import test from "node:test";
import assert from "node:assert/strict";
import { LeadWorkerRunService } from "../../src/agents/lead-worker-run";
import type { ApolloOrganizationFilter, CompanyScreeningDatabase, LeadCategory, PublicContactCandidate, ResearchBrief } from "../../src/types";

function createFilter(category: LeadCategory): ApolloOrganizationFilter {
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
    maxRuntimeMs: 60_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  });

  assert.equal(exaCalls, 0);
  assert.equal(result.hubspotSync.companySyncedCount, 1);
  assert.equal(result.shortlistedCompanies.length, 1);
  assert.equal(result.shortlistedCompanies[0]?.name, "Seed Vision");
  assert.ok(screeningWrites.length > 0);
  assert.equal(latestRunWrites.at(-1)?.summary?.foundCandidates, 1);
});

test("worker run promotes standby AI matches when the active company fails downstream", async () => {
  const syncedCompanies: string[] = [];
  let exaCalls = 0;

  const service = new LeadWorkerRunService({
    controlPlaneStore: {
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

test("worker run times out a stuck contact task and still finishes the run", async () => {
  const syncedCompanies: string[] = [];

  const service = new LeadWorkerRunService({
    contactTaskTimeoutMs: 25,
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
      createManualCompanyForWebsite: (website: string, filter: ApolloOrganizationFilter) => ({
        name: "Timeout Vision",
        domain: website,
        shortDescription: "Timeout company",
        sourceFilter: filter.name
      }),
      buildResearchBriefForExecution: async (company: { name: string }) => createResearchBrief(company.name),
      discoverContactsForExecution: async () => new Promise(() => undefined)
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
    maxRuntimeMs: 60_000,
    aiPrefilterConcurrency: 1,
    outreachPrepConcurrency: 1,
    contactSearchConcurrency: 1
  });

  assert.deepEqual(syncedCompanies, ["Timeout Vision"]);
  assert.equal(result.hubspotSync.companySyncedCount, 1);
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
      createManualCompanyForWebsite: (website: string, filter: ApolloOrganizationFilter) => ({
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