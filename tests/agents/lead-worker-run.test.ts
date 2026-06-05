import test from "node:test";
import assert from "node:assert/strict";
import { AsyncQueue, LeadWorkerRunService } from "../../src/agents/lead-worker-run";
import type { OrganizationFilter, CompanyScreeningDatabase, LeadCategory, PublicContactCandidate, ResearchBrief } from "../../src/types";

function createFilter(category: LeadCategory): OrganizationFilter {
  return {
    name: `filter-${category}`,
    persona: "persona",
    industries: ["automation"],
    keywords: ["vision"],
    locations: ["Germany"],
    employeeRanges: ["11-50"],
    targetCategories: [category],
    notes: "test"
  };
}

function createResearchBrief(companyName: string): ResearchBrief {
  return {
    companyName,
    overview: `${companyName} overview`,
    qualificationSummary: `${companyName} is a fit`,
    qualifyingSignals: [],
    riskFlags: [],
    likelyGermanSpeaking: true,
    outreachLanguage: "de",
    rankings: { customer: 1, serviceProvider: 2, partner: 3 },
    businessPotentialEUR: 1000,
    businessPotentialReasoning: "fit",
    targetIndustry: "Automation",
    productsOffered: "Vision",
    recommendedTemplateKey: "integrator_vision_industrial_ai",
    personalizationRule: "Mention fit",
    linkedInAngle: "Angle",
    emailAngle: "Email angle",
    phoneAngle: "Phone angle",
    linkedInMessage: "LinkedIn",
    emailSubject: "Subject",
    emailBody: "Body",
    phoneScript: "Phone"
  };
}

function createContacts(companyName: string): PublicContactCandidate[] {
  return [{
    email: `${companyName.toLowerCase()}@example.com`,
    sourceUrl: `https://${companyName.toLowerCase()}.example.com/contact`,
    label: "public_generic_mailbox"
  }];
}

