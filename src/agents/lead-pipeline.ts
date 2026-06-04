import fs from "node:fs/promises";
import path from "node:path";

import { env } from "../config";
import { buildSuggestedFilters, extractExplicitMarketLocality, isGermanyFocusedMarket } from "../filters";
import { ApolloClient } from "../clients/apollo";
import { CompanySearchClient } from "../clients/company-search";
import { AzureOpenAIClient } from "../clients/azure-openai";
import { ExaSearchClient } from "../clients/exa-search";
import { HubSpotClient } from "../clients/hubspot";
import { ControlPlaneStore, getLeadAgentRuntimeDataDirectory } from "../control-plane";
import { buildDebugSearchFilter } from "../debug/test-console";
import {
  OrganizationFilter,
  CompanyScreeningDatabase,
  CompanyScreeningRecord,
  CompanySample,
  ExaQueryHistoryInsight,
  FilterEvaluation,
  GeneratedLeadRecord,
  LeadCategory,
  LeadLearningData,
  LeadJobRequest,
  LeadJobResult,
  LeadRunFunnel,
  LeadRunProgress,
  PreCategorizedCompany,
  PrequalificationConfig,
  PublicContactCandidate,
  ResearchBrief,
  RawExaHistoryEntry,
  SearchHistoryDecisionSample,
  SearchHistoryEntry,
  SelectableLeadCategory
} from "../types";

const RELEVANT_CATEGORIES: LeadCategory[] = [
  "integrator_vision_industrial_ai",
  "integrator_vision_ai_consulting",
  "integrator_vision_ai_freelancer",
  "integrator_general_ai",
  "integrator_relevant_focus",
  "industrial_end_customer_scaled",
  "camera_manufacturer_partner",
  "machine_builder_ai_enablement",
  "software_platform_embedding"
];

const FILTER_CATEGORY_FALLBACKS: Array<{ match: RegExp; categories: LeadCategory[] }> = [
  { match: /vision\s*\/\s*industrial ai integrators/i, categories: ["integrator_vision_industrial_ai"] },
  { match: /vision ai consulting specialists|vision ai consulting/i, categories: ["integrator_vision_ai_consulting"] },
  { match: /freelance specialists|freelancer/i, categories: ["integrator_vision_ai_freelancer"] },
  { match: /general ai integrators/i, categories: ["integrator_general_ai"] },
  { match: /relevant-vertical integrators/i, categories: ["integrator_relevant_focus"] },
  { match: /scaled industrial end customers/i, categories: ["industrial_end_customer_scaled"] },
  { match: /camera manufacturers/i, categories: ["camera_manufacturer_partner"] },
  { match: /machine builders for ai options/i, categories: ["machine_builder_ai_enablement"] },
  { match: /software platforms for embedding/i, categories: ["software_platform_embedding"] }
];

const FULL_SAMPLE_SIZE = 50;
const DEFAULT_EARLY_STOP_REVIEW_COUNT = 30;
const MIN_EARLY_STOP_REVIEW_COUNT = 5;
const MAX_EARLY_STOP_REVIEW_COUNT = 30;
const DEFAULT_EARLY_STOP_THRESHOLD = 0.15;
const AZURE_WORKER_CONCURRENCY = env.AZURE_AI_CLASSIFICATION_CONCURRENCY;
const EXPANSION_BATCH_SIZE = 50;
const CREDITLESS_EXPANSION_BATCH_SIZE = 20;
const MAX_FILTER_REVISIONS = 1;
const MIN_COMPANIES_REVIEWED_BEFORE_FILTER_GIVE_UP = 40;
const CONTACT_DISCOVERY_CONCURRENCY = env.CONTACT_DISCOVERY_CONCURRENCY;
const PUBLIC_CONTACT_DISCOVERY_TIMEOUT_MS = 90_000;
const PARALLEL_FILTER_PROBE_COUNT = 5;
const FILTERS_TO_EXPAND_AFTER_PROBE = 5;
const DIRECT_EXA_FILTER_CONCURRENCY = 3;
const DIRECT_EXA_QUERY_CONCURRENCY = 3;
const RESEARCH_BRIEF_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_RUNTIME_MS = 3 * 60 * 60 * 1000;
const FALLBACK_REPLENISHMENT_LOCATIONS = ["Berlin", "Munich", "Hamburg", "Cologne", "Stuttgart", "DACH", "Austria", "Switzerland"];
const FALLBACK_REPLENISHMENT_KEYWORDS = ["computer vision", "machine vision", "bildverarbeitung", "industrial ai", "inspection automation", "vision systems"];
const WEB_SEARCH_SAMPLE_MULTIPLIER = 10;
const WEB_SEARCH_MIN_SAMPLE_SIZE = 20;
const WEB_SEARCH_MAX_PAGES = 5;
const WEB_SEARCH_MAX_RAW_PROBE_COUNT = 20;
const WEB_SEARCH_TOP_UP_SAMPLE_MULTIPLIER = 8;
const WEB_SEARCH_TOP_UP_MIN_SAMPLE_SIZE = 12;
const WEB_SEARCH_TOP_UP_MAX_PAGES = 3;
const MIN_USER_CONCURRENCY = 1;

type ProbedFilterCandidate = {
  filter: OrganizationFilter;
  activeCategory: LeadCategory;
  reviewedCompanies: PreCategorizedCompany[];
  categorizedInitialSample: PreCategorizedCompany[];
  sampleDiagnostics: SearchSampleDiagnostics;
  initialEvaluation: FilterEvaluation;
  initialRelevant: PreCategorizedCompany[];
  useWebSearchForExpansion: boolean;
  expansionSearchMode: import("../types").CompanySearchMode;
  apolloExpansionPage: number;
};

type SearchSampleDiagnostics = {
  fetchedSampleCount: number;
  eligibleSampleCount: number;
  filteredByPriorFeedbackCount: number;
  filteredByCacheCount: number;
  filteredByHubSpotCount: number;
  discoveryQueries: string[];
};

type ExpandedFilterOutcome = {
  evaluation: FilterEvaluation;
  categoryAdded: number;
  stoppedEarly: boolean;
  skippedAfterEarlyStop: number;
};

type LeadPipelineRunOptions = {
  onProgress?: (progress: LeadRunProgress) => void;
  shouldStop?: () => boolean;
};

type DirectExaExcludeDomainSources = {
  screeningScope?: "live" | "debug";
  currentRunExcludedDomains?: string[];
  historicalExaDomains?: string[];
};

type DirectExaExcludedDomainCategory = "hubspot" | "rejected_website" | "current_run_cache";

const MAX_DIRECT_EXA_REQUEST_EXCLUDED_DOMAINS = 1200;

type DirectExaQueryPlanningContext = {
  dryRun?: boolean;
  learning?: LeadLearningData;
  mainContext?: string;
  targetCategoryRefinement?: string;
  searchStrategyContext?: string;
  recentQueryHistory?: ExaQueryHistoryInsight[];
  prequalification?: PrequalificationConfig;
  useAzureQueryPlanner?: boolean;
  forcedQueries?: string[];
  plannedQueryMetadata?: {
    defaultQueries?: string[];
    plannedQueries?: string[];
    promptMessages?: Array<{ role: string; content: string }>;
  };
  debugCapture?: (details: { promptMessages: Array<{ role: string; content: string }> }) => void;
};

const EUROPEAN_COUNTRIES = new Set([
  "germany",
  "austria",
  "switzerland",
  "netherlands",
  "belgium",
  "luxembourg",
  "denmark",
  "sweden",
  "norway",
  "finland",
  "france",
  "italy",
  "spain",
  "portugal",
  "ireland",
  "poland",
  "czech republic",
  "czechia",
  "slovakia",
  "slovenia",
  "hungary",
  "romania",
  "bulgaria",
  "croatia",
  "estonia",
  "latvia",
  "lithuania"
]);

const EUROPEAN_TLDS = [
  ".de",
  ".at",
  ".ch",
  ".fr",
  ".it",
  ".es",
  ".pt",
  ".nl",
  ".be",
  ".lu",
  ".dk",
  ".se",
  ".no",
  ".fi",
  ".ie",
  ".pl",
  ".cz",
  ".sk",
  ".si",
  ".hu",
  ".ro",
  ".bg",
  ".hr",
  ".ee",
  ".lv",
  ".lt",
  ".eu"
];

const COMMON_COMPOUND_TLDS = new Set([
  "co.uk",
  "com.au",
  "com.br",
  "com.mx",
  "co.jp",
  "co.kr",
  "co.nz",
  "com.sg",
  "com.cn",
  "com.tw",
  "com.hk"
]);

export class LeadPipelineAgent {
  private readonly apolloClient = new ApolloClient();
  private readonly companySearchClient = new CompanySearchClient();

  private readonly azureClient = new AzureOpenAIClient();

  private readonly exaPreviewClient = new ExaSearchClient();

  private readonly hubspotClient = new HubSpotClient();

  private readonly controlPlaneStore = new ControlPlaneStore();

  private companyScreeningDatabase: CompanyScreeningDatabase = { records: [] };

  private discoveryCheckpointContext?: { runId: string; nextSequence: number };

  private aiPrefilterConcurrency = AZURE_WORKER_CONCURRENCY;

  private outreachPrepConcurrency = AZURE_WORKER_CONCURRENCY;

  private contactSearchConcurrency = CONTACT_DISCOVERY_CONCURRENCY;

