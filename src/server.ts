import express from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { env, readiness } from "./config";
import { ControlPlaneStore, getLeadAgentRuntimeDataDirectory } from "./control-plane";
import { DebugConsoleService } from "./debug/test-console-service";
import { defaultFilters } from "./filters";
import { LeadPipelineAgent } from "./agents/lead-pipeline";
import { LeadWorkerRunService } from "./agents/lead-worker-run";
import { CATEGORY_EXECUTION_CONTEXT } from "./prompting/one-ware-playbook";
import { resolveSearchStrategyPresetContext } from "./search-presets";
import { LeadRunProgress } from "./types";

const app = express();

type LeadRunStatus = LeadRunProgress & {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
  runVariant?: "legacy" | "worker_v2";
  workerMetrics?: unknown;
  debugMessages?: string[];
  errorMessages?: string[];
};

const STALE_LEAD_RUN_THRESHOLD_MS = 90_000;
const DEBUG_CONSOLE_TIMEOUT_MS = 290_000;

const leadRunStatus: LeadRunStatus = {
  running: false,
  stage: "idle",
  stageLabel: "Bereit",
  progressValue: 0,
  progressMax: 100,
  progressDescription: "Noch kein aktiver Lead-Run.",
  updatedAt: new Date(0).toISOString()
};
const leadPipelineAgent = new LeadPipelineAgent();
const leadWorkerRunService = new LeadWorkerRunService();
const controlPlaneStore = new ControlPlaneStore();
const debugConsoleService = new DebugConsoleService();
let activeLeadRunAbortController: AbortController | undefined;
const hubSpotConsolePath = path.join(process.cwd(), "public", "hubspot-ui", "index.html");
const publicRoutes = new Set(["/health", "/oauth-callback"]);

export function shouldUseCachedLiveSearchDebug(statusUpdatedAt: string | undefined, latestQueryRunTimestamp: string | undefined): boolean {
  const statusUpdatedAtMs = Date.parse(statusUpdatedAt || "");
  const latestQueryRunMs = Date.parse(latestQueryRunTimestamp || "");

  if (!Number.isFinite(latestQueryRunMs)) {
    return false;
  }

  if (!Number.isFinite(statusUpdatedAtMs)) {
    return true;
  }

  return latestQueryRunMs > statusUpdatedAtMs;
}

function resetLeadRunStatus(detail: string, stage: LeadRunStatus["stage"] = "idle", stageLabel = "Bereit"): void {
  leadRunStatus.running = false;
  leadRunStatus.stage = stage;
  leadRunStatus.stageLabel = stageLabel;
  leadRunStatus.progressValue = 0;
  leadRunStatus.progressMax = 100;
  leadRunStatus.progressDescription = "Noch kein aktiver Lead-Run.";
  leadRunStatus.detail = detail;
  leadRunStatus.processedFilters = 0;
  leadRunStatus.totalFilters = undefined;
  leadRunStatus.foundCandidates = 0;
  leadRunStatus.targetLeadCount = undefined;
  leadRunStatus.aiPrefilterConcurrency = undefined;
  leadRunStatus.outreachPrepConcurrency = undefined;
  leadRunStatus.contactSearchConcurrency = undefined;
  leadRunStatus.exaQueryCount = undefined;
  leadRunStatus.funnel = undefined;
  leadRunStatus.timedOut = false;
  leadRunStatus.lastError = undefined;
  leadRunStatus.runVariant = undefined;
  leadRunStatus.workerMetrics = undefined;
  leadRunStatus.liveSearchDebug = undefined;
  leadRunStatus.debugMessages = undefined;
  leadRunStatus.errorMessages = undefined;
  leadRunStatus.startedAt = undefined;
  leadRunStatus.finishedAt = new Date().toISOString();
  leadRunStatus.updatedAt = new Date().toISOString();
}

function applyLeadRunProgress(progress: LeadRunProgress & { runVariant?: "legacy" | "worker_v2"; workerMetrics?: unknown; debugMessages?: string[]; errorMessages?: string[] }, stopRequested: boolean): void {
  if (stopRequested) {
    leadRunStatus.stage = "stopping";
    leadRunStatus.stageLabel = "Wird gestoppt";
    leadRunStatus.progressValue = Math.max(leadRunStatus.progressValue ?? 0, progress.progressValue);
    leadRunStatus.progressMax = progress.progressMax;
    leadRunStatus.progressDescription = "Der aktuelle Lead-Run wird gestoppt.";
    leadRunStatus.detail = "Der laufende Suchschritt wird beendet und der Run danach sauber abgeschlossen.";
  } else {
    leadRunStatus.stage = progress.stage;
    leadRunStatus.stageLabel = progress.stageLabel;
    leadRunStatus.progressValue = progress.progressValue;
    leadRunStatus.progressMax = progress.progressMax;
    leadRunStatus.progressDescription = progress.progressDescription;
    leadRunStatus.detail = progress.detail;
  }

  leadRunStatus.processedFilters = progress.processedFilters;
  leadRunStatus.totalFilters = progress.totalFilters;
  leadRunStatus.foundCandidates = progress.foundCandidates;
  leadRunStatus.targetLeadCount = progress.targetLeadCount;
  leadRunStatus.aiPrefilterConcurrency = progress.aiPrefilterConcurrency;
  leadRunStatus.outreachPrepConcurrency = progress.outreachPrepConcurrency;
  leadRunStatus.contactSearchConcurrency = progress.contactSearchConcurrency;
  leadRunStatus.exaQueryCount = progress.exaQueryCount;
  leadRunStatus.funnel = progress.funnel;
  leadRunStatus.timedOut = progress.timedOut;
  leadRunStatus.updatedAt = progress.updatedAt;
  leadRunStatus.runVariant = progress.runVariant ?? leadRunStatus.runVariant;
  leadRunStatus.workerMetrics = progress.workerMetrics;
  leadRunStatus.liveSearchDebug = progress.liveSearchDebug;
  leadRunStatus.debugMessages = progress.debugMessages;
  leadRunStatus.errorMessages = progress.errorMessages;
}

