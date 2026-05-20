import fs from "node:fs/promises";
import path from "node:path";

import { env } from "../config";
import { buildSuggestedFilters, extractExplicitMarketLocality, isGermanyFocusedMarket } from "../filters";
import { ApolloClient } from "../clients/apollo";
import { AzureOpenAIClient } from "../clients/azure-openai";
import { HubSpotClient } from "../clients/hubspot";
import { ControlPlaneStore } from "../control-plane";
import {
  ApolloOrganizationFilter,
  CompanyScreeningDatabase,
  CompanyScreeningRecord,
  CompanySample,
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
  SearchHistoryDecisionSample,
  SearchHistoryEntry
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

type ProbedFilterCandidate = {
  filter: ApolloOrganizationFilter;
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
  filteredByPriorFeedbackCount: number;
  filteredByCacheCount: number;
  filteredByHubSpotCount: number;
  eligibleSampleCount: number;
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
  ".nl",
  ".be",
  ".lu",
  ".dk",
  ".se",
  ".no",
  ".fi",
  ".fr",
  ".it",
  ".es",
  ".pt",
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

  private readonly azureClient = new AzureOpenAIClient();

  private readonly hubspotClient = new HubSpotClient();

  private readonly controlPlaneStore = new ControlPlaneStore();

  private companyScreeningDatabase: CompanyScreeningDatabase = { records: [] };

  private discoveryCheckpointContext?: { runId: string; nextSequence: number };

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
    const companySearchMode = request.companySearchMode ?? (request.creditLessMode ? "internet_research" : "apollo_search");
    this.apolloClient.setExaApiKey(request.exaApiKey);
    this.apolloClient.setDiffbotToken(request.diffbotToken);
    const deadlineAt = Date.now() + Math.max(60_000, request.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS);
    const wasStopped = () => Boolean(options?.shouldStop?.());
    const hasTimedOut = () => Date.now() >= deadlineAt;
    const shouldFinishEarly = () => wasStopped() || hasTimedOut();
    this.discoveryCheckpointContext = { runId: this.createDiscoveryCheckpointRunId(), nextSequence: 0 };
    const useWebSearchCompanyDiscovery = companySearchMode !== "apollo_search";
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
    await this.preloadKnownHubSpotDomains(disableHubSpotDeduplication);
    let suggestedFilters = this.orderFiltersByLearning(
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
      stageLabel: "Filter werden bewertet",
      progressValue: 10,
      progressMax: 100,
      progressDescription: `0 von ${suggestedFilters.length} Filtern bewertet`,
      detail: "Der Lead Agent prueft jetzt die Suchfilter und sammelt erste Kandidaten.",
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
    const hasReachedRequestedTarget = () => getCompletionCount() >= request.targetLeadCount;

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

    this.apolloClient.resetDiscoveryMetrics(companySearchMode);

    const collectPreparedResearchBriefs = (companies: PreCategorizedCompany[]): ResearchBrief[] =>
      companies
        .map((company) => researchBriefsByCompany.get(this.getCompanyKey(company)))
        .filter((brief): brief is ResearchBrief => Boolean(brief));

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

      emitSyncPreparationProgress(40, `Research-Briefs und Website-Kontakte werden parallel fuer ${pendingCompanies.length} Firmen vorbereitet.`);

      const [preparedResearchEntries, publicContacts] = await Promise.all([
        dryRun
          ? Promise.resolve([])
          : this.mapWithConcurrency(
              pendingCompanies.map((company) => async () => ({
                companyKey: this.getCompanyKey(company),
                brief: await this.azureClient.buildResearchBrief(company, dryRun, mainContext, learning, {
                  includeWebResearch: request.runDeepResearch !== false
                })
              })),
              AZURE_WORKER_CONCURRENCY
            ),
        this.collectPublicContacts(pendingCompanies, dryRun)
      ]);

      for (const entry of preparedResearchEntries) {
        researchBriefsByCompany.set(entry.companyKey, entry.brief);
      }

      const syncEligibleCompanies = pendingCompanies;

      const pendingResearchBriefs = syncEligibleCompanies
        .map((company) => researchBriefsByCompany.get(this.getCompanyKey(company)))
        .filter((brief): brief is ResearchBrief => Boolean(brief));
      const companiesNeedingApolloContacts = syncEligibleCompanies.filter((company) => {
        const existingContacts = publicContacts.get(this.getCompanyKey(company)) ?? [];
        return !this.hasNonGenericReachableContact(existingContacts);
      });

      emitSyncPreparationProgress(56, `Zusatzrecherche fuer ${companiesNeedingApolloContacts.length} Firmen ohne brauchbare Direktkontakte wird vorbereitet.`);

      const apolloContacts = await this.collectApolloContacts(
        companiesNeedingApolloContacts,
        pendingResearchBriefs,
        dryRun,
        mainContext
      );

      if (shouldFinishEarly()) {
        return;
      }

      const mergedContacts = this.mergeContactCandidates(apolloContacts, publicContacts);

      for (const company of syncEligibleCompanies) {
        const companyKey = this.getCompanyKey(company);
        contactCandidatesByCompany.set(companyKey, mergedContacts.get(companyKey) ?? []);
      }

      const syncResult = await this.hubspotClient.syncQualifiedCompanies(
        syncEligibleCompanies,
        syncEligibleCompanies
          .map((company) => researchBriefsByCompany.get(this.getCompanyKey(company)))
          .filter((brief): brief is ResearchBrief => Boolean(brief)),
        mergedContacts,
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

    while (!hasReachedRequestedTarget() && !shouldFinishEarly()) {
      const remainingTargetCount = Math.max(1, request.targetLeadCount - getCompletionCount());
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
            `Probe fuer "${candidate.filter.name}": ${candidate.initialRelevant.length}/${candidate.categorizedInitialSample.length} relevant (${Math.round(candidate.initialEvaluation.relevanceRatio * 100)}%), Rohmenge ${candidate.sampleDiagnostics.fetchedSampleCount}, nach Cache/Vorfilter ${candidate.sampleDiagnostics.eligibleSampleCount}, Quelle ${candidate.useWebSearchForExpansion ? "Web" : "Apollo"}, Weiterlauf ab ${earlyStopMinRelevantCount} relevanten Treffern.`
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
    filter: ApolloOrganizationFilter,
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
    const probeSourceLabel = this.getDiscoverySourceLabel(useWebSearchCompanyDiscovery ? companySearchMode : "apollo_search");
    emitFilterProgress(
      `Teste Filter "${filter.name}" fuer ${this.describeLeadCategory(activeCategory)}. Quelle ${probeSourceLabel}, Region ${filter.locations.join(", ") || "unbekannt"}, Keywords ${filter.keywords.slice(0, 4).join(", ") || "keine"}. Probe mit bis zu ${useWebSearchCompanyDiscovery ? webRawProbeCount : earlyStopReviewCount} ${useWebSearchCompanyDiscovery ? "Web-Sites" : "Firmen"} startet.`
    );

    let useWebSearchForExpansion = useWebSearchCompanyDiscovery;
    let expansionSearchMode = companySearchMode;
    let apolloExpansionPage = useWebSearchCompanyDiscovery || dryRun
      ? 1
      : await this.controlPlaneStore.getApolloSearchCursor(filter);
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
      () => emitFilterProgress(
        `Teste Filter "${filter.name}" fuer ${this.describeLeadCategory(activeCategory)}. Quelle ${probeSourceLabel}, Region ${filter.locations.join(", ") || "unbekannt"}, Keywords ${filter.keywords.slice(0, 4).join(", ") || "keine"}. Probe mit bis zu ${useWebSearchCompanyDiscovery ? webRawProbeCount : earlyStopReviewCount} ${useWebSearchCompanyDiscovery ? "Web-Sites" : "Firmen"} startet.`
      )
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
            `Teste Filter "${filter.name}" fuer ${this.describeLeadCategory(activeCategory)}. Quelle ${webFallbackSourceLabel}, Region ${filter.locations.join(", ") || "unbekannt"}, Keywords ${filter.keywords.slice(0, 4).join(", ") || "keine"}. Probe mit bis zu ${webRawProbeCount} Web-Sites startet.`
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
        `Filter "${candidate.filter.name}" frueh gestoppt nach Web-Probe: ${candidate.initialRelevant.length}/${candidate.categorizedInitialSample.length} relevant, Rohmenge ${candidate.sampleDiagnostics.fetchedSampleCount}, nach Cache/Vorfilter ${candidate.sampleDiagnostics.eligibleSampleCount}.`
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
        `Filter "${candidate.filter.name}" frueh gestoppt: ${candidate.initialRelevant.length}/${candidate.categorizedInitialSample.length} relevant (${Math.round(candidate.initialEvaluation.relevanceRatio * 100)}%). Bisher ${shortlistedCompanies.length}/${request.targetLeadCount} Ziel-Firmen gesammelt.`
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
          `Filter "${candidate.filter.name}" wird weiter ausgebaut. Seite ${requestedPage}, Batch ${expansionBatchSize}, aktuell ${getCompletionCount()}/${request.targetLeadCount} Ziel-Firmen erreicht.`
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
          `Filter "${candidate.filter.name}" frueh gestoppt waehrend Expansion: ${evaluation.relevantCount}/${evaluation.totalReviewed} relevant (${Math.round(evaluation.relevanceRatio * 100)}%).`
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
      `Filter "${candidate.filter.name}" abgeschlossen: ${evaluation.relevantCount}/${evaluation.totalReviewed} relevant (${Math.round(evaluation.relevanceRatio * 100)}%). Aktuell ${getCompletionCount()}/${request.targetLeadCount} Ziel-Firmen erreicht.`
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

  private prioritizeFiltersForOpenCrawler(
    filters: ApolloOrganizationFilter[],
    targetCategories: LeadCategory[],
    learning: LeadLearningData | undefined,
    market?: string,
    customGoal?: string
  ): ApolloOrganizationFilter[] {
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
      const coveredFilters: ApolloOrganizationFilter[] = [];

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
    learning?: LeadLearningData
  ): Promise<PreCategorizedCompany[]> {
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

        const resolvedCategorization = dryRun
          ? {
              ...company,
              ...this.enforceIndustrialFit(company, categorization)
            }
          : {
              ...company,
              ...categorization
            };
        const normalizedCategorization = this.normalizeCompanyIdentity(resolvedCategorization);

        this.upsertCompanyScreeningRecord(normalizedCategorization, {
          category: normalizedCategorization.category,
          relevanceScore: normalizedCategorization.relevanceScore,
          rationale: normalizedCategorization.rationale
        });

        return normalizedCategorization;
      }),
      AZURE_WORKER_CONCURRENCY
    );
  }

  private prequalifyLocally(
    company: CompanySample
  ): Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale"> | null {
    const text = `${company.name} ${company.shortDescription} ${company.domain ?? ""}`.toLowerCase();
    const normalizedDescription = company.shortDescription.trim().toLowerCase();
    const hasPlaceholderDescription =
      normalizedDescription.length === 0 ||
      normalizedDescription.includes("no verified public company description was returned by apollo");
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
      "commissioning",
      "turnkey",
      "customer-specific",
      "kundenspezifisch",
      "systemintegration"
    ];
    const productVendorSignals = [
      "manufacturer",
      "manufacturer",
      "oem",
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
      (productVendorSignals.some((signal) => text.includes(signal)) || knownManufacturerSignals.some((signal) => text.includes(signal))) &&
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
      !industrialSignals.some((signal) => text.includes(signal))
    ) {
      return {
        category: "other",
        relevanceScore: Math.min(categorization.relevanceScore, 35),
        rationale: "Company may have software or AI capability, but the profile lacks clear industrial, automation, or vision-delivery signals."
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
    filters: import("../types").ApolloOrganizationFilter[],
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
        const discoveredFetch = await this.runWithProgressHeartbeat(
          () => this.fetchAvailableSearchSample(
            filter,
            expansionBatchSize,
            Boolean(request.dryRun),
            page,
            request.companySearchMode ?? (request.creditLessMode ? "internet_research" : "apollo_search"),
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
          () => emitTopUpProgress(topUpDetail, toppedUp.length)
        );
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

        const categorizedCompanies = await this.categorizeCompanies(
          unseenCompanies,
          Boolean(request.dryRun),
          mainContext,
          prequalification,
          targetCategories,
          learning
        );

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

  private getExpansionBatchSize(remainingSlots: number, useWebSearch: boolean): number {
    const fallbackRemainingSlots = Math.max(1, remainingSlots);
    const targetBuffer = useWebSearch ? fallbackRemainingSlots * 2 : fallbackRemainingSlots * 3;
    const maxBatchSize = useWebSearch ? CREDITLESS_EXPANSION_BATCH_SIZE : EXPANSION_BATCH_SIZE;

    return Math.max(MIN_EARLY_STOP_REVIEW_COUNT, Math.min(maxBatchSize, targetBuffer));
  }

  private orderFiltersByLearning(
    filters: import("../types").ApolloOrganizationFilter[],
    learning: LeadLearningData,
    market?: string,
    customGoal?: string
  ): import("../types").ApolloOrganizationFilter[] {
    return [...filters].sort(
      (left, right) => this.getFilterRank(right.name, learning, market, customGoal) - this.getFilterRank(left.name, learning, market, customGoal)
    );
  }

  private prioritizeFiltersForTopUp(
    filters: import("../types").ApolloOrganizationFilter[],
    evaluations: FilterEvaluation[],
    learning: LeadLearningData,
    market?: string,
    customGoal?: string
  ): import("../types").ApolloOrganizationFilter[] {
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
    baselineFilters: import("../types").ApolloOrganizationFilter[],
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
    filter: import("../types").ApolloOrganizationFilter,
    targetCategories: LeadCategory[],
    market?: string
  ): PreCategorizedCompany[] {
    return companies.filter(
      (company) => targetCategories.includes(company.category) && this.isCompanyInScope(company, filter, market)
    );
  }

  private isCompanyInScope(
    company: Pick<PreCategorizedCompany, "country" | "domain">,
    filter: import("../types").ApolloOrganizationFilter,
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

    return "Apollo";
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

  private buildSearchHistoryEntry(
    companySearchMode: import("../types").CompanySearchMode,
    filterName: string,
    targetCategory: LeadCategory,
    batchType: "probe_15" | "expand_50",
    page: number,
    requestedCount: number,
    companies: PreCategorizedCompany[],
    filter: import("../types").ApolloOrganizationFilter,
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

  private async fetchAvailableSearchSample(
    filter: ApolloOrganizationFilter,
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
    const pageSize = useWebSearch
      ? Math.max(webSearchMinSampleSize, requestedCount * webSearchSampleMultiplier)
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
        () => this.apolloClient.fetchOrganizationSample(
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
      await this.controlPlaneStore.updateApolloSearchCursor(filter, nextPage);
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
    filter: ApolloOrganizationFilter;
    page: number;
    companies: CompanySample[];
  }): Promise<void> {
    const outputDir = process.env.LEAD_AGENT_DISCOVERY_CHECKPOINT_DIR?.trim()
      || path.join(process.cwd(), "data", "lead-run-discovery-checkpoints", params.runId);
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
      CONTACT_DISCOVERY_CONCURRENCY
    );

    return new Map(entries);
  }

  private async collectApolloContacts(
    companies: PreCategorizedCompany[],
    researchBriefs: import("../types").ResearchBrief[],
    dryRun: boolean,
    mainContext?: string
  ): Promise<Map<string, PublicContactCandidate[]>> {
    if (dryRun) {
      return new Map();
    }

    const entries = await this.mapWithConcurrency(
      companies.map((company) => async () => {
        const brief = researchBriefs.find((entry) => entry.companyName === company.name);
        const apolloCandidates = await this.apolloClient.searchContactsForCompany(company, 20);
        const selectedCandidates = await this.azureClient.chooseApolloContacts(company, apolloCandidates, dryRun, mainContext, brief);
        const enrichedContacts: PublicContactCandidate[] = [];

        for (const candidate of selectedCandidates) {
          const enrichedContact = await this.apolloClient.enrichContactEmail(candidate, company);
          if (!enrichedContact) {
            continue;
          }

          if (enrichedContacts.some((existing) => existing.email === enrichedContact.email)) {
            continue;
          }

          enrichedContacts.push(enrichedContact);
        }

        return [this.getCompanyKey(company), enrichedContacts] as const;
      }),
      CONTACT_DISCOVERY_CONCURRENCY
    );

    return new Map(entries);
  }

  private hasNonGenericReachableContact(contacts: PublicContactCandidate[]): boolean {
    return contacts.some((contact) => Boolean(contact.email || contact.phone) && !this.isGenericFallbackContact(contact));
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
    const discoveryMetrics = this.apolloClient.getDiscoveryMetrics(companySearchMode);

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

    const discoveryMetrics = this.apolloClient.getDiscoveryMetrics(companySearchMode);
    return discoveryMetrics.crawledPages >= 24 && discoveryMetrics.acceptedCompanyDomains >= 24;
  }

  private async replenishExhaustedFilters(
    existingFilters: ApolloOrganizationFilter[],
    evaluations: FilterEvaluation[],
    market: string | undefined,
    customGoal: string | undefined,
    mainContext: string | undefined,
    searchStrategyContext: string | undefined,
    targetCategories: LeadCategory[],
    dryRun: boolean,
    learning?: LeadLearningData
  ): Promise<ApolloOrganizationFilter[]> {
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
    existingFilters: ApolloOrganizationFilter[],
    evaluations: FilterEvaluation[],
    targetCategories: LeadCategory[],
    round: number
  ): ApolloOrganizationFilter[] {
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
      .filter((filter): filter is ApolloOrganizationFilter => Boolean(filter));
    const fallbackSourceFilters = rankedFilters.length > 0 ? rankedFilters : existingFilters;

    const fallbackFilters: ApolloOrganizationFilter[] = [];

    for (const [index, filter] of fallbackSourceFilters.slice(0, 4).entries()) {
      const nextLocation = FALLBACK_REPLENISHMENT_LOCATIONS[(round + index - 1) % FALLBACK_REPLENISHMENT_LOCATIONS.length];
      if (nextLocation) {
        const locationVariant: ApolloOrganizationFilter = {
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
        const keywordVariant: ApolloOrganizationFilter = {
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

    if (targetLeadCount <= 10) {
      return 1;
    }

    if (targetLeadCount <= 25) {
      return 2;
    }

    return 3;
  }

  private getFiltersToExpandAfterProbe(
    companySearchMode: import("../types").CompanySearchMode,
    targetLeadCount: number
  ): number {
    if (companySearchMode !== "exa_search") {
      return FILTERS_TO_EXPAND_AFTER_PROBE;
    }

    if (targetLeadCount <= 10) {
      return 1;
    }

    if (targetLeadCount <= 25) {
      return 2;
    }

    return 3;
  }

  private async finalizeLeadRun(
    request: LeadJobRequest,
    suggestedFilters: ApolloOrganizationFilter[],
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
    filter: import("../types").ApolloOrganizationFilter,
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

  private filterSupportsTargetCategories(filter: ApolloOrganizationFilter, targetCategories: LeadCategory[]): boolean {
    const filterCategories = filter.targetCategories?.length ? filter.targetCategories : this.inferTargetCategories(filter.name);
    return filterCategories.some((category) => targetCategories.includes(category));
  }

  private getPrimaryTargetCategoryForFilter(filter: ApolloOrganizationFilter, targetCategories: LeadCategory[]): LeadCategory | undefined {
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