/**
 * exa-integrator-focus-lab.ts
 *
 * PURPOSE (no production code change):
 * Empirically test whether ALTERNATIVE Exa query framings surface more companies
 * that actually "stick" as `integrator_relevant_focus` through the REAL production
 * classifier path (`AzureOpenAIClient.categorizeWebsiteCrawl`, which crawls the domain
 * over HTTP and then classifies via Azure).
 *
 * This isolates the question: is the poor yield driven by the Exa PROMPT (which type
 * of company gets surfaced) or by the classifier/filter? By holding the classifier
 * constant across variants and only changing the Exa query framing, we can read the
 * effect of the prompt directly.
 *
 * It does NOT modify any src/ behaviour. It only reuses the real clients.
 *
 * Requires: AZURE_OPENAI_* (local .env) and EXA_API_KEY (inject from Railway before run).
 */

import { AzureOpenAIClient } from "../src/clients/azure-openai";
import type { LeadCategory, PrequalificationConfig } from "../src/types";

// ---- Faithful classifier context (mirrors scripts/compare-live-search.ts baseRequest) ----
const PREQUALIFICATION: PrequalificationConfig = {
  mainContext:
    "For this run, qualify conservatively for German delivery-led software and automation service providers. Prefer implementation ownership, recurring customer projects, industrial relevance, and credible Vision AI / Industrial AI potential. Downgrade product-centric AI platform vendors, pure consultancies, and weak-fit generic AI branding.",
  categoryContexts: {}
} as unknown as PrequalificationConfig;

const TARGET_CATEGORY: LeadCategory = "integrator_relevant_focus";

interface Variant {
  id: string;
  label: string;
  query: string;
}

// All variants target the SAME intent (integrator_relevant_focus) but frame the Exa
// query differently. V0 mirrors the current deployed vertical-rotation technical-noun
// framing (the CONTROL). V1-V3 test service-integrator / delivery-firm framings.
const VARIANTS: Variant[] = [
  {
    id: "V0_control_verticalNouns",
    label: "CONTROL: vertical technical-noun rotation (current deployed style)",
    query:
      "Germany embedded vision and FPGA image processing companies, defence and surveillance imaging, medtech imaging, agriculture technology cameras, automotive perception, industrial electronics and measurement automation specialists"
  },
  {
    id: "V1_serviceIntegrator_excludeHardware",
    label: "Service integrators that DELIVER vision projects, explicitly exclude hardware makers",
    query:
      "Germany system integrators and engineering service providers that deliver customer machine vision, image processing and camera inspection projects in industries like automotive, medtech, logistics, defence or agriculture — solution providers and project delivery firms, not camera or optics hardware manufacturers"
  },
  {
    id: "V2_industrialIntegrator_visionCapability",
    label: "Industrial automation integrators that ALSO list vision as a capability (user hypothesis)",
    query:
      "Germany industrial automation and systems integrators that also offer machine vision, camera inspection and image processing as part of their solution portfolio for factory and production customers"
  },
  {
    id: "V3_visionAdjacent_deliveryService",
    label: "Vision-adjacent custom delivery/engineering service firms",
    query:
      "German companies delivering custom camera, optical inspection or computer vision solutions as a service to industrial customers, including embedded vision development services and application-specific image processing engineering"
  }
];

const RESULTS_PER_QUERY = 14;
const MAX_CLASSIFY_PER_VARIANT = 8;
const EXA_ENDPOINT = "https://api.exa.ai/search";

interface ExaResult {
  url: string;
  title?: string;
  summary?: string;
  highlights?: string[];
}

interface Candidate {
  name: string;
  domain: string;
  summary: string;
}

function out(line: string): void {
  process.stdout.write(line + "\n");
}

function normalizeDomain(rawUrl: string): string | undefined {
  try {
    const u = new URL(rawUrl);
    let host = u.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    // reject obvious aggregators
    const blocked = ["linkedin.com", "facebook.com", "youtube.com", "twitter.com", "x.com", "instagram.com", "wikipedia.org", "crunchbase.com", "xing.com"];
    if (blocked.some((b) => host === b || host.endsWith("." + b))) return undefined;
    return host;
  } catch {
    return undefined;
  }
}

function deriveName(domain: string, title?: string): string {
  const t = (title ?? "").trim();
  if (t && t.length <= 60 && !/https?:\/\//.test(t)) {
    // strip trailing " - something" tagline noise, keep leading brand
    return t.split(/\s[|\-–—:]\s/)[0].trim() || t;
  }
  const core = domain.split(".")[0];
  return core.charAt(0).toUpperCase() + core.slice(1);
}