async function startManagedLeadRun(
  body: Record<string, unknown>,
  variant: "legacy" | "worker_v2",
  response: express.Response
): Promise<void> {
  clearStaleLeadRunStatusIfNeeded();

  if (leadRunStatus.running) {
    response.status(409).json({
      trigger: "hubspot-ui",
      accepted: false,
      runStatus: leadRunStatus,
      error: "A lead run is already in progress."
    });
    return;
  }

  const payload = await buildLeadJobPayload(body);
  const runAbortController = new AbortController();
  activeLeadRunAbortController = runAbortController;

  leadRunStatus.running = true;
  leadRunStatus.startedAt = new Date().toISOString();
  leadRunStatus.finishedAt = undefined;
  leadRunStatus.lastError = undefined;
  leadRunStatus.runVariant = variant;
  leadRunStatus.workerMetrics = undefined;
  leadRunStatus.liveSearchDebug = undefined;
  leadRunStatus.debugMessages = undefined;
  leadRunStatus.errorMessages = undefined;
  leadRunStatus.stage = "starting";
  leadRunStatus.stageLabel = variant === "worker_v2" ? "Neuer Worker-Run startet" : "Lead-Run startet";
  leadRunStatus.progressValue = 2;
  leadRunStatus.progressMax = 100;
  leadRunStatus.progressDescription = variant === "worker_v2"
    ? "Der neue Worker-Run initialisiert Exa-, KI-, Outreach-, Kontakt- und HubSpot-Queues."
    : "Der Lead Agent initialisiert die Suche.";
  leadRunStatus.detail = variant === "worker_v2"
    ? "Die Zielparameter wurden uebernommen und der Worker-Run wird vorbereitet."
    : "Die Zielparameter wurden uebernommen und der Lauf wird vorbereitet.";
  leadRunStatus.processedFilters = 0;
  leadRunStatus.totalFilters = undefined;
  leadRunStatus.foundCandidates = 0;
  leadRunStatus.targetLeadCount = payload.targetLeadCount;
  leadRunStatus.aiPrefilterConcurrency = payload.aiPrefilterConcurrency;
  leadRunStatus.outreachPrepConcurrency = payload.outreachPrepConcurrency;
  leadRunStatus.contactSearchConcurrency = payload.contactSearchConcurrency;
  leadRunStatus.exaQueryCount = payload.exaQueryCount;
  leadRunStatus.funnel = undefined;
  leadRunStatus.timedOut = false;
  leadRunStatus.updatedAt = new Date().toISOString();

  const attemptRun = () => variant === "worker_v2"
    ? leadWorkerRunService.run(payload, {
        signal: runAbortController.signal,
        onProgress: (progress) => applyLeadRunProgress(progress, runAbortController.signal.aborted)
      })
    : leadPipelineAgent.run(payload, {
        shouldStop: () => runAbortController.signal.aborted,
        onProgress: (progress) => applyLeadRunProgress(progress, runAbortController.signal.aborted)
      });

  const MAX_RUN_ATTEMPTS = 3;
  const RUN_RETRY_DELAY_MS = 2_000;

  const runPromise = (async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_RUN_ATTEMPTS; attempt += 1) {
      if (runAbortController.signal.aborted) {
        throw lastError ?? new Error("Lead-Run wurde vor Abschluss gestoppt.");
      }
      try {
        return await attemptRun();
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Lead run attempt ${attempt}/${MAX_RUN_ATTEMPTS} failed`, error);
        if (runAbortController.signal.aborted || attempt === MAX_RUN_ATTEMPTS) {
          break;
        }
        leadRunStatus.stage = "retrying";
        leadRunStatus.stageLabel = "Erneuter Versuch";
        leadRunStatus.progressDescription = `Versuch ${attempt}/${MAX_RUN_ATTEMPTS} fehlgeschlagen. Neuer Versuch...`;
        leadRunStatus.detail = `Fehler: ${message}`;
        leadRunStatus.updatedAt = new Date().toISOString();
        await new Promise((resolve) => setTimeout(resolve, RUN_RETRY_DELAY_MS));
      }
    }
    throw lastError ?? new Error("Lead-Run fehlgeschlagen.");
  })();

  void runPromise
    .then((result) => {
      if (activeLeadRunAbortController === runAbortController) {
        activeLeadRunAbortController = undefined;
      }

      leadRunStatus.running = false;
      leadRunStatus.stage = result.stopped ? "stopped" : result.timedOut ? "timed_out" : "completed";
      leadRunStatus.stageLabel = result.stopped ? "Gestoppt" : result.timedOut ? "Zeitlimit erreicht" : "Abgeschlossen";
      leadRunStatus.progressValue = 100;
      leadRunStatus.progressMax = 100;
      const targetSynchronizedCompanies = result.hubspotSync.mode === "live";
      const completionCount = targetSynchronizedCompanies ? result.hubspotSync.companySyncedCount : result.shortlistedCompanies.length;
      const completionReason = result.completionReason?.trim();
      leadRunStatus.progressDescription = result.stopped
        ? targetSynchronizedCompanies
          ? `Lead-Run manuell gestoppt bei ${completionCount}/${payload.targetLeadCount} nach HubSpot synchronisierten Firmen`
          : `Lead-Run manuell gestoppt bei ${completionCount} qualifizierten Firmen`
        : result.timedOut
        ? targetSynchronizedCompanies
          ? `Zeitlimit erreicht bei ${completionCount}/${payload.targetLeadCount} nach HubSpot synchronisierten Firmen`
          : `Zeitlimit erreicht bei ${completionCount} qualifizierten Firmen`
        : completionCount < payload.targetLeadCount
          ? targetSynchronizedCompanies
            ? completionReason
              ? `${completionCount}/${payload.targetLeadCount} Firmen nach HubSpot synchronisiert, ${completionReason}`
              : `${completionCount}/${payload.targetLeadCount} Firmen nach HubSpot synchronisiert, Suche vor Zeitlimit ausgeschoepft`
            : `${completionCount}/${payload.targetLeadCount} qualifizierte Firmen vor Zeitlimit gefunden`
          : targetSynchronizedCompanies
            ? `${completionCount}/${payload.targetLeadCount} Firmen nach HubSpot synchronisiert`
            : `${completionCount} qualifizierte Firmen abgeschlossen`;
      leadRunStatus.detail = result.stopped
        ? `Bis zum Stopp: ${result.funnel.crawledPages} Seiten gecrawlt, ${result.funnel.afterCrawlerPrefilter} nach Vorfilter, ${result.funnel.afterHubSpotDedup} nach HubSpot-Deduplizierung, ${result.funnel.afterAzureAICheck} nach Azure AI Check, ${result.funnel.syncedToHubSpot} nach HubSpot synchronisiert.`
        : result.timedOut
        ? `Funnel bis Abbruch: ${result.funnel.crawledPages} Seiten gecrawlt, ${result.funnel.afterCrawlerPrefilter} nach Vorfilter, ${result.funnel.afterHubSpotDedup} nach HubSpot-Deduplizierung, ${result.funnel.afterAzureAICheck} nach Azure AI Check, ${result.funnel.syncedToHubSpot} nach HubSpot synchronisiert.`
        : completionCount < payload.targetLeadCount
          ? `${completionReason ?? "Suche vor Zeitlimit ausgeschoepft."} ${result.funnel.crawledPages} Seiten gecrawlt, ${result.funnel.afterCrawlerPrefilter} nach Vorfilter, ${result.funnel.afterHubSpotDedup} nach HubSpot-Deduplizierung, ${result.funnel.afterAzureAICheck} nach Azure AI Check, ${result.funnel.syncedToHubSpot} nach HubSpot synchronisiert.`
          : targetSynchronizedCompanies
            ? `${result.hubspotSync.companySyncedCount} Firmen nach HubSpot synchronisiert.`
            : "Dry-Run abgeschlossen. Es wurde nichts nach HubSpot geschrieben.";
      leadRunStatus.processedFilters = result.evaluations.length;
      leadRunStatus.totalFilters = result.suggestedFilters.length;
      leadRunStatus.foundCandidates = result.shortlistedCompanies.length;
      leadRunStatus.targetLeadCount = payload.targetLeadCount;
      leadRunStatus.funnel = result.funnel;
      leadRunStatus.timedOut = result.timedOut;
      leadRunStatus.updatedAt = new Date().toISOString();
      leadRunStatus.finishedAt = new Date().toISOString();
    })
    .catch((error) => {
      if (activeLeadRunAbortController === runAbortController) {
        activeLeadRunAbortController = undefined;
      }

      leadRunStatus.running = false;
      leadRunStatus.stage = "failed";
      leadRunStatus.stageLabel = "Fehlgeschlagen";
      leadRunStatus.progressDescription = "Der Lead-Run ist mit einem Fehler abgebrochen.";
      leadRunStatus.detail = error instanceof Error ? error.message : "Unknown error";
      leadRunStatus.updatedAt = new Date().toISOString();
      leadRunStatus.finishedAt = new Date().toISOString();
      leadRunStatus.lastError = error instanceof Error ? error.message : "Unknown error";
      console.error("Lead run failed", error);

      void controlPlaneStore
        .appendRunErrors([
          {
            timestamp: new Date().toISOString(),
            scope: "lead_run",
            message: error instanceof Error ? error.message : "Unknown error"
          }
        ])
        .catch(() => undefined);
    });

  response.status(202).json({
    trigger: "hubspot-ui",
    accepted: true,
    runStatus: leadRunStatus
  });
}

function clearStaleLeadRunStatusIfNeeded(): void {
  if (!leadRunStatus.running) {
    return;
  }

  const queueSizes = (leadRunStatus.workerMetrics && typeof leadRunStatus.workerMetrics === "object" && "queueSizes" in leadRunStatus.workerMetrics)
    ? (leadRunStatus.workerMetrics as { queueSizes?: Record<string, unknown> }).queueSizes
    : undefined;
  const hasActiveWorkerQueue = Boolean(queueSizes) && Object.values(queueSizes ?? {}).some((value) => Number(value ?? 0) > 0);
  const isLegacyRun = leadRunStatus.runVariant === "legacy";

  // Legacy runs do not publish worker queue metrics; as long as the active run controller exists,
  // keep the run alive and avoid stale auto-release.
  if (activeLeadRunAbortController && (hasActiveWorkerQueue || isLegacyRun)) {
    return;
  }

  const updatedAtMs = Date.parse(leadRunStatus.updatedAt || "");
  const staleForMs = Number.isFinite(updatedAtMs) ? Date.now() - updatedAtMs : Number.POSITIVE_INFINITY;
  if (staleForMs < STALE_LEAD_RUN_THRESHOLD_MS) {
    return;
  }

  if (activeLeadRunAbortController) {
    activeLeadRunAbortController.abort();
    activeLeadRunAbortController = undefined;
  }

  resetLeadRunStatus(
    "Ein veralteter oder nach einem Deploy unterbrochener Lead-Run wurde automatisch freigegeben.",
    "failed",
    "Veralteter Run freigegeben"
  );
}

async function buildRunStatusResponse(): Promise<{ runStatus: LeadRunStatus }> {
  if (leadRunStatus.liveSearchDebug) {
    return { runStatus: leadRunStatus };
  }

  const liveExaCache = await controlPlaneStore.getLiveExaCache();
  const latestQueryRun = liveExaCache.queryRuns?.[0];
  if (!latestQueryRun) {
    return { runStatus: leadRunStatus };
  }

  if (!shouldUseCachedLiveSearchDebug(leadRunStatus.updatedAt, latestQueryRun.timestamp)) {
    return { runStatus: leadRunStatus };
  }

  return {
    runStatus: {
      ...leadRunStatus,
      liveSearchDebug: {
        filterName: latestQueryRun.filterName,
        plannedQueries: latestQueryRun.plannedQueries,
        promptMessages: latestQueryRun.promptMessages,
        lastExecutedQuery: latestQueryRun.query,
        excludedDomains: latestQueryRun.excludedDomains,
        excludedDomainDetails: latestQueryRun.excludedDomainDetails,
        executedQueries: latestQueryRun.plannedQueries?.length,
        totalQueries: latestQueryRun.plannedQueries?.length
      },
      updatedAt: leadRunStatus.updatedAt || latestQueryRun.timestamp
    }
  };
}

const selectableCategorySchema = z.enum([
  "integrator_vision_industrial_ai",
  "integrator_vision_ai_consulting",
  "integrator_vision_ai_freelancer",
  "integrator_general_ai",
  "integrator_relevant_focus",
  "industrial_end_customer_scaled",
  "camera_manufacturer_partner",
  "machine_builder_ai_enablement",
  "machine_builder_vision_ai",
  "software_platform_embedding"
]);

const prequalificationCategoryContextSchema = z.object({
  classificationRules: z.array(z.string().min(1)).max(12).optional(),
  disqualifiers: z.array(z.string().min(1)).max(12).optional(),
  addOnContext: z.string().max(3000).optional()
});

const executionCategoryContextSchema = z.object({
  researchPriorities: z.array(z.string().min(1)).max(12).optional(),
  outreachPriorities: z.array(z.string().min(1)).max(12).optional(),
  personalizationRules: z.array(z.string().min(1)).max(12).optional(),
  avoidSignals: z.array(z.string().min(1)).max(12).optional()
});

const prequalificationConfigSchema = z.object({
  mainContext: z.string().max(6000).optional(),
  categoryContexts: z.object({
    integrator_vision_industrial_ai: prequalificationCategoryContextSchema.optional(),
    integrator_vision_ai_consulting: prequalificationCategoryContextSchema.optional(),
    integrator_vision_ai_freelancer: prequalificationCategoryContextSchema.optional(),
    integrator_general_ai: prequalificationCategoryContextSchema.optional(),
    integrator_relevant_focus: prequalificationCategoryContextSchema.optional(),
    industrial_end_customer_scaled: prequalificationCategoryContextSchema.optional(),
    camera_manufacturer_partner: prequalificationCategoryContextSchema.optional(),
    machine_builder_ai_enablement: prequalificationCategoryContextSchema.optional(),
    machine_builder_vision_ai: prequalificationCategoryContextSchema.optional(),
    software_platform_embedding: prequalificationCategoryContextSchema.optional()
  }).optional()
});

const executionContextsSchema = z.object({
  integrator_vision_industrial_ai: executionCategoryContextSchema.optional(),
  integrator_vision_ai_consulting: executionCategoryContextSchema.optional(),
  integrator_vision_ai_freelancer: executionCategoryContextSchema.optional(),
  integrator_general_ai: executionCategoryContextSchema.optional(),
  integrator_relevant_focus: executionCategoryContextSchema.optional(),
  industrial_end_customer_scaled: executionCategoryContextSchema.optional(),
  camera_manufacturer_partner: executionCategoryContextSchema.optional(),
  machine_builder_ai_enablement: executionCategoryContextSchema.optional(),
  machine_builder_vision_ai: executionCategoryContextSchema.optional(),
  software_platform_embedding: executionCategoryContextSchema.optional()
});

const openCrawlerTuningSchema = z.object({
  probeCount: z.coerce.number().int().min(1).max(200).optional(),
  maxPages: z.coerce.number().int().min(1).max(20).optional(),
  sampleMultiplier: z.coerce.number().int().min(1).max(20).optional(),
  minSampleSize: z.coerce.number().int().min(1).max(200).optional(),
  rawCollectionMultiplier: z.coerce.number().int().min(1).max(20).optional()
});

const leadJobSchema = z.object({
  targetLeadCount: z.coerce.number().int().positive().max(1000),
  market: z.string().optional(),
  mainContext: z.string().max(12000).optional(),
  targetCategoryRefinement: z.string().max(4000).optional(),
  searchStrategyContext: z.string().max(12000).optional(),
  searchStrategyPreset: z.enum(["default", "optimized_vision_integrators"]).optional(),
  companySearchMode: z.enum(["internet_research", "open_crawler_search", "exa_search", "diffbot_search", "diffbot_test_data"]).optional(),
  prequalification: prequalificationConfigSchema.optional(),
  prequalificationContext: z.string().max(4000).optional(),
  executionContexts: executionContextsSchema.optional(),
  targetCategories: z.array(selectableCategorySchema).min(1).optional(),
  runDeepResearch: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  syncToHubSpot: z.boolean().optional(),
  reuseQualifiedCompanyCache: z.boolean().optional(),
  exaApiKey: z.string().optional(),
  diffbotToken: z.string().optional(),
  exaQueryCount: z.coerce.number().int().min(1).max(50).optional(),
  exaSearchMode: z.enum(["auto", "auto_system", "deep_lite", "deep_lite_system", "fast", "fast_system"]).optional(),
  useAzureQueryPlanner: z.boolean().optional(),
  useExaExcludeDomains: z.boolean().optional(),
  useExaCompanyCategory: z.boolean().optional(),
  excludePreviouslyFoundExaDomains: z.boolean().optional(),
  aiPrefilterConcurrency: z.coerce.number().int().min(1).optional(),
  outreachPrepConcurrency: z.coerce.number().int().min(1).optional(),
  contactSearchConcurrency: z.coerce.number().int().min(1).optional(),
  disableHubSpotDeduplication: z.boolean().optional(),
  maxRuntimeMs: z.coerce.number().int().min(60_000).max(10_800_000).optional(),
  earlyStopEnabled: z.boolean().optional(),
  earlyStopReviewCount: z.coerce.number().int().min(5).max(30).optional(),
  earlyStopThreshold: z.coerce.number().min(0).max(1).optional(),
  earlyStopMinRelevantCount: z.coerce.number().int().min(0).max(30).optional(),
  openCrawlerTuning: openCrawlerTuningSchema.optional()
});

const settingsUpdateSchema = z.object({
  targetLeadCount: z.coerce.number().int().positive().max(1000).optional(),
  market: z.string().min(1).optional(),
  mainContext: z.string().max(12000).optional(),
  targetCategoryRefinement: z.string().max(4000).optional(),
  searchStrategyContext: z.string().max(12000).optional(),
  searchStrategyPreset: z.enum(["default", "optimized_vision_integrators"]).optional(),
  companySearchMode: z.enum(["internet_research", "open_crawler_search", "exa_search", "diffbot_search", "diffbot_test_data"]).optional(),
  prequalification: prequalificationConfigSchema.optional(),
  prequalificationContext: z.string().max(4000).optional(),
  executionContexts: executionContextsSchema.optional(),
  targetCategories: z.array(selectableCategorySchema).min(1).optional(),
  runDeepResearch: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  syncToHubSpot: z.boolean().optional(),
  exaApiKey: z.string().optional(),
  diffbotToken: z.string().optional(),
  exaQueryCount: z.coerce.number().int().min(1).max(50).optional(),
  exaSearchMode: z.enum(["auto", "auto_system", "deep_lite", "deep_lite_system", "fast", "fast_system"]).optional(),
  useAzureQueryPlanner: z.boolean().optional(),
  useExaExcludeDomains: z.boolean().optional(),
  useExaCompanyCategory: z.boolean().optional(),
  excludePreviouslyFoundExaDomains: z.boolean().optional(),
  aiPrefilterConcurrency: z.coerce.number().int().min(1).optional(),
  outreachPrepConcurrency: z.coerce.number().int().min(1).optional(),
  contactSearchConcurrency: z.coerce.number().int().min(1).optional(),
  maxRuntimeMs: z.coerce.number().int().min(60_000).max(10_800_000).optional(),
  earlyStopEnabled: z.boolean().optional(),
  earlyStopReviewCount: z.coerce.number().int().min(5).max(30).optional(),
  earlyStopThreshold: z.coerce.number().min(0).max(1).optional(),
  earlyStopMinRelevantCount: z.coerce.number().int().min(0).max(30).optional(),
  openCrawlerTuning: openCrawlerTuningSchema.optional()
});

const templateUpdateSchema = z.object({
  audience: z.string().min(1).optional(),
  goal: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  emailBody: z.string().min(1).optional(),
  linkedInConnectionRequest: z.string().min(1).optional(),
  linkedInMessage: z.string().min(1).optional(),
  phoneScript: z.string().min(1).optional()
});

const learningFeedbackSchema = z.object({
  companyName: z.string().min(1),
  domain: z.string().optional(),
  verdict: z.enum(["accept", "reject"]),
  reason: z.string().min(1)
});

const debugConsoleRequestSchema = z.object({
  stage: z.enum(["company_search", "ai_prefilter", "outreach_prep", "contact_discovery"]).default("contact_discovery"),
  targetCategory: selectableCategorySchema.optional(),
  targetCategories: z.array(selectableCategorySchema).min(1).optional(),
  targetCategoryRefinement: z.string().max(4000).optional(),
  region: z.string().max(160).optional(),
  companySearchMode: z.enum(["exa_search", "diffbot_search"]).default("exa_search"),
  exaQueryCount: z.coerce.number().int().min(1).max(50).optional(),
  exaSearchMode: z.enum(["auto", "auto_system", "deep_lite", "deep_lite_system", "fast", "fast_system"]).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(20),
  useExaExcludeDomains: z.boolean().optional(),
  useExaCompanyCategory: z.boolean().optional(),
  useAzureQueryPlanner: z.boolean().optional(),
  excludePreviouslyFoundExaDomains: z.boolean().optional(),
  aiPrefilterConcurrency: z.coerce.number().int().min(1).optional(),
  outreachPrepConcurrency: z.coerce.number().int().min(1).optional(),
  contactSearchConcurrency: z.coerce.number().int().min(1).optional(),
  websites: z.array(z.string().max(500)).max(50).optional(),
  exaApiKey: z.string().optional(),
  diffbotToken: z.string().optional()
}).refine((value) => Boolean(value.targetCategory) || Boolean(value.targetCategories?.length), {
  message: "Either targetCategory or targetCategories must be provided."
});

app.use(express.json());

app.use((request, response, next) => {
  if (publicRoutes.has(request.path)) {
    next();
    return;
  }

  const forwardedFor = request.headers["x-forwarded-for"];
  const forwardedIp = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor?.split(",")[0]?.trim();
  const requestIp = forwardedIp ?? request.ip ?? "";
  const isLocalRequest = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(requestIp);

  if (isLocalRequest) {
    next();
    return;
  }

  const headerKey = request.get("x-lead-agent-key") ?? request.get("authorization")?.replace(/^Bearer\s+/i, "");
  const queryKey = typeof request.query.key === "string" ? request.query.key : undefined;
  const providedKey = headerKey ?? queryKey;

  if (providedKey !== env.LEAD_AGENT_SHARED_KEY) {
    response.status(401).json({
      error: "Unauthorized"
    });
    return;
  }

  next();
});

async function buildLeadJobPayload(body: Record<string, unknown>) {
  const settings = await controlPlaneStore.getSettings();
  const normalizedBodyExaApiKey = typeof body.exaApiKey === "string" && body.exaApiKey.trim().length > 0
    ? body.exaApiKey.trim()
    : undefined;
  const normalizedSettingsExaApiKey = typeof settings.exaApiKey === "string" && settings.exaApiKey.trim().length > 0
    ? settings.exaApiKey.trim()
    : undefined;
  const legacyPrequalificationContext = typeof body.prequalificationContext === "string"
    ? body.prequalificationContext
    : settings.prequalificationContext;
  const companySearchMode = body.companySearchMode ?? settings.companySearchMode;
  const prequalification = (body.prequalification ?? settings.prequalification) ??
    (legacyPrequalificationContext ? { mainContext: legacyPrequalificationContext } : undefined);
  const earlyStopEnabled = companySearchMode === "exa_search"
    ? false
    : body.earlyStopEnabled ?? settings.earlyStopEnabled;

  const searchStrategyPreset = body.searchStrategyPreset === "default" || body.searchStrategyPreset === "optimized_vision_integrators"
    ? body.searchStrategyPreset
    : settings.searchStrategyPreset;
  const presetSearchStrategyContext = resolveSearchStrategyPresetContext(searchStrategyPreset);

  return leadJobSchema.parse({
    targetLeadCount: body.targetLeadCount ?? settings.targetLeadCount ?? env.DEFAULT_TARGET_LEADS,
    market: body.market ?? settings.market ?? env.DEFAULT_MARKET,
    mainContext: body.mainContext ?? settings.mainContext,
    targetCategoryRefinement: body.targetCategoryRefinement ?? settings.targetCategoryRefinement,
    searchStrategyContext: body.searchStrategyContext ?? presetSearchStrategyContext ?? settings.searchStrategyContext,
    searchStrategyPreset,
    companySearchMode,
    creditLessMode: true,
    prequalification,
    prequalificationContext: legacyPrequalificationContext,
    executionContexts: body.executionContexts ?? settings.executionContexts,
    targetCategories: body.targetCategories ?? settings.targetCategories,
    runDeepResearch: body.runDeepResearch ?? settings.runDeepResearch,
    dryRun: body.dryRun ?? settings.dryRun,
    syncToHubSpot: body.syncToHubSpot ?? settings.syncToHubSpot ?? true,
    reuseQualifiedCompanyCache: body.reuseQualifiedCompanyCache,
    exaApiKey: normalizedBodyExaApiKey ?? normalizedSettingsExaApiKey ?? env.EXA_API_KEY,
    diffbotToken: typeof body.diffbotToken === "string" ? body.diffbotToken : settings.diffbotToken,
    exaQueryCount: body.exaQueryCount ?? settings.exaQueryCount,
    exaSearchMode: body.exaSearchMode ?? settings.exaSearchMode,
    useAzureQueryPlanner: body.useAzureQueryPlanner ?? settings.useAzureQueryPlanner ?? true,
    useExaExcludeDomains: body.useExaExcludeDomains ?? settings.useExaExcludeDomains,
    useExaCompanyCategory: body.useExaCompanyCategory ?? settings.useExaCompanyCategory,
    excludePreviouslyFoundExaDomains: body.excludePreviouslyFoundExaDomains ?? settings.excludePreviouslyFoundExaDomains,
    aiPrefilterConcurrency: body.aiPrefilterConcurrency ?? settings.aiPrefilterConcurrency,
    outreachPrepConcurrency: body.outreachPrepConcurrency ?? settings.outreachPrepConcurrency,
    contactSearchConcurrency: body.contactSearchConcurrency ?? settings.contactSearchConcurrency,
    disableHubSpotDeduplication: body.disableHubSpotDeduplication,
    earlyStopEnabled,
    earlyStopReviewCount: body.earlyStopReviewCount ?? settings.earlyStopReviewCount,
    earlyStopThreshold: body.earlyStopThreshold ?? settings.earlyStopThreshold,
    earlyStopMinRelevantCount: body.earlyStopMinRelevantCount ?? settings.earlyStopMinRelevantCount,
    maxRuntimeMs: body.maxRuntimeMs ?? settings.maxRuntimeMs,
    openCrawlerTuning: body.openCrawlerTuning ?? settings.openCrawlerTuning
  });
}

async function exchangeHubSpotOAuthCode(code: string, redirectUri: string) {
  if (!env.HUBSPOT_CLIENT_ID || !env.HUBSPOT_CLIENT_SECRET) {
    throw new Error("HubSpot OAuth is not configured. Set HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET.");
  }

  const response = await fetch(`${env.HUBSPOT_BASE_URL}/oauth/v1/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.HUBSPOT_CLIENT_ID,
      client_secret: env.HUBSPOT_CLIENT_SECRET,
      redirect_uri: redirectUri,
      code
    })
  });

  const payload = await response.json() as {
    hub_id?: number;
    access_token?: string;
    refresh_token?: string;
    message?: string;
    status?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !payload.access_token || !payload.refresh_token) {
    throw new Error(
      payload.error_description ||
      payload.message ||
      payload.error ||
      payload.status ||
      "HubSpot OAuth token exchange failed."
    );
  }

  return payload;
}

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "lead-agent",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/control/cache/live-exa", async (_request, response, next) => {
  try {
    response.json({
      cache: await controlPlaneStore.getLiveExaCache()
    });
  } catch (error) {
    next(error);
  }
});
app.get("/api/config/readiness", (_request, response) => {
  response.json({
    port: env.PORT,
    readiness
  });
});

