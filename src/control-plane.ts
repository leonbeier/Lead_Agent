import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CacheDatabaseStore } from "./cache-database";
import {
  CATEGORY_EXECUTION_CONTEXT,
  CATEGORY_PREQUALIFICATION_CONTEXT,
  DEFAULT_MAIN_CONTEXT,
  DEFAULT_PREQUALIFICATION_CATEGORY_CONTEXTS,
  DEFAULT_PREQUALIFICATION_MAIN_CONTEXT,
  DEFAULT_SEARCH_STRATEGY_CONTEXT,
  OUTREACH_TEMPLATES,
  OutreachTemplate
} from "./prompting/one-ware-playbook";
import {
  OrganizationFilter,
  CompanyScreeningDatabase,
  CompanyScreeningRecord,
  CompanyFeedbackEntry,
  CompanySearchMode,
  EditableExecutionContext,
  EditablePrequalificationCategoryContext,
  ExaQueryHistoryInsight,
  FilterEvaluation,
  LiveExaCache,
  LiveExaExcludedDomainDetail,
  LiveExaRecurringDomain,
  LatestLeadRunRecord,
  LeadAgentSettings,
  LeadLearningData,
  RawExaHistoryEntry,
  SearchHistoryEntry,
  SelectableLeadCategory
} from "./types";

const selectableCategorySchema = z.enum([
  "integrator_vision_industrial_ai",
  "integrator_vision_ai_consulting",
  "integrator_vision_ai_freelancer",
  "integrator_general_ai",
  "integrator_relevant_focus",
  "industrial_end_customer_scaled",
  "camera_manufacturer_partner",
  "machine_builder_ai_enablement",
  "software_platform_embedding"
]);

const DEFAULT_RUNTIME_DATA_DIRECTORY = "/data";
const LIVE_EXA_REQUEST_EXCLUDED_DOMAIN_LIMIT = 1200;
const LIVE_EXA_EXCLUDED_DOMAIN_CATEGORY_PRIORITY: Record<LiveExaExcludedDomainDetail["category"], number> = {
  current_run_cache: 0,
  hubspot: 1,
  rejected_website: 2,
  historical_exa: 3
};

function compareCanonicalLiveExaExcludedDomainPriority(
  left: Pick<LiveExaExcludedDomainDetail, "domain" | "category" | "recentOccurrences" | "occurrences" | "requestIndex">,
  right: Pick<LiveExaExcludedDomainDetail, "domain" | "category" | "recentOccurrences" | "occurrences" | "requestIndex">
): number {
  const recentOccurrenceDelta = (right.recentOccurrences ?? 0) - (left.recentOccurrences ?? 0);
  if (recentOccurrenceDelta !== 0) {
    return recentOccurrenceDelta;
  }

  const occurrenceDelta = (right.occurrences ?? 0) - (left.occurrences ?? 0);
  if (occurrenceDelta !== 0) {
    return occurrenceDelta;
  }

  const categoryDelta = (LIVE_EXA_EXCLUDED_DOMAIN_CATEGORY_PRIORITY[left.category] ?? Number.MAX_SAFE_INTEGER)
    - (LIVE_EXA_EXCLUDED_DOMAIN_CATEGORY_PRIORITY[right.category] ?? Number.MAX_SAFE_INTEGER);
  if (categoryDelta !== 0) {
    return categoryDelta;
  }

  const leftIndex = typeof left.requestIndex === "number" ? left.requestIndex : Number.MAX_SAFE_INTEGER;
  const rightIndex = typeof right.requestIndex === "number" ? right.requestIndex : Number.MAX_SAFE_INTEGER;
  if (leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }

  return left.domain.localeCompare(right.domain);
}

function compareCanonicalLiveExaExcludedDomainDetails(
  left: Pick<LiveExaExcludedDomainDetail, "domain" | "category" | "includedInRequest" | "requestIndex" | "recentOccurrences" | "occurrences">,
  right: Pick<LiveExaExcludedDomainDetail, "domain" | "category" | "includedInRequest" | "requestIndex" | "recentOccurrences" | "occurrences">
): number {
  if (Number(right.includedInRequest) !== Number(left.includedInRequest)) {
    return Number(right.includedInRequest) - Number(left.includedInRequest);
  }

  const priorityDelta = compareCanonicalLiveExaExcludedDomainPriority(left, right);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const leftIndex = typeof left.requestIndex === "number" ? left.requestIndex : Number.MAX_SAFE_INTEGER;
  const rightIndex = typeof right.requestIndex === "number" ? right.requestIndex : Number.MAX_SAFE_INTEGER;
  if (leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }

  return left.domain.localeCompare(right.domain);
}

export function canonicalizeLiveExaExcludedDomainState(
  entries: LiveExaExcludedDomainDetail[] | undefined
): { excludedDomains?: string[]; excludedDomainDetails?: LiveExaExcludedDomainDetail[] } {
  if (!Array.isArray(entries) || entries.length === 0) {
    return {};
  }

  const normalizedByDomain = new Map<string, LiveExaExcludedDomainDetail>();
  for (const entry of entries) {
    const normalizedDomain = entry.domain?.trim().toLowerCase();
    if (!normalizedDomain) {
      continue;
    }

    const normalizedEntry: LiveExaExcludedDomainDetail = {
      ...entry,
      domain: normalizedDomain
    };

    const existingEntry = normalizedByDomain.get(normalizedDomain);
    if (!existingEntry || compareCanonicalLiveExaExcludedDomainPriority(normalizedEntry, existingEntry) < 0) {
      normalizedByDomain.set(normalizedDomain, normalizedEntry);
    }
  }

  const priorityRankedEntries = Array.from(normalizedByDomain.values())
    .sort((left, right) => compareCanonicalLiveExaExcludedDomainPriority(left, right));

  const excludedDomains = priorityRankedEntries
    .map((entry) => entry.domain)
    .slice(0, LIVE_EXA_REQUEST_EXCLUDED_DOMAIN_LIMIT);

  const requestDomainPositions = new Map<string, number>();
  excludedDomains.forEach((domain, index) => {
    requestDomainPositions.set(domain, index);
  });

  const excludedDomainDetails = priorityRankedEntries
    .map<LiveExaExcludedDomainDetail>((entry) => {
      const requestIndex = requestDomainPositions.get(entry.domain);
      return {
        ...entry,
        includedInRequest: requestIndex !== undefined,
        requestIndex
      };
    })
    .sort((left, right) => compareCanonicalLiveExaExcludedDomainDetails(left, right));

  return {
    excludedDomains,
    excludedDomainDetails
  };
}

function normalizeLiveExaQueryRuns(
  queryRuns: NonNullable<LiveExaCache["queryRuns"]> | undefined
): NonNullable<LiveExaCache["queryRuns"]> {
  return (queryRuns ?? [])
    .reduce<NonNullable<LiveExaCache["queryRuns"]>>((runs, queryRun) => {
      const timestamp = queryRun.timestamp?.trim();
      const filterName = queryRun.filterName?.trim();
      const query = queryRun.query?.trim();
      if (!timestamp || !filterName || !query) {
        return runs;
      }

      const key = `${filterName}__${query}`;
      if (!runs.some((candidate) => `${candidate.filterName}__${candidate.query}` === key)) {
        const normalizedExcludedDomainDetails = canonicalizeLiveExaExcludedDomainState(
          queryRun.excludedDomainDetails?.map((entry) => ({
            domain: entry.domain.trim().toLowerCase(),
            category: entry.category,
            includedInRequest: Boolean(entry.includedInRequest),
            requestIndex: typeof entry.requestIndex === "number" ? entry.requestIndex : undefined,
            recentOccurrences: typeof entry.recentOccurrences === "number" ? entry.recentOccurrences : undefined,
            recentPriority: typeof entry.recentPriority === "number" ? entry.recentPriority : undefined,
            recentLastSeenAt: entry.recentLastSeenAt,
            occurrences: typeof entry.occurrences === "number" ? entry.occurrences : undefined,
            priority: typeof entry.priority === "number" ? entry.priority : undefined,
            lastSeenAt: entry.lastSeenAt
          })).filter((entry) => entry.domain)
        );

        runs.push({
          timestamp,
          filterName,
          query,
          plannedQueries: queryRun.plannedQueries?.map((value) => value.trim()).filter(Boolean),
          promptMessages: queryRun.promptMessages?.map((message) => ({ role: message.role, content: message.content })),
          excludedDomains: normalizedExcludedDomainDetails.excludedDomains
            ?? queryRun.excludedDomains?.map((domain) => domain.trim().toLowerCase()).filter(Boolean),
          excludedDomainDetails: normalizedExcludedDomainDetails.excludedDomainDetails
        });
      }

      return runs;
    }, [])
    .slice(0, 1000);
}

export interface LeadAgentDataPaths {
  runtimeDataDirectory: string;
  seedDataDirectory: string;
  settingsPath: string;
  templatesPath: string;
  learningPath: string;
  latestLeadRunPath: string;
  latestOutreachReviewPath: string;
  apolloSearchCursorPath: string;
  companyScreeningDatabasePath: string;
  testLabExaCachePath: string;
  liveExaCachePath: string;
  cacheDatabaseDirectory: string;
  liveCacheDatabasePath: string;
  debugCacheDatabasePath: string;
  seedSettingsPath: string;
  seedTemplatesPath: string;
  seedLearningPath: string;
  seedLatestLeadRunPath: string;
  seedLatestOutreachReviewPath: string;
  seedApolloSearchCursorPath: string;
  seedCompanyScreeningDatabasePath: string;
  seedTestLabExaCachePath: string;
  seedLiveExaCachePath: string;
  seedCacheDatabaseDirectory: string;
  seedLiveCacheDatabasePath: string;
  seedDebugCacheDatabasePath: string;
}

