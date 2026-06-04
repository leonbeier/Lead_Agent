import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildLiveExaRecurringDomains, readJsonFileWithRecovery, resolveLeadAgentDataPaths } from "../src/control-plane";

test("readJsonFileWithRecovery backs up corrupted JSON and restores defaults", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lead-agent-control-plane-"));
  const filePath = path.join(tempDir, "corrupted.json");
  const defaultValue = { records: [] };

  try {
    await fs.writeFile(filePath, '{"records":[{"domain":"broken"}', "utf8");

    const recovered = await readJsonFileWithRecovery(filePath, defaultValue);
    const repairedContent = await fs.readFile(filePath, "utf8");
    const files = await fs.readdir(tempDir);
    const backupFile = files.find((entry) => entry.startsWith("corrupted.json.corrupt-"));

    assert.deepEqual(recovered, defaultValue);
    assert.deepEqual(JSON.parse(repairedContent), defaultValue);
    assert.ok(backupFile);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveLeadAgentDataPaths separates runtime data from repo seed data when a mounted data dir exists", () => {
  const cwd = path.join(path.sep, "workspace", "lead-agent");
  const paths = resolveLeadAgentDataPaths({
    cwd,
    hasMountedDataDir: true
  });

  assert.equal(paths.runtimeDataDirectory, "/data");
  assert.equal(paths.seedDataDirectory, path.join(cwd, "data"));
  assert.equal(paths.settingsPath, path.join("/data", "lead-agent-settings.json"));
  assert.equal(paths.seedSettingsPath, path.join(cwd, "data", "lead-agent-settings.json"));
  assert.equal(paths.liveCacheDatabasePath, path.join("/data", "cache-db", "live-run-cache.sqlite"));
  assert.equal(paths.seedLiveCacheDatabasePath, path.join(cwd, "data", "cache-db", "live-run-cache.sqlite"));
});

test("resolveLeadAgentDataPaths honors explicit runtime directories", () => {
  const cwd = path.join(path.sep, "workspace", "lead-agent");
  const runtimeDir = path.join(cwd, ".runtime-data");
  const cacheDir = path.join(cwd, ".runtime-cache");
  const paths = resolveLeadAgentDataPaths({
    cwd,
    dataDirEnv: runtimeDir,
    cacheDirEnv: cacheDir,
    hasMountedDataDir: false
  });

  assert.equal(paths.runtimeDataDirectory, path.resolve(runtimeDir));
  assert.equal(paths.cacheDatabaseDirectory, path.resolve(cacheDir));
  assert.equal(paths.liveExaCachePath, path.join(path.resolve(runtimeDir), "live-exa-cache.json"));
  assert.equal(paths.debugCacheDatabasePath, path.join(path.resolve(cacheDir), "testlab-cache.sqlite"));
});

test("buildLiveExaRecurringDomains raises priority for repeated websites and sorts them to the top", () => {
  const recurringDomains = buildLiveExaRecurringDomains([
    {
      timestamp: "2026-06-04T10:10:00.000Z",
      domain: "repeat.example",
      discoveryQuery: "query two"
    },
    {
      timestamp: "2026-06-04T10:00:00.000Z",
      domain: "single.example",
      discoveryQuery: "query one"
    },
    {
      timestamp: "2026-06-04T09:55:00.000Z",
      domain: "repeat.example",
      discoveryQuery: "query zero"
    }
  ]);

  assert.equal(recurringDomains?.[0]?.domain, "repeat.example");
  assert.equal(recurringDomains?.[0]?.occurrences, 2);
  assert.equal(recurringDomains?.[0]?.priority, 2);
  assert.equal(recurringDomains?.[1]?.domain, "single.example");
});