  async run(request: LeadJobRequest, options?: LeadPipelineRunOptions): Promise<LeadJobResult> {
    const emitProgress = (progress: Omit<LeadRunProgress, "updatedAt">) => {
      options?.onProgress?.({
        ...progress,
        updatedAt: new Date().toISOString()
      });
    };

    const dryRun = request.dryRun ?? true;
    const syncToHubSpot = request.syncToHubSpot ?? !dryRun;
    const disableHubSpotDeduplication = request.disableHubSpotDeduplication ?? false;
    const companySearchMode = request.companySearchMode ?? "internet_research";
    this.companySearchClient.setExaApiKey(request.exaApiKey);
    this.companySearchClient.setDiffbotToken(request.diffbotToken);
    this.companySearchClient.setExaSearchPayloadOptions({
      includeExcludeDomains: request.useExaExcludeDomains ?? true,
      includeCompanyCategoryFilter: request.useExaCompanyCategory ?? false,
      maxQueryCount: request.exaQueryCount ?? 4
    });
    this.exaPreviewClient.setApiKey(request.exaApiKey);
    this.exaPreviewClient.setSearchPayloadOptions({
      includeExcludeDomains: request.useExaExcludeDomains ?? true,
      includeCompanyCategoryFilter: request.useExaCompanyCategory ?? false,
      maxQueryCount: request.exaQueryCount ?? 4
    });
    const deadlineAt = Date.now() + Math.max(60_000, request.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS);
    const wasStopped = () => Boolean(options?.shouldStop?.());
    const hasTimedOut = () => Date.now() >= deadlineAt;
    const shouldFinishEarly = () => wasStopped() || hasTimedOut();
    this.discoveryCheckpointContext = { runId: this.createDiscoveryCheckpointRunId(), nextSequence: 0 };
    this.aiPrefilterConcurrency = this.resolveConcurrency(request.aiPrefilterConcurrency, AZURE_WORKER_CONCURRENCY);
    this.outreachPrepConcurrency = this.resolveConcurrency(request.outreachPrepConcurrency, AZURE_WORKER_CONCURRENCY);
    this.contactSearchConcurrency = this.resolveConcurrency(request.contactSearchConcurrency, CONTACT_DISCOVERY_CONCURRENCY);
    const useWebSearchCompanyDiscovery = true;
    const targetCategories = this.getActiveTargetCategories(request.targetCategories);
    const mainContext = request.mainContext ?? request.agentContext;
    const learning = await this.controlPlaneStore.getLearning();
    const earlyStopEnabled = request.earlyStopEnabled ?? true;
    const earlyStopReviewCount = Math.min(
      MAX_EARLY_STOP_REVIEW_COUNT,
      Math.max(MIN_EARLY_STOP_REVIEW_COUNT, request.earlyStopReviewCount ?? DEFAULT_EARLY_STOP_REVIEW_COUNT)
    );
    const earlyStopThreshold = request.earlyStopThreshold ?? DEFAULT_EARLY_STOP_THRESHOLD;
    const earlyStopMinRelevantCount = Math.max(0, request.earlyStopMinRelevantCount ?? (earlyStopReviewCount >= 20 ? 2 : 1));
    const minimumCompaniesBeforeFilterGiveUp = Math.min(FULL_SAMPLE_SIZE, Math.max(earlyStopReviewCount, 20));
    const openCrawlerTuning = request.openCrawlerTuning;
    const webRawProbeCount = companySearchMode === "exa_search"
      ? openCrawlerTuning?.probeCount ?? 20
      : companySearchMode === "open_crawler_search" || companySearchMode === "diffbot_search"
        ? openCrawlerTuning?.probeCount ?? 20
        : Math.min(
          WEB_SEARCH_MAX_RAW_PROBE_COUNT,
          Math.max(WEB_SEARCH_MIN_SAMPLE_SIZE, request.targetLeadCount * WEB_SEARCH_SAMPLE_MULTIPLIER)
        );
    const prequalification = request.prequalification ?? (request.prequalificationContext ? { mainContext: request.prequalificationContext } : undefined);
    this.companyScreeningDatabase = await this.controlPlaneStore.getCompanyScreeningDatabase();
    const cachedQualifiedCompanies = request.reuseQualifiedCompanyCache === false || companySearchMode === "exa_search"
      ? []
      : this.getCachedQualifiedCompanies(targetCategories, request.market, request.targetLeadCount);
    this.companySearchClient.setExaExcludedDomains(this.getCachedExcludedDiscoveryDomains(targetCategories));
    let suggestedFilters = companySearchMode === "exa_search"
      ? this.buildDirectExaSearchFilters(targetCategories, request.market)
      : this.orderFiltersByLearning(
          await this.getSuggestedFilters(
            request.market,
            request.customGoal,
            mainContext,
            request.searchStrategyContext,
            targetCategories,
            dryRun,
            learning,
            companySearchMode
          ),
          learning,
          request.market,
          request.customGoal
        );
    emitProgress({
      stage: "screening_filters",
      stageLabel: companySearchMode === "exa_search" ? "Exa sammelt Rohfirmen" : "Filter werden bewertet",
      progressValue: 10,
      progressMax: 100,
      progressDescription: companySearchMode === "exa_search"
        ? "Exa sammelt jetzt rohe Firmenkandidaten fuer die KI-Pruefung."
        : `0 von ${suggestedFilters.length} Filtern bewertet`,
      detail: companySearchMode === "exa_search"
        ? "Der Lead Agent startet jetzt rohe Exa-Suchen und uebergibt alle Treffer an die KI-Kategorisierung."
        : "Der Lead Agent prueft jetzt die Suchfilter und sammelt erste Kandidaten.",
      processedFilters: 0,
      totalFilters: suggestedFilters.length,
      foundCandidates: 0,
      targetLeadCount: request.targetLeadCount
    });
    const incrementalHubspotSync = {
      attempted: false,
      mode: (syncToHubSpot ? "live" : "dry-run") as "live" | "dry-run",
      candidateCount: 0,
      syncedCount: 0,
      companySyncedCount: 0,
      contactSyncedCount: 0,
      errors: [] as string[]
    };
    const targetSynchronizedCompanies = syncToHubSpot && !dryRun;
    const qualificationPoolTarget = targetSynchronizedCompanies
      ? Math.min(1000, Math.max(request.targetLeadCount * 4, request.targetLeadCount + targetCategories.length * 3))
      : request.targetLeadCount;
    const evaluations: FilterEvaluation[] = [];
    const shortlistedCompanies: PreCategorizedCompany[] = [];
    const shortlistedKeys = new Set<string>();
    const searchHistory: SearchHistoryEntry[] = [];
    const categoryQuotas = this.buildCategoryQuotas(qualificationPoolTarget, targetCategories);
    const categoryCounts = new Map<LeadCategory, number>(targetCategories.map((category) => [category, 0]));
    let filtersStoppedEarly = 0;
    let companiesSkippedAfterEarlyStop = 0;
    let completionReason: string | undefined;
    const hubSpotDedupQualifiedKeys = new Set<string>();
    const researchBriefsByCompany = new Map<string, ResearchBrief>();
    const contactCandidatesByCompany = new Map<string, PublicContactCandidate[]>();
    const flushedQualifiedCompanyKeys = new Set<string>();
    const getCompletionCount = () => targetSynchronizedCompanies ? incrementalHubspotSync.companySyncedCount : shortlistedCompanies.length;
    const getTargetProgressCount = () => companySearchMode === "exa_search"
      ? this.companySearchClient.getDiscoveryMetrics(companySearchMode).acceptedCompanyDomains
      : getCompletionCount();
    const hasReachedRequestedTarget = () => getTargetProgressCount() >= request.targetLeadCount;

    const finalizeInterruptedRun = async (shortlisted: PreCategorizedCompany[], errorMessage: string) => {
      await flushQualifiedCompanies(shortlisted, shortlisted.length);

      return this.finalizeLeadRun(
        request,
        suggestedFilters,
        evaluations,
        shortlisted,
        collectPreparedResearchBriefs(shortlisted),
        searchHistory,
        {
          ...incrementalHubspotSync,
          errors: [...incrementalHubspotSync.errors, errorMessage]
        },
        filtersStoppedEarly,
        companiesSkippedAfterEarlyStop,
        this.buildFunnel(
          companySearchMode,
          Math.max(hubSpotDedupQualifiedKeys.size, shortlisted.length),
          shortlisted.length,
          incrementalHubspotSync.companySyncedCount
        ),
        hasTimedOut(),
        wasStopped(),
        errorMessage,
        contactCandidatesByCompany
      );
    };

    this.companySearchClient.resetDiscoveryMetrics(companySearchMode);

    const collectPreparedResearchBriefs = (companies: PreCategorizedCompany[]): ResearchBrief[] =>
      companies
        .map((company) => researchBriefsByCompany.get(this.getCompanyKey(company)))
        .filter((brief): brief is ResearchBrief => Boolean(brief));

    const cachedAdded = this.addUniqueCompanies(shortlistedCompanies, cachedQualifiedCompanies, shortlistedKeys);
    if (cachedAdded > 0) {
      for (const company of shortlistedCompanies) {
        hubSpotDedupQualifiedKeys.add(this.getCompanyKey(company));
        categoryCounts.set(company.category, (categoryCounts.get(company.category) ?? 0) + 1);
      }

      emitProgress({
        stage: "screening_filters",
        stageLabel: "Cache-Treffer werden uebernommen",
        progressValue: 12,
        progressMax: 100,
        progressDescription: `${cachedAdded} bereits bekannte Firmen direkt aus dem Cache uebernommen`,
        detail: "Passend kategorisierte Firmen aus frueheren Runs wurden ohne neue Exa-Suche wiederverwendet.",
        processedFilters: 0,
        totalFilters: suggestedFilters.length,
        foundCandidates: shortlistedCompanies.length,
        targetLeadCount: request.targetLeadCount
      });
    }

    const flushQualifiedCompanies = async (companies: PreCategorizedCompany[], shortlistCount: number) => {
      const pendingCompanies = companies.filter((company) => !flushedQualifiedCompanyKeys.has(this.getCompanyKey(company)));
      if (pendingCompanies.length === 0) {
        return;
      }

      const emitSyncPreparationProgress = (progressValue: number, detail: string) => {
        const completionCount = getCompletionCount();
        emitProgress({
          stage: "syncing_hubspot",
          stageLabel: "HubSpot wird fortlaufend aktualisiert",
          progressValue,
          progressMax: 100,
          progressDescription: targetSynchronizedCompanies
            ? `${completionCount}/${request.targetLeadCount} Firmen nach HubSpot synchronisiert, ${shortlistCount} qualifiziert`
            : `${shortlistCount} qualifizierte Firmen bisher gesammelt`,
          detail,
          processedFilters: evaluations.length,
          totalFilters: suggestedFilters.length,
          foundCandidates: shortlistCount,
          targetLeadCount: request.targetLeadCount,
          funnel: this.buildFunnel(companySearchMode, hubSpotDedupQualifiedKeys.size, shortlistCount, incrementalHubspotSync.companySyncedCount)
        });
      };

      emitSyncPreparationProgress(
        Math.min(92, Math.max(35, Math.round((getCompletionCount() / Math.max(request.targetLeadCount, 1)) * 100))),
        targetSynchronizedCompanies
          ? `${pendingCompanies.length} weitere qualifizierte Firmen werden jetzt fuer den HubSpot-Sync vorbereitet.`
          : `${pendingCompanies.length} neue Firmen werden direkt recherchiert, mit Kontakten angereichert und nach HubSpot geschrieben.`
      );

      if (companySearchMode === "exa_search") {
        emitSyncPreparationProgress(40, `Research-Briefs werden fuer ${pendingCompanies.length} neue Firmen parallel vorbereitet. Insgesamt aktuell ${shortlistCount} qualifiziert.`);
      } else {
        emitSyncPreparationProgress(40, `Research-Briefs werden fuer ${pendingCompanies.length} Firmen parallel vorbereitet.`);
      }
      const preparedResearchEntries = dryRun
        ? []
        : await this.mapWithConcurrency(
            pendingCompanies.map((company) => async () => ({
              companyKey: this.getCompanyKey(company),
              brief: await this.withTimeout(
                this.azureClient.buildResearchBrief(company, dryRun, mainContext, learning, {
                  includeWebResearch: request.runDeepResearch !== false
                }),
                RESEARCH_BRIEF_TIMEOUT_MS,
                this.buildResearchBriefTimeoutFallback(company, mainContext)
              )
            })),
            this.outreachPrepConcurrency
          );

      for (const entry of preparedResearchEntries) {
        researchBriefsByCompany.set(entry.companyKey, entry.brief);
      }

      const syncEligibleCompanies = pendingCompanies;

      const pendingResearchBriefs = syncEligibleCompanies
        .map((company) => researchBriefsByCompany.get(this.getCompanyKey(company)))
        .filter((brief): brief is ResearchBrief => Boolean(brief));
      emitSyncPreparationProgress(56, `Website-Kontakte werden jetzt fuer ${syncEligibleCompanies.length} Firmen vorbereitet.`);

      const publicContacts = await this.collectPublicContacts(syncEligibleCompanies, dryRun);

      for (const company of syncEligibleCompanies) {
        const companyKey = this.getCompanyKey(company);
        contactCandidatesByCompany.set(companyKey, publicContacts.get(companyKey) ?? []);
      }

      const syncResult = await this.hubspotClient.syncQualifiedCompanies(
        syncEligibleCompanies,
        syncEligibleCompanies
          .map((company) => researchBriefsByCompany.get(this.getCompanyKey(company)))
          .filter((brief): brief is ResearchBrief => Boolean(brief)),
        publicContacts,
        !syncToHubSpot,
        ({ completedCompanies, totalCompanies, companyName }) => {
          const completionCount = incrementalHubspotSync.companySyncedCount + completedCompanies;
          emitSyncPreparationProgress(
            Math.min(92, 60 + Math.round((completedCompanies / Math.max(totalCompanies, 1)) * 32)),
            `${companyName} wird nach HubSpot geschrieben. ${completedCompanies}/${totalCompanies} Firmen in diesem Sync-Block verarbeitet.`
          );
          if (!targetSynchronizedCompanies) {
            return;
          }
          emitSyncPreparationProgress(
            Math.min(92, 60 + Math.round((completedCompanies / Math.max(totalCompanies, 1)) * 32)),
            `${companyName} wird nach HubSpot geschrieben. Gesamtstand ${completionCount}/${request.targetLeadCount} Firmen synchronisiert.`
          );
        }
      );

      incrementalHubspotSync.attempted = incrementalHubspotSync.attempted || syncResult.attempted;
      incrementalHubspotSync.candidateCount += syncResult.candidateCount;
      incrementalHubspotSync.syncedCount += syncResult.syncedCount;
      incrementalHubspotSync.companySyncedCount += syncResult.companySyncedCount;
      incrementalHubspotSync.contactSyncedCount += syncResult.contactSyncedCount;
      incrementalHubspotSync.errors.push(...syncResult.errors);

      for (const companyKey of syncResult.successfulCompanyKeys) {
        flushedQualifiedCompanyKeys.add(companyKey);
      }
    };

    if (companySearchMode === "exa_search") {
      const exaFilters = suggestedFilters.length > 0
        ? suggestedFilters
        : this.buildDirectExaSearchFilters(targetCategories, request.market);
      const maxQueryCount = Math.max(1, request.exaQueryCount ?? 4);
      const emitDirectExaProgress = (
        progressValue: number,
        detail: string,
        foundCandidates = shortlistedCompanies.length,
        processedFilters = 0,
        totalFilters = exaFilters.length
      ) => {
        emitProgress({
          stage: "screening_filters",
          stageLabel: "Exa -> KI Vorfilter",
          progressValue,
          progressMax: 100,
          progressDescription: `${foundCandidates}/${request.targetLeadCount} qualifiziert nach direktem Exa->KI Lauf`,
          detail,
          processedFilters,
          totalFilters,
          foundCandidates,
          targetLeadCount: request.targetLeadCount,
          funnel: this.buildFunnel(
            companySearchMode,
            hubSpotDedupQualifiedKeys.size,
            foundCandidates,
            incrementalHubspotSync.companySyncedCount
          )
        });
      };

      const directExaBatches = (await this.mapWithConcurrency(
        exaFilters.map((exaFilter, filterIndex) => async () => {
          const primaryCategory = exaFilter?.targetCategories?.[0] ?? targetCategories[0] ?? "machine_builder_ai_enablement";
          if (!exaFilter || shouldFinishEarly()) {
            return null;
          }

          emitDirectExaProgress(
            14,
            `Exa sammelt jetzt bis zu ${maxQueryCount} Query-Batches parallel fuer ${this.describeLeadCategory(primaryCategory)}. KI-Vorfilter und Kontaktanreicherung laufen danach parallel mit den konfigurierten Workern.`,
            shortlistedCompanies.length,
            filterIndex,
            exaFilters.length
          );

          const rawCompanies = await this.runDirectExaCompanySearch(exaFilter, targetCategories, maxQueryCount, {
            screeningScope: "live"
          }, {
            dryRun,
            learning,
            mainContext: request.mainContext,
            targetCategoryRefinement: request.targetCategoryRefinement,
            searchStrategyContext: request.searchStrategyContext,
            useAzureQueryPlanner: request.useAzureQueryPlanner
          }, ({ executedQueries, totalQueries, query, rawCompaniesFound }) => {
            emitDirectExaProgress(
              Math.min(42, 14 + executedQueries * 8),
              `Kategorie ${filterIndex + 1}/${exaFilters.length}: Exa Query ${executedQueries}/${totalQueries}: "${query}". Bisher ${rawCompaniesFound} Rohfirmen gesammelt.`,
              shortlistedCompanies.length,
              filterIndex,
              exaFilters.length
            );
          });

          return {
            filterIndex,
            exaFilter,
            primaryCategory,
            rawCompanies
          };
        }),
        Math.min(DIRECT_EXA_FILTER_CONCURRENCY, Math.max(1, exaFilters.length))
      ))
        .filter((entry): entry is { filterIndex: number; exaFilter: OrganizationFilter; primaryCategory: LeadCategory; rawCompanies: CompanySample[] } => Boolean(entry))
        .sort((left, right) => left.filterIndex - right.filterIndex);

      for (const { filterIndex, exaFilter, primaryCategory, rawCompanies } of directExaBatches) {
        if (shouldFinishEarly()) {
          break;
        }

        await this.controlPlaneStore.recordLiveExaRawResults(
          rawCompanies
            .map<RawExaHistoryEntry | null>((company) => {
              const domain = this.normalizeDomain(company.domain);
              if (!domain) {
                return null;
              }

              return {
                timestamp: new Date().toISOString(),
                domain,
                companyName: company.name,
                discoveryQuery: company.discoveryQuery,
                sourceFilter: company.sourceFilter
              };
            })
            .filter((entry): entry is RawExaHistoryEntry => Boolean(entry))
        );

        emitDirectExaProgress(
          48,
          `${rawCompanies.length} Rohfirmen aus Exa gefunden. KI-Vorfilter prueft jetzt die Websites parallel.`,
          shortlistedCompanies.length,
          filterIndex,
          exaFilters.length
        );

        const categorizedCompanies = await this.categorizeCompanies(
          rawCompanies,
          dryRun,
          mainContext,
          prequalification,
          targetCategories,
          learning,
          ({ completed, total, matched, companyName, category }) => {
            emitDirectExaProgress(
              Math.min(66, 48 + Math.round((completed / Math.max(total, 1)) * 18)),
              `Kategorie ${filterIndex + 1}/${exaFilters.length}: KI-Vorfilter ${completed}/${total}: ${companyName} -> ${category}. Bisher ${matched} passend.`,
              shortlistedCompanies.length + matched,
              filterIndex,
              exaFilters.length
            );
          }
        );
        const relevantCompanies = this.getRelevantCompanies(categorizedCompanies, exaFilter, targetCategories, request.market);
        const shortlistLengthBeforeDirectPath = shortlistedCompanies.length;
        const addedDirectCompanies = this.addUniqueCompanies(shortlistedCompanies, relevantCompanies, shortlistedKeys);
        shortlistedCompanies.slice(shortlistLengthBeforeDirectPath).forEach((company) => {
          categoryCounts.set(company.category, (categoryCounts.get(company.category) ?? 0) + 1);
          hubSpotDedupQualifiedKeys.add(this.getCompanyKey(company));
        });

        searchHistory.push(
          this.buildSearchHistoryEntry(
            request.companySearchMode ?? "exa_search",
            exaFilter.name,
            primaryCategory,
            "expand_50",
            1,
            rawCompanies.length,
            categorizedCompanies,
            exaFilter,
            targetCategories,
            request.market,
            0,
            {
              fetchedSampleCount: rawCompanies.length,
              eligibleSampleCount: rawCompanies.length,
              filteredByPriorFeedbackCount: 0,
              filteredByCacheCount: 0,
              filteredByHubSpotCount: 0,
              discoveryQueries: rawCompanies
                .map((company) => company.discoveryQuery?.trim())
                .filter((query): query is string => Boolean(query))
            }
          )
        );

        emitDirectExaProgress(
          66,
          `Kategorie ${filterIndex + 1}/${exaFilters.length} abgeschlossen: ${relevantCompanies.length}/${categorizedCompanies.length} Firmen passen zur Zielkategorie.`,
          shortlistedCompanies.length,
          filterIndex + 1,
          exaFilters.length
        );

        if (addedDirectCompanies > 0) {
          await flushQualifiedCompanies(shortlistedCompanies.slice(shortlistLengthBeforeDirectPath), shortlistedCompanies.length);
        }
      }

      if (shortlistedCompanies.length === 0) {
        return finalizeInterruptedRun(
          shortlistedCompanies,
          "Direct Exa + AI prefilter completed, but no qualified companies matched the selected categories."
        );
      }

      return this.finalizeLeadRun(
        request,
        suggestedFilters,
        evaluations,
        shortlistedCompanies,
        collectPreparedResearchBriefs(shortlistedCompanies),
        searchHistory,
        incrementalHubspotSync,
        filtersStoppedEarly,
        companiesSkippedAfterEarlyStop,
        this.buildFunnel(
          companySearchMode,
          hubSpotDedupQualifiedKeys.size,
          shortlistedCompanies.length,
          incrementalHubspotSync.companySyncedCount
        ),
        hasTimedOut(),
        wasStopped(),
        completionReason,
        contactCandidatesByCompany
      );
    }

    const emitFilterProgress = (detail: string) => {
      const processedFilters = evaluations.length;
      const totalFilters = Math.max(suggestedFilters.length, processedFilters || 1);
      emitProgress({
        stage: "screening_filters",
        stageLabel: "Filter werden bewertet",
        progressValue: Math.min(70, 10 + Math.round((processedFilters / totalFilters) * 60)),
        progressMax: 100,
        progressDescription: `${processedFilters} von ${totalFilters} Filtern bewertet`,
        detail,
        processedFilters,
        totalFilters,
        foundCandidates: shortlistedCompanies.length,
        targetLeadCount: request.targetLeadCount,
        funnel: this.buildFunnel(
          companySearchMode,
          hubSpotDedupQualifiedKeys.size,
          shortlistedCompanies.length,
          incrementalHubspotSync.companySyncedCount
        )
      });
    };

    const categoryStates = targetCategories.map((category) => ({
      category,
      categoryTarget: categoryQuotas[category] ?? 0,
      filters: suggestedFilters.filter((filter) => this.getPrimaryTargetCategoryForFilter(filter, targetCategories) === category),
      nextFilterIndex: 0
    }));
    let filterReplenishmentRounds = 0;
    const useHeuristicFilterOrchestration = false;

    while (!hasReachedRequestedTarget() && !shouldFinishEarly()) {
      const remainingTargetCount = Math.max(1, request.targetLeadCount - getTargetProgressCount());
      const parallelFilterProbeCount = this.getParallelFilterProbeCount(companySearchMode, remainingTargetCount);
      const filtersToExpandAfterProbe = this.getFiltersToExpandAfterProbe(companySearchMode, remainingTargetCount);
      const nextCategoryState = categoryStates
        .filter((state) => state.categoryTarget > 0)
        .filter((state) => (categoryCounts.get(state.category) ?? 0) < state.categoryTarget)
        .filter((state) => state.nextFilterIndex < state.filters.length)
        .sort((left, right) => {
          const leftRemaining = left.categoryTarget - (categoryCounts.get(left.category) ?? 0);
          const rightRemaining = right.categoryTarget - (categoryCounts.get(right.category) ?? 0);
          if (rightRemaining !== leftRemaining) {
            return rightRemaining - leftRemaining;
          }

          return left.nextFilterIndex - right.nextFilterIndex;
        })[0];

      if (!nextCategoryState) {
        if (!useHeuristicFilterOrchestration) {
          completionReason = `Die Suche endete, weil alle ${suggestedFilters.length} Filter im direkten Ablauf verarbeitet wurden.`;
          break;
        }

        const additionalFilters = await this.replenishExhaustedFilters(
          suggestedFilters,
          evaluations,
          request.market,
          request.customGoal,
          mainContext,
          request.searchStrategyContext,
          targetCategories,
          dryRun,
          learning
        );

        const replenishedFilters = additionalFilters.length > 0
          ? additionalFilters
          : this.buildFallbackReplenishmentFilters(suggestedFilters, evaluations, targetCategories, filterReplenishmentRounds + 1);

        if (replenishedFilters.length === 0) {
          completionReason = `Die Suche endete, weil alle ${suggestedFilters.length} Filter getestet wurden und keine neuen Filter nachgeneriert werden konnten.`;
          break;
        }

        filterReplenishmentRounds += 1;
        suggestedFilters = [...suggestedFilters, ...replenishedFilters];
        for (const state of categoryStates) {
          state.filters.push(
            ...replenishedFilters.filter((filter) => this.getPrimaryTargetCategoryForFilter(filter, targetCategories) === state.category)
          );
        }

        emitFilterProgress(
          `${replenishedFilters.length} neue Filter wurden nachgeneriert, weil die bisherige Liste ausgeschoepft war.`
        );
        continue;
      }

      if (!useHeuristicFilterOrchestration) {
        const filter = nextCategoryState.filters[nextCategoryState.nextFilterIndex];
        nextCategoryState.nextFilterIndex += 1;

        if (!filter) {
          continue;
        }

        emitFilterProgress(
          `Starte direkten Suchlauf fuer ${this.describeLeadCategory(nextCategoryState.category)} mit Filter "${filter.name}".`
        );

        const candidate = await this.probeFilterCandidate(
          filter,
          nextCategoryState.category,
          dryRun,
          syncToHubSpot,
          mainContext,
          prequalification,
          targetCategories,
          learning,
          request.market,
          webRawProbeCount,
          earlyStopReviewCount,
          earlyStopThreshold,
          companySearchMode,
          useWebSearchCompanyDiscovery,
          disableHubSpotDeduplication,
          openCrawlerTuning,
          emitFilterProgress
        );

        const shortlistLengthBeforeProbe = shortlistedCompanies.length;
        const addedFromProbe = this.addUniqueCompanies(shortlistedCompanies, candidate.initialRelevant, shortlistedKeys);
        categoryCounts.set(nextCategoryState.category, (categoryCounts.get(nextCategoryState.category) ?? 0) + addedFromProbe);
        searchHistory.push(
          this.buildSearchHistoryEntry(
            request.companySearchMode ?? "internet_research",
            candidate.filter.name,
            nextCategoryState.category,
            "probe_15",
            candidate.useWebSearchForExpansion ? 1 : candidate.apolloExpansionPage - 1,
            earlyStopReviewCount,
            candidate.categorizedInitialSample,
            candidate.filter,
            targetCategories,
            request.market,
            earlyStopThreshold,
            candidate.sampleDiagnostics
          )
        );

        emitFilterProgress(
          `Direkter Lauf fuer "${candidate.filter.name}": ${candidate.initialRelevant.length}/${candidate.categorizedInitialSample.length} relevant (${Math.round(candidate.initialEvaluation.relevanceRatio * 100)}%), Rohmenge ${candidate.sampleDiagnostics.fetchedSampleCount}, nach Cache/Vorfilter ${candidate.sampleDiagnostics.eligibleSampleCount}, Quelle Web.`
        );

        await flushQualifiedCompanies(shortlistedCompanies.slice(shortlistLengthBeforeProbe), shortlistedCompanies.length);

        if ((categoryCounts.get(nextCategoryState.category) ?? 0) < nextCategoryState.categoryTarget && !hasReachedRequestedTarget()) {
          const shortlistLengthBeforeExpansion = shortlistedCompanies.length;
          const expansionOutcome = await this.expandProbedFilter(
            candidate,
            request,
            dryRun,
            mainContext,
            prequalification,
            targetCategories,
            learning,
            disableHubSpotDeduplication,
            nextCategoryState.categoryTarget,
            categoryCounts,
            shortlistedCompanies,
            shortlistedKeys,
            searchHistory,
            earlyStopReviewCount,
            earlyStopThreshold,
            earlyStopMinRelevantCount,
            minimumCompaniesBeforeFilterGiveUp,
            openCrawlerTuning,
            emitFilterProgress,
            getCompletionCount,
            hasReachedRequestedTarget
          );

          evaluations.push(expansionOutcome.evaluation);
          if (expansionOutcome.stoppedEarly) {
            filtersStoppedEarly += 1;
            companiesSkippedAfterEarlyStop += expansionOutcome.skippedAfterEarlyStop;
          }

          await flushQualifiedCompanies(shortlistedCompanies.slice(shortlistLengthBeforeExpansion), shortlistedCompanies.length);
        } else {
          evaluations.push(candidate.initialEvaluation);
        }

        if (this.shouldAbortLowYieldExaRun(companySearchMode, evaluations.length, shortlistedCompanies.length)) {
          return finalizeInterruptedRun(
            shortlistedCompanies,
            "Run was stopped early because Exa discovery kept crawling results without producing qualified companies."
          );
        }

        continue;
      }

      const scheduledBatch = {
        activeCategory: nextCategoryState.category,
        categoryTarget: nextCategoryState.categoryTarget,
        probeBatch: nextCategoryState.filters.slice(nextCategoryState.nextFilterIndex, nextCategoryState.nextFilterIndex + parallelFilterProbeCount)
      };
      nextCategoryState.nextFilterIndex += scheduledBatch.probeBatch.length;

      const batchFilterNames = scheduledBatch.probeBatch.map((filter) => `"${filter.name}"`).join(", ");
      emitFilterProgress(
        `Starte Parallel-Probe fuer ${scheduledBatch.probeBatch.length} Filter in ${this.describeLeadCategory(scheduledBatch.activeCategory)}: ${batchFilterNames}.`
      );

      const probedResults = await this.mapWithConcurrency(
        scheduledBatch.probeBatch.map((filter) => async () => ({
          activeCategory: scheduledBatch.activeCategory,
          candidate: await this.probeFilterCandidate(
            filter,
            scheduledBatch.activeCategory,
            dryRun,
            syncToHubSpot,
            mainContext,
            prequalification,
            targetCategories,
            learning,
            request.market,
            webRawProbeCount,
            earlyStopReviewCount,
            earlyStopThreshold,
            companySearchMode,
            useWebSearchCompanyDiscovery,
            disableHubSpotDeduplication,
            openCrawlerTuning,
            emitFilterProgress
          )
        })),
        parallelFilterProbeCount
      );

      for (const activeCategory of targetCategories) {
        if (shouldFinishEarly() && !hasReachedRequestedTarget()) {
          return finalizeInterruptedRun(
            shortlistedCompanies,
            wasStopped()
              ? "Run was stopped manually before qualification completed."
              : "Run timed out before qualification completed."
          );
        }

        const categoryTarget = categoryQuotas[activeCategory] ?? 0;
        if (categoryTarget <= 0 || hasReachedRequestedTarget()) {
          continue;
        }

        const rankedCandidates: ProbedFilterCandidate[] = probedResults
          .filter((result) => result.activeCategory === activeCategory)
          .map((result) => result.candidate)
          .sort((left, right) => {
            if (right.initialEvaluation.relevanceRatio !== left.initialEvaluation.relevanceRatio) {
              return right.initialEvaluation.relevanceRatio - left.initialEvaluation.relevanceRatio;
            }

            return right.initialRelevant.length - left.initialRelevant.length;
          });

        if (rankedCandidates.length === 0) {
          continue;
        }

        const filtersToExpand = rankedCandidates.slice(0, Math.min(filtersToExpandAfterProbe, rankedCandidates.length));
        const discardedFilters = rankedCandidates.slice(filtersToExpand.length);

        const newlyQualifiedFromProbe: PreCategorizedCompany[] = [];

        for (const candidate of rankedCandidates) {
          const shortlistLengthBeforeProbe = shortlistedCompanies.length;
          const addedFromProbe = this.addUniqueCompanies(shortlistedCompanies, candidate.initialRelevant, shortlistedKeys);
          categoryCounts.set(activeCategory, (categoryCounts.get(activeCategory) ?? 0) + addedFromProbe);
          newlyQualifiedFromProbe.push(...shortlistedCompanies.slice(shortlistLengthBeforeProbe));
          searchHistory.push(
            this.buildSearchHistoryEntry(
              request.companySearchMode ?? "internet_research",
              candidate.filter.name,
              activeCategory,
              "probe_15",
              candidate.useWebSearchForExpansion ? 1 : candidate.apolloExpansionPage - 1,
              earlyStopReviewCount,
              candidate.categorizedInitialSample,
              candidate.filter,
              targetCategories,
              request.market,
              earlyStopThreshold,
              candidate.sampleDiagnostics
            )
          );

          emitFilterProgress(
            `Probe fuer "${candidate.filter.name}": ${candidate.initialRelevant.length}/${candidate.categorizedInitialSample.length} relevant (${Math.round(candidate.initialEvaluation.relevanceRatio * 100)}%), Rohmenge ${candidate.sampleDiagnostics.fetchedSampleCount}, nach Cache/Vorfilter ${candidate.sampleDiagnostics.eligibleSampleCount}, Quelle Web, Weiterlauf ab ${earlyStopMinRelevantCount} relevanten Treffern.`
          );
        }

        await flushQualifiedCompanies(newlyQualifiedFromProbe, shortlistedCompanies.length);

        for (const discardedCandidate of discardedFilters) {
          const discardedEvaluation: FilterEvaluation = {
            ...discardedCandidate.initialEvaluation,
            stoppedEarly: true,
            skippedAfterEarlyStop: Math.max(0, FULL_SAMPLE_SIZE - discardedCandidate.categorizedInitialSample.length),
            recommendation: `${discardedCandidate.initialEvaluation.recommendation} Discarded after the parallel probe because better filters outperformed it.`
          };

          evaluations.push(discardedEvaluation);
          filtersStoppedEarly += 1;
          companiesSkippedAfterEarlyStop += discardedEvaluation.skippedAfterEarlyStop;
          emitFilterProgress(
            `Filter "${discardedCandidate.filter.name}" verworfen: ${discardedCandidate.initialRelevant.length}/${discardedCandidate.categorizedInitialSample.length} relevant (${Math.round(discardedCandidate.initialEvaluation.relevanceRatio * 100)}%).`
          );
        }

        for (const selectedCandidate of filtersToExpand) {
          if ((categoryCounts.get(activeCategory) ?? 0) >= categoryTarget || hasReachedRequestedTarget()) {
            break;
          }

          const shortlistLengthBeforeExpansion = shortlistedCompanies.length;
          const expansionOutcome = await this.expandProbedFilter(
            selectedCandidate,
            request,
            dryRun,
            mainContext,
            prequalification,
            targetCategories,
            learning,
            disableHubSpotDeduplication,
            categoryTarget,
            categoryCounts,
            shortlistedCompanies,
            shortlistedKeys,
            searchHistory,
            earlyStopReviewCount,
            earlyStopThreshold,
            earlyStopMinRelevantCount,
            minimumCompaniesBeforeFilterGiveUp,
            openCrawlerTuning,
            emitFilterProgress,
            getCompletionCount,
            hasReachedRequestedTarget
          );

          evaluations.push(expansionOutcome.evaluation);
          if (expansionOutcome.stoppedEarly) {
            filtersStoppedEarly += 1;
            companiesSkippedAfterEarlyStop += expansionOutcome.skippedAfterEarlyStop;
          }

          await flushQualifiedCompanies(shortlistedCompanies.slice(shortlistLengthBeforeExpansion), shortlistedCompanies.length);
        }
      }

      if (this.shouldAbortLowYieldExaRun(companySearchMode, evaluations.length, shortlistedCompanies.length)) {
        return finalizeInterruptedRun(
          shortlistedCompanies,
          "Run was stopped early because Exa discovery kept crawling results without producing qualified companies."
        );
      }
    }

    if (shouldFinishEarly() && !hasReachedRequestedTarget()) {
      return finalizeInterruptedRun(
        shortlistedCompanies,
        wasStopped()
          ? "Run was stopped manually before top-up started."
          : "Run timed out before top-up started."
      );
    }

    const topUpFilters = this.prioritizeFiltersForTopUp(
      suggestedFilters,
      evaluations,
      learning,
      request.market,
      request.customGoal
    );
    const emitTopUpProgress = (detail: string, foundCandidates: number) => {
      emitProgress({
        stage: "topping_up_candidates",
        stageLabel: "Zusatzkandidaten werden gesucht",
        progressValue: 74,
        progressMax: 100,
        progressDescription: targetSynchronizedCompanies
          ? `${incrementalHubspotSync.companySyncedCount}/${request.targetLeadCount} Firmen synchronisiert, ${foundCandidates} qualifiziert`
          : `${foundCandidates}/${request.targetLeadCount} Firmen nach Top-up erreicht`,
        detail,
        processedFilters: evaluations.length,
        totalFilters: suggestedFilters.length,
        foundCandidates,
        targetLeadCount: request.targetLeadCount,
        funnel: this.buildFunnel(
          companySearchMode,
          hubSpotDedupQualifiedKeys.size,
          foundCandidates,
          incrementalHubspotSync.companySyncedCount
        )
      });
    };

    const sortedShortlist = shortlistedCompanies
      .sort((left, right) => right.relevanceScore - left.relevanceScore)
      .filter((company, index, all) => this.findFirstMatchingCompanyIndex(all, company) === index);

    const toppedUpShortlist = hasReachedRequestedTarget()
      ? sortedShortlist
      : await this.topUpWithWebDiscovery(
          sortedShortlist,
          shortlistedKeys,
          topUpFilters,
          evaluations,
          request,
          mainContext,
          prequalification,
          targetCategories,
          learning,
          openCrawlerTuning,
          emitTopUpProgress,
          getCompletionCount,
          hasReachedRequestedTarget,
          shouldFinishEarly
        );
    await flushQualifiedCompanies(toppedUpShortlist.slice(sortedShortlist.length), toppedUpShortlist.length);

    if (shouldFinishEarly() && !hasReachedRequestedTarget()) {
      return finalizeInterruptedRun(
        toppedUpShortlist,
        wasStopped()
          ? "Run was stopped manually during top-up."
          : "Run timed out during top-up."
      );
    }

    if (!hasReachedRequestedTarget() && !shouldFinishEarly() && !completionReason) {
      completionReason = `Die Suche endete nach ${evaluations.length}/${suggestedFilters.length} getesteten Filtern und ausgeschopfter Top-up-Suche mit ${incrementalHubspotSync.companySyncedCount} synchronisierten Firmen bei ${toppedUpShortlist.length} qualifizierten Treffern.`;
    }
    const filteredShortlist = await this.excludeExistingHubSpotDomains(
      toppedUpShortlist,
      dryRun,
      disableHubSpotDeduplication,
      syncToHubSpot
    );
    filteredShortlist.forEach((company) => hubSpotDedupQualifiedKeys.add(this.getCompanyKey(company)));

    if (shouldFinishEarly() && !hasReachedRequestedTarget()) {
      return finalizeInterruptedRun(
        filteredShortlist,
        wasStopped()
          ? "Run was stopped manually before replenishment top-up."
          : "Run timed out before replenishment top-up."
      );
    }

    const replenishedShortlist = hasReachedRequestedTarget()
      ? filteredShortlist
      : await this.topUpWithWebDiscovery(
          filteredShortlist,
          shortlistedKeys,
          topUpFilters,
          evaluations,
          request,
          mainContext,
          prequalification,
          targetCategories,
          learning,
          openCrawlerTuning,
          emitTopUpProgress,
          getCompletionCount,
          hasReachedRequestedTarget,
          shouldFinishEarly
        );
    await flushQualifiedCompanies(replenishedShortlist.slice(filteredShortlist.length), replenishedShortlist.length);
    const finalShortlist = await this.excludeExistingHubSpotDomains(
      replenishedShortlist,
      dryRun,
      disableHubSpotDeduplication,
      syncToHubSpot
    );
    finalShortlist.forEach((company) => hubSpotDedupQualifiedKeys.add(this.getCompanyKey(company)));
    const uniqueShortlist = targetSynchronizedCompanies ? finalShortlist : finalShortlist.slice(0, request.targetLeadCount);
    const funnelBeforeSync = this.buildFunnel(
      companySearchMode,
      hubSpotDedupQualifiedKeys.size,
      uniqueShortlist.length,
      0
    );

    if (shouldFinishEarly() && !hasReachedRequestedTarget()) {
      return finalizeInterruptedRun(
        uniqueShortlist,
        wasStopped()
          ? "Run was stopped manually before outreach preparation and HubSpot sync."
          : "Run timed out before outreach preparation and HubSpot sync."
      );
    }

    emitProgress({
      stage: "building_research",
      stageLabel: "Leads werden aufbereitet",
      progressValue: 78,
      progressMax: 100,
      progressDescription: targetSynchronizedCompanies
        ? `${incrementalHubspotSync.companySyncedCount}/${request.targetLeadCount} Firmen synchronisiert, ${uniqueShortlist.length} qualifiziert`
        : `${uniqueShortlist.length} qualifizierte Firmen werden vorbereitet`,
      detail: dryRun
        ? "Dry-Run aktiv: Research-Briefs werden uebersprungen."
        : "Research-Briefs und Zusatzdaten werden fuer die qualifizierten Firmen erstellt.",
      processedFilters: evaluations.length,
      totalFilters: suggestedFilters.length,
      foundCandidates: uniqueShortlist.length,
      targetLeadCount: request.targetLeadCount,
      funnel: funnelBeforeSync
    });

    await flushQualifiedCompanies(uniqueShortlist, uniqueShortlist.length);
    const researchBriefs = collectPreparedResearchBriefs(uniqueShortlist);
    const localityScopedResults = this.applyExplicitLocalityFilter(uniqueShortlist, researchBriefs, request.market);
    const localityScopedShortlist = localityScopedResults.companies;
    const localityScopedBriefs = localityScopedResults.researchBriefs;

    emitProgress({
      stage: "syncing_hubspot",
      stageLabel: "HubSpot wird aktualisiert",
      progressValue: 90,
      progressMax: 100,
      progressDescription: targetSynchronizedCompanies
        ? `${incrementalHubspotSync.companySyncedCount}/${request.targetLeadCount} Firmen nach HubSpot synchronisiert, ${localityScopedShortlist.length} qualifiziert`
        : `${localityScopedShortlist.length} qualifizierte Firmen werden synchronisiert`,
      detail: syncToHubSpot
        ? "Die qualifizierten Firmen und Kontakte werden jetzt nach HubSpot geschrieben."
        : "Synchronisierung deaktiviert. Die Ergebnisse werden nur lokal gespeichert.",
      processedFilters: evaluations.length,
      totalFilters: suggestedFilters.length,
      foundCandidates: localityScopedShortlist.length,
      targetLeadCount: request.targetLeadCount,
      funnel: funnelBeforeSync
    });

    const finalFunnel = this.buildFunnel(
      companySearchMode,
      hubSpotDedupQualifiedKeys.size,
      localityScopedShortlist.length,
      incrementalHubspotSync.companySyncedCount
    );

    return this.finalizeLeadRun(
      request,
      suggestedFilters,
      evaluations,
      localityScopedShortlist,
      localityScopedBriefs,
      searchHistory,
      incrementalHubspotSync,
      filtersStoppedEarly,
      companiesSkippedAfterEarlyStop,
      finalFunnel,
      false,
      false,
      completionReason,
      contactCandidatesByCompany
    );
  }

