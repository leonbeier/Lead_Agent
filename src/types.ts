export type LeadCategory =
  | "integrator_vision_industrial_ai"
  | "integrator_general_ai"
  | "integrator_relevant_focus"
  | "industrial_end_customer_scaled"
  | "camera_manufacturer_partner"
  | "machine_builder_ai_enablement"
  | "software_platform_embedding"
  | "irrelevant"
  | "other";

export type SelectableLeadCategory = Exclude<LeadCategory, "irrelevant" | "other">;

export interface PrequalificationConfig {
  mainContext?: string;
  categoryContexts?: Partial<Record<SelectableLeadCategory, string>>;
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
}

export interface PreCategorizedCompany extends CompanySample {
  category: LeadCategory;
  relevanceScore: number;
  rationale: string;
}

export interface ResearchBrief {
  companyName: string;
  website?: string;
  citations?: string[];
  appliedAgentContext?: string;
  overview: string;
  qualificationSummary: string;
  qualifyingSignals: string[];
  riskFlags: string[];
  likelyGermanSpeaking: boolean;
  outreachLanguage: "de" | "en";
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
  emailAngle: string;
  phoneAngle: string;
  linkedInMessage: string;
  emailSubject: string;
  emailBody: string;
  phoneScript: string;
  eventIdea?: string;
}

export interface PublicContactCandidate {
  email?: string;
  phone?: string;
  sourceUrl: string;
  label: string;
  firstName?: string;
  lastName?: string;
  jobTitle?: string;
}

export interface LeadAgentSettings {
  targetLeadCount: number;
  market: string;
  mainContext?: string;
  prequalification?: PrequalificationConfig;
  prequalificationContext?: string;
  targetCategories?: LeadCategory[];
  runDeepResearch: boolean;
  dryRun: boolean;
  earlyStopEnabled: boolean;
  earlyStopReviewCount: number;
  earlyStopThreshold: number;
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

export interface StoredFilterSnapshot {
  persona: string;
  industries: string[];
  keywords: string[];
  locations: string[];
  employeeRanges: string[];
  notes: string;
}

export interface SearchHistoryEntry {
  timestamp: string;
  filterName: string;
  filterSnapshot?: StoredFilterSnapshot;
  targetCategory?: LeadCategory;
  batchType: "probe_15" | "expand_50";
  page: number;
  requestedCount: number;
  returnedCount: number;
  relevantCount: number;
  relevanceRatio: number;
  passedThreshold: boolean;
  recommendation: string;
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
  outreachLanguage?: "de" | "en";
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
  qualificationSummary?: string;
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
  };
  contacts: GeneratedLeadRecord[];
  searchHistory: SearchHistoryEntry[];
}

export interface LeadLearningData {
  companyFeedback: CompanyFeedbackEntry[];
  filterPerformance: Record<string, FilterLearningStat>;
  searchHistory: SearchHistoryEntry[];
}

export interface LeadJobRequest {
  targetLeadCount: number;
  market?: string;
  mainContext?: string;
  prequalification?: PrequalificationConfig;
  prequalificationContext?: string;
  customGoal?: string;
  agentContext?: string;
  targetCategories?: LeadCategory[];
  runDeepResearch?: boolean;
  dryRun?: boolean;
  syncToHubSpot?: boolean;
  earlyStopEnabled?: boolean;
  earlyStopReviewCount?: number;
  earlyStopThreshold?: number;
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
}