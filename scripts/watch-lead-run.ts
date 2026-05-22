import dns from "node:dns";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "../src/config";

dns.setDefaultResultOrder("ipv4first");

const execFileAsync = promisify(execFile);

type RunStatus = {
  running: boolean;
  stage: string;
  stageLabel: string;
  progressValue: number;
  progressMax: number;
  progressDescription: string;
  detail?: string;
  processedFilters?: number;
  totalFilters?: number;
  foundCandidates?: number;
  targetLeadCount?: number;
  funnel?: {
    crawledPages: number;
    afterCrawlerPrefilter: number;
    afterHubSpotDedup: number;
    afterAzureAICheck: number;
    syncedToHubSpot: number;
  };
  timedOut?: boolean;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
};

type TriggerResponse = {
  accepted: boolean;
  runStatus: RunStatus;
  error?: string;
};

const baseUrl = process.env.LEAD_AGENT_PUBLIC_BASE_URL ?? env.LEAD_AGENT_PUBLIC_BASE_URL;
const sharedKey = process.env.LEAD_AGENT_SHARED_KEY ?? env.LEAD_AGENT_SHARED_KEY;
const shouldTrigger = process.argv.includes("--trigger");
const pollMs = Number(process.env.LEAD_RUN_WATCH_POLL_MS ?? "15000");
const configuredTargetLeadCount = Number(process.env.LEAD_RUN_TARGET_COUNT ?? "200");
const configuredMaxRuntimeMs = Number(process.env.LEAD_RUN_MAX_RUNTIME_MS ?? "10800000");
const configuredEarlyStopReviewCount = Number(process.env.LEAD_RUN_EARLY_STOP_REVIEW_COUNT ?? "30");
const configuredEarlyStopThreshold = Number(process.env.LEAD_RUN_EARLY_STOP_THRESHOLD ?? "0.15");
const configuredEarlyStopMinRelevantCount = Number(process.env.LEAD_RUN_EARLY_STOP_MIN_RELEVANT_COUNT ?? "2");
const configuredNoNewLeadTimeoutMs = Number(process.env.LEAD_RUN_NO_NEW_LEAD_TIMEOUT_MS ?? "600000");

if (!baseUrl) {
  throw new Error("LEAD_AGENT_PUBLIC_BASE_URL is required.");
}

if (!sharedKey) {
  throw new Error("LEAD_AGENT_SHARED_KEY is required.");
}

function buildRequestBody() {
  return {
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
    searchStrategyPreset: "optimized_vision_integrators",
    earlyStopEnabled: true,
    earlyStopReviewCount: configuredEarlyStopReviewCount,
    earlyStopThreshold: configuredEarlyStopThreshold,
    earlyStopMinRelevantCount: configuredEarlyStopMinRelevantCount,
    maxRuntimeMs: configuredMaxRuntimeMs,
    prequalification: {
      mainContext:
        "Qualify conservatively for Europe-first delivery-led software and automation providers. Prefer implementation ownership, industrial relevance, and plausible Vision AI / Industrial AI potential. Allow consulting firms with clear hands-on delivery ownership, but exclude freelancer and solo-specialist profiles. Reject generic consultancies, media, HMI-only engineering, tool vendors, and non-industrial product companies.",
      categoryContexts: {}
    },
    mainContext: "",
    searchStrategyContext:
      "Run the alternative open crawler discovery path in a Europe-first setup. Focus on Vision/Industrial AI integrators plus adjacent industrial software, automation, MES, SCADA, PLC, OT-integration, smart-factory, and embedded engineering service providers with clear delivery ownership. Crawl official company sites plus relevant internal pages, but deprioritize broad end-customer and machine-builder exploration in favor of integrator-heavy discovery. Ignore already checked irrelevant firms and already existing HubSpot companies. Exclude freelancer and solo-specialist profiles. If the relevance rate of newly crawled companies drops below roughly 10-15 percent, tighten or revise the search criteria based on the accumulated search history instead of widening them."
  };
}

