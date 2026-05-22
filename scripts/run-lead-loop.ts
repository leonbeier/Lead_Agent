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

type Profile = {
  name: string;
  targetCategories: string[];
  searchStrategyContext: string;
  earlyStopThreshold?: number;
};

const baseUrl = process.env.LEAD_AGENT_PUBLIC_BASE_URL ?? env.LEAD_AGENT_PUBLIC_BASE_URL;
const sharedKey = process.env.LEAD_AGENT_SHARED_KEY ?? env.LEAD_AGENT_SHARED_KEY;
const targetLeadCount = Number(process.env.LEAD_RUN_TARGET_COUNT ?? "200");
const maxRuntimeMs = Number(process.env.LEAD_RUN_MAX_RUNTIME_MS ?? "10800000");
const noNewLeadTimeoutMs = Number(process.env.LEAD_RUN_NO_NEW_LEAD_TIMEOUT_MS ?? "600000");
const pollMs = Number(process.env.LEAD_RUN_WATCH_POLL_MS ?? "15000");
const earlyStopReviewCount = Number(process.env.LEAD_RUN_EARLY_STOP_REVIEW_COUNT ?? "30");
const earlyStopMinRelevantCount = Number(process.env.LEAD_RUN_EARLY_STOP_MIN_RELEVANT_COUNT ?? "2");
const lowYieldCrawlThreshold = Number(process.env.LEAD_RUN_LOW_YIELD_CRAWL_THRESHOLD ?? "4000");
const lowYieldPrefilterThreshold = Number(process.env.LEAD_RUN_LOW_YIELD_PREFILTER_THRESHOLD ?? "1");

if (!baseUrl) {
  throw new Error("LEAD_AGENT_PUBLIC_BASE_URL is required.");
}

if (!sharedKey) {
  throw new Error("LEAD_AGENT_SHARED_KEY is required.");
}

const profiles: Profile[] = [
  {
    name: "industrial_software",
    targetCategories: ["integrator_general_ai", "integrator_relevant_focus", "software_platform_embedding"],
    searchStrategyContext:
      "Run the alternative open crawler discovery path in a Europe-first setup. Focus on vision integrators plus adjacent industrial software, MES, SCADA, PLC, OT integration, smart-factory, embedded engineering, and production-software service providers with clear project delivery ownership. Prefer firms with implementation, commissioning, integration, and customer references over generic consulting."
  },
  {
    name: "benelux_europe_expanded",
    targetCategories: ["integrator_vision_industrial_ai", "integrator_relevant_focus"],
    searchStrategyContext:
      "Run the alternative open crawler discovery path in a Europe-first setup with extra emphasis on Belgium, Netherlands, Austria, Switzerland, France, Italy, Spain, Denmark, Portugal, Poland, and Czech Republic. Prefer machine vision, inspection automation, production quality, robot guidance, smart-factory software, and industrial engineering service providers with explicit customer implementation ownership."
  },
  {
    name: "vision_core",
    targetCategories: ["integrator_vision_industrial_ai", "integrator_relevant_focus"],
    searchStrategyContext:
      "Run the alternative open crawler discovery path in a Europe-first setup. Focus tightly on delivery-led machine-vision, visual-inspection, AOI, inline-inspection, and quality-control integrators. Prioritize official company sites, services, references, case studies, and customer-specific implementation language. Keep Belgium, Netherlands, Austria, Switzerland, France, Italy, Spain, and Germany in active rotation."
  }
];

function buildRequestBody(profile: Profile, remainingRuntimeMs: number) {
  return {
    targetLeadCount,
    market: "EU",
    targetCategories: profile.targetCategories,
    companySearchMode: "open_crawler_search",
    creditLessMode: true,
    dryRun: false,
    syncToHubSpot: true,
    runDeepResearch: true,
    searchStrategyPreset: "optimized_vision_integrators",
    earlyStopEnabled: true,
    earlyStopReviewCount,
    earlyStopThreshold: profile.earlyStopThreshold ?? 0.12,
    earlyStopMinRelevantCount,
    maxRuntimeMs: remainingRuntimeMs,
    prequalification: {
      mainContext:
        "Qualify conservatively for Europe-first delivery-led software and automation providers. Prefer implementation ownership, industrial relevance, and plausible Vision AI / Industrial AI potential. Reject generic consultancies, media, recruiters, distributors, resellers, and product-only vendors without delivery ownership.",
      categoryContexts: {}
    },
    mainContext: "",
    searchStrategyContext: profile.searchStrategyContext
  };
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

  const { stdout } = await execFileAsync(curlCommand, args, {
    maxBuffer: 1024 * 1024 * 10
  });

  return JSON.parse(stdout) as T;
}