  async preview(request: LeadJobRequest): Promise<Pick<LeadJobResult, "requested" | "suggestedFilters">> {
    const targetCategories = this.getActiveTargetCategories(request.targetCategories);
    const mainContext = request.mainContext ?? request.agentContext;

    return {
      requested: {
        ...request,
        targetCategories
      },
      suggestedFilters: await this.getSuggestedFilters(
        request.market,
        request.customGoal,
        mainContext,
        request.searchStrategyContext,
        targetCategories,
        request.dryRun ?? true,
        undefined,
        request.companySearchMode
      )
    };
  }

  private async probeFilterCandidate(
    filter: OrganizationFilter,
    activeCategory: LeadCategory,
    dryRun: boolean,
    syncToHubSpot: boolean,
    mainContext: string | undefined,
    prequalification: PrequalificationConfig | undefined,
    targetCategories: LeadCategory[],
    learning: LeadLearningData,
    market: string | undefined,
    webRawProbeCount: number,
    earlyStopReviewCount: number,
    earlyStopThreshold: number,
    companySearchMode: import("../types").CompanySearchMode,
    useWebSearchCompanyDiscovery: boolean,
    disableHubSpotDeduplication: boolean,
    openCrawlerTuning: LeadJobRequest["openCrawlerTuning"] | undefined,
    emitFilterProgress: (detail: string) => void
  ): Promise<ProbedFilterCandidate> {
    const reviewedCompanies: PreCategorizedCompany[] = [];
    const probeSourceLabel = this.getDiscoverySourceLabel(companySearchMode);
    const exaQueryPreview = this.buildExaQueryPreview(filter);
    const rawSearchProbeMessage = `Starte rohe Exa-Suche fuer ${this.describeLeadCategory(activeCategory)}. Quelle ${probeSourceLabel}, Region ${filter.locations.join(", ") || "unbekannt"}${exaQueryPreview ? `, Exa-Query \"${exaQueryPreview}\"` : ""}. Es werden bis zu ${useWebSearchCompanyDiscovery ? webRawProbeCount : earlyStopReviewCount} ${useWebSearchCompanyDiscovery ? "Web-Sites" : "Firmen"} roh gesammelt und danach von der KI kategorisiert.`;
    const filterProbeMessage = `Teste Filter "${filter.name}" fuer ${this.describeLeadCategory(activeCategory)}. Quelle ${probeSourceLabel}, Region ${filter.locations.join(", ") || "unbekannt"}, Keywords ${filter.keywords.slice(0, 4).join(", ") || "keine"}. Probe mit bis zu ${useWebSearchCompanyDiscovery ? webRawProbeCount : earlyStopReviewCount} ${useWebSearchCompanyDiscovery ? "Web-Sites" : "Firmen"} startet.`;
    emitFilterProgress(
      companySearchMode === "exa_search" ? rawSearchProbeMessage : filterProbeMessage
    );

    let useWebSearchForExpansion = useWebSearchCompanyDiscovery;
    let expansionSearchMode = companySearchMode;
    let apolloExpansionPage = useWebSearchCompanyDiscovery || dryRun
      ? 1
      : await this.controlPlaneStore.getSearchCursor(filter);
    const probeFetch = await this.fetchAvailableSearchSample(
      filter,
      earlyStopReviewCount,
      dryRun,
      apolloExpansionPage,
      companySearchMode,
      useWebSearchCompanyDiscovery,
      disableHubSpotDeduplication,
      syncToHubSpot,
      targetCategories,
      learning,
      reviewedCompanies,
      useWebSearchCompanyDiscovery ? webRawProbeCount : undefined,
      companySearchMode === "open_crawler_search"
        ? {
            webSearchMaxPages: openCrawlerTuning?.maxPages,
            webSearchSampleMultiplier: openCrawlerTuning?.sampleMultiplier,
            webSearchMinSampleSize: openCrawlerTuning?.minSampleSize,
            webSearchRawCollectionMultiplier: openCrawlerTuning?.rawCollectionMultiplier
          }
        : undefined,
      () => emitFilterProgress(companySearchMode === "exa_search" ? rawSearchProbeMessage : filterProbeMessage)
    );
    const probeSample = probeFetch.companies;
    apolloExpansionPage = probeFetch.nextPage;
    let categorizedInitialSample = await this.categorizeCompanies(
      probeSample,
      dryRun,
      mainContext,
      prequalification,
      targetCategories,
      learning
    );
    let sampleDiagnostics = probeFetch.diagnostics;
    let initialEvaluation = this.evaluateFilter(
      filter.name,
      categorizedInitialSample,
      filter,
      targetCategories,
      market,
      categorizedInitialSample.length,
      false
    );

    if (!useWebSearchCompanyDiscovery) {
      const initialRelevantFromApollo = this.getRelevantCompanies(categorizedInitialSample, filter, targetCategories, market);
      if (initialRelevantFromApollo.length === 0 || initialEvaluation.relevanceRatio < earlyStopThreshold) {
        const webFallbackSourceLabel = this.getDiscoverySourceLabel("internet_research");
        const webFallbackProbe = await this.fetchAvailableSearchSample(
          filter,
          earlyStopReviewCount,
          dryRun,
          1,
          "internet_research",
          true,
          disableHubSpotDeduplication,
          syncToHubSpot,
          targetCategories,
          learning,
          reviewedCompanies,
          webRawProbeCount,
          companySearchMode === "open_crawler_search"
            ? {
                webSearchMaxPages: openCrawlerTuning?.maxPages,
                webSearchSampleMultiplier: openCrawlerTuning?.sampleMultiplier,
                webSearchMinSampleSize: openCrawlerTuning?.minSampleSize,
                webSearchRawCollectionMultiplier: openCrawlerTuning?.rawCollectionMultiplier
              }
            : undefined,
          () => emitFilterProgress(
            companySearchMode === "exa_search"
              ? `Starte rohe Exa-Suche fuer ${this.describeLeadCategory(activeCategory)}. Quelle ${webFallbackSourceLabel}, Region ${filter.locations.join(", ") || "unbekannt"}${exaQueryPreview ? `, Exa-Query \"${exaQueryPreview}\"` : ""}. Es werden bis zu ${webRawProbeCount} Web-Sites roh gesammelt und danach von der KI kategorisiert.`
              : `Teste Filter "${filter.name}" fuer ${this.describeLeadCategory(activeCategory)}. Quelle ${webFallbackSourceLabel}, Region ${filter.locations.join(", ") || "unbekannt"}, Keywords ${filter.keywords.slice(0, 4).join(", ") || "keine"}. Probe mit bis zu ${webRawProbeCount} Web-Sites startet.`
          )
        );
        const categorizedWebFallbackProbe = await this.categorizeCompanies(
          webFallbackProbe.companies,
          dryRun,
          mainContext,
          prequalification,
          targetCategories,
          learning
        );
        const relevantFromWebFallback = this.getRelevantCompanies(categorizedWebFallbackProbe, filter, targetCategories, market);
        const webFallbackEvaluation = this.evaluateFilter(
          filter.name,
          categorizedWebFallbackProbe,
          filter,
          targetCategories,
          market,
          categorizedWebFallbackProbe.length,
          false
        );

        if (
          relevantFromWebFallback.length > initialRelevantFromApollo.length ||
          webFallbackEvaluation.relevanceRatio > initialEvaluation.relevanceRatio
        ) {
          categorizedInitialSample = categorizedWebFallbackProbe;
          initialEvaluation = webFallbackEvaluation;
          sampleDiagnostics = webFallbackProbe.diagnostics;
          useWebSearchForExpansion = true;
          expansionSearchMode = "internet_research";
        }
      }
    }

    reviewedCompanies.push(...categorizedInitialSample);

    return {
      filter,
      activeCategory,
      reviewedCompanies,
      categorizedInitialSample,
      sampleDiagnostics,
      initialEvaluation,
      initialRelevant: this.getRelevantCompanies(categorizedInitialSample, filter, targetCategories, market),
      useWebSearchForExpansion,
      expansionSearchMode,
      apolloExpansionPage
    };
  }

  private async expandProbedFilter(
    candidate: ProbedFilterCandidate,
    request: LeadJobRequest,
    dryRun: boolean,
    mainContext: string | undefined,
    prequalification: PrequalificationConfig | undefined,
    targetCategories: LeadCategory[],
    learning: LeadLearningData,
    disableHubSpotDeduplication: boolean,
    categoryTarget: number,
    categoryCounts: Map<LeadCategory, number>,
    shortlistedCompanies: PreCategorizedCompany[],
    shortlistedKeys: Set<string>,
    searchHistory: SearchHistoryEntry[],
    earlyStopReviewCount: number,
    earlyStopThreshold: number,
    earlyStopMinRelevantCount: number,
    minimumCompaniesBeforeFilterGiveUp: number,
    openCrawlerTuning: LeadJobRequest["openCrawlerTuning"] | undefined,
    emitFilterProgress: (detail: string) => void,
    getCompletionCount: () => number,
    hasReachedRequestedTarget: () => boolean
  ): Promise<ExpandedFilterOutcome> {
    const reviewedCompanies = [...candidate.reviewedCompanies];
    let apolloExpansionPage = candidate.apolloExpansionPage;
    const isRawExaSearch = request.companySearchMode === "exa_search";

    if (
      candidate.useWebSearchForExpansion &&
      candidate.initialRelevant.length === 0
    ) {
      const evaluation: FilterEvaluation = {
        ...candidate.initialEvaluation,
        stoppedEarly: true,
        skippedAfterEarlyStop: Math.max(0, FULL_SAMPLE_SIZE - candidate.categorizedInitialSample.length),
        recommendation: `${candidate.initialEvaluation.recommendation} Web expansion stopped because the initial probe found no relevant companies.`
      };
      emitFilterProgress(
        isRawExaSearch
          ? `Roh-Exa-Suchlauf frueh gestoppt nach KI-Pruefung: ${candidate.initialRelevant.length}/${candidate.categorizedInitialSample.length} passend, Rohmenge ${candidate.sampleDiagnostics.fetchedSampleCount}, nach Cache/Vorfilter ${candidate.sampleDiagnostics.eligibleSampleCount}.`
          : `Filter "${candidate.filter.name}" frueh gestoppt nach Web-Probe: ${candidate.initialRelevant.length}/${candidate.categorizedInitialSample.length} relevant, Rohmenge ${candidate.sampleDiagnostics.fetchedSampleCount}, nach Cache/Vorfilter ${candidate.sampleDiagnostics.eligibleSampleCount}.`
      );

      return {
        evaluation,
        categoryAdded: 0,
        stoppedEarly: true,
        skippedAfterEarlyStop: evaluation.skippedAfterEarlyStop
      };
    }

    if (
      candidate.categorizedInitialSample.length >= minimumCompaniesBeforeFilterGiveUp &&
      candidate.initialEvaluation.relevanceRatio < earlyStopThreshold &&
      candidate.initialRelevant.length < earlyStopMinRelevantCount
    ) {
      const skippedAfterEarlyStop = Math.max(0, FULL_SAMPLE_SIZE - candidate.categorizedInitialSample.length);
      const evaluation: FilterEvaluation = {
        ...candidate.initialEvaluation,
        stoppedEarly: true,
        skippedAfterEarlyStop,
        recommendation: `${candidate.initialEvaluation.recommendation} Early stop triggered after ${candidate.categorizedInitialSample.length} reviews and fewer than ${earlyStopMinRelevantCount} relevant firms.`
      };
      emitFilterProgress(
        isRawExaSearch
          ? `Roh-Exa-Suchlauf frueh gestoppt: ${candidate.initialRelevant.length}/${candidate.categorizedInitialSample.length} passend (${Math.round(candidate.initialEvaluation.relevanceRatio * 100)}%). Bisher ${shortlistedCompanies.length}/${request.targetLeadCount} Ziel-Firmen gesammelt.`
          : `Filter "${candidate.filter.name}" frueh gestoppt: ${candidate.initialRelevant.length}/${candidate.categorizedInitialSample.length} relevant (${Math.round(candidate.initialEvaluation.relevanceRatio * 100)}%). Bisher ${shortlistedCompanies.length}/${request.targetLeadCount} Ziel-Firmen gesammelt.`
      );

      return {
        evaluation,
        categoryAdded: 0,
        stoppedEarly: true,
        skippedAfterEarlyStop
      };
    }

    let categoryAdded = 0;
    for (let page = 1; page <= 10; page += 1) {
      const remainingCategorySlots = Math.max(0, categoryTarget - (categoryCounts.get(candidate.activeCategory) ?? 0));
      const remainingGlobalSlots = Math.max(1, request.targetLeadCount - getCompletionCount());
      const expansionBatchSize = this.getExpansionBatchSize(
        Math.min(remainingCategorySlots || remainingGlobalSlots, remainingGlobalSlots),
        candidate.useWebSearchForExpansion
      );
      const requestedPage = candidate.useWebSearchForExpansion ? page : apolloExpansionPage;
      const expandedFetch = await this.fetchAvailableSearchSample(
        candidate.filter,
        expansionBatchSize,
        dryRun,
        requestedPage,
        candidate.expansionSearchMode,
        candidate.useWebSearchForExpansion,
        disableHubSpotDeduplication,
        request.syncToHubSpot ?? !dryRun,
        targetCategories,
        learning,
        reviewedCompanies,
        undefined,
        candidate.expansionSearchMode === "open_crawler_search"
          ? {
              webSearchMaxPages: openCrawlerTuning?.maxPages,
              webSearchSampleMultiplier: openCrawlerTuning?.sampleMultiplier,
              webSearchMinSampleSize: openCrawlerTuning?.minSampleSize,
              webSearchRawCollectionMultiplier: openCrawlerTuning?.rawCollectionMultiplier
            }
          : undefined,
        () => emitFilterProgress(
          isRawExaSearch
            ? `Roh-Exa-Suchlauf wird erweitert. Seite ${requestedPage}, Batch ${expansionBatchSize}, aktuell ${getCompletionCount()}/${request.targetLeadCount} Ziel-Firmen erreicht.`
            : `Filter "${candidate.filter.name}" wird weiter ausgebaut. Seite ${requestedPage}, Batch ${expansionBatchSize}, aktuell ${getCompletionCount()}/${request.targetLeadCount} Ziel-Firmen erreicht.`
        )
      );
      const expandedSample = expandedFetch.companies;
      if (!candidate.useWebSearchForExpansion) {
        apolloExpansionPage = expandedFetch.nextPage;
      }

      if (expandedSample.length === 0) {
        break;
      }

      const unseenExpandedSample = this.excludeAlreadyReviewedCompanies(expandedSample, reviewedCompanies);
      if (unseenExpandedSample.length === 0) {
        if (expandedSample.length < EXPANSION_BATCH_SIZE) {
          break;
        }

        continue;
      }

      const categorizedExpandedSample = await this.categorizeCompanies(
        unseenExpandedSample,
        dryRun,
        mainContext,
        prequalification,
        targetCategories,
        learning
      );
      reviewedCompanies.push(...categorizedExpandedSample);
      const expandedRelevant = this.getRelevantCompanies(categorizedExpandedSample, candidate.filter, targetCategories, request.market);
      const addedFromExpansion = this.addUniqueCompanies(shortlistedCompanies, expandedRelevant, shortlistedKeys);
      categoryAdded += addedFromExpansion;
      categoryCounts.set(candidate.activeCategory, (categoryCounts.get(candidate.activeCategory) ?? 0) + addedFromExpansion);

      const cumulativeEvaluation = this.evaluateFilter(
        candidate.filter.name,
        reviewedCompanies,
        candidate.filter,
        targetCategories,
        request.market,
        reviewedCompanies.length,
        false
      );

      searchHistory.push(
        this.buildSearchHistoryEntry(
          request.companySearchMode ?? candidate.expansionSearchMode,
          candidate.filter.name,
          candidate.activeCategory,
          "expand_50",
          requestedPage,
          expansionBatchSize,
          categorizedExpandedSample,
          candidate.filter,
          targetCategories,
          request.market,
          earlyStopThreshold,
          expandedFetch.diagnostics
        )
      );

      if (
        reviewedCompanies.length >= minimumCompaniesBeforeFilterGiveUp &&
        cumulativeEvaluation.relevanceRatio < earlyStopThreshold &&
        cumulativeEvaluation.relevantCount < earlyStopMinRelevantCount
      ) {
        const evaluation: FilterEvaluation = {
          ...cumulativeEvaluation,
          stoppedEarly: true,
          skippedAfterEarlyStop: Math.max(0, FULL_SAMPLE_SIZE - reviewedCompanies.length),
          recommendation: `${cumulativeEvaluation.recommendation} Expansion stopped because stronger filters are outperforming it.`
        };
        emitFilterProgress(
          isRawExaSearch
            ? `Roh-Exa-Suchlauf waehrend Erweiterung frueh gestoppt: ${evaluation.relevantCount}/${evaluation.totalReviewed} passend (${Math.round(evaluation.relevanceRatio * 100)}%).`
            : `Filter "${candidate.filter.name}" frueh gestoppt waehrend Expansion: ${evaluation.relevantCount}/${evaluation.totalReviewed} relevant (${Math.round(evaluation.relevanceRatio * 100)}%).`
        );

        return {
          evaluation,
          categoryAdded,
          stoppedEarly: true,
          skippedAfterEarlyStop: evaluation.skippedAfterEarlyStop
        };
      }

      if (expandedSample.length < expansionBatchSize) {
        break;
      }

      if ((categoryCounts.get(candidate.activeCategory) ?? 0) >= categoryTarget || hasReachedRequestedTarget()) {
        break;
      }
    }

    const evaluation = this.evaluateFilter(
      candidate.filter.name,
      reviewedCompanies,
      candidate.filter,
      targetCategories,
      request.market,
      candidate.categorizedInitialSample.length,
      false
    );
    emitFilterProgress(
      isRawExaSearch
        ? `Roh-Exa-Suchlauf abgeschlossen: ${evaluation.relevantCount}/${evaluation.totalReviewed} passend (${Math.round(evaluation.relevanceRatio * 100)}%). Aktuell ${getCompletionCount()}/${request.targetLeadCount} Ziel-Firmen erreicht.`
        : `Filter "${candidate.filter.name}" abgeschlossen: ${evaluation.relevantCount}/${evaluation.totalReviewed} relevant (${Math.round(evaluation.relevanceRatio * 100)}%). Aktuell ${getCompletionCount()}/${request.targetLeadCount} Ziel-Firmen erreicht.`
    );

    return {
      evaluation,
      categoryAdded,
      stoppedEarly: false,
      skippedAfterEarlyStop: 0
    };
  }

  private async getSuggestedFilters(
    market: string | undefined,
    customGoal: string | undefined,
    mainContext: string | undefined,
    searchStrategyContext: string | undefined,
    targetCategories: LeadCategory[],
    dryRun: boolean,
    learning?: LeadLearningData,
    companySearchMode?: import("../types").CompanySearchMode
  ) {
    if (companySearchMode === "exa_search") {
      return this.buildRawExaSearchFilters(market, customGoal, targetCategories);
    }

    const baselineFilters = buildSuggestedFilters(market, customGoal)
      .filter((filter) => this.filterSupportsTargetCategories(filter, targetCategories));
    const modeAdjustedBaselineFilters = companySearchMode === "open_crawler_search"
      ? this.prioritizeFiltersForOpenCrawler(baselineFilters, targetCategories, learning, market, customGoal)
      : baselineFilters;
    if (this.shouldReuseLearnedFilters(modeAdjustedBaselineFilters, learning, customGoal, mainContext, searchStrategyContext)) {
      return modeAdjustedBaselineFilters;
    }

    if (companySearchMode === "open_crawler_search") {
      return modeAdjustedBaselineFilters;
    }

    if (companySearchMode === "diffbot_test_data") {
      return modeAdjustedBaselineFilters;
    }

    const adaptiveSearchStrategyContext = this.buildAdaptiveSearchStrategyContext(searchStrategyContext);

    const generatedFilters = await this.azureClient.generateSuggestedFilters(
      market,
      customGoal,
      mainContext,
      adaptiveSearchStrategyContext,
      targetCategories,
      baselineFilters,
      dryRun,
      learning
    );

    return [...modeAdjustedBaselineFilters, ...generatedFilters.filter((filter) => this.filterSupportsTargetCategories(filter, targetCategories))]
      .filter((filter, index, all) => all.findIndex((candidate) => candidate.name === filter.name) === index);
  }