// Debug: inspect the persistent per-domain occurrence counter and verify that the exclude
// request order matches the priority (occurrence) order. Used to prove nothing is lost and
// that historical occurrences accumulate across runs.
app.get("/api/debug/live-exa-occurrences", async (_request, response, next) => {
  try {
    const cache = await controlPlaneStore.getLiveExaCache();
    const stats = controlPlaneStore.getLiveExaDomainOccurrenceStats();
    const persisted = controlPlaneStore.readLiveExaDomainOccurrences();
    const recurring = cache.recurringDomains ?? [];

    // The exclude prompt should list domains in priority (occurrence) order, not alphabetical.
    const requestOrder = recurring.map((entry) => entry.domain);
    const priorityOrder = [...recurring]
      .sort((left, right) => {
        if (right.priority !== left.priority) {
          return right.priority - left.priority;
        }
        const timestampDelta = Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt);
        if (timestampDelta !== 0) {
          return timestampDelta;
        }
        return left.domain.localeCompare(right.domain);
      })
      .map((entry) => entry.domain);
    const orderMatchesPriority = requestOrder.every((domain, index) => domain === priorityOrder[index]);
    const firstMismatchIndex = requestOrder.findIndex((domain, index) => domain !== priorityOrder[index]);

    response.json({
      stats,
      entriesCount: cache.entries.length,
      recurringCount: recurring.length,
      persistedOccurrenceCount: persisted.length,
      orderMatchesPriority,
      firstMismatchIndex,
      topPersisted: persisted.slice(0, 20),
      topRecurring: recurring.slice(0, 20),
      requestOrderHead: requestOrder.slice(0, 20),
      priorityOrderHead: priorityOrder.slice(0, 20)
    });
  } catch (error) {
    next(error);
  }
});

