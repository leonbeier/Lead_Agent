import fs from "node:fs/promises";
import path from "node:path";
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

type ProfileConfig = {
  name: string;
  hypothesis: string;
  targetCategories: string[];
  earlyStopThreshold?: number;
  searchStrategyContext: string;
  openCrawlerTuning?: {
    probeCount?: number;
    maxPages?: number;
    sampleMultiplier?: number;
    minSampleSize?: number;
    rawCollectionMultiplier?: number;
  };
};

type BenchmarkTest = {
  testId: number;
  profile: ProfileConfig;
};

type BenchmarkResult = {
  testId: number;
  profileName: string;
  hypothesis: string;
  targetCategories: string[];
  earlyStopThreshold: number;
  attempts: number;
  startedAt: string;
  finishedAt: string;
  durationMinutes: number;
  stage: string;
  foundCandidates: number;
  crawledPages: number;
  afterCrawlerPrefilter: number;
  afterHubSpotDedup: number;
  afterAzureAICheck: number;
  syncedToHubSpot: number;
  lastError?: string;
};

const baseUrl = process.env.LEAD_AGENT_PUBLIC_BASE_URL ?? env.LEAD_AGENT_PUBLIC_BASE_URL;
const sharedKey = process.env.LEAD_AGENT_SHARED_KEY ?? env.LEAD_AGENT_SHARED_KEY;
const targetLeadCount = Number(process.env.LEAD_RUN_TARGET_COUNT ?? "200");
const benchmarkTestCount = Math.max(10, Number(process.env.LEAD_BENCHMARK_TEST_COUNT ?? "10"));
const perTestRuntimeMs = Number(process.env.LEAD_BENCHMARK_TEST_RUNTIME_MS ?? `${15 * 60 * 1000}`);
const pollMs = Number(process.env.LEAD_RUN_WATCH_POLL_MS ?? "15000");
const earlyStopReviewCount = Number(process.env.LEAD_RUN_EARLY_STOP_REVIEW_COUNT ?? "30");
const earlyStopMinRelevantCount = Number(process.env.LEAD_RUN_EARLY_STOP_MIN_RELEVANT_COUNT ?? "2");
const resultFilePath = path.join(process.cwd(), "data", "lead-benchmark-latest.json");

if (!baseUrl) {
  throw new Error("LEAD_AGENT_PUBLIC_BASE_URL is required.");
}

if (!sharedKey) {
  throw new Error("LEAD_AGENT_SHARED_KEY is required.");
}

const industrialSoftwareContext =
  "Run the alternative open crawler discovery path in a Europe-first setup. Focus on industrial software, MES, SCADA, PLC, OT integration, smart-factory, embedded engineering, and production-software service providers with clear project delivery ownership. Prefer firms with implementation, commissioning, integration, and customer references over generic consulting.";

const activeUiTargetCategories = [
  "integrator_vision_industrial_ai",
  "integrator_vision_ai_consulting",
  "integrator_general_ai",
  "integrator_relevant_focus",
  "industrial_end_customer_scaled",
  "machine_builder_ai_enablement"
] as const;

