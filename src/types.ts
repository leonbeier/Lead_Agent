export type LeadCategory =
  | "integrator_vision_industrial_ai"
  | "integrator_vision_ai_consulting"
  | "integrator_vision_ai_freelancer"
  | "integrator_general_ai"
  | "integrator_relevant_focus"
  | "industrial_end_customer_scaled"
  | "camera_manufacturer_partner"
  | "machine_builder_ai_enablement"
  | "software_platform_embedding"
  | "irrelevant"
  | "other";

export type SelectableLeadCategory = Exclude<LeadCategory, "irrelevant" | "other">;

export type CompanySearchMode = "internet_research" | "open_crawler_search" | "apollo_search" | "exa_search" | "diffbot_search" | "diffbot_test_data";
export type SearchStrategyPreset = "default" | "optimized_vision_integrators";

export interface EditablePrequalificationCategoryContext {
  classificationRules?: string[];
  disqualifiers?: string[];
  addOnContext?: string;
}

export interface EditableExecutionContext {
  researchPriorities?: string[];
  outreachPriorities?: string[];
  personalizationRules?: string[];
  avoidSignals?: string[];
}

export interface PrequalificationConfig {
  mainContext?: string;
  categoryContexts?: Partial<Record<SelectableLeadCategory, EditablePrequalificationCategoryContext>>;
}

export interface ApolloOrganizationFilter {
  name: string;
  persona: string;
  industries: string[];
  keywords: string[];
  locations: string[];
  employeeRanges: string[];
  targetCategories?: LeadCategory[];
  notes: string;
}

export interface CompanySample {
  name: string;
  domain?: string;
  country?: string;
  shortDescription: string;
  sourceFilter: string;
  discoveryQuery?: string;
}

export interface CrawledWebsiteProfile {
  summary: string;
  landingUrl: string;
  relevantUrls: string[];
}

export interface PreCategorizedCompany extends CompanySample {
  category: LeadCategory;
  relevanceScore: number;
  rationale: string;
}

export type OutreachLanguage = "de" | "en";

export function normalizeOutreachLanguage(value: unknown, fallback: OutreachLanguage = "en"): OutreachLanguage {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";

  if (["de", "deutsch", "german"].includes(normalized)) {
    return "de";
  }

  if (["en", "english"].includes(normalized)) {
    return "en";
  }

  return fallback;
}

export interface ResearchBrief {
  companyName: string;
  website?: string;
  citations?: string[];
  appliedAgentContext?: string;
  isFallback?: boolean;
  stillQualified?: boolean;
  qualificationDecisionReason?: string;
  overview: string;
  qualificationSummary: string;
  qualifyingSignals: string[];
  riskFlags: string[];
  likelyGermanSpeaking: boolean;
  outreachLanguage: OutreachLanguage;
  rankings: {
    customer: number;
    serviceProvider: number;
    partner: number;
  };
  businessPotentialEUR: number;
  businessPotentialReasoning: string;
  targetIndustry: string;
  productsOffered: string;
  recommendedTemplateKey: string;
  personalizationRule: string;
  linkedInAngle: string;
  linkedInConnectionRequest?: string;
  emailAngle: string;
  phoneAngle: string;
  linkedInMessage: string;
  emailSubject: string;
  emailBody: string;
  phoneScript: string;
  eventIdea?: string;
}

export interface PublicContactCandidate {
  personId?: string;
  email?: string;
  phone?: string;
  sourceUrl: string;
  label: string;
  firstName?: string;
  lastName?: string;
  jobTitle?: string;
  linkedinUrl?: string;
  linkedinConnectionCount?: number;
  sourceQuery?: string;
  sourceSnippet?: string;
}

export interface ApolloContactCandidate {
  personId: string;
  firstName?: string;
  lastName?: string;
  name: string;
  title?: string;
  seniority?: string;
  departments?: string[];
  functions?: string[];
  organizationId?: string;
  organizationName?: string;
  linkedinUrl?: string;
  hasEmail?: boolean;
}

