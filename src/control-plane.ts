import { promises as fs } from "node:fs";
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
  ApolloOrganizationFilter,
  CompanyScreeningDatabase,
  CompanyScreeningRecord,
  CompanyFeedbackEntry,
  EditableExecutionContext,
  EditablePrequalificationCategoryContext,
  FilterEvaluation,
  LiveExaCache,
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

const dataDirectory = path.join(process.cwd(), "data");
const settingsPath = path.join(dataDirectory, "lead-agent-settings.json");
const templatesPath = path.join(dataDirectory, "outreach-templates.json");
const learningPath = path.join(dataDirectory, "lead-agent-learning.json");
const latestLeadRunPath = path.join(dataDirectory, "latest-lead-run.json");
const latestOutreachReviewPath = path.join(dataDirectory, "latest-outreach-review.json");
const apolloSearchCursorPath = path.join(dataDirectory, "apollo-search-cursors.json");
const companyScreeningDatabasePath = path.join(dataDirectory, "company-screening-database.json");
const testLabExaCachePath = path.join(dataDirectory, "testlab-exa-cache.json");
const liveExaCachePath = path.join(dataDirectory, "live-exa-cache.json");
const cacheDatabaseDirectory = process.env.LEAD_AGENT_CACHE_DIR?.trim()
  ? path.resolve(process.env.LEAD_AGENT_CACHE_DIR.trim())
  : path.join(dataDirectory, "cache-db");
const liveCacheDatabasePath = path.join(cacheDatabaseDirectory, "live-run-cache.sqlite");
const debugCacheDatabasePath = path.join(cacheDatabaseDirectory, "testlab-cache.sqlite");

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
  mainContext: z.string().max(12000).optional(),
  searchStrategyContext: z.string().max(12000).optional(),
  searchStrategyPreset: z.enum(["default", "optimized_vision_integrators"]).optional(),
  companySearchMode: z.enum(["internet_research", "open_crawler_search", "apollo_search", "exa_search", "diffbot_search", "diffbot_test_data"]),
  creditLessMode: z.boolean(),
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
  useExaExcludeDomains: z.boolean().optional(),
  excludePreviouslyFoundExaDomains: z.boolean().optional(),
  useExaCompanyCategory: z.boolean().optional(),
  maxRuntimeMs: z.number().int().min(60_000).max(10_800_000).optional(),
  aiPrefilterConcurrency: z.number().int().min(1).max(32).optional(),
  outreachPrepConcurrency: z.number().int().min(1).max(32).optional(),
  contactSearchConcurrency: z.number().int().min(1).max(32).optional(),
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
  companySearchMode: z.enum(["internet_research", "open_crawler_search", "apollo_search", "exa_search", "diffbot_search", "diffbot_test_data"]),
  filterName: z.string().min(1),
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

const apolloSearchCursorSchema = z.record(z.object({
  nextPage: z.number().int().positive(),
  updatedAt: z.string().min(1)
}));

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

const testLabExaCacheSchema = z.object({
  queryHistory: z.array(z.string().min(1)),
  discoveredDomains: z.array(z.string().min(1))
});

const rawExaHistoryEntrySchema = z.object({
  timestamp: z.string().min(1),
  domain: z.string().min(1),
  companyName: z.string().min(1).optional(),
  discoveryQuery: z.string().min(1).optional(),
  sourceFilter: z.string().min(1).optional()
});

const liveExaCacheSchema = z.object({
  entries: z.array(rawExaHistoryEntrySchema),
  discoveredDomains: z.array(z.string().min(1))
});

type ScreeningCacheScope = "all" | "live" | "debug";
type CacheDatabaseScope = "live" | "debug";

const defaultSettings: LeadAgentSettings = {
  targetLeadCount: 20,
  market: "DE",
  mainContext: DEFAULT_MAIN_CONTEXT,
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
  exaQueryCount: 1,
  useExaExcludeDomains: true,
  excludePreviouslyFoundExaDomains: true,
  useExaCompanyCategory: false,
  maxRuntimeMs: 600_000,
  aiPrefilterConcurrency: 20,
  outreachPrepConcurrency: 20,
  contactSearchConcurrency: 20,
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
  discoveredDomains: []
};

