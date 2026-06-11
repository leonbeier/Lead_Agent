import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildLiveExaRecurringDomains,
  buildRecentLiveExaRecurringDomains,
  canonicalizeLiveExaExcludedDomainState,
  normalizeLiveExaQueryRuns,
  readJsonFileWithRecovery,
  resolveLeadAgentDataPaths
} from "../src/control-plane";

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

test("resolveLeadAgentDataPaths uses the Railway volume mount path when no explicit data dir is set", () => {
  const cwd = path.join(path.sep, "workspace", "lead-agent");
  const volumePath = path.join(path.sep, "railway-volume");
  const paths = resolveLeadAgentDataPaths({
    cwd,
    railwayVolumeMountPath: volumePath,
    hasMountedDataDir: false
  });

  assert.equal(paths.runtimeDataDirectory, path.resolve(volumePath));
  assert.equal(paths.cacheDatabaseDirectory, path.join(path.resolve(volumePath), "cache-db"));
  assert.equal(paths.liveCacheDatabasePath, path.join(path.resolve(volumePath), "cache-db", "live-run-cache.sqlite"));
  assert.notEqual(paths.runtimeDataDirectory, paths.seedDataDirectory);
});

test("resolveLeadAgentDataPaths prefers an explicit data dir over the Railway volume mount path", () => {
  const cwd = path.join(path.sep, "workspace", "lead-agent");
  const runtimeDir = path.join(cwd, ".runtime-data");
  const volumePath = path.join(path.sep, "railway-volume");
  const paths = resolveLeadAgentDataPaths({
    cwd,
    dataDirEnv: runtimeDir,
    railwayVolumeMountPath: volumePath,
    hasMountedDataDir: false
  });

  assert.equal(paths.runtimeDataDirectory, path.resolve(runtimeDir));
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

test("buildRecentLiveExaRecurringDomains keeps only domains from the latest Exa query window", () => {
  const recurringDomains = buildRecentLiveExaRecurringDomains(
    [
      {
        timestamp: "2026-06-04T10:10:00.000Z",
        domain: "recent-repeat.example",
        discoveryQuery: "query two"
      },
      {
        timestamp: "2026-06-04T10:09:00.000Z",
        domain: "recent-repeat.example",
        discoveryQuery: "query one"
      },
      {
        timestamp: "2026-06-04T08:00:00.000Z",
        domain: "old.example",
        discoveryQuery: "query zero"
      }
    ],
    [
      {
        timestamp: "2026-06-04T10:10:00.000Z",
        filterName: "Recent Run",
        query: "recent query"
      },
      {
        timestamp: "2026-06-04T10:09:00.000Z",
        filterName: "Recent Run",
        query: "recent query follow-up"
      }
    ]
  );

  assert.equal(recurringDomains.length, 1);
  assert.equal(recurringDomains[0]?.domain, "recent-repeat.example");
  assert.equal(recurringDomains[0]?.occurrences, 2);
});

test("canonicalizeLiveExaExcludedDomainState rebuilds stale request indices from priority order", () => {
  const canonical = canonicalizeLiveExaExcludedDomainState([
    {
      domain: "sciaky.com",
      category: "historical_exa",
      includedInRequest: true,
      requestIndex: 0,
      recentOccurrences: 1,
      occurrences: 1
    },
    {
      domain: "u-experten.de",
      category: "hubspot",
      includedInRequest: true,
      requestIndex: 40,
      recentOccurrences: 2,
      occurrences: 3
    },
    {
      domain: "hahn-ie.com",
      category: "hubspot",
      includedInRequest: true,
      requestIndex: 42,
      recentOccurrences: 2,
      occurrences: 3
    },
    {
      domain: "data-spree.com",
      category: "hubspot",
      includedInRequest: true,
      requestIndex: 43,
      recentOccurrences: 2,
      occurrences: 3
    }
  ]);

  assert.deepEqual(canonical.excludedDomains?.slice(0, 4), [
    "u-experten.de",
    "hahn-ie.com",
    "data-spree.com",
    "sciaky.com"
  ]);
  assert.equal(canonical.excludedDomainDetails?.find((entry) => entry.domain === "u-experten.de")?.requestIndex, 0);
  assert.equal(canonical.excludedDomainDetails?.find((entry) => entry.domain === "hahn-ie.com")?.requestIndex, 1);
  assert.equal(canonical.excludedDomainDetails?.find((entry) => entry.domain === "data-spree.com")?.requestIndex, 2);
  assert.equal(canonical.excludedDomainDetails?.find((entry) => entry.domain === "sciaky.com")?.requestIndex, 3);
});

test("normalizeLiveExaQueryRuns keeps heavy planner debug only on the newest run", () => {
  const makeRun = (suffix: string, timestamp: string) => ({
    timestamp,
    filterName: "Germany Machine Vision System Integrators",
    query: `query ${suffix}`,
    plannedQueries: [`planned ${suffix}`],
    promptMessages: [{ role: "system", content: `prompt ${suffix}` }],
    excludedDomains: [`excluded-${suffix}.com`],
    excludedDomainDetails: [
      {
        domain: `excluded-${suffix}.com`,
        category: "hubspot" as const,
        includedInRequest: true,
        requestIndex: 0
      }
    ]
  });

  // Newest run is intentionally NOT first in the input array to prove selection is by timestamp.
  const normalized = normalizeLiveExaQueryRuns([
    makeRun("old", "2026-06-04T10:00:00.000Z"),
    makeRun("new", "2026-06-04T12:00:00.000Z"),
    makeRun("middle", "2026-06-04T11:00:00.000Z")
  ]);

  const newest = normalized.find((run) => run.query === "query new");
  const older = normalized.filter((run) => run.query !== "query new");

  assert.ok(newest);
  assert.ok(Array.isArray(newest?.promptMessages) && newest.promptMessages.length > 0);
  assert.ok(Array.isArray(newest?.excludedDomainDetails) && newest.excludedDomainDetails.length > 0);

  assert.equal(older.length, 2);
  for (const run of older) {
    assert.equal(run.promptMessages, undefined);
    assert.equal(run.excludedDomainDetails, undefined);
    // Lightweight fields the search-history list relies on are retained.
    assert.ok(run.query);
    assert.ok(Array.isArray(run.plannedQueries) && run.plannedQueries.length > 0);
  }
});
