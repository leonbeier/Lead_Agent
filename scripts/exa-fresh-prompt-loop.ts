/**
 * exa-fresh-prompt-loop.ts (no production code change)
 *
 * Goal (user request): verify that when we ALWAYS feed the previously used prompts back
 * into the REAL planner, it keeps producing brand-new, SPECIALIZED queries (sub-region +
 * application/use-case + technology anchor, like "Keyence-mentioning integrators in OWL")
 * instead of near-duplicates, and that each new round still surfaces NEW (non-duplicate)
 * companies against the real Railway exclude filter.
 *
 * Per round it:
 *   1) calls AzureOpenAIClient.planExaSearchQueries with recentQueryHistory = every query
 *      generated in the PREVIOUS rounds, tagged with a saturated/low-yield outcome so the
 *      planner treats the mined routes as exhausted,
 *   2) captures the generated queries (validated, or raw when the strict locality validator
 *      rejects an adjective form),
 *   3) checks each new query against ALL prior queries for near-duplication (token Jaccard),
 *   4) runs each new query through live Exa with the real exclude filter and counts NEW
 *      companies (domain not in the growing seen set),
 *   5) classifies a few NEW candidates through the REAL classifier,
 *   6) adds the newly discovered domains to the seen set so the NEXT round must go fresher.
 *
 * Requires AZURE_OPENAI_* (.env), EXA_API_KEY (Railway), HUBSPOT_PRIVATE_APP_TOKEN (.env).
 */

import { AzureOpenAIClient } from "../src/clients/azure-openai";
import type { ExaQueryHistoryInsight, LeadCategory, OrganizationFilter, PrequalificationConfig } from "../src/types";

const RAILWAY_BASE = "https://leadagent-production-4555.up.railway.app";
const LEAD_KEY = "1UlS6EGO2RJPWacNdtQsYh94X3ejLuixmzMkrA5FBbqKyZTC";
const EXA_ENDPOINT = "https://api.exa.ai/search";
const EXA_EXCLUDE_CAP = 1200;
const RESULTS_PER_QUERY = 20;
const QUERIES_PER_ROUND = 4;
const ROUNDS = 3;
const MAX_CLASSIFY_NEW_PER_QUERY = 3;

const MATCHING_TARGET: Set<string> = new Set<LeadCategory>([
  "integrator_relevant_focus",
  "integrator_vision_industrial_ai",
  "integrator_general_ai",
  "integrator_vision_ai_consulting",
  "integrator_vision_ai_freelancer",
  "machine_builder_vision_ai"
]);

const PREQUALIFICATION: PrequalificationConfig = {
  mainContext:
    "For this run, qualify conservatively for German delivery-led software and automation service providers. Prefer implementation ownership, recurring customer projects, industrial relevance, and credible Vision AI / Industrial AI potential. Downgrade product-centric AI platform vendors, pure consultancies, and weak-fit generic AI branding.",
  categoryContexts: {}
} as unknown as PrequalificationConfig;

const FILTER: OrganizationFilter = {
  name: "Fresh-prompt loop integrator run",
  persona: "Decision makers",
  industries: ["Manufacturing", "Industrial Automation"],
  keywords: ["machine vision", "industrial image processing", "system integration", "industrial AI"],
  locations: ["Germany"],
  employeeRanges: ["11-50"],
  targetCategories: ["integrator_vision_industrial_ai", "integrator_relevant_focus"],
  notes: "Find German delivery-led vision/industrial-AI system integrators that own customer implementation."
} as unknown as OrganizationFilter;

const REQUESTED_CATEGORIES: LeadCategory[] = ["integrator_vision_industrial_ai", "integrator_relevant_focus"];
const DEFAULT_QUERIES = ["machine vision system integrators in Germany official company websites"];

function out(line: string): void {
  process.stdout.write(line + "\n");
}

function normalizeDomain(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let host = raw.trim().toLowerCase();
  host = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  host = host.replace(/:\d+$/, "");
  if (!host || !host.includes(".")) return undefined;
  const blocked = ["linkedin.com", "facebook.com", "youtube.com", "twitter.com", "x.com", "instagram.com", "wikipedia.org", "crunchbase.com", "xing.com"];
  if (blocked.some((b) => host === b || host.endsWith("." + b))) return undefined;
  return host;
}

function deriveName(domain: string, title?: string): string {
  const t = (title ?? "").trim();
  if (t && t.length <= 60 && !/https?:\/\//.test(t)) {
    return t.split(/\s[|\-–—:]\s/)[0].trim() || t;
  }
  const core = domain.split(".")[0];
  return core.charAt(0).toUpperCase() + core.slice(1);
}

