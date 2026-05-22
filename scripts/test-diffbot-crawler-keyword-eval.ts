import fs from "node:fs/promises";
import path from "node:path";

import { WebSearchAgent } from "../src/clients/web-search-agent";

type DiffbotCsvRow = {
  name: string;
  website: string;
  description: string;
};

type AnalysisRow = {
  name: string;
  website?: string;
  category: string;
  relevanceScore?: number;
  rationale?: string;
};

type CrawlEvaluation = {
  name: string;
  website: string;
  category: string;
  strictRelevant: boolean;
  broadRelevant: boolean;
  crawlSucceeded: boolean;
  kept: boolean;
  score: number;
  matchedPositiveTerms: string[];
  matchedDeliveryTerms: string[];
  matchedNegativeTerms: string[];
  matchedSoftNegativeTerms: string[];
  blockedByNegative: boolean;
  summary: string | null;
  relevantUrls: string[];
};

type Report = {
  createdAt: string;
  inputPath: string;
  analysisPath: string;
  outputPath: string;
  totalCompanies: number;
  crawlSucceededCount: number;
  crawlFailedCount: number;
  keptCount: number;
  droppedCount: number;
  strictTarget: {
    totalRelevant: number;
    keptRelevant: number;
    droppedRelevant: number;
    nonTargetStillIn: number;
    precision: number;
    recall: number;
  };
  broadRelevant: {
    totalRelevant: number;
    keptRelevant: number;
    droppedRelevant: number;
    irrelevantStillIn: number;
    precision: number;
    recall: number;
  };
  falsePositives: CrawlEvaluation[];
  falseNegativesStrict: CrawlEvaluation[];
  falseNegativesBroad: CrawlEvaluation[];
  keptCompanies: CrawlEvaluation[];
  results: CrawlEvaluation[];
};

const DEFAULT_INPUT_PATH = path.join(process.cwd(), "data", "diffbot", "eu_ai_machine_vision_integrators_100_full_entity_v3.csv");
const DEFAULT_ANALYSIS_PATH = path.join(process.cwd(), "data", "diffbot", "eu_ai_machine_vision_integrators_100_full_entity_v3.analysis.json");
const DEFAULT_CONCURRENCY = 6;

const STRICT_TARGET_CATEGORIES = new Set([
  "integrator_vision_industrial_ai",
  "integrator_vision_ai_consulting_freelancer",
  "integrator_general_ai"
]);

const NEGATIVE_CATEGORIES = new Set(["irrelevant"]);

const POSITIVE_VISION_TERMS = [
  "machine vision",
  "industrial vision",
  "visual inspection",
  "optical inspection",
  "automated optical inspection",
  "quality inspection",
  "vision-guided robotics",
  "industrielle bildverarbeitung",
  "optische inspektion"
];

const DELIVERY_TERMS = [
  "system integrator",
  "system integration",
  "turnkey",
  "custom solution",
  "customer-specific",
  "engineering services",
  "commissioning",
  "robot guidance",
  "inspection system",
  "automation solution",
  "inspection solutions",
  "quality control",
  "implementation",
  "project",
  "systemintegration",
  "kundenspezifisch",
  "automatisierungstechnik",
  "sondermaschinenbau",
  "beratung",
  "planung",
  "konzeption",
  "entwicklung",
  "integration",
  "inbetriebnahme",
  "service",
  "optimierung",
  "case studies",
  "referenzen",
  "machbarkeitsstudien",
  "support"
];

const HARD_NEGATIVE_TERMS = [
  "face recognition",
  "face tracking",
  "biometrics",
  "virtual try-on",
  "security",
  "smart city",
  "traffic enforcement",
  "marketing research"
];

const SOFT_NEGATIVE_TERMS = [
  "camera module",
  "smart camera",
  "embedded vision",
  "led lighting",
  "x-ray inspection",
  "distributor",
  "reseller",
  "manufacturer",
  "manufacturers",
  "products",
  "product",
  "sensors",
  "components",
  "oems",
  "oem",
  "platform"
];

