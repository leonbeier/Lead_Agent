import { readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
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

function runTestFile(testFile) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--test", testFile], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });

    child.on("exit", (code) => {
      resolve({ testFile, code: code ?? 1, output });
    });
    child.on("error", (error) => {
      resolve({ testFile, code: 1, output: `${output}\n${error instanceof Error ? error.message : error}` });
    });
  });
}

async function runWithConcurrency(testFiles, concurrency) {
  const results = [];
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= testFiles.length) {
        return;
      }

      const testFile = testFiles[index];
      const result = await runTestFile(testFile);
      results.push(result);

      const relative = path.relative(process.cwd(), testFile);
      const status = result.code === 0 ? "PASS" : "FAIL";
      // Print each file's full output as a contiguous block once it finishes so the buffered
      // TAP lines from concurrent files never interleave.
      process.stdout.write(`\n===== ${status} ${relative} (${results.length}/${testFiles.length}) =====\n`);
      process.stdout.write(result.output.trimEnd() + "\n");
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, testFiles.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  const testsRoot = path.resolve(process.cwd(), "tests");
  const testFiles = (await collectTestFiles(testsRoot)).sort();

  if (testFiles.length === 0) {
    console.log("No test files found.");
    return;
  }

  // Each test file still runs in its own isolated process (so shared-state tests are unaffected),
  // but multiple files now run concurrently instead of one-at-a-time. Default to the machine's
  // parallelism, capped so we don't oversubscribe; override with TEST_CONCURRENCY when needed.
  const defaultConcurrency = Math.max(2, Math.min(8, os.availableParallelism?.() ?? os.cpus().length));
  const concurrency = Number(process.env.TEST_CONCURRENCY) || defaultConcurrency;

  const startedAt = Date.now();
  const results = await runWithConcurrency(testFiles, concurrency);
  const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  const failed = results.filter((result) => result.code !== 0);
  process.stdout.write(`\n===== SUMMARY: ${results.length - failed.length}/${results.length} files passed, ${concurrency}-way parallel, ${durationSeconds}s =====\n`);

  if (failed.length > 0) {
    for (const result of failed) {
      process.stdout.write(`FAILED: ${path.relative(process.cwd(), result.testFile)} (exit ${result.code})\n`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});