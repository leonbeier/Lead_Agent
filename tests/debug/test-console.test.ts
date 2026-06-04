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

test("buildDebugSearchFilter prefers the narrowest Germany-scoped filter over Europe-wide matches", () => {
  const filter = buildDebugSearchFilter("integrator_relevant_focus", "DE");

  assert.equal(filter.name, "Germany Embedded Vision Engineering Firms [debug Germany]");
  assert.deepEqual(filter.locations, ["Germany"]);
  assert.match(filter.persona, /^German /);
  assert.match(filter.notes, /^German /);
});

test("buildDebugSearchFilter prefers Germany-only vision filters when multiple exact region matches exist", () => {
  const filter = buildDebugSearchFilter("integrator_vision_industrial_ai", "DE");

  assert.deepEqual(filter.locations, ["Germany"]);
  assert.match(filter.name, /^Germany /);
  assert.doesNotMatch(filter.name, /^Europe /);
  assert.match(filter.persona, /^German /);
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

test("runExaCompanySearch rejects domains that are already excluded even when Exa returns them", async () => {
  const service = new DebugConsoleService() as any;

  service.exaSearchClient = {
    runtimeApiKey: "test-api-key",
    buildQueries: () => ["query one"],
    runSearch: async () => ({
      results: [
        {
          title: "Excluded company",
          url: "https://already-known.example.com",
          summary: "Already in HubSpot"
        },
        {
          title: "New company",
          url: "https://new-company.example.com",
          summary: "Fresh result"
        }
      ]
    }),
    buildSearchPayload: (query: string) => ({ query }),
    loadKnownExcludedDomains: async () => new Set<string>(["already-known.example.com"]),
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
      exaQueryCount: 1,
      limit: 20
    },
    [buildDebugSearchFilter("integrator_vision_industrial_ai", "Germany")],
    20
  );

  assert.equal(result.discoveredCompanies.length, 1);
  assert.equal(result.discoveredCompanies[0]?.domain, "https://new-company.example.com");
  assert.equal(result.generatedSearches[0]?.rejectedResults[0]?.reason, "excluded_domain");
});

test("runExaCompanySearch can route queries through the Azure planner when enabled", async () => {
  const service = new DebugConsoleService() as any;
  const executedQueries: string[] = [];
  const plannerCalls: Array<{
    defaultQueries: string[];
    mainContext?: string;
    searchStrategyContext?: string;
    maxQueryCount: number;
    recentQueryHistory?: string[];
  }> = [];

  service.exaSearchClient = {
    runtimeApiKey: "test-api-key",
    buildQueries: () => ["default one", "default two", "default three"],
    runSearch: async (_apiKey: string, query: string) => {
      executedQueries.push(query);
      return { results: [] };
    },
    buildSearchPayload: (query: string) => ({ query }),
    loadKnownExcludedDomains: async () => new Set<string>(),
    toExcludeDomain: (value?: string) => {
      if (!value) {
        return undefined;
      }

      return new URL(value.includes("://") ? value : `https://${value}`).hostname.replace(/^www\./i, "");
    },
    normalizeUrl: (url?: string) => url,
    toCanonicalCompanyDomain: (url: string) => url,
    deriveCompanyName: (domain: string) => domain,
    inferCountryFromDomain: () => "Germany",
    buildDescription: () => "Mock description"
  };

  service.azureOpenAIClient = {
    planExaSearchQueries: async (
      _filter: unknown,
      defaultQueries: string[],
      _learning: unknown,
      _dryRun: boolean,
      mainContext?: string,
      searchStrategyContext?: string,
      maxQueryCount = 3,
      options?: {
        recentQueryHistory?: Array<{ query: string }>;
        debugCapture?: (details: { promptMessages: Array<{ role: string; content: string }> }) => void;
      }
    ) => {
      options?.debugCapture?.({
        promptMessages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "user prompt" }
        ]
      });
      plannerCalls.push({
        defaultQueries: [...defaultQueries],
        mainContext,
        searchStrategyContext,
        maxQueryCount,
        recentQueryHistory: [...(options?.recentQueryHistory ?? [])]
      });
      return ["planned query"];
    }
  };

  service.controlPlaneStore = {
    getSettings: async () => ({
      mainContext: "Main context",
      searchStrategyContext: "Search strategy"
    }),
    getLearning: async () => ({
      companyFeedback: [],
      filterPerformance: {},
      searchHistory: [],
      searchHistoryByMode: {}
    }),
    getTestLabExaCache: async () => ({ queryHistory: ["previous planned query"], discoveredDomains: [] }),
    getCompanyScreeningDatabase: async () => ({ records: [] }),
    writeTestLabExaCache: async () => undefined
  };

  const result = await service.runExaCompanySearch(
    {
      stage: "company_search",
      targetCategory: "integrator_vision_industrial_ai",
      targetCategories: ["integrator_vision_industrial_ai"],
      companySearchMode: "exa_search",
      exaQueryCount: 1,
      limit: 20,
      useAzureQueryPlanner: true
    },
    [buildDebugSearchFilter("integrator_vision_industrial_ai", "Germany")],
    20
  );

  assert.deepEqual(executedQueries, ["planned query"]);
  assert.deepEqual(plannerCalls, [{
    defaultQueries: ["default one", "default two", "default three"],
    mainContext: "Main context",
    searchStrategyContext: "Search strategy",
    maxQueryCount: 3,
    recentQueryHistory: [{ query: "previous planned query" }]
  }]);
  assert.deepEqual(result.generatedSearches[0]?.queryGeneration, {
    source: "azure_planner",
    defaultQueries: ["default one", "default two", "default three"],
    plannedQueries: ["planned query"],
    promptMessages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "user prompt" }
    ]
  });
});