function summarizeStatus(status: RunStatus, profileName: string): string {
  const percentage = status.progressMax > 0
    ? `${Math.round((status.progressValue / status.progressMax) * 100)}%`
    : `${status.progressValue}`;
  const funnel = status.funnel
    ? ` | Crawl ${status.funnel.crawledPages} | Vorfilter ${status.funnel.afterCrawlerPrefilter} | Azure ${status.funnel.afterAzureAICheck} | Sync ${status.funnel.syncedToHubSpot}`
    : "";

  return `[${new Date().toLocaleTimeString("de-DE", { hour12: false })}] ${profileName} | ${status.stageLabel} | ${percentage} | Kandidaten ${status.foundCandidates ?? 0}/${status.targetLeadCount ?? targetLeadCount}${funnel}${status.detail ? ` | ${status.detail}` : ""}`;
}

async function resetRun(): Promise<void> {
  await fetchJson("/api/control/run-status/reset", { method: "POST" });
}

async function getRunStatus(): Promise<RunStatus> {
  const payload = await fetchJson<{ runStatus: RunStatus }>("/api/control/run-status");
  return payload.runStatus;
}

async function runProfile(profile: Profile, deadlineAt: number): Promise<{ completed: boolean; synced: number }> {
  const remainingRuntimeMs = Math.max(60_000, deadlineAt - Date.now());
  const response = await fetchJson<TriggerResponse>("/api/hubspot/workflow-trigger", {
    method: "POST",
    body: JSON.stringify(buildRequestBody(profile, remainingRuntimeMs))
  });

  if (!response.accepted) {
    if ((response.error ?? "").toLowerCase().includes("already in progress")) {
      const existingStatus = await getRunStatus();
      console.log(`Profil ${profile.name} haengt sich an laufenden Run an.`);
      return watchAcceptedRun(profile, existingStatus);
    }

    throw new Error(response.error ?? `Profile ${profile.name} was not accepted.`);
  }

  console.log(`Profil gestartet: ${profile.name}`);
  return watchAcceptedRun(profile, response.runStatus);
}

async function watchAcceptedRun(profile: Profile, initialStatus: RunStatus): Promise<{ completed: boolean; synced: number }> {
  console.log(summarizeStatus(initialStatus, profile.name));

  let bestLeadCount = Math.max(initialStatus.foundCandidates ?? 0, initialStatus.funnel?.syncedToHubSpot ?? 0);
  let lastLeadAt = Date.now();
  let lastFingerprint = "";

  for (;;) {
    const status = await getRunStatus();
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
      foundCandidates: status.foundCandidates,
      funnel: status.funnel,
      detail: status.detail,
      updatedAt: status.updatedAt
    });

    if (fingerprint !== lastFingerprint) {
      console.log(summarizeStatus(status, profile.name));
      lastFingerprint = fingerprint;
    }

    if (!status.running && (status.stage === "completed" || status.stage === "failed" || status.stage === "timed_out")) {
      return {
        completed: status.stage === "completed",
        synced: status.funnel?.syncedToHubSpot ?? 0
      };
    }

    const crawledPages = status.funnel?.crawledPages ?? 0;
    const prefilteredCount = status.funnel?.afterCrawlerPrefilter ?? 0;
    if (currentLeadCount === 0 && crawledPages >= lowYieldCrawlThreshold && prefilteredCount <= lowYieldPrefilterThreshold) {
      console.log(`Profil ${profile.name} frueh gestoppt: Low-Yield-Muster (${crawledPages} Crawls, ${prefilteredCount} Vorfilter, 0 Leads).`);
      await resetRun();
      return {
        completed: false,
        synced: 0
      };
    }

    if (Date.now() - lastLeadAt >= noNewLeadTimeoutMs) {
      console.log(`Profil ${profile.name} gestoppt: ${(noNewLeadTimeoutMs / 60000).toFixed(1)} min ohne neuen Lead.`);
      console.log(`Zwischenstand | Sync ${status.funnel?.syncedToHubSpot ?? 0} | Crawl ${status.funnel?.crawledPages ?? 0} | Vorfilter ${status.funnel?.afterCrawlerPrefilter ?? 0}`);
      await resetRun();
      return {
        completed: false,
        synced: status.funnel?.syncedToHubSpot ?? 0
      };
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function main() {
  const deadlineAt = Date.now() + maxRuntimeMs;
  let profileIndex = 0;
  let cumulativeSynced = 0;

  while (Date.now() < deadlineAt && cumulativeSynced < targetLeadCount) {
    const profile = profiles[profileIndex % profiles.length];
    profileIndex += 1;

    try {
      const result = await runProfile(profile, deadlineAt);
      cumulativeSynced += result.synced;
      if (cumulativeSynced >= targetLeadCount) {
        console.log(`Ziel erreicht: ${cumulativeSynced}/${targetLeadCount} synchronisiert.`);
        return;
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      try {
        await resetRun();
      } catch {
        // Ignore reset failures during loop recovery.
      }
    }
  }

  console.log(`Loop beendet | Kumuliert synchronisiert ${cumulativeSynced}/${targetLeadCount}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});