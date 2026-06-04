import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CacheDatabaseStore } from "../src/cache-database";

test("CacheDatabaseStore keeps live Exa and screening data in sqlite tables", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lead-agent-cache-db-"));
  const databasePath = path.join(tempDir, "live-cache.sqlite");
  const store = new CacheDatabaseStore(databasePath);

  try {
    store.writeLiveExaCache({
      entries: [
        {
          timestamp: "2026-05-23T14:00:00.000Z",
          domain: "example.com",
          companyName: "Example",
          discoveryQuery: "vision ai germany",
          sourceFilter: "exa-search:test"
        }
      ],
      discoveredDomains: ["example.com"]
    });
    store.writeScreeningDatabase({
      records: [
        {
          companyName: "Example",
          normalizedName: "example",
          domain: "https://example.com",
          normalizedDomain: "example.com",
          category: "other",
          relevanceScore: 25,
          rationale: "manual review",
          sourceFilter: "Germany vision integrators",
          checkedAt: "2026-05-23T14:00:01.000Z"
        }
      ]
    });

    const liveExaCache = store.readLiveExaCache();
    const screening = store.readScreeningDatabase();

    assert.equal(liveExaCache.entries.length, 1);
    assert.deepEqual(liveExaCache.discoveredDomains, ["example.com"]);
    assert.equal(screening.records.length, 1);
    assert.equal(screening.records[0]?.normalizedDomain, "example.com");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("CacheDatabaseStore preserves repeated live Exa domains so recurring priority can be rebuilt", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lead-agent-cache-db-"));
  const databasePath = path.join(tempDir, "live-cache-recurring.sqlite");
  const store = new CacheDatabaseStore(databasePath);

  try {
    store.writeLiveExaCache({
      entries: [
        {
          timestamp: "2026-05-23T14:05:00.000Z",
          domain: "repeat.example",
          companyName: "Repeat Example",
          discoveryQuery: "query two",
          sourceFilter: "exa-search:test"
        },
        {
          timestamp: "2026-05-23T14:00:00.000Z",
          domain: "repeat.example",
          companyName: "Repeat Example",
          discoveryQuery: "query one",
          sourceFilter: "exa-search:test"
        }
      ],
      discoveredDomains: ["repeat.example"]
    });

    const liveExaCache = store.readLiveExaCache();

    assert.equal(liveExaCache.entries.length, 2);
    assert.deepEqual(liveExaCache.entries.map((entry) => entry.domain), ["repeat.example", "repeat.example"]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("CacheDatabaseStore persists live Exa excluded-domain details for UI inspection", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lead-agent-cache-db-"));
  const databasePath = path.join(tempDir, "live-cache-excluded-details.sqlite");
  const store = new CacheDatabaseStore(databasePath);

  try {
    store.writeLiveExaCache({
      entries: [],
      discoveredDomains: [],
      queryRuns: [
        {
          timestamp: "2026-06-04T11:40:00.000Z",
          filterName: "Germany Machine Vision System Integrators",
          query: "test query",
          excludedDomains: ["example.com"],
          excludedDomainDetails: [
            {
              domain: "example.com",
              category: "hubspot",
              includedInRequest: true,
              requestIndex: 14,
              occurrences: 3,
              priority: 3,
              lastSeenAt: "2026-06-04T11:39:00.000Z"
            }
          ]
        }
      ]
    });

    const liveExaCache = store.readLiveExaCache();

    assert.equal(liveExaCache.queryRuns?.[0]?.excludedDomainDetails?.[0]?.domain, "example.com");
    assert.equal(liveExaCache.queryRuns?.[0]?.excludedDomainDetails?.[0]?.includedInRequest, true);
    assert.equal(liveExaCache.queryRuns?.[0]?.excludedDomainDetails?.[0]?.requestIndex, 14);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("CacheDatabaseStore keeps test-lab query history separate from discovered domains", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lead-agent-cache-db-"));
  const databasePath = path.join(tempDir, "testlab-cache.sqlite");
  const store = new CacheDatabaseStore(databasePath);

  try {
    store.writeTestLabExaCache({
      queryHistory: ["query one", "query two"],
      discoveredDomains: ["first.example", "second.example"]
    });

    const cache = store.readTestLabExaCache();

    assert.deepEqual(cache.queryHistory, ["query one", "query two"]);
    assert.deepEqual(cache.discoveredDomains, ["first.example", "second.example"]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("CacheDatabaseStore preserves repeated test-lab queries with their matching insights", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lead-agent-cache-db-"));
  const databasePath = path.join(tempDir, "testlab-duplicates.sqlite");
  const store = new CacheDatabaseStore(databasePath);

  try {
    store.writeTestLabExaCache({
      queryHistory: ["repeat query", "repeat query", "new query"],
      queryInsights: [
        {
          query: "repeat query",
          timestamp: "2026-05-23T14:00:00.000Z",
          note: "first run"
        },
        {
          query: "repeat query",
          timestamp: "2026-05-23T14:05:00.000Z",
          note: "second run"
        },
        {
          query: "new query",
          timestamp: "2026-05-23T14:10:00.000Z",
          note: "third run"
        }
      ],
      discoveredDomains: []
    });

    const cache = store.readTestLabExaCache();

    assert.deepEqual(cache.queryHistory, ["repeat query", "repeat query", "new query"]);
    assert.deepEqual(cache.queryInsights.map((entry) => entry.note), ["first run", "second run", "third run"]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});