test("runExaCompanySearch passes live Exa query stats into planner history", async () => {
  const service = new DebugConsoleService() as any;
  const plannerCalls: Array<{ recentQueryHistory?: Array<{ query: string; note?: string }> }> = [];

  service.exaSearchClient = {
    runtimeApiKey: "test-api-key",
    buildQueries: () => ["default one"],
    runSearch: async () => ({ results: [] }),
    buildSearchPayload: (query: string) => ({ query }),
    loadKnownExcludedDomains: async () => new Set<string>(),
    toExcludeDomain: (value?: string) => {
      if (!value) {
        return undefined;
      }

      return new URL(value.includes("://") ? value : `https://${value}`).hostname.replace(/^www\./i, "");
    },
    normalizeUrl: (url?: string) => url,
    toCanonicalCompanyDomain: (url: string) => url,
    deriveCompanyName: (domain: string) => domain,
    inferCountryFromDomain: () => "Germany",
    buildDescription: () => "Mock description"
  };

  service.azureOpenAIClient = {
    planExaSearchQueries: async (
      _filter: unknown,
      _defaultQueries: string[],
      _learning: unknown,
      _dryRun: boolean,
      _mainContext?: string,
      _searchStrategyContext?: string,
      _maxQueryCount = 3,
      options?: {
        recentQueryHistory?: Array<{ query: string; note?: string }>;
      }
    ) => {
      plannerCalls.push({
        recentQueryHistory: [...(options?.recentQueryHistory ?? [])]
      });
      return ["planned query"];
    }
  };

  service.controlPlaneStore = {
    getSettings: async () => ({
      mainContext: "Main context",
      searchStrategyContext: "Search strategy"
    }),
    getLearning: async () => ({
      companyFeedback: [],
      filterPerformance: {},
      searchHistory: [],
      searchHistoryByMode: {
        exa_search: {
          filterPerformance: {},
          searchHistory: [
            {
              timestamp: "2026-05-23T14:05:00.000Z",
              companySearchMode: "exa_search",
              filterName: "Live filter",
              batchType: "probe_15",
              page: 1,
              requestedCount: 20,
              returnedCount: 20,
              relevantCount: 2,
              relevanceRatio: 0.1,
              categoryBreakdown: {
                integrator_vision_industrial_ai: 1,
                integrator_general_ai: 0,
                integrator_relevant_focus: 0,
                industrial_end_customer_scaled: 0,
                machine_builder_ai_enablement: 0,
                software_platform_embedding: 0,
                integrator_vision_ai_consulting: 0,
                integrator_vision_ai_freelancer: 0,
                camera_manufacturer_partner: 0,
                irrelevant: 0,
                other: 1
              },
              passedThreshold: false,
              recommendation: "retry",
              queryStats: [
                {
                  query: "live industrial vision query",
                  rawFound: 11,
                  duplicates: 4,
                  accepted: 1,
                  rejectedDifferentCategory: 5,
                  rejectedOther: 1,
                  categoryBreakdown: {
                    integrator_vision_industrial_ai: 1,
                    integrator_general_ai: 0,
                    integrator_relevant_focus: 0,
                    industrial_end_customer_scaled: 0,
                    machine_builder_ai_enablement: 0,
                    software_platform_embedding: 0,
                    integrator_vision_ai_consulting: 0,
                    integrator_vision_ai_freelancer: 0,
                    camera_manufacturer_partner: 0,
                    irrelevant: 0,
                    other: 1
                  }
                }
              ]
            }
          ]
        }
      }
    }),
    getTestLabExaCache: async () => ({
      queryHistory: ["older test-lab query"],
      queryInsights: [
        {
          query: "older test-lab query",
          timestamp: "2026-05-23T14:00:00.000Z",
          note: "older debug run"
        }
      ],
      discoveredDomains: []
    }),
    getCompanyScreeningDatabase: async () => ({ records: [] }),
    writeTestLabExaCache: async () => undefined
  };

  await service.runExaCompanySearch(
    {
      stage: "company_search",
      targetCategory: "integrator_vision_industrial_ai",
      targetCategories: ["integrator_vision_industrial_ai"],
      companySearchMode: "exa_search",
      exaQueryCount: 1,
      limit: 20,
      useAzureQueryPlanner: true
    },
    [buildDebugSearchFilter("integrator_vision_industrial_ai", "Germany")],
    20
  );

  assert.equal(plannerCalls.length, 1);
  assert.deepEqual(plannerCalls[0]?.recentQueryHistory?.map((entry) => entry.query), [
    "live industrial vision query",
    "older test-lab query"
  ]);
  assert.match(plannerCalls[0]?.recentQueryHistory?.[0]?.note ?? "", /Live filter \| accepted 1, wrong-category 5, other 1, duplicates 4/);
});

