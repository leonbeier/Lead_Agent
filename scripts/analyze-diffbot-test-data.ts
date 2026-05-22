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
  "integrator_vision_ai_consulting_freelancer",
  "integrator_general_ai",
  "integrator_relevant_focus",
  "industrial_end_customer_scaled",
  "camera_manufacturer_partner",
  "machine_builder_ai_enablement",
  "software_platform_embedding"
];

const INPUT_PATH = path.join(process.cwd(), "data", "diffbot", "eu_ai_machine_vision_integrators_100.csv");
const OUTPUT_PATH = path.join(process.cwd(), "data", "diffbot", "eu_ai_machine_vision_integrators_100.analysis.json");

const PREQUALIFICATION: PrequalificationConfig = {
  mainContext:
    "Qualify conservatively for European delivery-led software, automation, robotics, and machine-vision companies. Prefer recurring customer project ownership, industrial implementation work, computer vision or industrial AI potential, and system-integration evidence. Downgrade pure hardware vendors, generic manufacturers without delivery ownership, distributors, media, and companies that only mention automation as a product market."
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

async function readRows(): Promise<DiffbotCsvRow[]> {
  const content = await fs.readFile(INPUT_PATH, "utf8");
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

async function main() {
  const rows = await readRows();
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

  const counts = categorized.reduce<Record<string, number>>((accumulator, row) => {
    accumulator[row.category] = (accumulator[row.category] ?? 0) + 1;
    return accumulator;
  }, {});

  const relevant = categorized.filter((row) => RELEVANT_CATEGORIES.includes(row.category));
  const output = {
    inputPath: INPUT_PATH,
    analyzedEntities: categorized.length,
    relevantEntities: relevant.length,
    irrelevantEntities: categorized.length - relevant.length,
    categoryCounts: counts,
    relevantCategoryCounts: relevant.reduce<Record<string, number>>((accumulator, row) => {
      accumulator[row.category] = (accumulator[row.category] ?? 0) + 1;
      return accumulator;
    }, {}),
    topRelevant: relevant
      .slice()
      .sort((left, right) => right.relevanceScore - left.relevanceScore)
      .slice(0, 40),
    allResults: categorized
  };

  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    outputPath: OUTPUT_PATH,
    analyzedEntities: output.analyzedEntities,
    relevantEntities: output.relevantEntities,
    categoryCounts: output.categoryCounts,
    relevantCategoryCounts: output.relevantCategoryCounts
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});