import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTestFiles(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(entryPath);
    }
  }

  return files;
}

async function main() {
  const testsRoot = path.resolve(process.cwd(), "tests");
  const testFiles = (await collectTestFiles(testsRoot)).sort();

  if (testFiles.length === 0) {
    console.log("No test files found.");
    return;
  }

  for (const testFile of testFiles) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--test", testFile], {
        stdio: "inherit",
        env: process.env
      });

      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(`Tests failed in ${testFile} with exit code ${code ?? 1}.`));
      });
      child.on("error", reject);
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});