test("worker run consumes matching live screening seeds before starting Exa", async () => {
  const screeningWrites: CompanyScreeningDatabase[] = [];
  const latestRunWrites: Array<{ summary?: { foundCandidates?: number } }> = [];
  let exaCalls = 0;

  const service = new LeadWorkerRunService({
    controlPlaneStore: {
      getLearning: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      getCompanyScreeningDatabase: async () => ({
        records: [{
          companyName: "Seed Vision",
          normalizedName: "seed vision",
          domain: "seed-vision.example.com",
          normalizedDomain: "seed-vision.example.com",
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.92,
          rationale: "Already screened live",
          sourceFilter: "live-filter"
        }]
      }),
      getLiveExaCache: async () => ({ entries: [], discoveredDomains: [] }),
      writeCompanyScreeningDatabase: async (database: CompanyScreeningDatabase) => {
        screeningWrites.push(database);
      },
      recordSearchHistory: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      recordLiveExaRawResults: async () => ({ entries: [], discoveredDomains: [] }),
      writeLatestLeadRun: async (record: { summary?: { foundCandidates?: number } }) => {
        latestRunWrites.push(record);
      }
    } as any,
    debugConsoleService: {
      createManualCompanyForWebsite: (website: string, filter: OrganizationFilter) => ({
        name: "Seed Vision",
        domain: website,
        shortDescription: "Seed company",
        sourceFilter: filter.name
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      syncQualifiedCompanies: async () => ({
        attempted: true,
        mode: "live",
        candidateCount: 1,
        syncedCount: 1,
        companySyncedCount: 1,
        contactSyncedCount: 1
      })
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [createFilter("integrator_vision_industrial_ai")],
      discoverDirectExaCompaniesForExecution: async () => {
        exaCalls += 1;
        return [];
      }
    } as any
  });

  const result = await service.run({
    targetLeadCount: 1,
    targetCategories: ["integrator_vision_industrial_ai"],
    companySearchMode: "exa_search",
    syncToHubSpot: true,
    dryRun: false,
    maxRuntimeMs: 200,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  });

  assert.equal(exaCalls, 0);
  assert.equal(result.hubspotSync.companySyncedCount, 1);
  assert.equal(result.shortlistedCompanies.length, 1);
  assert.equal(result.shortlistedCompanies[0]?.name, "Seed Vision");
  assert.equal(result.stopped, false);
  assert.ok(screeningWrites.length > 0);
  assert.ok(!screeningWrites.at(-1)?.records.some((record) => record.companyName === "Seed Vision"));
  assert.equal(latestRunWrites.at(-1)?.summary?.foundCandidates, 1);
});

test("worker run keeps live screening seeds when HubSpot sync does not succeed", async () => {
  const screeningWrites: CompanyScreeningDatabase[] = [];

  const service = new LeadWorkerRunService({
    controlPlaneStore: {
      getLearning: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      getCompanyScreeningDatabase: async () => ({
        records: [{
          companyName: "Seed Vision",
          normalizedName: "seed vision",
          domain: "seed-vision.example.com",
          normalizedDomain: "seed-vision.example.com",
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.92,
          rationale: "Already screened live",
          sourceFilter: "live-filter"
        }]
      }),
      getLiveExaCache: async () => ({ entries: [], discoveredDomains: [] }),
      writeCompanyScreeningDatabase: async (database: CompanyScreeningDatabase) => {
        screeningWrites.push(database);
      },
      recordSearchHistory: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      recordLiveExaRawResults: async () => ({ entries: [], discoveredDomains: [] }),
      writeLatestLeadRun: async () => undefined
    } as any,
    debugConsoleService: {
      createManualCompanyForWebsite: (website: string, filter: ApolloOrganizationFilter) => ({
        name: "Seed Vision",
        domain: website,
        shortDescription: "Seed company",
        sourceFilter: filter.name
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      syncQualifiedCompanies: async () => ({
        attempted: true,
        mode: "live",
        candidateCount: 1,
        syncedCount: 0,
        companySyncedCount: 0,
        contactSyncedCount: 0,
        errors: ["hubspot write failed"]
      })
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [createFilter("integrator_vision_industrial_ai")],
      discoverDirectExaCompaniesForExecution: async () => []
    } as any
  });

  const result = await service.run({
    targetLeadCount: 1,
    targetCategories: ["integrator_vision_industrial_ai"],
    companySearchMode: "exa_search",
    syncToHubSpot: true,
    dryRun: false,
    maxRuntimeMs: 200,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  });

  assert.equal(result.hubspotSync.companySyncedCount, 0);
  assert.equal(screeningWrites.length, 0);
});

test("worker run skips live screening seeds when reuseQualifiedCompanyCache is false", async () => {
  let exaCalls = 0;

  const service = new LeadWorkerRunService({
    controlPlaneStore: {
      getLearning: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      getCompanyScreeningDatabase: async () => ({
        records: [{
          companyName: "Seed Vision",
          normalizedName: "seed vision",
          domain: "seed-vision.example.com",
          normalizedDomain: "seed-vision.example.com",
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.92,
          rationale: "Already screened live",
          sourceFilter: "live-filter"
        }]
      }),
      getLiveExaCache: async () => ({ entries: [], discoveredDomains: [] }),
      writeCompanyScreeningDatabase: async () => undefined,
      recordSearchHistory: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      recordLiveExaRawResults: async () => ({ entries: [], discoveredDomains: [] }),
      writeLatestLeadRun: async () => undefined
    } as any,
    debugConsoleService: {
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.9,
          rationale: "fit"
        }
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      syncQualifiedCompanies: async () => ({
        attempted: true,
        mode: "live",
        candidateCount: 1,
        syncedCount: 1,
        companySyncedCount: 1,
        contactSyncedCount: 1
      })
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [createFilter("integrator_vision_industrial_ai")],
      discoverDirectExaCompaniesForExecution: async () => {
        exaCalls += 1;
        return [{
          name: "Fresh Vision",
          domain: "fresh-vision.example.com",
          shortDescription: "Fresh company",
          sourceFilter: "exa-filter"
        }];
      }
    } as any
  });

  const result = await service.run({
    targetLeadCount: 1,
    targetCategories: ["integrator_vision_industrial_ai"],
    companySearchMode: "exa_search",
    syncToHubSpot: true,
    dryRun: false,
    reuseQualifiedCompanyCache: false,
    exaQueryCount: 1,
    maxRuntimeMs: 60_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  });

  assert.ok(exaCalls >= 1);
  assert.equal(result.shortlistedCompanies[0]?.name, "Fresh Vision");
  assert.equal(result.hubspotSync.companySyncedCount, 1);
});

test("worker run rejects out-of-market AI matches before HubSpot sync", async () => {
  let exaCalls = 0;

  const service = new LeadWorkerRunService({
    controlPlaneStore: {
      getLearning: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      getCompanyScreeningDatabase: async () => ({ records: [] }),
      getLiveExaCache: async () => ({ entries: [], discoveredDomains: [] }),
      writeCompanyScreeningDatabase: async () => undefined,
      recordSearchHistory: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      recordLiveExaRawResults: async () => ({ entries: [], discoveredDomains: [] }),
      writeLatestLeadRun: async () => undefined
    } as any,
    debugConsoleService: {
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          country: "Mexico",
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.91,
          rationale: "fit"
        }
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      syncQualifiedCompanies: async () => {
        throw new Error("HubSpot sync should not run for out-of-market companies");
      }
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [createFilter("integrator_vision_industrial_ai")],
      isCompanyInExecutionScope: () => false,
      discoverDirectExaCompaniesForExecution: async () => {
        exaCalls += 1;
        if (exaCalls > 1) {
          throw new Error("Exa search failed: 503 unavailable");
        }
        return [{
          name: "Nesis Automation",
          domain: "nesisautomation.com",
          country: "Mexico",
          shortDescription: "Industrial automation integrator",
          sourceFilter: "exa-filter"
        }];
      }
    } as any
  });

  const result = await service.run({
    targetLeadCount: 1,
    targetCategories: ["integrator_vision_industrial_ai"],
    companySearchMode: "exa_search",
    market: "EU",
    syncToHubSpot: true,
    dryRun: false,
    reuseQualifiedCompanyCache: false,
    exaQueryCount: 1,
    maxRuntimeMs: 60_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  });

  assert.ok(exaCalls >= 1);
  assert.equal(result.shortlistedCompanies.length, 0);
  assert.equal(result.hubspotSync.companySyncedCount, 0);
});

test("worker run promotes standby AI matches when the active company fails downstream", async () => {
  const syncedCompanies: string[] = [];
  let exaCalls = 0;

  const service = new LeadWorkerRunService({
    controlPlaneStore: {
      getLearning: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      getCompanyScreeningDatabase: async () => ({ records: [] }),
      getLiveExaCache: async () => ({ entries: [], discoveredDomains: [] }),
      writeCompanyScreeningDatabase: async () => undefined,
      recordSearchHistory: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      recordLiveExaRawResults: async () => ({ entries: [], discoveredDomains: [] }),
      writeLatestLeadRun: async () => undefined
    } as any,
    debugConsoleService: {
      buildResearchBriefForExecution: async (company: { name: string }) => {
        if (company.name === "First Vision") {
          throw new Error("brief failed");
        }
        return createResearchBrief(company.name);
      },
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.9,
          rationale: "fit"
        }
      }),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      syncQualifiedCompanies: async (companies: Array<{ name: string }>) => {
        syncedCompanies.push(companies[0].name);
        return {
          attempted: true,
          mode: "live",
          candidateCount: 1,
          syncedCount: 1,
          companySyncedCount: 1,
          contactSyncedCount: 1
        };
      }
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [createFilter("integrator_vision_industrial_ai")],
      discoverDirectExaCompaniesForExecution: async () => {
        exaCalls += 1;
        return exaCalls > 1
          ? []
          : [
              {
                name: "First Vision",
                domain: "first-vision.example.com",
                shortDescription: "first",
                sourceFilter: "exa-filter"
              },
              {
                name: "Second Vision",
                domain: "second-vision.example.com",
                shortDescription: "second",
                sourceFilter: "exa-filter"
              }
            ];
      }
    } as any
  });

  const result = await service.run({
    targetLeadCount: 1,
    targetCategories: ["integrator_vision_industrial_ai"],
    companySearchMode: "exa_search",
    syncToHubSpot: true,
    dryRun: false,
    maxRuntimeMs: 60_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  });

  assert.deepEqual(syncedCompanies, ["Second Vision"]);
  assert.equal(result.hubspotSync.companySyncedCount, 1);
  assert.equal(result.shortlistedCompanies.at(-1)?.name, "Second Vision");
});