test("runExaCompanySearch avoids repeating the exact previous query when Azure returns it again", async () => {
  const service = new DebugConsoleService() as any;
  const executedQueries: string[] = [];

  service.exaSearchClient = {
    runtimeApiKey: "test-api-key",
    buildQueries: () => ["repeat query", "fresh default two", "fresh default three"],
    runSearch: async (_apiKey: string, query: string) => {
      executedQueries.push(query);
      return { results: [] };
    },
    buildSearchPayload: (query: string) => ({ query }),
    loadKnownExcludedDomains: async () => new Set<string>(),
    toExcludeDomain: (value?: string) => {
      if (!value) {
        return undefined;
      }

      return new URL(value.includes("://") ? value : `https://${value}`).hostname.replace(/^www\./i, "");
    },
    normalizeUrl: (url?: string) => url,
    toCanonicalCompanyDomain: (url: string) => url,
    deriveCompanyName: (domain: string) => domain,
    inferCountryFromDomain: () => "Germany",
    buildDescription: () => "Mock description"
  };

  service.azureOpenAIClient = {
    planExaSearchQueries: async () => ["repeat query"]
  };

  service.controlPlaneStore = {
    getSettings: async () => ({
      mainContext: "Main context",
      searchStrategyContext: "Search strategy"
    }),
    getLearning: async () => ({
      companyFeedback: [],
      filterPerformance: {},
      searchHistory: [],
      searchHistoryByMode: {}
    }),
    getTestLabExaCache: async () => ({ queryHistory: ["repeat query"], discoveredDomains: [] }),
    getCompanyScreeningDatabase: async () => ({ records: [] }),
    writeTestLabExaCache: async () => undefined
  };

  await service.runExaCompanySearch(
    {
      stage: "company_search",
      targetCategory: "integrator_vision_industrial_ai",
      targetCategories: ["integrator_vision_industrial_ai"],
      companySearchMode: "exa_search",
      exaQueryCount: 1,
      limit: 20,
      useAzureQueryPlanner: true
    },
    [buildDebugSearchFilter("integrator_vision_industrial_ai", "Germany")],
    20
  );

  assert.deepEqual(executedQueries, ["fresh default two"]);
});

