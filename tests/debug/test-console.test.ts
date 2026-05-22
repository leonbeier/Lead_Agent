import test from "node:test";
import assert from "node:assert/strict";
import { buildDebugSearchFilter, normalizeManualWebsites, normalizeWebsiteUrl } from "../../src/debug/test-console";
import { DebugConsoleService } from "../../src/debug/test-console-service";
import { ControlPlaneStore } from "../../src/control-plane";

test("buildDebugSearchFilter keeps a category-compatible base filter and overrides the region", () => {
  const filter = buildDebugSearchFilter("integrator_general_ai", "Germany");

  assert.ok(filter.targetCategories?.includes("integrator_general_ai"));
  assert.deepEqual(filter.locations, ["Germany"]);
  assert.match(filter.name, /\[debug Germany\]$/);
});

test("buildDebugSearchFilter falls back to the first category filter when the region is not present", () => {
  const filter = buildDebugSearchFilter("software_platform_embedding", "Finland");

  assert.ok(filter.targetCategories?.includes("software_platform_embedding"));
  assert.deepEqual(filter.locations, ["Finland"]);
});

test("buildDebugSearchFilter normalizes DE to Germany before overriding the region", () => {
  const filter = buildDebugSearchFilter("integrator_vision_industrial_ai", "DE");

  assert.deepEqual(filter.locations, ["Germany"]);
  assert.match(filter.name, /\[debug Germany\]$/);
});

test("normalizeWebsiteUrl canonicalizes protocol, strips query/hash, and rejects invalid values", () => {
  assert.equal(normalizeWebsiteUrl("example.com/path/?a=1#frag"), "https://example.com/path");
  assert.equal(normalizeWebsiteUrl("https://www.example.com/"), "https://www.example.com");
  assert.equal(normalizeWebsiteUrl("nota url"), undefined);
});

test("normalizeManualWebsites deduplicates and drops invalid values", () => {
  const normalized = normalizeManualWebsites([
    "example.com",
    "https://example.com/",
    "https://example.com?foo=bar",
    "",
    "nota url",
    "https://second.example.org/team"
  ]);

  assert.deepEqual(normalized, [
    "https://example.com",
    "https://second.example.org/team"
  ]);
});

test("runExaCompanySearch executes the requested number of queries even when the first query fills the company limit", async () => {
  const service = new DebugConsoleService() as any;
  const executedQueries: string[] = [];

  service.exaSearchClient = {
    runtimeApiKey: "test-api-key",
    buildQueries: () => ["query one", "query two", "query three", "query four"],
    runSearch: async (_apiKey: string, query: string) => {
      executedQueries.push(query);
      return {
        results: Array.from({ length: 20 }, (_, index) => ({
          title: `${query} result ${index + 1}`,
          url: `https://${query.replace(/\s+/g, "-")}-${index + 1}.example.com`,
          summary: `Summary for ${query} result ${index + 1}`
        }))
      };
    },
    buildSearchPayload: (query: string) => ({ query }),
    loadKnownExcludedDomains: async () => new Set<string>(),
    toExcludeDomain: (value?: string) => {
      if (!value) {
        return undefined;
      }

      return new URL(value).hostname.replace(/^www\./i, "");
    },
    normalizeUrl: (url?: string) => url,
    toCanonicalCompanyDomain: (url: string) => url,
    deriveCompanyName: (domain: string) => domain,
    inferCountryFromDomain: () => "Germany",
    buildDescription: () => "Mock description"
  };

  service.controlPlaneStore = {
    getTestLabExaCache: async () => ({ queryHistory: [], discoveredDomains: [] }),
    getCompanyScreeningDatabase: async () => ({ records: [] }),
    writeTestLabExaCache: async () => undefined
  };

  const result = await service.runExaCompanySearch(
    {
      stage: "company_search",
      targetCategory: "integrator_vision_industrial_ai",
      targetCategories: ["integrator_vision_industrial_ai"],
      companySearchMode: "exa_search",
      exaQueryCount: 3,
      limit: 20
    },
    [buildDebugSearchFilter("integrator_vision_industrial_ai", "Germany")],
    20
  );

  assert.equal(executedQueries.length, 3);
  assert.equal(result.generatedSearches.length, 3);
  assert.equal(result.discoveredCompanies.length, 60);
});

test("runAiPrefilterStage honors high requested concurrency in test lab", async () => {
  const service = new DebugConsoleService() as any;
  let capturedConcurrency = 0;

  service.buildWebsiteCompanies = () => ([
    { name: "one", domain: "https://one.example", shortDescription: "desc", sourceFilter: "debug" },
    { name: "two", domain: "https://two.example", shortDescription: "desc", sourceFilter: "debug" },
    { name: "three", domain: "https://three.example", shortDescription: "desc", sourceFilter: "debug" }
  ]);
  service.classifyWebsite = async (company: { name: string }) => ({ company, categorizedCompany: { category: "other" } });
  service.persistScreeningResults = async () => undefined;
  service.mapWithConcurrency = async (tasks: Array<() => Promise<unknown>>, concurrency: number) => {
    capturedConcurrency = concurrency;
    return Promise.all(tasks.map((task) => task()));
  };

  await service.runAiPrefilterStage(
    {
      stage: "ai_prefilter",
      targetCategory: "machine_builder_ai_enablement",
      targetCategories: ["machine_builder_ai_enablement"],
      companySearchMode: "exa_search",
      limit: 20,
      aiPrefilterConcurrency: 20
    },
    buildDebugSearchFilter("machine_builder_ai_enablement", "Germany")
  );

  assert.equal(capturedConcurrency, 20);
});

test("clearCompanyScreeningCache removes only debug exclusions for debug scope", async () => {
  const store = new ControlPlaneStore() as any;
  let writtenDatabase: { records: Array<{ domain: string }> } | undefined;

  store.getCompanyScreeningDatabase = async () => ({
    records: [
      { domain: "debug.example", sourceFilter: "manual-debug-input", category: "other" },
      { domain: "live.example", sourceFilter: "Germany vision integrators", category: "other" },
      { domain: "hubspot.example", sourceFilter: "manual-debug-input", category: "other", existsInHubSpot: true }
    ]
  });
  store.writeCompanyScreeningDatabase = async (database: { records: Array<{ domain: string }> }) => {
    writtenDatabase = database;
  };

  const result = await store.clearCompanyScreeningCache("debug");

  assert.deepEqual(result.records.map((record: { domain: string }) => record.domain), ["live.example", "hubspot.example"]);
  assert.deepEqual(writtenDatabase?.records.map((record) => record.domain), ["live.example", "hubspot.example"]);
});

test("clearCompanyScreeningCache removes only live exclusions for live scope", async () => {
  const store = new ControlPlaneStore() as any;
  let writtenDatabase: { records: Array<{ domain: string }> } | undefined;

  store.getCompanyScreeningDatabase = async () => ({
    records: [
      { domain: "debug.example", sourceFilter: "[debug Germany]", category: "other" },
      { domain: "live.example", sourceFilter: "Germany vision integrators", category: "other" },
      { domain: "hubspot.example", sourceFilter: "Germany vision integrators", category: "other", existsInHubSpot: true }
    ]
  });
  store.writeCompanyScreeningDatabase = async (database: { records: Array<{ domain: string }> }) => {
    writtenDatabase = database;
  };

  const result = await store.clearCompanyScreeningCache("live");

  assert.deepEqual(result.records.map((record: { domain: string }) => record.domain), ["debug.example", "hubspot.example"]);
  assert.deepEqual(writtenDatabase?.records.map((record) => record.domain), ["debug.example", "hubspot.example"]);
});