test("worker run does not promote standby companies after target is reached", async () => {
  const researchedCompanies: string[] = [];
  const syncedCompanies: string[] = [];
  const progressSnapshots: Array<{ foundCandidates?: number; funnel?: { afterHubSpotDedup?: number; syncedToHubSpot?: number } }> = [];
  let exaCalls = 0;

  const service = new LeadWorkerRunService({
    controlPlaneStore: {
      getLearning: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      getCompanyScreeningDatabase: async () => ({ records: [] }),
      getLiveExaCache: async () => ({ entries: [], discoveredDomains: [] }),
      writeCompanyScreeningDatabase: async () => undefined,
      recordSearchHistory: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      recordLiveExaRawResults: async () => ({ entries: [], discoveredDomains: [] }),
      writeLatestLeadRun: async () => undefined
    } as any,
    debugConsoleService: {
      buildResearchBriefForExecution: async (company: { name: string }) => {
        researchedCompanies.push(company.name);
        return createResearchBrief(company.name);
      },
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.9,
          rationale: "fit"
        }
      }),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      syncQualifiedCompanies: async (companies: Array<{ name: string }>) => {
        syncedCompanies.push(companies[0].name);
        return {
          attempted: true,
          mode: "live",
          candidateCount: 1,
          syncedCount: 1,
          companySyncedCount: 1,
          contactSyncedCount: 1
        };
      }
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [createFilter("integrator_vision_industrial_ai")],
      discoverDirectExaCompaniesForExecution: async () => {
        exaCalls += 1;
        return exaCalls > 1
          ? []
          : [
              {
                name: "First Vision",
                domain: "first-vision.example.com",
                shortDescription: "first",
                sourceFilter: "exa-filter"
              },
              {
                name: "Second Vision",
                domain: "second-vision.example.com",
                shortDescription: "second",
                sourceFilter: "exa-filter"
              }
            ];
      }
    } as any
  });

  const result = await service.run({
    targetLeadCount: 1,
    targetCategories: ["integrator_vision_industrial_ai"],
    companySearchMode: "exa_search",
    syncToHubSpot: true,
    dryRun: false,
    maxRuntimeMs: 60_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  }, {
    onProgress: (progress) => {
      progressSnapshots.push({
        foundCandidates: progress.foundCandidates,
        funnel: progress.funnel
          ? {
              afterHubSpotDedup: progress.funnel.afterHubSpotDedup,
              syncedToHubSpot: progress.funnel.syncedToHubSpot
            }
          : undefined
      });
    }
  });

  assert.deepEqual(syncedCompanies, ["First Vision"]);
  assert.deepEqual(researchedCompanies, ["First Vision"]);
  assert.equal(result.hubspotSync.companySyncedCount, 1);
  assert.equal(result.shortlistedCompanies.length, 1);
  assert.equal(result.shortlistedCompanies[0]?.name, "First Vision");
  assert.ok(progressSnapshots.some((snapshot) => snapshot.foundCandidates === 2));
  assert.ok(progressSnapshots.some((snapshot) => snapshot.funnel?.afterHubSpotDedup === 2 && snapshot.funnel?.syncedToHubSpot === 1));
});

test("worker run defaults to four Exa queries per batch when no explicit exaQueryCount is provided", async () => {
  const observedQueryCounts: number[] = [];

  const service = new LeadWorkerRunService({
    controlPlaneStore: {
      getLearning: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      getCompanyScreeningDatabase: async () => ({ records: [] }),
      getLiveExaCache: async () => ({ entries: [], discoveredDomains: [] }),
      writeCompanyScreeningDatabase: async () => undefined,
      recordSearchHistory: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      recordLiveExaRawResults: async () => ({ entries: [], discoveredDomains: [] }),
      recordLiveExaQueryRuns: async () => ({ entries: [], discoveredDomains: [], queryRuns: [] }),
      writeLatestLeadRun: async () => undefined
    } as any,
    debugConsoleService: {
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.9,
          rationale: "fit"
        }
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      syncQualifiedCompanies: async () => ({
        attempted: true,
        mode: "live",
        candidateCount: 1,
        syncedCount: 1,
        companySyncedCount: 1,
        contactSyncedCount: 1
      })
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [createFilter("integrator_vision_industrial_ai")],
      discoverDirectExaCompaniesForExecution: async (
        _filter: OrganizationFilter,
        _targetCategories: LeadCategory[],
        maxQueryCount: number
      ) => {
        observedQueryCounts.push(maxQueryCount);
        return [{
          name: "Query Count Vision",
          domain: "query-count-vision.example.com",
          shortDescription: "fast-path company",
          sourceFilter: "exa-filter"
        }];
      }
    } as any
  });

  await service.run({
    targetLeadCount: 1,
    targetCategories: ["integrator_vision_industrial_ai"],
    companySearchMode: "exa_search",
    syncToHubSpot: true,
    dryRun: false,
    maxRuntimeMs: 60_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  });

  assert.ok(observedQueryCounts.length > 0);
  assert.ok(observedQueryCounts.every((count) => count === 4));
});

test("worker run reuses planned Exa queries before requesting a fresh Azure plan", async () => {
  const forcedQueryBatches: string[][] = [];
  let freshPlanRequests = 0;

  const service = new LeadWorkerRunService({
    controlPlaneStore: {
      getLearning: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      getCompanyScreeningDatabase: async () => ({ records: [] }),
      getLiveExaCache: async () => ({ entries: [], discoveredDomains: [] }),
      writeCompanyScreeningDatabase: async () => undefined,
      recordSearchHistory: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      recordLiveExaRawResults: async () => ({ entries: [], discoveredDomains: [] }),
      recordLiveExaQueryRuns: async () => ({ entries: [], discoveredDomains: [], queryRuns: [] }),
      writeLatestLeadRun: async () => undefined
    } as any,
    debugConsoleService: {
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.9,
          rationale: "fit"
        }
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      syncQualifiedCompanies: async () => ({
        attempted: true,
        mode: "live",
        candidateCount: 1,
        syncedCount: 1,
        companySyncedCount: 1,
        contactSyncedCount: 1
      })
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [createFilter("integrator_vision_industrial_ai")],
      discoverDirectExaCompaniesForExecution: async (
        filter: OrganizationFilter,
        _targetCategories: LeadCategory[],
        _maxQueryCount: number,
        _excludeDomainSources: unknown,
        queryPlanningContext?: {
          forcedQueries?: string[];
          plannedQueryMetadata?: {
            plannedQueries?: string[];
          };
        },
        onQueryProgress?: (update: {
          executedQueries: number;
          totalQueries: number;
          query: string;
          returnedResults: number;
          filteredByExcludedDomains: number;
          duplicatesRemoved: number;
          rawCompaniesFound: number;
          filterName: string;
          defaultQueries: string[];
          plannedQueries: string[];
          promptMessages?: Array<{ role: string; content: string }>;
          excludedDomains: string[];
        }) => void
      ) => {
        const activeQuery = queryPlanningContext?.forcedQueries?.[0] ?? "query one";
        const plannedQueries = queryPlanningContext?.plannedQueryMetadata?.plannedQueries ?? ["query one", "query two", "query three"];

        if (queryPlanningContext?.forcedQueries?.length) {
          forcedQueryBatches.push([...queryPlanningContext.forcedQueries]);
        } else {
          freshPlanRequests += 1;
        }

        onQueryProgress?.({
          executedQueries: 0,
          totalQueries: 1,
          query: activeQuery,
          returnedResults: 0,
          filteredByExcludedDomains: 0,
          duplicatesRemoved: 0,
          rawCompaniesFound: 0,
          filterName: filter.name,
          defaultQueries: ["default one", "default two", "default three"],
          plannedQueries,
          promptMessages: [{ role: "system", content: "prompt" }],
          excludedDomains: []
        });

        onQueryProgress?.({
          executedQueries: 1,
          totalQueries: 1,
          query: activeQuery,
          returnedResults: 1,
          filteredByExcludedDomains: 0,
          duplicatesRemoved: 0,
          rawCompaniesFound: 1,
          filterName: filter.name,
          defaultQueries: ["default one", "default two", "default three"],
          plannedQueries,
          promptMessages: [{ role: "system", content: "prompt" }],
          excludedDomains: []
        });

        return [{
          name: activeQuery,
          domain: `${activeQuery.replace(/\s+/g, "-")}.example.com`,
          shortDescription: "planned query result",
          sourceFilter: filter.name,
          discoveryQuery: activeQuery
        }];
      }
    } as any
  });

  await service.run({
    targetLeadCount: 3,
    targetCategories: ["integrator_vision_industrial_ai"],
    companySearchMode: "exa_search",
    syncToHubSpot: true,
    dryRun: false,
    exaQueryCount: 1,
    maxRuntimeMs: 60_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  });

  assert.ok(freshPlanRequests >= 1 && freshPlanRequests <= 2);
  assert.deepEqual(forcedQueryBatches, [["query two"], ["query three"]]);
});

