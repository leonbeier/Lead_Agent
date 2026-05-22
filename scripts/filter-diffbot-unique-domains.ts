import fs from "node:fs/promises";
import path from "node:path";

type DiffbotCsvRow = {
  name: string;
  website: string;
  description: string;
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

function toCsv(rows: DiffbotCsvRow[]): string {
  const escapeCell = (value: string) => /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  return [
    ["name", "website", "description"].join(","),
    ...rows.map((row) => [row.name, row.website, row.description].map(escapeCell).join(","))
  ].join("\n") + "\n";
}

function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0] ?? "";
}

async function readRows(filePath: string): Promise<DiffbotCsvRow[]> {
  const content = await fs.readFile(filePath, "utf8");
  const rows = parseCsv(content);
  const [, ...dataRows] = rows;

  return dataRows.map((row) => ({
    name: (row[0] ?? "").trim(),
    website: (row[1] ?? "").trim(),
    description: (row[2] ?? "").trim()
  }));
}

async function main() {
  const inputPath = process.argv[2] ? path.resolve(process.argv[2]) : "";
  if (!inputPath) {
    throw new Error("Missing input CSV path.");
  }

  const diffbotDir = path.dirname(inputPath);
  const inputFileName = path.basename(inputPath);
  const outputPath = inputPath.replace(/\.csv$/i, ".novel.csv");
  const rows = await readRows(inputPath);

  const existingDomains = new Map<string, string[]>();
  const files = await fs.readdir(diffbotDir, { withFileTypes: true });

  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".csv") || file.name === inputFileName || file.name.endsWith(".relevant.csv") || file.name.endsWith(".novel.csv")) {
      continue;
    }

    const fileRows = await readRows(path.join(diffbotDir, file.name));
    for (const row of fileRows) {
      const domain = normalizeDomain(row.website);
      if (!domain) {
        continue;
      }

      const existingFiles = existingDomains.get(domain) ?? [];
      if (!existingFiles.includes(file.name)) {
        existingFiles.push(file.name);
        existingDomains.set(domain, existingFiles);
      }
    }
  }

  const overlaps: Array<{ name: string; website: string; existingFiles: string[] }> = [];
  const novelRows = rows.filter((row) => {
    const domain = normalizeDomain(row.website);
    if (!domain) {
      return true;
    }

    const existingFiles = existingDomains.get(domain);
    if (!existingFiles?.length) {
      return true;
    }

    overlaps.push({
      name: row.name,
      website: row.website,
      existingFiles
    });
    return false;
  });

  await fs.writeFile(outputPath, toCsv(novelRows), "utf8");
  process.stdout.write(`${JSON.stringify({
    inputPath,
    outputPath,
    inputCount: rows.length,
    novelCount: novelRows.length,
    overlapCount: overlaps.length,
    overlaps
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});