test("runExaCompanySearch passes the Test Lab target-category refinement into the Azure planner", async () => {
  const service = new DebugConsoleService() as any;
  const plannerCalls: Array<{ targetCategoryRefinement?: string }> = [];

  service.exaSearchClient = {
    runtimeApiKey: "test-api-key",
    buildQueries: () => ["default query"],
    runSearch: async () => ({ results: [] }),
    buildSearchPayload: (query: string) => ({ query }),
    loadKnownExcludedDomains: async () => new Set<string>(),
    toExcludeDomain: (value?: string) => value,
    normalizeUrl: (url?: string) => url,
    toCanonicalCompanyDomain: (url: string) => url,
    deriveCompanyName: (domain: string) => domain,
    inferCountryFromDomain: () => "Germany",
    buildDescription: () => "Mock description"
  };

  service.azureOpenAIClient = {
    planExaSearchQueries: async (
      _filter: unknown,
      _defaultQueries: string[],
      _learning: unknown,
      _dryRun: boolean,
      _mainContext: string | undefined,
      _searchStrategyContext: string | undefined,
      _maxQueryCount: number,
      options: { targetCategoryRefinement?: string }
    ) => {
      plannerCalls.push({ targetCategoryRefinement: options.targetCategoryRefinement });
      return ["default query"];
    }
  };

  service.controlPlaneStore = {
    getSettings: async () => ({
      targetCategoryRefinement: "saved refinement"
    }),
    getLearning: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
    getTestLabExaCache: async () => ({ queryHistory: [], discoveredDomains: [] }),
    getCompanyScreeningDatabase: async () => ({ records: [] }),
    writeTestLabExaCache: async () => undefined
  };

  await service.runExaCompanySearch(
    {
      stage: "company_search",
      targetCategory: "integrator_vision_industrial_ai",
      targetCategories: ["integrator_vision_industrial_ai"],
      targetCategoryRefinement: "only food production plants",
      companySearchMode: "exa_search",
      exaQueryCount: 1,
      limit: 20,
      useAzureQueryPlanner: true
    },
    [buildDebugSearchFilter("integrator_vision_industrial_ai", "Germany")],
    20
  );

  assert.equal(plannerCalls.length, 1);
  assert.equal(plannerCalls[0]?.targetCategoryRefinement, "only food production plants");
});

