import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CATEGORY_EXECUTION_CONTEXT,
  CATEGORY_PREQUALIFICATION_CONTEXT,
  DEFAULT_MAIN_CONTEXT,
  DEFAULT_PREQUALIFICATION_CATEGORY_CONTEXTS,
  DEFAULT_PREQUALIFICATION_MAIN_CONTEXT,
  OUTREACH_TEMPLATES,
  OutreachTemplate
} from "./prompting/one-ware-playbook";
import {
  CompanyFeedbackEntry,
  FilterEvaluation,
  LatestLeadRunRecord,
  LeadAgentSettings,
  LeadLearningData,
  SearchHistoryEntry
} from "./types";

const selectableCategorySchema = z.enum([
  "integrator_vision_industrial_ai",
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

const settingsSchema = z.object({
  targetLeadCount: z.number().int().positive().max(1000),
  market: z.string().min(1),
  mainContext: z.string().max(12000).optional(),
  prequalification: z.object({
    mainContext: z.string().max(6000).optional(),
    categoryContexts: z.object({
      integrator_vision_industrial_ai: z.string().max(3000).optional(),
      integrator_general_ai: z.string().max(3000).optional(),
      integrator_relevant_focus: z.string().max(3000).optional(),
      industrial_end_customer_scaled: z.string().max(3000).optional(),
      camera_manufacturer_partner: z.string().max(3000).optional(),
      machine_builder_ai_enablement: z.string().max(3000).optional(),
      software_platform_embedding: z.string().max(3000).optional()
    }).optional()
  }).optional(),
  prequalificationContext: z.string().max(4000).optional(),
  targetCategories: z.array(selectableCategorySchema).min(1).optional(),
  runDeepResearch: z.boolean(),
  dryRun: z.boolean(),
  earlyStopEnabled: z.boolean(),
  earlyStopReviewCount: z.number().int().min(5).max(15),
  earlyStopThreshold: z.number().min(0).max(1)
});

const settingsUpdateSchema = settingsSchema.partial();

const templateSchema = z.object({
  key: z.string().min(1),
  audience: z.string().min(1),
  goal: z.string().min(1),
  subject: z.string().min(1),
  emailBody: z.string().min(1),
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

const searchHistoryEntrySchema = z.object({
  timestamp: z.string().min(1),
  filterName: z.string().min(1),
  filterSnapshot: z.object({
    persona: z.string().min(1),
    industries: z.array(z.string().min(1)),
    keywords: z.array(z.string().min(1)),
    locations: z.array(z.string().min(1)),
    employeeRanges: z.array(z.string().min(1)),
    notes: z.string().min(1)
  }).optional(),
  targetCategory: z.enum([
    "integrator_vision_industrial_ai",
    "integrator_general_ai",
    "integrator_relevant_focus",
    "industrial_end_customer_scaled",
    "camera_manufacturer_partner",
    "machine_builder_ai_enablement",
    "software_platform_embedding",
    "irrelevant",
    "other"
  ]).optional(),
  batchType: z.enum(["probe_15", "expand_50"]),
  page: z.number().int().positive(),
  requestedCount: z.number().int().positive(),
  returnedCount: z.number().int().nonnegative(),
  relevantCount: z.number().int().nonnegative(),
  relevanceRatio: z.number().min(0).max(1),
  passedThreshold: z.boolean(),
  recommendation: z.string().min(1)
});

const leadLearningSchema = z.object({
  companyFeedback: z.array(companyFeedbackSchema),
  filterPerformance: z.record(filterLearningStatSchema),
  searchHistory: z.array(searchHistoryEntrySchema)
});

const latestLeadRunSchema = z.object({
  createdAt: z.string().min(1),
  requested: z.any(),
  summary: z.object({
    foundCandidates: z.number().int().nonnegative(),
    filtersTested: z.number().int().nonnegative(),
    filtersStoppedEarly: z.number().int().nonnegative(),
    companiesSkippedAfterEarlyStop: z.number().int().nonnegative()
  }),
  contacts: z.array(z.any()),
  searchHistory: z.array(searchHistoryEntrySchema)
});

const defaultSettings: LeadAgentSettings = {
  targetLeadCount: 50,
  market: "DE",
  mainContext: DEFAULT_MAIN_CONTEXT,
  prequalification: {
    mainContext: DEFAULT_PREQUALIFICATION_MAIN_CONTEXT,
    categoryContexts: DEFAULT_PREQUALIFICATION_CATEGORY_CONTEXTS
  },
  targetCategories: [
    "integrator_vision_industrial_ai",
    "integrator_general_ai",
    "integrator_relevant_focus",
    "industrial_end_customer_scaled",
    "camera_manufacturer_partner",
    "machine_builder_ai_enablement",
    "software_platform_embedding"
  ],
  runDeepResearch: true,
  dryRun: true,
  earlyStopEnabled: true,
  earlyStopReviewCount: 15,
  earlyStopThreshold: 0.5
};

const defaultLearning: LeadLearningData = {
  companyFeedback: [],
  filterPerformance: {},
  searchHistory: []
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
    companiesSkippedAfterEarlyStop: 0
  },
  contacts: [],
  searchHistory: []
};

const suggestedControls = [
  "targetLeadCount",
  "market",
  "mainContext",
  "prequalification.mainContext",
  "prequalification.categoryContexts",
  "targetCategories",
  "runDeepResearch",
  "dryRun",
  "earlyStopEnabled",
  "earlyStopReviewCount",
  "earlyStopThreshold",
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

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function writeJsonFile<T>(filePath: string, value: T): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export class ControlPlaneStore {
  private async ensureSeedData(): Promise<void> {
    await ensureFile(settingsPath, defaultSettings);
    await ensureFile(templatesPath, OUTREACH_TEMPLATES);
    await ensureFile(learningPath, defaultLearning);
    await ensureFile(latestLeadRunPath, defaultLatestLeadRun);
    await ensureFile(latestOutreachReviewPath, defaultLatestLeadRun);
  }

  async getSettings(): Promise<LeadAgentSettings> {
    await this.ensureSeedData();
    const settings = await readJsonFile<LeadAgentSettings & { prequalificationContext?: string }>(settingsPath);

    const normalizedPrequalification = {
      ...defaultSettings.prequalification,
      ...(settings.prequalification ?? {}),
      mainContext:
        settings.prequalification?.mainContext ?? settings.prequalificationContext ?? defaultSettings.prequalification?.mainContext,
      categoryContexts: {
        ...defaultSettings.prequalification?.categoryContexts,
        ...(settings.prequalification?.categoryContexts ?? {})
      }
    };

    return settingsSchema.parse({
      ...defaultSettings,
      ...settings,
      prequalification: normalizedPrequalification
    });
  }

  async updateSettings(input: Partial<LeadAgentSettings>): Promise<LeadAgentSettings> {
    const currentSettings = await this.getSettings();
    const nextSettings = settingsSchema.parse({
      ...currentSettings,
      ...settingsUpdateSchema.parse(input)
    });

    await writeJsonFile(settingsPath, nextSettings);
    return nextSettings;
  }

  async getTemplates(): Promise<Record<string, OutreachTemplate>> {
    await this.ensureSeedData();
    const templates = await readJsonFile<Record<string, OutreachTemplate>>(templatesPath);
    const mergedTemplates = {
      ...OUTREACH_TEMPLATES,
      ...templates
    };

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
    return leadLearningSchema.parse({
      ...defaultLearning,
      ...learning
    });
  }

  async getLatestLeadRun(): Promise<LatestLeadRunRecord> {
    await this.ensureSeedData();
    const latestLeadRun = await readJsonFile<LatestLeadRunRecord>(latestLeadRunPath);
    return latestLeadRunSchema.parse(latestLeadRun) as LatestLeadRunRecord;
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

  async recordFilterEvaluations(evaluations: FilterEvaluation[]): Promise<void> {
    const learning = await this.getLearning();
    const filterPerformance = { ...learning.filterPerformance };

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

    await writeJsonFile(learningPath, {
      ...learning,
      filterPerformance
    });
  }

  async recordSearchHistory(entries: SearchHistoryEntry[]): Promise<LeadLearningData> {
    const learning = await this.getLearning();
    const nextLearning = {
      ...learning,
      searchHistory: [...entries, ...learning.searchHistory].slice(0, 300)
    };

    await writeJsonFile(learningPath, nextLearning);
    return nextLearning;
  }

  async writeLatestLeadRun(record: LatestLeadRunRecord): Promise<void> {
    await this.ensureSeedData();
    await writeJsonFile(latestLeadRunPath, record);
    await writeJsonFile(latestOutreachReviewPath, record);
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
  }> {
    return {
      settings: await this.getSettings(),
      templates: await this.getTemplates(),
      categoryContexts: CATEGORY_EXECUTION_CONTEXT,
      prequalificationCategoryContexts: CATEGORY_PREQUALIFICATION_CONTEXT,
      selectableCategories: [
        { value: "integrator_vision_industrial_ai", label: "Software Integratoren mit Vision/Industrial AI Fokus" },
        { value: "integrator_general_ai", label: "Software Integratoren mit allgemeinem AI Fokus" },
        { value: "integrator_relevant_focus", label: "Integratoren in relevanten Industriezweigen" },
        { value: "industrial_end_customer_scaled", label: "Industrie-Endkunden mit ausreichender Projektgroesse" },
        { value: "camera_manufacturer_partner", label: "Kamera-/Imaging-Hersteller als Partner" },
        { value: "machine_builder_ai_enablement", label: "Maschinenbauer mit AI-Option Potenzial" },
        { value: "software_platform_embedding", label: "Softwareplattformen fuer Embedding-Partnerschaften" }
      ],
      suggestedControls,
      learning: await this.getLearning(),
      latestLeadRun: await this.getLatestLeadRun()
    };
  }
}