  private buildRawExaSearchFilters(
    market: string | undefined,
    customGoal: string | undefined,
    targetCategories: LeadCategory[]
  ): OrganizationFilter[] {
    const baselineFilters = buildSuggestedFilters(market, customGoal)
      .filter((filter) => this.filterSupportsTargetCategories(filter, targetCategories));
    const filters: OrganizationFilter[] = [];

    for (const targetCategory of targetCategories) {
      const match = baselineFilters.find((filter) => {
        const filterCategories = filter.targetCategories?.length ? filter.targetCategories : this.inferTargetCategories(filter.name);
        return filterCategories.includes(targetCategory);
      });

      if (!match) {
        continue;
      }

      filters.push({
        ...match,
        name: `Raw Exa Search - ${targetCategory}`,
        notes: `${match.notes} Raw Exa discovery scaffold for ${targetCategory}. Forward every Exa result directly to AI categorization before any category-based exclusion.`
      });
    }

    if (filters.length > 0) {
      return filters;
    }

    return baselineFilters.slice(0, 1).map((filter) => ({
      ...filter,
      name: "Raw Exa Search",
      notes: `${filter.notes} Raw Exa discovery scaffold. Forward every Exa result directly to AI categorization before any category-based exclusion.`
    }));
  }

  private prioritizeFiltersForOpenCrawler(
    filters: OrganizationFilter[],
    targetCategories: LeadCategory[],
    learning: LeadLearningData | undefined,
    market?: string,
    customGoal?: string
  ): OrganizationFilter[] {
    const excludedNames = new Set([
      "Germany Embedded Vision Engineering Firms",
      "Benelux DACH Vision Integration Specialists",
      "France Vision Industrielle Integrateurs",
      "Italy Visione Industriale Integratori",
      "Spain Vision Industrial Integradores",
      "France Italy Spain Vision Inspection Integrators"
    ]);
    const softwareLedNames = new Set([
      "Germany Smart Factory Software Engineering Partners",
      "Germany Automation Software Integrators",
      "DACH Industrial Software Integration Partners"
    ]);
    const consultingNames = new Set([
      "Germany Vision AI Consulting Specialists"
    ]);
    const machineBuilderNames = new Set([
      "DACH Machine Builders For AI Options"
    ]);
    const industrialEndCustomerNames = new Set([
      "DACH Scaled Industrial End Customers"
    ]);
    const platformNames = new Set([
      "Europe Software Platforms For Embedding"
    ]);
    const preferredSoftwareNames = new Set([
      "Germany Automation Software Integrators",
      "Germany Smart Factory Software Engineering Partners",
      "DACH Industrial Software Integration Partners"
    ]);
    const preferredVisionNames = new Set([
      "Germany Industrial Computer Vision Engineering Services",
      "Germany Machine Vision System Integrators",
      "Austria Switzerland Vision Inspection Integrators",
      "Netherlands Sweden Vision Automation Integrators",
      "Europe Vision System Integrators",
      "Europe Industrial Inspection Engineering Firms"
    ]);
    const wantsGeneralAISignals = targetCategories.includes("integrator_general_ai");
    const wantsVisionSignals = targetCategories.includes("integrator_vision_industrial_ai");
    const wantsConsultingSignals = targetCategories.includes("integrator_vision_ai_consulting");
    const wantsMachineBuilderSignals = targetCategories.includes("machine_builder_ai_enablement");
    const wantsIndustrialEndCustomers = targetCategories.includes("industrial_end_customer_scaled");
    const wantsPlatformSignals = targetCategories.includes("software_platform_embedding");
    const wantsBroadCategoryMix =
      wantsVisionSignals ||
      wantsConsultingSignals ||
      wantsMachineBuilderSignals ||
      wantsIndustrialEndCustomers ||
      wantsPlatformSignals;

    const filtered = filters.filter((filter) => {
      if (excludedNames.has(filter.name)) {
        return false;
      }

      if (!wantsGeneralAISignals && softwareLedNames.has(filter.name)) {
        return false;
      }

      if (wantsGeneralAISignals && !wantsBroadCategoryMix && !softwareLedNames.has(filter.name)) {
        return false;
      }

      if (!wantsConsultingSignals && consultingNames.has(filter.name)) {
        return false;
      }

      if (!wantsMachineBuilderSignals && machineBuilderNames.has(filter.name)) {
        return false;
      }

      if (!wantsIndustrialEndCustomers && industrialEndCustomerNames.has(filter.name)) {
        return false;
      }

      if (!wantsPlatformSignals && platformNames.has(filter.name)) {
        return false;
      }

      return true;
    });

    const getModeBias = (filterName: string): number => {
      if (wantsGeneralAISignals && !wantsBroadCategoryMix) {
        if (preferredSoftwareNames.has(filterName)) {
          return 1.2;
        }

        return -1;
      }

      let bias = 0;

      if (wantsGeneralAISignals && preferredSoftwareNames.has(filterName)) {
        bias += 0.9;
      }

      if (wantsVisionSignals && preferredVisionNames.has(filterName)) {
        bias += 0.8;
      }

      if (wantsConsultingSignals && consultingNames.has(filterName)) {
        bias += 0.75;
      }

      if (wantsMachineBuilderSignals && machineBuilderNames.has(filterName)) {
        bias += 0.8;
      }

      if (wantsIndustrialEndCustomers && industrialEndCustomerNames.has(filterName)) {
        bias += 0.65;
      }

      if (wantsPlatformSignals && platformNames.has(filterName)) {
        bias += 0.55;
      }

      return bias;
    };

    const ranked = [...filtered].sort((left, right) => {
      const leftRank = (learning ? this.getFilterRank(left.name, learning, market, customGoal) : 0) + getModeBias(left.name);
      const rightRank = (learning ? this.getFilterRank(right.name, learning, market, customGoal) : 0) + getModeBias(right.name);
      return rightRank - leftRank;
    });

    if (wantsBroadCategoryMix) {
      const coverageBuckets: string[][] = [
        wantsGeneralAISignals ? [...preferredSoftwareNames] : [],
        wantsVisionSignals ? [...preferredVisionNames] : [],
        wantsConsultingSignals ? [...consultingNames] : [],
        wantsMachineBuilderSignals ? [...machineBuilderNames] : [],
        wantsIndustrialEndCustomers ? [...industrialEndCustomerNames] : [],
        wantsPlatformSignals ? [...platformNames] : []
      ];
      const coveredNames = new Set<string>();
      const coveredFilters: OrganizationFilter[] = [];

      for (const bucket of coverageBuckets) {
        const firstMatch = ranked.find((filter) => bucket.includes(filter.name) && !coveredNames.has(filter.name));
        if (!firstMatch) {
          continue;
        }

        coveredNames.add(firstMatch.name);
        coveredFilters.push(firstMatch);
      }

      for (const filter of ranked) {
        if (coveredNames.has(filter.name)) {
          continue;
        }

        coveredFilters.push(filter);
        coveredNames.add(filter.name);
      }

      return coveredFilters;
    }

    return ranked;
  }

  private buildAdaptiveSearchStrategyContext(searchStrategyContext?: string): string | undefined {
    const recentRecords = this.companyScreeningDatabase.records
      .filter((record) => record.category)
      .slice(0, 250);

    if (recentRecords.length === 0) {
      return searchStrategyContext;
    }

    const counts = recentRecords.reduce<Record<string, number>>((accumulator, record) => {
      const key = record.category ?? "unknown";
      accumulator[key] = (accumulator[key] ?? 0) + 1;
      return accumulator;
    }, {});

    const hints: string[] = [];

    if ((counts.integrator_vision_industrial_ai ?? 0) >= 3) {
      hints.push(
        "Keep proven positive angles from recent good firms: machine vision, visual inspection, optical inspection, AOI, quality inspection, system integration, commissioning, and customer-specific delivery ownership."
      );
    }

    if ((counts.integrator_general_ai ?? 0) >= 3 || (counts.integrator_relevant_focus ?? 0) >= 3) {
      hints.push(
        "Keep adjacent industrial software and automation-integrator angles when implementation ownership, references, and customer projects are explicit."
      );
    }

    if ((counts.camera_manufacturer_partner ?? 0) >= 3) {
      hints.push(
        "Minimal negative adjustment: filter out camera manufacturers, component vendors, sensor suppliers, lighting vendors, and product-heavy imaging firms unless services, integration, commissioning, support, or references are explicit."
      );
    }

    if ((counts.irrelevant ?? 0) >= 3) {
      hints.push(
        "Minimal negative adjustment: exclude publishers, media, event operators, associations, investors, recruiting firms, and other non-operating entities earlier in the search loop."
      );
    }

    if (hints.length === 0) {
      return searchStrategyContext;
    }

    return [
      searchStrategyContext?.trim(),
      "Adaptive tuning from recent screening:",
      ...hints.map((hint) => `- ${hint}`)
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private async categorizeCompanies(
    companies: CompanySample[],
    dryRun: boolean,
    mainContext?: string,
    prequalification?: PrequalificationConfig,
    targetCategories?: LeadCategory[],
    learning?: LeadLearningData,
    onProgress?: (update: { completed: number; total: number; matched: number; companyName: string; category: LeadCategory }) => void
  ): Promise<PreCategorizedCompany[]> {
    let completed = 0;
    let matched = 0;
    const total = companies.length;

    return this.mapWithConcurrency(
      companies.map((company) => async () => {
        const useWebsiteBackedClassification = Boolean(company.domain);
        const cachedCategorization = dryRun ? this.getCachedCategorization(company) : null;
        if (cachedCategorization) {
          const resolvedCachedCategorization = this.normalizeCompanyIdentity({
            ...company,
            ...this.enforceIndustrialFit(company, cachedCategorization)
          });
          this.upsertCompanyScreeningRecord(resolvedCachedCategorization, {
            category: resolvedCachedCategorization.category,
            relevanceScore: resolvedCachedCategorization.relevanceScore,
            rationale: resolvedCachedCategorization.rationale
          });
          completed += 1;
          if (!targetCategories || targetCategories.includes(resolvedCachedCategorization.category)) {
            matched += 1;
          }
          onProgress?.({
            completed,
            total,
            matched,
            companyName: resolvedCachedCategorization.name,
            category: resolvedCachedCategorization.category
          });
          return resolvedCachedCategorization;
        }

        const localCategorization = this.prequalifyLocally(company);
        if (dryRun && localCategorization) {
          const resolvedLocalCategorization = this.normalizeCompanyIdentity({
            ...company,
            ...this.enforceIndustrialFit(company, localCategorization)
          });
          this.upsertCompanyScreeningRecord(resolvedLocalCategorization, {
            category: resolvedLocalCategorization.category,
            relevanceScore: resolvedLocalCategorization.relevanceScore,
            rationale: resolvedLocalCategorization.rationale
          });
          completed += 1;
          if (!targetCategories || targetCategories.includes(resolvedLocalCategorization.category)) {
            matched += 1;
          }
          onProgress?.({
            completed,
            total,
            matched,
            companyName: resolvedLocalCategorization.name,
            category: resolvedLocalCategorization.category
          });
          return resolvedLocalCategorization;
        }

        const categorization = useWebsiteBackedClassification
          ? await this.azureClient.categorizeWebsiteCrawl(
              company.name,
              company.domain,
              company.shortDescription,
              dryRun,
              mainContext,
              prequalification,
              learning
            )
          : await this.azureClient.categorizeCompany(
              company.name,
              company.shortDescription,
              dryRun,
              mainContext,
              prequalification,
              targetCategories,
              learning
            );

        const resolvedCategorization = {
          ...company,
          ...this.enforceIndustrialFit(company, categorization)
        };
        const normalizedCategorization = this.normalizeCompanyIdentity(resolvedCategorization);

        this.upsertCompanyScreeningRecord(normalizedCategorization, {
          category: normalizedCategorization.category,
          relevanceScore: normalizedCategorization.relevanceScore,
          rationale: normalizedCategorization.rationale
        });

        completed += 1;
        if (!targetCategories || targetCategories.includes(normalizedCategorization.category)) {
          matched += 1;
        }
        onProgress?.({
          completed,
          total,
          matched,
          companyName: normalizedCategorization.name,
          category: normalizedCategorization.category
        });

        return normalizedCategorization;
      }),
      this.aiPrefilterConcurrency
    );
  }

  private resolveConcurrency(requested: number | undefined, fallback: number): number {
    if (typeof requested !== "number" || !Number.isFinite(requested)) {
      return Math.max(MIN_USER_CONCURRENCY, fallback);
    }

    return Math.max(MIN_USER_CONCURRENCY, Math.round(requested));
  }

  private prequalifyLocally(
    company: CompanySample
  ): Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale"> | null {
    const text = `${company.name} ${company.shortDescription} ${company.domain ?? ""}`.toLowerCase();
    const normalizedDescription = company.shortDescription.trim().toLowerCase();
    const hasPlaceholderDescription =
      normalizedDescription.length === 0 ||
      normalizedDescription.includes("no verified public company description");
    const normalizedCountry = company.country?.trim().toLowerCase();
    const industrialSignals = [
      "industrial",
      "automation",
      "automatisierung",
      "automatisierungstechnik",
      "inspection",
      "quality control",
      "machine vision",
      "bildverarbeitung",
      "industrielle bildverarbeitung",
      "camera",
      "robotics",
      "embedded",
      "factory",
      "smart factory",
      "mes",
      "scada",
      "plc",
      "ot",
      "operational technology",
      "production data",
      "process control",
      "oem",
      "sensor"
    ];
    const recruitingSignals = [
      "recruit",
      "staffing",
      "talent",
      "job board",
      "joblead",
      "job platform",
      "career platform",
      "employment",
      "hr software"
    ];
    const obviouslyIrrelevantSignals = [
      "magazine",
      "magazin",
      "publisher",
      "publishing",
      "media company",
      "media house",
      "news portal",
      "newsroom",
      "editorial",
      "conference",
      "event organizer",
      "association",
      "foundation",
      "university",
      "research institute",
      "venture capital",
      "private equity",
      "investor",
      "bank",
      "financial services",
      "insurance",
      "betriebssicherheitsverordnung",
      "arbeitsschutzgesetz",
      "baurecht",
      "sachverstand",
      "sachverstaend",
      "building inspection",
      "facility inspection",
      "hvac inspection",
      "fire safety inspection",
      "elevator inspection",
      "construction inspection",
      "ventilation inspection",
      "casino",
      "betting",
      "sportsbook",
      "slot",
      "roulette",
      "blackjack",
      "baccarat",
      "poker",
      "bahis",
      "live casino",
      "online casino",
      "curacao egaming",
      "sorumlu kumar"
    ];
    const mediaProductionSignals = [
      "videoproduktion",
      "video production",
      "content- und videoproduktion",
      "filmproduktion",
      "film production",
      "filmmaker",
      "videographer",
      "cinematography",
      "post-production",
      "post production",
      "production company",
      "video agency",
      "content creation",
      "content creator",
      "commercial production",
      "vfx",
      "storytelling"
    ];
    const clinicalSoftwareSignals = [
      "clinical trial",
      "clinical trials",
      "ctms",
      "etmf",
      "trial master file",
      "trial supply management",
      "life sciences software",
      "cro",
      "pharma",
      "biotech",
      "clinical operations",
      "study startup"
    ];
    const serviceSignals = [
      "system integrator",
      "systems integrator",
      "integration services",
      "software services",
      "software development",
      "software engineering",
      "custom software",
      "project delivery",
      "engineering services",
      "solution provider",
      "implementation",
      "mes integration",
      "mes system integrator",
      "scada integration",
      "scada system integrator",
      "plc software integration",
      "ot integration",
      "industrial software",
      "manufacturing software",
      "smart factory",
      "process control",
      "digital transformation",
      "data & ai",
      "machine learning",
      "computer vision"
    ];
    const facilityInspectionSignals = [
      "betriebssicherheitsverordnung",
      "arbeitsschutzgesetz",
      "baurecht",
      "verkaufsstätten",
      "gaststätten",
      "hochhäuser",
      "hochhaeuser",
      "garagen",
      "heime",
      "prüfen und beraten",
      "pruefen und beraten",
      "sachverstand",
      "hvac inspection",
      "building inspection",
      "facility inspection",
      "fire safety inspection",
      "elevator inspection",
      "construction inspection",
      "ventilation inspection"
    ];
    const productBrandSignals = [
      "robotics",
      "robot",
      "automation",
      "machine",
      "industrial"
    ];
    const nonIndustrialPlatformSignals = [
      "erp",
      "crm",
      "marketing platform",
      "supply chain saas",
      "crypto",
      "blockchain",
      "food ordering",
      "pricing software",
      "procurement saas",
      "travel platform",
      "marketplace"
    ];
    const competitorSignals = [
      "annotation platform",
      "mlops",
      "vision platform",
      "training data platform",
      "labeling platform",
      "computer vision platform"
    ];
    const productOnlySignals = [
      "humanoid robot",
      "mobile robot",
      "robot arm",
      "service robot",
      "open-source robot",
      "pre-order",
      "hardware platform",
      "robot platform",
      "robotics platform",
      "robot manufacturer"
    ];
    const machineBuilderSignals = [
      "maschinenbau",
      "anlagenbau",
      "sondermaschinenbau",
      "special machinery",
      "machine builder",
      "oem",
      "automation equipment",
      "inspection systems",
      "schaltschrankbau",
      "intralogistik",
      "lagertechnik",
      "production machines"
    ];
    const openCrawlerStrongDeliverySignals = [
      "system integrator",
      "systems integrator",
      "systemintegration",
      "integration partner",
      "implementation",
      "commissioning",
      "inbetriebnahme",
      "engineering services",
      "custom solution",
      "customer-specific",
      "project delivery",
      "retrofit"
    ];
    const openCrawlerVisionSignals = [
      "machine vision",
      "bildverarbeitung",
      "industrielle bildverarbeitung",
      "optische inspektion",
      "aoi",
      "industrial image processing",
      "quality inspection"
    ];
    const openCrawlerSoftwareSignals = [
      "industrial software",
      "manufacturing software",
      "mes",
      "scada",
      "plc",
      "ot integration",
      "smart factory",
      "industrie 4.0",
      "iiot",
      "industrial iot",
      "prozessautomation",
      "prozessleittechnik",
      "leitsystem",
      "systemhaus",
      "steuerungstechnik"
    ];

    const industrialHits = industrialSignals.filter((signal) => text.includes(signal)).length;
    const openCrawlerScoreMatch = normalizedDescription.match(/open-crawler\s+(?:high-fit|review-fit)\s+score\s+(\d+)/i);
    const openCrawlerScore = openCrawlerScoreMatch ? Number(openCrawlerScoreMatch[1]) : 0;
    const openCrawlerDeliveryHits = openCrawlerStrongDeliverySignals.filter((signal) => text.includes(signal)).length;
    const openCrawlerVisionHits = openCrawlerVisionSignals.filter((signal) => text.includes(signal)).length;
    const openCrawlerSoftwareHits = openCrawlerSoftwareSignals.filter((signal) => text.includes(signal)).length;
    const machineBuilderHits = machineBuilderSignals.filter((signal) => text.includes(signal)).length;
    const clinicalSoftwareHits = clinicalSoftwareSignals.filter((signal) => text.includes(signal)).length;

    if (normalizedCountry && !EUROPEAN_COUNTRIES.has(normalizedCountry)) {
      return {
        category: "irrelevant",
        relevanceScore: 5,
        rationale: "Company is outside the European target geography for this campaign."
      };
    }

    if (obviouslyIrrelevantSignals.some((signal) => text.includes(signal)) && !serviceSignals.some((signal) => text.includes(signal))) {
      return {
        category: "irrelevant",
        relevanceScore: 3,
        rationale: "Company appears to be a media, finance, event, academic, or otherwise clearly irrelevant profile."
      };
    }

    if (mediaProductionSignals.some((signal) => text.includes(signal))) {
      return {
        category: "irrelevant",
        relevanceScore: 2,
        rationale: "Company appears to be a film, video, or content-production business rather than a software integrator or industrial AI target."
      };
    }

    if (clinicalSoftwareHits >= 2 && industrialHits <= 1) {
      return {
        category: "irrelevant",
        relevanceScore: 4,
        rationale: "Company appears to be clinical-trial or life-sciences software rather than an industrial Vision-AI fit."
      };
    }

    if (facilityInspectionSignals.some((signal) => text.includes(signal))) {
      return {
        category: "irrelevant",
        relevanceScore: 4,
        rationale: "Company appears to be a building, safety, or facility inspection service rather than an AI integrator."
      };
    }

    if (hasPlaceholderDescription && productBrandSignals.some((signal) => text.includes(signal)) && !serviceSignals.some((signal) => text.includes(signal))) {
      return {
        category: "other",
        relevanceScore: 25,
        rationale: "Only a product- or brand-like company name is available, without verified evidence of service-led delivery ownership."
      };
    }

    if (recruitingSignals.some((signal) => text.includes(signal))) {
      return {
        category: "irrelevant",
        relevanceScore: 4,
        rationale: "Company appears to be in recruiting, staffing, or HR rather than an industrial Vision AI target."
      };
    }

    if (competitorSignals.some((signal) => text.includes(signal))) {
      return {
        category: "irrelevant",
        relevanceScore: 5,
        rationale: "Company appears closer to an AI platform competitor than to a delivery-led ONE WARE target."
      };
    }

    if (productOnlySignals.some((signal) => text.includes(signal)) && !serviceSignals.some((signal) => text.includes(signal))) {
      return {
        category: "machine_builder_ai_enablement",
        relevanceScore: 28,
        rationale: "Company appears to be a product-led robotics or hardware builder rather than a software integrator."
      };
    }

    if (machineBuilderHits >= 2 && industrialHits >= 2) {
      return {
        category: "machine_builder_ai_enablement",
        relevanceScore: Math.min(78, 42 + machineBuilderHits * 6 + industrialHits),
        rationale: "Company profile indicates a machine builder or OEM with industrial automation, inspection, or AI-option potential."
      };
    }

    if (
      industrialHits === 0 &&
      nonIndustrialPlatformSignals.some((signal) => text.includes(signal)) &&
      !serviceSignals.some((signal) => text.includes(signal))
    ) {
      return {
        category: "irrelevant",
        relevanceScore: 6,
        rationale: "Company appears to be a generic SaaS or non-industrial platform rather than a ONE WARE ICP fit."
      };
    }

    if (
      normalizedDescription.includes("open-crawler") &&
      openCrawlerScore >= 12 &&
      openCrawlerDeliveryHits >= 1 &&
      industrialHits >= 2
    ) {
      if (openCrawlerVisionHits >= 1) {
        return {
          category: "integrator_relevant_focus",
          relevanceScore: Math.min(82, 62 + openCrawlerScore),
          rationale: "Open-crawler signals show a delivery-led industrial vision or inspection integrator with explicit implementation evidence."
        };
      }

      if (openCrawlerSoftwareHits >= 1) {
        return {
          category: "integrator_general_ai",
          relevanceScore: Math.min(80, 60 + openCrawlerScore),
          rationale: "Open-crawler signals show a delivery-led industrial software or OT integrator with explicit implementation evidence."
        };
      }
    }

    if (
      normalizedDescription.includes("open-crawler") &&
      openCrawlerScore >= 9 &&
      openCrawlerDeliveryHits >= 2 &&
      openCrawlerSoftwareHits >= 2 &&
      industrialHits >= 2
    ) {
      return {
        category: "software_platform_embedding",
        relevanceScore: Math.min(74, 58 + openCrawlerScore),
        rationale: "Open-crawler signals indicate an industrial software implementation partner with platform or embedded delivery relevance."
      };
    }

    return null;
  }

  private enforceIndustrialFit(
    company: CompanySample,
    categorization: Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale">
  ): Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale"> {
    const text = `${company.name} ${company.shortDescription} ${company.domain ?? ""} ${company.sourceFilter}`.toLowerCase();
    const normalizedName = company.name.trim().toLowerCase();
    const normalizedDomain = company.domain?.trim().toLowerCase() ?? "";
    const industrialSignals = [
      "industrial",
      "automation",
      "automatisierung",
      "automatisierungstechnik",
      "inspection",
      "quality control",
      "machine vision",
      "bildverarbeitung",
      "industrielle bildverarbeitung",
      "camera",
      "robotics",
      "embedded",
      "factory",
      "smart factory",
      "mes",
      "scada",
      "plc",
      "ot",
      "operational technology",
      "production data",
      "process control",
      "oem",
      "sensor",
      "manufacturing",
      "process automation"
    ];
    const strongIndustrialSignals = [
      "industrial automation",
      "automatisierungstechnik",
      "automation solutions",
      "automation engineering",
      "steuerungs- und antriebstechnik",
      "control and drive technology",
      "control systems integration",
      "machine vision",
      "bildverarbeitung",
      "industrielle bildverarbeitung",
      "factory",
      "manufacturing",
      "warehouse automation",
      "production automation",
      "process control",
      "scada",
      "plc",
      "robot programming",
      "commissioning",
      "sondermaschinen",
      "special machine",
      "anlagenbau",
      "machine builder"
    ];
    const clearlyBadSignals = [
      "magazine",
      "magazin",
      "publisher",
      "publishing",
      "media",
      "news",
      "editorial",
      "conference",
      "association",
      "university",
      "research institute",
      "venture capital",
      "private equity",
      "investor",
      "bank",
      "financial services",
      "insurance",
      "staffing",
      "recruit",
      "talent",
      "joblead",
      "job platform",
      "logistics",
      "parcel",
      "human resources",
      "hr software",
      "hr platform",
      "crypto",
      "marketing",
      "payments",
      "betriebssicherheitsverordnung",
      "arbeitsschutzgesetz",
      "baurecht",
      "sachverstand",
      "sachverstaend",
      "building inspection",
      "facility inspection",
      "hvac inspection",
      "fire safety inspection",
      "elevator inspection",
      "construction inspection",
      "ventilation inspection",
      "casino",
      "betting",
      "sportsbook",
      "slot",
      "roulette",
      "blackjack",
      "baccarat",
      "poker",
      "bahis",
      "live casino",
      "online casino",
      "curacao egaming",
      "sorumlu kumar"
    ];
    const mediaProductionSignals = [
      "videoproduktion",
      "video production",
      "content- und videoproduktion",
      "filmproduktion",
      "film production",
      "filmmaker",
      "videographer",
      "cinematography",
      "post-production",
      "post production",
      "production company",
      "video agency",
      "content creation",
      "content creator",
      "commercial production",
      "vfx",
      "animation",
      "pipeline solutions",
      "storytelling"
    ];
    const clinicalSoftwareSignals = [
      "clinical trial",
      "clinical trials",
      "ctms",
      "etmf",
      "trial master file",
      "trial supply management",
      "life sciences software",
      "cro",
      "pharma",
      "biotech",
      "clinical operations",
      "study startup"
    ];
    const academicDomainSignals = [
      "uni-",
      ".edu",
      "/university",
      "hochschule",
      "fh-"
    ];
    const serviceSignals = [
      "system integrator",
      "systems integrator",
      "integration services",
      "automation solutions",
      "automation engineering",
      "control and drive technology",
      "engineering partner",
      "software services",
      "software development",
      "software engineering",
      "custom software",
      "project delivery",
      "engineering services",
      "solution provider",
      "implementation",
      "general contractor",
      "turnkey solutions",
      "turnkey projects",
      "mes integration",
      "mes system integrator",
      "scada integration",
      "scada system integrator",
      "plc software integration",
      "plc programming",
      "ot integration",
      "industrial software",
      "manufacturing software",
      "electrical engineering",
      "mechanical engineering",
      "electrical construction",
      "control cabinet",
      "control cabinet construction",
      "robot programming",
      "assembly",
      "inbetriebnahme",
      "smart factory",
      "process control",
      "commissioning",
      "turnkey",
      "customer-specific",
      "kundenspezifisch",
      "systemintegration"
    ];
    const explicitAISignals = [
      "artificial intelligence",
      "machine learning",
      "deep learning",
      "predictive analytics",
      "predictive maintenance",
      "data science",
      "neural network",
      "large language model",
      "llm"
    ];
    const visionSignals = [
      "computer vision",
      "machine vision",
      "vision ai",
      "bildverarbeitung",
      "industrielle bildverarbeitung",
      "inspection",
      "visual inspection",
      "quality inspection",
      "aoi",
      "camera"
    ];
    const industrialVerticalSignals = [
      "industrial",
      "automation",
      "automatisierung",
      "embedded",
      "mes",
      "scada",
      "plc",
      "factory",
      "manufacturing",
      "process control",
      "robotics",
      "instrumentation",
      "semiconductor",
      "medtech",
      "defence"
    ];
    const genericSoftwareConsultingSignals = [
      "software consulting",
      "consulting services",
      "professional services",
      "software and engineering services",
      "technical expert",
      "application software developer",
      "firmware developer",
      "os porting specialist",
      "device driver",
      "software architect",
      "sap",
      "embedded systems",
      "embedded software services",
      "design engineering",
      "cybersecurity",
      "smooth development processes",
      "resource augmentation"
    ];
    const hasExplicitAI = explicitAISignals.some((signal) => text.includes(signal)) || /\bai\b/.test(text);
    const hasVisionSignals = visionSignals.some((signal) => text.includes(signal));
    const hasIndustrialVerticalSignals = industrialVerticalSignals.some((signal) => text.includes(signal));
    const hasStrongIndustrialSignals = strongIndustrialSignals.some((signal) => text.includes(signal));
    const genericSoftwareConsultingHits = genericSoftwareConsultingSignals.filter((signal) => text.includes(signal)).length;
    const productVendorSignals = [
      "manufacturer",
      "manufacturer",
      "oem",
      "product portfolio",
      "camera systems",
      "intelligent camera systems",
      "line scan cameras",
      "lighting systems",
      "gpu computing",
      "high-performance systems",
      "high performance computing",
      "servers",
      "server",
      "workstation",
      "dgx",
      "robot fleet orchestration",
      "its own software",
      "own software",
      "patent-pending",
      "industrial cameras",
      "machine vision cameras",
      "camera technology",
      "lenses",
      "lighting",
      "vision sensor",
      "robot platform",
      "robotics platform",
      "industrial robots",
      "mobile robots",
      "humanoid robot",
      "robot arm",
      "service robot",
      "open-source robot",
      "pre-order",
      "hardware platform",
      "product portfolio",
      "autonomous robot"
    ];
    const cameraVendorSignals = [
      "camera systems",
      "intelligent camera systems",
      "industrial cameras",
      "machine vision cameras",
      "line scan cameras",
      "lighting systems",
      "camera technology",
      "vision sensor",
      "industrial image processing"
    ];
    const softwarePlatformSignals = [
      "software platform",
      "platform",
      "sdk",
      "development platform",
      "software stack",
      "toolchain",
      "modules",
      "scan modules",
      "plugin",
      "plugins",
      "toolbox",
      "hmi auto-generation",
      "integrated data platform",
      "autonomous software modules",
      "runtime",
      "api",
      "app developers integrate",
      "other app developers",
      "customers embed",
      "workflow"
    ];
    const knownManufacturerSignals = [
      "omron",
      "keyence",
      "cognex",
      "basler",
      "balluff",
      "sick",
      "teledyne",
      "baumer",
      "ifm",
      "ids imaging"
    ];
    const genericPageTitleNames = new Set([
      "solutions",
      "inspection systems",
      "industrial automation",
      "index.php",
      "home",
      "homepage",
      "products",
      "services"
    ]);
    const cameraVendorHits = cameraVendorSignals.filter((signal) => text.includes(signal)).length;
    const softwarePlatformHits = softwarePlatformSignals.filter((signal) => text.includes(signal)).length;
    const productVendorHits = productVendorSignals.filter((signal) => text.includes(signal)).length;

    if (clearlyBadSignals.some((signal) => text.includes(signal))) {
      return {
        category: "irrelevant",
        relevanceScore: 8,
        rationale: "Company profile signals a non-industrial service or platform segment outside ONE WARE's ICP."
      };
    }

    if (mediaProductionSignals.some((signal) => text.includes(signal))) {
      return {
        category: "irrelevant",
        relevanceScore: 4,
        rationale: "Company profile signals a film, video, or content-production business rather than an industrial or AI software integrator."
      };
    }

    if (clinicalSoftwareSignals.filter((signal) => text.includes(signal)).length >= 2) {
      return {
        category: "irrelevant",
        relevanceScore: 6,
        rationale: "Company profile signals clinical-trial or life-sciences software rather than industrial Vision-AI delivery."
      };
    }

    if (
      (categorization.category === "integrator_vision_industrial_ai" ||
        categorization.category === "integrator_general_ai" ||
        categorization.category === "integrator_relevant_focus") &&
      (genericPageTitleNames.has(normalizedName) || academicDomainSignals.some((signal) => normalizedDomain.includes(signal)))
    ) {
      return {
        category: academicDomainSignals.some((signal) => normalizedDomain.includes(signal)) ? "irrelevant" : "other",
        relevanceScore: Math.min(categorization.relevanceScore, 22),
        rationale: academicDomainSignals.some((signal) => normalizedDomain.includes(signal))
          ? "Domain and profile look academic rather than a delivery-led industrial integrator."
          : "Result looks like a generic page title instead of a verified company identity."
      };
    }

    if (
      (categorization.category === "integrator_vision_industrial_ai" ||
        categorization.category === "integrator_general_ai" ||
        categorization.category === "integrator_relevant_focus") &&
      knownManufacturerSignals.some((signal) => text.includes(signal))
    ) {
      return {
        category: "camera_manufacturer_partner",
        relevanceScore: Math.min(categorization.relevanceScore, 38),
        rationale: "Company looks like a known manufacturer or OEM brand, not a delivery-led integrator target."
      };
    }

    if (
      (categorization.category === "integrator_vision_industrial_ai" ||
        categorization.category === "integrator_general_ai" ||
        categorization.category === "integrator_relevant_focus") &&
      cameraVendorHits >= 1 &&
      (!serviceSignals.some((signal) => text.includes(signal)) || /(manufactur|line scan cameras|lighting systems|oem)/.test(text))
    ) {
      return {
        category: "camera_manufacturer_partner",
        relevanceScore: Math.min(categorization.relevanceScore, 45),
        rationale: "Company looks more like a camera or imaging product vendor than a delivery-led integrator."
      };
    }

    if (
      (categorization.category === "integrator_vision_industrial_ai" ||
        categorization.category === "integrator_general_ai" ||
        categorization.category === "integrator_relevant_focus") &&
      softwarePlatformHits >= 2 &&
      (!serviceSignals.some((signal) => text.includes(signal)) || /(sdk|software platform|development platform|software stack|toolchain|toolbox|plugin|modules)/.test(text))
    ) {
      return {
        category: "software_platform_embedding",
        relevanceScore: Math.min(categorization.relevanceScore, 54),
        rationale: "Company looks like a productized software platform or SDK surface that customers embed into their own workflows."
      };
    }

    if (
      (categorization.category === "integrator_vision_industrial_ai" ||
        categorization.category === "integrator_general_ai" ||
        categorization.category === "integrator_relevant_focus") &&
      (productVendorHits >= 1 || knownManufacturerSignals.some((signal) => text.includes(signal))) &&
      !serviceSignals.some((signal) => text.includes(signal))
    ) {
      return {
        category: "machine_builder_ai_enablement",
        relevanceScore: Math.min(categorization.relevanceScore, 48),
        rationale: "Company looks more like a product-led robotics or OEM vendor than a service-led software integrator."
      };
    }

    if (
      (categorization.category === "integrator_vision_industrial_ai" ||
        categorization.category === "integrator_general_ai" ||
        categorization.category === "integrator_relevant_focus") &&
      /(industrial cameras|machine vision cameras|camera technology|lenses|lighting|vision sensor)/.test(text) &&
      !serviceSignals.some((signal) => text.includes(signal))
    ) {
      return {
        category: "camera_manufacturer_partner",
        relevanceScore: Math.min(categorization.relevanceScore, 45),
        rationale: "Company looks more like a camera or imaging product vendor than a software integrator."
      };
    }

    if (company.sourceFilter.includes("Camera Manufacturers")) {
      return categorization;
    }

    if (
      (categorization.category === "integrator_vision_industrial_ai" || categorization.category === "integrator_general_ai") &&
      !hasStrongIndustrialSignals
    ) {
      return {
        category: "other",
        relevanceScore: Math.min(categorization.relevanceScore, 35),
        rationale: "Company may have software or AI capability, but the profile lacks clear industrial, automation, or vision-delivery signals."
      };
    }

    if (
      categorization.category === "integrator_general_ai" &&
      !hasExplicitAI &&
      hasIndustrialVerticalSignals &&
      serviceSignals.some((signal) => text.includes(signal))
    ) {
      return {
        category: "integrator_relevant_focus",
        relevanceScore: categorization.relevanceScore,
        rationale: "Profile shows delivery-led industrial automation or embedded integration work, but no explicit AI specialization."
      };
    }

    if (
      (categorization.category === "integrator_vision_industrial_ai" ||
        categorization.category === "integrator_general_ai" ||
        categorization.category === "integrator_relevant_focus") &&
      !hasExplicitAI &&
      genericSoftwareConsultingHits >= 2 &&
      !hasStrongIndustrialSignals
    ) {
      return {
        category: "other",
        relevanceScore: Math.min(categorization.relevanceScore, 32),
        rationale: "Profile reads like broad software consulting or engineering services without a verified industrial delivery focus."
      };
    }

    if (
      (categorization.category === "integrator_relevant_focus" || categorization.category === "integrator_vision_industrial_ai") &&
      !hasExplicitAI &&
      !hasVisionSignals &&
      !hasIndustrialVerticalSignals &&
      genericSoftwareConsultingHits >= 2
    ) {
      return {
        category: "other",
        relevanceScore: Math.min(categorization.relevanceScore, 34),
        rationale: "Profile reads like broad software consulting or embedded engineering, not a clear industrial AI or vision fit."
      };
    }

    return categorization;
  }

