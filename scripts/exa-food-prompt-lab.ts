/**
 * Exa prompt lab for the `industrial_end_customer_scaled` + food-production target.
 *
 * Goal: empirically find which hand-written Exa query shape actually returns real
 * FOOD PRODUCERS that run their own factories (the desired archetype) instead of
 * vision integrators / machine builders / component vendors (the wrong archetype
 * that causes `aiRejectedDifferentCategory`).
 *
 * This is a research tool only. It calls the live Exa API directly and prints the
 * top results per strategy with an archetype HINT (heuristic, for eyeballing only —
 * the real judgment is manual). No HubSpot writes, no AI classifier, no pipeline.
 *
 * Usage: npx tsx scripts/exa-food-prompt-lab.ts [numResults]
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EXA_ENDPOINT = "https://api.exa.ai/search";

type ExaResult = { title?: string; url?: string; summary?: string; highlights?: string[] };
type ExaResponse = { results?: ExaResult[]; costDollars?: { total?: number } };

type Strategy = {
  name: string;
  note: string;
  query: string;
  useCompanyCategory: boolean;
};

function loadExaApiKey(): string {
  const fromEnv = process.env.EXA_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const envPath = resolve(process.cwd(), ".env");
  const content = readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const match = rawLine.match(/^\s*EXA_API_KEY\s*=\s*(.*)\s*$/);
    if (match) {
      return match[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  throw new Error("EXA_API_KEY not found in environment or .env file.");
}

/**
 * Heuristic archetype HINT for eyeballing only. Not a classifier and not used for
 * any accept/reject decision. It just helps scan a long result list quickly.
 */
function archetypeHint(text: string): string {
  const t = text.toLowerCase();
  const integrator = /(integrator|system integration|systemintegrat|lösungsanbieter|solution provider|engineering services|dienstleist|automation partner|bildverarbeitung|machine vision|computer vision|inspection system|beratung|consult)/.test(t);
  const machineBuilder = /(maschinenbau|machine builder|oem|anlagenbau|sondermaschin|equipment manufacturer|packaging machine|verpackungsmaschin|abfüllanlage|fördertechnik)/.test(t);
  const vendor = /(kamera|camera|sensor|component|komponent|reseller|distributor|händler|supplier of)/.test(t);
  const producer = /(hersteller|produzent|produktion|manufactur|molkerei|bäckerei|brauerei|fleisch|wurst|dairy|bakery|brewery|meat|beverage|getränk|lebensmittelhersteller|food producer|nahrungsmittel|feinkost|convenience|tiefkühl|frozen food)/.test(t);
  const tags: string[] = [];
  if (producer) tags.push("PRODUCER?");
  if (integrator) tags.push("integrator");
  if (machineBuilder) tags.push("machineBuilder");
  if (vendor) tags.push("vendor");
  return tags.length ? tags.join("+") : "unclear";
}