export function resolveLeadAgentDataPaths(options: {
  cwd?: string;
  dataDirEnv?: string;
  cacheDirEnv?: string;
  railwayVolumeMountPath?: string;
  hasMountedDataDir?: boolean;
} = {}): LeadAgentDataPaths {
  const cwd = options.cwd ?? process.cwd();
  const seedDataDirectory = path.join(cwd, "data");
  const explicitRuntimeDataDirectory = options.dataDirEnv?.trim();
  const railwayVolumeMountPath = options.railwayVolumeMountPath?.trim();
  const runtimeDataDirectory = explicitRuntimeDataDirectory
    ? path.resolve(explicitRuntimeDataDirectory)
    : railwayVolumeMountPath
      ? path.resolve(railwayVolumeMountPath)
      : (options.hasMountedDataDir ?? existsSync(DEFAULT_RUNTIME_DATA_DIRECTORY))
        ? DEFAULT_RUNTIME_DATA_DIRECTORY
        : seedDataDirectory;
  const cacheDatabaseDirectory = options.cacheDirEnv?.trim()
    ? path.resolve(options.cacheDirEnv.trim())
    : path.join(runtimeDataDirectory, "cache-db");
  const seedCacheDatabaseDirectory = path.join(seedDataDirectory, "cache-db");

  return {
    runtimeDataDirectory,
    seedDataDirectory,
    settingsPath: path.join(runtimeDataDirectory, "lead-agent-settings.json"),
    templatesPath: path.join(runtimeDataDirectory, "outreach-templates.json"),
    learningPath: path.join(runtimeDataDirectory, "lead-agent-learning.json"),
    latestLeadRunPath: path.join(runtimeDataDirectory, "latest-lead-run.json"),
    latestOutreachReviewPath: path.join(runtimeDataDirectory, "latest-outreach-review.json"),
    apolloSearchCursorPath: path.join(runtimeDataDirectory, "apollo-search-cursors.json"),
    companyScreeningDatabasePath: path.join(runtimeDataDirectory, "company-screening-database.json"),
    testLabExaCachePath: path.join(runtimeDataDirectory, "testlab-exa-cache.json"),
    liveExaCachePath: path.join(runtimeDataDirectory, "live-exa-cache.json"),
    cacheDatabaseDirectory,
    liveCacheDatabasePath: path.join(cacheDatabaseDirectory, "live-run-cache.sqlite"),
    debugCacheDatabasePath: path.join(cacheDatabaseDirectory, "testlab-cache.sqlite"),
    seedSettingsPath: path.join(seedDataDirectory, "lead-agent-settings.json"),
    seedTemplatesPath: path.join(seedDataDirectory, "outreach-templates.json"),
    seedLearningPath: path.join(seedDataDirectory, "lead-agent-learning.json"),
    seedLatestLeadRunPath: path.join(seedDataDirectory, "latest-lead-run.json"),
    seedLatestOutreachReviewPath: path.join(seedDataDirectory, "latest-outreach-review.json"),
    seedApolloSearchCursorPath: path.join(seedDataDirectory, "apollo-search-cursors.json"),
    seedCompanyScreeningDatabasePath: path.join(seedDataDirectory, "company-screening-database.json"),
    seedTestLabExaCachePath: path.join(seedDataDirectory, "testlab-exa-cache.json"),
    seedLiveExaCachePath: path.join(seedDataDirectory, "live-exa-cache.json"),
    seedCacheDatabaseDirectory,
    seedLiveCacheDatabasePath: path.join(seedCacheDatabaseDirectory, "live-run-cache.sqlite"),
    seedDebugCacheDatabasePath: path.join(seedCacheDatabaseDirectory, "testlab-cache.sqlite")
  };
}

const controlPlanePaths = resolveLeadAgentDataPaths({
  dataDirEnv: process.env.LEAD_AGENT_DATA_DIR,
  cacheDirEnv: process.env.LEAD_AGENT_CACHE_DIR,
  railwayVolumeMountPath: process.env.RAILWAY_VOLUME_MOUNT_PATH
});

const usingPersistentRuntimeDataDirectory = controlPlanePaths.runtimeDataDirectory !== controlPlanePaths.seedDataDirectory;
if (usingPersistentRuntimeDataDirectory) {
  console.info(`[control-plane] Persistent runtime data directory: ${controlPlanePaths.runtimeDataDirectory}`);
} else {
  console.warn(
    "[control-plane] No persistent data volume detected. Runtime data is stored in the ephemeral repo 'data' directory "
    + "and will be lost on every redeploy (live Exa history, screening cache, etc. reset to 0). "
    + "Mount a Railway volume (sets RAILWAY_VOLUME_MOUNT_PATH) or set LEAD_AGENT_DATA_DIR to a persistent path."
  );
}

export function getLeadAgentRuntimeDataDirectory(): string {
  return controlPlanePaths.runtimeDataDirectory;
}

const openCrawlerTuningSchema = z.object({
  probeCount: z.number().int().min(1).max(200).optional(),
  maxPages: z.number().int().min(1).max(20).optional(),
  sampleMultiplier: z.number().int().min(1).max(20).optional(),
  minSampleSize: z.number().int().min(1).max(200).optional(),
  rawCollectionMultiplier: z.number().int().min(1).max(20).optional()
});

const settingsSchema = z.object({
  targetLeadCount: z.number().int().positive().max(1000),
  market: z.string().min(1),
  creditLessMode: z.boolean(),
  mainContext: z.string().max(12000).optional(),
  targetCategoryRefinement: z.string().max(4000).optional(),
  searchStrategyContext: z.string().max(12000).optional(),
  searchStrategyPreset: z.enum(["default", "optimized_vision_integrators"]).optional(),
  companySearchMode: z.enum(["internet_research", "open_crawler_search", "exa_search", "diffbot_search", "diffbot_test_data"]),
  prequalification: z.object({
    mainContext: z.string().max(6000).optional(),
    categoryContexts: z.object({
      integrator_vision_industrial_ai: z.object({
        classificationRules: z.array(z.string().min(1)).max(12).optional(),
        disqualifiers: z.array(z.string().min(1)).max(12).optional(),
        addOnContext: z.string().max(3000).optional()
      }).optional(),
      integrator_vision_ai_consulting: z.object({
        classificationRules: z.array(z.string().min(1)).max(12).optional(),
        disqualifiers: z.array(z.string().min(1)).max(12).optional(),
        addOnContext: z.string().max(3000).optional()
      }).optional(),
      integrator_vision_ai_freelancer: z.object({
        classificationRules: z.array(z.string().min(1)).max(12).optional(),
        disqualifiers: z.array(z.string().min(1)).max(12).optional(),
        addOnContext: z.string().max(3000).optional()
      }).optional(),
      integrator_general_ai: z.object({
        classificationRules: z.array(z.string().min(1)).max(12).optional(),
        disqualifiers: z.array(z.string().min(1)).max(12).optional(),
        addOnContext: z.string().max(3000).optional()
      }).optional(),
      integrator_relevant_focus: z.object({
        classificationRules: z.array(z.string().min(1)).max(12).optional(),
        disqualifiers: z.array(z.string().min(1)).max(12).optional(),
        addOnContext: z.string().max(3000).optional()
      }).optional(),
      industrial_end_customer_scaled: z.object({
        classificationRules: z.array(z.string().min(1)).max(12).optional(),
        disqualifiers: z.array(z.string().min(1)).max(12).optional(),
        addOnContext: z.string().max(3000).optional()
      }).optional(),
      camera_manufacturer_partner: z.object({
        classificationRules: z.array(z.string().min(1)).max(12).optional(),
        disqualifiers: z.array(z.string().min(1)).max(12).optional(),
        addOnContext: z.string().max(3000).optional()
      }).optional(),
      machine_builder_ai_enablement: z.object({
        classificationRules: z.array(z.string().min(1)).max(12).optional(),
        disqualifiers: z.array(z.string().min(1)).max(12).optional(),
        addOnContext: z.string().max(3000).optional()
      }).optional(),
      software_platform_embedding: z.object({
        classificationRules: z.array(z.string().min(1)).max(12).optional(),
        disqualifiers: z.array(z.string().min(1)).max(12).optional(),
        addOnContext: z.string().max(3000).optional()
      }).optional()
    }).optional()
  }).optional(),
  prequalificationContext: z.string().max(4000).optional(),
  executionContexts: z.object({
    integrator_vision_industrial_ai: z.object({
      researchPriorities: z.array(z.string().min(1)).max(12).optional(),
      outreachPriorities: z.array(z.string().min(1)).max(12).optional(),
      personalizationRules: z.array(z.string().min(1)).max(12).optional(),
      avoidSignals: z.array(z.string().min(1)).max(12).optional()
    }).optional(),
    integrator_vision_ai_consulting: z.object({
      researchPriorities: z.array(z.string().min(1)).max(12).optional(),
      outreachPriorities: z.array(z.string().min(1)).max(12).optional(),
      personalizationRules: z.array(z.string().min(1)).max(12).optional(),
      avoidSignals: z.array(z.string().min(1)).max(12).optional()
    }).optional(),
    integrator_vision_ai_freelancer: z.object({
      researchPriorities: z.array(z.string().min(1)).max(12).optional(),
      outreachPriorities: z.array(z.string().min(1)).max(12).optional(),
      personalizationRules: z.array(z.string().min(1)).max(12).optional(),
      avoidSignals: z.array(z.string().min(1)).max(12).optional()
    }).optional(),
    integrator_general_ai: z.object({
      researchPriorities: z.array(z.string().min(1)).max(12).optional(),
      outreachPriorities: z.array(z.string().min(1)).max(12).optional(),
      personalizationRules: z.array(z.string().min(1)).max(12).optional(),
      avoidSignals: z.array(z.string().min(1)).max(12).optional()
    }).optional(),
    integrator_relevant_focus: z.object({
      researchPriorities: z.array(z.string().min(1)).max(12).optional(),
      outreachPriorities: z.array(z.string().min(1)).max(12).optional(),
      personalizationRules: z.array(z.string().min(1)).max(12).optional(),
      avoidSignals: z.array(z.string().min(1)).max(12).optional()
    }).optional(),
    industrial_end_customer_scaled: z.object({
      researchPriorities: z.array(z.string().min(1)).max(12).optional(),
      outreachPriorities: z.array(z.string().min(1)).max(12).optional(),
      personalizationRules: z.array(z.string().min(1)).max(12).optional(),
      avoidSignals: z.array(z.string().min(1)).max(12).optional()
    }).optional(),
    camera_manufacturer_partner: z.object({
      researchPriorities: z.array(z.string().min(1)).max(12).optional(),
      outreachPriorities: z.array(z.string().min(1)).max(12).optional(),
      personalizationRules: z.array(z.string().min(1)).max(12).optional(),
      avoidSignals: z.array(z.string().min(1)).max(12).optional()
    }).optional(),
    machine_builder_ai_enablement: z.object({
      researchPriorities: z.array(z.string().min(1)).max(12).optional(),
      outreachPriorities: z.array(z.string().min(1)).max(12).optional(),
      personalizationRules: z.array(z.string().min(1)).max(12).optional(),
      avoidSignals: z.array(z.string().min(1)).max(12).optional()
    }).optional(),
    software_platform_embedding: z.object({
      researchPriorities: z.array(z.string().min(1)).max(12).optional(),
      outreachPriorities: z.array(z.string().min(1)).max(12).optional(),
      personalizationRules: z.array(z.string().min(1)).max(12).optional(),
      avoidSignals: z.array(z.string().min(1)).max(12).optional()
    }).optional()
  }).optional(),
  targetCategories: z.array(selectableCategorySchema).min(1).optional(),
  runDeepResearch: z.boolean(),
  dryRun: z.boolean(),
  syncToHubSpot: z.boolean().optional(),
  exaApiKey: z.string().optional(),
  diffbotToken: z.string().optional(),
  exaQueryCount: z.number().int().min(1).max(50).optional(),
  useAzureQueryPlanner: z.boolean().optional(),
  useExaExcludeDomains: z.boolean().optional(),
  excludePreviouslyFoundExaDomains: z.boolean().optional(),
  useExaCompanyCategory: z.boolean().optional(),
  maxRuntimeMs: z.number().int().min(60_000).max(10_800_000).optional(),
  aiPrefilterConcurrency: z.number().int().min(1).optional(),
  outreachPrepConcurrency: z.number().int().min(1).optional(),
  contactSearchConcurrency: z.number().int().min(1).optional(),
  earlyStopEnabled: z.boolean(),
  earlyStopReviewCount: z.number().int().min(5).max(30),
  earlyStopThreshold: z.number().min(0).max(1),
  earlyStopMinRelevantCount: z.number().int().min(0).max(30).optional(),
  openCrawlerTuning: openCrawlerTuningSchema.optional()
});