const profiles: ProfileConfig[] = [
  {
    name: "h01_balanced_dach_software",
    hypothesis: "Balanced DACH industrial software context yields the highest raw relevant-domain volume.",
    targetCategories: [...activeUiTargetCategories],
    earlyStopThreshold: 0.12,
    searchStrategyContext: industrialSoftwareContext,
    openCrawlerTuning: { probeCount: 24, maxPages: 3, sampleMultiplier: 4, minSampleSize: 18, rawCollectionMultiplier: 3 }
  },
  {
    name: "h02_delivery_heavy",
    hypothesis: "Heavier delivery-language bias improves conversion from crawler prefilter to Azure relevance.",
    targetCategories: [...activeUiTargetCategories],
    earlyStopThreshold: 0.08,
    searchStrategyContext: `${industrialSoftwareContext} Bias strongly toward delivery-led firms with commissioning, retrofit, implementation, references, and customer project ownership.`,
    openCrawlerTuning: { probeCount: 28, maxPages: 4, sampleMultiplier: 4, minSampleSize: 18, rawCollectionMultiplier: 3 }
  },
  {
    name: "h03_wider_software_platform",
    hypothesis: "Allowing adjacent industrial platforms captures additional software-led firms that still qualify later.",
    targetCategories: [...activeUiTargetCategories],
    earlyStopThreshold: 0.06,
    searchStrategyContext: `${industrialSoftwareContext} Allow adjacent software integration and industrial platform providers when manufacturing delivery ownership and system integration signals are explicit.`,
    openCrawlerTuning: { probeCount: 30, maxPages: 4, sampleMultiplier: 5, minSampleSize: 20, rawCollectionMultiplier: 4 }
  },
  {
    name: "h04_german_systemhaus",
    hypothesis: "German systemhaus and automation-house vocabulary unlocks more DACH integrator websites than generic software wording.",
    targetCategories: [...activeUiTargetCategories],
    earlyStopThreshold: 0.08,
    searchStrategyContext: `${industrialSoftwareContext} Explicitly seek Systemhaus, Automatisierungshaus, Steuerungstechnik, Prozessleittechnik, Systemintegration, Visualisierung, and SPS delivery firms in Germany, Austria, and Switzerland.`,
    openCrawlerTuning: { probeCount: 32, maxPages: 5, sampleMultiplier: 5, minSampleSize: 20, rawCollectionMultiplier: 4 }
  },
  {
    name: "h05_scada_mes_ot",
    hypothesis: "A narrower MES, SCADA, OT, and process-control angle yields fewer crawls but more industrial-fit candidates.",
    targetCategories: [...activeUiTargetCategories],
    earlyStopThreshold: 0.1,
    searchStrategyContext: `${industrialSoftwareContext} Narrow the search toward MES, SCADA, OT integration, Prozessautomation, Leitsysteme, Betriebsdatenerfassung, and production data systems with implementation ownership.`,
    openCrawlerTuning: { probeCount: 26, maxPages: 4, sampleMultiplier: 4, minSampleSize: 18, rawCollectionMultiplier: 3 }
  },
  {
    name: "h06_commissioning_retrofit",
    hypothesis: "Commissioning, retrofit, and brownfield-modernization language is a stronger proxy for delivery-led integrators than generic AI wording.",
    targetCategories: [...activeUiTargetCategories],
    earlyStopThreshold: 0.07,
    searchStrategyContext: `${industrialSoftwareContext} Prioritize commissioning, Inbetriebnahme, retrofit, modernization, migration, and brownfield industrial software projects over broad digital transformation claims.`,
    openCrawlerTuning: { probeCount: 28, maxPages: 5, sampleMultiplier: 4, minSampleSize: 18, rawCollectionMultiplier: 3 }
  },
  {
    name: "h07_reference_case_study",
    hypothesis: "Reference-project and case-study-heavy contexts produce the best downstream Azure acceptance.",
    targetCategories: [...activeUiTargetCategories],
    earlyStopThreshold: 0.06,
    searchStrategyContext: `${industrialSoftwareContext} Prefer firms with reference projects, Referenzen, case studies, customer projects, industries served, and named implementation outcomes.`,
    openCrawlerTuning: { probeCount: 30, maxPages: 5, sampleMultiplier: 5, minSampleSize: 20, rawCollectionMultiplier: 4 }
  },
  {
    name: "h08_europe_service_exporters",
    hypothesis: "Europe-wide industrial software exporters yield more total candidates than DACH-only profiles even if relevance is noisier.",
    targetCategories: [...activeUiTargetCategories],
    earlyStopThreshold: 0.05,
    searchStrategyContext: `${industrialSoftwareContext} Expand across Europe for delivery-led industrial software exporters and system integrators serving multiple EU markets, while keeping manufacturing relevance mandatory.`,
    openCrawlerTuning: { probeCount: 36, maxPages: 6, sampleMultiplier: 5, minSampleSize: 22, rawCollectionMultiplier: 4 }
  },
  {
    name: "h09_embedded_edge_ot",
    hypothesis: "Embedded, edge, and machine-level software engineering firms are undercounted and can add qualified adjacent targets.",
    targetCategories: [...activeUiTargetCategories],
    earlyStopThreshold: 0.05,
    searchStrategyContext: `${industrialSoftwareContext} Seek embedded engineering, edge software, machine connectivity, PLC/IPC integration, and production-line software firms when they clearly deliver custom industrial implementations.`,
    openCrawlerTuning: { probeCount: 34, maxPages: 5, sampleMultiplier: 5, minSampleSize: 20, rawCollectionMultiplier: 4 }
  },
  {
    name: "h10_iiot_industrie40",
    hypothesis: "Industrie 4.0 and IIoT wording surfaces a separate pool of qualified software-led implementation partners.",
    targetCategories: [...activeUiTargetCategories],
    earlyStopThreshold: 0.05,
    searchStrategyContext: `${industrialSoftwareContext} Emphasize Industrie 4.0, IIoT, Industrial IoT, shopfloor connectivity, digitalization of production, and manufacturing data platforms only when paired with clear integration and implementation ownership.`,
    openCrawlerTuning: { probeCount: 36, maxPages: 6, sampleMultiplier: 6, minSampleSize: 24, rawCollectionMultiplier: 4 }
  }
];