async function runExa(apiKey: string, strategy: Strategy, numResults: number): Promise<ExaResponse> {
  const payload = {
    query: strategy.query,
    type: "auto" as const,
    ...(strategy.useCompanyCategory ? { category: "company" as const } : {}),
    numResults,
    contents: { summary: true, highlights: true }
  };
  const response = await fetch(EXA_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Exa failed ${response.status}: ${text.slice(0, 300)}`);
  }
  return (await response.json()) as ExaResponse;
}

function domainOf(url?: string): string {
  if (!url) return "(no url)";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Candidate strategies. All Germany-scoped, food-production end-customer target.
// S0 reproduces the current integrator-flavored framing (control). S1..S6 test
// end-customer framings. Each is a natural-language Exa instruction.
// ---------------------------------------------------------------------------
const STRATEGIES: Strategy[] = [
  {
    name: "R2-A-producer-scale-combined",
    note: "FINAL CANDIDATE: producer + scale/multi-site framing, strong wrong-archetype exclusions, no QC hook.",
    query:
      "Germany food and beverage manufacturers and producer groups that own and operate their own factories and production lines at industrial scale, including larger multi-site producers. Prefer the official company websites of the producing companies themselves that make and process their own products in-house. Exclude system integrators, automation service providers, consultancies, machine builders, OEMs, packaging-machine and equipment suppliers, camera or sensor vendors, ingredient traders, distributors, directories, marketplaces, job boards, news articles, and PDFs.",
    useCompanyCategory: false
  },
  {
    name: "R2-B-producer-scale-no-exclusion-tail",
    note: "Same intent as A but shorter exclusion tail, to test whether the long exclusion list is doing the work.",
    query:
      "Germany food and beverage producers and manufacturing groups that own and operate their own factories and production lines at industrial scale. Prefer the official company websites of the producers themselves, not their suppliers, integrators, or machine builders.",
    useCompanyCategory: false
  },
  {
    name: "R2-C-producer-scale-verticals",
    note: "A + named verticals to broaden coverage across food segments while keeping producer framing.",
    query:
      "Germany food and beverage producers that own and operate their own factories at industrial scale across dairy, bakery, confectionery, meat and sausage, frozen and convenience foods, snacks, and beverages, including larger multi-site producer groups. Prefer the official company websites of the manufacturers that run their own plants. Exclude system integrators, automation service providers, machine builders, OEMs, packaging-equipment suppliers, camera or sensor vendors, ingredient traders, distributors, directories, and news pages.",
    useCompanyCategory: false
  },
  {
    name: "S1-pure-producer-repeat",
    note: "Round-1 winner, repeated for stability comparison (result variance check).",
    query:
      "Germany food producers and manufacturers that operate their own factories and production lines. Prefer official company websites of food companies that make and process their own products in-house. Exclude system integrators, consultancies, machine builders, OEMs, packaging-machine suppliers, camera or sensor vendors, distributors, directories, marketplaces, job boards, news articles, and PDFs.",
    useCompanyCategory: false
  }
];

async function main() {
  const numResults = Math.max(3, Math.min(15, Number(process.argv[2]) || 10));
  const apiKey = loadExaApiKey();

  console.log(`Exa food end-customer prompt lab — ${numResults} results/strategy\n`);

  const summary: Array<{ strategy: string; producerLike: number; total: number; cost: number }> = [];

  for (const strategy of STRATEGIES) {
    console.log("=".repeat(90));
    console.log(`STRATEGY ${strategy.name}  (companyCategory=${strategy.useCompanyCategory})`);
    console.log(`  ${strategy.note}`);
    console.log(`  query: ${strategy.query}`);
    console.log("-".repeat(90));
    try {
      const res = await runExa(apiKey, strategy, numResults);
      const results = res.results ?? [];
      let producerLike = 0;
      for (const r of results) {
        const hint = archetypeHint(`${r.title ?? ""} ${r.summary ?? ""} ${(r.highlights ?? []).join(" ")}`);
        if (hint.includes("PRODUCER?") && !hint.includes("integrator") && !hint.includes("machineBuilder") && !hint.includes("vendor")) {
          producerLike += 1;
        }
        const summaryLine = (r.summary ?? "").replace(/\s+/g, " ").slice(0, 130);
        console.log(`  [${hint.padEnd(28)}] ${domainOf(r.url).padEnd(32)} ${summaryLine}`);
      }
      const cost = res.costDollars?.total ?? 0;
      summary.push({ strategy: strategy.name, producerLike, total: results.length, cost });
      console.log(`  -> clean-producer hits: ${producerLike}/${results.length}  cost=$${cost.toFixed(4)}`);
    } catch (error) {
      console.log(`  ERROR: ${error instanceof Error ? error.message : String(error)}`);
      summary.push({ strategy: strategy.name, producerLike: 0, total: 0, cost: 0 });
    }
    console.log("");
  }

  console.log("=".repeat(90));
  console.log("SUMMARY (heuristic clean-producer hit rate — eyeball the lists above, this is only a hint)");
  for (const row of summary) {
    console.log(`  ${row.strategy.padEnd(38)} ${row.producerLike}/${row.total}  $${row.cost.toFixed(4)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