const settingsUpdateSchema = settingsSchema.partial();

const templateSchema = z.object({
  key: z.string().min(1),
  audience: z.string().min(1),
  goal: z.string().min(1),
  subject: z.string().min(1),
  emailBody: z.string().min(1),
  linkedInConnectionRequest: z.string().min(1),
  linkedInMessage: z.string().min(1),
  phoneScript: z.string().min(1)
});

const templateUpdateSchema = templateSchema.omit({ key: true }).partial();
const templateRecordSchema = z.record(templateSchema);

const companyFeedbackSchema = z.object({
  companyName: z.string().min(1),
  domain: z.string().optional(),
  verdict: z.enum(["accept", "reject"]),
  reason: z.string().min(1),
  createdAt: z.string().min(1)
});

const filterLearningStatSchema = z.object({
  runs: z.number().int().nonnegative(),
  averageRelevanceRatio: z.number().min(0).max(1),
  earlyStopCount: z.number().int().nonnegative()
});

const leadCategorySchema = z.enum([
  "integrator_vision_industrial_ai",
  "integrator_vision_ai_consulting",
  "integrator_vision_ai_freelancer",
  "integrator_general_ai",
  "integrator_relevant_focus",
  "industrial_end_customer_scaled",
  "camera_manufacturer_partner",
  "machine_builder_ai_enablement",
  "software_platform_embedding",
  "irrelevant",
  "other"
]);

const searchHistoryEntrySchema = z.object({
  timestamp: z.string().min(1),
  companySearchMode: z.enum(["internet_research", "open_crawler_search", "exa_search", "diffbot_search", "diffbot_test_data"]),
  filterSnapshot: z.object({
    persona: z.string().min(1),
    industries: z.array(z.string().min(1)),
    keywords: z.array(z.string().min(1)),
    locations: z.array(z.string().min(1)),
    employeeRanges: z.array(z.string().min(1)),
    notes: z.string().min(1)
  }).optional(),
  targetCategory: leadCategorySchema.optional(),
  batchType: z.enum(["probe_15", "expand_50"]),
  page: z.number().int().positive(),
  requestedCount: z.number().int().positive(),
  returnedCount: z.number().int().nonnegative(),
  relevantCount: z.number().int().nonnegative(),
  relevanceRatio: z.number().min(0).max(1),
  categoryBreakdown: z.record(leadCategorySchema, z.number().int().nonnegative()),
  passedThreshold: z.boolean(),
  recommendation: z.string().min(1),
  fetchedSampleCount: z.number().int().nonnegative().optional(),
  eligibleSampleCount: z.number().int().nonnegative().optional(),
  discoveryQueries: z.array(z.string().min(1)).optional(),
  plannedQueries: z.array(z.string().min(1)).optional(),
  promptMessages: z.array(z.object({
    role: z.string().min(1),
    content: z.string()
  })).optional(),
  excludedDomains: z.array(z.string().min(1)).optional(),
  queryStats: z.array(z.object({
    query: z.string().min(1),
    rawFound: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    rejectedDifferentCategory: z.number().int().nonnegative(),
    rejectedOther: z.number().int().nonnegative(),
    categoryBreakdown: z.record(leadCategorySchema, z.number().int().nonnegative())
  })).optional(),
  dropOffSummary: z.object({
    filteredByPriorFeedback: z.number().int().nonnegative(),
    filteredByCache: z.number().int().nonnegative(),
    filteredByHubSpot: z.number().int().nonnegative(),
    categorizedIrrelevant: z.number().int().nonnegative(),
    categorizedOther: z.number().int().nonnegative()
  }).optional(),
  decisionSamples: z.array(z.object({
    companyName: z.string().min(1),
    domain: z.string().optional(),
    sourceFilter: z.string().optional(),
    discoveryQuery: z.string().optional(),
    category: leadCategorySchema,
    relevanceScore: z.number().min(0).max(100),
    rationale: z.string().min(1)
  })).optional()
});

const searchModeLearningSchema = z.object({
  filterPerformance: z.record(filterLearningStatSchema),
  searchHistory: z.array(searchHistoryEntrySchema)
});

const leadLearningSchema = z.object({
  companyFeedback: z.array(companyFeedbackSchema),
  filterPerformance: z.record(filterLearningStatSchema),
  searchHistory: z.array(searchHistoryEntrySchema),
  searchHistoryByMode: z.object({
    internet_research: searchModeLearningSchema.optional(),
    open_crawler_search: searchModeLearningSchema.optional(),
    apollo_search: searchModeLearningSchema.optional(),
    exa_search: searchModeLearningSchema.optional(),
    diffbot_search: searchModeLearningSchema.optional(),
    diffbot_test_data: searchModeLearningSchema.optional()
  }).optional()
});

const latestLeadRunSchema = z.object({
  createdAt: z.string().min(1),
  requested: z.any(),
  summary: z.object({
    foundCandidates: z.number().int().nonnegative(),
    filtersTested: z.number().int().nonnegative(),
    filtersStoppedEarly: z.number().int().nonnegative(),
    companiesSkippedAfterEarlyStop: z.number().int().nonnegative(),
    funnel: z.object({
      crawledPages: z.number().int().nonnegative(),
      afterCrawlerPrefilter: z.number().int().nonnegative(),
      afterHubSpotDedup: z.number().int().nonnegative(),
      afterAzureAICheck: z.number().int().nonnegative(),
      syncedToHubSpot: z.number().int().nonnegative()
    }).optional(),
    timedOut: z.boolean().optional(),
    stopped: z.boolean().optional(),
    completionReason: z.string().min(1).optional()
  }),
  contacts: z.array(z.any()),
  searchHistory: z.array(searchHistoryEntrySchema),
  hubspotSync: z.object({
    attempted: z.boolean(),
    mode: z.enum(["dry-run", "live"]),
    candidateCount: z.number().int().nonnegative(),
    syncedCount: z.number().int().nonnegative(),
    companySyncedCount: z.number().int().nonnegative(),
    contactSyncedCount: z.number().int().nonnegative(),
    errors: z.array(z.string().min(1)).optional()
  }).optional(),
  costs: z.object({
    azure: z.object({
      requests: z.number().int().nonnegative(),
      promptTokens: z.number().int().nonnegative(),
      completionTokens: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative(),
      estimatedCostUsd: z.number().nonnegative()
    }).optional()
  }).optional()
});

