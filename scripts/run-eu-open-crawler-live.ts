import { LeadPipelineAgent } from "../src/agents/lead-pipeline";
import { ControlPlaneStore } from "../src/control-plane";
import { resolveSearchStrategyPresetContext } from "../src/search-presets";
import { LeadJobRequest, LeadRunProgress } from "../src/types";

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

async function buildRequest(): Promise<LeadJobRequest> {
  const controlPlaneStore = new ControlPlaneStore();
  const settings = await controlPlaneStore.getSettings();
  const preset = "optimized_vision_integrators" as const;
  const configuredTargetLeadCount = Math.max(60, Number(process.env.LEAD_RUN_TARGET ?? "100"));

  return {
    ...settings,
    targetLeadCount: configuredTargetLeadCount,
    market: "EU",
    targetCategories: [
      "integrator_vision_industrial_ai",
      "integrator_general_ai",
      "integrator_relevant_focus"
    ],
    companySearchMode: "open_crawler_search",
    creditLessMode: true,
    dryRun: false,
    syncToHubSpot: true,
    runDeepResearch: true,
    searchStrategyPreset: preset,
    searchStrategyContext: resolveSearchStrategyPresetContext(preset) ?? settings.searchStrategyContext,
    maxRuntimeMs: 3 * 60 * 60 * 1000
  };
}

async function main(): Promise<void> {
  const agent = new LeadPipelineAgent();
  const request = await buildRequest();
  let lastFingerprint = "";

  const result = await agent.run(request, {
    onProgress: (progress) => {
      const fingerprint = JSON.stringify({
        stage: progress.stage,
        progressValue: progress.progressValue,
        progressDescription: progress.progressDescription,
        detail: progress.detail,
        processedFilters: progress.processedFilters,
        totalFilters: progress.totalFilters,
        foundCandidates: progress.foundCandidates,
        funnel: progress.funnel,
        updatedAt: progress.updatedAt,
        timedOut: progress.timedOut
      });

      if (fingerprint === lastFingerprint) {
        return;
      }

      lastFingerprint = fingerprint;
      console.log(summarizeProgress(progress));
    }
  });

  console.log("FINAL_RESULT_START");
  console.log(JSON.stringify({
    timedOut: result.timedOut ?? false,
    funnel: result.funnel,
    shortlistedCount: result.shortlistedCompanies.length,
    hubspotSync: result.hubspotSync,
    shortlistedCompanies: result.shortlistedCompanies.map((company) => ({
      name: company.name,
      domain: company.domain,
      category: company.category,
      relevanceScore: company.relevanceScore
    }))
  }, null, 2));
  console.log("FINAL_RESULT_END");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});