test("worker run drains accepted companies when Exa aborts with a raw timeout error", async () => {
  const syncedCompanies: string[] = [];
  let exaCalls = 0;

  const service = new LeadWorkerRunService({
    controlPlaneStore: {
      getLearning: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      getCompanyScreeningDatabase: async () => ({ records: [] }),
      getLiveExaCache: async () => ({ entries: [], discoveredDomains: [] }),
      writeCompanyScreeningDatabase: async () => undefined,
      recordSearchHistory: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      recordLiveExaRawResults: async () => ({ entries: [], discoveredDomains: [] }),
      recordLiveExaQueryRuns: async () => ({ entries: [], discoveredDomains: [], queryRuns: [] }),
      writeLatestLeadRun: async () => undefined
    } as any,
    debugConsoleService: {
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.9,
          rationale: "fit"
        }
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      syncQualifiedCompanies: async (companies: Array<{ name: string }>) => {
        syncedCompanies.push(companies[0]?.name ?? "unknown");
        return {
          attempted: true,
          mode: "live",
          candidateCount: 1,
          syncedCount: 1,
          companySyncedCount: 1,
          contactSyncedCount: 1
        };
      }
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [createFilter("integrator_vision_industrial_ai")],
      discoverDirectExaCompaniesForExecution: async () => {
        exaCalls += 1;
        if (exaCalls === 1) {
          return [{
            name: "Abort Timeout Vision",
            domain: "abort-timeout-vision.example.com",
            shortDescription: "fit",
            sourceFilter: "exa-filter",
            discoveryQuery: "vision query"
          }];
        }

        throw new Error("The operation was aborted due to timeout");
      }
    } as any
  });

  const result = await service.run({
    targetLeadCount: 2,
    targetCategories: ["integrator_vision_industrial_ai"],
    companySearchMode: "exa_search",
    syncToHubSpot: true,
    dryRun: false,
    exaQueryCount: 1,
    maxRuntimeMs: 60_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  });

  assert.deepEqual(syncedCompanies, ["Abort Timeout Vision"]);
  assert.equal(result.hubspotSync.companySyncedCount, 1);
  assert.equal(result.shortlistedCompanies.length, 1);
  assert.equal(result.shortlistedCompanies[0]?.name, "Abort Timeout Vision");
  assert.equal(result.completionReason, "exa_search_unavailable");
  assert.equal(result.timedOut, false);
  assert.equal(result.stopped, false);
});

test("worker run keeps streaming Exa raw companies into AI when the batch times out after progress updates", async () => {
  const syncedCompanies: string[] = [];

  const service = new LeadWorkerRunService({
    controlPlaneStore: {
      getLearning: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      getCompanyScreeningDatabase: async () => ({ records: [] }),
      getLiveExaCache: async () => ({ entries: [], discoveredDomains: [] }),
      writeCompanyScreeningDatabase: async () => undefined,
      recordSearchHistory: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      recordLiveExaRawResults: async () => ({ entries: [], discoveredDomains: [] }),
      recordLiveExaQueryRuns: async () => ({ entries: [], discoveredDomains: [], queryRuns: [] }),
      writeLatestLeadRun: async () => undefined
    } as any,
    debugConsoleService: {
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.9,
          rationale: "fit"
        }
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      syncQualifiedCompanies: async (companies: Array<{ name: string }>) => {
        syncedCompanies.push(companies[0]?.name ?? "unknown");
        return {
          attempted: true,
          mode: "live",
          candidateCount: companies.length,
          syncedCount: companies.length,
          companySyncedCount: companies.length,
          contactSyncedCount: companies.length
        };
      }
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [createFilter("integrator_vision_industrial_ai")],
      discoverDirectExaCompaniesForExecution: async (
        _filter: OrganizationFilter,
        _targetCategories: LeadCategory[],
        _queryCount: number,
        _screeningOptions: unknown,
        _executionOptions: unknown,
        onQueryProgress?: (update: {
          executedQueries: number;
          totalQueries: number;
          query: string;
          returnedResults: number;
          filteredByExcludedDomains: number;
          filteredByHubSpot: number;
          filteredByRejectedWebsites: number;
          filteredByCurrentRunCache: number;
          duplicatesRemoved: number;
          rawCompaniesFound: number;
          newRawCompanies?: Array<{
            name: string;
            domain?: string;
            shortDescription: string;
            sourceFilter: string;
            discoveryQuery?: string;
          }>;
          filterName: string;
          defaultQueries: string[];
          plannedQueries: string[];
          promptMessages?: Array<{ role: string; content: string }>;
          excludedDomains: string[];
        }) => void
      ) => {
        onQueryProgress?.({
          executedQueries: 1,
          totalQueries: 1,
          query: "vision query",
          returnedResults: 4,
          filteredByExcludedDomains: 0,
          filteredByHubSpot: 0,
          filteredByRejectedWebsites: 0,
          filteredByCurrentRunCache: 0,
          duplicatesRemoved: 0,
          rawCompaniesFound: 2,
          newRawCompanies: [{
            name: "Streamed Vision One",
            domain: "streamed-vision-one.example.com",
            shortDescription: "fit",
            sourceFilter: "exa-filter",
            discoveryQuery: "vision query"
          }, {
            name: "Streamed Vision Two",
            domain: "streamed-vision-two.example.com",
            shortDescription: "fit",
            sourceFilter: "exa-filter",
            discoveryQuery: "vision query"
          }],
          filterName: "filter-integrator_vision_industrial_ai",
          defaultQueries: ["vision query"],
          plannedQueries: ["vision query"],
          promptMessages: [],
          excludedDomains: []
        });

        throw new Error("Exa discovery timed out after 180000ms");
      }
    } as any
  });

  const result = await service.run({
    targetLeadCount: 2,
    targetCategories: ["integrator_vision_industrial_ai"],
    companySearchMode: "exa_search",
    syncToHubSpot: true,
    dryRun: false,
    exaQueryCount: 1,
    maxRuntimeMs: 60_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  });

  assert.deepEqual(syncedCompanies, ["Streamed Vision One", "Streamed Vision Two"]);
  assert.equal(result.hubspotSync.companySyncedCount, 2);
  assert.equal(result.shortlistedCompanies.length, 2);
  assert.equal(result.completionReason, "exa_search_unavailable");
});

