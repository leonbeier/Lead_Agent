import dns from "node:dns";
import { LeadPipelineAgent } from "../src/agents/lead-pipeline";
import { LeadRunProgress } from "../src/types";

dns.setDefaultResultOrder("ipv4first");

const targetLeadCount = Number(process.env.LEAD_RUN_TARGET_COUNT ?? "200");
const maxRuntimeMs = Number(process.env.LEAD_RUN_MAX_RUNTIME_MS ?? String(3 * 60 * 60 * 1000));
const exaApiKey = process.env.EXA_API_KEY?.trim();

if (!exaApiKey) {
  throw new Error("EXA_API_KEY is required.");
}

function summarizeProgress(progress: LeadRunProgress): string {
  const percentage = progress.progressMax > 0
    ? `${Math.round((progress.progressValue / progress.progressMax) * 100)}%`
    : `${progress.progressValue}`;
  const filterPart = progress.totalFilters
    ? ` | Filter ${progress.processedFilters ?? 0}/${progress.totalFilters}`
    : "";
  const candidatePart = typeof progress.foundCandidates === "number"
    ? ` | Kandidaten ${progress.foundCandidates}/${progress.targetLeadCount ?? "?"}`
    : "";
  const funnelPart = progress.funnel
    ? ` | Crawl ${progress.funnel.crawledPages} | Vorfilter ${progress.funnel.afterCrawlerPrefilter} | HubSpot-Dedup ${progress.funnel.afterHubSpotDedup} | Azure ${progress.funnel.afterAzureAICheck} | Sync ${progress.funnel.syncedToHubSpot}`
    : "";
  const detailPart = progress.detail ? ` | ${progress.detail}` : "";

  return `[${new Date().toLocaleTimeString("de-DE", { hour12: false })}] ${progress.stageLabel} | ${percentage} | ${progress.progressDescription}${filterPart}${candidatePart}${funnelPart}${detailPart}`;
}

async function main() {
  const agent = new LeadPipelineAgent();

  const result = await agent.run({
    targetLeadCount,
    market: "EU",
    targetCategories: [
      "integrator_vision_industrial_ai",
      "integrator_general_ai",
      "integrator_relevant_focus"
    ],
    companySearchMode: "exa_search",
    creditLessMode: true,
    dryRun: false,
    syncToHubSpot: true,
    exaApiKey,
    runDeepResearch: true,
    searchStrategyPreset: "optimized_vision_integrators",
    earlyStopEnabled: true,
    earlyStopReviewCount: 30,
    earlyStopThreshold: 0.15,
    earlyStopMinRelevantCount: 2,
    maxRuntimeMs,
    prequalification: {
      mainContext:
        "Qualify conservatively for Europe-first delivery-led software and automation providers. Prefer implementation ownership, industrial relevance, and plausible Vision AI / Industrial AI potential. Allow consulting firms with clear hands-on delivery ownership, but exclude freelancer and solo-specialist profiles. Reject generic consultancies, media, HMI-only engineering, tool vendors, and non-industrial product companies.",
      categoryContexts: {}
    },
    mainContext: "",
    searchStrategyContext:
      "Run the Exa company discovery path in a Europe-first setup. Maximize useful company recall for Vision/Industrial AI integrators and adjacent industrial software, automation, MES, SCADA, PLC, OT-integration, smart-factory, and embedded engineering service providers with visible delivery ownership. Prefer official company websites and company pages over directories, avoid generic listing pages and duplicates, and keep Exa spend efficient. If evidence is weak, do not force qualification; if evidence is strong, push directly through the full research, contact, and HubSpot sync path."
  }, {
    onProgress: (progress) => {
      console.log(summarizeProgress(progress));
    }
  });

  console.log(JSON.stringify({
    foundCandidates: result.shortlistedCompanies.length,
    syncedToHubSpot: result.hubspotSync.companySyncedCount,
    contactSyncedCount: result.hubspotSync.contactSyncedCount,
    funnel: result.funnel,
    timedOut: result.timedOut,
    errors: result.hubspotSync.errors
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});