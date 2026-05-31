import fs from "node:fs/promises";
import path from "node:path";

import { OrganizationFilter, CompanySample } from "../types";

type DiffbotCsvRow = {
  name: string;
  website: string;
  description: string;
};

const DEFAULT_DIFFBOT_TEST_DATA_PATH = path.join(process.cwd(), "data", "diffbot", "eu_ai_machine_vision_integrators_100.csv");

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

export class DiffbotTestDataClient {
  private cachedRows?: DiffbotCsvRow[];
  private cachedPath?: string;

  async fetchOrganizationSample(
    filter: OrganizationFilter,
    limit: number,
    page: number,
    shouldSkipDomain?: (domain: string) => boolean
  ): Promise<CompanySample[]> {
    const rows = await this.getRows();
    const filteredRows = rows.filter((row) => !row.website || !shouldSkipDomain?.(row.website));
    const startIndex = Math.max(0, (page - 1) * limit);
    const pageRows = filteredRows.slice(startIndex, startIndex + limit);

    return pageRows.map((row) => ({
      name: row.name,
      domain: row.website ? `https://${row.website.replace(/^https?:\/\//i, "")}` : undefined,
      shortDescription: row.description,
      sourceFilter: `${filter.name} (diffbot-test-data)`
    }));
  }

  private async getRows(): Promise<DiffbotCsvRow[]> {
    const inputPath = process.env.DIFFBOT_TEST_DATA_PATH?.trim() || DEFAULT_DIFFBOT_TEST_DATA_PATH;

    if (this.cachedRows && this.cachedPath === inputPath) {
      return this.cachedRows;
    }

    const content = await fs.readFile(inputPath, "utf8");
    const rows = parseCsv(content);
    const [, ...dataRows] = rows;
    this.cachedPath = inputPath;
    this.cachedRows = dataRows.map((row) => {
      const [name = "", website = "", description = ""] = row;
      return {
        name: name.trim(),
        website: website.trim(),
        description: description.trim()
      };
    });

    return this.cachedRows;
  }
}