test("worker run continues with other Exa filters after a temporary search timeout", async () => {
  const syncedCompanies: string[] = [];
  const attemptedFilters: string[] = [];

  const service = new LeadWorkerRunService({
    controlPlaneStore: {
      getLearning: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      getCompanyScreeningDatabase: async () => ({ records: [] }),
      getLiveExaCache: async () => ({ entries: [], discoveredDomains: [] }),
      writeCompanyScreeningDatabase: async () => undefined,
      recordSearchHistory: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      recordLiveExaRawResults: async () => ({ entries: [], discoveredDomains: [] }),
      recordLiveExaQueryRuns: async () => ({ entries: [], discoveredDomains: [], queryRuns: [] }),
      writeLatestLeadRun: async () => undefined
    } as any,
    debugConsoleService: {
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.9,
          rationale: "fit"
        }
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      syncQualifiedCompanies: async (companies: Array<{ name: string }>) => {
        syncedCompanies.push(companies[0]?.name ?? "unknown");
        return {
          attempted: true,
          mode: "live",
          candidateCount: companies.length,
          syncedCount: companies.length,
          companySyncedCount: companies.length,
          contactSyncedCount: companies.length
        };
      }
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [
        createFilter("integrator_vision_industrial_ai"),
        { ...createFilter("integrator_vision_industrial_ai"), name: "filter-integrator-backup" }
      ],
      discoverDirectExaCompaniesForExecution: async (filter: OrganizationFilter) => {
        attemptedFilters.push(filter.name);
        if (filter.name === "filter-integrator_vision_industrial_ai") {
          throw new Error("Exa discovery timed out after 180000ms");
        }

        return [{
          name: "Backup Vision Integrator",
          domain: "backup-vision-integrator.example.com",
          shortDescription: "fit",
          sourceFilter: filter.name,
          discoveryQuery: "backup query"
        }];
      }
    } as any
  });

  const result = await service.run({
    targetLeadCount: 1,
    targetCategories: ["integrator_vision_industrial_ai"],
    companySearchMode: "exa_search",
    syncToHubSpot: true,
    dryRun: false,
    exaQueryCount: 1,
    maxRuntimeMs: 60_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  });

  assert.ok(attemptedFilters.includes("filter-integrator_vision_industrial_ai"));
  assert.ok(attemptedFilters.includes("filter-integrator-backup"));
  assert.deepEqual(syncedCompanies, ["Backup Vision Integrator"]);
  assert.equal(result.hubspotSync.companySyncedCount, 1);
  assert.equal(result.shortlistedCompanies[0]?.name, "Backup Vision Integrator");
  assert.equal(result.completionReason, "target_reached");
});

test("worker run can search with two Exa producer workers in parallel when multiple filters exist", async () => {
  let activeExaCalls = 0;
  let maxActiveExaCalls = 0;

  const service = new LeadWorkerRunService({
    controlPlaneStore: {
      getLearning: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      getCompanyScreeningDatabase: async () => ({ records: [] }),
      getLiveExaCache: async () => ({ entries: [], discoveredDomains: [] }),
      writeCompanyScreeningDatabase: async () => undefined,
      recordSearchHistory: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      recordLiveExaRawResults: async () => ({ entries: [], discoveredDomains: [] }),
      recordLiveExaQueryRuns: async () => ({ entries: [], discoveredDomains: [], queryRuns: [] }),
      writeLatestLeadRun: async () => undefined
    } as any,
    debugConsoleService: {
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.91,
          rationale: "fit"
        }
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      syncQualifiedCompanies: async () => ({
        attempted: true,
        mode: "live",
        candidateCount: 1,
        syncedCount: 1,
        companySyncedCount: 1,
        contactSyncedCount: 1
      })
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [
        createFilter("integrator_vision_industrial_ai"),
        createFilter("integrator_general_ai")
      ],
      discoverDirectExaCompaniesForExecution: async (
        filter: OrganizationFilter,
        _targetCategories: LeadCategory[],
        _maxQueryCount: number,
        _excludeDomainSources: unknown,
        _queryPlanningContext: unknown,
        onQueryProgress?: (update: {
          executedQueries: number;
          totalQueries: number;
          query: string;
          returnedResults: number;
          filteredByExcludedDomains: number;
          duplicatesRemoved: number;
          rawCompaniesFound: number;
          filterName: string;
          defaultQueries: string[];
          plannedQueries: string[];
          excludedDomains: string[];
        }) => void
      ) => {
        activeExaCalls += 1;
        maxActiveExaCalls = Math.max(maxActiveExaCalls, activeExaCalls);

        onQueryProgress?.({
          executedQueries: 1,
          totalQueries: 1,
          query: `query-${filter.name}`,
          returnedResults: 1,
          filteredByExcludedDomains: 0,
          duplicatesRemoved: 0,
          rawCompaniesFound: 1,
          filterName: filter.name,
          defaultQueries: [`query-${filter.name}`],
          plannedQueries: [`query-${filter.name}`],
          excludedDomains: []
        });

        await new Promise((resolve) => setTimeout(resolve, 50));
        activeExaCalls -= 1;

        return [{
          name: `${filter.name}-company`,
          domain: `${filter.name}.example.com`,
          shortDescription: "parallel result",
          sourceFilter: filter.name,
          discoveryQuery: `query-${filter.name}`
        }];
      }
    } as any
  });

  await service.run({
    targetLeadCount: 2,
    targetCategories: ["integrator_vision_industrial_ai", "integrator_general_ai"],
    companySearchMode: "exa_search",
    syncToHubSpot: true,
    dryRun: false,
    exaQueryCount: 1,
    maxRuntimeMs: 60_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  });

  assert.equal(maxActiveExaCalls, 2);
});

