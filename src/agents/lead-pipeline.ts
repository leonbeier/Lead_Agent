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
  PreCategorizedCompany,
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
const MAX_FILTER_REVISIONS = 1;
const CONTACT_DISCOVERY_CONCURRENCY = 2;

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

  async run(request: LeadJobRequest): Promise<LeadJobResult> {
    const dryRun = request.dryRun ?? true;
    const syncToHubSpot = request.syncToHubSpot ?? !dryRun;
    const targetCategories = this.getActiveTargetCategories(request.targetCategories);
    const mainContext = request.mainContext ?? request.agentContext;
    const learning = await this.controlPlaneStore.getLearning();
    const earlyStopEnabled = request.earlyStopEnabled ?? true;
    const earlyStopReviewCount = Math.min(
      MAX_EARLY_STOP_REVIEW_COUNT,
      Math.max(MIN_EARLY_STOP_REVIEW_COUNT, request.earlyStopReviewCount ?? DEFAULT_EARLY_STOP_REVIEW_COUNT)
    );
    const earlyStopThreshold = request.earlyStopThreshold ?? DEFAULT_EARLY_STOP_THRESHOLD;
    const prequalificationContext = request.prequalificationContext;
    const suggestedFilters = this.orderFiltersByLearning(
      await this.getSuggestedFilters(request.market, request.customGoal, mainContext, targetCategories, dryRun, learning),
      learning,
      request.market,
      request.customGoal
    );
    const evaluations: FilterEvaluation[] = [];
    const shortlistedCompanies: PreCategorizedCompany[] = [];
    const shortlistedKeys = new Set<string>();
    const searchHistory: SearchHistoryEntry[] = [];
    const categoryQuotas = this.buildCategoryQuotas(request.targetLeadCount, targetCategories);
    const categoryCounts = new Map<LeadCategory, number>(targetCategories.map((category) => [category, 0]));
    let filtersStoppedEarly = 0;
    let companiesSkippedAfterEarlyStop = 0;

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
          const probeSample = this.excludeRejectedCompanies(
            await this.apolloClient.fetchOrganizationSample(activeFilter, earlyStopReviewCount, dryRun, 1),
            learning
          );
          const categorizedInitialSample = await this.categorizeCompanies(probeSample, dryRun, mainContext, prequalificationContext, targetCategories, learning);
          reviewedCompanies.push(...categorizedInitialSample);

          const initialEvaluation = this.evaluateFilter(
            activeFilter.name,
            categorizedInitialSample,
            activeFilter,
            targetCategories,
            categorizedInitialSample.length,
            false
          );

          searchHistory.push(
            this.buildSearchHistoryEntry(
              activeFilter.name,
              activeCategory,
              "probe_15",
              1,
              earlyStopReviewCount,
              categorizedInitialSample,
              activeFilter,
              targetCategories,
              earlyStopThreshold
            )
          );

          const initialRelevant = this.getRelevantEuropeanCompanies(categorizedInitialSample, activeFilter, targetCategories);
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
            const expandedSample = this.excludeRejectedCompanies(
              await this.apolloClient.fetchOrganizationSample(activeFilter, EXPANSION_BATCH_SIZE, dryRun, page),
              learning
            );

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
              prequalificationContext,
              targetCategories,
              learning
            );
            reviewedCompanies.push(...categorizedExpandedSample);
            const expandedRelevant = this.getRelevantEuropeanCompanies(categorizedExpandedSample, activeFilter, targetCategories);
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
                page,
                EXPANSION_BATCH_SIZE,
                categorizedExpandedSample,
                activeFilter,
                targetCategories,
                earlyStopThreshold
              )
            );

            if (batchEvaluation.relevanceRatio < earlyStopThreshold) {
              break;
            }

            if (expandedSample.length < EXPANSION_BATCH_SIZE) {
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

    const filteredShortlist = await this.excludeExistingHubSpotDomains(sortedShortlist, dryRun);
    const uniqueShortlist = filteredShortlist.slice(0, request.targetLeadCount);

    const researchBriefs = request.runDeepResearch === false
      ? []
      : await this.mapWithConcurrency(
          uniqueShortlist.map((company) =>
            () => this.azureClient.buildResearchBrief(company, dryRun, mainContext, learning)
          ),
          AZURE_WORKER_CONCURRENCY
        );

    const publicContactsByCompany = await this.collectPublicContacts(uniqueShortlist, dryRun);

    const hubspotSync = await this.hubspotClient.syncQualifiedCompanies(uniqueShortlist, researchBriefs, !syncToHubSpot);
    await this.controlPlaneStore.recordFilterEvaluations(evaluations);
    await this.controlPlaneStore.recordSearchHistory(searchHistory);
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
          publicContactsByCompany.get(this.getCompanyKey(company)) ?? []
        )
      ),
      searchHistory
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
        targetCategories,
        request.dryRun ?? true
      )
    };
  }

  private async getSuggestedFilters(
    market: string | undefined,
    customGoal: string | undefined,
    mainContext: string | undefined,
    targetCategories: LeadCategory[],
    dryRun: boolean,
    learning?: LeadLearningData
  ) {
    const filters = await this.azureClient.generateSuggestedFilters(
      market,
      customGoal,
      mainContext,
      targetCategories,
      buildSuggestedFilters(market, customGoal),
      dryRun,
      learning
    );

    return filters.filter((filter) => this.filterSupportsTargetCategories(filter, targetCategories));
  }

  private async categorizeCompanies(
    companies: CompanySample[],
    dryRun: boolean,
    mainContext?: string,
    prequalificationContext?: string,
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
          prequalificationContext,
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

    const industrialHits = industrialSignals.filter((signal) => text.includes(signal)).length;

    if (normalizedCountry && !EUROPEAN_COUNTRIES.has(normalizedCountry)) {
      return {
        category: "irrelevant",
        relevanceScore: 5,
        rationale: "Company is outside the European target geography for this campaign."
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

    if (clearlyBadSignals.some((signal) => text.includes(signal))) {
      return {
        category: "irrelevant",
        relevanceScore: 8,
        rationale: "Company profile signals a non-industrial service or platform segment outside ONE WARE's ICP."
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

  private getRelevantEuropeanCompanies(
    companies: PreCategorizedCompany[],
    filter: import("../types").ApolloOrganizationFilter,
    targetCategories: LeadCategory[]
  ): PreCategorizedCompany[] {
    return companies.filter(
      (company) => targetCategories.includes(company.category) && this.isEuropeanCompany(company, filter)
    );
  }

  private isEuropeanCompany(
    company: Pick<PreCategorizedCompany, "country" | "domain">,
    filter: import("../types").ApolloOrganizationFilter
  ): boolean {
    const normalizedCountry = company.country?.trim().toLowerCase();
    if (normalizedCountry && EUROPEAN_COUNTRIES.has(normalizedCountry)) {
      return true;
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
    const relevantCount = this.getRelevantEuropeanCompanies(companies, filter, targetCategories).length;
    const relevanceRatio = companies.length === 0 ? 0 : relevantCount / companies.length;

    return {
      timestamp: new Date().toISOString(),
      filterName,
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

    const relevantCount = this.getRelevantEuropeanCompanies(companies, filter, targetCategories).length;
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