import { env } from "../src/config";

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
const pollMs = Number(process.env.LEAD_RUN_WATCH_POLL_MS ?? "4000");

if (!baseUrl) {
  throw new Error("LEAD_AGENT_PUBLIC_BASE_URL is required.");
}

if (!sharedKey) {
  throw new Error("LEAD_AGENT_SHARED_KEY is required.");
}

function buildRequestBody() {
  return {
    targetLeadCount: 15,
    market: "DE",
    targetCategories: [
      "integrator_vision_industrial_ai",
      "integrator_general_ai",
      "integrator_relevant_focus"
    ],
    companySearchMode: "internet_research",
    creditLessMode: true,
    dryRun: false,
    syncToHubSpot: true,
    runDeepResearch: true,
    earlyStopEnabled: true,
    earlyStopReviewCount: 30,
    earlyStopThreshold: 0.15,
    earlyStopMinRelevantCount: 2,
    prequalification: {
      mainContext:
        "Qualify conservatively for German delivery-led software and automation providers. Prefer implementation ownership, industrial relevance, and plausible Vision AI / Industrial AI potential. Reject generic consultancies, media, HMI-only engineering, tool vendors, and non-industrial product companies.",
      categoryContexts: {}
    },
    mainContext: "",
    searchStrategyContext:
      "Start with internet research and keep using low-cost public discovery paths. Ignore already checked irrelevant firms and already existing HubSpot companies. Track which search filters and query variants produce relevant companies for the selected target categories. If the relevance rate of newly crawled companies drops below roughly 10-15 percent, tighten or revise the search criteria based on the accumulated search history instead of widening them."
  };
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(sharedKey)}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }

  return response.json() as Promise<T>;
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
  const detailPart = status.detail ? ` | ${status.detail}` : "";

  return `[${new Date().toLocaleTimeString("de-DE", { hour12: false })}] ${status.stageLabel} | ${percentage} | ${status.progressDescription}${filterPart}${candidatePart}${detailPart}`;
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

  for (;;) {
    const payload = await fetchJson<{ runStatus: RunStatus }>("/api/control/run-status");
    const status = payload.runStatus;
    const fingerprint = JSON.stringify({
      stage: status.stage,
      progressValue: status.progressValue,
      progressDescription: status.progressDescription,
      detail: status.detail,
      processedFilters: status.processedFilters,
      totalFilters: status.totalFilters,
      foundCandidates: status.foundCandidates,
      updatedAt: status.updatedAt,
      lastError: status.lastError
    });

    if (fingerprint !== lastFingerprint) {
      console.log(summarizeStatus(status));
      lastFingerprint = fingerprint;
    }

    if (!status.running && (status.stage === "completed" || status.stage === "failed")) {
      if (status.lastError) {
        console.error(`Run failed: ${status.lastError}`);
        process.exitCode = 1;
      }

      return;
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