function summarizeStatus(status: RunStatus | undefined, profileName: string, testId: number): string {
  if (!status) {
    return `[Test ${testId.toString().padStart(2, "0")}] ${profileName} | Status unbekannt | Kandidaten 0/${targetLeadCount}`;
  }

  const funnel = status.funnel
    ? ` | Crawl ${status.funnel.crawledPages} | Vorfilter ${status.funnel.afterCrawlerPrefilter} | Azure ${status.funnel.afterAzureAICheck} | Sync ${status.funnel.syncedToHubSpot}`
    : "";

  return `[Test ${testId.toString().padStart(2, "0")}] ${profileName} | ${status.stageLabel} | Kandidaten ${status.foundCandidates ?? 0}/${status.targetLeadCount ?? targetLeadCount}${funnel}${status.detail ? ` | ${status.detail}` : ""}`;
}

function buildTests(): BenchmarkTest[] {
  if (benchmarkTestCount > profiles.length) {
    throw new Error(`Requested ${benchmarkTestCount} benchmark tests but only ${profiles.length} unique hypotheses are configured.`);
  }

  return profiles.slice(0, benchmarkTestCount).map((profile, index) => ({
    testId: index + 1,
    profile
  }));
}

function buildRequestBody(profile: ProfileConfig) {
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
    earlyStopEnabled: false,
    earlyStopReviewCount,
    earlyStopThreshold: profile.earlyStopThreshold ?? 0.12,
    earlyStopMinRelevantCount,
    maxRuntimeMs: perTestRuntimeMs,
    prequalification: {
      mainContext:
        "Qualify conservatively for Europe-first delivery-led software and automation providers. Prefer implementation ownership, industrial relevance, and plausible Vision AI / Industrial AI potential. Reject generic consultancies, media, recruiters, distributors, resellers, and product-only vendors without delivery ownership.",
      categoryContexts: {}
    },
    mainContext: "",
    searchStrategyContext: profile.searchStrategyContext,
    openCrawlerTuning: profile.openCrawlerTuning
  };
}