  private normalizeCompanyIdentity<T extends Pick<CompanySample, "name" | "domain">>(company: T): T {
    const normalizedName = company.name.trim().toLowerCase();
    const normalizedCompactName = normalizedName.replace(/[^a-z0-9]+/g, "");
    const fallbackName = this.deriveCompanyNameFromDomain(company.domain);
    const normalizedFallbackName = fallbackName?.replace(/[^a-z0-9]+/g, "").toLowerCase();
    const genericPageTitleNames = new Set([
      "inicio",
      "welcome",
      "solutions",
      "inspection systems",
      "industrial automation",
      "index.php",
      "home",
      "homepage",
      "what is visio?",
      "nueva sala blanca",
      "zero defect manufacturing",
      "products",
      "services"
    ]);
    const looksLikeMarketingSlogan = /(trusted by|powered by|built for|made for|future of|designed for|engineered for|your partner|tailored for|driven by)/i.test(normalizedName);
    const mismatchesDomainBrand = Boolean(normalizedFallbackName && !normalizedCompactName.includes(normalizedFallbackName));
    const brandsDifferClearly = Boolean(
      normalizedFallbackName &&
      normalizedCompactName !== normalizedFallbackName &&
      !normalizedCompactName.includes(normalizedFallbackName) &&
      !normalizedFallbackName.includes(normalizedCompactName)
    );
    const looksLikePageTitle =
      genericPageTitleNames.has(normalizedName) ||
      normalizedName.startsWith("what is ") ||
      normalizedName.startsWith("inicio") ||
      normalizedName.includes(" - ") ||
      normalizedName.includes(" — ") ||
      normalizedName.split(/\s+/).length >= 6 ||
      (brandsDifferClearly && normalizedName.split(/\s+/).length <= 2) ||
      (looksLikeMarketingSlogan && mismatchesDomainBrand);

    if (!looksLikePageTitle) {
      return company;
    }

    if (!fallbackName) {
      return company;
    }

    return {
      ...company,
      name: fallbackName
    };
  }