const BONUS_TERMS = [
  "customer-specific",
  "kundenspezifisch",
  "services",
  "solutions",
  "integration",
  "integrator",
  "commissioning",
  "retrofit",
  "plc",
  "scada",
  "robot",
  "inline inspection",
  "aoi"
];

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const nextCharacter = content[index + 1];

    if (character === '"') {
      if (inQuotes && nextCharacter === '"') {
        current += '"';
        index += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (character === "," && !inQuotes) {
      currentRow.push(current);
      current = "";
      continue;
    }

    if ((character === "\n" || character === "\r") && !inQuotes) {
      if (character === "\r" && nextCharacter === "\n") {
        index += 1;
      }

      currentRow.push(current);
      current = "";
      if (currentRow.some((value) => value.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      continue;
    }

    current += character;
  }

  currentRow.push(current);
  if (currentRow.some((value) => value.length > 0)) {
    rows.push(currentRow);
  }

  return rows;
}

async function readRows(inputPath: string): Promise<DiffbotCsvRow[]> {
  const content = await fs.readFile(inputPath, "utf8");
  const rows = parseCsv(content);
  const [, ...dataRows] = rows;
  return dataRows.map((row) => {
    const [name = "", website = "", description = ""] = row;
    return {
      name: name.trim(),
      website: website.trim(),
      description: description.trim()
    };
  });
}

async function readAnalysis(analysisPath: string): Promise<Map<string, AnalysisRow>> {
  const raw = JSON.parse(await fs.readFile(analysisPath, "utf8")) as { allResults?: AnalysisRow[] };
  const rows = raw.allResults ?? [];
  return new Map(rows.map((row) => [buildKey(row.name, row.website), row]));
}

function buildKey(name: string, website?: string): string {
  return `${normalizeText(name)}::${normalizeWebsite(website)}`;
}

function normalizeText(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeWebsite(value: string | undefined): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");
  return normalized;
}

function normalizeDomainAsUrl(website: string | undefined): string | undefined {
  const normalized = normalizeWebsite(website);
  return normalized ? `https://${normalized}` : undefined;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    for (;;) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, () => runWorker()));
  return results;
}

function collectMatches(text: string, terms: string[]): string[] {
  return terms.filter((term) => text.includes(term));
}

function evaluateSummary(summary: string | null): {
  kept: boolean;
  score: number;
  matchedPositiveTerms: string[];
  matchedDeliveryTerms: string[];
  matchedNegativeTerms: string[];
  matchedSoftNegativeTerms: string[];
  blockedByNegative: boolean;
} {
  const normalizedSummary = normalizeText(summary).replace(/\s+/g, " ");
  const matchedPositiveTerms = collectMatches(normalizedSummary, POSITIVE_VISION_TERMS);
  const matchedDeliveryTerms = collectMatches(normalizedSummary, DELIVERY_TERMS);
  const matchedNegativeTerms = collectMatches(normalizedSummary, HARD_NEGATIVE_TERMS);
  const matchedSoftNegativeTerms = collectMatches(normalizedSummary, SOFT_NEGATIVE_TERMS);
  const matchedBonusTerms = collectMatches(normalizedSummary, BONUS_TERMS);
  const blockedByNegative = matchedNegativeTerms.length > 0;
  const deliveryStrength = matchedDeliveryTerms.length + matchedBonusTerms.length;
  const vendorPenalty = matchedSoftNegativeTerms.length;

  const score = (matchedPositiveTerms.length * 3)
    + (matchedDeliveryTerms.length * 3)
    + (matchedBonusTerms.length * 2)
    - (matchedNegativeTerms.length * 5)
    - (matchedSoftNegativeTerms.length * 2);
  const kept = !blockedByNegative
    && matchedPositiveTerms.length > 0
    && deliveryStrength >= 2
    && score >= 5
    && (deliveryStrength >= vendorPenalty || matchedDeliveryTerms.length >= 2);

  return {
    kept,
    score,
    matchedPositiveTerms,
    matchedDeliveryTerms,
    matchedNegativeTerms,
    matchedSoftNegativeTerms,
    blockedByNegative
  };
}

function toPercentage(value: number): number {
  return Number(value.toFixed(3));
}