const searchCursorSchema = z.record(z.object({
  nextPage: z.number().int().positive(),
  updatedAt: z.string().min(1)
}));

const apolloSearchCursorSchema = searchCursorSchema;

const companyScreeningRecordSchema = z.object({
  companyName: z.string().min(1),
  normalizedName: z.string().min(1),
  domain: z.string().optional(),
  normalizedDomain: z.string().optional(),
  category: z.enum([
    "integrator_vision_industrial_ai",
    "integrator_vision_ai_consulting",
    "integrator_vision_ai_freelancer",
    "integrator_general_ai",
    "integrator_relevant_focus",
    "industrial_end_customer_scaled",
    "camera_manufacturer_partner",
    "machine_builder_ai_enablement",
    "software_platform_embedding",
    "irrelevant",
    "other"
  ]).optional(),
  relevanceScore: z.number().min(0).max(100).optional(),
  rationale: z.string().optional(),
  sourceFilter: z.string().optional(),
  shortDescription: z.string().optional(),
  checkedAt: z.string().optional(),
  existsInHubSpot: z.boolean().optional(),
  hubspotCheckedAt: z.string().optional()
});

const companyScreeningDatabaseSchema = z.object({
  records: z.array(companyScreeningRecordSchema)
});

const exaQueryHistoryInsightSchema = z.object({
  query: z.string().min(1),
  timestamp: z.string().optional(),
  detectedCategories: z.array(leadCategorySchema).optional(),
  foundCategoryBreakdown: z.record(leadCategorySchema, z.number().int().nonnegative()).optional(),
  excludedDomains: z.array(z.string().min(1)).optional(),
  excludedDomainDetails: z.array(z.object({
    domain: z.string().min(1),
    category: z.enum(["hubspot", "rejected_website", "current_run_cache", "historical_exa"]),
    includedInRequest: z.boolean(),
    requestIndex: z.number().int().nonnegative().optional(),
    recentOccurrences: z.number().int().nonnegative().optional(),
    recentPriority: z.number().int().nonnegative().optional(),
    recentLastSeenAt: z.string().min(1).optional(),
    occurrences: z.number().int().nonnegative().optional(),
    priority: z.number().int().nonnegative().optional(),
    lastSeenAt: z.string().min(1).optional()
  })).optional(),
  note: z.string().optional()
});

const testLabExaCacheSchema = z.object({
  queryHistory: z.array(z.string().min(1)),
  queryInsights: z.array(exaQueryHistoryInsightSchema).optional(),
  discoveredDomains: z.array(z.string().min(1))
});

const rawExaHistoryEntrySchema = z.object({
  timestamp: z.string().min(1),
  domain: z.string().min(1),
  companyName: z.string().min(1).optional(),
  discoveryQuery: z.string().min(1).optional(),
  sourceFilter: z.string().min(1).optional()
});

const liveExaQueryRunSchema = z.object({
  timestamp: z.string().min(1),
  filterName: z.string().min(1),
  query: z.string().min(1),
  plannedQueries: z.array(z.string().min(1)).optional(),
  promptMessages: z.array(z.object({
    role: z.string().min(1),
    content: z.string()
  })).optional(),
  excludedDomains: z.array(z.string().min(1)).optional(),
  excludedDomainDetails: z.array(z.object({
    domain: z.string().min(1),
    category: z.enum(["hubspot", "rejected_website", "current_run_cache", "historical_exa"]),
    includedInRequest: z.boolean(),
    requestIndex: z.number().int().nonnegative().optional(),
    recentOccurrences: z.number().int().nonnegative().optional(),
    recentPriority: z.number().int().nonnegative().optional(),
    recentLastSeenAt: z.string().min(1).optional(),
    occurrences: z.number().int().nonnegative().optional(),
    priority: z.number().int().nonnegative().optional(),
    lastSeenAt: z.string().min(1).optional()
  })).optional()
});

const liveExaRecurringDomainSchema = z.object({
  domain: z.string().min(1),
  occurrences: z.number().int().positive(),
  priority: z.number().int().positive(),
  lastSeenAt: z.string().min(1),
  companyName: z.string().min(1).optional(),
  discoveryQuery: z.string().min(1).optional(),
  sourceFilter: z.string().min(1).optional()
});

const liveExaCacheSchema = z.object({
  entries: z.array(rawExaHistoryEntrySchema),
  discoveredDomains: z.array(z.string().min(1)),
  recentRecurringDomains: z.array(liveExaRecurringDomainSchema).optional(),
  recurringDomains: z.array(liveExaRecurringDomainSchema).optional(),
  queryRuns: z.array(liveExaQueryRunSchema).optional()
});

type ScreeningCacheScope = "all" | "live" | "debug";
type CacheDatabaseScope = "live" | "debug";

const defaultSettings: LeadAgentSettings = {
  targetLeadCount: 20,
  market: "DE",
  mainContext: DEFAULT_MAIN_CONTEXT,
  targetCategoryRefinement: "",
  searchStrategyContext: DEFAULT_SEARCH_STRATEGY_CONTEXT,
  searchStrategyPreset: "default",
  companySearchMode: "exa_search",
  creditLessMode: true,
  prequalification: {
    mainContext: DEFAULT_PREQUALIFICATION_MAIN_CONTEXT,
    categoryContexts: DEFAULT_PREQUALIFICATION_CATEGORY_CONTEXTS
  },
  executionContexts: {
    integrator_vision_industrial_ai: CATEGORY_EXECUTION_CONTEXT.integrator_vision_industrial_ai,
    integrator_vision_ai_consulting: CATEGORY_EXECUTION_CONTEXT.integrator_vision_ai_consulting,
    integrator_vision_ai_freelancer: CATEGORY_EXECUTION_CONTEXT.integrator_vision_ai_freelancer,
    integrator_general_ai: CATEGORY_EXECUTION_CONTEXT.integrator_general_ai,
    integrator_relevant_focus: CATEGORY_EXECUTION_CONTEXT.integrator_relevant_focus,
    industrial_end_customer_scaled: CATEGORY_EXECUTION_CONTEXT.industrial_end_customer_scaled,
    camera_manufacturer_partner: CATEGORY_EXECUTION_CONTEXT.camera_manufacturer_partner,
    machine_builder_ai_enablement: CATEGORY_EXECUTION_CONTEXT.machine_builder_ai_enablement,
    software_platform_embedding: CATEGORY_EXECUTION_CONTEXT.software_platform_embedding
  },
  targetCategories: [
    "integrator_vision_industrial_ai",
    "integrator_vision_ai_consulting",
    "integrator_vision_ai_freelancer",
    "integrator_general_ai",
  ],
  runDeepResearch: true,
  dryRun: false,
  syncToHubSpot: true,
  exaQueryCount: 4,
  useAzureQueryPlanner: true,
  useExaExcludeDomains: true,
  excludePreviouslyFoundExaDomains: true,
  useExaCompanyCategory: false,
  maxRuntimeMs: 600_000,
  earlyStopEnabled: false,
  earlyStopReviewCount: 20,
  earlyStopThreshold: 0.15,
  earlyStopMinRelevantCount: 2
};

const defaultLearning: LeadLearningData = {
  companyFeedback: [],
  filterPerformance: {},
  searchHistory: [],
  searchHistoryByMode: {}
};

const defaultLatestLeadRun: LatestLeadRunRecord = {
  createdAt: new Date(0).toISOString(),
  requested: {
    targetLeadCount: 0
  },
  summary: {
    foundCandidates: 0,
    filtersTested: 0,
    filtersStoppedEarly: 0,
    companiesSkippedAfterEarlyStop: 0,
    funnel: {
      crawledPages: 0,
      afterCrawlerPrefilter: 0,
      afterHubSpotDedup: 0,
      afterAzureAICheck: 0,
      syncedToHubSpot: 0
    },
    timedOut: false
  },
  contacts: [],
  searchHistory: []
};

const defaultCompanyScreeningDatabase: CompanyScreeningDatabase = {
  records: []
};

const defaultTestLabExaCache = {
  queryHistory: [],
  queryInsights: [],
  discoveredDomains: []
};

const defaultLiveExaCache: LiveExaCache = {
  entries: [],
  discoveredDomains: [],
  recentRecurringDomains: [],
  recurringDomains: [],
  queryRuns: []
};

const MAX_RECENT_LIVE_EXA_QUERY_RUNS = 50;

