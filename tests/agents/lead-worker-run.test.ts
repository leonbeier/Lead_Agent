import test from "node:test";
import assert from "node:assert/strict";
import { AsyncQueue, LeadWorkerRunService, resolveContactSearchConcurrency, MAX_CONTACT_CONCURRENCY } from "../../src/agents/lead-worker-run";
import { HubSpotClient, HUBSPOT_BROWSER_TASK_CONCURRENCY } from "../../src/clients/hubspot";
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
      // Seeds flow through the SAME website -> AI classification path as fresh Exa results. The
      // classifier determines the category AND the headquarters country from the live website in a
      // single check (here: an in-region German integrator), then the accept gate decides scope.
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.9,
          rationale: "fit",
          country: "Germany"
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

test("worker run does not re-admit a screening seed whose persisted country is out of region", async () => {
  let exaCalls = 0;
  let syncCalls = 0;

  const service = new LeadWorkerRunService({
    controlPlaneStore: {
      getLearning: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      getCompanyScreeningDatabase: async () => ({
        records: [{
          companyName: "Innerspec Technologies",
          normalizedName: "innerspec technologies",
          domain: "innerspec.com",
          normalizedDomain: "innerspec.com",
          // This company has a matching category but was screened out previously because its
          // headquarters is in the US. The persisted country must keep it out of scope so it is
          // not re-admitted as an in-scope seed.
          country: "United States",
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
      // The seed runs through the AI classifier, which confirms the US headquarters from the
      // website. The accept gate then rejects it on locality before any outreach/contact/sync work,
      // instead of letting it travel the whole pipeline only to be skipped at the pre-write gate.
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string; country?: string }) => ({
        categorizedCompany: {
          ...company,
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.9,
          rationale: "fit",
          country: "United States"
        }
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      syncQualifiedCompanies: async () => {
        syncCalls += 1;
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
        return [];
      },
      isCompanyInExecutionScope: (company: { country?: string }) => {
        const country = (company.country ?? "").trim().toLowerCase();
        return country === "" || country === "germany";
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

  assert.equal(syncCalls, 0);
  assert.ok(!result.shortlistedCompanies.some((company) => company.name === "Innerspec Technologies"));
});

test("worker run does not fabricate a market-default country for a seed with no persisted country", async () => {
  let syncCalls = 0;

  const service = new LeadWorkerRunService({
    controlPlaneStore: {
      getLearning: async () => ({ companyFeedback: [], filterPerformance: {}, searchHistory: [], searchHistoryByMode: {} }),
      getCompanyScreeningDatabase: async () => ({
        records: [{
          companyName: "Mapvision",
          normalizedName: "mapvision",
          // A neutral / non-German domain seed that was screened in for category but never had an
          // evidence-based country persisted. Previously the seed reuse path fell back to
          // createManualCompanyForWebsite's market default ("Germany"), which let an out-of-region
          // company be written to HubSpot as Germany. With no persisted country it must instead be
          // verified by the fail-closed locality gate, not granted a fake market country.
          domain: "mapvision.com",
          normalizedDomain: "mapvision.com",
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
      // The classifier finds no reliable country evidence on the website and returns an empty
      // country (no market-default fabrication). With no resolveCompanyAddress on the HubSpot mock
      // the deep resolver also yields nothing, so the company reaches the scope check with an empty
      // country and a neutral .com domain and is rejected before any sync.
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
      syncQualifiedCompanies: async () => {
        syncCalls += 1;
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
      discoverDirectExaCompaniesForExecution: async () => [],
      isCompanyInExecutionScope: (company: { country?: string; domain?: string }) => {
        const country = (company.country ?? "").trim().toLowerCase();
        // Germany-focused market scope: a present country must be Germany; an empty country falls
        // back to a .de domain check. mapvision.com with an empty country is therefore out of scope.
        if (country) {
          return country === "germany";
        }
        return (company.domain ?? "").toLowerCase().includes(".de");
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

  assert.equal(syncCalls, 0);
  assert.ok(!result.shortlistedCompanies.some((company) => company.name === "Mapvision"));
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
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.9,
          rationale: "fit",
          country: "Germany"
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
        syncedCount: 0,
        companySyncedCount: 0,
        contactSyncedCount: 0,
        errors: ["hubspot write failed"]
      })
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [createFilter("integrator_vision_industrial_ai")],
      // The only company is the failing seed; Exa supplies no fresh companies. Signal credits
      // exhaustion so the run stops cleanly instead of spinning the exa workers until the 60s
      // minimum-runtime floor (the seed assertion below is unaffected by why the search stops).
      discoverDirectExaCompaniesForExecution: async () => {
        throw new Error("Exa search failed: no_more_credits");
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

  assert.equal(result.hubspotSync.companySyncedCount, 0);
  // The seed was classified (upserted into screening) but the failed HubSpot write must NOT remove
  // it, so it stays in the screening database and can be retried on a later run.
  assert.ok(screeningWrites.length > 0);
  assert.ok(screeningWrites.at(-1)?.records.some((record) => record.companyName === "Seed Vision"));
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

test("worker run skips HubSpot write when the website-verified country is out of region", async () => {
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
      // Sourcing-time country mislabels this company as German; it therefore passes the
      // qualification-time scope gate even though its real headquarters are overseas.
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          country: "Germany",
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.93,
          rationale: "fit"
        }
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      // The website crawl reveals the company is actually based in the United States.
      resolveCompanyAddress: async () => ({ companyName: "Offshore Vision Inc", country: "United States" }),
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
      isCompanyInExecutionScope: (company: { country?: string }) => {
        const country = (company.country ?? "").trim().toLowerCase();
        return country === "" || country === "germany";
      },
      discoverDirectExaCompaniesForExecution: async () => {
        exaCalls += 1;
        if (exaCalls > 1) {
          throw new Error("Exa search failed: 503 unavailable");
        }
        return [{
          name: "Surface Vision",
          domain: "surface-vision.example.com",
          country: "Germany",
          shortDescription: "Industrial vision integrator",
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

  assert.deepEqual(syncedCompanies, []);
  assert.equal(result.hubspotSync.companySyncedCount, 0);
});

test("worker run skips a company whose authoritative country resolves out of region only AFTER the qualification gate (gate/writer divergence)", async () => {
  // Reproduces the live Singapore-in-a-DE-run leak. The per-domain identity resolution is shared
  // between the qualification gate and the HubSpot writer. Under browser-lane load the gate's 90s
  // race TIMES OUT (returns null), so the gate approves the company on its in-scope SOURCING
  // country (Germany). The shared resolution then completes during contact discovery / outreach
  // with the company's TRUE country (Singapore), which the writer would persist — an out-of-region
  // record in a Germany-focused run. The first resolveCompanyAddress call (gate) returns null; the
  // second (the final pre-write authoritative check) returns Singapore. Without the final check +
  // resolved-address threading the writer is reached (syncedCompanies non-empty); with the fix the
  // company is skipped before any write.
  const syncedCompanies: string[] = [];
  let exaCalls = 0;
  let identityCalls = 0;

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
      // Sourcing-time country mislabels this company as German (non-empty, so the deeper country
      // backfill is skipped) and it passes the qualification-time scope gate.
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          country: "Germany",
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.93,
          rationale: "fit"
        }
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      // Call #1 is the qualification gate: it times out under load (null) so the gate keeps the
      // in-scope sourcing country. Call #2 is the final pre-write authoritative check: the shared
      // resolution has now completed and reveals the real headquarters are in Singapore.
      resolveCompanyAddress: async () => {
        identityCalls += 1;
        return identityCalls <= 1 ? null : { companyName: "Hypernology APAC Pte. Ltd.", country: "Singapore" };
      },
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
      isCompanyInExecutionScope: (company: { country?: string }) => {
        const country = (company.country ?? "").trim().toLowerCase();
        return country === "" || country === "germany";
      },
      discoverDirectExaCompaniesForExecution: async () => {
        exaCalls += 1;
        if (exaCalls > 1) {
          throw new Error("Exa search failed: 503 unavailable");
        }
        return [{
          name: "Hypernology APAC",
          domain: "hypernology.net",
          country: "Germany",
          shortDescription: "Industrial vision integrator",
          sourceFilter: "exa-filter"
        }];
      }
    } as any
  });

  const result = await service.run({
    targetLeadCount: 1,
    targetCategories: ["integrator_vision_industrial_ai"],
    companySearchMode: "exa_search",
    market: "DE",
    syncToHubSpot: true,
    dryRun: false,
    reuseQualifiedCompanyCache: false,
    exaQueryCount: 1,
    maxRuntimeMs: 60_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  });

  assert.ok(identityCalls >= 2, "the final pre-write authoritative locality check must re-resolve the identity");
  assert.deepEqual(syncedCompanies, [], "an out-of-region company resolved after the gate must never be written");
  assert.equal(result.hubspotSync.companySyncedCount, 0);
});

test("worker run fails closed when a neutral-TLD company has no resolved country and verification fails", async () => {
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
      // No country could be inferred for this .com company at sourcing time, so qualification
      // scope only passes via the neutral fallback (filter.locations.every(isEuropean)).
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          country: "",
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.93,
          rationale: "fit"
        }
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      // The website crawl times out / returns no usable country: identity verification fails.
      resolveCompanyAddress: async () => null,
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
      isCompanyInExecutionScope: (company: { country?: string }) => {
        const country = (company.country ?? "").trim().toLowerCase();
        return country === "" || country === "germany";
      },
      discoverDirectExaCompaniesForExecution: async () => {
        exaCalls += 1;
        if (exaCalls > 1) {
          throw new Error("Exa search failed: 503 unavailable");
        }
        return [{
          name: "Unverifiable Vision",
          domain: "unverifiable-vision.com",
          country: "",
          shortDescription: "Industrial vision integrator",
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

  assert.deepEqual(syncedCompanies, []);
  assert.equal(result.hubspotSync.companySyncedCount, 0);
});

test("worker run still writes an evidence-based EU company on a neutral TLD when the verification crawl fails", async () => {
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
      // Country was inferred from website/snippet evidence at sourcing time (Germany), so it is a
      // trustworthy in-region signal even though the domain is a neutral .com TLD.
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          country: "Germany",
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.93,
          rationale: "fit"
        }
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      // The browser identity crawl times out under load and cannot re-verify the country. A real
      // German .com company must NOT be dropped just because verification failed.
      resolveCompanyAddress: async () => null,
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
      isCompanyInExecutionScope: (company: { country?: string }) => {
        const country = (company.country ?? "").trim().toLowerCase();
        return country === "" || country === "germany";
      },
      discoverDirectExaCompaniesForExecution: async () => {
        exaCalls += 1;
        if (exaCalls > 1) {
          throw new Error("Exa search failed: 503 unavailable");
        }
        return [{
          name: "Real German Vision",
          domain: "real-german-vision.com",
          country: "Germany",
          shortDescription: "Industrial vision integrator",
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

  assert.deepEqual(syncedCompanies, ["Real German Vision"]);
  assert.equal(result.hubspotSync.companySyncedCount, 1);
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
  // The two companies streamed via onQueryProgress before the batch threw are enough to reach
  // target=2, so the retry budget lets the run finish on target rather than collapsing to
  // exa_search_unavailable on the first transient timeout.
  assert.equal(result.completionReason, "target_reached");
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

test("worker run keeps a single filter in rotation after one transient Exa timeout", async () => {
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
        // First batch hits a transient timeout. Under the old single-failure retirement this ended
        // the whole run with "exa_search_unavailable" and zero companies. The retry budget keeps the
        // sole filter in rotation so the very next batch can still deliver a company.
        if (exaCalls === 1) {
          throw new Error("Exa discovery timed out after 180000ms");
        }

        return [{
          name: "Recovered Vision Integrator",
          domain: "recovered-vision-integrator.example.com",
          shortDescription: "fit",
          sourceFilter: "exa-filter",
          discoveryQuery: "vision query"
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

  assert.ok(exaCalls >= 2);
  assert.deepEqual(syncedCompanies, ["Recovered Vision Integrator"]);
  assert.equal(result.hubspotSync.companySyncedCount, 1);
  assert.equal(result.shortlistedCompanies[0]?.name, "Recovered Vision Integrator");
  assert.notEqual(result.completionReason, "exa_search_unavailable");
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
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.9,
          rationale: "fit",
          country: "Germany"
        }
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
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.9,
          rationale: "fit",
          country: "Germany"
        }
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

test("worker run admits an out-of-Europe company when the AI region check says it is in the target market", async () => {
  const syncedCompanies: string[] = [];
  const regionChecks: Array<{ country?: string; market?: string }> = [];
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
          country: "United States",
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.93,
          rationale: "fit"
        }
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      // The website crawl confirms the US headquarters.
      resolveCompanyAddress: async () => ({ companyName: "Bay Vision Inc", country: "United States" }),
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
      // AI-backed flexible region check: the market "EU und USA" includes the United States, so a US
      // company is in scope. A hardcoded Europe-only list would have wrongly rejected it.
      isCompanyInExecutionScopeAsync: async (company: { country?: string }, _filter: unknown, market?: string) => {
        regionChecks.push({ country: company.country, market });
        const country = (company.country ?? "").trim().toLowerCase();
        return country === "united states" || country === "germany";
      },
      discoverDirectExaCompaniesForExecution: async () => {
        exaCalls += 1;
        if (exaCalls > 1) {
          throw new Error("Exa search failed: 503 unavailable");
        }
        return [{
          name: "Bay Vision",
          domain: "bay-vision.com",
          country: "United States",
          shortDescription: "Industrial vision integrator",
          sourceFilter: "exa-filter"
        }];
      }
    } as any
  });

  const result = await service.run({
    targetLeadCount: 1,
    targetCategories: ["integrator_vision_industrial_ai"],
    companySearchMode: "exa_search",
    market: "EU und USA",
    syncToHubSpot: true,
    dryRun: false,
    reuseQualifiedCompanyCache: false,
    exaQueryCount: 1,
    maxRuntimeMs: 60_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  });

  assert.deepEqual(syncedCompanies, ["Bay Vision Inc"]);
  assert.equal(result.hubspotSync.companySyncedCount, 1);
  assert.ok(regionChecks.some((check) => check.market === "EU und USA" && (check.country ?? "").toLowerCase() === "united states"));
});

test("worker run AI-resolves and stores a location for a category-relevant company with no sourcing-time country", async () => {
  const screeningWrites: CompanyScreeningDatabase[] = [];
  let resolveCalls = 0;
  let exaCalls = 0;

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
      writeLatestLeadRun: async () => undefined
    } as any,
    debugConsoleService: {
      // The prefilter crawl could not determine a country (empty), but the category is relevant.
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          country: "",
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.93,
          rationale: "fit"
        }
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => ({ selectedContacts: createContacts(company.name) })
    } as any,
    hubSpotClient: {
      // Deeper identity resolver finds the headquarters country from the website: outside the EU
      // market, so the company is screened out — but its location must still be recorded so the
      // Aussortiert entry shows where it is.
      resolveCompanyAddress: async () => {
        resolveCalls += 1;
        return { companyName: "Backfill Vision Inc", country: "United States" };
      },
      syncQualifiedCompanies: async () => {
        throw new Error("HubSpot sync should not run for an out-of-market company");
      }
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [createFilter("integrator_vision_industrial_ai")],
      isCompanyInExecutionScope: (company: { country?: string }) => {
        const country = (company.country ?? "").trim().toLowerCase();
        return country === "" || country === "germany";
      },
      discoverDirectExaCompaniesForExecution: async () => {
        exaCalls += 1;
        if (exaCalls > 1) {
          throw new Error("Exa search failed: 503 unavailable");
        }
        return [{
          name: "Backfill Vision",
          domain: "backfill-vision.com",
          country: "",
          shortDescription: "Industrial vision integrator",
          sourceFilter: "exa-filter"
        }];
      }
    } as any
  });

  await service.run({
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

  assert.ok(resolveCalls >= 1);
  const recordedCountry = screeningWrites
    .flatMap((database) => database.records)
    .find((record) => record.companyName === "Backfill Vision")?.country;
  assert.equal(recordedCountry, "United States");
});

test("worker run rejects a region-unverifiable target company at the AI gate before spending contact discovery", async () => {
  const contactCalls: string[] = [];
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
      // Prefilter crawl cannot determine a country; the domain is a neutral/global .com.
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => ({
        categorizedCompany: {
          ...company,
          country: "",
          category: "integrator_vision_industrial_ai",
          relevanceScore: 0.93,
          rationale: "fit"
        }
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => {
        contactCalls.push(company.name);
        return { selectedContacts: createContacts(company.name) };
      }
    } as any,
    hubSpotClient: {
      // The deeper identity resolver also cannot verify a country (timeout / blocked crawl).
      resolveCompanyAddress: async () => null,
      syncQualifiedCompanies: async () => {
        throw new Error("HubSpot sync should not run for a region-unverifiable company");
      }
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [createFilter("integrator_vision_industrial_ai")],
      // The scope check is fail-open for an empty country on a neutral TLD (locations all European),
      // so without the accept-gate trust requirement this company would proceed into contact
      // discovery and only be dropped at the write gate. The trust requirement must reject it first.
      isCompanyInExecutionScopeAsync: async () => true,
      discoverDirectExaCompaniesForExecution: async () => {
        exaCalls += 1;
        if (exaCalls > 1) {
          throw new Error("Exa search failed: 503 unavailable");
        }
        return [{
          name: "Neutral Vision",
          domain: "neutral-vision.com",
          country: "",
          shortDescription: "Industrial vision integrator",
          sourceFilter: "exa-filter"
        }];
      }
    } as any
  });

  const result = await service.run({
    targetLeadCount: 1,
    targetCategories: ["integrator_vision_industrial_ai"],
    companySearchMode: "exa_search",
    market: "Europe",
    syncToHubSpot: true,
    dryRun: false,
    reuseQualifiedCompanyCache: false,
    exaQueryCount: 1,
    maxRuntimeMs: 60_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  });

  // Rejected at the AI accept gate: no contact discovery spent, nothing written to HubSpot.
  assert.deepEqual(contactCalls, []);
  assert.equal(result.hubspotSync.companySyncedCount ?? 0, 0);
  assert.equal(result.shortlistedCompanies.length, 0);
});

test("worker run skips a company that already exists in HubSpot at the AI gate before spending contact discovery", async () => {
  const contactCalls: string[] = [];
  const existenceLookups: string[] = [];
  const classifyCalls: string[] = [];
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
      classifyCompanyForExecution: async (company: { name: string; domain?: string; shortDescription: string; sourceFilter: string }) => {
        classifyCalls.push(company.domain ?? company.name);
        return {
          categorizedCompany: {
            ...company,
            country: "Germany",
            category: "integrator_vision_industrial_ai",
            relevanceScore: 0.93,
            rationale: "fit"
          }
        };
      },
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async (company: { name: string }) => {
        contactCalls.push(company.name);
        return { selectedContacts: createContacts(company.name) };
      }
    } as any,
    hubSpotClient: {
      // The candidate's domain already exists in HubSpot: the live dedup lookup must report it so
      // the company is skipped at the AI gate before any contact discovery or write happens. The
      // worker uses companyExistsInHubSpot (findExistingCompany: every domain variant + brand-root
      // name search), the same matcher the pre-write writer uses, so a writer-side match is caught
      // at intake.
      companyExistsInHubSpot: async (company: { name: string; domain?: string }) => {
        existenceLookups.push(company.domain ?? company.name);
        return (company.domain ?? "") === "existing-vision.de";
      },
      resolveCompanyAddress: async () => null,
      syncQualifiedCompanies: async () => {
        throw new Error("HubSpot sync should not run for an already-existing company");
      }
    } as any,
    leadPipelineAgent: {
      buildDirectExaFiltersForExecution: () => [createFilter("integrator_vision_industrial_ai")],
      isCompanyInExecutionScopeAsync: async () => true,
      discoverDirectExaCompaniesForExecution: async () => {
        exaCalls += 1;
        if (exaCalls > 1) {
          throw new Error("Exa search failed: 503 unavailable");
        }
        return [{
          name: "Existing Vision",
          domain: "existing-vision.de",
          country: "Germany",
          shortDescription: "Industrial vision integrator",
          sourceFilter: "exa-filter"
        }];
      }
    } as any
  });

  const result = await service.run({
    targetLeadCount: 1,
    targetCategories: ["integrator_vision_industrial_ai"],
    companySearchMode: "exa_search",
    market: "Europe",
    syncToHubSpot: true,
    dryRun: false,
    reuseQualifiedCompanyCache: false,
    exaQueryCount: 1,
    maxRuntimeMs: 60_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  });

  // The dedup lookup ran on the candidate domain and matched the existing HubSpot company, so it
  // was filtered at the AI gate before classification: no category was determined, no contact
  // discovery spent, nothing written to HubSpot.
  assert.ok(existenceLookups.includes("existing-vision.de"));
  assert.deepEqual(classifyCalls, []);
  assert.deepEqual(contactCalls, []);
  assert.equal(result.hubspotSync.companySyncedCount ?? 0, 0);
  assert.equal(result.shortlistedCompanies.length, 0);
});

// --- Contact-discovery concurrency starvation (the measured Railway defect) -------------------
// Root cause: contact discovery is browser-bound. Every company's page collection runs through the
// shared Chromium, which serves only HUBSPOT_BROWSER_TASK_CONCURRENCY serial lanes. When the worker
// fanned out 4 contact discoveries onto 2 lanes, the 2 excess companies waited in the lane queue;
// that wait pushed their total past the 600s contact-task cap, so they were written with ZERO
// contacts even though their logic (proven by the curated repro) reaches every company's ceiling.

test("the shared browser scheduler never runs more concurrent tasks than it has lanes (starvation reproduction)", async () => {
  const client = new HubSpotClient();
  const lanes = HUBSPOT_BROWSER_TASK_CONCURRENCY;
  const callers = lanes + 2; // mirror the pre-fix 4-on-2 contact fan-out
  let active = 0;
  let maxActive = 0;
  const task = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
  };
  await Promise.all(
    Array.from({ length: callers }, () => (client as unknown as {
      scheduleBrowserTask<T>(t: () => Promise<T>): Promise<T>;
    }).scheduleBrowserTask(task))
  );
  // The real scheduler caps concurrent browser tasks at the lane count: any stage that fans out
  // MORE browser-bound work than there are lanes leaves the excess queued. Under a fixed per-task
  // budget (the 600s contact cap) that queue wait is exactly what stranded companies at 0 contacts.
  assert.equal(
    maxActive,
    lanes,
    `Expected the shared browser to run at most ${lanes} tasks at once, observed ${maxActive}.`
  );
});

test("resolveContactSearchConcurrency never schedules more browser-bound discoveries than browser lanes", () => {
  // The fix: the effective contact-discovery fan-out is capped to the Chromium lane count so every
  // in-flight discovery owns a lane and its page collection starts immediately (no queue wait, no
  // 600s-cap overrun). The hard ceiling and the request-supplied value still apply on top.
  const lanes = HUBSPOT_BROWSER_TASK_CONCURRENCY;

  // A request asking for the pre-fix 4 (or an absurd 200) is clamped to the lane count.
  assert.equal(resolveContactSearchConcurrency(4, lanes), Math.min(lanes, 4));
  assert.equal(resolveContactSearchConcurrency(200, lanes), lanes);
  assert.equal(resolveContactSearchConcurrency(undefined, lanes), Math.min(lanes, 3));
  // It never exceeds the lane count, never exceeds the hard ceiling, and never drops below 1.
  for (const requested of [undefined, 0, 1, 2, 3, 4, 50]) {
    const resolved = resolveContactSearchConcurrency(requested, lanes);
    assert.ok(resolved >= 1, `expected >= 1, got ${resolved}`);
    assert.ok(resolved <= lanes, `expected <= ${lanes} lanes, got ${resolved} for requested=${requested}`);
    assert.ok(resolved <= MAX_CONTACT_CONCURRENCY, `expected <= ${MAX_CONTACT_CONCURRENCY}, got ${resolved}`);
  }
  // Fewer lanes than requested -> lanes win; more lanes than requested -> request wins (still capped).
  assert.equal(resolveContactSearchConcurrency(1, 4), 1);
  assert.equal(resolveContactSearchConcurrency(3, 1), 1);
});

// End-to-end starvation reproduction: too many parallel "chromiums" (browser-bound contact
// discoveries) strand companies at ZERO contacts under a fixed per-company time cap; the fix
// (capping the contact fan-out to the browser lane count) brings every company in under budget.
//
// The lane behaviour of the REAL shared browser is proven structurally in the 'starvation
// reproduction' test above (it never runs more than `lanes` tasks at once). Here we model that same
// lane-limited scheduler deterministically (a plain semaphore, no Chromium launch overhead) so the
// cap-OVERRUN assertion is stable, while still driving the timing through the actual production
// resolveContactSearchConcurrency fix function. The cap timer starts when the worker pool PICKS THE
// COMPANY UP — exactly as the production 600s contact-task cap wraps discoverPublicContactsForExecution
// once the contact worker dequeues it — so a company picked up but then queued for a lane burns its
// cap while starved: the measured defect.
test("too many parallel browser-bound discoveries strand companies at zero contacts; the lane cap fixes it", async () => {
  const lanes = HUBSPOT_BROWSER_TASK_CONCURRENCY; // 2
  const companies = lanes + 2;                    // 4 -> the pre-fix 4-on-2 fan-out
  const pageCollectionMs = 200;                   // time a discovery holds a browser lane
  const perCompanyCapMs = 300;                    // < 2 * pageCollectionMs, so a queued company overruns

  function raceCap<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(fallback);
        }
      }, ms);
      if (typeof timer.unref === "function") timer.unref();
      const finish = (value: T) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      };
      p.then(finish, () => finish(fallback));
    });
  }

  // Deterministic model of the shared Chromium: exactly `lanes` serial lanes. A task that finds all
  // lanes busy waits in the queue until one is released — the same starvation the real scheduler
  // imposes (proven separately), but with no browser-launch jitter so the cap math is exact.
  function makeLaneScheduler(laneCount: number) {
    let active = 0;
    const queue: Array<() => void> = [];
    async function run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= laneCount) {
        await new Promise<void>((resolve) => queue.push(resolve));
      }
      active += 1;
      try {
        return await task();
      } finally {
        active -= 1;
        const next = queue.shift();
        if (next) next();
      }
    }
    return { run };
  }

  // One company's contact discovery: the cap timer starts NOW (pool pick-up), then it competes for a
  // browser lane and holds it for the page-collection time. Returns 1 contact on success, 0 on cap.
  async function discoverOne(scheduler: { run<T>(t: () => Promise<T>): Promise<T> }): Promise<number> {
    const work = scheduler.run(async () => {
      await new Promise((r) => setTimeout(r, pageCollectionMs));
      return 1;
    });
    return raceCap(work, perCompanyCapMs, 0);
  }

  // Bounded worker pool: at most `fanOut` companies are picked up at once (cap timer starts on pickup),
  // all sharing ONE lane-limited browser, exactly like the production contact worker.
  async function runAtFanOut(fanOut: number): Promise<number[]> {
    const scheduler = makeLaneScheduler(lanes);
    const results = new Array<number>(companies).fill(-1);
    let cursor = 0;
    const runners = Array.from({ length: Math.max(1, fanOut) }, async () => {
      while (cursor < companies) {
        const index = cursor;
        cursor += 1;
        results[index] = await discoverOne(scheduler);
      }
    });
    await Promise.all(runners);
    return results;
  }

  // Pre-fix fan-out: pick up all 4 at once. Only `lanes` get a lane immediately; the rest wait in the
  // lane queue while their cap ticks and overrun -> 0 contacts. This reproduces the Railway defect.
  const naive = await runAtFanOut(companies);
  const stranded = naive.filter((c) => c === 0).length;
  assert.ok(
    stranded > 0,
    `Reproduction failed: expected companies stranded at 0 contacts when fanning out ${companies} discoveries onto ${lanes} lanes, got [${naive.join(",")}].`
  );

  // Fixed fan-out: cap the browser-bound fan-out to the lane count. Every picked-up discovery owns a
  // lane immediately, so its page collection finishes inside the per-company cap -> nothing stranded.
  const fixedFanOut = resolveContactSearchConcurrency(companies, lanes);
  assert.equal(fixedFanOut, lanes, `fix should cap fan-out to ${lanes} lanes, got ${fixedFanOut}`);
  const fixed = await runAtFanOut(fixedFanOut);
  const strandedAfter = fixed.filter((c) => c === 0).length;
  assert.equal(
    strandedAfter,
    0,
    `After the lane cap no company should be stranded, but ${strandedAfter} got 0 contacts ([${fixed.join(",")}]).`
  );
});