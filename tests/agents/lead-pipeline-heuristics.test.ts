import test from "node:test";
import assert from "node:assert/strict";
import { LeadPipelineAgent } from "../../src/agents/lead-pipeline";
import { CompanySample, PreCategorizedCompany, ResearchBrief } from "../../src/types";

function applyIndustrialFit(
  company: CompanySample,
  categorization: Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale">
) {
  const agent = new LeadPipelineAgent();
  return agent["enforceIndustrialFit"](company, categorization) as Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale">;
}

test("industrial automation companies without explicit AI evidence are demoted from general_ai to relevant_focus", () => {
  const result = applyIndustrialFit(
    {
      name: "AZT",
      domain: "https://azt-a.ru",
      shortDescription: "delivery-led industrial automation and software integrator with real implementation ownership in PLC, SCADA and BMS",
      sourceFilter: "Germany filter"
    },
    {
      category: "integrator_general_ai",
      relevanceScore: 75,
      rationale: "Initial AI-heavy categorization"
    }
  );

  assert.equal(result.category, "integrator_relevant_focus");
  assert.match(result.rationale, /no explicit AI specialization/i);
});

test("vision only in the company name does not keep a generic software consultancy in an industrial vision bucket", () => {
  const result = applyIndustrialFit(
    {
      name: "Ivy Vision",
      domain: "https://ivyvision.com",
      shortDescription: "consulting services for application software developer, firmware developer, OS porting specialist, device driver and software architect support",
      sourceFilter: "Germany filter"
    },
    {
      category: "integrator_vision_industrial_ai",
      relevanceScore: 72,
      rationale: "Name contains vision"
    }
  );

  assert.equal(result.category, "other");
  assert.match(result.rationale, /broad software consulting|embedded engineering|lacks clear industrial|vision-delivery/i);
});

test("known camera manufacturers do not remain in integrator buckets", () => {
  const result = applyIndustrialFit(
    {
      name: "Basler",
      domain: "https://baslerweb.com",
      shortDescription: "Machine vision cameras, lenses and lighting portfolio for industrial imaging",
      sourceFilter: "Germany filter"
    },
    {
      category: "integrator_vision_industrial_ai",
      relevanceScore: 81,
      rationale: "Initial integrator guess"
    }
  );

  assert.equal(result.category, "camera_manufacturer_partner");
});