// Debug: record synthetic returned domains and re-read to PROVE persistence + accumulation.
app.post("/api/debug/live-exa-occurrences/record", async (request, response, next) => {
  try {
    const body = request.body as { domains?: unknown };
    const rawDomains = Array.isArray(body?.domains) ? body.domains : [];
    const domains = rawDomains
      .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
      .filter((value): value is string => value.length > 0);

    if (domains.length === 0) {
      response.status(400).json({ error: "Provide a non-empty 'domains' string array." });
      return;
    }

    const before = controlPlaneStore.getLiveExaDomainOccurrenceStats();
    const beforeByDomain = new Map(
      controlPlaneStore.readLiveExaDomainOccurrences().map((entry) => [entry.domain, entry.occurrences])
    );

    const timestamp = new Date().toISOString();
    controlPlaneStore.recordLiveExaDomainOccurrences(
      domains.map((domain) => ({ timestamp, domain, discoveryQuery: "debug-record", sourceFilter: "debug" }))
    );

    const after = controlPlaneStore.getLiveExaDomainOccurrenceStats();
    const afterByDomain = new Map(
      controlPlaneStore.readLiveExaDomainOccurrences().map((entry) => [entry.domain, entry.occurrences])
    );

    response.json({
      recorded: domains,
      before,
      after,
      perDomain: domains.map((domain) => ({
        domain,
        before: beforeByDomain.get(domain) ?? 0,
        after: afterByDomain.get(domain) ?? 0
      }))
    });
  } catch (error) {
    next(error);
  }
});

