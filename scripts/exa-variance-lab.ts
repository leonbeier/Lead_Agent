/**
 * exa-variance-lab.ts (no production code change)
 *
 * Tests the user's variance hypothesis: generic "vision integrator Germany/Europe" queries
 * keep returning the SAME already-seen companies, while more specific/varied angles
 * (region like OWL, technology mentions like Keyence/Cognex/HALCON, niche verticals) may
 * surface NEW companies.
 *
 * For each candidate Exa prompt it:
 *   1) loads the REAL Railway exclude set (screening DB + live-exa discovered/recurring +
 *      HubSpot domains),
 *   2) calls live Exa /search with excludeDomains applied (capped to Exa's 1200 limit),
 *   3) counts how many of the 20 results are NEW (domain not in the full seen set),
 *   4) classifies each NEW result through the REAL classifier (categorizeWebsiteCrawl),
 *   5) reports returned / new / matching-target-category per prompt.
 *
 * GOAL per user: find a prompt that returns ~20 results with >=1 NEW result that also
 * lands in a matching target category.
 *
 * Requires AZURE_OPENAI_* (local .env), EXA_API_KEY (from Railway), HUBSPOT_PRIVATE_APP_TOKEN (.env).
 */

import { AzureOpenAIClient } from "../src/clients/azure-openai";
import type { LeadCategory, PrequalificationConfig } from "../src/types";

const RAILWAY_BASE = "https://leadagent-production-4555.up.railway.app";
const LEAD_KEY = "1UlS6EGO2RJPWacNdtQsYh94X3ejLuixmzMkrA5FBbqKyZTC";
const EXA_ENDPOINT = "https://api.exa.ai/search";
const EXA_EXCLUDE_CAP = 1200;
const RESULTS_PER_QUERY = 20;
const MAX_CLASSIFY_NEW_PER_QUERY = 4;

// Categories that count as a "matching" target for this integrator-focused run.
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

interface Prompt {
  id: string;
  query: string;
}