export function buildLiveExaRecurringDomains(
  entries: RawExaHistoryEntry[],
  fallbackDomains: string[] = []
): NonNullable<LiveExaCache["recurringDomains"]> {
  const recurringByDomain = new Map<string, NonNullable<LiveExaCache["recurringDomains"]>[number]>();

  for (const entry of entries) {
    const domain = entry.domain?.trim().toLowerCase();
    if (!domain) {
      continue;
    }

    const timestamp = entry.timestamp?.trim() || new Date(0).toISOString();
    const existing = recurringByDomain.get(domain);
    if (!existing) {
      recurringByDomain.set(domain, {
        domain,
        occurrences: 1,
        priority: 1,
        lastSeenAt: timestamp,
        companyName: entry.companyName,
        discoveryQuery: entry.discoveryQuery,
        sourceFilter: entry.sourceFilter
      });
      continue;
    }

    existing.occurrences += 1;
    existing.priority += 1;
    if (Date.parse(timestamp) >= Date.parse(existing.lastSeenAt)) {
      existing.lastSeenAt = timestamp;
      existing.companyName = entry.companyName ?? existing.companyName;
      existing.discoveryQuery = entry.discoveryQuery ?? existing.discoveryQuery;
      existing.sourceFilter = entry.sourceFilter ?? existing.sourceFilter;
    }
  }

  for (const domainValue of fallbackDomains) {
    const domain = domainValue?.trim().toLowerCase();
    if (!domain || recurringByDomain.has(domain)) {
      continue;
    }

    recurringByDomain.set(domain, {
      domain,
      occurrences: 1,
      priority: 1,
      lastSeenAt: new Date(0).toISOString()
    });
  }

  return Array.from(recurringByDomain.values())
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
    .slice(0, 2000);
}

/**
 * Merges the persistent per-domain occurrence counter (primary, authoritative cross-run
 * historical signal) with the entries-derived recurring domains (legacy/backward-compat).
 * The persistent counter wins on occurrence counts; legacy-only domains are unioned in.
 */
export function mergeLiveExaRecurringDomains(
  persistedOccurrences: LiveExaRecurringDomain[],
  entriesRecurringDomains: LiveExaRecurringDomain[]
): NonNullable<LiveExaCache["recurringDomains"]> {
  const mergedByDomain = new Map<string, LiveExaRecurringDomain>();

  for (const recurring of entriesRecurringDomains) {
    const domain = recurring.domain?.trim().toLowerCase();
    if (domain) {
      mergedByDomain.set(domain, { ...recurring, domain });
    }
  }

  for (const occurrence of persistedOccurrences) {
    const domain = occurrence.domain?.trim().toLowerCase();
    if (!domain) {
      continue;
    }

    const existing = mergedByDomain.get(domain);
    const occurrences = Math.max(occurrence.occurrences, existing?.occurrences ?? 0);
    const lastSeenAt = existing?.lastSeenAt && Date.parse(existing.lastSeenAt) > Date.parse(occurrence.lastSeenAt)
      ? existing.lastSeenAt
      : occurrence.lastSeenAt;
    mergedByDomain.set(domain, {
      domain,
      occurrences,
      priority: occurrences,
      lastSeenAt,
      companyName: occurrence.companyName ?? existing?.companyName,
      discoveryQuery: occurrence.discoveryQuery ?? existing?.discoveryQuery,
      sourceFilter: occurrence.sourceFilter ?? existing?.sourceFilter
    });
  }

  return Array.from(mergedByDomain.values())
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
    .slice(0, 2000);
}

export function buildRecentLiveExaRecurringDomains(
  entries: RawExaHistoryEntry[],
  queryRuns: NonNullable<LiveExaCache["queryRuns"]> = []
): NonNullable<LiveExaCache["recentRecurringDomains"]> {
  const recentRunTimestamps = queryRuns
    .slice(0, MAX_RECENT_LIVE_EXA_QUERY_RUNS)
    .map((queryRun) => Date.parse(queryRun.timestamp))
    .filter((timestamp) => Number.isFinite(timestamp));

  if (recentRunTimestamps.length === 0) {
    return [];
  }

  const cutoffTimestamp = Math.min(...recentRunTimestamps);
  const recentEntries = entries.filter((entry) => {
    const timestamp = Date.parse(entry.timestamp);
    return Number.isFinite(timestamp) && timestamp >= cutoffTimestamp;
  });

  return buildLiveExaRecurringDomains(recentEntries);
}

const suggestedControls = [
  "targetLeadCount",
  "market",
  "mainContext",
  "searchStrategyContext",
  "searchStrategyPreset",
  "companySearchMode",
  "prequalification.mainContext",
  "prequalification.categoryContexts",
  "executionContexts",
  "targetCategories",
  "runDeepResearch",
  "dryRun",
  "syncToHubSpot",
  "exaApiKey",
  "diffbotToken",
  "exaQueryCount",
  "useAzureQueryPlanner",
  "useExaExcludeDomains",
  "excludePreviouslyFoundExaDomains",
  "useExaCompanyCategory",
  "maxRuntimeMs",
  "earlyStopEnabled",
  "earlyStopReviewCount",
  "earlyStopThreshold",
  "earlyStopMinRelevantCount",
  "active ICP segment per campaign",
  "negative keyword rules",
  "personalization strictness"
];

async function ensureFile<T>(filePath: string, defaultValue: T, seedPath: string = filePath): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  try {
    await fs.access(filePath);
  } catch {
    if (filePath !== seedPath && existsSync(seedPath)) {
      await fs.copyFile(seedPath, filePath);
      return;
    }

    await fs.writeFile(filePath, `${JSON.stringify(defaultValue, null, 2)}\n`, "utf8");
  }
}

async function ensureSeededCacheDatabase(filePath: string, seedPath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  try {
    await fs.access(filePath);
  } catch {
    if (filePath !== seedPath && existsSync(seedPath)) {
      await fs.copyFile(seedPath, filePath);
    }
  }
}