  private deriveCompanyNameFromDomain(domain: string | undefined): string | undefined {
    const normalizedDomain = this.normalizeDomain(domain);
    if (!normalizedDomain) {
      return undefined;
    }

    const hostWithoutWww = normalizedDomain.replace(/^www\./, "");
    const firstSegment = hostWithoutWww.split(".")[0]?.trim();
    if (!firstSegment) {
      return undefined;
    }

    return firstSegment
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  private excludeRejectedCompanies(companies: CompanySample[], learning: LeadLearningData): CompanySample[] {
    const rejectedEntries = learning.companyFeedback.filter((entry) => entry.verdict === "reject");
    if (rejectedEntries.length === 0) {
      return companies;
    }

    return companies.filter((company) => {
      const normalizedName = company.name.toLowerCase();
      const normalizedDomain = company.domain?.toLowerCase();

      return !rejectedEntries.some((entry) => {
        const sameName = normalizedName.includes(entry.companyName.toLowerCase());
        const sameDomain = entry.domain && normalizedDomain?.includes(entry.domain.toLowerCase());
        return sameName || sameDomain;
      });
    });
  }

  private async topUpWithWebDiscovery(
    currentShortlist: PreCategorizedCompany[],
    shortlistedKeys: Set<string>,
    filters: import("../types").OrganizationFilter[],
    evaluations: FilterEvaluation[],
    request: LeadJobRequest,
    mainContext: string | undefined,
    prequalification: PrequalificationConfig | undefined,
    targetCategories: LeadCategory[],
    learning: LeadLearningData,
    openCrawlerTuning: LeadJobRequest["openCrawlerTuning"] | undefined,
    emitTopUpProgress: (detail: string, foundCandidates: number) => void,
    getCompletionCount: () => number,
    hasReachedRequestedTarget: () => boolean,
    shouldStop?: () => boolean
  ): Promise<PreCategorizedCompany[]> {
    const toppedUp = [...currentShortlist];
    const evaluationByName = new Map(evaluations.map((evaluation) => [evaluation.filterName, evaluation]));
    const nextPageByFilter = new Map(filters.map((filter) => [filter.name, 1]));

    while (!shouldStop?.() && !hasReachedRequestedTarget()) {
      let roundAddedCount = 0;
      let exhaustedFilters = 0;

      for (const filter of filters) {
        if (shouldStop?.()) {
          return toppedUp;
        }

        const remainingSlots = Math.max(1, request.targetLeadCount - getCompletionCount());

        const evaluation = evaluationByName.get(filter.name);
        const hasStrongTopUpSignal = Boolean(
          evaluation && (evaluation.relevantCount >= 2 || evaluation.relevanceRatio >= 0.25 || evaluation.totalReviewed >= 8)
        );
        const maxPages = hasStrongTopUpSignal
          ? (remainingSlots <= 3 ? 2 : remainingSlots <= 8 ? 3 : Math.max(WEB_SEARCH_TOP_UP_MAX_PAGES, openCrawlerTuning?.maxPages ?? 0))
          : toppedUp.length === 0
            ? Math.max(WEB_SEARCH_TOP_UP_MAX_PAGES, openCrawlerTuning?.maxPages ?? 0)
            : remainingSlots <= 3
              ? 1
              : Math.min(Math.max(WEB_SEARCH_TOP_UP_MAX_PAGES, openCrawlerTuning?.maxPages ?? 0), 2);
        const page = nextPageByFilter.get(filter.name) ?? 1;
        if (page > maxPages) {
          exhaustedFilters += 1;
          continue;
        }

        if (shouldStop?.()) {
          return toppedUp;
        }

        const topUpDetail = `Top-up prueft Filter "${filter.name}" auf Seite ${page}/${maxPages}. Aktuell ${toppedUp.length}/${request.targetLeadCount} Ziel-Firmen gefunden.`;
        emitTopUpProgress(topUpDetail, toppedUp.length);
        const expansionBatchSize = this.getExpansionBatchSize(remainingSlots, true);
        const discoveredFetch = await this.runWithProgressHeartbeatUntilStop(
          () => this.fetchAvailableSearchSample(
            filter,
            expansionBatchSize,
            Boolean(request.dryRun),
            page,
            request.companySearchMode ?? "internet_research",
            true,
            request.disableHubSpotDeduplication ?? false,
            request.syncToHubSpot ?? !(request.dryRun ?? true),
            targetCategories,
            learning,
            toppedUp,
            undefined,
            {
              webSearchMaxPages: Math.max(WEB_SEARCH_TOP_UP_MAX_PAGES, openCrawlerTuning?.maxPages ?? 0),
              webSearchSampleMultiplier: Math.max(WEB_SEARCH_TOP_UP_SAMPLE_MULTIPLIER, openCrawlerTuning?.sampleMultiplier ?? 0),
              webSearchMinSampleSize: Math.max(WEB_SEARCH_TOP_UP_MIN_SAMPLE_SIZE, openCrawlerTuning?.minSampleSize ?? 0),
              webSearchRawCollectionMultiplier: Math.max(2, openCrawlerTuning?.rawCollectionMultiplier ?? 0)
            }
          ),
          () => emitTopUpProgress(topUpDetail, toppedUp.length),
          shouldStop
        );
        if (!discoveredFetch) {
          return toppedUp;
        }
        const discoveredCompanies = discoveredFetch.companies;
        nextPageByFilter.set(filter.name, page + 1);

        if (discoveredCompanies.length === 0) {
          exhaustedFilters += 1;
          continue;
        }

        if (shouldStop?.()) {
          return toppedUp;
        }

        const unseenCompanies = this.excludeAlreadyReviewedCompanies(discoveredCompanies, toppedUp);
        if (unseenCompanies.length === 0) {
          continue;
        }

        const categorizedCompanies = await this.runWithProgressHeartbeatUntilStop(
          () => this.categorizeCompanies(
            unseenCompanies,
            Boolean(request.dryRun),
            mainContext,
            prequalification,
            targetCategories,
            learning
          ),
          () => emitTopUpProgress(topUpDetail, toppedUp.length),
          shouldStop,
          5_000,
          250
        );
        if (!categorizedCompanies) {
          return toppedUp;
        }

        const relevantCompanies = this.getRelevantCompanies(categorizedCompanies, filter, targetCategories, request.market);
        const sizeBeforeAdd = toppedUp.length;
        this.addUniqueCompanies(toppedUp, relevantCompanies, shortlistedKeys);
        roundAddedCount += toppedUp.length - sizeBeforeAdd;

        if (hasReachedRequestedTarget() || discoveredCompanies.length < expansionBatchSize) {
          if (discoveredCompanies.length < expansionBatchSize) {
            exhaustedFilters += 1;
          }

          if (hasReachedRequestedTarget()) {
            return toppedUp;
          }
        }
      }

      if (roundAddedCount === 0 || exhaustedFilters >= filters.length) {
        break;
      }
    }

    return toppedUp;
  }

  private async runWithProgressHeartbeat<T>(
    operation: () => Promise<T>,
    heartbeat: () => void,
    intervalMs = 5_000
  ): Promise<T> {
    const timer = setInterval(() => {
      heartbeat();
    }, intervalMs);

    try {
      return await operation();
    } finally {
      clearInterval(timer);
    }
  }

  private async runWithProgressHeartbeatUntilStop<T>(
    operation: () => Promise<T>,
    heartbeat: () => void,
    shouldStop?: () => boolean,
    intervalMs = 5_000,
    stopPollMs = 250
  ): Promise<T | null> {
    if (!shouldStop) {
      return this.runWithProgressHeartbeat(operation, heartbeat, intervalMs);
    }

    const timer = setInterval(() => {
      heartbeat();
    }, intervalMs);

    const operationResult = operation()
      .then((value) => ({ kind: "result" as const, value }))
      .catch((error: unknown) => ({ kind: "error" as const, error }));

    const stopResult = new Promise<{ kind: "stopped" }>((resolve) => {
      if (shouldStop()) {
        resolve({ kind: "stopped" });
        return;
      }

      const stopTimer = setInterval(() => {
        if (!shouldStop()) {
          return;
        }

        clearInterval(stopTimer);
        resolve({ kind: "stopped" });
      }, stopPollMs);

      void operationResult.finally(() => clearInterval(stopTimer));
    });

    try {
      const winner = await Promise.race([operationResult, stopResult]);
      if (winner.kind === "stopped") {
        return null;
      }

      if (winner.kind === "error") {
        throw winner.error;
      }

      return winner.value;
    } finally {
      clearInterval(timer);
    }
  }

  private getExpansionBatchSize(remainingSlots: number, useWebSearch: boolean): number {
    const fallbackRemainingSlots = Math.max(1, remainingSlots);
    const targetBuffer = useWebSearch ? fallbackRemainingSlots * 2 : fallbackRemainingSlots * 3;
    const maxBatchSize = useWebSearch ? CREDITLESS_EXPANSION_BATCH_SIZE : EXPANSION_BATCH_SIZE;

    return Math.max(MIN_EARLY_STOP_REVIEW_COUNT, Math.min(maxBatchSize, targetBuffer));
  }

  private orderFiltersByLearning(
    filters: import("../types").OrganizationFilter[],
    learning: LeadLearningData,
    market?: string,
    customGoal?: string
  ): import("../types").OrganizationFilter[] {
    return [...filters].sort(
      (left, right) => this.getFilterRank(right.name, learning, market, customGoal) - this.getFilterRank(left.name, learning, market, customGoal)
    );
  }

  private prioritizeFiltersForTopUp(
    filters: import("../types").OrganizationFilter[],
    evaluations: FilterEvaluation[],
    learning: LeadLearningData,
    market?: string,
    customGoal?: string
  ): import("../types").OrganizationFilter[] {
    const evaluationByName = new Map(evaluations.map((evaluation) => [evaluation.filterName, evaluation]));

    return [...filters].sort((left, right) => {
      const leftEvaluation = evaluationByName.get(left.name);
      const rightEvaluation = evaluationByName.get(right.name);
      const leftScore = this.getTopUpFilterScore(left.name, leftEvaluation, learning, market, customGoal);
      const rightScore = this.getTopUpFilterScore(right.name, rightEvaluation, learning, market, customGoal);

      return rightScore - leftScore;
    });
  }

  private getTopUpFilterScore(
    filterName: string,
    evaluation: FilterEvaluation | undefined,
    learning: LeadLearningData,
    market?: string,
    customGoal?: string
  ): number {
    const rank = this.getFilterRank(filterName, learning, market, customGoal);
    if (!evaluation) {
      return rank;
    }

    let score = rank + Math.min(0.5, evaluation.relevanceRatio) + Math.min(2, evaluation.relevantCount) * 0.2;

    if (evaluation.relevantCount === 1 && evaluation.totalReviewed <= 4) {
      score -= 0.55;
    }

    if (evaluation.relevantCount === 0 && evaluation.totalReviewed <= 2) {
      score -= 0.2;
    }

    return score;
  }

  private hasSyncReadyResearchBrief(brief: ResearchBrief | undefined): brief is ResearchBrief {
    const hasText = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;

    return Boolean(
      brief &&
      !brief.isFallback &&
      hasText(brief.overview) &&
      hasText(brief.qualificationSummary) &&
      hasText(brief.emailBody) &&
      hasText(brief.linkedInMessage) &&
      hasText(brief.phoneScript)
    );
  }

  private hasSyncReadyContacts(contacts: PublicContactCandidate[]): boolean {
    return contacts.some((contact) => {
      const email = contact.email?.trim().toLowerCase();
      if (!email) {
        return false;
      }

      if (/^(info|sales|office|kontakt|contact|hello|team|support|service|mail)@/i.test(email)) {
        return false;
      }

      return Boolean(contact.firstName?.trim() || contact.lastName?.trim());
    });
  }

  private shouldReuseLearnedFilters(
    baselineFilters: import("../types").OrganizationFilter[],
    learning: LeadLearningData | undefined,
    customGoal?: string,
    mainContext?: string,
    searchStrategyContext?: string
  ): boolean {
    if (!learning || customGoal?.trim() || mainContext?.trim() || searchStrategyContext?.trim()) {
      return false;
    }

    const strongBaselineFilters = baselineFilters.filter((filter) => {
      const stats = learning.filterPerformance[filter.name];
      if (!stats || stats.runs < 1) {
        return false;
      }

      const earlyStopRate = stats.earlyStopCount / stats.runs;
      return stats.averageRelevanceRatio >= 0.15 && earlyStopRate <= 0.6;
    });

    return strongBaselineFilters.length >= 2;
  }

  private getFilterRank(filterName: string, learning: LeadLearningData, market?: string, customGoal?: string): number {
    const stats = learning.filterPerformance[filterName];
    const strategicBias = this.getStrategicFilterBias(filterName, market, customGoal);

    if (!stats) {
      return strategicBias;
    }

    const sampleConfidence = Math.min(1, stats.runs / 5);
    const confidenceWeightedRelevance = stats.averageRelevanceRatio * sampleConfidence;
    const earlyStopPenalty = stats.runs === 0 ? 0 : stats.earlyStopCount / stats.runs;
    return confidenceWeightedRelevance - earlyStopPenalty + strategicBias;
  }

  private getStrategicFilterBias(filterName: string, market?: string, customGoal?: string): number {
    const normalizedName = filterName.toLowerCase();
    const normalizedGoal = customGoal?.toLowerCase() ?? "";
    let bias = 0;

    if (normalizedName.includes("vision") && normalizedName.includes("integrators")) {
      bias += 0.45;
    }

    if (normalizedName.includes("consulting") || normalizedName.includes("freelance")) {
      bias += 0.38;
    }

    if (normalizedName.includes("automation software integrators")) {
      bias += 0.35;
    }

    if (normalizedName.includes("smart factory software engineering partners")) {
      bias += 0.35;
    }

    if (normalizedName.includes("industrial computer vision engineering services")) {
      bias += 0.4;
    }

    if (normalizedName.includes("machine vision system integrators")) {
      bias += 0.4;
    }

    if (normalizedName.includes("europe vision system integrators")) {
      bias += 0.48;
    }

    if (normalizedName.includes("europe industrial inspection engineering firms")) {
      bias += 0.48;
    }

    if (normalizedName.includes("benelux dach vision integration specialists")) {
      bias += 0.44;
    }

    if (normalizedName.includes("france italy spain vision inspection integrators")) {
      bias += 0.44;
    }

    if (normalizedName.includes("france vision industrielle integrateurs")) {
      bias += 0.5;
    }

    if (normalizedName.includes("italy visione industriale integratori")) {
      bias += 0.48;
    }

    if (normalizedName.includes("spain vision industrial integradores")) {
      bias += 0.48;
    }

    if (normalizedName.includes("netherlands sweden vision automation integrators")) {
      bias += 0.45;
    }

    if (normalizedName.includes("austria switzerland vision inspection integrators")) {
      bias += 0.46;
    }

    if (normalizedName.includes("general ai integrators")) {
      bias += 0.05;
    }

    if (normalizedName.includes("scaled industrial end customers")) {
      bias += 0.35;
    }

    if (normalizedName.includes("machine builders")) {
      bias += 0.25;
    }

    if (normalizedName.includes("camera manufacturers")) {
      bias -= 0.15;
    }

    if (isGermanyFocusedMarket(market) && normalizedName.includes("europe")) {
      bias -= 0.05;
    }

    if (/(software integrator|industrial|quality control|qc|process automation)/.test(normalizedGoal) && normalizedName.includes("camera manufacturers")) {
      bias -= 0.1;
    }

    return bias;
  }

  private getRelevantCompanies(
    companies: PreCategorizedCompany[],
    filter: import("../types").OrganizationFilter,
    targetCategories: LeadCategory[],
    market?: string
  ): PreCategorizedCompany[] {
    return companies.filter(
      (company) => targetCategories.includes(company.category) && this.isCompanyInScope(company, filter, market)
    );
  }

  isCompanyInExecutionScope(
    company: Pick<PreCategorizedCompany, "country" | "domain">,
    filter: import("../types").OrganizationFilter,
    market?: string
  ): boolean {
    return this.isCompanyInScope(company, filter, market);
  }

  private isCompanyInScope(
    company: Pick<PreCategorizedCompany, "country" | "domain">,
    filter: import("../types").OrganizationFilter,
    market?: string
  ): boolean {
    const normalizedMarket = market?.trim().toLowerCase();
    const normalizedCountry = company.country?.trim().toLowerCase();

    if (isGermanyFocusedMarket(normalizedMarket)) {
      if (normalizedCountry) {
        return normalizedCountry === "germany";
      }

      const normalizedDomain = company.domain?.trim().toLowerCase();
      return Boolean(normalizedDomain?.includes(".de"));
    }

    if (normalizedCountry && EUROPEAN_COUNTRIES.has(normalizedCountry)) {
      return true;
    }

    if (normalizedCountry && !EUROPEAN_COUNTRIES.has(normalizedCountry)) {
      return false;
    }

    const normalizedDomain = company.domain?.trim().toLowerCase();
    if (normalizedDomain && EUROPEAN_TLDS.some((tld) => normalizedDomain.includes(tld))) {
      return true;
    }

    return filter.locations.every((location) => this.isEuropeanLocation(location));
  }

  private isEuropeanLocation(location: string): boolean {
    const normalizedLocation = location.trim().toLowerCase();
    return EUROPEAN_COUNTRIES.has(normalizedLocation) || Array.from(EUROPEAN_COUNTRIES).some((country) => normalizedLocation.includes(country));
  }

  private getDiscoverySourceLabel(companySearchMode: import("../types").CompanySearchMode): string {
    if (companySearchMode === "exa_search") {
      return "Exa/Web";
    }

    if (companySearchMode === "diffbot_search") {
      return "Diffbot";
    }

    if (companySearchMode === "diffbot_test_data") {
      return "Diffbot-Testdaten";
    }

    if (companySearchMode === "open_crawler_search" || companySearchMode === "internet_research") {
      return "Open Web";
    }

    return "Web Search";
  }

  private applyExplicitLocalityFilter(
    companies: PreCategorizedCompany[],
    researchBriefs: ResearchBrief[],
    market?: string
  ): { companies: PreCategorizedCompany[]; researchBriefs: ResearchBrief[] } {
    const locality = extractExplicitMarketLocality(market)?.toLowerCase();
    if (!locality) {
      return { companies, researchBriefs };
    }

    const researchBriefByCompanyKey = new Map(
      companies.map((company) => [this.getCompanyKey(company), researchBriefs.find((brief) => brief.companyName === company.name)])
    );

    const filteredCompanies = companies.filter((company) => {
      const brief = researchBriefByCompanyKey.get(this.getCompanyKey(company));
      const localityEvidence = [
        company.name,
        company.domain,
        company.shortDescription,
        brief?.overview,
        brief?.qualificationSummary,
        brief?.targetIndustry,
        brief?.productsOffered
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return localityEvidence.includes(locality);
    });

    // Keep explicit-locality filtering as a preference, not a hard failure mode.
    // Otherwise a market like "DE Berlin" can zero out a valid shortlist just
    // because the generated summary omitted the city name even when the company is relevant.
    if (filteredCompanies.length === 0) {
      return { companies, researchBriefs };
    }

    const filteredCompanyNames = new Set(filteredCompanies.map((company) => company.name));
    return {
      companies: filteredCompanies,
      researchBriefs: researchBriefs.filter((brief) => filteredCompanyNames.has(brief.companyName))
    };
  }

  private buildDirectExaSearchFilters(targetCategories: LeadCategory[], market?: string): OrganizationFilter[] {
    const requestedCategories = Array.from(new Set(targetCategories.length > 0
      ? targetCategories
      : ["machine_builder_ai_enablement" as LeadCategory])) as SelectableLeadCategory[];

    return requestedCategories.map((category) => {
      const debugFilter = buildDebugSearchFilter(category, market);
      return {
        ...debugFilter,
        name: debugFilter.name.replace(/\s*\[debug(?: [^\]]+)?\]\s*$/i, "").trim(),
        notes: debugFilter.notes.replace(/\s*Debug console request for .*$/i, "").trim()
      } satisfies OrganizationFilter;
    });
  }

  buildDirectExaFiltersForExecution(targetCategories: LeadCategory[], market?: string): OrganizationFilter[] {
    return this.buildDirectExaSearchFilters(targetCategories, market);
  }

  private buildDirectExaSearchFilter(targetCategories: LeadCategory[], market?: string): OrganizationFilter {
    return this.buildDirectExaSearchFilters(targetCategories, market)[0];
  }

  private async runDirectExaCompanySearch(
    filter: OrganizationFilter,
    targetCategories: LeadCategory[],
    maxQueryCount: number,
    excludeDomainSources: DirectExaExcludeDomainSources = {},
    queryPlanningContext: DirectExaQueryPlanningContext = {},
    onQueryProgress?: (update: {
      executedQueries: number;
      totalQueries: number;
      query: string;
      returnedResults: number;
      filteredByExcludedDomains: number;
      filteredByHubSpot: number;
      filteredByRejectedWebsites: number;
      filteredByCurrentRunCache: number;
      duplicatesRemoved: number;
      rawCompaniesFound: number;
      filterName: string;
      defaultQueries: string[];
      plannedQueries: string[];
      promptMessages?: Array<{ role: string; content: string }>;
      excludedDomains: string[];
    }) => void
  ): Promise<CompanySample[]> {
    const exaClient = this.exaPreviewClient as unknown as {
      runtimeApiKey?: string;
      buildQueries: (filter: OrganizationFilter, page: number, options?: { targetCategoryRefinement?: string }) => string[];
      runSearch: (apiKey: string, query: string, numResults: number, excludeDomains?: string[]) => Promise<{ results?: Array<{ title?: string; url?: string; highlights?: string[]; summary?: string; text?: string }> }>;
      toExcludeDomain: (value: string | undefined) => string | undefined;
      normalizeUrl: (url: string | undefined) => string | undefined;
      toCanonicalCompanyDomain: (url: string) => string;
      deriveCompanyName: (domain: string, title?: string) => string;
      inferCountryFromDomain: (domain: string, result: { title?: string; highlights?: string[]; summary?: string; text?: string }, fallbackLocation?: string) => string | undefined;
      buildDescription: (result: { title?: string; highlights?: string[]; summary?: string; text?: string }, filter: OrganizationFilter) => string;
      loadKnownExcludedDomains: () => Promise<Set<string>>;
    };
    const apiKey = exaClient.runtimeApiKey ?? env.EXA_API_KEY;
    if (!apiKey) {
      return [];
    }

    const [screeningDatabase, liveExaCache] = await Promise.all([
      this.controlPlaneStore.getCompanyScreeningDatabase(),
      this.controlPlaneStore.getLiveExaCache()
    ]);
    const prioritizedExcludedDomains = this.buildPrioritizedDirectExaExcludedDomains(
      screeningDatabase,
      targetCategories,
      await exaClient.loadKnownExcludedDomains(),
      {
        ...excludeDomainSources,
        historicalExaDomains: excludeDomainSources.historicalExaDomains ?? liveExaCache.discoveredDomains
      }
    );
    const excludedDomains = prioritizedExcludedDomains.localExcludedDomains;
    const excludedDomainCategories = prioritizedExcludedDomains.localExcludedDomainCategories;

    const defaultQueries = exaClient.buildQueries(filter, 1, {
      targetCategoryRefinement: queryPlanningContext.targetCategoryRefinement
    });
    const useAzureQueryPlanner = queryPlanningContext.useAzureQueryPlanner ?? true;
    const plannerQueryCount = Math.min(defaultQueries.length, Math.max(1, maxQueryCount, 4));
    let queryGenerationPromptMessages: Array<{ role: string; content: string }> | undefined;
    const forcedQueries = Array.from(new Set((queryPlanningContext.forcedQueries ?? []).map((query) => query.trim()).filter(Boolean)));
    const queries = (forcedQueries.length > 0
      ? forcedQueries
      : useAzureQueryPlanner
        ? await this.azureClient.planExaSearchQueries(
          filter,
          defaultQueries.slice(0, plannerQueryCount),
          queryPlanningContext.learning,
          Boolean(queryPlanningContext.dryRun),
          queryPlanningContext.mainContext,
          queryPlanningContext.searchStrategyContext,
          plannerQueryCount,
          {
            recentQueryHistory: queryPlanningContext.recentQueryHistory,
            prequalification: queryPlanningContext.prequalification,
            excludedDomainExamples: prioritizedExcludedDomains.requestExcludedDomains.slice(0, 30),
            requestedTargetCategories: targetCategories,
            targetCategoryRefinement: queryPlanningContext.targetCategoryRefinement,
            debugCapture: (details) => {
              queryGenerationPromptMessages = details.promptMessages;
              queryPlanningContext.debugCapture?.(details);
            }
          }
        )
        : defaultQueries).slice(0, Math.max(1, maxQueryCount));
    const debugUpdateBase = {
      filterName: filter.name,
      defaultQueries: queryPlanningContext.plannedQueryMetadata?.defaultQueries ?? defaultQueries.slice(0, plannerQueryCount),
      plannedQueries: queryPlanningContext.plannedQueryMetadata?.plannedQueries ?? queries,
      promptMessages: queryPlanningContext.plannedQueryMetadata?.promptMessages ?? queryGenerationPromptMessages,
      excludedDomains: prioritizedExcludedDomains.requestExcludedDomains
    };
    onQueryProgress?.({
      executedQueries: 0,
      totalQueries: queries.length,
      query: queries[0] ?? "",
      returnedResults: 0,
      filteredByExcludedDomains: 0,
      filteredByHubSpot: 0,
      filteredByRejectedWebsites: 0,
      filteredByCurrentRunCache: 0,
      duplicatesRemoved: 0,
      rawCompaniesFound: 0,
      ...debugUpdateBase
    });
    let completedQueries = 0;
    let returnedResultsCount = 0;
    let filteredByExcludedDomainsCount = 0;
    let filteredByHubSpotCount = 0;
    let filteredByRejectedWebsitesCount = 0;
    let filteredByCurrentRunCacheCount = 0;
    let discoveredCompanyCount = 0;
    const queryResults: CompanySample[] = [];
    const reprioritizeExcludeDomain = (domain: string, category: DirectExaExcludedDomainCategory) => {
      const existingIndex = prioritizedExcludedDomains.requestExcludedDomains.indexOf(domain);
      if (existingIndex >= 0) {
        prioritizedExcludedDomains.requestExcludedDomains.splice(existingIndex, 1);
      }

      excludedDomains.add(domain);
      excludedDomainCategories.set(domain, category);
      prioritizedExcludedDomains.requestExcludedDomains.push(domain);
      this.trimDirectExaRequestExcludedDomains(prioritizedExcludedDomains.requestExcludedDomains);
    };

    for (const query of queries) {
      const payload = await exaClient.runSearch(apiKey, query, 20, prioritizedExcludedDomains.requestExcludedDomains);
      const discoveredCompanies: CompanySample[] = [];
      const queryReturnedResults = payload.results?.length ?? 0;
      let queryFilteredByExcludedDomains = 0;
      let queryFilteredByHubSpot = 0;
      let queryFilteredByRejectedWebsites = 0;
      let queryFilteredByCurrentRunCache = 0;

      for (const result of payload.results ?? []) {
        const normalizedDomain = exaClient.normalizeUrl(result.url);
        if (!normalizedDomain) {
          continue;
        }

        const excludeDomain = exaClient.toExcludeDomain(normalizedDomain);
        if (excludeDomain && excludedDomains.has(excludeDomain)) {
          queryFilteredByExcludedDomains += 1;
          const category = excludedDomainCategories.get(excludeDomain);
          if (category === "hubspot") {
            queryFilteredByHubSpot += 1;
            reprioritizeExcludeDomain(excludeDomain, "hubspot");
          } else if (category === "rejected_website") {
            queryFilteredByRejectedWebsites += 1;
            reprioritizeExcludeDomain(excludeDomain, "rejected_website");
          } else if (category === "current_run_cache") {
            queryFilteredByCurrentRunCache += 1;
            reprioritizeExcludeDomain(excludeDomain, "current_run_cache");
          }
          continue;
        }

        discoveredCompanies.push({
          name: exaClient.deriveCompanyName(normalizedDomain, result.title),
          domain: exaClient.toCanonicalCompanyDomain(normalizedDomain),
          country: exaClient.inferCountryFromDomain(normalizedDomain, result, filter.locations[0]),
          shortDescription: exaClient.buildDescription(result, filter),
          sourceFilter: `${filter.name} (exa-search: ${query.slice(0, 72)})`,
          discoveryQuery: query
        });

        if (excludeDomain) {
          reprioritizeExcludeDomain(excludeDomain, "current_run_cache");
        }
      }

      completedQueries += 1;
      returnedResultsCount += queryReturnedResults;
      filteredByExcludedDomainsCount += queryFilteredByExcludedDomains;
      filteredByHubSpotCount += queryFilteredByHubSpot;
      filteredByRejectedWebsitesCount += queryFilteredByRejectedWebsites;
      filteredByCurrentRunCacheCount += queryFilteredByCurrentRunCache;
      discoveredCompanyCount += discoveredCompanies.length;
      onQueryProgress?.({
        executedQueries: completedQueries,
        totalQueries: queries.length,
        query,
        returnedResults: returnedResultsCount,
        filteredByExcludedDomains: filteredByExcludedDomainsCount,
        filteredByHubSpot: filteredByHubSpotCount,
        filteredByRejectedWebsites: filteredByRejectedWebsitesCount,
        filteredByCurrentRunCache: filteredByCurrentRunCacheCount,
        duplicatesRemoved: Math.max(0, returnedResultsCount - filteredByExcludedDomainsCount - discoveredCompanyCount),
        rawCompaniesFound: discoveredCompanyCount,
        ...debugUpdateBase,
        excludedDomains: prioritizedExcludedDomains.requestExcludedDomains
      });

      queryResults.push(...discoveredCompanies);
    }

    return queryResults;
  }

  async discoverDirectExaCompaniesForExecution(
    filter: OrganizationFilter,
    targetCategories: LeadCategory[],
    maxQueryCount: number,
    excludeDomainSources: DirectExaExcludeDomainSources = {},
    queryPlanningContext: DirectExaQueryPlanningContext = {},
    onQueryProgress?: (update: {
      executedQueries: number;
      totalQueries: number;
      query: string;
      returnedResults: number;
      filteredByExcludedDomains: number;
      filteredByHubSpot: number;
      filteredByRejectedWebsites: number;
      filteredByCurrentRunCache: number;
      duplicatesRemoved: number;
      rawCompaniesFound: number;
      filterName: string;
      defaultQueries: string[];
      plannedQueries: string[];
      promptMessages?: Array<{ role: string; content: string }>;
      excludedDomains: string[];
    }) => void
  ): Promise<CompanySample[]> {
    return this.runDirectExaCompanySearch(filter, targetCategories, maxQueryCount, excludeDomainSources, queryPlanningContext, onQueryProgress);
  }

  buildPrioritizedDirectExaExcludedDomains(
    screeningDatabase: CompanyScreeningDatabase,
    targetCategories: LeadCategory[],
    hubSpotExcludedDomains: Iterable<string>,
    excludeDomainSources: DirectExaExcludeDomainSources = {}
  ): { requestExcludedDomains: string[]; localExcludedDomains: Set<string>; localExcludedDomainCategories: Map<string, DirectExaExcludedDomainCategory> } {
    const seenDomains = new Set<string>();
    const localExcludedDomainCategories = new Map<string, DirectExaExcludedDomainCategory>();
    const hubSpotDomains: string[] = [];
    const rejectedWebsiteDomains: string[] = [];
    const currentRunExcludedDomains: string[] = [];
    const requestedCategorySet = new Set(targetCategories);

    const pushDomain = (collection: string[], domain: string | undefined, category: DirectExaExcludedDomainCategory) => {
      const normalizedDomain = this.normalizeExcludeDomain(domain);
      if (!normalizedDomain || seenDomains.has(normalizedDomain)) {
        return;
      }

      seenDomains.add(normalizedDomain);
      localExcludedDomainCategories.set(normalizedDomain, category);
      collection.push(normalizedDomain);
    };

    for (const record of screeningDatabase.records) {
      if (!this.matchesDirectExaExcludeScope(record, excludeDomainSources.screeningScope)) {
        continue;
      }

      const normalizedDomain = this.normalizeDomain(record.normalizedDomain ?? record.domain);
      if (!normalizedDomain) {
        continue;
      }

      if (!record.category || record.existsInHubSpot || requestedCategorySet.has(record.category)) {
        continue;
      }

      pushDomain(rejectedWebsiteDomains, normalizedDomain, "rejected_website");
    }

    for (const domain of hubSpotExcludedDomains) {
      pushDomain(hubSpotDomains, domain, "hubspot");
    }

    for (const domain of excludeDomainSources.currentRunExcludedDomains ?? []) {
      pushDomain(currentRunExcludedDomains, domain, "current_run_cache");
    }

    const historicalExaScores = new Map<string, number>();
    const historicalExaDomains = excludeDomainSources.historicalExaDomains ?? [];
    const historicalDomainCount = historicalExaDomains.length;
    for (const [index, domain] of historicalExaDomains.entries()) {
      const normalizedDomain = this.normalizeExcludeDomain(domain);
      if (!normalizedDomain) {
        continue;
      }

      const recencyWeight = Math.max(1, historicalDomainCount - index);
      historicalExaScores.set(normalizedDomain, (historicalExaScores.get(normalizedDomain) ?? 0) + recencyWeight);
    }

    const splitPromotedDomains = (domains: string[]) => {
      const regular: string[] = [];
      const promoted = domains
        .map((domain, index) => ({
          domain,
          index,
          score: historicalExaScores.get(domain) ?? 0
        }))
        .filter((entry) => {
          if (entry.score <= 0) {
            regular.push(entry.domain);
            return false;
          }

          return true;
        })
        .sort((left, right) => left.score - right.score || left.index - right.index)
        .map((entry) => entry.domain);

      return { regular, promoted };
    };

    const splitHubSpotDomains = splitPromotedDomains(hubSpotDomains);
    const splitRejectedDomains = splitPromotedDomains(rejectedWebsiteDomains);
    const splitCurrentRunDomains = splitPromotedDomains(currentRunExcludedDomains);

    return {
      requestExcludedDomains: [
        ...splitHubSpotDomains.regular,
        ...splitRejectedDomains.regular,
        ...splitHubSpotDomains.promoted,
        ...splitRejectedDomains.promoted,
        ...splitCurrentRunDomains.regular,
        ...splitCurrentRunDomains.promoted
      ].slice(-MAX_DIRECT_EXA_REQUEST_EXCLUDED_DOMAINS),
      localExcludedDomains: new Set(seenDomains),
      localExcludedDomainCategories
    };
  }

  private trimDirectExaRequestExcludedDomains(domains: string[]): void {
    if (domains.length <= MAX_DIRECT_EXA_REQUEST_EXCLUDED_DOMAINS) {
      return;
    }

    domains.splice(0, domains.length - MAX_DIRECT_EXA_REQUEST_EXCLUDED_DOMAINS);
  }

  private matchesDirectExaExcludeScope(record: CompanyScreeningRecord, screeningScope?: "live" | "debug"): boolean {
    if (!screeningScope) {
      return true;
    }

    const isDebugRecord = this.isDebugScreeningRecord(record.sourceFilter);
    return screeningScope === "debug" ? isDebugRecord : !isDebugRecord;
  }

  private isDebugScreeningRecord(sourceFilter?: string): boolean {
    const normalized = sourceFilter?.trim().toLowerCase() ?? "";
    return normalized.includes("manual-debug-input") || normalized.includes("debug-stage=") || normalized.includes("[debug");
  }

  private normalizeExcludeDomain(domain: string | undefined): string | undefined {
    if (!domain) {
      return undefined;
    }

    try {
      const parsed = domain.includes("://") ? new URL(domain) : new URL(`https://${domain}`);
      return parsed.hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return domain
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/$/, "");
    }
  }

