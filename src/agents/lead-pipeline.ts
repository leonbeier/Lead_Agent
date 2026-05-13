import { buildSuggestedFilters } from "../filters";
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
  LeadRunProgress,
  PreCategorizedCompany,
  PrequalificationConfig,
  PublicContactCandidate,
  SearchHistoryEntry
} from "../types";

const RELEVANT_CATEGORIES: LeadCategory[] = [
  "integrator_vision_industrial_ai",
  "integrator_general_ai",
  "integrator_relevant_focus",
  "industrial_end_customer_scaled",
  "camera_manufacturer_partner",
  "machine_builder_ai_enablement",
  "software_platform_embedding"
];

const FILTER_CATEGORY_FALLBACKS: Array<{ match: RegExp; categories: LeadCategory[] }> = [
  { match: /vision\s*\/\s*industrial ai integrators/i, categories: ["integrator_vision_industrial_ai"] },
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
const AZURE_WORKER_CONCURRENCY = 6;
const EXPANSION_BATCH_SIZE = 50;
const CREDITLESS_EXPANSION_BATCH_SIZE = 12;
const MAX_FILTER_REVISIONS = 1;
const MIN_COMPANIES_REVIEWED_BEFORE_FILTER_GIVE_UP = 40;
const CONTACT_DISCOVERY_CONCURRENCY = 2;
const PARALLEL_FILTER_PROBE_COUNT = 3;
const FILTERS_TO_EXPAND_AFTER_PROBE = 2;

type ProbedFilterCandidate = {
  filter: ApolloOrganizationFilter;
  activeCategory: LeadCategory;
  reviewedCompanies: PreCategorizedCompany[];
  categorizedInitialSample: PreCategorizedCompany[];
  initialEvaluation: FilterEvaluation;
  initialRelevant: PreCategorizedCompany[];
  useWebSearchForExpansion: boolean;
  apolloExpansionPage: number;
};

type ExpandedFilterOutcome = {
  evaluation: FilterEvaluation;
  categoryAdded: number;
  stoppedEarly: boolean;
  skippedAfterEarlyStop: number;
};

type LeadPipelineRunOptions = {
  onProgress?: (progress: LeadRunProgress) => void;
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

export class LeadPipelineAgent {
  private readonly apolloClient = new ApolloClient();

  private readonly azureClient = new AzureOpenAIClient();

  private readonly hubspotClient = new HubSpotClient();

  private readonly controlPlaneStore = new ControlPlaneStore();

  private companyScreeningDatabase: CompanyScreeningDatabase = { records: [] };

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
    const useWebSearchCompanyDiscovery = companySearchMode === "internet_research";
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
    const prequalification = request.prequalification ?? (request.prequalificationContext ? { mainContext: request.prequalificationContext } : undefined);
    this.companyScreeningDatabase = await this.controlPlaneStore.getCompanyScreeningDatabase();
    const suggestedFilters = this.orderFiltersByLearning(
      await this.getSuggestedFilters(request.market, request.customGoal, mainContext, request.searchStrategyContext, targetCategories, dryRun, learning),
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
    const evaluations: FilterEvaluation[] = [];
    const shortlistedCompanies: PreCategorizedCompany[] = [];
    const shortlistedKeys = new Set<string>();
    const searchHistory: SearchHistoryEntry[] = [];
    const categoryQuotas = this.buildCategoryQuotas(request.targetLeadCount, targetCategories);
    const categoryCounts = new Map<LeadCategory, number>(targetCategories.map((category) => [category, 0]));
    let filtersStoppedEarly = 0;
    let companiesSkippedAfterEarlyStop = 0;

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
        targetLeadCount: request.targetLeadCount
      });
    };

    for (const activeCategory of targetCategories) {
      const categoryTarget = categoryQuotas[activeCategory] ?? 0;
      if (categoryTarget <= 0) {
        continue;
      }

      const categoryFilters = suggestedFilters.filter((filter) => this.filterSupportsTargetCategories(filter, [activeCategory]));
      for (let filterIndex = 0; filterIndex < categoryFilters.length; filterIndex += PARALLEL_FILTER_PROBE_COUNT) {
        if ((categoryCounts.get(activeCategory) ?? 0) >= categoryTarget || shortlistedCompanies.length >= request.targetLeadCount) {
          break;
        }

        const probeBatch = categoryFilters.slice(filterIndex, filterIndex + PARALLEL_FILTER_PROBE_COUNT);
        const batchFilterNames = probeBatch.map((filter) => `"${filter.name}"`).join(", ");
        emitFilterProgress(
          `Starte Parallel-Probe fuer ${probeBatch.length} Filter in ${this.describeLeadCategory(activeCategory)}: ${batchFilterNames}.`
        );

        const probedCandidates = await this.mapWithConcurrency<ProbedFilterCandidate>(
          probeBatch.map((filter) => () => this.probeFilterCandidate(
            filter,
            activeCategory,
            dryRun,
            mainContext,
            prequalification,
            targetCategories,
            learning,
            request.market,
            earlyStopReviewCount,
            earlyStopThreshold,
            useWebSearchCompanyDiscovery,
            disableHubSpotDeduplication,
            emitFilterProgress
          )),
          PARALLEL_FILTER_PROBE_COUNT
        );

        const rankedCandidates: ProbedFilterCandidate[] = [...probedCandidates].sort((left: ProbedFilterCandidate, right: ProbedFilterCandidate) => {
          if (right.initialEvaluation.relevanceRatio !== left.initialEvaluation.relevanceRatio) {
            return right.initialEvaluation.relevanceRatio - left.initialEvaluation.relevanceRatio;
          }

          return right.initialRelevant.length - left.initialRelevant.length;
        });

        const filtersToExpand = rankedCandidates.slice(0, Math.min(FILTERS_TO_EXPAND_AFTER_PROBE, rankedCandidates.length));
        const discardedFilters = rankedCandidates.slice(filtersToExpand.length);

        for (const candidate of rankedCandidates) {
          const addedFromProbe = this.addUniqueCompanies(shortlistedCompanies, candidate.initialRelevant, shortlistedKeys);
          categoryCounts.set(activeCategory, (categoryCounts.get(activeCategory) ?? 0) + addedFromProbe);
          searchHistory.push(
            this.buildSearchHistoryEntry(
              candidate.filter.name,
              activeCategory,
              "probe_15",
              candidate.useWebSearchForExpansion ? 1 : candidate.apolloExpansionPage - 1,
              earlyStopReviewCount,
              candidate.categorizedInitialSample,
              candidate.filter,
              targetCategories,
              earlyStopThreshold
            )
          );

          emitFilterProgress(
            `Probe fuer "${candidate.filter.name}": ${candidate.initialRelevant.length}/${candidate.categorizedInitialSample.length} relevant (${Math.round(candidate.initialEvaluation.relevanceRatio * 100)}%), Quelle ${candidate.useWebSearchForExpansion ? "Web" : "Apollo"}, Weiterlauf ab ${earlyStopMinRelevantCount} relevanten Treffern.`
          );
        }

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
          if ((categoryCounts.get(activeCategory) ?? 0) >= categoryTarget || shortlistedCompanies.length >= request.targetLeadCount) {
            break;
          }

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
            emitFilterProgress
          );

          evaluations.push(expansionOutcome.evaluation);
          if (expansionOutcome.stoppedEarly) {
            filtersStoppedEarly += 1;
            companiesSkippedAfterEarlyStop += expansionOutcome.skippedAfterEarlyStop;
          }
        }
      }

      if (shortlistedCompanies.length >= request.targetLeadCount) {
        break;
      }
    }

    const sortedShortlist = shortlistedCompanies
      .sort((left, right) => right.relevanceScore - left.relevanceScore)
      .filter((company, index, all) => this.findFirstMatchingCompanyIndex(all, company) === index);

    const toppedUpShortlist = sortedShortlist.length >= request.targetLeadCount
      ? sortedShortlist
      : await this.topUpWithWebDiscovery(
          sortedShortlist,
          shortlistedKeys,
          suggestedFilters,
          request,
          mainContext,
          prequalification,
          targetCategories,
          learning
        );
    const filteredShortlist = await this.excludeExistingHubSpotDomains(
      toppedUpShortlist,
      dryRun,
      disableHubSpotDeduplication
    );
    const replenishedShortlist = filteredShortlist.length >= request.targetLeadCount
      ? filteredShortlist
      : await this.topUpWithWebDiscovery(
          filteredShortlist,
          shortlistedKeys,
          suggestedFilters,
          request,
          mainContext,
          prequalification,
          targetCategories,
          learning
        );
    const finalShortlist = await this.excludeExistingHubSpotDomains(
      replenishedShortlist,
      dryRun,
      disableHubSpotDeduplication
    );
    const uniqueShortlist = finalShortlist.slice(0, request.targetLeadCount);

    emitProgress({
      stage: "building_research",
      stageLabel: "Leads werden aufbereitet",
      progressValue: 78,
      progressMax: 100,
      progressDescription: `${uniqueShortlist.length} qualifizierte Firmen werden vorbereitet`,
      detail: dryRun
        ? "Dry-Run aktiv: Research-Briefs werden uebersprungen."
        : "Research-Briefs und Zusatzdaten werden fuer die qualifizierten Firmen erstellt.",
      processedFilters: evaluations.length,
      totalFilters: suggestedFilters.length,
      foundCandidates: uniqueShortlist.length,
      targetLeadCount: request.targetLeadCount
    });

    const researchBriefs = dryRun
      ? []
      : await this.mapWithConcurrency(
          uniqueShortlist.map((company) =>
            () => this.azureClient.buildResearchBrief(company, dryRun, mainContext, learning, {
              includeWebResearch: request.runDeepResearch !== false
            })
          ),
          AZURE_WORKER_CONCURRENCY
        );

    const publicContactCandidatesByCompany = await this.collectPublicContacts(uniqueShortlist, dryRun);
    const companiesNeedingApolloContacts = uniqueShortlist.filter((company) => {
      const existingContacts = publicContactCandidatesByCompany.get(this.getCompanyKey(company)) ?? [];
      return !this.hasReachableContact(existingContacts);
    });
    const apolloContactCandidatesByCompany = await this.collectApolloContacts(
      companiesNeedingApolloContacts,
      researchBriefs,
      dryRun,
      mainContext
    );
    const contactCandidatesByCompany = this.mergeContactCandidates(
      publicContactCandidatesByCompany,
      apolloContactCandidatesByCompany
    );

    emitProgress({
      stage: "syncing_hubspot",
      stageLabel: "HubSpot wird aktualisiert",
      progressValue: 90,
      progressMax: 100,
      progressDescription: `${uniqueShortlist.length} qualifizierte Firmen werden synchronisiert`,
      detail: syncToHubSpot
        ? "Die qualifizierten Firmen und Kontakte werden jetzt nach HubSpot geschrieben."
        : "Synchronisierung deaktiviert. Die Ergebnisse werden nur lokal gespeichert.",
      processedFilters: evaluations.length,
      totalFilters: suggestedFilters.length,
      foundCandidates: uniqueShortlist.length,
      targetLeadCount: request.targetLeadCount
    });

    const hubspotSync = await this.hubspotClient.syncQualifiedCompanies(uniqueShortlist, researchBriefs, contactCandidatesByCompany, !syncToHubSpot);
    const azureCosts = this.azureClient.getUsageTotals();
  await this.controlPlaneStore.writeCompanyScreeningDatabase(this.companyScreeningDatabase);
    await this.controlPlaneStore.recordFilterEvaluations(evaluations);
    await this.controlPlaneStore.recordSearchHistory(searchHistory);
    emitProgress({
      stage: "saving_results",
      stageLabel: "Ergebnisse werden gespeichert",
      progressValue: 97,
      progressMax: 100,
      progressDescription: `${uniqueShortlist.length} qualifizierte Firmen wurden verarbeitet`,
      detail: "Der letzte Lauf wird gespeichert und fuer die HubSpot-Oberflaeche aktualisiert.",
      processedFilters: evaluations.length,
      totalFilters: suggestedFilters.length,
      foundCandidates: uniqueShortlist.length,
      targetLeadCount: request.targetLeadCount
    });
    await this.controlPlaneStore.writeLatestLeadRun({
      createdAt: new Date().toISOString(),
      requested: request,
      summary: {
        foundCandidates: uniqueShortlist.length,
        filtersTested: evaluations.length,
        filtersStoppedEarly,
        companiesSkippedAfterEarlyStop
      },
      contacts: uniqueShortlist.map((company) =>
        this.buildGeneratedLeadRecord(
          company,
          researchBriefs,
          contactCandidatesByCompany.get(this.getCompanyKey(company)) ?? []
        )
      ),
      searchHistory,
      costs: {
        azure: azureCosts
      }
    });

    return {
      requested: request,
      suggestedFilters,
      evaluations: evaluations.sort((left, right) => right.relevanceRatio - left.relevanceRatio),
      shortlistedCompanies: uniqueShortlist,
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
      costs: {
        azure: azureCosts
      }
    };
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
        request.dryRun ?? true
      )
    };
  }

  private async probeFilterCandidate(
    filter: ApolloOrganizationFilter,
    activeCategory: LeadCategory,
    dryRun: boolean,
    mainContext: string | undefined,
    prequalification: PrequalificationConfig | undefined,
    targetCategories: LeadCategory[],
    learning: LeadLearningData,
    market: string | undefined,
    earlyStopReviewCount: number,
    earlyStopThreshold: number,
    useWebSearchCompanyDiscovery: boolean,
    disableHubSpotDeduplication: boolean,
    emitFilterProgress: (detail: string) => void
  ): Promise<ProbedFilterCandidate> {
    const reviewedCompanies: PreCategorizedCompany[] = [];
    emitFilterProgress(
      `Teste Filter "${filter.name}" fuer ${this.describeLeadCategory(activeCategory)}. Quelle ${useWebSearchCompanyDiscovery ? "Web" : "Apollo"}, Region ${filter.locations.join(", ") || "unbekannt"}, Keywords ${filter.keywords.slice(0, 4).join(", ") || "keine"}. Probe mit ${earlyStopReviewCount} Firmen startet.`
    );

    let useWebSearchForExpansion = useWebSearchCompanyDiscovery;
    let apolloExpansionPage = useWebSearchCompanyDiscovery || dryRun
      ? 1
      : await this.controlPlaneStore.getApolloSearchCursor(filter);
    const probeFetch = await this.fetchAvailableSearchSample(
      filter,
      earlyStopReviewCount,
      dryRun,
      apolloExpansionPage,
      useWebSearchCompanyDiscovery,
      disableHubSpotDeduplication,
      targetCategories,
      learning,
      reviewedCompanies
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
    let initialEvaluation = this.evaluateFilter(
      filter.name,
      categorizedInitialSample,
      filter,
      targetCategories,
      categorizedInitialSample.length,
      false
    );

    if (!useWebSearchCompanyDiscovery) {
      const initialRelevantFromApollo = this.getRelevantCompanies(categorizedInitialSample, filter, targetCategories, market);
      if (initialRelevantFromApollo.length === 0 || initialEvaluation.relevanceRatio < earlyStopThreshold) {
        const webFallbackProbe = await this.fetchAvailableSearchSample(
          filter,
          earlyStopReviewCount,
          dryRun,
          1,
          true,
          disableHubSpotDeduplication,
          targetCategories,
          learning,
          reviewedCompanies
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
          categorizedWebFallbackProbe.length,
          false
        );

        if (
          relevantFromWebFallback.length > initialRelevantFromApollo.length ||
          webFallbackEvaluation.relevanceRatio > initialEvaluation.relevanceRatio
        ) {
          categorizedInitialSample = categorizedWebFallbackProbe;
          initialEvaluation = webFallbackEvaluation;
          useWebSearchForExpansion = true;
        }
      }
    }

    reviewedCompanies.push(...categorizedInitialSample);

    return {
      filter,
      activeCategory,
      reviewedCompanies,
      categorizedInitialSample,
      initialEvaluation,
      initialRelevant: this.getRelevantCompanies(categorizedInitialSample, filter, targetCategories, market),
      useWebSearchForExpansion,
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
    emitFilterProgress: (detail: string) => void
  ): Promise<ExpandedFilterOutcome> {
    const reviewedCompanies = [...candidate.reviewedCompanies];
    let apolloExpansionPage = candidate.apolloExpansionPage;

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
      const remainingGlobalSlots = Math.max(0, request.targetLeadCount - shortlistedCompanies.length);
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
        candidate.useWebSearchForExpansion,
        disableHubSpotDeduplication,
        targetCategories,
        learning,
        reviewedCompanies
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
        reviewedCompanies.length,
        false
      );

      searchHistory.push(
        this.buildSearchHistoryEntry(
          candidate.filter.name,
          candidate.activeCategory,
          "expand_50",
          requestedPage,
          expansionBatchSize,
          categorizedExpandedSample,
          candidate.filter,
          targetCategories,
          earlyStopThreshold
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

      if ((categoryCounts.get(candidate.activeCategory) ?? 0) >= categoryTarget || shortlistedCompanies.length >= request.targetLeadCount) {
        break;
      }
    }

    const evaluation = this.evaluateFilter(
      candidate.filter.name,
      reviewedCompanies,
      candidate.filter,
      targetCategories,
      candidate.categorizedInitialSample.length,
      false
    );
    emitFilterProgress(
      `Filter "${candidate.filter.name}" abgeschlossen: ${evaluation.relevantCount}/${evaluation.totalReviewed} relevant (${Math.round(evaluation.relevanceRatio * 100)}%). Aktuell ${shortlistedCompanies.length}/${request.targetLeadCount} Ziel-Firmen gefunden.`
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
    learning?: LeadLearningData
  ) {
    const baselineFilters = buildSuggestedFilters(market, customGoal)
      .filter((filter) => this.filterSupportsTargetCategories(filter, targetCategories));
    if (this.shouldReuseLearnedFilters(baselineFilters, learning, customGoal, mainContext, searchStrategyContext)) {
      return baselineFilters;
    }

    const generatedFilters = await this.azureClient.generateSuggestedFilters(
      market,
      customGoal,
      mainContext,
      searchStrategyContext,
      targetCategories,
      baselineFilters,
      dryRun,
      learning
    );

    return [...baselineFilters, ...generatedFilters.filter((filter) => this.filterSupportsTargetCategories(filter, targetCategories))]
      .filter((filter, index, all) => all.findIndex((candidate) => candidate.name === filter.name) === index);
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
        const cachedCategorization = this.getCachedCategorization(company);
        if (cachedCategorization) {
          return {
            ...company,
            ...cachedCategorization
          };
        }

        const localCategorization = this.prequalifyLocally(company);
        if (localCategorization) {
          this.upsertCompanyScreeningRecord(company, localCategorization);
          return {
            ...company,
            ...localCategorization
          };
        }

        const categorization = /(browser-search|source-scrape)/.test(company.sourceFilter)
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

        this.upsertCompanyScreeningRecord(company, {
          category: resolvedCategorization.category,
          relevanceScore: resolvedCategorization.relevanceScore,
          rationale: resolvedCategorization.rationale
        });

        return resolvedCategorization;
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
      "inspection",
      "quality control",
      "machine vision",
      "camera",
      "robotics",
      "embedded",
      "factory",
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
      "insurance"
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
      "digital transformation",
      "data & ai",
      "machine learning",
      "computer vision"
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

    const industrialHits = industrialSignals.filter((signal) => text.includes(signal)).length;

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

    return null;
  }

  private enforceIndustrialFit(
    company: CompanySample,
    categorization: Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale">
  ): Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale"> {
    const text = `${company.name} ${company.shortDescription} ${company.domain ?? ""} ${company.sourceFilter}`.toLowerCase();
    const industrialSignals = [
      "industrial",
      "automation",
      "inspection",
      "quality control",
      "machine vision",
      "camera",
      "robotics",
      "embedded",
      "factory",
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
      "hr",
      "crypto",
      "marketing",
      "payments"
    ];
    const serviceSignals = [
      "system integrator",
      "systems integrator",
      "integration services",
      "software services",
      "software development",
      "custom software",
      "project delivery",
      "engineering services",
      "solution provider",
      "implementation"
    ];
    const productVendorSignals = [
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

    if (clearlyBadSignals.some((signal) => text.includes(signal))) {
      return {
        category: "irrelevant",
        relevanceScore: 8,
        rationale: "Company profile signals a non-industrial service or platform segment outside ONE WARE's ICP."
      };
    }

    if (
      (categorization.category === "integrator_vision_industrial_ai" ||
        categorization.category === "integrator_general_ai" ||
        categorization.category === "integrator_relevant_focus") &&
      productVendorSignals.some((signal) => text.includes(signal)) &&
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
    request: LeadJobRequest,
    mainContext: string | undefined,
    prequalification: PrequalificationConfig | undefined,
    targetCategories: LeadCategory[],
    learning: LeadLearningData
  ): Promise<PreCategorizedCompany[]> {
    const toppedUp = [...currentShortlist];

    for (const filter of filters) {
      const remainingSlots = request.targetLeadCount - toppedUp.length;
      if (remainingSlots <= 0) {
        break;
      }

      const maxPages = remainingSlots <= 3 ? 1 : remainingSlots <= 8 ? 2 : 3;
      for (let page = 1; page <= maxPages; page += 1) {
        const expansionBatchSize = this.getExpansionBatchSize(request.targetLeadCount - toppedUp.length, true);
        const discoveredFetch = await this.fetchAvailableSearchSample(
          filter,
          expansionBatchSize,
          Boolean(request.dryRun),
          page,
          true,
          request.disableHubSpotDeduplication ?? false,
          targetCategories,
          learning,
          toppedUp
        );
        const discoveredCompanies = discoveredFetch.companies;

        if (discoveredCompanies.length === 0) {
          break;
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
        this.addUniqueCompanies(toppedUp, relevantCompanies, shortlistedKeys);

        if (toppedUp.length >= request.targetLeadCount || discoveredCompanies.length < expansionBatchSize) {
          break;
        }
      }
    }

    return toppedUp;
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

    const earlyStopPenalty = stats.runs === 0 ? 0 : stats.earlyStopCount / stats.runs;
    return stats.averageRelevanceRatio - earlyStopPenalty + strategicBias;
  }

  private getStrategicFilterBias(filterName: string, market?: string, customGoal?: string): number {
    const normalizedName = filterName.toLowerCase();
    const normalizedGoal = customGoal?.toLowerCase() ?? "";
    let bias = 0;

    if (normalizedName.includes("vision") && normalizedName.includes("integrators")) {
      bias += 0.45;
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

    if ((market ?? "").toLowerCase() === "de" && normalizedName.includes("europe")) {
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

    if (normalizedMarket === "de") {
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
    return EUROPEAN_COUNTRIES.has(location.trim().toLowerCase());
  }

  private buildSearchHistoryEntry(
    filterName: string,
    targetCategory: LeadCategory,
    batchType: "probe_15" | "expand_50",
    page: number,
    requestedCount: number,
    companies: PreCategorizedCompany[],
    filter: import("../types").ApolloOrganizationFilter,
    targetCategories: LeadCategory[],
    threshold: number
  ): SearchHistoryEntry {
    const relevantCount = this.getRelevantCompanies(companies, filter, targetCategories).length;
    const relevanceRatio = companies.length === 0 ? 0 : relevantCount / companies.length;

    return {
      timestamp: new Date().toISOString(),
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
      passedThreshold: relevanceRatio >= threshold,
      recommendation: relevanceRatio >= threshold
        ? "Continue expanding this search."
        : "Revise the search before spending more credits."
    };
  }

  private buildCategoryQuotas(targetLeadCount: number, categories: LeadCategory[]): Record<LeadCategory, number> {
    const baseQuota = Math.floor(targetLeadCount / categories.length);
    const remainder = targetLeadCount % categories.length;
    const quotas = {} as Record<LeadCategory, number>;

    categories.forEach((category, index) => {
      quotas[category] = baseQuota + (index < remainder ? 1 : 0);
    });

    return quotas;
  }

  private describeLeadCategory(category: LeadCategory): string {
    switch (category) {
      case "integrator_vision_industrial_ai":
        return "Vision-/Industrial-AI-Integratoren";
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
    disableHubSpotDeduplication: boolean
  ): Promise<PreCategorizedCompany[]> {
    if (dryRun || disableHubSpotDeduplication || companies.length === 0) {
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
    targetCategories: LeadCategory[]
  ): Promise<CompanySample[]> {
    if (dryRun || disableHubSpotDeduplication || companies.length === 0) {
      return this.excludeCachedScreenedCompanies(companies, targetCategories);
    }

    const filteredByCache = this.excludeCachedScreenedCompanies(companies, targetCategories);
    if (filteredByCache.length === 0) {
      return filteredByCache;
    }

    const domains = filteredByCache
      .map((company) => company.domain)
      .filter((domain): domain is string => Boolean(domain));
    if (domains.length === 0) {
      return filteredByCache;
    }

    const existingDomains = await this.getKnownHubSpotDomains(domains);
    if (existingDomains.size === 0) {
      return filteredByCache;
    }

    return filteredByCache.filter((company) => {
      const normalizedDomain = company.domain?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
      return !normalizedDomain || !existingDomains.has(normalizedDomain);
    });
  }

  private async fetchAvailableSearchSample(
    filter: ApolloOrganizationFilter,
    requestedCount: number,
    dryRun: boolean,
    page: number,
    useWebSearch: boolean,
    disableHubSpotDeduplication: boolean,
    targetCategories: LeadCategory[],
    learning: LeadLearningData,
    reviewedCompanies: Array<Pick<CompanySample, "name" | "domain">>
  ): Promise<{ companies: CompanySample[]; nextPage: number }> {
    const collected: CompanySample[] = [];
    const seenKeys = new Set(reviewedCompanies.map((company) => this.getCompanyKey(company)));
    const maxPages = useWebSearch ? 3 : 6;
    const pageSize = Math.max(MIN_EARLY_STOP_REVIEW_COUNT, requestedCount);
    const plannedPages = this.buildSearchPagePlan(page, maxPages, useWebSearch, requestedCount);
    let nextPage = page;
    const shouldSkipDiscoveryDomain = (domain: string) => this.shouldSkipDiscoveryDomain(domain, targetCategories);

    for (const plannedPage of plannedPages) {
      if (collected.length >= requestedCount) {
        break;
      }

      const sample = this.excludeRejectedCompanies(
        await this.apolloClient.fetchOrganizationSample(filter, pageSize, dryRun, plannedPage, useWebSearch, shouldSkipDiscoveryDomain),
        learning
      );

      nextPage = plannedPage + 1;

      if (sample.length === 0) {
        break;
      }

      const unseenSample = sample.filter((company) => !seenKeys.has(this.getCompanyKey(company)));
      const availableSample = await this.excludeExistingCompanySamples(
        unseenSample,
        dryRun,
        disableHubSpotDeduplication,
        targetCategories
      );

      for (const company of availableSample) {
        const companyKey = this.getCompanyKey(company);
        if (seenKeys.has(companyKey)) {
          continue;
        }

        seenKeys.add(companyKey);
        collected.push(company);

        if (collected.length >= requestedCount) {
          break;
        }
      }
      if (sample.length < pageSize) {
        break;
      }
    }

    if (!useWebSearch && !dryRun) {
      await this.controlPlaneStore.updateApolloSearchCursor(filter, nextPage);
    }

    return {
      companies: collected,
      nextPage
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

  private normalizeDomain(domain: string | undefined): string | undefined {
    if (!domain) {
      return undefined;
    }

    return domain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/$/, "");
  }

  private getUniqueCompanyCount(companies: PreCategorizedCompany[]): number {
    return companies.filter((company, index, all) => this.findFirstMatchingCompanyIndex(all, company) === index).length;
  }

  private excludeAlreadyReviewedCompanies(
    companies: CompanySample[],
    reviewedCompanies: PreCategorizedCompany[]
  ): CompanySample[] {
    const reviewedKeys = new Set(reviewedCompanies.map((company) => this.getCompanyKey(company)));
    return companies.filter((company) => !reviewedKeys.has(this.getCompanyKey(company)));
  }

  private findFirstMatchingCompanyIndex(companies: PreCategorizedCompany[], company: PreCategorizedCompany): number {
    const companyDomain = company.domain?.toLowerCase();
    const companyName = company.name.toLowerCase();

    return companies.findIndex((entry) => {
      const sameDomain = companyDomain && entry.domain?.toLowerCase() === companyDomain;
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
      companies.map((company) => async () => [this.getCompanyKey(company), await this.hubspotClient.findPublicContactsForCompany(company)] as const),
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
        const apolloCandidates = await this.apolloClient.searchContactsForCompany(company, 10);
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

  private hasReachableContact(contacts: PublicContactCandidate[]): boolean {
    return contacts.some((contact) => Boolean(contact.email || contact.phone));
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
    return company.domain?.trim().toLowerCase() || company.name.trim().toLowerCase();
  }

  private async mapWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
    const results: T[] = [];

    for (let start = 0; start < tasks.length; start += concurrency) {
      const batch = tasks.slice(start, start + concurrency);
      results.push(...(await Promise.all(batch.map((task) => task()))));
    }

    return results;
  }

  private evaluateFilter(
    filterName: string,
    companies: PreCategorizedCompany[],
    filter: import("../types").ApolloOrganizationFilter,
    targetCategories: LeadCategory[],
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

    const relevantCount = this.getRelevantCompanies(companies, filter, targetCategories).length;
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

  private inferTargetCategories(filterName: string): LeadCategory[] {
    const matchedEntry = FILTER_CATEGORY_FALLBACKS.find((entry) => entry.match.test(filterName));
    return matchedEntry ? matchedEntry.categories : [...RELEVANT_CATEGORIES];
  }
}