async function runExa(apiKey: string, query: string): Promise<ExaResult[]> {
  const payload = {
    query,
    type: "auto",
    numResults: RESULTS_PER_QUERY,
    contents: { summary: true, highlights: true }
  };
  const res = await fetch(EXA_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    out(`  [exa error ${res.status}] ${(await res.text()).slice(0, 200)}`);
    return [];
  }
  const json = (await res.json()) as { results?: ExaResult[]; costDollars?: { total?: number } };
  return json.results ?? [];
}

async function main(): Promise<void> {
  const apiKey = process.env.EXA_API_KEY?.trim();
  if (!apiKey) {
    out("FATAL: EXA_API_KEY not set. Inject it from Railway before running.");
    process.exit(1);
  }

  // Silence noisy client logs; keep our own output on stdout via out().
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  console.log = () => undefined;
  console.info = () => undefined;
  console.warn = () => undefined;

  const azure = new AzureOpenAIClient();

  interface VariantSummary {
    id: string;
    label: string;
    surfaced: number;
    classified: number;
    stick: number;
    counts: Record<string, number>;
    companies: { name: string; domain: string; category: string; score: number; rationale: string }[];
  }

  const summaries: VariantSummary[] = [];
  const globalSeenDomains = new Set<string>();

  for (const variant of VARIANTS) {
    out("\n============================================================");
    out(`VARIANT ${variant.id}`);
    out(variant.label);
    out(`QUERY: ${variant.query}`);
    out("------------------------------------------------------------");

    const results = await runExa(apiKey, variant.query);
    // dedupe within variant by domain
    const seenInVariant = new Set<string>();
    const candidates: Candidate[] = [];
    for (const r of results) {
      const domain = normalizeDomain(r.url);
      if (!domain || seenInVariant.has(domain)) continue;
      seenInVariant.add(domain);
      const summary = [r.summary, ...(r.highlights ?? [])].filter(Boolean).join(" ").trim();
      candidates.push({ name: deriveName(domain, r.title), domain, summary });
    }

    const summary: VariantSummary = {
      id: variant.id,
      label: variant.label,
      surfaced: candidates.length,
      classified: 0,
      stick: 0,
      counts: {},
      companies: []
    };

    const toClassify = candidates.slice(0, MAX_CLASSIFY_PER_VARIANT);
    for (const c of toClassify) {
      let verdict;
      try {
        verdict = await azure.categorizeWebsiteCrawl(
          c.name,
          c.domain,
          c.summary,
          false, // dryRun = false -> real crawl + Azure
          "",
          PREQUALIFICATION,
          undefined
        );
      } catch (err) {
        verdict = { category: "error" as LeadCategory, relevanceScore: 0, rationale: String(err).slice(0, 120) };
      }
      const cat = String(verdict.category);
      summary.classified += 1;
      summary.counts[cat] = (summary.counts[cat] ?? 0) + 1;
      if (cat === TARGET_CATEGORY) summary.stick += 1;
      const isNew = !globalSeenDomains.has(c.domain);
      globalSeenDomains.add(c.domain);
      summary.companies.push({
        name: c.name,
        domain: c.domain,
        category: cat,
        score: verdict.relevanceScore ?? 0,
        rationale: (verdict.rationale ?? "").slice(0, 160)
      });
      const stickMark = cat === TARGET_CATEGORY ? "  <== STICKS" : "";
      out(`  ${isNew ? " " : "*"} ${c.domain}  ->  ${cat} (${verdict.relevanceScore ?? 0})${stickMark}`);
      out(`      ${c.name} | ${(verdict.rationale ?? "").slice(0, 150)}`);
    }

    summaries.push(summary);
  }

  console.log = originalLog;
  console.info = originalInfo;
  console.warn = originalWarn;

  out("\n\n############################################################");
  out("SUMMARY — how many stick as integrator_relevant_focus per framing");
  out("############################################################");
  for (const s of summaries) {
    out(`\n${s.id}`);
    out(`  ${s.label}`);
    out(`  surfaced(dedup)=${s.surfaced}  classified=${s.classified}  STICK(integrator_relevant_focus)=${s.stick}`);
    const dist = Object.entries(s.counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join("  ");
    out(`  category distribution: ${dist}`);
  }
  out("\n(* = domain already seen in an earlier variant)\n");
}

main().catch((err) => {
  process.stdout.write("FATAL: " + String(err) + "\n");
  process.exit(1);
});
