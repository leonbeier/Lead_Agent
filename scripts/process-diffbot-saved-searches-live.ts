import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

type AnalysisSummary = {
  categoryCounts: Record<string, number>;
  qualifiedCategoryBreakdown: Record<string, number>;
};

type LiveProcessingSummary = {
  outputPath: string;
  inputCount: number;
  alreadyInHubSpotCount: number;
  notInHubSpotCount: number;
  crawledCount: number;
  crawlFailedCount: number;
  categorizedCount: number;
  integratorQualifiedCount: number;
  qualifiedCategoryBreakdown: Record<string, number>;
  researchBriefCount: number;
  companiesNeedingApolloContactsCount: number;
  companySyncedCount: number;
  contactSyncedCount: number;
  syncedCount: number;
  hubspotErrors: string[];
};

type BatchEntry = {
  fileName: string;
  filePath: string;
  processing: LiveProcessingSummary;
  categories: AnalysisSummary;
};

type BatchReport = {
  createdAt: string;
  inputFiles: string[];
  aggregate: Record<string, unknown>;
  results: BatchEntry[];
};

const DIFFBOT_DIR = path.join(process.cwd(), "data", "diffbot");
const OUTPUT_PATH = path.join(DIFFBOT_DIR, "diffbot-saved-searches-live-batch-report.json");
const FILE_PRIORITY: string[] = [
  "eu_ai_machine_vision_integrators_precision_v4.csv",
  "vision_integrators_dach_plus_50_v1.csv",
  "eu_ai_machine_vision_integrators_50_balanced_v3.csv",
  "eu_ai_machine_vision_integrators_100.csv",
  "eu_ai_machine_vision_integrators_100_names_only_v2.csv",
  "eu_ai_machine_vision_integrators_100_full_entity_v3.csv",
  "eu_ai_machine_vision_integrators_472_full_entity_v4.csv",
  "eu_industrial_ai_integrators_union_1000_v1.csv"
];

function isPrimaryDiffbotCsv(fileName: string): boolean {
  return fileName.endsWith(".csv") && !fileName.endsWith(".relevant.csv");
}

async function collectInputFiles(): Promise<string[]> {
  const entries = await fs.readdir(DIFFBOT_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && isPrimaryDiffbotCsv(entry.name))
    .map((entry) => path.join(DIFFBOT_DIR, entry.name))
    .sort((left, right) => left.localeCompare(right));

  const priorityIndex = new Map(FILE_PRIORITY.map((fileName, index) => [fileName, index]));

  return files.sort((left, right) => {
    const leftName = path.basename(left);
    const rightName = path.basename(right);
    const leftPriority = priorityIndex.get(leftName) ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = priorityIndex.get(rightName) ?? Number.MAX_SAFE_INTEGER;
    return leftPriority - rightPriority || leftName.localeCompare(rightName);
  });
}

function accumulateCounts(target: Record<string, number>, source: Record<string, number>): Record<string, number> {
  for (const [category, count] of Object.entries(source)) {
    target[category] = (target[category] ?? 0) + count;
  }

  return target;
}