test("worker run reports raw Exa results separately from excluded and unique companies", async () => {
  const progressSnapshots: Array<{
    workerMetrics?: {
      exaRequests?: number;
      exaReturnedResults?: number;
      exaFilteredByExcludedDomains?: number;
      exaDuplicatesRemoved?: number;
      exaRawFound?: number;
    };
    liveSearchDebug?: {
      returnedResults?: number;
      filteredByExcludedDomains?: number;
      duplicatesRemoved?: number;
      rawCompaniesFound?: number;
    };
  }> = [];

  const service = new LeadWorkerRunService({
    controlPlaneStore: {
      getLearning: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      getCompanyScreeningDatabase: async () => ({ records: [] }),
      getLiveExaCache: async () => ({ entries: [], discoveredDomains: [] }),
      writeCompanyScreeningDatabase: async () => undefined,
      recordSearchHistory: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      recordLiveExaRawResults: async () => ({ entries: [], discoveredDomains: [] }),
      recordLiveExaQueryRuns: async () => ({ entries: [], discoveredDomains: [], queryRuns: [] }),
      writeLatestLeadRun: async () => undefined
    } as any,
    debugConsoleService: {
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.9,
          rationale: "fit"
        }
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      syncQualifiedCompanies: async () => ({
        attempted: true,
        mode: "live",
        candidateCount: 1,
        syncedCount: 1,
        companySyncedCount: 1,
        contactSyncedCount: 1
      })
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [createFilter("integrator_vision_industrial_ai")],
      discoverDirectExaCompaniesForExecution: async (
        filter: OrganizationFilter,
        _targetCategories: LeadCategory[],
        _maxQueryCount: number,
        _excludeDomainSources: unknown,
        _queryPlanningContext: unknown,
        onQueryProgress?: (update: {
          executedQueries: number;
          totalQueries: number;
          query: string;
          returnedResults: number;
          filteredByExcludedDomains: number;
          duplicatesRemoved: number;
          rawCompaniesFound: number;
          filterName: string;
          defaultQueries: string[];
          plannedQueries: string[];
          excludedDomains: string[];
        }) => void
      ) => {
        onQueryProgress?.({
          executedQueries: 1,
          totalQueries: 1,
          query: "query one",
          returnedResults: 20,
          filteredByExcludedDomains: 17,
          duplicatesRemoved: 0,
          rawCompaniesFound: 3,
          filterName: filter.name,
          defaultQueries: ["query one"],
          plannedQueries: ["query one"],
          excludedDomains: []
        });

        return [
          { name: "Alpha Vision", domain: "alpha-vision.example.com", shortDescription: "alpha", sourceFilter: filter.name, discoveryQuery: "query one" },
          { name: "Alpha Vision", domain: "alpha-vision.example.com", shortDescription: "alpha duplicate", sourceFilter: filter.name, discoveryQuery: "query one" },
          { name: "Beta Vision", domain: "beta-vision.example.com", shortDescription: "beta", sourceFilter: filter.name, discoveryQuery: "query one" }
        ];
      }
    } as any
  });

  await service.run({
    targetLeadCount: 1,
    targetCategories: ["integrator_vision_industrial_ai"],
    companySearchMode: "exa_search",
    syncToHubSpot: true,
    dryRun: false,
    maxRuntimeMs: 60_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1,
    exaQueryCount: 1
  }, {
    onProgress: (progress) => {
      progressSnapshots.push({
        workerMetrics: progress.workerMetrics
          ? {
              exaRequests: progress.workerMetrics.exaRequests,
              exaBatchesStarted: progress.workerMetrics.exaBatchesStarted,
              exaReturnedResults: progress.workerMetrics.exaReturnedResults,
              exaFilteredByExcludedDomains: progress.workerMetrics.exaFilteredByExcludedDomains,
              exaDuplicatesRemoved: progress.workerMetrics.exaDuplicatesRemoved,
              exaRawFound: progress.workerMetrics.exaRawFound
            }
          : undefined,
        liveSearchDebug: progress.liveSearchDebug
          ? {
              returnedResults: progress.liveSearchDebug.returnedResults,
              filteredByExcludedDomains: progress.liveSearchDebug.filteredByExcludedDomains,
              duplicatesRemoved: progress.liveSearchDebug.duplicatesRemoved,
              rawCompaniesFound: progress.liveSearchDebug.rawCompaniesFound
            }
          : undefined
      });
    }
  });

  assert.ok(progressSnapshots.some((snapshot) => snapshot.workerMetrics?.exaReturnedResults === 20));
  assert.ok(progressSnapshots.some((snapshot) => snapshot.workerMetrics?.exaFilteredByExcludedDomains === 17));
  assert.ok(progressSnapshots.some((snapshot) => snapshot.workerMetrics?.exaDuplicatesRemoved === 1));
  assert.ok(progressSnapshots.some((snapshot) => snapshot.workerMetrics?.exaRawFound === 2));
  assert.ok(progressSnapshots.some((snapshot) => snapshot.workerMetrics?.exaRequests === 1));
  assert.ok(progressSnapshots.some((snapshot) => snapshot.workerMetrics?.exaBatchesStarted === 1));
  assert.ok(progressSnapshots.some((snapshot) => snapshot.liveSearchDebug?.returnedResults === 20));
});