const PROMPTS: Prompt[] = [
  // --- Benchmark (previously strongest: combo vertical+tech+country) ---
  {
    id: "BENCH_pack_it_es_cognex",
    query:
      "Official websites of packaging-line machine-vision integrators in Italy and Spain using Cognex or Keyence systems for print, label, fill-level and closure inspection on production lines."
  },
  // --- NEW AXIS 1: native-language queries (Exa is multilingual) ---
  {
    id: "L_IT_native",
    query:
      "Aziende e integratori italiani di sistemi di visione artificiale e automazione industriale che progettano e realizzano impianti di ispezione, controllo qualità e guida robot su misura per aziende manifatturiere."
  },
  {
    id: "L_ES_native",
    query:
      "Empresas e integradores españoles de sistemas de visión artificial y automatización industrial que diseñan y desarrollan proyectos a medida de inspección, control de calidad y guiado de robots para fábricas."
  },
  {
    id: "L_DE_native",
    query:
      "Systemintegratoren und Ingenieurbüros für industrielle Bildverarbeitung, Automatisierung und Sondermaschinenbau, die kundenspezifische Inspektions-, Prüf- und Roboterführungssysteme für die Fertigung realisieren."
  },
  // --- NEW AXIS 2: fresh vertical + technology + country combos ---
  {
    id: "X_pcb_electronics",
    query:
      "Official websites of machine-vision inspection integrators for electronics, PCB and semiconductor assembly (AOI, solder-joint and component-placement inspection) in Germany, Italy, Poland and Austria."
  },
  {
    id: "X_pharma_serialization",
    query:
      "Official websites of vision inspection integrators for pharmaceutical serialization, blister, vial and syringe inspection using OCR and OCV in Italy, Spain and Switzerland."
  },
  {
    id: "X_metal_welding",
    query:
      "Official websites of vision-guided robotic welding and metal surface inspection integrators for the metal, steel and foundry industry in Italy, Spain and Poland."
  },
  {
    id: "X_battery_ev",
    query:
      "Official websites of machine-vision and AI inspection integrators for battery cell, EV and e-mobility production lines in Germany, Sweden and Hungary."
  },
  // --- NEW AXIS 3: fresh sub-national regions in underexplored countries ---
  {
    id: "R_IT_veneto_friuli",
    query:
      "Official websites of machine-vision and automation system integrators in Veneto and Friuli, Italy (Padova, Vicenza, Treviso, Udine) delivering custom inspection and robotics projects."
  },
  {
    id: "R_PL_silesia_greater",
    query:
      "Official websites of industrial automation and machine-vision integrators in Silesia and greater Poland (Katowice, Poznań, Wrocław) delivering custom inspection and robot projects."
  },
  {
    id: "R_ES_valencia_zaragoza",
    query:
      "Official websites of machine-vision and automation integrators around Valencia, Zaragoza and Navarra in Spain delivering custom inspection and robotics projects for factories."
  },
  {
    id: "R_BE_flanders",
    query:
      "Official websites of machine-vision and industrial automation integrators in Flanders, Belgium (Ghent, Antwerp, Kortrijk) delivering custom inspection and robotics projects."
  },
  // --- NEW AXIS 4: application/use-case specific combos ---
  {
    id: "A_binpicking_robotguide",
    query:
      "Official websites of system integrators delivering 3D-vision bin-picking and vision-guided robot loading cells for manufacturers in Germany, the Netherlands and Italy."
  },
  {
    id: "A_surface_ocr_defect",
    query:
      "Official websites of machine-vision integrators delivering surface-defect detection and OCR code-reading inspection systems for production lines in Spain, Italy and Poland."
  }
];

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
  console.log = () => undefined;
  console.info = () => undefined;
  console.warn = () => undefined;

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
    out("  [warn] screening fetch failed: " + String(e).slice(0, 80));
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
    out("  [warn] live-exa fetch failed: " + String(e).slice(0, 80));
  }
  let hsCount = 0;
  if (hsToken) {
    const hs = await hubspotDomains(hsToken);
    for (const d of hs) {
      seen.add(d);
      hsCount += 1;
    }
  }

  // Build the exclude list actually sent to Exa: prioritise recurring (most repeated), then rest.
  const excludeList = Array.from(new Set([...recurringOrdered, ...seen]));

  console.log = originalLog;
  console.info = originalInfo;
  console.warn = originalWarn;
  out(`Exclude/seen set built: total=${seen.size} (recurring=${recurringOrdered.length}, hubspot=${hsCount}). Sending ${Math.min(excludeList.length, EXA_EXCLUDE_CAP)} to Exa per query.`);
  console.log = () => undefined;
  console.info = () => undefined;
  console.warn = () => undefined;

  const azure = new AzureOpenAIClient();

  interface Row {
    id: string;
    returned: number;
    newCount: number;
    matchingNew: number;
    relevantFocusNew: number;
    newCompanies: { domain: string; category: string; matching: boolean }[];
  }
  const rows: Row[] = [];

  for (const prompt of PROMPTS) {
    out("\n============================================================");
    out(`${prompt.id}`);
    out(`QUERY: ${prompt.query}`);
    out("------------------------------------------------------------");

    const results = await runExa(exaKey, prompt.query, excludeList);
    const returned = results.length;

    // dedupe within query + split into new vs already-seen
    const seenInQuery = new Set<string>();
    const newCandidates: { name: string; domain: string; summary: string }[] = [];
    let alreadySeen = 0;
    for (const r of results) {
      const domain = normalizeDomain(r.url);
      if (!domain || seenInQuery.has(domain)) continue;
      seenInQuery.add(domain);
      if (seen.has(domain)) {
        alreadySeen += 1;
        continue;
      }
      const summary = [r.summary, ...(r.highlights ?? [])].filter(Boolean).join(" ").trim();
      newCandidates.push({ name: deriveName(domain, r.title), domain, summary });
    }

    const row: Row = { id: prompt.id, returned, newCount: newCandidates.length, matchingNew: 0, relevantFocusNew: 0, newCompanies: [] };
    out(`  returned=${returned}  already-seen=${alreadySeen}  NEW=${newCandidates.length}`);

    const toClassify = newCandidates.slice(0, MAX_CLASSIFY_NEW_PER_QUERY);
    for (const c of toClassify) {
      let verdict;
      try {
        verdict = await azure.categorizeWebsiteCrawl(c.name, c.domain, c.summary, false, "", PREQUALIFICATION, undefined);
      } catch (err) {
        verdict = { category: "error" as LeadCategory, relevanceScore: 0, rationale: String(err).slice(0, 100) };
      }
      const cat = String(verdict.category);
      const matching = MATCHING_TARGET.has(cat);
      if (matching) row.matchingNew += 1;
      if (cat === "integrator_relevant_focus") row.relevantFocusNew += 1;
      row.newCompanies.push({ domain: c.domain, category: cat, matching });
      out(`   NEW ${c.domain}  ->  ${cat} (${verdict.relevanceScore ?? 0})${matching ? "  <== MATCHING TARGET" : ""}`);
      out(`       ${(verdict.rationale ?? "").slice(0, 140)}`);
    }
    rows.push(row);
  }

  console.log = originalLog;
  console.info = originalInfo;
  console.warn = originalWarn;

  out("\n\n############################################################");
  out("SUMMARY — variance / novelty per prompt");
  out("(goal: returned~20, NEW>=1, and >=1 NEW in a matching target category)");
  out("############################################################");
  for (const r of rows) {
    const goal = r.newCount >= 1 && r.matchingNew >= 1 ? "GOAL MET" : "—";
    out(`${r.id.padEnd(26)} returned=${String(r.returned).padStart(2)}  NEW=${String(r.newCount).padStart(2)}  matchingNew=${String(r.matchingNew).padStart(2)}  relevantFocusNew=${r.relevantFocusNew}  ${goal}`);
  }
  out("");
}

main().catch((err) => {
  process.stdout.write("FATAL: " + String(err) + "\n");
  process.exit(1);
});