async function recoverCorruptedJsonFile<T>(filePath: string, defaultValue: T): Promise<T> {
  const corruptedContent = await fs.readFile(filePath, "utf8");
  const backupPath = `${filePath}.corrupt-${Date.now()}`;

  await fs.writeFile(backupPath, corruptedContent, "utf8");
  await writeJsonFile(filePath, defaultValue);

  return defaultValue;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

export async function readJsonFileWithRecovery<T>(filePath: string, defaultValue: T): Promise<T> {
  try {
    return await readJsonFile<T>(filePath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return recoverCorruptedJsonFile(filePath, defaultValue);
    }

    throw error;
  }
}

async function writeJsonFile<T>(filePath: string, value: T): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export class ControlPlaneStore {
  private readonly liveCacheDatabase = new CacheDatabaseStore(controlPlanePaths.liveCacheDatabasePath);
  private readonly debugCacheDatabase = new CacheDatabaseStore(controlPlanePaths.debugCacheDatabasePath);

  private normalizeLegacyCategory(category: string | undefined): string | undefined {
    if (category === "integrator_vision_ai_consulting_freelancer") {
      return "integrator_vision_ai_consulting";
    }

    return category;
  }

  private normalizeLegacyCategoryRecord<T extends Record<string, unknown> | undefined>(record: T): T {
    if (!record || typeof record !== "object") {
      return record;
    }

    const normalized = { ...record } as Record<string, unknown>;
    const legacyValue = normalized.integrator_vision_ai_consulting_freelancer;

    if (legacyValue !== undefined && normalized.integrator_vision_ai_consulting === undefined) {
      normalized.integrator_vision_ai_consulting = legacyValue;
    }

    delete normalized.integrator_vision_ai_consulting_freelancer;
    return normalized as T;
  }

  private normalizeSearchHistoryEntry(entry: SearchHistoryEntry): SearchHistoryEntry {
    const emptyCategoryBreakdown = Object.fromEntries(
      leadCategorySchema.options.map((category) => [category, 0])
    ) as SearchHistoryEntry["categoryBreakdown"];

    return {
      ...entry,
      companySearchMode: entry.companySearchMode ?? "open_crawler_search",
      targetCategory: this.normalizeLegacyCategory(entry.targetCategory) as SearchHistoryEntry["targetCategory"],
      plannedQueries: entry.plannedQueries?.map((query) => query.trim()).filter(Boolean),
      promptMessages: entry.promptMessages?.map((message) => ({
        role: message.role,
        content: message.content
      })),
      excludedDomains: entry.excludedDomains?.map((domain) => domain.trim().toLowerCase()).filter(Boolean),
      queryStats: (entry.queryStats ?? []).map((queryStat) => ({
        query: queryStat.query,
        returnedResults: queryStat.returnedResults ?? 0,
        filteredByExcludedDomains: queryStat.filteredByExcludedDomains ?? 0,
        rawFound: queryStat.rawFound ?? 0,
        duplicates: queryStat.duplicates ?? 0,
        accepted: queryStat.accepted ?? 0,
        rejectedDifferentCategory: queryStat.rejectedDifferentCategory ?? 0,
        rejectedOther: queryStat.rejectedOther ?? 0,
        categoryBreakdown: {
          ...emptyCategoryBreakdown,
          ...(queryStat.categoryBreakdown ?? {})
        }
      })),
      categoryBreakdown: {
        ...emptyCategoryBreakdown,
        ...(entry.categoryBreakdown ?? {})
      }
    };
  }

  private normalizeCompanyScreeningRecord(record: CompanyScreeningRecord): CompanyScreeningRecord {
    return {
      ...record,
      category: this.normalizeLegacyCategory(record.category) as CompanyScreeningRecord["category"]
    };
  }

  private async ensureSeedData(): Promise<void> {
    await ensureFile(controlPlanePaths.settingsPath, defaultSettings, controlPlanePaths.seedSettingsPath);
    await ensureFile(controlPlanePaths.templatesPath, OUTREACH_TEMPLATES, controlPlanePaths.seedTemplatesPath);
    await ensureFile(controlPlanePaths.learningPath, defaultLearning, controlPlanePaths.seedLearningPath);
    await ensureFile(controlPlanePaths.latestLeadRunPath, defaultLatestLeadRun, controlPlanePaths.seedLatestLeadRunPath);
    await ensureFile(controlPlanePaths.latestOutreachReviewPath, defaultLatestLeadRun, controlPlanePaths.seedLatestOutreachReviewPath);
    await ensureFile(controlPlanePaths.apolloSearchCursorPath, {}, controlPlanePaths.seedApolloSearchCursorPath);
    await ensureFile(controlPlanePaths.companyScreeningDatabasePath, defaultCompanyScreeningDatabase, controlPlanePaths.seedCompanyScreeningDatabasePath);
    await ensureFile(controlPlanePaths.testLabExaCachePath, defaultTestLabExaCache, controlPlanePaths.seedTestLabExaCachePath);
    await ensureFile(controlPlanePaths.liveExaCachePath, defaultLiveExaCache, controlPlanePaths.seedLiveExaCachePath);
    await ensureSeededCacheDatabase(controlPlanePaths.liveCacheDatabasePath, controlPlanePaths.seedLiveCacheDatabasePath);
    await ensureSeededCacheDatabase(controlPlanePaths.debugCacheDatabasePath, controlPlanePaths.seedDebugCacheDatabasePath);
  }

  private getSearchCursorKey(filter: OrganizationFilter): string {
    return JSON.stringify({
      persona: filter.persona,
      industries: [...filter.industries].sort(),
      keywords: [...filter.keywords].sort(),
      locations: [...filter.locations].sort(),
      employeeRanges: [...filter.employeeRanges].sort(),
      notes: filter.notes,
      targetCategories: [...(filter.targetCategories ?? [])].sort()
    });
  }

  async getSettings(): Promise<LeadAgentSettings> {
    await this.ensureSeedData();
    const settings = await readJsonFile<Partial<LeadAgentSettings> & { prequalificationContext?: string }>(controlPlanePaths.settingsPath);
    const normalizedCompanySearchMode = settings.companySearchMode ?? defaultSettings.companySearchMode;

    const normalizedPrequalification = {
      ...defaultSettings.prequalification,
      ...(settings.prequalification ?? {}),
      mainContext:
        settings.prequalification?.mainContext ?? settings.prequalificationContext ?? defaultSettings.prequalification?.mainContext,
      categoryContexts: {
        ...defaultSettings.prequalification?.categoryContexts,
        ...this.normalizeLegacyCategoryRecord(settings.prequalification?.categoryContexts)
      }
    };

    const normalizedExecutionContexts = {
      ...defaultSettings.executionContexts,
      ...this.normalizeLegacyCategoryRecord(settings.executionContexts)
    };

    const normalizedTargetCategories = (settings.targetCategories ?? defaultSettings.targetCategories)
      ?.map((category) => this.normalizeLegacyCategory(category))
      .filter((category): category is SelectableLeadCategory => Boolean(category));

    return settingsSchema.parse({
      ...defaultSettings,
      ...settings,
      companySearchMode: normalizedCompanySearchMode,
      creditLessMode: true,
      prequalification: normalizedPrequalification,
      executionContexts: normalizedExecutionContexts,
      targetCategories: normalizedTargetCategories,
      openCrawlerTuning: settings.openCrawlerTuning ?? defaultSettings.openCrawlerTuning,
      maxRuntimeMs: settings.maxRuntimeMs ?? defaultSettings.maxRuntimeMs
    });
  }

  async updateSettings(input: Partial<LeadAgentSettings>): Promise<LeadAgentSettings> {
    const currentSettings = await this.getSettings();
    const parsedInput = settingsUpdateSchema.parse(input);
    const normalizedCompanySearchMode = parsedInput.companySearchMode ?? currentSettings.companySearchMode;
    const nextSettings = settingsSchema.parse({
      ...currentSettings,
      ...parsedInput,
      companySearchMode: normalizedCompanySearchMode,
      creditLessMode: true
    });

    await writeJsonFile(controlPlanePaths.settingsPath, nextSettings);
    return nextSettings;
  }

  async getTemplates(): Promise<Record<string, OutreachTemplate>> {
    await this.ensureSeedData();
    const templates = await readJsonFile<Record<string, OutreachTemplate>>(controlPlanePaths.templatesPath);
    const mergedTemplates = Object.fromEntries(
      Object.entries(OUTREACH_TEMPLATES).map(([key, template]) => [
        key,
        {
          ...template,
          ...(templates[key] ?? {})
        }
      ])
    );

    const supportedTemplateKeys = new Set(Object.keys(OUTREACH_TEMPLATES));
    const sanitizedTemplates = templateRecordSchema.parse(
      Object.fromEntries(
        Object.entries(mergedTemplates).filter(([key]) => supportedTemplateKeys.has(key))
      )
    );

    const persistedTemplateKeys = Object.keys(templates);
    const expectedTemplateKeys = Object.keys(sanitizedTemplates);
    const hasLegacyKeys = persistedTemplateKeys.some((key) => !supportedTemplateKeys.has(key));
    const missingCurrentKeys = expectedTemplateKeys.some((key) => !persistedTemplateKeys.includes(key));

    if (hasLegacyKeys || missingCurrentKeys) {
      await writeJsonFile(controlPlanePaths.templatesPath, sanitizedTemplates);
    }

    return sanitizedTemplates;
  }

  async getLearning(): Promise<LeadLearningData> {
    await this.ensureSeedData();
    const learning = await readJsonFile<Partial<LeadLearningData>>(controlPlanePaths.learningPath);
    const normalizedSearchHistoryByMode = Object.fromEntries(
      Object.entries(learning.searchHistoryByMode ?? {}).map(([mode, modeLearning]) => [
        mode,
        {
          filterPerformance: modeLearning?.filterPerformance ?? {},
          searchHistory: (modeLearning?.searchHistory ?? []).map((entry) => this.normalizeSearchHistoryEntry(entry))
        }
      ])
    ) as NonNullable<LeadLearningData["searchHistoryByMode"]>;
    const flattenedSearchHistory = Object.values(normalizedSearchHistoryByMode)
      .flatMap((modeLearning) => modeLearning.searchHistory)
      .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
      .slice(0, 300) as SearchHistoryEntry[];
    const flattenedFilterPerformance = Object.fromEntries(
      Object.entries(normalizedSearchHistoryByMode).flatMap(([mode, modeLearning]) =>
        Object.entries(modeLearning.filterPerformance).map(([filterName, stats]) => [`${mode} :: ${filterName}`, stats])
      )
    );

    return leadLearningSchema.parse({
      ...defaultLearning,
      ...learning,
      filterPerformance: flattenedFilterPerformance,
      searchHistory: flattenedSearchHistory,
      searchHistoryByMode: normalizedSearchHistoryByMode
    }) as LeadLearningData;
  }

  async getLatestLeadRun(): Promise<LatestLeadRunRecord> {
    await this.ensureSeedData();
    const latestLeadRun = await readJsonFile<LatestLeadRunRecord>(controlPlanePaths.latestLeadRunPath);
    return latestLeadRunSchema.parse({
      ...latestLeadRun,
      contacts: latestLeadRun.contacts.map((contact) => ({
        ...contact,
        category: this.normalizeLegacyCategory(contact.category) as typeof contact.category
      })),
      searchHistory: latestLeadRun.searchHistory.map((entry) => this.normalizeSearchHistoryEntry(entry))
    }) as LatestLeadRunRecord;
  }

  async clearLatestLeadRunSearchHistory(companySearchMode?: CompanySearchMode): Promise<LatestLeadRunRecord> {
    const latestLeadRun = await this.getLatestLeadRun();
    if (companySearchMode && latestLeadRun.requested?.companySearchMode && latestLeadRun.requested.companySearchMode !== companySearchMode) {
      return latestLeadRun;
    }

    const nextLatestLeadRun: LatestLeadRunRecord = {
      ...latestLeadRun,
      searchHistory: []
    };

    await this.writeLatestLeadRun(nextLatestLeadRun);
    return nextLatestLeadRun;
  }

  async getCompanyScreeningDatabase(): Promise<CompanyScreeningDatabase> {
    const [liveDatabase, debugDatabase] = await Promise.all([
      this.readScreeningDatabaseForScope("live"),
      this.readScreeningDatabaseForScope("debug")
    ]);

    const database = {
      records: [...liveDatabase.records, ...debugDatabase.records]
    };

    return companyScreeningDatabaseSchema.parse({
      ...defaultCompanyScreeningDatabase,
      ...database,
      records: (database.records ?? []).map((record) => this.normalizeCompanyScreeningRecord(record))
    });
  }

  async writeCompanyScreeningDatabase(database: CompanyScreeningDatabase): Promise<void> {
    const normalizedRecords = this.normalizeCompanyScreeningRecords(database.records);
    const liveRecords = normalizedRecords.filter((record) => !this.isDebugScreeningRecord(record.sourceFilter));
    const debugRecords = normalizedRecords.filter((record) => this.isDebugScreeningRecord(record.sourceFilter));

    await Promise.all([
      this.writeScreeningDatabaseForScope("live", { records: liveRecords }),
      this.writeScreeningDatabaseForScope("debug", { records: debugRecords })
    ]);
  }

  async getTestLabExaCache(): Promise<{ queryHistory: string[]; queryInsights: ExaQueryHistoryInsight[]; discoveredDomains: string[] }> {
    const cache = await this.readTestLabExaCacheFromDatabase();
    const parsed = testLabExaCacheSchema.parse({
      ...defaultTestLabExaCache,
      ...cache
    });

    return {
      ...parsed,
      queryInsights: parsed.queryInsights ?? parsed.queryHistory.map((query) => ({ query }))
    };
  }

  async writeTestLabExaCache(cache: { queryHistory: string[]; queryInsights?: ExaQueryHistoryInsight[]; discoveredDomains: string[] }): Promise<void> {
    const queryHistory = cache.queryHistory
      .map((query) => query.trim())
      .filter(Boolean)
      .slice(0, 500);
    const queryInsights = (cache.queryInsights ?? [])
      .filter((entry) => queryHistory.includes(entry.query?.trim()))
      .map((entry) => ({
        ...entry,
        query: entry.query.trim()
      }))
      .slice(0, 500);

    this.debugCacheDatabase.writeTestLabExaCache(testLabExaCacheSchema.parse({
      queryHistory,
      queryInsights,
      discoveredDomains: Array.from(new Set(cache.discoveredDomains)).slice(0, 5000)
    }));
  }

  async clearTestLabExaCache(): Promise<{ queryHistory: string[]; queryInsights: ExaQueryHistoryInsight[]; discoveredDomains: string[] }> {
    await this.writeTestLabExaCache(defaultTestLabExaCache);
    return defaultTestLabExaCache;
  }

  async getLiveExaCache(): Promise<LiveExaCache> {
    const cache = await this.readLiveExaCacheFromDatabase();
    const queryRuns = normalizeLiveExaQueryRuns(cache.queryRuns);
    // Historical recurring signal comes primarily from the persistent per-domain occurrence
    // counter (counts EVERY domain Exa returns, including excluded ones, and never gets
    // bulk-deleted). Entries-based recurring is unioned in for backward compatibility with
    // caches recorded before the counter existed.
    const persistedOccurrences = this.liveCacheDatabase.readLiveExaDomainOccurrences();
    const entriesRecurringDomains = buildLiveExaRecurringDomains(cache.entries, cache.discoveredDomains);
    const recurringDomains = mergeLiveExaRecurringDomains(persistedOccurrences, entriesRecurringDomains);
    const recentRecurringDomains = buildRecentLiveExaRecurringDomains(cache.entries, queryRuns);
    return liveExaCacheSchema.parse({
      ...defaultLiveExaCache,
      ...cache,
      queryRuns,
      recentRecurringDomains,
      recurringDomains,
      discoveredDomains: recurringDomains.length > 0
        ? recurringDomains.map((entry) => entry.domain)
        : cache.discoveredDomains
    });
  }

  async writeLiveExaCache(cache: LiveExaCache): Promise<void> {
    const normalizedEntries: RawExaHistoryEntry[] = [];
    for (const entry of cache.entries) {
      const normalizedDomain = entry.domain.trim().toLowerCase();
      if (!normalizedDomain) {
        continue;
      }

      normalizedEntries.push({
        ...entry,
        domain: normalizedDomain
      });
    }

    const entries = normalizedEntries.slice(0, 5000);
    const recurringDomains = buildLiveExaRecurringDomains(entries, cache.discoveredDomains);
    const queryRuns = normalizeLiveExaQueryRuns(cache.queryRuns);
    const recentRecurringDomains = buildRecentLiveExaRecurringDomains(entries, queryRuns);
    this.liveCacheDatabase.writeLiveExaCache(liveExaCacheSchema.parse({
      entries,
      discoveredDomains: recurringDomains.map((entry) => entry.domain),
      recentRecurringDomains,
      recurringDomains,
      queryRuns
    }));
  }

  async recordLiveExaRawResults(entries: RawExaHistoryEntry[]): Promise<LiveExaCache> {
    const current = await this.getLiveExaCache();
    await this.writeLiveExaCache({
      entries: [...entries, ...current.entries],
      discoveredDomains: [],
      queryRuns: current.queryRuns ?? []
    });

    return this.getLiveExaCache();
  }

  async recordLiveExaQueryRuns(queryRuns: NonNullable<LiveExaCache["queryRuns"]>): Promise<LiveExaCache> {
    const current = await this.getLiveExaCache();
    await this.writeLiveExaCache({
      entries: current.entries,
      discoveredDomains: [],
      queryRuns: [...queryRuns, ...(current.queryRuns ?? [])]
    });

    return this.getLiveExaCache();
  }

  /**
   * Persistently records that Exa returned these domains, incrementing the per-domain
   * occurrence counter. Used for EVERY returned domain (excluded or accepted) so the
   * historical recurring signal accumulates across runs and drives exclude prioritization.
   */
  recordLiveExaDomainOccurrences(entries: RawExaHistoryEntry[]): void {
    this.liveCacheDatabase.recordLiveExaDomainOccurrences(entries);
  }

  readLiveExaDomainOccurrences(): LiveExaRecurringDomain[] {
    return this.liveCacheDatabase.readLiveExaDomainOccurrences();
  }

  getLiveExaDomainOccurrenceStats(): { domains: number; totalOccurrences: number } {
    return this.liveCacheDatabase.countLiveExaDomainOccurrences();
  }

  deleteLiveExaDomainOccurrences(domains: string[]): number {
    return this.liveCacheDatabase.deleteLiveExaDomainOccurrences(domains);
  }

  async clearLiveExaCache(): Promise<LiveExaCache> {
    await this.writeLiveExaCache(defaultLiveExaCache);
    this.liveCacheDatabase.clearLiveExaDomainOccurrences();
    return defaultLiveExaCache;
  }

  async getSearchCursor(filter: OrganizationFilter): Promise<number> {
    await this.ensureSeedData();
    const cursorMap = apolloSearchCursorSchema.parse(
      await readJsonFile<Record<string, { nextPage: number; updatedAt: string }>>(controlPlanePaths.apolloSearchCursorPath)
    );

    return cursorMap[this.getSearchCursorKey(filter)]?.nextPage ?? 1;
  }

  async updateSearchCursor(filter: OrganizationFilter, nextPage: number): Promise<void> {
    await this.ensureSeedData();
    const cursorMap = apolloSearchCursorSchema.parse(
      await readJsonFile<Record<string, { nextPage: number; updatedAt: string }>>(controlPlanePaths.apolloSearchCursorPath)
    );

    cursorMap[this.getSearchCursorKey(filter)] = {
      nextPage: Math.max(1, nextPage),
      updatedAt: new Date().toISOString()
    };

    await writeJsonFile(controlPlanePaths.apolloSearchCursorPath, cursorMap);
  }

  async recordCompanyFeedback(input: Omit<CompanyFeedbackEntry, "createdAt">): Promise<LeadLearningData> {
    const learning = await this.getLearning();
    const normalizedName = input.companyName.trim().toLowerCase();
    const normalizedDomain = input.domain?.trim().toLowerCase();

    const dedupedFeedback = learning.companyFeedback.filter((entry) => {
      const sameName = entry.companyName.trim().toLowerCase() === normalizedName;
      const sameDomain = normalizedDomain && entry.domain?.trim().toLowerCase() === normalizedDomain;
      return !(sameName || sameDomain);
    });

    const nextLearning = {
      ...learning,
      companyFeedback: [
        {
          ...input,
          createdAt: new Date().toISOString()
        },
        ...dedupedFeedback
      ].slice(0, 200)
    };

    await writeJsonFile(controlPlanePaths.learningPath, nextLearning);
    return nextLearning;
  }

  async recordFilterEvaluations(
    companySearchMode: LeadAgentSettings["companySearchMode"],
    evaluations: FilterEvaluation[]
  ): Promise<void> {
    const learning = await this.getLearning();
    const searchHistoryByMode = { ...(learning.searchHistoryByMode ?? {}) };
    const normalizedMode = companySearchMode ?? "open_crawler_search";
    const modeLearning = searchHistoryByMode[normalizedMode] ?? {
      filterPerformance: {},
      searchHistory: []
    };
    const filterPerformance = { ...modeLearning.filterPerformance };

    for (const evaluation of evaluations) {
      const current = filterPerformance[evaluation.filterName] ?? {
        runs: 0,
        averageRelevanceRatio: 0,
        earlyStopCount: 0
      };

      const runs = current.runs + 1;
      filterPerformance[evaluation.filterName] = {
        runs,
        averageRelevanceRatio:
          (current.averageRelevanceRatio * current.runs + evaluation.relevanceRatio) / runs,
        earlyStopCount: current.earlyStopCount + (evaluation.stoppedEarly ? 1 : 0)
      };
    }

    searchHistoryByMode[normalizedMode] = {
      ...modeLearning,
      filterPerformance
    };

    await writeJsonFile(controlPlanePaths.learningPath, {
      ...learning,
      filterPerformance: {},
      searchHistory: [],
      searchHistoryByMode
    });
  }

  async recordSearchHistory(
    companySearchMode: LeadAgentSettings["companySearchMode"],
    entries: SearchHistoryEntry[]
  ): Promise<LeadLearningData> {
    const learning = await this.getLearning();
    const searchHistoryByMode = { ...(learning.searchHistoryByMode ?? {}) };
    const normalizedMode = companySearchMode ?? "open_crawler_search";
    const modeLearning = searchHistoryByMode[normalizedMode] ?? {
      filterPerformance: {},
      searchHistory: []
    };
    const nextLearning = {
      ...learning,
      filterPerformance: {},
      searchHistory: [],
      searchHistoryByMode: {
        ...searchHistoryByMode,
        [normalizedMode]: {
          ...modeLearning,
          searchHistory: [...entries, ...modeLearning.searchHistory]
            .map((entry) => this.normalizeSearchHistoryEntry(entry))
            .slice(0, 300)
        }
      }
    };

    await writeJsonFile(controlPlanePaths.learningPath, nextLearning);
    return nextLearning;
  }

  async clearSearchHistoryMode(companySearchMode: LeadAgentSettings["companySearchMode"]): Promise<LeadLearningData> {
    const learning = await this.getLearning();
    const searchHistoryByMode = { ...(learning.searchHistoryByMode ?? {}) };
    delete searchHistoryByMode[companySearchMode ?? "open_crawler_search"];

    const nextLearning = {
      ...learning,
      filterPerformance: {},
      searchHistory: [],
      searchHistoryByMode
    };

    await writeJsonFile(controlPlanePaths.learningPath, nextLearning);
    return this.getLearning();
  }

  async clearCompanyScreeningCache(scope: ScreeningCacheScope = "all"): Promise<CompanyScreeningDatabase> {
    const database = await this.getCompanyScreeningDatabase();
    const nextDatabase = {
      records: database.records.filter((record) => {
        if (record.existsInHubSpot) {
          return true;
        }

        if (scope === "all") {
          return false;
        }

        const isDebugRecord = this.isDebugScreeningRecord(record.sourceFilter);
        return scope === "debug"
          ? !isDebugRecord
          : isDebugRecord;
      })
    } satisfies CompanyScreeningDatabase;

    await this.writeCompanyScreeningDatabase(nextDatabase);
    return nextDatabase;
  }

  private isDebugScreeningRecord(sourceFilter?: string): boolean {
    const normalized = sourceFilter?.trim().toLowerCase() ?? "";
    return normalized.includes("manual-debug-input") || normalized.includes("debug-stage=") || normalized.includes("[debug");
  }

  private getCacheDatabase(scope: CacheDatabaseScope): CacheDatabaseStore {
    return scope === "live" ? this.liveCacheDatabase : this.debugCacheDatabase;
  }

  private async ensureScreeningMigration(scope: CacheDatabaseScope): Promise<void> {
    const cacheDatabase = this.getCacheDatabase(scope);
    if (cacheDatabase.getMetadata("screeningMigrated") === "1") {
      return;
    }

    await this.ensureSeedData();
    const database = await readJsonFileWithRecovery<Partial<CompanyScreeningDatabase>>(
      controlPlanePaths.companyScreeningDatabasePath,
      defaultCompanyScreeningDatabase
    );
    const records = (database.records ?? [])
      .map((record) => this.normalizeCompanyScreeningRecord(record))
      .filter((record) => scope === "debug"
        ? this.isDebugScreeningRecord(record.sourceFilter)
        : !this.isDebugScreeningRecord(record.sourceFilter));

    cacheDatabase.writeScreeningDatabase({
      records: this.normalizeCompanyScreeningRecords(records)
    });
    cacheDatabase.setMetadata("screeningMigrated", "1");
  }

  private async ensureExaMigration(scope: CacheDatabaseScope): Promise<void> {
    const cacheDatabase = this.getCacheDatabase(scope);
    const metadataKey = scope === "live" ? "liveExaMigrated" : "testLabExaMigrated";
    if (cacheDatabase.getMetadata(metadataKey) === "1") {
      return;
    }

    await this.ensureSeedData();

    if (scope === "live") {
      const cache = await readJsonFileWithRecovery<Partial<LiveExaCache>>(controlPlanePaths.liveExaCachePath, defaultLiveExaCache);
      cacheDatabase.writeLiveExaCache(liveExaCacheSchema.parse({
        ...defaultLiveExaCache,
        ...cache
      }));
    } else {
      const cache = await readJsonFileWithRecovery<{ queryHistory?: string[]; queryInsights?: ExaQueryHistoryInsight[]; discoveredDomains?: string[] }>(
        controlPlanePaths.testLabExaCachePath,
        defaultTestLabExaCache
      );
      cacheDatabase.writeTestLabExaCache(testLabExaCacheSchema.parse({
        ...defaultTestLabExaCache,
        ...cache
      }));
    }

    cacheDatabase.setMetadata(metadataKey, "1");
  }

  private async readScreeningDatabaseForScope(scope: CacheDatabaseScope): Promise<CompanyScreeningDatabase> {
    await this.ensureScreeningMigration(scope);
    return this.getCacheDatabase(scope).readScreeningDatabase();
  }

  private async writeScreeningDatabaseForScope(scope: CacheDatabaseScope, database: CompanyScreeningDatabase): Promise<void> {
    await this.ensureScreeningMigration(scope);
    this.getCacheDatabase(scope).writeScreeningDatabase({
      records: this.normalizeCompanyScreeningRecords(database.records)
    });
  }

  private async readLiveExaCacheFromDatabase(): Promise<LiveExaCache> {
    await this.ensureExaMigration("live");
    return this.liveCacheDatabase.readLiveExaCache();
  }

  private async readTestLabExaCacheFromDatabase(): Promise<{ queryHistory: string[]; queryInsights: ExaQueryHistoryInsight[]; discoveredDomains: string[] }> {
    await this.ensureExaMigration("debug");
    return this.debugCacheDatabase.readTestLabExaCache();
  }

  async writeLatestLeadRun(record: LatestLeadRunRecord): Promise<void> {
    await this.ensureSeedData();
    await writeJsonFile(controlPlanePaths.latestLeadRunPath, record);
    await writeJsonFile(controlPlanePaths.latestOutreachReviewPath, record);
  }

  private normalizeCompanyScreeningRecords(records: CompanyScreeningRecord[]): CompanyScreeningRecord[] {
    const deduped = new Map<string, CompanyScreeningRecord>();

    for (const record of records) {
      const normalizedName = record.normalizedName?.trim().toLowerCase() || record.companyName.trim().toLowerCase();
      const normalizedDomain = record.normalizedDomain?.trim().toLowerCase() || record.domain?.trim().toLowerCase();
      const key = normalizedDomain || `name:${normalizedName}`;

      deduped.set(key, {
        ...this.normalizeCompanyScreeningRecord(record),
        normalizedName,
        normalizedDomain
      });
    }

    return Array.from(deduped.values())
      .sort((left, right) => {
        const leftTimestamp = Date.parse(left.checkedAt ?? left.hubspotCheckedAt ?? "") || 0;
        const rightTimestamp = Date.parse(right.checkedAt ?? right.hubspotCheckedAt ?? "") || 0;
        return rightTimestamp - leftTimestamp;
      })
      .slice(0, 5000);
  }

  async updateTemplate(key: string, input: Partial<Omit<OutreachTemplate, "key">>): Promise<OutreachTemplate> {
    const templates = await this.getTemplates();
    const currentTemplate = templates[key];

    if (!currentTemplate) {
      throw new Error(`Unknown template key: ${key}`);
    }

    const nextTemplate = templateSchema.parse({
      ...currentTemplate,
      ...templateUpdateSchema.parse(input),
      key
    });

    const nextTemplates = {
      ...templates,
      [key]: nextTemplate
    };

    await writeJsonFile(controlPlanePaths.templatesPath, nextTemplates);
    return nextTemplate;
  }

  async getBootstrap(): Promise<{
    settings: LeadAgentSettings;
    templates: Record<string, OutreachTemplate>;
    categoryContexts: typeof CATEGORY_EXECUTION_CONTEXT;
    prequalificationCategoryContexts: typeof CATEGORY_PREQUALIFICATION_CONTEXT;
    selectableCategories: Array<{ value: string; label: string }>;
    suggestedControls: string[];
    learning: LeadLearningData;
    latestLeadRun: LatestLeadRunRecord;
    testLabExaCache: { queryHistory: string[]; queryInsights: ExaQueryHistoryInsight[]; discoveredDomains: string[] };
    liveExaCache: LiveExaCache;
    companyScreeningDatabase: CompanyScreeningDatabase;
  }> {
    return {
      settings: await this.getSettings(),
      templates: await this.getTemplates(),
      categoryContexts: CATEGORY_EXECUTION_CONTEXT,
      prequalificationCategoryContexts: CATEGORY_PREQUALIFICATION_CONTEXT,
      selectableCategories: [
        { value: "integrator_vision_industrial_ai", label: "Software Integratoren mit Vision/Industrial AI Fokus" },
        { value: "integrator_vision_ai_consulting", label: "Vision AI/Industrial AI Consulting" },
        { value: "integrator_vision_ai_freelancer", label: "Vision AI/Industrial AI Freelancer" },
        { value: "integrator_general_ai", label: "Software Integratoren mit allgemeinem AI Fokus" },
        { value: "integrator_relevant_focus", label: "Integratoren in relevanten Industriezweigen" },
        { value: "industrial_end_customer_scaled", label: "Industrie-Endkunden mit ausreichender Projektgroesse" },
        { value: "camera_manufacturer_partner", label: "Kamera-/Imaging-Hersteller als Partner" },
        { value: "machine_builder_ai_enablement", label: "Maschinenbauer mit AI-Option Potenzial" },
        { value: "software_platform_embedding", label: "Softwareplattformen fuer Embedding-Partnerschaften" }
      ],
      suggestedControls,
      learning: await this.getLearning(),
      latestLeadRun: await this.getLatestLeadRun(),
      testLabExaCache: await this.getTestLabExaCache(),
      liveExaCache: await this.getLiveExaCache(),
      companyScreeningDatabase: await this.getCompanyScreeningDatabase()
    };
  }
}