test("worker run records excluded-domain category counts per query instead of cumulative totals", async () => {
  const progressSnapshots: Array<{
    currentBatchQueryStats?: Array<{
      query: string;
      filteredByHubSpot: number;
      filteredByRejectedWebsites: number;
      filteredByCurrentRunCache: number;
    }>;
  }> = [];

  const service = new LeadWorkerRunService({
    controlPlaneStore: {
      getLearning: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      getCompanyScreeningDatabase: async () => ({ records: [] }),
      getLiveExaCache: async () => ({ entries: [], discoveredDomains: [] }),
      writeCompanyScreeningDatabase: async () => undefined,
      recordSearchHistory: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      recordLiveExaRawResults: async () => ({ entries: [], discoveredDomains: [] }),
      recordLiveExaQueryRuns: async () => ({ entries: [], discoveredDomains: [], queryRuns: [] }),
      writeLatestLeadRun: async () => undefined
    } as any,
    debugConsoleService: {
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.9,
          rationale: "fit"
        }
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      syncQualifiedCompanies: async () => ({
        attempted: true,
        mode: "live",
        candidateCount: 1,
        syncedCount: 1,
        companySyncedCount: 1,
        contactSyncedCount: 1
      })
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [createFilter("integrator_vision_industrial_ai")],
      discoverDirectExaCompaniesForExecution: async (
        filter: ApolloOrganizationFilter,
        _targetCategories: LeadCategory[],
        _maxQueryCount: number,
        _excludeDomainSources: unknown,
        _queryPlanningContext: unknown,
        onQueryProgress?: (update: {
          executedQueries: number;
          totalQueries: number;
          query: string;
          returnedResults: number;
          filteredByExcludedDomains: number;
          filteredByHubSpot: number;
          filteredByRejectedWebsites: number;
          filteredByCurrentRunCache: number;
          duplicatesRemoved: number;
          rawCompaniesFound: number;
          filterName: string;
          defaultQueries: string[];
          plannedQueries: string[];
          excludedDomains: string[];
        }) => void
      ) => {
        onQueryProgress?.({
          executedQueries: 1,
          totalQueries: 2,
          query: "query one",
          returnedResults: 10,
          filteredByExcludedDomains: 3,
          filteredByHubSpot: 2,
          filteredByRejectedWebsites: 1,
          filteredByCurrentRunCache: 0,
          duplicatesRemoved: 0,
          rawCompaniesFound: 7,
          filterName: filter.name,
          defaultQueries: ["query one", "query two"],
          plannedQueries: ["query one", "query two"],
          excludedDomains: []
        });

        onQueryProgress?.({
          executedQueries: 2,
          totalQueries: 2,
          query: "query two",
          returnedResults: 20,
          filteredByExcludedDomains: 5,
          filteredByHubSpot: 3,
          filteredByRejectedWebsites: 1,
          filteredByCurrentRunCache: 1,
          duplicatesRemoved: 0,
          rawCompaniesFound: 15,
          filterName: filter.name,
          defaultQueries: ["query one", "query two"],
          plannedQueries: ["query one", "query two"],
          excludedDomains: []
        });

        return [
          { name: "Alpha Vision", domain: "alpha-vision.example.com", shortDescription: "alpha", sourceFilter: filter.name, discoveryQuery: "query one" }
        ];
      }
    } as any
  });

  await service.run({
    targetLeadCount: 1,
    targetCategories: ["integrator_vision_industrial_ai"],
    companySearchMode: "exa_search",
    syncToHubSpot: true,
    dryRun: false,
    maxRuntimeMs: 60_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1,
    exaQueryCount: 2
  }, {
    onProgress: (progress) => {
      progressSnapshots.push({
        currentBatchQueryStats: progress.liveSearchDebug?.currentBatchQueryStats?.map((queryStat) => ({
          query: queryStat.query,
          filteredByHubSpot: queryStat.filteredByHubSpot,
          filteredByRejectedWebsites: queryStat.filteredByRejectedWebsites,
          filteredByCurrentRunCache: queryStat.filteredByCurrentRunCache
        }))
      });
    }
  });

  assert.ok(progressSnapshots.some((snapshot) => snapshot.currentBatchQueryStats?.some((queryStat) => queryStat.query === "query one" && queryStat.filteredByHubSpot === 2 && queryStat.filteredByRejectedWebsites === 1 && queryStat.filteredByCurrentRunCache === 0)));
  assert.ok(progressSnapshots.some((snapshot) => snapshot.currentBatchQueryStats?.some((queryStat) => queryStat.query === "query two" && queryStat.filteredByHubSpot === 1 && queryStat.filteredByRejectedWebsites === 0 && queryStat.filteredByCurrentRunCache === 1)));
});

test("worker run only syncs AI-matching categories to HubSpot and leaves other categories rejected", async () => {
  const syncedCompanies: string[] = [];
  const screeningWrites: CompanyScreeningDatabase[] = [];

  const service = new LeadWorkerRunService({
    controlPlaneStore: {
      getLearning: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      getCompanyScreeningDatabase: async () => ({ records: [] }),
      getLiveExaCache: async () => ({ entries: [], discoveredDomains: [] }),
      writeCompanyScreeningDatabase: async (database: CompanyScreeningDatabase) => {
        screeningWrites.push(database);
      },
      recordSearchHistory: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      recordLiveExaRawResults: async () => ({ entries: [], discoveredDomains: [] }),
      recordLiveExaQueryRuns: async () => ({ entries: [], discoveredDomains: [], queryRuns: [] }),
      writeLatestLeadRun: async () => undefined
    } as any,
    debugConsoleService: {
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          category: company.name === "Accepted Vision"
            ? "integrator_vision_industrial_ai"
            : "integrator_general_ai",
          relevanceScore: 0.9,
          rationale: company.name === "Accepted Vision" ? "fit" : "wrong category"
        }
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      syncQualifiedCompanies: async (companies: Array<{ name: string }>) => {
        syncedCompanies.push(companies[0].name);
        return {
          attempted: true,
          mode: "live",
          candidateCount: 1,
          syncedCount: 1,
          companySyncedCount: 1,
          contactSyncedCount: 1
        };
      }
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [createFilter("integrator_vision_industrial_ai")],
      discoverDirectExaCompaniesForExecution: async () => [
        {
          name: "Accepted Vision",
          domain: "accepted-vision.example.com",
          shortDescription: "accepted",
          sourceFilter: "filter-integrator_vision_industrial_ai",
          discoveryQuery: "accepted query"
        },
        {
          name: "Rejected General",
          domain: "rejected-general.example.com",
          shortDescription: "rejected",
          sourceFilter: "filter-integrator_vision_industrial_ai",
          discoveryQuery: "rejected query"
        }
      ]
    } as any
  });

  const result = await service.run({
    targetLeadCount: 1,
    targetCategories: ["integrator_vision_industrial_ai"],
    companySearchMode: "exa_search",
    syncToHubSpot: true,
    dryRun: false,
    maxRuntimeMs: 60_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  });

  assert.deepEqual(syncedCompanies, ["Accepted Vision"]);
  assert.equal(result.hubspotSync.companySyncedCount, 1);
  assert.equal(result.shortlistedCompanies.length, 1);
  assert.equal(result.shortlistedCompanies[0]?.name, "Accepted Vision");
  assert.equal(result.funnel.afterAzureAICheck, 1);
  assert.ok(screeningWrites.length > 0);
  const latestScreening = screeningWrites.at(-1);
  assert.ok(latestScreening?.records.some((record) => record.companyName === "Rejected General" && record.category === "integrator_general_ai"));
  assert.ok(!latestScreening?.records.some((record) => record.companyName === "Accepted Vision"));
});