export interface AzureUsageCost {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface LeadAgentSettings {
  targetLeadCount: number;
  market: string;
  mainContext?: string;
  searchStrategyContext?: string;
  searchStrategyPreset?: SearchStrategyPreset;
  executionContexts?: Partial<Record<SelectableLeadCategory, EditableExecutionContext>>;
  companySearchMode: CompanySearchMode;
  creditLessMode: boolean;
  prequalification?: PrequalificationConfig;
  prequalificationContext?: string;
  targetCategories?: LeadCategory[];
  runDeepResearch: boolean;
  dryRun: boolean;
  syncToHubSpot?: boolean;
  exaApiKey?: string;
  diffbotToken?: string;
  exaQueryCount?: number;
  useAzureQueryPlanner?: boolean;
  useExaExcludeDomains?: boolean;
  excludePreviouslyFoundExaDomains?: boolean;
  useExaCompanyCategory?: boolean;
  maxRuntimeMs?: number;
  aiPrefilterConcurrency?: number;
  outreachPrepConcurrency?: number;
  contactSearchConcurrency?: number;
  earlyStopEnabled: boolean;
  earlyStopReviewCount: number;
  earlyStopThreshold: number;
  earlyStopMinRelevantCount?: number;
  openCrawlerTuning?: {
    probeCount?: number;
    maxPages?: number;
    sampleMultiplier?: number;
    minSampleSize?: number;
    rawCollectionMultiplier?: number;
  };
}

export interface FilterEvaluation {
  filterName: string;
  totalReviewed: number;
  relevantCount: number;
  relevanceRatio: number;
  categoryBreakdown: Record<LeadCategory, number>;
  recommendation: string;
  stoppedEarly: boolean;
  initialReviewCount: number;
  skippedAfterEarlyStop: number;
}

export interface CompanyFeedbackEntry {
  companyName: string;
  domain?: string;
  verdict: "accept" | "reject";
  reason: string;
  createdAt: string;
}

export interface FilterLearningStat {
  runs: number;
  averageRelevanceRatio: number;
  earlyStopCount: number;
}

export interface SearchModeLearning {
  filterPerformance: Record<string, FilterLearningStat>;
  searchHistory: SearchHistoryEntry[];
}

export interface RawExaHistoryEntry {
  timestamp: string;
  domain: string;
  companyName?: string;
  discoveryQuery?: string;
  sourceFilter?: string;
}

export interface LiveExaQueryRun {
  timestamp: string;
  filterName: string;
  query: string;
  plannedQueries?: string[];
  promptMessages?: Array<{
    role: string;
    content: string;
  }>;
  excludedDomains?: string[];
}

export interface LiveExaCache {
  entries: RawExaHistoryEntry[];
  discoveredDomains: string[];
  queryRuns?: LiveExaQueryRun[];
}

export interface StoredFilterSnapshot {
  persona: string;
  industries: string[];
  keywords: string[];
  locations: string[];
  employeeRanges: string[];
  notes: string;
}

export interface SearchHistoryDropOffSummary {
  filteredByPriorFeedback: number;
  filteredByCache: number;
  filteredByHubSpot: number;
  categorizedIrrelevant: number;
  categorizedOther: number;
}

export interface SearchHistoryDecisionSample {
  companyName: string;
  domain?: string;
  sourceFilter?: string;
  discoveryQuery?: string;
  category: LeadCategory;
  relevanceScore: number;
  rationale: string;
}

export interface SearchHistoryEntry {
  timestamp: string;
  companySearchMode: CompanySearchMode;
  filterName: string;
  filterSnapshot?: StoredFilterSnapshot;
  targetCategory?: LeadCategory;
  batchType: "probe_15" | "expand_50";
  page: number;
  requestedCount: number;
  returnedCount: number;
  relevantCount: number;
  relevanceRatio: number;
  categoryBreakdown: Record<LeadCategory, number>;
  passedThreshold: boolean;
  recommendation: string;
  fetchedSampleCount?: number;
  eligibleSampleCount?: number;
  discoveryQueries?: string[];
  plannedQueries?: string[];
  promptMessages?: Array<{
    role: string;
    content: string;
  }>;
  excludedDomains?: string[];
  queryStats?: Array<{
    query: string;
    returnedResults: number;
    filteredByExcludedDomains: number;
    rawFound: number;
    duplicates: number;
    accepted: number;
    rejectedDifferentCategory: number;
    rejectedOther: number;
    categoryBreakdown: Record<LeadCategory, number>;
  }>;
  dropOffSummary?: SearchHistoryDropOffSummary;
  decisionSamples?: SearchHistoryDecisionSample[];
}

export interface ExaQueryHistoryInsight {
  query: string;
  timestamp?: string;
  detectedCategories?: LeadCategory[];
  foundCategoryBreakdown?: Partial<Record<LeadCategory, number>>;
  returnedResults?: number;
  filteredByExcludedDomains?: number;
  rawFound?: number;
  duplicates?: number;
  accepted?: number;
  rejectedDifferentCategory?: number;
  rejectedOther?: number;
  note?: string;
}

export interface GeneratedLeadRecord {
  companyName: string;
  domain?: string;
  country?: string;
  category: LeadCategory;
  relevanceScore: number;
  sourceFilter: string;
  rationale: string;
  likelyGermanSpeaking?: boolean;
  outreachLanguage?: OutreachLanguage;
  rankings?: {
    customer: number;
    serviceProvider: number;
    partner: number;
  };
  businessPotentialEUR?: number;
  businessPotentialReasoning?: string;
  targetIndustry?: string;
  productsOffered?: string;
  overview?: string;
  stillQualified?: boolean;
  qualificationDecisionReason?: string;
  qualificationSummary?: string;
  linkedInConnectionRequest?: string;
  linkedInMessage?: string;
  emailSubject?: string;
  emailBody?: string;
  phoneScript?: string;
  riskFlags?: string[];
  publicContactEmails?: string[];
  publicContactPhones?: string[];
  publicContactSources?: string[];
}

export interface LatestLeadRunRecord {
  createdAt: string;
  requested: LeadJobRequest;
  summary: {
    foundCandidates: number;
    filtersTested: number;
    filtersStoppedEarly: number;
    companiesSkippedAfterEarlyStop: number;
    funnel?: LeadRunFunnel;
    timedOut?: boolean;
    stopped?: boolean;
    completionReason?: string;
  };
  contacts: GeneratedLeadRecord[];
  searchHistory: SearchHistoryEntry[];
  hubspotSync?: {
    attempted: boolean;
    mode: "dry-run" | "live";
    candidateCount: number;
    syncedCount: number;
    companySyncedCount: number;
    contactSyncedCount: number;
    errors?: string[];
  };
  costs?: {
    azure?: AzureUsageCost;
  };
}

export interface LeadLearningData {
  companyFeedback: CompanyFeedbackEntry[];
  filterPerformance: Record<string, FilterLearningStat>;
  searchHistory: SearchHistoryEntry[];
  searchHistoryByMode?: Partial<Record<CompanySearchMode, SearchModeLearning>>;
}

export interface CompanyScreeningRecord {
  companyName: string;
  normalizedName: string;
  domain?: string;
  normalizedDomain?: string;
  category?: LeadCategory;
  relevanceScore?: number;
  rationale?: string;
  sourceFilter?: string;
  shortDescription?: string;
  checkedAt?: string;
  existsInHubSpot?: boolean;
  hubspotCheckedAt?: string;
}

export interface CompanyScreeningDatabase {
  records: CompanyScreeningRecord[];
}

export interface LeadRunFunnel {
  crawledPages: number;
  afterCrawlerPrefilter: number;
  afterHubSpotDedup: number;
  afterAzureAICheck: number;
  syncedToHubSpot: number;
}

export interface LeadJobRequest {
  targetLeadCount: number;
  market?: string;
  mainContext?: string;
  searchStrategyContext?: string;
  searchStrategyPreset?: SearchStrategyPreset;
  executionContexts?: Partial<Record<SelectableLeadCategory, EditableExecutionContext>>;
  companySearchMode?: CompanySearchMode;
  creditLessMode?: boolean;
  prequalification?: PrequalificationConfig;
  prequalificationContext?: string;
  customGoal?: string;
  agentContext?: string;
  targetCategories?: LeadCategory[];
  runDeepResearch?: boolean;
  dryRun?: boolean;
  syncToHubSpot?: boolean;
  reuseQualifiedCompanyCache?: boolean;
  exaApiKey?: string;
  diffbotToken?: string;
  exaQueryCount?: number;
  useAzureQueryPlanner?: boolean;
  useExaExcludeDomains?: boolean;
  excludePreviouslyFoundExaDomains?: boolean;
  useExaCompanyCategory?: boolean;
  aiPrefilterConcurrency?: number;
  outreachPrepConcurrency?: number;
  contactSearchConcurrency?: number;
  disableHubSpotDeduplication?: boolean;
  earlyStopEnabled?: boolean;
  earlyStopReviewCount?: number;
  earlyStopThreshold?: number;
  earlyStopMinRelevantCount?: number;
  maxRuntimeMs?: number;
  openCrawlerTuning?: {
    probeCount?: number;
    maxPages?: number;
    sampleMultiplier?: number;
    minSampleSize?: number;
    rawCollectionMultiplier?: number;
  };
}

export interface LeadRunProgress {
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
  aiPrefilterConcurrency?: number;
  outreachPrepConcurrency?: number;
  contactSearchConcurrency?: number;
  exaQueryCount?: number;
  funnel?: LeadRunFunnel;
  timedOut?: boolean;
  stopped?: boolean;
  liveSearchDebug?: {
    filterName?: string;
    defaultQueries?: string[];
    plannedQueries?: string[];
    promptMessages?: Array<{
      role: string;
      content: string;
    }>;
    lastExecutedQuery?: string;
    excludedDomains?: string[];
    executedQueries?: number;
    totalQueries?: number;
    returnedResults?: number;
    filteredByExcludedDomains?: number;
    filteredByHubSpot?: number;
    filteredByRejectedWebsites?: number;
    filteredByCurrentRunCache?: number;
    duplicatesRemoved?: number;
    rawCompaniesFound?: number;
    currentBatchQueryStats?: Array<{
      query: string;
      returnedResults: number;
      filteredByExcludedDomains: number;
      filteredByHubSpot: number;
      filteredByRejectedWebsites: number;
      filteredByCurrentRunCache: number;
      rawFound: number;
      duplicates: number;
      accepted: number;
      rejectedDifferentCategory: number;
      rejectedOther: number;
      categoryBreakdown: Partial<Record<LeadCategory, number>>;
    }>;
  };
  updatedAt: string;
}

export interface LeadJobResult {
  requested: LeadJobRequest;
  suggestedFilters: ApolloOrganizationFilter[];
  evaluations: FilterEvaluation[];
  shortlistedCompanies: PreCategorizedCompany[];
  researchBriefs: ResearchBrief[];
  searchHistory: SearchHistoryEntry[];
  hubspotSync: {
    attempted: boolean;
    mode: "dry-run" | "live";
    candidateCount: number;
    syncedCount: number;
    companySyncedCount: number;
    contactSyncedCount: number;
    errors?: string[];
  };
  efficiency: {
    filtersStoppedEarly: number;
    companiesSkippedAfterEarlyStop: number;
  };
  funnel: LeadRunFunnel;
  timedOut?: boolean;
  stopped?: boolean;
  completionReason?: string;
  costs?: {
    azure: AzureUsageCost;
  };
}