async function fetchJson<T>(requestPath: string, init?: RequestInit): Promise<T> {
  const url = `${baseUrl}${requestPath}${requestPath.includes("?") ? "&" : "?"}key=${encodeURIComponent(sharedKey)}`;
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

async function getRunStatus(): Promise<RunStatus> {
  const payload = await fetchJson<{ runStatus: RunStatus }>("/api/control/run-status");
  return payload?.runStatus ?? {
    running: false,
    stage: "unknown",
    stageLabel: "Status unbekannt",
    progressValue: 0,
    progressMax: 100,
    progressDescription: "Control-plane status did not include a runStatus payload.",
    updatedAt: new Date().toISOString()
  };
}

async function resetRun(): Promise<void> {
  await fetchJson("/api/control/run-status/reset", { method: "POST" });
}

async function triggerRun(profile: ProfileConfig, runtimeMs: number): Promise<RunStatus> {
  const response = await fetchJson<TriggerResponse>("/api/hubspot/workflow-trigger", {
    method: "POST",
    body: JSON.stringify({
      ...buildRequestBody(profile),
      maxRuntimeMs: runtimeMs
    })
  });

  if (!response.accepted) {
    if ((response.error ?? "").toLowerCase().includes("already in progress")) {
      return getRunStatus();
    }

    throw new Error(response.error ?? `Profile ${profile.name} was not accepted.`);
  }

  return response.runStatus ?? await getRunStatus();
}

function toBenchmarkResult(
  test: BenchmarkTest,
  attempts: number,
  slotStartedAt: string,
  slotFinishedAt: string,
  aggregate: {
    foundCandidates: number;
    crawledPages: number;
    afterCrawlerPrefilter: number;
    afterHubSpotDedup: number;
    afterAzureAICheck: number;
    syncedToHubSpot: number;
  },
  status: RunStatus
): BenchmarkResult {
  const startedAt = slotStartedAt;
  const finishedAt = slotFinishedAt;
  const durationMinutes = Math.max(0, (Date.parse(finishedAt) - Date.parse(startedAt)) / 60000);

  return {
    testId: test.testId,
    profileName: test.profile.name,
    hypothesis: test.profile.hypothesis,
    targetCategories: test.profile.targetCategories,
    earlyStopThreshold: test.profile.earlyStopThreshold ?? 0.12,
    attempts,
    startedAt,
    finishedAt,
    durationMinutes,
    stage: status.stage,
    foundCandidates: aggregate.foundCandidates,
    crawledPages: aggregate.crawledPages,
    afterCrawlerPrefilter: aggregate.afterCrawlerPrefilter,
    afterHubSpotDedup: aggregate.afterHubSpotDedup,
    afterAzureAICheck: aggregate.afterAzureAICheck,
    syncedToHubSpot: aggregate.syncedToHubSpot,
    lastError: status.lastError
  };
}

async function writeResults(results: BenchmarkResult[]): Promise<void> {
  const leaderboard = [...results].sort((left, right) => {
    if (right.syncedToHubSpot !== left.syncedToHubSpot) {
      return right.syncedToHubSpot - left.syncedToHubSpot;
    }

    if (right.afterAzureAICheck !== left.afterAzureAICheck) {
      return right.afterAzureAICheck - left.afterAzureAICheck;
    }

    if (right.foundCandidates !== left.foundCandidates) {
      return right.foundCandidates - left.foundCandidates;
    }

    return right.afterCrawlerPrefilter - left.afterCrawlerPrefilter;
  });

  await fs.mkdir(path.dirname(resultFilePath), { recursive: true });
  await fs.writeFile(
    resultFilePath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        perTestRuntimeMs,
        benchmarkTestCount,
        leaderboard,
        results
      },
      null,
      2
    )
  );
}

