import fs from "node:fs/promises";
import path from "node:path";

import { AzureOpenAIClient } from "../src/clients/azure-openai";
import { LeadCategory, PrequalificationConfig } from "../src/types";

type DiffbotCsvRow = {
  name: string;
  website: string;
  description: string;
};

type CategorizedRow = DiffbotCsvRow & {
  category: LeadCategory;
  relevanceScore: number;
  rationale: string;
};

const RELEVANT_CATEGORIES: LeadCategory[] = [
  "integrator_vision_industrial_ai",
  "integrator_vision_ai_consulting",
  "integrator_general_ai",
  "integrator_relevant_focus",
  "industrial_end_customer_scaled",
  "machine_builder_ai_enablement"
];

const PREQUALIFICATION: PrequalificationConfig = {
  mainContext:
    "Qualify conservatively for the currently selected ONE WARE categories only. Prefer companies with a clear machine vision, industrial inspection, visual quality control, industrial image processing, embedded vision, or industrial AI delivery focus. Also allow Vision AI or Industrial AI consulting if hands-on project delivery is explicit. Do not favor generic industrial automation integrators unless a clear vision, inspection, or concrete AI consulting angle is explicit. Exclude freelancers, camera or imaging manufacturers, software platforms, distributors, media, and hardware-led vendors unless they clearly fit another selected target category."
};

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

function toCsv(rows: DiffbotCsvRow[]): string {
  const escapeCell = (value: string) => {
    if (/[",\n\r]/.test(value)) {
      return `"${value.replace(/"/g, '""')}"`;
    }

    return value;
  };

  return [
    ["name", "website", "description"].join(","),
    ...rows.map((row) => [row.name, row.website, row.description].map(escapeCell).join(","))
  ].join("\n") + "\n";
}

async function main() {
  const inputPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(process.cwd(), "data", "diffbot", "eu_ai_machine_vision_integrators_100_full_entity_v3.csv");
  const outputPath = inputPath.replace(/\.csv$/i, ".analysis.json");
  const relevantCsvPath = inputPath.replace(/\.csv$/i, ".relevant.csv");
  const rows = await readRows(inputPath);
  const azureClient = new AzureOpenAIClient();
  const categorized: CategorizedRow[] = [];

  for (const row of rows) {
    const result = await azureClient.categorizeCompany(
      row.name,
      row.description,
      false,
      PREQUALIFICATION.mainContext,
      PREQUALIFICATION
    );

    categorized.push({
      ...row,
      category: result.category,
      relevanceScore: result.relevanceScore,
      rationale: result.rationale
    });
  }

  const categoryCounts = categorized.reduce<Record<string, number>>((accumulator, row) => {
    accumulator[row.category] = (accumulator[row.category] ?? 0) + 1;
    return accumulator;
  }, {});
  const relevant = categorized.filter((row) => RELEVANT_CATEGORIES.includes(row.category));
  const relevantRows: DiffbotCsvRow[] = relevant.map((row) => ({
    name: row.name,
    website: row.website,
    description: row.description
  }));

  const output = {
    inputPath,
    analyzedEntities: categorized.length,
    relevantEntities: relevant.length,
    irrelevantEntities: categorized.length - relevant.length,
    categoryCounts,
    relevantCategoryCounts: relevant.reduce<Record<string, number>>((accumulator, row) => {
      accumulator[row.category] = (accumulator[row.category] ?? 0) + 1;
      return accumulator;
    }, {}),
    selectedCompanies: relevant.map((row) => ({
      name: row.name,
      website: row.website,
      category: row.category,
      relevanceScore: row.relevanceScore,
      rationale: row.rationale
    })),
    excludedSample: categorized.filter((row) => !RELEVANT_CATEGORIES.includes(row.category)).slice(0, 20).map((row) => ({
      name: row.name,
      website: row.website,
      category: row.category,
      relevanceScore: row.relevanceScore,
      rationale: row.rationale
    })),
    relevantCsvPath,
    allResults: categorized
  };

  await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await fs.writeFile(relevantCsvPath, toCsv(relevantRows), "utf8");
  process.stdout.write(`${JSON.stringify({
    outputPath,
    relevantCsvPath,
    analyzedEntities: output.analyzedEntities,
    relevantEntities: output.relevantEntities,
    categoryCounts: output.categoryCounts,
    relevantCategoryCounts: output.relevantCategoryCounts,
    selectedCompanies: output.selectedCompanies,
    excludedSample: output.excludedSample
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});