test("direct exa path keeps a machine-builder-compatible live filter without debug labels", () => {
  const agent = new LeadPipelineAgent() as any;

  const filter = agent.buildDirectExaSearchFilter(["machine_builder_ai_enablement", "integrator_general_ai"], "DE");

  assert.ok(filter.targetCategories?.includes("machine_builder_ai_enablement"));
  assert.deepEqual(filter.locations, ["Germany"]);
  assert.match(filter.name, /Machine Builders For AI Options/i);
  assert.doesNotMatch(filter.name, /\[debug/i);
});

test("stopped direct exa runs still sync already qualified companies", async () => {
  const agent = new LeadPipelineAgent() as any;
  let stopRequested = false;
  let syncCalls = 0;

  const qualifiedCompany = {
    name: "Robofunktion Vision GmbH",
    domain: "https://robofunktion.example",
    country: "Germany",
    shortDescription: "Machine vision integration for industrial customers.",
    sourceFilter: "Direct Exa filter",
    category: "integrator_vision_industrial_ai",
    relevanceScore: 91,
    rationale: "Strong delivery ownership for machine vision projects."
  } satisfies PreCategorizedCompany;

  const researchBrief: ResearchBrief = {
    companyName: qualifiedCompany.name,
    overview: "Overview",
    qualificationSummary: "Strong fit.",
    qualifyingSignals: ["Machine vision"],
    riskFlags: [],
    likelyGermanSpeaking: true,
    outreachLanguage: "de",
    rankings: {
      customer: 3,
      serviceProvider: 9,
      partner: 7
    },
    businessPotentialEUR: 18000,
    businessPotentialReasoning: "Good fit.",
    targetIndustry: "INDUSTRIAL_AUTOMATION",
    productsOffered: "Machine vision integration",
    recommendedTemplateKey: "integrator_vision_industrial_ai",
    personalizationRule: "Mention machine vision delivery.",
    linkedInAngle: "Partner fit",
    emailAngle: "Machine vision delivery",
    phoneAngle: "Partnership",
    linkedInMessage: "Hallo [Name], kurze Frage zu Ihren Vision-Projekten.",
    emailSubject: "Vision AI fuer Integratoren",
    emailBody: "Hallo [Name], wir helfen Integratoren Vision-AI schneller produktiv zu machen.",
    phoneScript: "Hallo [Name], ich wollte kurz zu Vision-AI-Projekten sprechen."
  };

  agent.preloadKnownHubSpotDomains = async () => {};
  agent.buildDirectExaSearchFilters = () => [{
    name: "Germany Vision Integrators [debug Germany]",
    persona: "Integrator",
    industries: ["Industrial Automation"],
    keywords: ["machine vision integrator"],
    locations: ["Germany"],
    employeeRanges: ["11,50"],
    targetCategories: ["integrator_vision_industrial_ai"],
    notes: "debug"
  }];
  agent.runDirectExaCompanySearch = async () => [{
    name: qualifiedCompany.name,
    domain: qualifiedCompany.domain,
    country: qualifiedCompany.country,
    shortDescription: qualifiedCompany.shortDescription,
    sourceFilter: qualifiedCompany.sourceFilter,
    discoveryQuery: "robofunktion vision"
  }];
  agent.categorizeCompanies = async () => [qualifiedCompany];
  agent.controlPlaneStore.getLearning = async () => ({ filterPerformance: {}, searchHistory: [], modes: {} });
  agent.controlPlaneStore.getCompanyScreeningDatabase = async () => ({ records: [] });
  agent.controlPlaneStore.getLiveExaCache = async () => ({ entries: [], discoveredDomains: [] });
  agent.controlPlaneStore.recordLiveExaRawResults = async () => ({ entries: [], discoveredDomains: [] });
  agent.controlPlaneStore.writeCompanyScreeningDatabase = async () => {};
  agent.controlPlaneStore.recordFilterEvaluations = async () => {};
  agent.controlPlaneStore.recordSearchHistory = async () => {};
  agent.controlPlaneStore.writeLatestLeadRun = async () => {};
  agent.azureClient.buildResearchBrief = async () => researchBrief;
  agent.collectPublicContacts = async () => new Map([["robofunktion.example", [{
    email: "info@robofunktion.example",
    phone: "+49 30 123456",
    sourceUrl: qualifiedCompany.domain,
    label: "public_generic_mailbox",
    jobTitle: "General contact"
  }]]]);
  agent.collectApolloContacts = async () => {
    stopRequested = true;
    return new Map();
  };
  agent.hubspotClient.syncQualifiedCompanies = async (companies: PreCategorizedCompany[]) => {
    syncCalls += 1;
    assert.equal(companies.length, 1);
    assert.equal(companies[0]?.name, qualifiedCompany.name);

    return {
      attempted: true,
      mode: "live",
      candidateCount: 1,
      syncedCount: 2,
      companySyncedCount: 1,
      contactSyncedCount: 1,
      successfulCompanyKeys: ["robofunktion.example"],
      failedCompanyKeys: [],
      errors: []
    };
  };

  const result = await agent.run({
    targetLeadCount: 1,
    market: "Germany",
    companySearchMode: "exa_search",
    targetCategories: ["integrator_vision_industrial_ai"],
    dryRun: false,
    syncToHubSpot: true,
    exaQueryCount: 1,
    maxRuntimeMs: 60000
  }, {
    shouldStop: () => stopRequested
  });

  assert.equal(syncCalls, 1);
  assert.equal(result.stopped, true);
  assert.equal(result.hubspotSync.companySyncedCount, 1);
  assert.equal(result.hubspotSync.contactSyncedCount, 1);
});

test("direct exa exclude prioritization keeps hubspot, matching rejected websites, and current-run domains deduped inside the 1200-domain limit", () => {
  const agent = new LeadPipelineAgent() as any;
  const hubSpotDomains = Array.from({ length: 1300 }, (_, index) => `hubspot-${index}.example${index}.com`);
  hubSpotDomains.push("relevant-hubspot.test", "duplicate.test");

  const prioritized = agent.buildPrioritizedDirectExaExcludedDomains(
    {
      records: [
        {
          companyName: "Live Rejected",
          normalizedName: "live rejected",
          normalizedDomain: "live-rejected.test",
          existsInHubSpot: false,
          category: "other",
          sourceFilter: "Germany vision integrators"
        },
        {
          companyName: "Debug Rejected",
          normalizedName: "debug rejected",
          normalizedDomain: "debug-rejected.test",
          existsInHubSpot: false,
          category: "other",
          sourceFilter: "manual-debug-input"
        },
        {
          companyName: "Already Matching Target",
          normalizedName: "already matching target",
          normalizedDomain: "matching-target.test",
          existsInHubSpot: false,
          category: "integrator_vision_industrial_ai",
          sourceFilter: "Germany vision integrators"
        }
      ]
    },
    ["integrator_vision_industrial_ai"],
    hubSpotDomains,
    {
      screeningScope: "live",
      currentRunExcludedDomains: ["same-run-1.test", "duplicate.test", "same-run-2.test"]
    }
  );

  const requestPayloadDomains = prioritized.requestExcludedDomains.slice(-1200);

  assert.equal(prioritized.localExcludedDomains.has("same-run-1.test"), true);
  assert.equal(prioritized.localExcludedDomains.has("relevant-hubspot.test"), true);
  assert.equal(prioritized.localExcludedDomains.has("live-rejected.test"), true);
  assert.equal(prioritized.localExcludedDomains.has("debug-rejected.test"), false);
  assert.equal(prioritized.localExcludedDomains.has("matching-target.test"), false);
  assert.equal(requestPayloadDomains.includes("same-run-1.test"), true);
  assert.equal(requestPayloadDomains.includes("same-run-2.test"), true);
  assert.equal(requestPayloadDomains.includes("relevant-hubspot.test"), true);
  assert.equal(requestPayloadDomains.includes("live-rejected.test"), true);
  assert.equal(requestPayloadDomains.includes("debug-rejected.test"), false);
  assert.equal(requestPayloadDomains.includes("duplicate.test"), true);
  assert.equal(requestPayloadDomains.filter((domain) => domain === "duplicate.test").length, 1);
  assert.equal(requestPayloadDomains.includes("hubspot-0.example0.com"), false);
});