function tokenize(q: string): Set<string> {
  const stop = new Set([
    "official", "company", "websites", "website", "of", "the", "in", "and", "for", "with", "that", "a", "an", "to", "on",
    "germany", "german", "companies", "www", "com", "de", "not", "no", "or", "as", "their", "work", "works"
  ]);
  return new Set(
    q
      .toLowerCase()
      .replace(/[^a-zäöüß0-9\s-]/g, " ")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 2 && !stop.has(t))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

// crude specialization signals (reporting only, not production logic)
const CITY_ANCHORS = [
  "ostwestfalen", "owl", "bielefeld", "paderborn", "gütersloh", "guetersloh", "detmold", "herford", "baden-württemberg",
  "baden-wurttemberg", "bayern", "bavaria", "stuttgart", "münchen", "munich", "hamburg", "ruhr", "sachsen", "saxony",
  "nordrhein", "westfalen", "swabia", "schwaben", "aachen", "karlsruhe", "nürnberg", "nuremberg", "rhein", "main",
  "franken", "franconia", "allgäu", "allgaeu", "region", "area", "around"
];
const TECH_ANCHORS = ["keyence", "cognex", "basler", "sick", "halcon", "mvtec", "ids", "matrox", "opencv", "tensorflow", "nvidia", "jetson", "framos"];
const APPLICATION_ANCHORS = [
  "weld", "seam", "surface", "defect", "packaging", "pharma", "food", "automotive", "metal", "logistics", "assembly",
  "robot", "pick", "sorting", "printing", "textile", "wood", "plastic", "semiconductor", "battery", "solar", "medtech",
  "quality", "inspection", "measurement", "bin-picking", "guidance", "traceability", "ocr", "reading"
];

function classifySpecialization(q: string): { region: boolean; tech: boolean; application: boolean } {
  const low = q.toLowerCase();
  return {
    region: CITY_ANCHORS.some((a) => low.includes(a)),
    tech: TECH_ANCHORS.some((a) => low.includes(a)),
    application: APPLICATION_ANCHORS.some((a) => low.includes(a))
  };
}

async function railwayGet(path: string): Promise<unknown> {
  const res = await fetch(RAILWAY_BASE + path, { headers: { "x-lead-agent-key": LEAD_KEY } });
  if (!res.ok) throw new Error(`railway ${path} -> ${res.status}`);
  return res.json();
}

async function hubspotDomains(token: string): Promise<Set<string>> {
  const domains = new Set<string>();
  let after: string | undefined;
  try {
    for (let page = 0; page < 60; page += 1) {
      const url = new URL("https://api-eu1.hubapi.com/crm/v3/objects/companies");
      url.searchParams.set("limit", "100");
      url.searchParams.set("properties", "domain");
      if (after) url.searchParams.set("after", after);
      const res = await fetch(url.toString(), { headers: { Authorization: "Bearer " + token } });
      if (!res.ok) break;
      const json = (await res.json()) as { results?: Array<{ properties?: { domain?: string } }>; paging?: { next?: { after?: string } } };
      for (const r of json.results ?? []) {
        const d = normalizeDomain(r.properties?.domain);
        if (d) domains.add(d);
      }
      after = json.paging?.next?.after;
      if (!after) break;
    }
  } catch {
    /* best effort */
  }
  return domains;
}

async function runExa(apiKey: string, query: string, excludeDomains: string[]): Promise<Array<{ url: string; title?: string; summary?: string; highlights?: string[] }>> {
  const payload = {
    query,
    type: "auto",
    numResults: RESULTS_PER_QUERY,
    excludeDomains: excludeDomains.slice(0, EXA_EXCLUDE_CAP),
    contents: { summary: true, highlights: true }
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(EXA_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        out(`  [exa error ${res.status}] ${(await res.text()).slice(0, 200)}`);
        return [];
      }
      const json = (await res.json()) as { results?: Array<{ url: string; title?: string; summary?: string; highlights?: string[] }> };
      return json.results ?? [];
    } catch (err) {
      if (attempt === 2) {
        out(`  [exa fetch failed after retries] ${String(err).slice(0, 120)}`);
        return [];
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return [];
}

interface RoundResult {
  round: number;
  queries: string[];
  maxDupVsPrior: number[]; // per query: highest Jaccard vs any prior query
  specialization: { region: boolean; tech: boolean; application: boolean }[];
  newPerQuery: number[];
  matchingNewPerQuery: number[];
}

async function main(): Promise<void> {
  const exaKey = process.env.EXA_API_KEY?.trim();
  if (!exaKey) {
    out("FATAL: EXA_API_KEY not set. Inject from Railway first.");
    process.exit(1);
  }
  const hsToken = process.env.HUBSPOT_PRIVATE_APP_TOKEN?.trim();

  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const silence = () => {
    console.log = () => undefined;
    console.info = () => undefined;
    console.warn = () => undefined;
  };
  const restore = () => {
    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
  };
  silence();

  // ---- Build the real seen/exclude set ----
  const seen = new Set<string>();
  const recurringOrdered: string[] = [];
  try {
    const screening = (await railwayGet("/api/control/cache/company-screening")) as { database?: { records?: Array<{ domain?: string; normalizedDomain?: string }> } };
    for (const r of screening.database?.records ?? []) {
      const d = normalizeDomain(r.normalizedDomain ?? r.domain);
      if (d) seen.add(d);
    }
  } catch (e) {
    restore();
    out("  [warn] screening fetch failed: " + String(e).slice(0, 80));
    silence();
  }
  try {
    const live = (await railwayGet("/api/control/cache/live-exa")) as {
      cache?: { discoveredDomains?: string[]; recurringDomains?: Array<{ domain?: string }> };
    };
    for (const d0 of live.cache?.discoveredDomains ?? []) {
      const d = normalizeDomain(d0);
      if (d) seen.add(d);
    }
    for (const r of live.cache?.recurringDomains ?? []) {
      const d = normalizeDomain(r.domain);
      if (d) {
        seen.add(d);
        recurringOrdered.push(d);
      }
    }
  } catch (e) {
    restore();
    out("  [warn] live-exa fetch failed: " + String(e).slice(0, 80));
    silence();
  }
  let hsCount = 0;
  if (hsToken) {
    const hs = await hubspotDomains(hsToken);
    for (const d of hs) {
      seen.add(d);
      hsCount += 1;
    }
  }
  const excludeList = Array.from(new Set([...recurringOrdered, ...seen]));

  restore();
  out(`Exclude/seen set built: total=${seen.size} (recurring=${recurringOrdered.length}, hubspot=${hsCount}). Sending ${Math.min(excludeList.length, EXA_EXCLUDE_CAP)} to Exa per query.`);
  out(`Rounds=${ROUNDS}, queries/round=${QUERIES_PER_ROUND}. Each round feeds ALL prior queries back as saturated history.`);
  silence();

  const azure = new AzureOpenAIClient();

  // Capture raw model output so we survive the strict locality validator (adjective form).
  const azAny = azure as unknown as { runChatWithTimeout: (...args: unknown[]) => Promise<string> };
  const originalRun = azAny.runChatWithTimeout.bind(azAny);
  let rawOutput = "";
  azAny.runChatWithTimeout = async (...args: unknown[]) => {
    const result = await originalRun(...args);
    rawOutput = result;
    return result;
  };

  const priorQueries: string[] = [];
  const priorTokenSets: Set<string>[] = [];
  const history: ExaQueryHistoryInsight[] = [];
  const rounds: RoundResult[] = [];

  for (let round = 1; round <= ROUNDS; round += 1) {
    rawOutput = "";
    let queries: string[] = [];
    try {
      queries = await azure.planExaSearchQueries(
        FILTER,
        DEFAULT_QUERIES,
        undefined,
        false,
        undefined,
        undefined,
        QUERIES_PER_ROUND,
        {
          requestedTargetCategories: REQUESTED_CATEGORIES,
          recentQueryHistory: history.slice(0, 50),
          excludedDomainExamples: recurringOrdered.slice(0, 30)
        }
      );
    } catch {
      // Locality validator rejected an adjective form — recover the raw generated queries.
      try {
        const parsed = JSON.parse(rawOutput) as { queries?: string[] };
        queries = (parsed.queries ?? []).map((q) => q.trim()).filter(Boolean);
      } catch {
        queries = [];
      }
    }

    restore();
    out("\n############################################################");
    out(`ROUND ${round}  (history size fed in: ${history.length} prior queries)`);
    out("############################################################");
    silence();

    const roundResult: RoundResult = {
      round,
      queries,
      maxDupVsPrior: [],
      specialization: [],
      newPerQuery: [],
      matchingNewPerQuery: []
    };

    for (const query of queries) {
      const tokens = tokenize(query);
      let maxDup = 0;
      for (const prior of priorTokenSets) {
        maxDup = Math.max(maxDup, jaccard(tokens, prior));
      }
      const spec = classifySpecialization(query);

      const results = await runExa(exaKey, query, excludeList);
      const seenInQuery = new Set<string>();
      const newCandidates: { name: string; domain: string; summary: string }[] = [];
      for (const r of results) {
        const domain = normalizeDomain(r.url);
        if (!domain || seenInQuery.has(domain)) continue;
        seenInQuery.add(domain);
        if (seen.has(domain)) continue;
        const summary = [r.summary, ...(r.highlights ?? [])].filter(Boolean).join(" ").trim();
        newCandidates.push({ name: deriveName(domain, r.title), domain, summary });
      }

      restore();
      const specTag = [spec.region ? "REGION" : null, spec.tech ? "TECH" : null, spec.application ? "APP" : null].filter(Boolean).join("+") || "generic";
      out(`\n  Q: ${query}`);
      out(`     dupVsPrior=${maxDup.toFixed(2)}  specialization=[${specTag}]  returned=${results.length}  NEW=${newCandidates.length}`);
      silence();

      // classify a few new candidates
      let matchingNew = 0;
      const toClassify = newCandidates.slice(0, MAX_CLASSIFY_NEW_PER_QUERY);
      for (const c of toClassify) {
        let verdict;
        try {
          verdict = await azure.categorizeWebsiteCrawl(c.name, c.domain, c.summary, false, "", PREQUALIFICATION, undefined);
        } catch (err) {
          verdict = { category: "error" as LeadCategory, relevanceScore: 0, rationale: String(err).slice(0, 80) };
        }
        const cat = String(verdict.category);
        const matching = MATCHING_TARGET.has(cat);
        if (matching) matchingNew += 1;
        restore();
        out(`       NEW ${c.domain} -> ${cat} (${verdict.relevanceScore ?? 0})${matching ? "  <== MATCHING" : ""}`);
        silence();
      }

      // add ALL new domains to seen so the next round must find fresher ones
      for (const c of newCandidates) seen.add(c.domain);

      roundResult.maxDupVsPrior.push(maxDup);
      roundResult.specialization.push(spec);
      roundResult.newPerQuery.push(newCandidates.length);
      roundResult.matchingNewPerQuery.push(matchingNew);

      // record this query into history as a saturated/low-yield outcome to push the next round fresher
      priorQueries.push(query);
      priorTokenSets.push(tokens);
      history.unshift({
        query,
        returnedResults: RESULTS_PER_QUERY,
        filteredByExcludedDomains: RESULTS_PER_QUERY - newCandidates.length,
        duplicates: 0,
        accepted: matchingNew,
        rejectedDifferentCategory: 0,
        rejectedOther: Math.max(0, newCandidates.length - matchingNew),
        rawFound: newCandidates.length,
        detectedCategories: REQUESTED_CATEGORIES,
        note: "Route already mined in this experiment; rotate to a new sub-region / application / technology anchor."
      } as ExaQueryHistoryInsight);
    }

    rounds.push(roundResult);
  }

  restore();
  out("\n\n############################################################");
  out("SUMMARY — fresh specialized prompts across rounds");
  out("(dupVsPrior: 1.00 = near-duplicate of an earlier query; lower = fresher)");
  out("############################################################");
  for (const r of rounds) {
    const avgDup = r.maxDupVsPrior.length ? r.maxDupVsPrior.reduce((a, b) => a + b, 0) / r.maxDupVsPrior.length : 0;
    const totalNew = r.newPerQuery.reduce((a, b) => a + b, 0);
    const totalMatch = r.matchingNewPerQuery.reduce((a, b) => a + b, 0);
    const regionCount = r.specialization.filter((s) => s.region).length;
    const techCount = r.specialization.filter((s) => s.tech).length;
    const appCount = r.specialization.filter((s) => s.application).length;
    out(
      `ROUND ${r.round}: queries=${r.queries.length}  avgDupVsPrior=${avgDup.toFixed(2)}  ` +
        `specialization[region=${regionCount} tech=${techCount} app=${appCount}]  NEW=${totalNew}  matchingNEW=${totalMatch}`
    );
  }
  const allDup = rounds.flatMap((r) => r.maxDupVsPrior);
  const worstDup = allDup.length ? Math.max(...allDup) : 0;
  const totalNewAll = rounds.reduce((a, r) => a + r.newPerQuery.reduce((x, y) => x + y, 0), 0);
  const totalMatchAll = rounds.reduce((a, r) => a + r.matchingNewPerQuery.reduce((x, y) => x + y, 0), 0);
  out(`\nWorst dupVsPrior across all rounds: ${worstDup.toFixed(2)} (want < 0.6 = no near-duplicates)`);
  out(`Total NEW companies across all rounds: ${totalNewAll}   matching-target NEW: ${totalMatchAll}`);
}

main().catch((err) => {
  process.stdout.write("FATAL: " + String(err) + "\n");
  process.exit(1);
});
