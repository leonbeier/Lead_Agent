import fs from "node:fs/promises";
import path from "node:path";

import { LeadPipelineAgent } from "../src/agents/lead-pipeline";
import { WebSearchAgent } from "../src/clients/web-search-agent";
import { ControlPlaneStore } from "../src/control-plane";
import { LeadCategory } from "../src/types";

type DiffbotCsvRow = {
  name: string;
  website: string;
  description: string;
};

type DropoffReport = {
  createdAt: string;
  inputPath: string;
  outputPath: string;
  inputCount: number;
  crawlFailures: Array<{
    name: string;
    website: string;
  }>;
  categorizedByCategory: Record<string, Array<{
    name: string;
    website?: string;
    relevanceScore: number;
  }>>;
  qualified: Array<{
    name: string;
    website?: string;
    category: LeadCategory;
    relevanceScore: number;
  }>;
};

const DEFAULT_INPUT_PATH = path.join(process.cwd(), "data", "diffbot", "eu_ai_machine_vision_integrators_50_balanced_v3.relevant.csv");
const TARGET_CATEGORIES: LeadCategory[] = [
  "integrator_vision_industrial_ai",
  "integrator_vision_ai_consulting_freelancer",
  "integrator_general_ai"
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
  return rows.slice(1).map((row) => ({
    name: (row[0] ?? "").trim(),
    website: (row[1] ?? "").trim(),
    description: (row[2] ?? "").trim()
  }));
}

function normalizeDomain(website: string | undefined): string | undefined {
  const normalized = String(website ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");

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

async function main() {
  const inputPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_INPUT_PATH;
  const outputPath = inputPath.replace(/\.csv$/i, ".dropoff-analysis.json");
  const rows = await readRows(inputPath);
  const store = new ControlPlaneStore();
  const settings = await store.getSettings();
  const learning = await store.getLearning();
  const pipeline = new LeadPipelineAgent() as unknown as {
    categorizeCompanies: (
      companies: Array<{ name: string; domain?: string; shortDescription: string; sourceFilter: string }>,
      dryRun: boolean,
      mainContext?: string,
      prequalification?: typeof settings.prequalification,
      targetCategories?: LeadCategory[],
      learning?: typeof learning
    ) => Promise<Array<{ name: string; domain?: string; category: LeadCategory; relevanceScore: number }>>;
  };
  const webSearchAgent = new WebSearchAgent();

  const crawled = await mapWithConcurrency(rows, 6, async (row) => {
    const domain = normalizeDomain(row.website);
    const websiteProfile = await webSearchAgent.crawlCompanyWebsite(domain);
    return { row, domain, websiteProfile };
  });

  const crawlFailures = crawled
    .filter((entry) => !entry.websiteProfile?.summary)
    .map((entry) => ({
      name: entry.row.name,
      website: entry.row.website
    }));

  const categorized = await pipeline.categorizeCompanies(
    crawled
      .filter((entry) => entry.websiteProfile?.summary)
      .map((entry) => ({
        name: entry.row.name,
        domain: entry.domain,
        shortDescription: entry.websiteProfile?.summary ?? entry.row.description,
        sourceFilter: "diffbot-live-dropoff-analysis"
      })),
    false,
    settings.mainContext,
    settings.prequalification,
    TARGET_CATEGORIES,
    learning
  );

  const categorizedByCategory = categorized.reduce<Record<string, Array<{ name: string; website?: string; relevanceScore: number }>>>((accumulator, company) => {
    const website = rows.find((row) => row.name === company.name)?.website;
    (accumulator[company.category] ??= []).push({
      name: company.name,
      website,
      relevanceScore: company.relevanceScore
    });
    return accumulator;
  }, {});

  const report: DropoffReport = {
    createdAt: new Date().toISOString(),
    inputPath,
    outputPath,
    inputCount: rows.length,
    crawlFailures,
    categorizedByCategory,
    qualified: categorized
      .filter((company) => TARGET_CATEGORIES.includes(company.category))
      .map((company) => ({
        name: company.name,
        website: rows.find((row) => row.name === company.name)?.website,
        category: company.category,
        relevanceScore: company.relevanceScore
      }))
  };

  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});