const defaultLiveExaCache: LiveExaCache = {
  entries: [],
  discoveredDomains: []
};

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

async function ensureFile<T>(filePath: string, defaultValue: T): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, `${JSON.stringify(defaultValue, null, 2)}\n`, "utf8");
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
  private readonly liveCacheDatabase = new CacheDatabaseStore(liveCacheDatabasePath);
  private readonly debugCacheDatabase = new CacheDatabaseStore(debugCacheDatabasePath);

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
    await ensureFile(settingsPath, defaultSettings);
    await ensureFile(templatesPath, OUTREACH_TEMPLATES);
    await ensureFile(learningPath, defaultLearning);
    await ensureFile(latestLeadRunPath, defaultLatestLeadRun);
    await ensureFile(latestOutreachReviewPath, defaultLatestLeadRun);
    await ensureFile(apolloSearchCursorPath, {});
    await ensureFile(companyScreeningDatabasePath, defaultCompanyScreeningDatabase);
    await ensureFile(testLabExaCachePath, defaultTestLabExaCache);
    await ensureFile(liveExaCachePath, defaultLiveExaCache);
  }

  private getApolloSearchCursorKey(filter: ApolloOrganizationFilter): string {
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
    const settings = await readJsonFile<Partial<LeadAgentSettings> & { prequalificationContext?: string }>(settingsPath);
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
      creditLessMode: normalizedCompanySearchMode !== "apollo_search",
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
    const normalizedCompanySearchMode = parsedInput.companySearchMode ?? (
      typeof parsedInput.creditLessMode === "boolean"
        ? (parsedInput.creditLessMode ? "internet_research" : "apollo_search")
        : currentSettings.companySearchMode
    );
    const nextSettings = settingsSchema.parse({
      ...currentSettings,
      ...parsedInput,
      companySearchMode: normalizedCompanySearchMode,
      creditLessMode: normalizedCompanySearchMode !== "apollo_search"
    });

    await writeJsonFile(settingsPath, nextSettings);
    return nextSettings;
  }

  async getTemplates(): Promise<Record<string, OutreachTemplate>> {
    await this.ensureSeedData();
    const templates = await readJsonFile<Record<string, OutreachTemplate>>(templatesPath);
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
      await writeJsonFile(templatesPath, sanitizedTemplates);
    }

    return sanitizedTemplates;
  }

  async getLearning(): Promise<LeadLearningData> {
    await this.ensureSeedData();
    const learning = await readJsonFile<Partial<LeadLearningData>>(learningPath);
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
    const latestLeadRun = await readJsonFile<LatestLeadRunRecord>(latestLeadRunPath);
    return latestLeadRunSchema.parse({
      ...latestLeadRun,
      contacts: latestLeadRun.contacts.map((contact) => ({
        ...contact,
        category: this.normalizeLegacyCategory(contact.category) as typeof contact.category
      })),
      searchHistory: latestLeadRun.searchHistory.map((entry) => this.normalizeSearchHistoryEntry(entry))
    }) as LatestLeadRunRecord;
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

  async getTestLabExaCache(): Promise<{ queryHistory: string[]; discoveredDomains: string[] }> {
    const cache = await this.readTestLabExaCacheFromDatabase();
    return testLabExaCacheSchema.parse({
      ...defaultTestLabExaCache,
      ...cache
    });
  }

  async writeTestLabExaCache(cache: { queryHistory: string[]; discoveredDomains: string[] }): Promise<void> {
    this.debugCacheDatabase.writeTestLabExaCache(testLabExaCacheSchema.parse({
      queryHistory: Array.from(new Set(cache.queryHistory)).slice(0, 500),
      discoveredDomains: Array.from(new Set(cache.discoveredDomains)).slice(0, 5000)
    }));
  }

  async clearTestLabExaCache(): Promise<{ queryHistory: string[]; discoveredDomains: string[] }> {
    await this.writeTestLabExaCache(defaultTestLabExaCache);
    return defaultTestLabExaCache;
  }

  async getLiveExaCache(): Promise<LiveExaCache> {
    const cache = await this.readLiveExaCacheFromDatabase();
    return liveExaCacheSchema.parse({
      ...defaultLiveExaCache,
      ...cache
    });
  }

  async writeLiveExaCache(cache: LiveExaCache): Promise<void> {
    const entriesByDomain = new Map<string, RawExaHistoryEntry>();
    for (const entry of cache.entries) {
      const normalizedDomain = entry.domain.trim().toLowerCase();
      if (!normalizedDomain) {
        continue;
      }

      if (!entriesByDomain.has(normalizedDomain)) {
        entriesByDomain.set(normalizedDomain, {
          ...entry,
          domain: normalizedDomain
        });
      }
    }

    const entries = Array.from(entriesByDomain.values()).slice(0, 5000);
    this.liveCacheDatabase.writeLiveExaCache(liveExaCacheSchema.parse({
      entries,
      discoveredDomains: entries.map((entry) => entry.domain)
    }));
  }

  async recordLiveExaRawResults(entries: RawExaHistoryEntry[]): Promise<LiveExaCache> {
    const current = await this.getLiveExaCache();
    await this.writeLiveExaCache({
      entries: [...entries, ...current.entries],
      discoveredDomains: []
    });

    return this.getLiveExaCache();
  }

  async clearLiveExaCache(): Promise<LiveExaCache> {
    await this.writeLiveExaCache(defaultLiveExaCache);
    return defaultLiveExaCache;
  }

  async getApolloSearchCursor(filter: ApolloOrganizationFilter): Promise<number> {
    await this.ensureSeedData();
    const cursorMap = apolloSearchCursorSchema.parse(
      await readJsonFile<Record<string, { nextPage: number; updatedAt: string }>>(apolloSearchCursorPath)
    );

    return cursorMap[this.getApolloSearchCursorKey(filter)]?.nextPage ?? 1;
  }

  async updateApolloSearchCursor(filter: ApolloOrganizationFilter, nextPage: number): Promise<void> {
    await this.ensureSeedData();
    const cursorMap = apolloSearchCursorSchema.parse(
      await readJsonFile<Record<string, { nextPage: number; updatedAt: string }>>(apolloSearchCursorPath)
    );

    cursorMap[this.getApolloSearchCursorKey(filter)] = {
      nextPage: Math.max(1, nextPage),
      updatedAt: new Date().toISOString()
    };

    await writeJsonFile(apolloSearchCursorPath, cursorMap);
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

    await writeJsonFile(learningPath, nextLearning);
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

    await writeJsonFile(learningPath, {
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

    await writeJsonFile(learningPath, nextLearning);
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

    await writeJsonFile(learningPath, nextLearning);
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
      companyScreeningDatabasePath,
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
      const cache = await readJsonFileWithRecovery<Partial<LiveExaCache>>(liveExaCachePath, defaultLiveExaCache);
      cacheDatabase.writeLiveExaCache(liveExaCacheSchema.parse({
        ...defaultLiveExaCache,
        ...cache
      }));
    } else {
      const cache = await readJsonFileWithRecovery<{ queryHistory?: string[]; discoveredDomains?: string[] }>(
        testLabExaCachePath,
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

  private async readTestLabExaCacheFromDatabase(): Promise<{ queryHistory: string[]; discoveredDomains: string[] }> {
    await this.ensureExaMigration("debug");
    return this.debugCacheDatabase.readTestLabExaCache();
  }

  async writeLatestLeadRun(record: LatestLeadRunRecord): Promise<void> {
    await this.ensureSeedData();
    await writeJsonFile(latestLeadRunPath, record);
    await writeJsonFile(latestOutreachReviewPath, record);
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

    await writeJsonFile(templatesPath, nextTemplates);
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
    testLabExaCache: { queryHistory: string[]; discoveredDomains: string[] };
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