  private buildSearchHistoryEntry(
    companySearchMode: import("../types").CompanySearchMode,
    filterName: string,
    targetCategory: LeadCategory,
    batchType: "probe_15" | "expand_50",
    page: number,
    requestedCount: number,
    companies: PreCategorizedCompany[],
    filter: import("../types").OrganizationFilter,
    targetCategories: LeadCategory[],
    market: string | undefined,
    threshold: number,
    diagnostics?: SearchSampleDiagnostics
  ): SearchHistoryEntry {
    const relevantCount = this.getRelevantCompanies(companies, filter, targetCategories, market).length;
    const relevanceRatio = companies.length === 0 ? 0 : relevantCount / companies.length;
    const categoryBreakdown = this.evaluateFilter(filterName, companies, filter, targetCategories, market, requestedCount, false).categoryBreakdown;
    const decisionSamples = companies
      .slice(0, 8)
      .map<SearchHistoryDecisionSample>((company) => ({
        companyName: company.name,
        domain: company.domain,
        sourceFilter: company.sourceFilter,
        discoveryQuery: company.discoveryQuery,
        category: company.category,
        relevanceScore: company.relevanceScore,
        rationale: company.rationale
      }));

    return {
      timestamp: new Date().toISOString(),
      companySearchMode,
      filterName,
      filterSnapshot: {
        persona: filter.persona,
        industries: [...filter.industries],
        keywords: [...filter.keywords],
        locations: [...filter.locations],
        employeeRanges: [...filter.employeeRanges],
        notes: filter.notes
      },
      targetCategory,
      batchType,
      page,
      requestedCount,
      returnedCount: companies.length,
      relevantCount,
      relevanceRatio,
      categoryBreakdown,
      passedThreshold: relevanceRatio >= threshold,
      recommendation: relevanceRatio >= threshold
        ? "Continue expanding this search."
        : "Revise the search before spending more credits.",
      fetchedSampleCount: diagnostics?.fetchedSampleCount,
      eligibleSampleCount: diagnostics?.eligibleSampleCount,
      discoveryQueries: diagnostics?.discoveryQueries.slice(0, 6),
      dropOffSummary: diagnostics
        ? {
            filteredByPriorFeedback: diagnostics.filteredByPriorFeedbackCount,
            filteredByCache: diagnostics.filteredByCacheCount,
            filteredByHubSpot: diagnostics.filteredByHubSpotCount,
            categorizedIrrelevant: categoryBreakdown.irrelevant ?? 0,
            categorizedOther: categoryBreakdown.other ?? 0
          }
        : undefined,
      decisionSamples
    };
  }

  private buildCategoryQuotas(targetLeadCount: number, categories: LeadCategory[]): Record<LeadCategory, number> {
    const quotas = {} as Record<LeadCategory, number>;

    categories.forEach((category) => {
      quotas[category] = targetLeadCount;
    });

    return quotas;
  }

  private describeLeadCategory(category: LeadCategory): string {
    switch (category) {
      case "integrator_vision_industrial_ai":
        return "Vision-/Industrial-AI-Integratoren";
      case "integrator_vision_ai_consulting":
        return "Vision-/Industrial-AI-Consulting-Firmen";
      case "integrator_vision_ai_freelancer":
        return "Vision-/Industrial-AI-Freelancer";
      case "integrator_general_ai":
        return "allgemeinen AI-Integratoren";
      case "integrator_relevant_focus":
        return "relevanten Spezial-Integratoren";
      default:
        return category;
    }
  }

  private buildExaQueryPreview(filter: OrganizationFilter): string | undefined {
    const query = this.exaPreviewClient.buildQueries(filter, 1)[0]?.trim();
    return query || undefined;
  }

  private addUniqueCompanies(
    target: PreCategorizedCompany[],
    incoming: PreCategorizedCompany[],
    knownKeys: Set<string>
  ): number {
    let added = 0;

    for (const company of incoming) {
      const companyKey = this.getCompanyKey(company);
      if (knownKeys.has(companyKey)) {
        continue;
      }

      target.push(company);
      knownKeys.add(companyKey);
      added += 1;
    }

    return added;
  }

  private async excludeExistingCompanySamples(
    companies: CompanySample[],
    dryRun: boolean,
    disableHubSpotDeduplication: boolean,
    targetCategories: LeadCategory[],
    syncToHubSpot: boolean
  ): Promise<{ companies: CompanySample[]; filteredByCacheCount: number; filteredByHubSpotCount: number }> {
    if (dryRun || disableHubSpotDeduplication || syncToHubSpot || companies.length === 0) {
      const filteredByCache = this.excludeCachedScreenedCompanies(companies, targetCategories);
      return {
        companies: filteredByCache,
        filteredByCacheCount: Math.max(0, companies.length - filteredByCache.length),
        filteredByHubSpotCount: 0
      };
    }

    const filteredByCache = this.excludeCachedScreenedCompanies(companies, targetCategories);
    const filteredByCacheCount = Math.max(0, companies.length - filteredByCache.length);
    if (filteredByCache.length === 0) {
      return {
        companies: filteredByCache,
        filteredByCacheCount,
        filteredByHubSpotCount: 0
      };
    }

    const domains = filteredByCache
      .map((company) => company.domain)
      .filter((domain): domain is string => Boolean(domain));
    if (domains.length === 0) {
      return {
        companies: filteredByCache,
        filteredByCacheCount,
        filteredByHubSpotCount: 0
      };
    }

    const existingDomains = await this.getKnownHubSpotDomains(domains);
    if (existingDomains.size === 0) {
      return {
        companies: filteredByCache,
        filteredByCacheCount,
        filteredByHubSpotCount: 0
      };
    }

    const filteredByHubSpot = filteredByCache.filter((company) => {
      const normalizedDomain = company.domain?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
      return !normalizedDomain || !existingDomains.has(normalizedDomain);
    });
    return {
      companies: filteredByHubSpot,
      filteredByCacheCount,
      filteredByHubSpotCount: Math.max(0, filteredByCache.length - filteredByHubSpot.length)
    };
  }

  private async excludeExistingHubSpotDomains(
    companies: PreCategorizedCompany[],
    dryRun: boolean,
    disableHubSpotDeduplication: boolean,
    syncToHubSpot: boolean
  ): Promise<PreCategorizedCompany[]> {
    if (dryRun || disableHubSpotDeduplication || syncToHubSpot || companies.length === 0) {
      return companies;
    }

    const domains = companies
      .map((company) => company.domain)
      .filter((domain): domain is string => Boolean(domain));
    if (domains.length === 0) {
      return companies;
    }

    const existingDomains = await this.getKnownHubSpotDomains(domains);
    if (existingDomains.size === 0) {
      return companies;
    }

    return companies.filter((company) => {
      const normalizedDomain = company.domain?.trim().toLowerCase();
      return !normalizedDomain || !existingDomains.has(normalizedDomain);
    });
  }

  private async fetchAvailableSearchSample(
    filter: OrganizationFilter,
    requestedCount: number,
    dryRun: boolean,
    page: number,
    companySearchMode: import("../types").CompanySearchMode,
    useWebSearch: boolean,
    disableHubSpotDeduplication: boolean,
    syncToHubSpot: boolean,
    targetCategories: LeadCategory[],
    learning: LeadLearningData,
    reviewedCompanies: Array<Pick<CompanySample, "name" | "domain">>,
    rawCollectionTarget?: number,
    searchTuning?: {
      webSearchMaxPages?: number;
      webSearchSampleMultiplier?: number;
      webSearchMinSampleSize?: number;
      webSearchRawCollectionMultiplier?: number;
    },
    progressHeartbeat?: () => void
  ): Promise<{ companies: CompanySample[]; nextPage: number; diagnostics: SearchSampleDiagnostics }> {
    const collected: CompanySample[] = [];
    const seenKeys = new Set(reviewedCompanies.map((company) => this.getCompanyKey(company)));
    const isOpenCrawlerSearch = companySearchMode === "open_crawler_search";
    const webSearchSampleMultiplier = isOpenCrawlerSearch
      ? Math.max(2, searchTuning?.webSearchSampleMultiplier ?? 3)
      : (searchTuning?.webSearchSampleMultiplier ?? WEB_SEARCH_SAMPLE_MULTIPLIER);
    const webSearchMinSampleSize = isOpenCrawlerSearch
      ? Math.max(10, searchTuning?.webSearchMinSampleSize ?? 10)
      : (searchTuning?.webSearchMinSampleSize ?? WEB_SEARCH_MIN_SAMPLE_SIZE);
    const maxPages = useWebSearch
      ? (searchTuning?.webSearchMaxPages ?? (isOpenCrawlerSearch ? 2 : WEB_SEARCH_MAX_PAGES))
      : 6;
    const exaRawCollectionLimit = useWebSearch && companySearchMode === "exa_search"
      ? Math.max(requestedCount, rawCollectionTarget ?? requestedCount)
      : undefined;
    const pageSize = useWebSearch
      ? exaRawCollectionLimit ?? Math.max(webSearchMinSampleSize, requestedCount * webSearchSampleMultiplier)
      : Math.max(MIN_EARLY_STOP_REVIEW_COUNT, requestedCount);
    const collectionTarget = useWebSearch
      ? Math.max(
          requestedCount,
          rawCollectionTarget ?? (isOpenCrawlerSearch ? requestedCount * Math.max(2, searchTuning?.webSearchRawCollectionMultiplier ?? 2) : requestedCount)
        )
      : requestedCount;
    const plannedPages = this.buildSearchPagePlan(page, maxPages, useWebSearch, requestedCount);
    let nextPage = page;
    let fetchedSampleCount = 0;
    let filteredByPriorFeedbackCount = 0;
    let filteredByCacheCount = 0;
    let filteredByHubSpotCount = 0;
    const discoveryQueries = new Set<string>();
    const shouldSkipDiscoveryDomain = (domain: string) => this.shouldSkipDiscoveryDomain(domain, targetCategories);
    const discoveryCheckpointContext = this.discoveryCheckpointContext ??= {
      runId: this.createDiscoveryCheckpointRunId(),
      nextSequence: 0
    };

    for (const plannedPage of plannedPages) {
      if (collected.length >= collectionTarget) {
        break;
      }

      const rawSample = await this.runWithProgressHeartbeat(
        () => this.companySearchClient.fetchOrganizationSample(
          filter,
          pageSize,
          dryRun,
          plannedPage,
          companySearchMode,
          shouldSkipDiscoveryDomain
        ),
        progressHeartbeat ?? (() => undefined)
      );
      await this.persistDiscoveryCheckpoint({
        runId: discoveryCheckpointContext.runId,
        sequence: ++discoveryCheckpointContext.nextSequence,
        companySearchMode,
        filter,
        page: plannedPage,
        companies: rawSample
      });
      fetchedSampleCount += rawSample.length;
      rawSample
        .map((company) => company.discoveryQuery?.trim())
        .filter((query): query is string => Boolean(query))
        .forEach((query) => discoveryQueries.add(query));
      const sample = this.excludeRejectedCompanies(rawSample, learning);
      filteredByPriorFeedbackCount += Math.max(0, rawSample.length - sample.length);

      nextPage = plannedPage + 1;

      if (sample.length === 0) {
        if (useWebSearch) {
          continue;
        }

        break;
      }

      const unseenSample = sample.filter((company) => !seenKeys.has(this.getCompanyKey(company)));
      const availableSample = await this.excludeExistingCompanySamples(
        unseenSample,
        dryRun,
        disableHubSpotDeduplication,
        targetCategories,
        syncToHubSpot
      );
      filteredByCacheCount += availableSample.filteredByCacheCount;
      filteredByHubSpotCount += availableSample.filteredByHubSpotCount;

      for (const company of availableSample.companies) {
        const companyKey = this.getCompanyKey(company);
        if (seenKeys.has(companyKey)) {
          continue;
        }

        seenKeys.add(companyKey);
        collected.push(company);

        if (collected.length >= collectionTarget) {
          break;
        }
      }
      if (!useWebSearch && sample.length < pageSize) {
        break;
      }
    }

    if (!useWebSearch && !dryRun) {
      await this.controlPlaneStore.updateSearchCursor(filter, nextPage);
    }

    return {
      companies: collected,
      nextPage,
      diagnostics: {
        fetchedSampleCount,
        filteredByPriorFeedbackCount,
        filteredByCacheCount,
        filteredByHubSpotCount,
        eligibleSampleCount: collected.length,
        discoveryQueries: [...discoveryQueries]
      }
    };
  }

  private buildSearchPagePlan(
    startPage: number,
    maxPages: number,
    useWebSearch: boolean,
    requestedCount: number
  ): number[] {
    if (useWebSearch || requestedCount > MAX_EARLY_STOP_REVIEW_COUNT) {
      return Array.from({ length: maxPages }, (_, index) => startPage + index);
    }

    const pageOffsets = [0, 1, 3, 6, 12, 24];
    return pageOffsets.slice(0, maxPages).map((offset) => startPage + offset);
  }

  private excludeCachedScreenedCompanies(
    companies: CompanySample[],
    targetCategories: LeadCategory[]
  ): CompanySample[] {
    return companies.filter((company) => {
      const cachedRecord = this.findCompanyScreeningRecord(company);
      if (!cachedRecord) {
        return true;
      }

      if (cachedRecord.existsInHubSpot) {
        return false;
      }

      if (!cachedRecord.category) {
        return true;
      }

      return targetCategories.includes(cachedRecord.category);
    });
  }

  private shouldSkipDiscoveryDomain(domain: string | undefined, targetCategories: LeadCategory[]): boolean {
    const normalizedDomain = this.normalizeDomain(domain);
    if (!normalizedDomain) {
      return false;
    }

    const cachedRecord = this.companyScreeningDatabase.records.find((record) => record.normalizedDomain === normalizedDomain);
    if (!cachedRecord) {
      return false;
    }

    if (cachedRecord.existsInHubSpot) {
      return true;
    }

    return Boolean(cachedRecord.category && !targetCategories.includes(cachedRecord.category));
  }

  private getCachedCategorization(
    company: CompanySample
  ): Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale"> | null {
    const cachedRecord = this.findCompanyScreeningRecord(company);
    if (!cachedRecord?.category || !cachedRecord.rationale) {
      return null;
    }