// Debug: delete specific domains from the occurrence counter (used to clean up test data).
app.post("/api/debug/live-exa-occurrences/delete", async (request, response, next) => {
  try {
    const body = request.body as { domains?: unknown };
    const rawDomains = Array.isArray(body?.domains) ? body.domains : [];
    const domains = rawDomains
      .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
      .filter((value): value is string => value.length > 0);

    if (domains.length === 0) {
      response.status(400).json({ error: "Provide a non-empty 'domains' string array." });
      return;
    }

    const removed = controlPlaneStore.deleteLiveExaDomainOccurrences(domains);
    response.json({ removed, after: controlPlaneStore.getLiveExaDomainOccurrenceStats() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/cache/live-exa/reset", async (_request, response, next) => {
  try {
    response.json({
      cache: await controlPlaneStore.clearLiveExaCache()
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/cache/live-exa-history/reset", async (_request, response, next) => {
  try {
    const [learning, cache, latestLeadRun] = await Promise.all([
      controlPlaneStore.clearSearchHistoryMode("exa_search"),
      controlPlaneStore.clearLiveExaCache(),
      controlPlaneStore.clearLatestLeadRunSearchHistory("exa_search")
    ]);

    response.json({ learning, cache, latestLeadRun });
  } catch (error) {
    next(error);
  }
});
app.get("/hubspot", (_request, response) => {
  response.redirect("/hubspot/ui");
});

app.get("/hubspot/ui", (request, response) => {
  const html = readFileSync(hubSpotConsolePath, "utf8");
  const sharedKey = typeof request.query.key === "string" ? request.query.key : "";

  response.setHeader("Cache-Control", "no-store");
  response.type("html").send(
    html
      .replace(/__LEAD_AGENT_SHARED_KEY__/g, sharedKey)
      .replace(/__LEAD_AGENT_PUBLIC_BASE_URL__/g, env.LEAD_AGENT_PUBLIC_BASE_URL ?? "")
  );
});

app.get("/oauth-callback", async (request, response) => {
  const code = typeof request.query.code === "string" ? request.query.code : "";

  if (!code) {
    response.status(400).send("Missing HubSpot OAuth code.");
    return;
  }

  try {
    const publicBaseUrl = env.LEAD_AGENT_PUBLIC_BASE_URL ?? `${request.protocol}://${request.get("host")}`;
    const redirectUri = new URL("/oauth-callback", publicBaseUrl).toString();
    const oauthPayload = await exchangeHubSpotOAuthCode(code, redirectUri);

    console.log("HubSpot UI app connected", {
      hubId: oauthPayload.hub_id ?? "unknown"
    });

    response.status(200).send("ONE WARE Lead Agent UI was connected successfully. You can close this window and return to HubSpot.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "HubSpot OAuth callback failed.";
    response.status(500).send(message);
  }
});

app.get("/api/control-plane/bootstrap", async (_request, response, next) => {
  try {
    response.json(await controlPlaneStore.getBootstrap());
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/settings", async (_request, response, next) => {
  try {
    response.json({
      settings: await controlPlaneStore.getSettings()
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/control/settings", async (request, response, next) => {
  try {
    response.json({
      settings: await controlPlaneStore.updateSettings(settingsUpdateSchema.parse(request.body))
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/filter-presets", (_request, response) => {
  response.json({
    filters: defaultFilters
  });
});

app.get("/api/outreach/templates", async (_request, response, next) => {
  try {
    response.json({
      templates: Object.values(await controlPlaneStore.getTemplates())
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/outreach/contexts", (_request, response) => {
  response.json({
    categoryContexts: Object.values(CATEGORY_EXECUTION_CONTEXT)
  });
});

app.get("/api/control/learning", async (_request, response, next) => {
  try {
    response.json({
      learning: await controlPlaneStore.getLearning()
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/latest-lead-run", async (_request, response, next) => {
  try {
    response.json({
      latestLeadRun: await controlPlaneStore.getLatestLeadRun()
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/run-errors", async (_request, response, next) => {
  try {
    response.json({
      errors: await controlPlaneStore.getRunErrors()
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/cache/testlab-exa", async (_request, response, next) => {
  try {
    response.json({
      cache: await controlPlaneStore.getTestLabExaCache()
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/cache/company-screening", async (_request, response, next) => {
  try {
    response.json({
      database: await controlPlaneStore.getCompanyScreeningDatabase()
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/cache/testlab-exa/reset", async (_request, response, next) => {
  try {
    response.json({
      cache: await controlPlaneStore.clearTestLabExaCache()
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/cache/exa-search-history/reset", async (_request, response, next) => {
  try {
    response.json({
      learning: await controlPlaneStore.clearSearchHistoryMode("exa_search")
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/cache/company-screening/reset", async (_request, response, next) => {
  try {
    response.json({
      database: await controlPlaneStore.clearCompanyScreeningCache("all")
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/cache/company-screening/live/reset", async (_request, response, next) => {
  try {
    response.json({
      database: await controlPlaneStore.clearCompanyScreeningCache("live")
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/cache/company-screening/debug/reset", async (_request, response, next) => {
  try {
    response.json({
      database: await controlPlaneStore.clearCompanyScreeningCache("debug")
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/run-status", async (_request, response, next) => {
  clearStaleLeadRunStatusIfNeeded();
  try {
    response.json(await buildRunStatusResponse());
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/run-status/reset", (_request, response) => {
  resetLeadRunStatus("Blockierter oder veralteter Lead-Run wurde manuell freigegeben.");

  response.json({
    accepted: true,
    runStatus: leadRunStatus
  });
});

app.post("/api/control/run-status/stop", (_request, response) => {
  if (!leadRunStatus.running || !activeLeadRunAbortController) {
    response.status(409).json({
      accepted: false,
      error: "Es laeuft kein aktiver Lead-Run, der gestoppt werden kann.",
      runStatus: leadRunStatus
    });
    return;
  }

  activeLeadRunAbortController.abort();
  leadRunStatus.stage = "stopping";
  leadRunStatus.stageLabel = "Wird gestoppt";
  leadRunStatus.progressDescription = "Der aktuelle Lead-Run wird gestoppt.";
  leadRunStatus.detail = "Der laufende Suchschritt wird beendet und der Run danach sauber abgeschlossen.";
  leadRunStatus.updatedAt = new Date().toISOString();

  response.json({
    accepted: true,
    runStatus: leadRunStatus
  });
});

app.post("/api/control/learning/feedback", async (request, response, next) => {
  try {
    response.json({
      learning: await controlPlaneStore.recordCompanyFeedback(learningFeedbackSchema.parse(request.body))
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/outreach/templates/:key", async (request, response, next) => {
  try {
    response.json({
      template: await controlPlaneStore.updateTemplate(request.params.key, templateUpdateSchema.parse(request.body))
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/lead-jobs/preview", async (request, response, next) => {
  try {
    const payload = await buildLeadJobPayload(request.body as Record<string, unknown>);

    response.json(await leadPipelineAgent.preview(payload));
  } catch (error) {
    next(error);
  }
});

app.post("/api/debug/test-console", async (request, response, next) => {
  try {
    const parsedRequest = debugConsoleRequestSchema.parse(request.body);
    const settings = await controlPlaneStore.getSettings();
    const normalizedTargetCategories = (parsedRequest.targetCategories && parsedRequest.targetCategories.length > 0
      ? parsedRequest.targetCategories
      : parsedRequest.targetCategory
        ? [parsedRequest.targetCategory]
        : settings.targetCategories)
      ?.filter((category): category is z.infer<typeof selectableCategorySchema> => selectableCategorySchema.safeParse(category).success);

    if (!normalizedTargetCategories || normalizedTargetCategories.length === 0) {
      throw new Error("At least one target category is required for the debug console.");
    }

    const debugRunPromise = debugConsoleService.run({
      ...parsedRequest,
      targetCategory: parsedRequest.targetCategory ?? normalizedTargetCategories[0],
      targetCategories: normalizedTargetCategories,
      exaApiKey: parsedRequest.exaApiKey ?? settings.exaApiKey,
      diffbotToken: parsedRequest.diffbotToken ?? settings.diffbotToken
    });

    const result = await Promise.race([
      debugRunPromise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(Object.assign(new Error(`Test-Lab request timed out after ${DEBUG_CONSOLE_TIMEOUT_MS}ms.`), { statusCode: 504 })), DEBUG_CONSOLE_TIMEOUT_MS);
      })
    ]);

    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/lead-jobs/run", async (request, response, next) => {
  try {
    const payload = await buildLeadJobPayload(request.body as Record<string, unknown>);

    const result = await leadPipelineAgent.run(payload);
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/hubspot/workflow-trigger", async (request, response, next) => {
  try {
    await startManagedLeadRun(request.body as Record<string, unknown>, "legacy", response);
  } catch (error) {
    next(error);
  }
});

app.post("/api/hubspot/workflow-trigger-legacy", async (request, response, next) => {
  try {
    await startManagedLeadRun(request.body as Record<string, unknown>, "legacy", response);
  } catch (error) {
    next(error);
  }
});

app.post("/api/hubspot/workflow-trigger-new", async (request, response, next) => {
  try {
    await startManagedLeadRun(request.body as Record<string, unknown>, "worker_v2", response);
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  const statusCode = typeof error === "object" && error !== null && "statusCode" in error && typeof (error as { statusCode?: unknown }).statusCode === "number"
    ? (error as { statusCode: number }).statusCode
    : 500;
  response.status(statusCode).json({
    error: message
  });
});

export function startServer(): void {
  app.listen(env.PORT, "0.0.0.0", () => {
    console.log(`Lead Agent listening on 0.0.0.0:${env.PORT}`);
    console.log(`Lead Agent runtime data dir: ${getLeadAgentRuntimeDataDirectory()}`);
  });
}