async function runJsonCommand(command: string, args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}\n${stderr}`));
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(new Error(`Command produced no JSON output: ${command} ${args.join(" ")}`));
        return;
      }

      try {
        resolve(JSON.parse(trimmed));
      } catch (error) {
        reject(new Error(`Failed to parse JSON output from ${command} ${args.join(" ")}: ${trimmed.slice(-4000)}`));
      }
    });
  });
}

async function loadProcessingReport(reportPath: string): Promise<{ categoryBreakdown: Record<string, number>; qualifiedCategoryBreakdown: Record<string, number> }> {
  const content = await fs.readFile(reportPath, "utf8");
  const parsed = JSON.parse(content) as { categoryBreakdown?: Record<string, number>; qualifiedCategoryBreakdown?: Record<string, number> };
  return {
    categoryBreakdown: parsed.categoryBreakdown ?? {},
    qualifiedCategoryBreakdown: parsed.qualifiedCategoryBreakdown ?? {}
  };
}

async function loadExistingBatchReport(): Promise<BatchEntry[]> {
  try {
    const content = await fs.readFile(OUTPUT_PATH, "utf8");
    const parsed = JSON.parse(content) as Partial<BatchReport>;
    return Array.isArray(parsed.results) ? parsed.results : [];
  } catch {
    return [];
  }
}

async function main() {
  const inputFiles = await collectInputFiles();
  const results: BatchEntry[] = await loadExistingBatchReport();
  const processedFiles = new Set(results.map((entry) => entry.fileName));

  const writeReport = async () => {
    const aggregate = results.reduce(
      (accumulator, entry) => {
        accumulator.filesProcessed += 1;
        accumulator.inputCount += entry.processing.inputCount;
        accumulator.alreadyInHubSpotCount += entry.processing.alreadyInHubSpotCount;
        accumulator.notInHubSpotCount += entry.processing.notInHubSpotCount;
        accumulator.crawledCount += entry.processing.crawledCount;
        accumulator.crawlFailedCount += entry.processing.crawlFailedCount;
        accumulator.categorizedCount += entry.processing.categorizedCount;
        accumulator.integratorQualifiedCount += entry.processing.integratorQualifiedCount;
        accumulator.researchBriefCount += entry.processing.researchBriefCount;
        accumulator.companiesNeedingApolloContactsCount += entry.processing.companiesNeedingApolloContactsCount;
        accumulator.companySyncedCount += entry.processing.companySyncedCount;
        accumulator.contactSyncedCount += entry.processing.contactSyncedCount;
        accumulator.syncedCount += entry.processing.syncedCount;
        accumulateCounts(accumulator.categoryCounts, entry.categories.categoryCounts);
        accumulateCounts(accumulator.qualifiedCategoryBreakdown, entry.categories.qualifiedCategoryBreakdown);
        accumulator.hubspotErrors.push(...entry.processing.hubspotErrors.map((error) => `${entry.fileName}: ${error}`));
        return accumulator;
      },
      {
        filesProcessed: 0,
        inputCount: 0,
        alreadyInHubSpotCount: 0,
        notInHubSpotCount: 0,
        crawledCount: 0,
        crawlFailedCount: 0,
        categorizedCount: 0,
        integratorQualifiedCount: 0,
        researchBriefCount: 0,
        companiesNeedingApolloContactsCount: 0,
        companySyncedCount: 0,
        contactSyncedCount: 0,
        syncedCount: 0,
        categoryCounts: {} as Record<string, number>,
        qualifiedCategoryBreakdown: {} as Record<string, number>,
        hubspotErrors: [] as string[]
      }
    );

    const report = {
      createdAt: new Date().toISOString(),
      inputFiles,
      aggregate,
      results
    };

    await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return aggregate;
  };

  for (const inputFile of inputFiles) {
    const fileName = path.basename(inputFile);
    if (processedFiles.has(fileName)) {
      process.stdout.write(`\n=== Skipping ${fileName} (already processed) ===\n`);
      continue;
    }

    process.stdout.write(`\n=== Processing ${fileName} ===\n`);

    const processing = (await runJsonCommand("npx", ["tsx", "scripts/process-diffbot-test-data-live.ts", inputFile])) as LiveProcessingSummary;
    const categories = await loadProcessingReport(processing.outputPath);

    results.push({
      fileName,
      filePath: inputFile,
      processing,
      categories: {
        categoryCounts: categories.categoryBreakdown,
        qualifiedCategoryBreakdown: categories.qualifiedCategoryBreakdown
      }
    });
    processedFiles.add(fileName);

    const aggregate = await writeReport();
    process.stdout.write(`${JSON.stringify({ latestFile: fileName, aggregate }, null, 2)}\n`);
  }
  const aggregate = await writeReport();
  process.stdout.write(`${JSON.stringify({ outputPath: OUTPUT_PATH, aggregate }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});