    return {
      category: cachedRecord.category,
      relevanceScore: cachedRecord.relevanceScore ?? 0,
      rationale: cachedRecord.rationale
    };
  }

  private findCompanyScreeningRecord(
    company: Pick<CompanySample, "name" | "domain">
  ): CompanyScreeningRecord | undefined {
    const normalizedDomain = this.normalizeDomain(company.domain);
    const normalizedName = company.name.trim().toLowerCase();

    return this.companyScreeningDatabase.records.find((record) => {
      if (normalizedDomain && record.normalizedDomain === normalizedDomain) {
        return true;
      }

      return record.normalizedName === normalizedName;
    });
  }

  private getCachedQualifiedCompanies(
    targetCategories: LeadCategory[],
    market: string | undefined,
    limit: number
  ): PreCategorizedCompany[] {
    const scopeFilter = {
      name: "cached_screening_database",
      persona: "cached screening database",
      industries: [],
      keywords: [],
      locations: [],
      employeeRanges: [],
      notes: "cached screening database"
    } satisfies OrganizationFilter;

    return this.companyScreeningDatabase.records
      .filter((record) => Boolean(record.category) && targetCategories.includes(record.category as LeadCategory))
      .filter((record) => !record.existsInHubSpot)
      .map((record) => ({
        name: record.companyName,
        domain: record.domain,
        country: undefined,
        shortDescription: record.shortDescription || "Cached from prior qualification run.",
        sourceFilter: record.sourceFilter || "cached_screening_database",
        category: record.category as LeadCategory,
        relevanceScore: record.relevanceScore ?? 60,
        rationale: record.rationale || "Company matched a requested target category in a prior run and was reused from cache."
      }))
      .filter((company) => this.isCompanyInScope(company, scopeFilter, market))
      .slice(0, Math.max(0, limit));
  }

  private getCachedExcludedDiscoveryDomains(targetCategories: LeadCategory[]): string[] {
    return this.companyScreeningDatabase.records
      .filter((record) => Boolean(record.normalizedDomain))
      .filter((record) => Boolean(record.existsInHubSpot) || Boolean(record.category && !targetCategories.includes(record.category as LeadCategory)))
      .map((record) => record.normalizedDomain as string);
  }

  private upsertCompanyScreeningRecord(
    company: Pick<CompanySample, "name" | "domain" | "shortDescription" | "sourceFilter">,
    categorization?: Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale">,
    existsInHubSpot?: boolean
  ): void {
    const normalizedDomain = this.normalizeDomain(company.domain);
    const normalizedName = company.name.trim().toLowerCase();
    const existingIndex = this.companyScreeningDatabase.records.findIndex((record) => {
      if (normalizedDomain && record.normalizedDomain === normalizedDomain) {
        return true;
      }

      return record.normalizedName === normalizedName;
    });
    const current = existingIndex >= 0 ? this.companyScreeningDatabase.records[existingIndex] : undefined;
    const nextRecord: CompanyScreeningRecord = {
      companyName: company.name,
      normalizedName,
      domain: company.domain,
      normalizedDomain,
      category: categorization?.category ?? current?.category,
      relevanceScore: categorization?.relevanceScore ?? current?.relevanceScore,
      rationale: categorization?.rationale ?? current?.rationale,
      sourceFilter: company.sourceFilter ?? current?.sourceFilter,
      shortDescription: company.shortDescription ?? current?.shortDescription,
      checkedAt: categorization ? new Date().toISOString() : current?.checkedAt,
      existsInHubSpot: existsInHubSpot ?? current?.existsInHubSpot,
      hubspotCheckedAt: typeof existsInHubSpot === "boolean" ? new Date().toISOString() : current?.hubspotCheckedAt
    };

    if (existingIndex >= 0) {
      this.companyScreeningDatabase.records[existingIndex] = nextRecord;
      return;
    }

    this.companyScreeningDatabase.records.unshift(nextRecord);
  }

  private async getKnownHubSpotDomains(domains: string[]): Promise<Set<string>> {
    const normalizedDomains = Array.from(
      new Set(domains.map((domain) => this.normalizeDomain(domain)).filter((domain): domain is string => Boolean(domain)))
    );
    const knownExistingDomains = new Set<string>();
    const uncachedDomains: string[] = [];

    for (const domain of normalizedDomains) {
      const cachedRecord = this.companyScreeningDatabase.records.find((record) => record.normalizedDomain === domain);
      if (cachedRecord?.existsInHubSpot) {
        knownExistingDomains.add(domain);
      } else {
        uncachedDomains.push(domain);
      }
    }

    if (uncachedDomains.length === 0) {
      return knownExistingDomains;
    }

    const liveExistingDomains = await this.hubspotClient.getExistingCompanyDomains(uncachedDomains);
    for (const domain of uncachedDomains) {
      const existsInHubSpot = liveExistingDomains.has(domain);
      this.upsertCompanyScreeningRecord(
        {
          name: domain,
          domain,
          shortDescription: "",
          sourceFilter: "hubspot-existing-domain-check"
        },
        undefined,
        existsInHubSpot
      );

      if (existsInHubSpot) {
        knownExistingDomains.add(domain);
      }
    }

    return knownExistingDomains;
  }

  private async preloadKnownHubSpotDomains(disableHubSpotDeduplication: boolean): Promise<void> {
    if (disableHubSpotDeduplication) {
      return;
    }

    const liveHubSpotDomains = await this.hubspotClient.getAllCompanyDomains();
    for (const domain of liveHubSpotDomains) {
      this.upsertCompanyScreeningRecord(
        {
          name: domain,
          domain,
          shortDescription: "",
          sourceFilter: "hubspot-domain-cache"
        },
        undefined,
        true
      );
    }
  }

  private normalizeDomain(domain: string | undefined): string | undefined {
    if (!domain) {
      return undefined;
    }

    try {
      const hostname = new URL(domain.startsWith("http") ? domain : `https://${domain}`).hostname.toLowerCase().replace(/^www\./, "");
      const labels = hostname.split(".").filter(Boolean);
      if (labels.length <= 2) {
        return hostname;
      }

      const compoundTld = labels.slice(-2).join(".");
      return COMMON_COMPOUND_TLDS.has(compoundTld)
        ? labels.slice(-3).join(".")
        : labels.slice(-2).join(".");
    } catch {
      return domain
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/$/, "");
    }
  }

  private getUniqueCompanyCount(companies: PreCategorizedCompany[]): number {
    return companies.filter((company, index, all) => this.findFirstMatchingCompanyIndex(all, company) === index).length;
  }

  private createDiscoveryCheckpointRunId(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
  }

  private async persistDiscoveryCheckpoint(params: {
    runId: string;
    sequence: number;
    companySearchMode: string;
    filter: OrganizationFilter;
    page: number;
    companies: CompanySample[];
  }): Promise<void> {
    const outputDir = process.env.LEAD_AGENT_DISCOVERY_CHECKPOINT_DIR?.trim()
      || path.join(getLeadAgentRuntimeDataDirectory(), "lead-run-discovery-checkpoints", params.runId);
    await fs.mkdir(outputDir, { recursive: true });

    const safeFilterName = params.filter.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "unnamed-filter";
    const fileName = `${String(params.sequence).padStart(3, "0")}-${params.companySearchMode}-page-${params.page}-${safeFilterName}.json`;

    await fs.writeFile(path.join(outputDir, fileName), JSON.stringify({
      runId: params.runId,
      savedAt: new Date().toISOString(),
      companySearchMode: params.companySearchMode,
      page: params.page,
      filter: {
        name: params.filter.name,
        keywords: params.filter.keywords,
        locations: params.filter.locations,
        industries: params.filter.industries,
        employeeRanges: params.filter.employeeRanges
      },
      count: params.companies.length,
      companies: params.companies
    }, null, 2), "utf8");
  }

  private excludeAlreadyReviewedCompanies(
    companies: CompanySample[],
    reviewedCompanies: PreCategorizedCompany[]
  ): CompanySample[] {
    const reviewedKeys = new Set(reviewedCompanies.map((company) => this.getCompanyKey(company)));
    return companies.filter((company) => !reviewedKeys.has(this.getCompanyKey(company)));
  }

  private findFirstMatchingCompanyIndex(companies: PreCategorizedCompany[], company: PreCategorizedCompany): number {
    const companyDomain = this.normalizeDomain(company.domain);
    const companyName = company.name.toLowerCase();

    return companies.findIndex((entry) => {
      const sameDomain = companyDomain && this.normalizeDomain(entry.domain) === companyDomain;
      const sameName = entry.name.toLowerCase() === companyName;
      return Boolean(sameDomain || sameName);
    });
  }

  private buildGeneratedLeadRecord(
    company: PreCategorizedCompany,
    researchBriefs: import("../types").ResearchBrief[],
    publicContacts: PublicContactCandidate[]
  ): GeneratedLeadRecord {
    const researchBrief = researchBriefs.find((entry) => entry.companyName === company.name);

    return {
      companyName: company.name,
      domain: company.domain,
      country: company.country,
      category: company.category,
      relevanceScore: company.relevanceScore,
      sourceFilter: company.sourceFilter,
      rationale: company.rationale,
      likelyGermanSpeaking: researchBrief?.likelyGermanSpeaking,
      outreachLanguage: researchBrief?.outreachLanguage,
      rankings: researchBrief?.rankings,
      businessPotentialEUR: researchBrief?.businessPotentialEUR,
      businessPotentialReasoning: researchBrief?.businessPotentialReasoning,
      targetIndustry: researchBrief?.targetIndustry,
      productsOffered: researchBrief?.productsOffered,
      overview: researchBrief?.overview,
      qualificationSummary: researchBrief?.qualificationSummary,
      linkedInConnectionRequest: researchBrief?.linkedInConnectionRequest,
      linkedInMessage: researchBrief?.linkedInMessage,
      emailSubject: researchBrief?.emailSubject,
      emailBody: researchBrief?.emailBody,
      phoneScript: researchBrief?.phoneScript,
      riskFlags: researchBrief?.riskFlags,
      publicContactEmails: publicContacts.map((contact) => contact.email).filter((email): email is string => Boolean(email)),
      publicContactPhones: publicContacts.map((contact) => contact.phone).filter((phone): phone is string => Boolean(phone)),
      publicContactSources: publicContacts.map((contact) => contact.sourceUrl)
    };
  }

  private async collectPublicContacts(
    companies: PreCategorizedCompany[],
    dryRun: boolean
  ): Promise<Map<string, PublicContactCandidate[]>> {
    if (dryRun) {
      return new Map();
    }

    const entries = await this.mapWithConcurrency(
      companies.map((company) => async () => [
        this.getCompanyKey(company),
        await this.withTimeout(
          this.hubspotClient.findPublicContactsForCompany(company),
          PUBLIC_CONTACT_DISCOVERY_TIMEOUT_MS,
          [] as PublicContactCandidate[]
        )
      ] as const),
      this.contactSearchConcurrency
    );

    return new Map(entries);
  }

  private async collectApolloContacts(
    companies: PreCategorizedCompany[],
    _researchBriefs: ResearchBrief[],
    dryRun: boolean,
    _mainContext?: string
  ): Promise<Map<string, PublicContactCandidate[]>> {
    if (dryRun) {
      return new Map(companies.map((company) => [this.getCompanyKey(company), []] as const));
    }

    const entries = await this.mapWithConcurrency(
      companies.map((company) => async () => {
        try {
          const apolloCandidates = await this.apolloClient.searchContactsForCompany(company);
          const enrichedContacts = await Promise.all(
            apolloCandidates.slice(0, 5).map((candidate) => this.apolloClient.enrichContactEmail(candidate, company).catch(() => null))
          );

          return [
            this.getCompanyKey(company),
            enrichedContacts.filter((contact): contact is PublicContactCandidate => Boolean(contact))
          ] as const;
        } catch {
          return [this.getCompanyKey(company), [] as PublicContactCandidate[]] as const;
        }
      }),
      this.contactSearchConcurrency
    );

    return new Map(entries);
  }

  private hasNonGenericReachableContact(contacts: PublicContactCandidate[]): boolean {
    return contacts.some((contact) => Boolean(contact.email || contact.phone) && !this.isGenericFallbackContact(contact));
  }

  private buildResearchBriefTimeoutFallback(
    company: PreCategorizedCompany,
    mainContext?: string
  ): ResearchBrief {
    const likelyGermanSpeaking = ["germany", "austria", "switzerland", "de", "at", "ch"].includes(
      company.country?.trim().toLowerCase() ?? ""
    ) || /\.(de|at|ch)$/i.test(company.domain ?? "");
    const outreachLanguage = likelyGermanSpeaking ? "de" as const : "en" as const;

    return {
      companyName: company.name,
      website: company.domain,
      appliedAgentContext: mainContext,
      isFallback: true,
      stillQualified: true,
      qualificationDecisionReason: company.rationale,
      overview: `${company.name} remains qualified based on ${company.shortDescription.toLowerCase()}.`,
      qualificationSummary: company.rationale,
      qualifyingSignals: [
        `Category fit: ${company.category}`,
        `Source filter: ${company.sourceFilter}`
      ],
      riskFlags: ["Research brief timed out and was replaced with a minimal fallback summary."],
      likelyGermanSpeaking,
      outreachLanguage,
      rankings: {
        customer: company.category === "industrial_end_customer_scaled" ? 7 : 6,
        serviceProvider: company.category.startsWith("integrator_") ? 8 : 3,
        partner: company.category.startsWith("integrator_") ? 7 : 3
      },
      businessPotentialEUR: company.category === "industrial_end_customer_scaled" ? 20000 : 18000,
      businessPotentialReasoning: "Research timeout fallback used. Validate commercial fit manually before outreach.",
      targetIndustry: company.category === "industrial_end_customer_scaled" ? "Industrial Manufacturing" : "Industrial Automation",
      productsOffered: company.shortDescription,
      recommendedTemplateKey: company.category,
      personalizationRule: "Use only verified factual hooks from the company description and domain.",
      linkedInAngle: "Check whether faster, lower-friction Vision-AI delivery would matter for current projects.",
      linkedInConnectionRequest: outreachLanguage === "de"
        ? "Kurze Frage: Ist Vision AI fuer aktuelle Projekte oder Qualitaetskontrolle bei Ihnen relevant?"
        : "Quick question: is vision AI relevant for current projects or quality control on your side?",
      emailAngle: "Keep the outreach factual and mention reduced trial-and-error only if relevant.",
      phoneAngle: "Lead with the operational bottleneck and verify relevance first.",
      linkedInMessage: outreachLanguage === "de"
        ? "Kurze Frage: Ist Vision AI fuer aktuelle Projekte oder Qualitaetskontrolle bei Ihnen relevant? Wenn ja, koennte ONE WARE die Umsetzung deutlich planbarer machen."
        : "Quick question: is vision AI relevant for current projects or quality control on your side? If yes, ONE WARE may make delivery much more predictable.",
      emailSubject: outreachLanguage === "de"
        ? "Vision-AI-Projekte planbarer umsetzen"
        : "Make vision-AI projects more predictable",
      emailBody: outreachLanguage === "de"
        ? "Hallo [Name],\n\nwir sehen oft, dass Vision-AI-Projekte an Datenqualitaet, Iterationen und Lieferaufwand haengen bleiben. Wenn das bei Ihnen relevant ist, kann ONE WARE helfen, Modelle schneller und planbarer produktionsreif zu bekommen.\n\nWaere ein kurzer Austausch sinnvoll?\n\nMit freundlichen Gruessen\n[Ihr Name]"
        : "Hello [Name],\n\nwe often see vision-AI projects slow down because of data quality, repeated iteration, and delivery overhead. If that is relevant for you, ONE WARE may help get models production-ready faster and with more predictable effort.\n\nWould a short exchange make sense?\n\nBest regards,\n[Your Name]",
      phoneScript: outreachLanguage === "de"
        ? "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE. Ich wollte kurz fragen, ob Vision AI oder automatisierte Qualitaetskontrolle aktuell ein Thema ist. Wenn ja, koennte unsere Software helfen, Projekte schneller produktionsreif zu bekommen."
        : "Hello Mr./Ms. [Name], this is [Your Name] from ONE WARE. I wanted to ask whether vision AI or automated quality control is currently relevant. If yes, our software may help get projects production-ready faster."
    };
  }

  private mergeContactCandidates(
    primaryContacts: Map<string, PublicContactCandidate[]>,
    fallbackContacts: Map<string, PublicContactCandidate[]>
  ): Map<string, PublicContactCandidate[]> {
    const merged = new Map(primaryContacts);

    for (const [companyKey, contacts] of fallbackContacts.entries()) {
      const existingContacts = merged.get(companyKey) ?? [];
      const dedupedContacts = [...existingContacts];
      const seenContactKeys = new Set(existingContacts.map((contact) => this.getContactKey(contact)));

      for (const contact of contacts) {
        if (this.isGenericFallbackContact(contact) && existingContacts.some((existing) => !this.isGenericFallbackContact(existing))) {
          continue;
        }

        const contactKey = this.getContactKey(contact);
        if (seenContactKeys.has(contactKey)) {
          continue;
        }

        seenContactKeys.add(contactKey);
        dedupedContacts.push(contact);
      }

      merged.set(companyKey, dedupedContacts);
    }

    return merged;
  }

  private isGenericFallbackContact(contact: PublicContactCandidate): boolean {
    const email = contact.email?.trim().toLowerCase() ?? "";
    return /^((info|sales|office|kontakt|contact|hello|team|support|service|mail)@)/i.test(email)
      || contact.label === "public_generic_mailbox";
  }

  private getContactKey(contact: PublicContactCandidate): string {
    return [
      contact.email?.trim().toLowerCase(),
      contact.phone?.trim(),
      contact.linkedinUrl?.trim().toLowerCase(),
      `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim().toLowerCase(),
      contact.label.trim().toLowerCase(),
      contact.sourceUrl.trim().toLowerCase()
    ].filter(Boolean).join("::");
  }

  private getCompanyKey(company: Pick<CompanySample, "name" | "domain">): string {
    return this.normalizeDomain(company.domain) || company.name.trim().toLowerCase();
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallbackValue: T): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        promise,
        new Promise<T>((resolve) => {
          timeoutHandle = setTimeout(() => resolve(fallbackValue), timeoutMs);
        })
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async mapWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
    if (tasks.length === 0) {
      return [];
    }

    const results = new Array<T>(tasks.length);
    let nextIndex = 0;
    const workerCount = Math.max(1, Math.min(concurrency, tasks.length));

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const currentIndex = nextIndex;
          nextIndex += 1;
          if (currentIndex >= tasks.length) {
            return;
          }

          results[currentIndex] = await tasks[currentIndex]!();
        }
      })
    );

    return results;
  }

  private buildFunnel(
    companySearchMode: import("../types").CompanySearchMode,
    afterHubSpotDedup: number,
    afterAzureAICheck: number,
    syncedToHubSpot: number
  ): LeadRunFunnel {
    const discoveryMetrics = this.companySearchClient.getDiscoveryMetrics(companySearchMode);

    return {
      crawledPages: discoveryMetrics.crawledPages,
      afterCrawlerPrefilter: discoveryMetrics.acceptedCompanyDomains,
      afterHubSpotDedup,
      afterAzureAICheck,
      syncedToHubSpot
    };
  }

  private shouldAbortLowYieldExaRun(
    companySearchMode: import("../types").CompanySearchMode,
    processedFilters: number,
    shortlistedCount: number
  ): boolean {
    if (companySearchMode !== "exa_search" || shortlistedCount > 0 || processedFilters < 2) {
      return false;
    }

    const discoveryMetrics = this.companySearchClient.getDiscoveryMetrics(companySearchMode);
    return discoveryMetrics.crawledPages >= 24 && discoveryMetrics.acceptedCompanyDomains >= 24;
  }

  private async replenishExhaustedFilters(
    existingFilters: OrganizationFilter[],
    evaluations: FilterEvaluation[],
    market: string | undefined,
    customGoal: string | undefined,
    mainContext: string | undefined,
    searchStrategyContext: string | undefined,
    targetCategories: LeadCategory[],
    dryRun: boolean,
    learning?: LeadLearningData
  ): Promise<OrganizationFilter[]> {
    const existingNames = new Set(existingFilters.map((filter) => filter.name));
    const recentOutcomes = evaluations
      .slice(-12)
      .map((evaluation) => `${evaluation.filterName}: relevant ${evaluation.relevantCount}/${evaluation.totalReviewed} (${Math.round(evaluation.relevanceRatio * 100)}%)`)
      .join("\n");
    const strongestOutcomes = [...evaluations]
      .sort((left, right) => right.relevanceRatio - left.relevanceRatio)
      .slice(0, 6)
      .map((evaluation) => `${evaluation.filterName}: relevant ${evaluation.relevantCount}/${evaluation.totalReviewed} (${Math.round(evaluation.relevanceRatio * 100)}%)`)
      .join("\n");
    const adaptiveSearchStrategyContext = [
      this.buildAdaptiveSearchStrategyContext(searchStrategyContext),
      "The current filter set was exhausted before the lead target was reached.",
      recentOutcomes ? `Most recent tested filters:\n${recentOutcomes}` : undefined,
      strongestOutcomes ? `Best-performing filters so far:\n${strongestOutcomes}` : undefined,
      "Return only net-new filters with distinct names and search angles that complement the exhausted set.",
      "Prefer concrete geo and niche variants over near-duplicates, for example city-specific variants such as Berlin, Munich, Hamburg, Cologne, Stuttgart, or DACH sub-regions when they fit the market.",
      "For Exa-style web discovery, propose search angles that are likely to surface additional official company sites instead of directories or generic listing pages."
    ]
      .filter(Boolean)
      .join("\n\n");

    const generatedFilters = await this.azureClient.generateSuggestedFilters(
      market,
      customGoal,
      mainContext,
      adaptiveSearchStrategyContext,
      targetCategories,
      existingFilters,
      dryRun,
      learning
    );

    return generatedFilters
      .filter((filter) => this.filterSupportsTargetCategories(filter, targetCategories))
      .filter((filter) => !existingNames.has(filter.name));
  }

  private buildFallbackReplenishmentFilters(
    existingFilters: OrganizationFilter[],
    evaluations: FilterEvaluation[],
    targetCategories: LeadCategory[],
    round: number
  ): OrganizationFilter[] {
    const existingNames = new Set(existingFilters.map((filter) => filter.name));
    const rankedFilters = [...evaluations]
      .filter((evaluation) => evaluation.relevantCount > 0)
      .sort((left, right) => {
        if (right.relevanceRatio !== left.relevanceRatio) {
          return right.relevanceRatio - left.relevanceRatio;
        }

        return right.relevantCount - left.relevantCount;
      })
      .map((evaluation) => existingFilters.find((filter) => filter.name === evaluation.filterName))
      .filter((filter): filter is OrganizationFilter => Boolean(filter));
    const fallbackSourceFilters = rankedFilters.length > 0 ? rankedFilters : existingFilters;

    const fallbackFilters: OrganizationFilter[] = [];

    for (const [index, filter] of fallbackSourceFilters.slice(0, 4).entries()) {
      const nextLocation = FALLBACK_REPLENISHMENT_LOCATIONS[(round + index - 1) % FALLBACK_REPLENISHMENT_LOCATIONS.length];
      if (nextLocation) {
        const locationVariant: OrganizationFilter = {
          ...filter,
          name: `${filter.name} ${nextLocation} Variant R${round}`,
          locations: Array.from(new Set([...filter.locations, nextLocation])),
          notes: `${filter.notes} Fallback location variant for continued discovery in ${nextLocation}, round ${round}.`
        };
        if (!existingNames.has(locationVariant.name) && this.filterSupportsTargetCategories(locationVariant, targetCategories)) {
          existingNames.add(locationVariant.name);
          fallbackFilters.push(locationVariant);
        }
      }

      const nextKeyword = FALLBACK_REPLENISHMENT_KEYWORDS[(round + index - 1) % FALLBACK_REPLENISHMENT_KEYWORDS.length];
      if (nextKeyword) {
        const keywordVariant: OrganizationFilter = {
          ...filter,
          name: `${filter.name} ${nextKeyword} Variant R${round}`,
          keywords: Array.from(new Set([...filter.keywords, nextKeyword])),
          notes: `${filter.notes} Fallback keyword variant for continued discovery around ${nextKeyword}, round ${round}.`
        };
        if (!existingNames.has(keywordVariant.name) && this.filterSupportsTargetCategories(keywordVariant, targetCategories)) {
          existingNames.add(keywordVariant.name);
          fallbackFilters.push(keywordVariant);
        }
      }
    }

    return fallbackFilters.slice(0, 8);
  }

  private getParallelFilterProbeCount(
    companySearchMode: import("../types").CompanySearchMode,
    targetLeadCount: number
  ): number {
    if (companySearchMode !== "exa_search") {
      return PARALLEL_FILTER_PROBE_COUNT;
    }

    return 1;
  }

  private getFiltersToExpandAfterProbe(
    companySearchMode: import("../types").CompanySearchMode,
    targetLeadCount: number
  ): number {
    if (companySearchMode !== "exa_search") {
      return FILTERS_TO_EXPAND_AFTER_PROBE;
    }

    return 0;
  }

  private async finalizeLeadRun(
    request: LeadJobRequest,
    suggestedFilters: OrganizationFilter[],
    evaluations: FilterEvaluation[],
    shortlistedCompanies: PreCategorizedCompany[],
    researchBriefs: ResearchBrief[],
    searchHistory: SearchHistoryEntry[],
    hubspotSync: {
      attempted: boolean;
      mode: "dry-run" | "live";
      candidateCount: number;
      syncedCount: number;
      companySyncedCount: number;
      contactSyncedCount: number;
      errors?: string[];
    },
    filtersStoppedEarly: number,
    companiesSkippedAfterEarlyStop: number,
    funnel: LeadRunFunnel,
    timedOut: boolean,
    stopped = false,
    completionReason?: string,
    contactCandidatesByCompany: Map<string, PublicContactCandidate[]> = new Map()
  ): Promise<LeadJobResult> {
    const azureCosts = this.azureClient.getUsageTotals();

    await this.controlPlaneStore.writeCompanyScreeningDatabase(this.companyScreeningDatabase);
    await this.controlPlaneStore.recordFilterEvaluations(request.companySearchMode ?? "internet_research", evaluations);
    await this.controlPlaneStore.recordSearchHistory(request.companySearchMode ?? "internet_research", searchHistory);
    await this.controlPlaneStore.writeLatestLeadRun({
      createdAt: new Date().toISOString(),
      requested: request,
      summary: {
        foundCandidates: shortlistedCompanies.length,
        filtersTested: evaluations.length,
        filtersStoppedEarly,
        companiesSkippedAfterEarlyStop,
        funnel,
        timedOut,
        stopped,
        completionReason
      },
      contacts: shortlistedCompanies.map((company) =>
        this.buildGeneratedLeadRecord(
          company,
          researchBriefs,
          contactCandidatesByCompany.get(this.getCompanyKey(company)) ?? []
        )
      ),
      searchHistory,
      hubspotSync: {
        attempted: hubspotSync.attempted,
        mode: hubspotSync.mode,
        candidateCount: hubspotSync.candidateCount,
        syncedCount: hubspotSync.syncedCount,
        companySyncedCount: hubspotSync.companySyncedCount,
        contactSyncedCount: hubspotSync.contactSyncedCount,
        errors: hubspotSync.errors
      },
      costs: {
        azure: azureCosts
      }
    });

    return {
      requested: request,
      suggestedFilters,
      evaluations: evaluations.sort((left, right) => right.relevanceRatio - left.relevanceRatio),
      shortlistedCompanies,
      researchBriefs,
      searchHistory,
      hubspotSync: {
        attempted: hubspotSync.attempted,
        mode: hubspotSync.mode,
        candidateCount: hubspotSync.candidateCount,
        syncedCount: hubspotSync.syncedCount,
        companySyncedCount: hubspotSync.companySyncedCount,
        contactSyncedCount: hubspotSync.contactSyncedCount,
        errors: hubspotSync.errors
      },
      efficiency: {
        filtersStoppedEarly,
        companiesSkippedAfterEarlyStop
      },
      funnel,
      timedOut,
      stopped,
      completionReason,
      costs: {
        azure: azureCosts
      }
    };
  }

  private evaluateFilter(
    filterName: string,
    companies: PreCategorizedCompany[],
    filter: import("../types").OrganizationFilter,
    targetCategories: LeadCategory[],
    market: string | undefined,
    initialReviewCount: number,
    stoppedEarly: boolean
  ): FilterEvaluation {
    const allCategories: LeadCategory[] = [...RELEVANT_CATEGORIES, "irrelevant", "other"];
    const categoryBreakdown = companies.reduce<Record<LeadCategory, number>>(
      (accumulator, company) => {
        accumulator[company.category] += 1;
        return accumulator;
      },
      Object.fromEntries(allCategories.map((category) => [category, 0])) as Record<LeadCategory, number>
    );

    const relevantCount = this.getRelevantCompanies(companies, filter, targetCategories, market).length;
    const relevanceRatio = companies.length === 0 ? 0 : relevantCount / companies.length;

    return {
      filterName,
      totalReviewed: companies.length,
      relevantCount,
      relevanceRatio,
      categoryBreakdown,
      stoppedEarly,
      initialReviewCount,
      skippedAfterEarlyStop: 0,
      recommendation:
        relevanceRatio >= 0.6
          ? "Scale this filter and expand adjacent keywords."
          : relevanceRatio >= 0.5
            ? "Keep testing with tighter keywords and geography constraints."
            : "Low signal. Replace or significantly revise the filter."
    };
  }

  private getActiveTargetCategories(input: LeadCategory[] | undefined): LeadCategory[] {
    const selectedCategories = (input ?? []).filter((category) => RELEVANT_CATEGORIES.includes(category));
    return selectedCategories.length > 0 ? selectedCategories : [...RELEVANT_CATEGORIES];
  }

  private filterSupportsTargetCategories(filter: OrganizationFilter, targetCategories: LeadCategory[]): boolean {
    const filterCategories = filter.targetCategories?.length ? filter.targetCategories : this.inferTargetCategories(filter.name);
    return filterCategories.some((category) => targetCategories.includes(category));
  }

  private getPrimaryTargetCategoryForFilter(filter: OrganizationFilter, targetCategories: LeadCategory[]): LeadCategory | undefined {
    const filterCategories = filter.targetCategories?.length ? filter.targetCategories : this.inferTargetCategories(filter.name);

    for (const category of filterCategories) {
      if (targetCategories.includes(category)) {
        return category;
      }
    }

    return targetCategories.find((category) => filterCategories.includes(category));
  }

  private inferTargetCategories(filterName: string): LeadCategory[] {
    const matchedEntry = FILTER_CATEGORY_FALLBACKS.find((entry) => entry.match.test(filterName));
    return matchedEntry ? matchedEntry.categories : [...RELEVANT_CATEGORIES];
  }
}