test("runExaCompanySearch excludes only hubspot and debug rejected websites before adding current-request domains", async () => {
  const service = new DebugConsoleService() as any;
  const hubSpotDomains = Array.from({ length: 1300 }, (_, index) => `hubspot-${index}.example${index}.com`);
  hubSpotDomains.push("relevant-hubspot.test", "duplicate.test");
  const capturedExcludeDomains: string[][] = [];

  service.exaSearchClient = {
    runtimeApiKey: "test-api-key",
    buildQueries: () => ["query one"],
    runSearch: async (_apiKey: string, _query: string, _numResults: number, excludeDomains?: string[]) => {
      capturedExcludeDomains.push([...(excludeDomains ?? [])]);
      return { results: [] };
    },
    buildSearchPayload: (_query: string, _numResults: number, excludeDomains?: string[]) => ({ excludeDomains }),
    loadKnownExcludedDomains: async () => new Set<string>(hubSpotDomains),
    toExcludeDomain: (value?: string) => {
      if (!value) {
        return undefined;
      }

      return new URL(value.includes("://") ? value : `https://${value}`).hostname.replace(/^www\./i, "");
    },
    normalizeUrl: (url?: string) => url,
    toCanonicalCompanyDomain: (url: string) => url,
    deriveCompanyName: (domain: string) => domain,
    inferCountryFromDomain: () => "Germany",
    buildDescription: () => "Mock description"
  };

  service.controlPlaneStore = {
    getTestLabExaCache: async () => ({
      queryHistory: [],
      discoveredDomains: [
        "hubspot-0.example0.com",
        "same-run-1.test",
        "hubspot-0.example0.com",
        "same-run-2.test",
        "prior-run-exa.test"
      ]
    }),
    getCompanyScreeningDatabase: async () => ({
      records: [
        {
          companyName: "Debug Rejected",
          normalizedName: "debug rejected",
          normalizedDomain: "debug-rejected.test",
          existsInHubSpot: false,
          category: "other",
          sourceFilter: "manual-debug-input"
        },
        {
          companyName: "Live Rejected",
          normalizedName: "live rejected",
          normalizedDomain: "live-rejected.test",
          existsInHubSpot: false,
          category: "other",
          sourceFilter: "Germany vision integrators"
        },
        {
          companyName: "Matching Target",
          normalizedName: "matching target",
          normalizedDomain: "matching-target.test",
          existsInHubSpot: false,
          category: "integrator_vision_industrial_ai",
          sourceFilter: "manual-debug-input"
        }
      ]
    }),
    writeTestLabExaCache: async () => undefined
  };

  await service.runExaCompanySearch(
    {
      stage: "company_search",
      targetCategory: "integrator_vision_industrial_ai",
      targetCategories: ["integrator_vision_industrial_ai"],
      companySearchMode: "exa_search",
      exaQueryCount: 1,
      limit: 20
    },
    [buildDebugSearchFilter("integrator_vision_industrial_ai", "Germany")],
    20
  );

  const requestPayloadDomains = capturedExcludeDomains[0] ?? [];
  assert.equal(requestPayloadDomains.length, 1200);
  assert.equal(requestPayloadDomains.includes("same-run-1.test"), false);
  assert.equal(requestPayloadDomains.includes("same-run-2.test"), false);
  assert.equal(requestPayloadDomains.includes("prior-run-exa.test"), false);
  assert.equal(requestPayloadDomains.includes("hubspot-0.example0.com"), true);
  assert.equal(requestPayloadDomains.includes("relevant-hubspot.test"), true);
  assert.equal(requestPayloadDomains.includes("debug-rejected.test"), true);
  assert.equal(requestPayloadDomains.includes("live-rejected.test"), false);
  assert.equal(requestPayloadDomains.includes("matching-target.test"), false);
  assert.equal(requestPayloadDomains.includes("duplicate.test"), true);
  assert.equal(requestPayloadDomains.filter((domain) => domain === "duplicate.test").length, 1);
  assert.equal(requestPayloadDomains.includes("hubspot-1.example1.com"), false);
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

test("classifyCompanyForExecution preserves the source filter for live execution", async () => {
  const service = new DebugConsoleService() as any;

  service.webSearchAgent = {
    crawlCompanyWebsite: async () => ({
      summary: "Industrial image processing projects"
    })
  };

  service.debugCategorizeWebsite = async () => ({
    rawInput: "Industrial image processing projects",
    promptMessages: [],
    compactRetryUsed: false,
    category: "integrator_vision_industrial_ai",
    relevanceScore: 92,
    rationale: "Strong fit"
  });

  const result = await service.classifyCompanyForExecution(
    {
      name: "Live Vision GmbH",
      domain: "https://live-vision.example.com",
      shortDescription: "Industrial image processing projects",
      sourceFilter: "Europe Vision System Integrators (exa-search: site:.de ...)"
    },
    {
      annotateDebugStage: false
    }
  );

  assert.equal(result.categorizedCompany.sourceFilter, "Europe Vision System Integrators (exa-search: site:.de ...)");
});

test("buildContactAnalysis runs research and contact debug together and keeps preview contacts", async () => {
  const service = new DebugConsoleService() as any;
  const company = {
    name: "Senswork",
    domain: "https://senswork.com/en",
    country: "Germany",
    shortDescription: "Manual debug website input.",
    sourceFilter: "debug"
  };
  const categorizedCompany = {
    ...company,
    category: "integrator_vision_industrial_ai",
    relevanceScore: 90,
    rationale: "Strong fit"
  };

  service.classifyWebsite = async () => ({
    company,
    websiteParser: null,
    azureEvaluation: {
      rawInput: "",
      promptMessages: [],
      compactRetryUsed: false,
      category: "integrator_vision_industrial_ai",
      relevanceScore: 90,
      rationale: "Strong fit"
    },
    categorizedCompany
  });
  service.azureOpenAIClient.buildResearchBrief = async () => ({
    companyName: categorizedCompany.name,
    overview: "Overview",
    qualificationSummary: "Strong fit.",
    qualifyingSignals: [],
    riskFlags: [],
    likelyGermanSpeaking: true,
    outreachLanguage: "de",
    rankings: { customer: 1, serviceProvider: 2, partner: 3 },
    businessPotentialEUR: 10000,
    businessPotentialReasoning: "fit",
    targetIndustry: "Automation",
    productsOffered: "Vision systems",
    recommendedTemplateKey: "integrator_vision_industrial_ai",
    personalizationRule: "Mention fit",
    linkedInAngle: "Angle",
    emailAngle: "Angle",
    phoneAngle: "Angle",
    linkedInMessage: "Message",
    emailSubject: "Subject",
    emailBody: "Body",
    phoneScript: "Phone"
  });
  service.hubspotClient.resolveCompanyAddress = async () => ({
    city: "Burghausen"
  });
  service.hubspotClient.debugPublicContactDiscovery = async (_company: unknown, options: { selectedContactsTimeoutMs?: number }) => {
    assert.equal(options.selectedContactsTimeoutMs, 90_000);
    return {
      aliases: ["Senswork"],
      queries: [],
      websitePages: [],
      hitGroups: [],
      heuristicContacts: [],
      selectedContacts: [{
        email: "info@senswork.com",
        phone: "+49 123",
        sourceUrl: "https://senswork.com/kontakt/",
        label: "public_generic_mailbox",
        jobTitle: "General contact"
      }]
    };
  };
  service.hubspotClient.previewHubSpotSync = async (
    _company: unknown,
    _brief: unknown,
    contacts: Array<{ email?: string }>,
    options: { extractedAddress?: { city?: string } | null }
  ) => {
    assert.equal(options.extractedAddress?.city, "Burghausen");
    return {
    companyProperties: {},
    contacts: contacts.map((contact) => ({ skipped: false, normalizedContact: contact, properties: { email: contact.email } }))
    };
  };

  const result = await service.buildContactAnalysis(company);

  assert.equal(result.error, undefined);
  assert.ok(result.researchBrief);
  assert.equal(result.publicContactDebug?.selectedContacts.length, 1);
  assert.equal(result.hubspotPreview?.contacts.length, 1);
});

test("buildOutreachAnalysis preloads address lookup for preview", async () => {
  const service = new DebugConsoleService() as any;
  const company = {
    name: "Senswork",
    domain: "https://senswork.com/en",
    country: "Germany",
    shortDescription: "Manual debug website input.",
    sourceFilter: "debug"
  };
  const categorizedCompany = {
    ...company,
    category: "integrator_vision_industrial_ai",
    relevanceScore: 90,
    rationale: "Strong fit"
  };

  service.classifyWebsite = async () => ({
    company,
    websiteParser: null,
    azureEvaluation: {
      rawInput: "",
      promptMessages: [],
      compactRetryUsed: false,
      category: "integrator_vision_industrial_ai",
      relevanceScore: 90,
      rationale: "Strong fit"
    },
    categorizedCompany
  });
  service.azureOpenAIClient.buildResearchBrief = async () => ({
    companyName: categorizedCompany.name,
    overview: "Overview",
    qualificationSummary: "Strong fit.",
    qualifyingSignals: [],
    riskFlags: [],
    likelyGermanSpeaking: true,
    outreachLanguage: "de",
    rankings: { customer: 1, serviceProvider: 2, partner: 3 },
    businessPotentialEUR: 10000,
    businessPotentialReasoning: "fit",
    targetIndustry: "Automation",
    productsOffered: "Vision systems",
    recommendedTemplateKey: "integrator_vision_industrial_ai",
    personalizationRule: "Mention fit",
    linkedInAngle: "Angle",
    emailAngle: "Angle",
    phoneAngle: "Angle",
    linkedInMessage: "Message",
    emailSubject: "Subject",
    emailBody: "Body",
    phoneScript: "Phone"
  });
  service.hubspotClient.resolveCompanyAddress = async () => ({
    city: "Burghausen"
  });
  service.hubspotClient.previewHubSpotSync = async (
    _company: unknown,
    _brief: unknown,
    _contacts: unknown[],
    options: { extractedAddress?: { city?: string } | null }
  ) => {
    assert.equal(options.extractedAddress?.city, "Burghausen");
    return {
      companyProperties: {},
      contacts: []
    };
  };

  const result = await service.buildOutreachAnalysis(company);

  assert.equal(result.error, undefined);
  assert.ok(result.researchBrief);
  assert.equal(result.hubspotPreview?.contacts.length, 0);
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