test("worker run still syncs companies to HubSpot when contact discovery fails", async () => {
  const syncedCompanies: string[] = [];
  const service = new LeadWorkerRunService({
    controlPlaneStore: {
      getCompanyScreeningDatabase: async () => ({
        records: [{
          companyName: "Timeout Vision",
          normalizedName: "timeout vision",
          domain: "timeout-vision.example.com",
          normalizedDomain: "timeout-vision.example.com",
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.95,
          rationale: "Already screened live",
          sourceFilter: "live-filter"
        }]
      }),
      getLiveExaCache: async () => ({ entries: [], discoveredDomains: [] }),
      writeCompanyScreeningDatabase: async () => undefined,
      recordSearchHistory: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      recordLiveExaRawResults: async () => ({ entries: [], discoveredDomains: [] }),
      writeLatestLeadRun: async () => undefined
    } as any,
    debugConsoleService: {
      createManualCompanyForWebsite: (website: string, filter: OrganizationFilter) => ({
        name: "Timeout Vision",
        domain: website,
        shortDescription: "Timeout company",
        sourceFilter: filter.name
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async () => {
        throw new Error("Contact worker timed out after 150000ms");
      }
    } as any,
    hubSpotClient: {
      syncQualifiedCompanies: async (companies: Array<{ name: string }>) => {
        syncedCompanies.push(companies[0].name);
        return {
          attempted: true,
          mode: "live",
          candidateCount: 1,
          syncedCount: 1,
          companySyncedCount: 1,
          contactSyncedCount: 0
        };
      }
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [createFilter("integrator_vision_industrial_ai")],
      discoverDirectExaCompaniesForExecution: async () => []
    } as any
  });

  const result = await service.run({
    targetLeadCount: 1,
    targetCategories: ["integrator_vision_industrial_ai"],
    companySearchMode: "exa_search",
    syncToHubSpot: true,
    dryRun: false,
    maxRuntimeMs: 1_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  });

  assert.deepEqual(syncedCompanies, ["Timeout Vision"]);
  assert.equal(result.hubspotSync.companySyncedCount, 1);
  assert.equal(result.shortlistedCompanies.length, 1);
});

test("worker run times out a stuck HubSpot sync instead of blocking the drain forever", async () => {
  let syncCalls = 0;
  const progressMessages: string[] = [];
  const filterCallCounts = new Map<string, number>();

  const service = new LeadWorkerRunService({
    controlPlaneStore: {
      getLearning: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      getCompanyScreeningDatabase: async () => ({ records: [] }),
      getLiveExaCache: async () => ({ entries: [], discoveredDomains: [] }),
      writeCompanyScreeningDatabase: async () => undefined,
      recordSearchHistory: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      recordLiveExaRawResults: async () => ({ entries: [], discoveredDomains: [] }),
      recordLiveExaQueryRuns: async () => ({ entries: [], discoveredDomains: [], queryRuns: [] }),
      writeLatestLeadRun: async () => undefined
    } as any,
    debugConsoleService: {
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.9,
          rationale: "fit"
        }
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      syncQualifiedCompanies: async (companies: Array<{ name: string }>) => {
        syncCalls += 1;
        if (companies[0]?.name === "Alpha Vision") {
          await new Promise((resolve) => setTimeout(resolve, 80));
        }

        return {
          attempted: true,
          mode: "live",
          candidateCount: 1,
          syncedCount: 1,
          companySyncedCount: companies[0]?.name === "Alpha Vision" ? 0 : 1,
          contactSyncedCount: companies[0]?.name === "Alpha Vision" ? 0 : 1
        };
      }
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [createFilter("integrator_vision_industrial_ai"), createFilter("integrator_general_ai")],
      discoverDirectExaCompaniesForExecution: async (filter: OrganizationFilter) => {
        const filterName = filter.name;
        const nextCount = (filterCallCounts.get(filterName) ?? 0) + 1;
        filterCallCounts.set(filterName, nextCount);
        const companyName = filter.targetCategories?.[0] === "integrator_general_ai"
          ? (nextCount === 1 ? "Beta Vision" : "Gamma Vision")
          : (nextCount === 1 ? "Alpha Vision" : "Delta Vision");
        return [{
          name: companyName,
          domain: `${companyName.toLowerCase().replace(/\s+/g, "-")}.example.com`,
          shortDescription: "fit",
          sourceFilter: filter.name,
          discoveryQuery: `query-${companyName}`
        }];
      }
    } as any,
    hubspotTaskTimeoutMs: 20
  });

  const result = await service.run({
    targetLeadCount: 2,
    targetCategories: ["integrator_vision_industrial_ai", "integrator_general_ai"],
    companySearchMode: "exa_search",
    syncToHubSpot: true,
    dryRun: false,
    exaQueryCount: 1,
    maxRuntimeMs: 60_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  }, {
    onProgress: (progress) => {
      if (progress.detail) {
        progressMessages.push(progress.detail);
      }
    }
  });

  assert.ok(syncCalls >= 2);
  assert.equal(result.hubspotSync.companySyncedCount, 2);
  assert.ok(progressMessages.some((message) => message.includes("HubSpot worker timed out after 20ms")));
});

test("AsyncQueue clear removes queued items before close", async () => {
  const queue = new AsyncQueue<number>();

  queue.enqueue(1);
  queue.enqueue(2);
  assert.equal(queue.size, 2);

  queue.clear();
  queue.close();

  assert.equal(queue.size, 0);
  assert.equal(await queue.dequeue(), undefined);
});

test("worker run passes selected contacts to HubSpot sync under the normalized company key", async () => {
  let syncedContactCount = 0;

  const service = new LeadWorkerRunService({
    controlPlaneStore: {
      getCompanyScreeningDatabase: async () => ({
        records: [{
          companyName: "GeoTT",
          normalizedName: "geott",
          domain: "https://geott.de",
          normalizedDomain: "geott.de",
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.95,
          rationale: "Already screened live",
          sourceFilter: "live-filter"
        }]
      }),
      getLiveExaCache: async () => ({ entries: [], discoveredDomains: [] }),
      writeCompanyScreeningDatabase: async () => undefined,
      recordSearchHistory: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      recordLiveExaRawResults: async () => ({ entries: [], discoveredDomains: [] }),
      writeLatestLeadRun: async () => undefined
    } as any,
    debugConsoleService: {
      createManualCompanyForWebsite: (website: string, filter: OrganizationFilter) => ({
        name: "GeoTT",
        domain: website,
        shortDescription: "GeoTT company",
        sourceFilter: filter.name
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async () => ({
        selectedContacts: [{
          firstName: "Nicolas",
          lastName: "March",
          linkedinUrl: "https://de.linkedin.com/in/nicolas-march-ai4robotics",
          sourceUrl: "https://de.linkedin.com/in/nicolas-march-ai4robotics",
          label: "linkedin_profile"
        }]
      })
    } as any,
    hubSpotClient: {
      syncQualifiedCompanies: async (_companies: Array<{ name: string }>, _briefs: unknown[], contactsByCompany: Map<string, PublicContactCandidate[]>) => {
        syncedContactCount = contactsByCompany.get("geott.de")?.length ?? 0;
        return {
          attempted: true,
          mode: "live",
          candidateCount: 1,
          syncedCount: 2,
          companySyncedCount: 1,
          contactSyncedCount: syncedContactCount
        };
      }
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [createFilter("integrator_vision_industrial_ai")],
      discoverDirectExaCompaniesForExecution: async () => []
    } as any
  });

  const result = await service.run({
    targetLeadCount: 1,
    targetCategories: ["integrator_vision_industrial_ai"],
    companySearchMode: "exa_search",
    syncToHubSpot: true,
    dryRun: false,
    maxRuntimeMs: 60_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  });

  assert.equal(syncedContactCount, 1);
  assert.equal(result.hubspotSync.contactSyncedCount, 1);
});