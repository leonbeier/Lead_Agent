import { buildSuggestedFilters } from "../filters";
import { ApolloClient } from "../clients/apollo";
import { AzureOpenAIClient } from "../clients/azure-openai";
import { HubSpotClient } from "../clients/hubspot";
import { ControlPlaneStore } from "../control-plane";
import {
  ApolloOrganizationFilter,
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
const DEFAULT_EARLY_STOP_REVIEW_COUNT = 15;
const MIN_EARLY_STOP_REVIEW_COUNT = 5;
const MAX_EARLY_STOP_REVIEW_COUNT = 15;
const DEFAULT_EARLY_STOP_THRESHOLD = 0.5;
const AZURE_WORKER_CONCURRENCY = 4;
const EXPANSION_BATCH_SIZE = 50;
const CREDITLESS_EXPANSION_BATCH_SIZE = 12;
const MAX_FILTER_REVISIONS = 1;
const CONTACT_DISCOVERY_CONCURRENCY = 2;

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

  async run(request: LeadJobRequest, options?: LeadPipelineRunOptions): Promise<LeadJobResult> {
    const emitProgress = (progress: Omit<LeadRunProgress, "updatedAt">) => {
      options?.onProgress?.({
        ...progress,
        updatedAt: new Date().toISOString()
      });
    };

    const dryRun = request.dryRun ?? true;
    const syncToHubSpot = request.syncToHubSpot ?? !dryRun;
    const creditLessMode = request.creditLessMode ?? false;
    const targetCategories = this.getActiveTargetCategories(request.targetCategories);
    const mainContext = request.mainContext ?? request.agentContext;
    const learning = await this.controlPlaneStore.getLearning();
    const earlyStopEnabled = request.earlyStopEnabled ?? true;
    const earlyStopReviewCount = Math.min(
      MAX_EARLY_STOP_REVIEW_COUNT,
      Math.max(MIN_EARLY_STOP_REVIEW_COUNT, request.earlyStopReviewCount ?? DEFAULT_EARLY_STOP_REVIEW_COUNT)
    );
    const earlyStopThreshold = request.earlyStopThreshold ?? DEFAULT_EARLY_STOP_THRESHOLD;
    const prequalification = request.prequalification ?? (request.prequalificationContext ? { mainContext: request.prequalificationContext } : undefined);
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
      for (const filter of categoryFilters) {
        if ((categoryCounts.get(activeCategory) ?? 0) >= categoryTarget) {
          break;
        }

        if (shortlistedCompanies.length >= request.targetLeadCount) {
          break;
        }

        const candidateFilters: ApolloOrganizationFilter[] = [filter];
        let revisionCount = 0;

        while (candidateFilters.length > 0) {
          const activeFilter = candidateFilters.shift() as ApolloOrganizationFilter;
          const reviewedCompanies: PreCategorizedCompany[] = [];
          let useWebSearchForExpansion = creditLessMode;
          let apolloExpansionPage = creditLessMode || dryRun
            ? 1
            : await this.controlPlaneStore.getApolloSearchCursor(activeFilter);
          const probeFetch = await this.fetchAvailableSearchSample(
            activeFilter,
            earlyStopReviewCount,
            dryRun,
            apolloExpansionPage,
            creditLessMode,
            learning,
            reviewedCompanies
          );
          const probeSample = probeFetch.companies;
          apolloExpansionPage = probeFetch.nextPage;
          let categorizedInitialSample = await this.categorizeCompanies(probeSample, dryRun, mainContext, prequalification, targetCategories, learning);
          let initialEvaluation = this.evaluateFilter(
            activeFilter.name,
            categorizedInitialSample,
            activeFilter,
            targetCategories,
            categorizedInitialSample.length,
            false
          );

          if (!creditLessMode) {
            const initialRelevantFromApollo = this.getRelevantCompanies(categorizedInitialSample, activeFilter, targetCategories, request.market);
            if (initialRelevantFromApollo.length === 0 || initialEvaluation.relevanceRatio < earlyStopThreshold) {
              const webFallbackProbe = await this.fetchAvailableSearchSample(
                activeFilter,
                earlyStopReviewCount,
                dryRun,
                1,
                true,
                learning,
                reviewedCompanies
              );
              const webFallbackProbeSample = webFallbackProbe.companies;
              const categorizedWebFallbackProbe = await this.categorizeCompanies(
                webFallbackProbeSample,
                dryRun,
                mainContext,
                prequalification,
                targetCategories,
                learning
              );
              const relevantFromWebFallback = this.getRelevantCompanies(categorizedWebFallbackProbe, activeFilter, targetCategories, request.market);
              const webFallbackEvaluation = this.evaluateFilter(
                activeFilter.name,
                categorizedWebFallbackProbe,
                activeFilter,
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

          searchHistory.push(
            this.buildSearchHistoryEntry(
              activeFilter.name,
              activeCategory,
              "probe_15",
              creditLessMode ? 1 : apolloExpansionPage - 1,
              earlyStopReviewCount,
              categorizedInitialSample,
              activeFilter,
              targetCategories,
              earlyStopThreshold
            )
          );

          const initialRelevant = this.getRelevantCompanies(categorizedInitialSample, activeFilter, targetCategories, request.market);
          const addedFromProbe = this.addUniqueCompanies(shortlistedCompanies, initialRelevant, shortlistedKeys);
          categoryCounts.set(activeCategory, (categoryCounts.get(activeCategory) ?? 0) + addedFromProbe);

          if (earlyStopEnabled && initialEvaluation.relevanceRatio < earlyStopThreshold) {
            const skippedCount = Math.max(0, FULL_SAMPLE_SIZE - categorizedInitialSample.length);
            const stoppedEvaluation: FilterEvaluation = {
              ...initialEvaluation,
              stoppedEarly: true,
              skippedAfterEarlyStop: skippedCount,
              recommendation: `${initialEvaluation.recommendation} Early stop triggered after ${categorizedInitialSample.length} reviews.`
            };

            evaluations.push(stoppedEvaluation);
            filtersStoppedEarly += 1;
            companiesSkippedAfterEarlyStop += skippedCount;
            emitFilterProgress(
              `${activeFilter.name} wurde frueh gestoppt. Bisher ${shortlistedCompanies.length} von ${request.targetLeadCount} Ziel-Firmen gesammelt.`
            );

            if (revisionCount < MAX_FILTER_REVISIONS) {
              const revisedFilter = await this.azureClient.reviseSearchFilter(
                activeFilter,
                stoppedEvaluation,
                dryRun,
                learning,
                request.market,
                request.customGoal,
                mainContext
              );

              if (revisedFilter && this.filterSupportsTargetCategories(revisedFilter, [activeCategory])) {
                candidateFilters.push(revisedFilter);
                revisionCount += 1;
              }
            }

            continue;
          }

          for (let page = 1; page <= 10; page += 1) {
            const remainingCategorySlots = Math.max(0, categoryTarget - (categoryCounts.get(activeCategory) ?? 0));
            const remainingGlobalSlots = Math.max(0, request.targetLeadCount - shortlistedCompanies.length);
            const expansionBatchSize = this.getExpansionBatchSize(
              Math.min(remainingCategorySlots || remainingGlobalSlots, remainingGlobalSlots),
              useWebSearchForExpansion
            );
            const requestedPage = useWebSearchForExpansion ? page : apolloExpansionPage;
            const expandedFetch = await this.fetchAvailableSearchSample(
              activeFilter,
              expansionBatchSize,
              dryRun,
              requestedPage,
              useWebSearchForExpansion,
              learning,
              reviewedCompanies
            );
            const expandedSample = expandedFetch.companies;
            if (!useWebSearchForExpansion) {
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
            const expandedRelevant = this.getRelevantCompanies(categorizedExpandedSample, activeFilter, targetCategories, request.market);
            const addedFromExpansion = this.addUniqueCompanies(shortlistedCompanies, expandedRelevant, shortlistedKeys);
            categoryCounts.set(activeCategory, (categoryCounts.get(activeCategory) ?? 0) + addedFromExpansion);

            const batchEvaluation = this.evaluateFilter(
              activeFilter.name,
              categorizedExpandedSample,
              activeFilter,
              targetCategories,
              earlyStopReviewCount,
              false
            );

            searchHistory.push(
              this.buildSearchHistoryEntry(
                activeFilter.name,
                activeCategory,
                "expand_50",
                requestedPage,
                expansionBatchSize,
                categorizedExpandedSample,
                activeFilter,
                targetCategories,
                earlyStopThreshold
              )
            );

            if (batchEvaluation.relevanceRatio < earlyStopThreshold) {
              break;
            }

            if (expandedSample.length < expansionBatchSize) {
              break;
            }

            if ((categoryCounts.get(activeCategory) ?? 0) >= categoryTarget || shortlistedCompanies.length >= request.targetLeadCount) {
              break;
            }
          }

          evaluations.push(
            this.evaluateFilter(
              activeFilter.name,
              reviewedCompanies,
              activeFilter,
              targetCategories,
              categorizedInitialSample.length,
              false
            )
          );
          emitFilterProgress(
            `${activeFilter.name} abgeschlossen. Aktuell ${shortlistedCompanies.length} von ${request.targetLeadCount} Ziel-Firmen gefunden.`
          );
          break;
        }

        if ((categoryCounts.get(activeCategory) ?? 0) >= categoryTarget || shortlistedCompanies.length >= request.targetLeadCount) {
          break;
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

    const filteredShortlist = await this.excludeExistingHubSpotDomains(toppedUpShortlist, dryRun);
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
    const finalShortlist = await this.excludeExistingHubSpotDomains(replenishedShortlist, dryRun);
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

    const contactCandidatesByCompany = await this.collectApolloContacts(uniqueShortlist, researchBriefs, dryRun, mainContext);

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
        const localCategorization = this.prequalifyLocally(company);
        if (localCategorization) {
          return {
            ...company,
            ...localCategorization
          };
        }

        const categorization = await this.azureClient.categorizeCompany(
          company.name,
          company.shortDescription,
          dryRun,
          mainContext,
          prequalification,
          targetCategories,
          learning
        );

        return {
          ...company,
          ...this.enforceIndustrialFit(company, categorization)
        };
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
      "custom software",
      "project delivery",
      "engineering services",
      "solution provider",
      "implementation"
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

    if (obviouslyIrrelevantSignals.some((signal) => text.includes(signal))) {
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

    if (industrialHits === 0 && nonIndustrialPlatformSignals.some((signal) => text.includes(signal))) {
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
      return stats.averageRelevanceRatio >= 0.55 && earlyStopRate <= 0.4;
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
    dryRun: boolean
  ): Promise<PreCategorizedCompany[]> {
    if (dryRun || companies.length === 0) {
      return companies;
    }

    const domains = companies
      .map((company) => company.domain)
      .filter((domain): domain is string => Boolean(domain));
    if (domains.length === 0) {
      return companies;
    }

    const existingDomains = await this.hubspotClient.getExistingCompanyDomains(domains);
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
    dryRun: boolean
  ): Promise<CompanySample[]> {
    if (dryRun || companies.length === 0) {
      return companies;
    }

    const domains = companies
      .map((company) => company.domain)
      .filter((domain): domain is string => Boolean(domain));
    if (domains.length === 0) {
      return companies;
    }

    const existingDomains = await this.hubspotClient.getExistingCompanyDomains(domains);
    if (existingDomains.size === 0) {
      return companies;
    }

    return companies.filter((company) => {
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
    learning: LeadLearningData,
    reviewedCompanies: Array<Pick<CompanySample, "name" | "domain">>
  ): Promise<{ companies: CompanySample[]; nextPage: number }> {
    const collected: CompanySample[] = [];
    const seenKeys = new Set(reviewedCompanies.map((company) => this.getCompanyKey(company)));
    const maxPages = useWebSearch ? 3 : 6;
    const pageSize = Math.max(MIN_EARLY_STOP_REVIEW_COUNT, requestedCount);
    let nextPage = page;

    for (let attempt = 0; attempt < maxPages && collected.length < requestedCount; attempt += 1) {
      const sample = this.excludeRejectedCompanies(
        await this.apolloClient.fetchOrganizationSample(filter, pageSize, dryRun, nextPage, useWebSearch),
        learning
      );

      if (!useWebSearch && !dryRun) {
        await this.controlPlaneStore.updateApolloSearchCursor(filter, nextPage + 1);
      }

      if (sample.length === 0) {
        break;
      }

      const unseenSample = sample.filter((company) => !seenKeys.has(this.getCompanyKey(company)));
      const availableSample = await this.excludeExistingCompanySamples(unseenSample, dryRun);

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

      nextPage += 1;

      if (sample.length < pageSize) {
        break;
      }
    }

    return {
      companies: collected,
      nextPage
    };
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