function summarizeFinalMetrics(status: RunStatus): string | null {
  if (!status.startedAt) {
    return null;
  }

  const finishedAt = status.finishedAt ?? status.updatedAt;
  const durationMs = Date.parse(finishedAt) - Date.parse(status.startedAt);
  const durationMinutes = Number.isFinite(durationMs) ? (durationMs / 60000).toFixed(1) : "?";
  const crawlCount = status.funnel?.crawledPages ?? 0;
  const syncedCount = status.funnel?.syncedToHubSpot ?? 0;
  const searchesPerSynced = syncedCount > 0 ? (crawlCount / syncedCount).toFixed(1) : "n/a";

  return `Finale Metrik | Dauer ${durationMinutes} min | Crawl ${crawlCount} | Sync ${syncedCount} | Crawl pro Sync ${searchesPerSynced}`;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${baseUrl}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(sharedKey)}`;
  const curlCommand = process.platform === "win32" ? "curl.exe" : "curl";
  const args = ["-sS", "-X", init?.method ?? "GET", "-H", "Content-Type: application/json"];
  const body = typeof init?.body === "string" ? init.body : undefined;

  if (body) {
    args.push("--data-raw", body);
  }

  args.push(url);

  try {
    const { stdout } = await execFileAsync(curlCommand, args, {
      maxBuffer: 1024 * 1024 * 10
    });

    return JSON.parse(stdout) as T;
  } catch (error) {
    const stderr = typeof error === "object" && error && "stderr" in error ? String((error as { stderr?: string }).stderr ?? "") : "";
    const stdout = typeof error === "object" && error && "stdout" in error ? String((error as { stdout?: string }).stdout ?? "") : "";
    const detail = stderr || stdout || (error instanceof Error ? error.message : String(error));
    throw new Error(detail.trim() || "curl request failed");
  }
}

function summarizeStatus(status: RunStatus): string {
  const percentage = status.progressMax > 0
    ? `${Math.round((status.progressValue / status.progressMax) * 100)}%`
    : `${status.progressValue}`;
  const filterPart = status.totalFilters
    ? ` | Filter ${status.processedFilters ?? 0}/${status.totalFilters}`
    : "";
  const candidatePart = typeof status.foundCandidates === "number"
    ? ` | Kandidaten ${status.foundCandidates}/${status.targetLeadCount ?? "?"}`
    : "";
  const funnelPart = status.funnel
    ? ` | Crawl ${status.funnel.crawledPages} | Vorfilter ${status.funnel.afterCrawlerPrefilter} | HubSpot-Dedup ${status.funnel.afterHubSpotDedup} | Azure ${status.funnel.afterAzureAICheck} | Sync ${status.funnel.syncedToHubSpot}`
    : "";
  const detailPart = status.detail ? ` | ${status.detail}` : "";

  return `[${new Date().toLocaleTimeString("de-DE", { hour12: false })}] ${status.stageLabel} | ${percentage} | ${status.progressDescription}${filterPart}${candidatePart}${funnelPart}${detailPart}`;
}

async function triggerRun(): Promise<void> {
  const response = await fetchJson<TriggerResponse>("/api/hubspot/workflow-trigger", {
    method: "POST",
    body: JSON.stringify(buildRequestBody())
  });

  if (!response.accepted) {
    throw new Error(response.error ?? "Lead run was not accepted.");
  }

  console.log("Lead run accepted.");
  console.log(summarizeStatus(response.runStatus));
}

async function watchRun(): Promise<void> {
  let lastFingerprint = "";
  let consecutiveFetchFailures = 0;
  let bestLeadCount = 0;
  let lastLeadAt = Date.now();

  for (;;) {
    try {
      const payload = await fetchJson<{ runStatus: RunStatus }>("/api/control/run-status");
      const status = payload.runStatus;
      consecutiveFetchFailures = 0;
      const currentLeadCount = Math.max(status.foundCandidates ?? 0, status.funnel?.syncedToHubSpot ?? 0);
      if (currentLeadCount > bestLeadCount) {
        bestLeadCount = currentLeadCount;
        lastLeadAt = Date.now();
      }

      if (bestLeadCount === 0 && status.startedAt) {
        lastLeadAt = Math.max(lastLeadAt, Date.parse(status.startedAt));
      }

      const fingerprint = JSON.stringify({
        stage: status.stage,
        progressValue: status.progressValue,
        progressDescription: status.progressDescription,
        detail: status.detail,
        processedFilters: status.processedFilters,
        totalFilters: status.totalFilters,
        foundCandidates: status.foundCandidates,
        funnel: status.funnel,
        timedOut: status.timedOut,
        updatedAt: status.updatedAt,
        lastError: status.lastError
      });

      if (fingerprint !== lastFingerprint) {
        console.log(summarizeStatus(status));
        lastFingerprint = fingerprint;
      }

      if (status.running && configuredNoNewLeadTimeoutMs > 0 && Date.now() - lastLeadAt >= configuredNoNewLeadTimeoutMs) {
        console.error(`No new leads for ${(configuredNoNewLeadTimeoutMs / 60000).toFixed(1)} minutes.`);
        process.exitCode = 2;
        return;
      }

      if (!status.running && (status.stage === "completed" || status.stage === "failed" || status.stage === "timed_out")) {
        const finalMetrics = summarizeFinalMetrics(status);
        if (finalMetrics) {
          console.log(finalMetrics);
        }

        if (status.lastError) {
          console.error(`Run failed: ${status.lastError}`);
          process.exitCode = 1;
        }

        return;
      }
    } catch (error) {
      consecutiveFetchFailures += 1;
      if (consecutiveFetchFailures === 1 || consecutiveFetchFailures % 5 === 0) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Watcher retry after fetch error (${consecutiveFetchFailures}): ${message}`);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function main() {
  if (shouldTrigger) {
    await triggerRun();
  }

  await watchRun();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});