async function main() {
  const inputPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_INPUT_PATH;
  const analysisPath = process.argv[3] ? path.resolve(process.argv[3]) : DEFAULT_ANALYSIS_PATH;
  const outputPath = path.join(
    path.dirname(inputPath),
    `${path.basename(inputPath, path.extname(inputPath))}.crawler-keyword-eval.json`
  );

  const rows = await readRows(inputPath);
  const analysisByKey = await readAnalysis(analysisPath);
  const webSearchAgent = new WebSearchAgent();

  const results = await mapWithConcurrency(rows, DEFAULT_CONCURRENCY, async (row) => {
    const analysis = analysisByKey.get(buildKey(row.name, row.website)) ?? analysisByKey.get(buildKey(row.name, undefined));
    if (!analysis) {
      throw new Error(`No analysis row found for ${row.name} (${row.website})`);
    }

    const domain = normalizeDomainAsUrl(row.website);
    const websiteProfile = await webSearchAgent.crawlCompanyWebsite(domain);
    const evaluation = evaluateSummary(websiteProfile?.summary ?? null);
    const strictRelevant = STRICT_TARGET_CATEGORIES.has(analysis.category);
    const broadRelevant = !NEGATIVE_CATEGORIES.has(analysis.category);

    return {
      name: row.name,
      website: row.website,
      category: analysis.category,
      strictRelevant,
      broadRelevant,
      crawlSucceeded: Boolean(websiteProfile?.summary),
      kept: evaluation.kept,
      score: evaluation.score,
      matchedPositiveTerms: evaluation.matchedPositiveTerms,
      matchedDeliveryTerms: evaluation.matchedDeliveryTerms,
      matchedNegativeTerms: evaluation.matchedNegativeTerms,
      matchedSoftNegativeTerms: evaluation.matchedSoftNegativeTerms,
      blockedByNegative: evaluation.blockedByNegative,
      summary: websiteProfile?.summary ?? null,
      relevantUrls: websiteProfile?.relevantUrls ?? []
    } satisfies CrawlEvaluation;
  });

  const crawlSucceededCount = results.filter((entry) => entry.crawlSucceeded).length;
  const keptCompanies = results.filter((entry) => entry.kept);
  const falsePositives = keptCompanies.filter((entry) => !entry.strictRelevant);
  const falseNegativesStrict = results.filter((entry) => entry.strictRelevant && !entry.kept);
  const falseNegativesBroad = results.filter((entry) => entry.broadRelevant && !entry.kept);

  const strictRelevantTotal = results.filter((entry) => entry.strictRelevant).length;
  const strictRelevantKept = keptCompanies.filter((entry) => entry.strictRelevant).length;
  const strictRelevantDropped = strictRelevantTotal - strictRelevantKept;
  const nonTargetStillIn = falsePositives.length;

  const broadRelevantTotal = results.filter((entry) => entry.broadRelevant).length;
  const broadRelevantKept = keptCompanies.filter((entry) => entry.broadRelevant).length;
  const broadRelevantDropped = broadRelevantTotal - broadRelevantKept;
  const irrelevantStillIn = keptCompanies.filter((entry) => !entry.broadRelevant).length;

  const report: Report = {
    createdAt: new Date().toISOString(),
    inputPath,
    analysisPath,
    outputPath,
    totalCompanies: results.length,
    crawlSucceededCount,
    crawlFailedCount: results.length - crawlSucceededCount,
    keptCount: keptCompanies.length,
    droppedCount: results.length - keptCompanies.length,
    strictTarget: {
      totalRelevant: strictRelevantTotal,
      keptRelevant: strictRelevantKept,
      droppedRelevant: strictRelevantDropped,
      nonTargetStillIn,
      precision: toPercentage(keptCompanies.length === 0 ? 0 : strictRelevantKept / keptCompanies.length),
      recall: toPercentage(strictRelevantTotal === 0 ? 0 : strictRelevantKept / strictRelevantTotal)
    },
    broadRelevant: {
      totalRelevant: broadRelevantTotal,
      keptRelevant: broadRelevantKept,
      droppedRelevant: broadRelevantDropped,
      irrelevantStillIn,
      precision: toPercentage(keptCompanies.length === 0 ? 0 : broadRelevantKept / keptCompanies.length),
      recall: toPercentage(broadRelevantTotal === 0 ? 0 : broadRelevantKept / broadRelevantTotal)
    },
    falsePositives,
    falseNegativesStrict,
    falseNegativesBroad,
    keptCompanies,
    results
  };

  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    totalCompanies: report.totalCompanies,
    crawlSucceededCount: report.crawlSucceededCount,
    crawlFailedCount: report.crawlFailedCount,
    keptCount: report.keptCount,
    strictTarget: report.strictTarget,
    broadRelevant: report.broadRelevant,
    falsePositiveNames: report.falsePositives.map((entry) => ({ name: entry.name, category: entry.category, score: entry.score })),
    sampleStrictFalseNegatives: report.falseNegativesStrict.slice(0, 15).map((entry) => ({ name: entry.name, category: entry.category, score: entry.score })),
    outputPath: report.outputPath
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});