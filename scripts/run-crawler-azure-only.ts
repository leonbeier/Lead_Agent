import { LeadPipelineAgent } from "../src/agents/lead-pipeline";
import type { CompanyResearchBrief, LeadJobResult } from "../src/types";

const originalFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

  if (/api\.openai\.com/i.test(url)) {
    throw new Error(`OpenAI web search is blocked in crawler+Azure-only validation: ${url}`);
  }

  if (/api\.apollo\.io/i.test(url)) {
    throw new Error(`Apollo requests are blocked in crawler+Azure-only validation: ${url}`);
  }

  return originalFetch(input, init);
};

const buildStubBrief = (company: { name: string; rationale?: string }): CompanyResearchBrief => ({
  companyName: company.name,
  overview: "",
  qualificationSummary: company.rationale ?? "",
  qualifyingSignals: [],
  riskFlags: [],
  likelyGermanSpeaking: true,
  outreachLanguage: "de",
  rankings: { customer: 0, serviceProvider: 0, partner: 0 },
  businessPotentialEUR: 0,
  businessPotentialReasoning: "",
  targetIndustry: "",
  productsOffered: "",
  recommendedTemplateKey: "integrator_general_ai_template",
  personalizationRule: "",
  linkedInAngle: "",
  emailAngle: "",
  phoneAngle: "",
  linkedInMessage: "",
  emailSubject: "",
  emailBody: "",
  phoneScript: ""
});

const summarize = (result: LeadJobResult) => ({
  found: result.shortlistedCompanies.length,
  filters: result.evaluations.slice(0, 12).map((evaluation) => ({
    name: evaluation.filterName,
    reviewed: evaluation.totalReviewed,
    relevant: evaluation.relevantCount,
    ratio: Number(evaluation.relevanceRatio.toFixed(2)),
    stopped: evaluation.stoppedEarly
  })),
  companies: result.shortlistedCompanies.slice(0, 20).map((company) => ({
    name: company.name,
    domain: company.domain,
    category: company.category,
    relevanceScore: company.relevanceScore,
    sourceFilter: company.sourceFilter,
    rationale: company.rationale,
    shortDescription: company.shortDescription
  }))
});

async function main() {
  const agent = new LeadPipelineAgent() as LeadPipelineAgent & {
    azureClient: { buildResearchBrief: (company: { name: string; rationale?: string }) => Promise<CompanyResearchBrief> };
    collectPublicContacts: () => Promise<Map<string, never[]>>;
    collectApolloContacts: () => Promise<Map<string, never[]>>;
    hubspotClient: {
      syncQualifiedCompanies: (companies: unknown[]) => Promise<{
        attempted: boolean;
        mode: string;
        candidateCount: number;
        syncedCount: number;
        companySyncedCount: number;
        contactSyncedCount: number;
        errors: string[];
      }>;
    };
  };

  agent.azureClient.buildResearchBrief = async (company) => buildStubBrief(company);
  agent.collectPublicContacts = async () => new Map();
  agent.collectApolloContacts = async () => new Map();
  agent.hubspotClient.syncQualifiedCompanies = async (companies) => ({
    attempted: false,
    mode: "dry-run",
    candidateCount: companies.length,
    syncedCount: 0,
    companySyncedCount: 0,
    contactSyncedCount: 0,
    errors: []
  });

  const result = await agent.run({
    targetLeadCount: 15,
    market: "DE",
    targetCategories: ["integrator_vision_industrial_ai", "integrator_general_ai", "integrator_relevant_focus"],
    companySearchMode: "internet_research",
    creditLessMode: true,
    runDeepResearch: false,
    dryRun: false,
    syncToHubSpot: false,
    disableHubSpotDeduplication: true,
    earlyStopEnabled: true,
    earlyStopReviewCount: 8,
    earlyStopThreshold: 0.15,
    prequalification: {
      mainContext:
        "For this run, qualify conservatively for German delivery-led software and automation service providers. Prefer implementation ownership, recurring customer projects, industrial relevance, and credible Vision AI / Industrial AI potential. Downgrade product-centric AI platform vendors, pure consultancies, and weak-fit generic AI branding.",
      categoryContexts: {}
    },
    mainContext: "",
    searchStrategyContext:
      "Run a crawler-first Germany search for delivery-led software and automation service providers. Use DuckDuckGo result pages plus official company sites and crawled internal pages such as About, Services, Solutions, Products, Applications, and Industry pages. Only keep firms whose own website suggests system integration, software implementation, automation engineering, machine vision delivery, industrial software projects, AOI, inline inspection, OT/MES/SCADA/PLC integration, or similar recurring customer project ownership. Avoid directories, marketplaces, publishers, media, events, associations, universities, investors, recruiters, hardware-only vendors, OEM product brands, and generic consultancies."
  });

  process.stdout.write(`${JSON.stringify(summarize(result), null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});