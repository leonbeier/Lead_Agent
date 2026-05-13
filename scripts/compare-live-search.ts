import { LeadPipelineAgent } from "../src/agents/lead-pipeline";
import type { CompanyResearchBrief, LeadJobResult } from "../src/types";

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

console.log = () => undefined;
console.info = () => undefined;

const summarize = (label: string, result: LeadJobResult) => ({
  label,
  found: result.shortlistedCompanies.length,
  filters: result.evaluations.slice(0, 8).map((evaluation) => ({
    name: evaluation.filterName,
    reviewed: evaluation.totalReviewed,
    relevant: evaluation.relevantCount,
    ratio: Number(evaluation.relevanceRatio.toFixed(2)),
    stopped: evaluation.stoppedEarly
  })),
  companies: result.shortlistedCompanies.slice(0, 12).map((company) => ({
    name: company.name,
    domain: company.domain,
    category: company.category,
    sourceFilter: company.sourceFilter
  }))
});

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

const baseRequest = {
  targetLeadCount: 8,
  market: "DE",
  targetCategories: ["integrator_vision_industrial_ai", "integrator_general_ai", "integrator_relevant_focus"],
  companySearchMode: "internet_research",
  creditLessMode: true,
  runDeepResearch: false,
  dryRun: false,
  syncToHubSpot: false,
  earlyStopEnabled: true,
  earlyStopReviewCount: 8,
  earlyStopThreshold: 0.4,
  prequalification: {
    mainContext:
      "For this run, qualify conservatively for German delivery-led software and automation service providers. Prefer implementation ownership, recurring customer projects, industrial relevance, and credible Vision AI / Industrial AI potential. Downgrade product-centric AI platform vendors, pure consultancies, and weak-fit generic AI branding.",
    categoryContexts: {}
  },
  mainContext: "",
  searchStrategyContext:
    "You are steering a Germany-first campaign for ONE WARE focused on software service providers and system integrators. Priority for this run: Find German software integrators, automation integrators, embedded/industrial software service providers, and technical project-delivery firms. Search across official company websites, trade fair exhibitor lists, expo catalogs, industry directories, technical magazine coverage, and customer case studies, but return only real company sites. Strongest fit is explicit Vision AI, Industrial AI, image processing, industrial automation, robotics, inspection, surveillance, medtech imaging, or similar project delivery. Also accept firms with broader AI messaging only when they clearly deliver customer projects and a future Vision AI / Industrial AI path is plausible. Prefer companies similar in spirit to delivery-led firms like Gestalt Automation or Strategion: service-heavy, project-led, implementation-oriented. Avoid for this run: Own AI platform vendors or software products that make ONE WARE look like a direct competitor. Pure consultancies, strategy firms, recruiting, finance, investors, resellers, distributors, and generic SaaS without delivery ownership. Non-German companies unless an unusually strong German delivery footprint is visible. Filter-building rules: Build concrete search variants that can find implementation companies, not just companies that mention AI somewhere. Prefer realistic industries and keywords for software service providers, automation, embedded, machine vision, industrial software, and system integration. If a filter would likely pull too many product vendors or generic consultants, tighten it."
} as const;

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

  const normal = await agent.run(baseRequest);
  const noDedup = await agent.run({ ...baseRequest, disableHubSpotDeduplication: true });

  console.log(
    JSON.stringify(
      {
        normal: summarize("normal", normal),
        noDedup: summarize("noDedup", noDedup)
      },
      null,
      2
    )
  );

  originalStdoutWrite(
    `${JSON.stringify(
      {
        normal: summarize("normal", normal),
        noDedup: summarize("noDedup", noDedup)
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  originalStderrWrite(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
