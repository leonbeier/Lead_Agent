import { performance } from "node:perf_hooks";

import { DebugConsoleService } from "../src/debug/test-console-service";
import { buildDebugSearchFilter } from "../src/debug/test-console";
import { PublicContactCandidate, SelectableLeadCategory } from "../src/types";

const websites = [
  "https://senswork.com/en",
  "https://www.visuelle-technik.de",
  "https://visotect.de",
  "https://www.kaiser-vision.de/en",
  "https://peak.vision/start/leistungen"
];

const targetCategory: SelectableLeadCategory = "integrator_vision_industrial_ai";
const targetCategories: SelectableLeadCategory[] = [
  "integrator_vision_industrial_ai",
  "integrator_vision_ai_consulting",
  "integrator_vision_ai_freelancer",
  "integrator_general_ai"
];

type StageName = "ai_prefilter" | "outreach_prep" | "contact_discovery";

type BenchmarkSummary = {
  stage: StageName;
  variant: "current" | "parallel_alternative";
  elapsedMs: number;
  normalizedResult: unknown;
};

const baseRequest = {
  targetCategory,
  targetCategories,
  region: "DE",
  companySearchMode: "exa_search" as const,
  limit: websites.length,
  websites
};

function normalizeDomain(url?: string): string {
  return (url ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");
}

function contactKey(contact: PublicContactCandidate): string {
  return [
    contact.firstName?.trim().toLowerCase(),
    contact.lastName?.trim().toLowerCase(),
    contact.email?.trim().toLowerCase(),
    contact.phone?.trim(),
    contact.linkedinUrl?.trim().toLowerCase(),
    contact.label.trim().toLowerCase()
  ].filter(Boolean).join("::");
}

function normalizeAiResult(result: any) {
  return (result.aiPrefilter?.analyzedWebsites ?? [])
    .map((entry: any) => ({
      domain: normalizeDomain(entry.company?.domain),
      category: entry.categorizedCompany?.category,
      hasError: Boolean(entry.error)
    }))
    .sort((left: any, right: any) => left.domain.localeCompare(right.domain));
}

function normalizeOutreachResult(result: any) {
  return (result.outreachPrep?.analyzedWebsites ?? [])
    .map((entry: any) => ({
      domain: normalizeDomain(entry.company?.domain),
      category: entry.categorizedCompany?.category,
      hasError: Boolean(entry.error),
      hasResearchBrief: Boolean(entry.researchBrief),
      previewContactCount: entry.hubspotPreview?.contacts?.length ?? 0
    }))
    .sort((left: any, right: any) => left.domain.localeCompare(right.domain));
}

function normalizeContactResult(result: any) {
  return (result.contactDiscovery?.analyzedWebsites ?? [])
    .map((entry: any) => ({
      domain: normalizeDomain(entry.company?.domain),
      category: entry.categorizedCompany?.category,
      hasError: Boolean(entry.error),
      selectedContacts: (entry.publicContactDebug?.selectedContacts ?? [])
        .map((contact: PublicContactCandidate) => contactKey(contact))
        .sort()
    }))
    .sort((left: any, right: any) => left.domain.localeCompare(right.domain));
}

async function measure<T>(fn: () => Promise<T>): Promise<{ elapsedMs: number; value: T }> {
  const startedAt = performance.now();
  const value = await fn();
  return {
    elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
    value
  };
}

async function runCurrentStage(stage: StageName): Promise<BenchmarkSummary> {
  const service = new DebugConsoleService();
  const { elapsedMs, value } = await measure(() => service.run({
    ...baseRequest,
    stage
  }));

  return {
    stage,
    variant: "current",
    elapsedMs,
    normalizedResult: stage === "ai_prefilter"
      ? normalizeAiResult(value)
      : stage === "outreach_prep"
        ? normalizeOutreachResult(value)
        : normalizeContactResult(value)
  };
}

async function runParallelAlternative(stage: StageName): Promise<BenchmarkSummary> {
  const service = new DebugConsoleService() as any;
  const filter = buildDebugSearchFilter(targetCategory, "DE");
  const companies = service.buildWebsiteCompanies(baseRequest, filter);

  const { elapsedMs, value } = await measure(async () => {
    if (stage === "ai_prefilter") {
      const analyzedWebsites = await Promise.all(companies.map((company: any) => service.classifyWebsite(company)));
      return { aiPrefilter: { analyzedWebsites } };
    }

    if (stage === "outreach_prep") {
      const analyzedWebsites = await Promise.all(companies.map(async (company: any) => {
        const baseAnalysis = await service.classifyWebsite(company);
        if (baseAnalysis.error) {
          return {
            ...baseAnalysis,
            researchBrief: null,
            hubspotPreview: null
          };
        }

        const researchBrief = await service.azureOpenAIClient.buildResearchBrief(baseAnalysis.categorizedCompany, false, undefined, undefined, {
          includeWebResearch: true
        });
        const hubspotPreview = await service.hubspotClient.previewHubSpotSync(baseAnalysis.categorizedCompany, researchBrief, [], {
          includeAddressLookup: true
        });

        return {
          ...baseAnalysis,
          researchBrief: service.toResearchBriefPreview(researchBrief),
          hubspotPreview
        };
      }));

      return { outreachPrep: { analyzedWebsites } };
    }

    const analyzedWebsites = await Promise.all(companies.map(async (company: any) => {
      const baseAnalysis = await service.classifyWebsite(company);
      if (baseAnalysis.error) {
        return {
          ...baseAnalysis,
          researchBrief: null,
          hubspotPreview: null,
          publicContactDebug: null
        };
      }

      const [researchBrief, publicContactDebug] = await Promise.all([
        service.azureOpenAIClient.buildResearchBrief(baseAnalysis.categorizedCompany, false, undefined, undefined, {
          includeWebResearch: true
        }),
        service.withTimeout(
          service.buildDetailedContactDebug(baseAnalysis.categorizedCompany),
          90_000,
          `Kontakt-Check hat nach 90s das Zeitlimit erreicht.`
        )
      ]);

      const hubspotPreview = await service.hubspotClient.previewHubSpotSync(
        baseAnalysis.categorizedCompany,
        researchBrief,
        publicContactDebug.selectedContacts,
        { includeAddressLookup: true }
      );

      return {
        ...baseAnalysis,
        researchBrief: service.toResearchBriefPreview(researchBrief),
        hubspotPreview,
        publicContactDebug
      };
    }));

    return { contactDiscovery: { analyzedWebsites } };
  });

  return {
    stage,
    variant: "parallel_alternative",
    elapsedMs,
    normalizedResult: stage === "ai_prefilter"
      ? normalizeAiResult(value)
      : stage === "outreach_prep"
        ? normalizeOutreachResult(value)
        : normalizeContactResult(value)
  };
}

async function main() {
  const summaries: BenchmarkSummary[] = [];

  for (const stage of ["ai_prefilter", "outreach_prep", "contact_discovery"] as const) {
    const current = await runCurrentStage(stage);
    const parallelAlternative = await runParallelAlternative(stage);
    summaries.push(current, parallelAlternative);
  }

  const comparison = ["ai_prefilter", "outreach_prep", "contact_discovery"].map((stage) => {
    const current = summaries.find((entry) => entry.stage === stage && entry.variant === "current");
    const alternative = summaries.find((entry) => entry.stage === stage && entry.variant === "parallel_alternative");
    return {
      stage,
      currentMs: current?.elapsedMs,
      parallelAlternativeMs: alternative?.elapsedMs,
      sameNormalizedResult: JSON.stringify(current?.normalizedResult) === JSON.stringify(alternative?.normalizedResult)
    };
  });

  console.log(JSON.stringify({
    websites,
    summaries,
    comparison
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});