async function runSingleTest(test: BenchmarkTest): Promise<BenchmarkResult> {
  const slotStartedAt = new Date().toISOString();
  const slotDeadlineAt = Date.now() + perTestRuntimeMs;
  let attempts = 0;
  let lastCompletedStatus: RunStatus = {
    running: false,
    stage: "timed_out",
    stageLabel: "Zeitfenster beendet",
    progressValue: 0,
    progressMax: 100,
    progressDescription: "Benchmark-Zeitfenster beendet.",
    updatedAt: slotStartedAt
  };
  const aggregate = {
    foundCandidates: 0,
    crawledPages: 0,
    afterCrawlerPrefilter: 0,
    afterHubSpotDedup: 0,
    afterAzureAICheck: 0,
    syncedToHubSpot: 0
  };

  while (Date.now() < slotDeadlineAt) {
    const remainingRuntimeMs = Math.max(60_000, slotDeadlineAt - Date.now());
    attempts += 1;
    const initialStatus = await triggerRun(test.profile, remainingRuntimeMs);
    console.log(summarizeStatus(initialStatus, test.profile.name, test.testId));

    let lastFingerprint = "";

    for (;;) {
      const status = await getRunStatus();
      const fingerprint = JSON.stringify({
        stage: status.stage,
        progressValue: status.progressValue,
        foundCandidates: status.foundCandidates,
        funnel: status.funnel,
        detail: status.detail,
        updatedAt: status.updatedAt
      });

      if (fingerprint !== lastFingerprint) {
        console.log(summarizeStatus(status, test.profile.name, test.testId));
        lastFingerprint = fingerprint;
      }

      if (!status.running && (status.stage === "completed" || status.stage === "failed" || status.stage === "timed_out")) {
        aggregate.foundCandidates += status.foundCandidates ?? 0;
        aggregate.crawledPages += status.funnel?.crawledPages ?? 0;
        aggregate.afterCrawlerPrefilter += status.funnel?.afterCrawlerPrefilter ?? 0;
        aggregate.afterHubSpotDedup += status.funnel?.afterHubSpotDedup ?? 0;
        aggregate.afterAzureAICheck += status.funnel?.afterAzureAICheck ?? 0;
        aggregate.syncedToHubSpot += status.funnel?.syncedToHubSpot ?? 0;
        lastCompletedStatus = status;
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  return toBenchmarkResult(test, attempts, slotStartedAt, new Date().toISOString(), aggregate, lastCompletedStatus);
}

async function main() {
  const tests = buildTests();
  const results: BenchmarkResult[] = [];

  await writeResults(results);

  for (const test of tests) {
    try {
      const result = await runSingleTest(test);
      results.push(result);
      await writeResults(results);
    } catch (error) {
      const failedStatus = await getRunStatus().catch(() => ({
        running: false,
        stage: "failed",
        stageLabel: "Fehlgeschlagen",
        progressValue: 0,
        progressMax: 100,
        progressDescription: "Benchmark test failed before run status could be fetched.",
        updatedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error)
      } satisfies RunStatus));

      results.push(
        toBenchmarkResult(
          test,
          1,
          new Date().toISOString(),
          new Date().toISOString(),
          {
            foundCandidates: failedStatus.foundCandidates ?? 0,
            crawledPages: failedStatus.funnel?.crawledPages ?? 0,
            afterCrawlerPrefilter: failedStatus.funnel?.afterCrawlerPrefilter ?? 0,
            afterHubSpotDedup: failedStatus.funnel?.afterHubSpotDedup ?? 0,
            afterAzureAICheck: failedStatus.funnel?.afterAzureAICheck ?? 0,
            syncedToHubSpot: failedStatus.funnel?.syncedToHubSpot ?? 0
          },
          failedStatus
        )
      );
      await writeResults(results);
      try {
        await resetRun();
      } catch {
        // Ignore reset failures and continue to the next test.
      }
    }
  }

  const totalSync = results.reduce((sum, result) => sum + result.syncedToHubSpot, 0);
  const totalAzure = results.reduce((sum, result) => sum + result.afterAzureAICheck, 0);
  console.log(`Benchmark beendet | Tests ${results.length}/${benchmarkTestCount} | Azure ${totalAzure} | Sync ${totalSync}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});