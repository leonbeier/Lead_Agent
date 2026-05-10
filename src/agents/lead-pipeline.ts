import { buildSuggestedFilters } from "../filters";
import { ApolloClient } from "../clients/apollo";
import { AzureOpenAIClient } from "../clients/azure-openai";
import { HubSpotClient } from "../clients/hubspot";
import { ControlPlaneStore } from "../control-plane";
import {
  CompanySample,
  FilterEvaluation,
  GeneratedLeadRecord,
  LeadCategory,
  LeadLearningData,
  LeadJobRequest,
  LeadJobResult,
  PreCategorizedCompany,
  SearchHistoryEntry
} from "../types";

const RELEVANT_CATEGORIES: LeadCategory[] = [
  "software_integrator",
  "ai_software_integrator",
  "machine_builder_with_vision_ai_need",
  "industrial_camera_vendor_without_ai_software"
];

const FULL_SAMPLE_SIZE = 50;
const DEFAULT_EARLY_STOP_REVIEW_COUNT = 15;
const MIN_EARLY_STOP_REVIEW_COUNT = 5;
const MAX_EARLY_STOP_REVIEW_COUNT = 15;
const DEFAULT_EARLY_STOP_THRESHOLD = 0.5;
const AZURE_WORKER_CONCURRENCY = 4;
const EXPANSION_BATCH_SIZE = 50;

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
    const learning = await this.controlPlaneStore.getLearning();
    const earlyStopEnabled = request.earlyStopEnabled ?? true;
    const earlyStopReviewCount = Math.min(
      MAX_EARLY_STOP_REVIEW_COUNT,
      Math.max(MIN_EARLY_STOP_REVIEW_COUNT, request.earlyStopReviewCount ?? DEFAULT_EARLY_STOP_REVIEW_COUNT)
    );
    const earlyStopThreshold = request.earlyStopThreshold ?? DEFAULT_EARLY_STOP_THRESHOLD;
    const suggestedFilters = this.orderFiltersByLearning(
      await this.getSuggestedFilters(request.market, request.customGoal, request.agentContext, dryRun),
      learning
    );
    const evaluations: FilterEvaluation[] = [];
    const shortlistedCompanies: PreCategorizedCompany[] = [];
    const searchHistory: SearchHistoryEntry[] = [];
    let filtersStoppedEarly = 0;
    let companiesSkippedAfterEarlyStop = 0;

    for (const filter of suggestedFilters) {
      const reviewedCompanies: PreCategorizedCompany[] = [];
      const probeSample = this.excludeRejectedCompanies(
        await this.apolloClient.fetchOrganizationSample(filter, earlyStopReviewCount, dryRun, 1),
        learning
      );
      const categorizedInitialSample = await this.categorizeCompanies(probeSample, dryRun, request.agentContext, learning);
      reviewedCompanies.push(...categorizedInitialSample);
      const initialEvaluation = this.evaluateFilter(
        filter.name,
        categorizedInitialSample,
        filter,
        categorizedInitialSample.length,
        false
      );
      searchHistory.push(
        this.buildSearchHistoryEntry(
          filter.name,
          "probe_15",
          1,
          earlyStopReviewCount,
          categorizedInitialSample,
          filter,
          earlyStopThreshold
        )
      );

      shortlistedCompanies.push(...this.getRelevantEuropeanCompanies(categorizedInitialSample, filter));

      if (earlyStopEnabled && initialEvaluation.relevanceRatio < earlyStopThreshold) {
        const skippedCount = Math.max(0, FULL_SAMPLE_SIZE - categorizedInitialSample.length);
        evaluations.push({
          ...initialEvaluation,
          stoppedEarly: true,
          skippedAfterEarlyStop: skippedCount,
          recommendation: `${initialEvaluation.recommendation} Early stop triggered after ${categorizedInitialSample.length} reviews.`
        });
        filtersStoppedEarly += 1;
        companiesSkippedAfterEarlyStop += skippedCount;

        if (this.getUniqueCompanyCount(shortlistedCompanies) >= request.targetLeadCount) {
          break;
        }

        continue;
      }

      for (let page = 1; page <= 10; page += 1) {
        const expandedSample = this.excludeRejectedCompanies(
          await this.apolloClient.fetchOrganizationSample(filter, EXPANSION_BATCH_SIZE, dryRun, page),
          learning
        );

        if (expandedSample.length === 0) {
          break;
        }

        const categorizedExpandedSample = await this.categorizeCompanies(expandedSample, dryRun, request.agentContext, learning);
        reviewedCompanies.push(...categorizedExpandedSample);
        shortlistedCompanies.push(...this.getRelevantEuropeanCompanies(categorizedExpandedSample, filter));

        const batchEvaluation = this.evaluateFilter(
          filter.name,
          categorizedExpandedSample,
          filter,
          earlyStopReviewCount,
          false
        );

        searchHistory.push(
          this.buildSearchHistoryEntry(
            filter.name,
            "expand_50",
            page,
            EXPANSION_BATCH_SIZE,
            categorizedExpandedSample,
            filter,
            earlyStopThreshold
          )
        );

        if (page > 1 && batchEvaluation.relevanceRatio < earlyStopThreshold) {
          break;
        }

        if (expandedSample.length < EXPANSION_BATCH_SIZE || this.getUniqueCompanyCount(shortlistedCompanies) >= request.targetLeadCount) {
          break;
        }
      }

      const evaluation = this.evaluateFilter(
        filter.name,
        reviewedCompanies,
        filter,
        categorizedInitialSample.length,
        false
      );
      evaluations.push(evaluation);

      if (this.getUniqueCompanyCount(shortlistedCompanies) >= request.targetLeadCount) {
        break;
      }
    }

    const uniqueShortlist = shortlistedCompanies
      .sort((left, right) => right.relevanceScore - left.relevanceScore)
      .filter((company, index, all) => this.findFirstMatchingCompanyIndex(all, company) === index)
      .slice(0, request.targetLeadCount);

    const researchBriefs = request.runDeepResearch === false
      ? []
      : await this.mapWithConcurrency(
          uniqueShortlist.map((company) =>
            () => this.azureClient.buildResearchBrief(company, dryRun, request.agentContext, learning)
          ),
          AZURE_WORKER_CONCURRENCY
        );

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
      contacts: uniqueShortlist.map((company) => this.buildGeneratedLeadRecord(company, researchBriefs)),
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
        syncedCount: hubspotSync.syncedCount
      },
      efficiency: {
        filtersStoppedEarly,
        companiesSkippedAfterEarlyStop
      }
    };
  }

  async preview(request: LeadJobRequest): Promise<Pick<LeadJobResult, "requested" | "suggestedFilters">> {
    return {
      requested: request,
      suggestedFilters: await this.getSuggestedFilters(
        request.market,
        request.customGoal,
        request.agentContext,
        request.dryRun ?? true
      )
    };
  }

  private async getSuggestedFilters(
    market: string | undefined,
    customGoal: string | undefined,
    agentContext: string | undefined,
    dryRun: boolean
  ) {
    return this.azureClient.generateSuggestedFilters(
      market,
      customGoal,
      agentContext,
      buildSuggestedFilters(market, customGoal),
      dryRun
    );
  }

  private async categorizeCompanies(
    companies: CompanySample[],
    dryRun: boolean,
    agentContext?: string,
    learning?: LeadLearningData
  ): Promise<PreCategorizedCompany[]> {
    return this.mapWithConcurrency(
      companies.map((company) => async () => {
        const categorization = await this.azureClient.categorizeCompany(
          company.name,
          company.shortDescription,
          dryRun,
          agentContext,
          learning
        );

        return {
          ...company,
          ...categorization
        };
      }),
      AZURE_WORKER_CONCURRENCY
    );
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
    learning: LeadLearningData
  ): import("../types").ApolloOrganizationFilter[] {
    return [...filters].sort((left, right) => this.getFilterRank(right.name, learning) - this.getFilterRank(left.name, learning));
  }

  private getFilterRank(filterName: string, learning: LeadLearningData): number {
    const stats = learning.filterPerformance[filterName];
    if (!stats) {
      return 0;
    }

    const earlyStopPenalty = stats.runs === 0 ? 0 : stats.earlyStopCount / stats.runs;
    return stats.averageRelevanceRatio - earlyStopPenalty;
  }

  private getRelevantEuropeanCompanies(
    companies: PreCategorizedCompany[],
    filter: import("../types").ApolloOrganizationFilter
  ): PreCategorizedCompany[] {
    return companies.filter(
      (company) => RELEVANT_CATEGORIES.includes(company.category) && this.isEuropeanCompany(company, filter)
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
    batchType: "probe_15" | "expand_50",
    page: number,
    requestedCount: number,
    companies: PreCategorizedCompany[],
    filter: import("../types").ApolloOrganizationFilter,
    threshold: number
  ): SearchHistoryEntry {
    const relevantCount = this.getRelevantEuropeanCompanies(companies, filter).length;
    const relevanceRatio = companies.length === 0 ? 0 : relevantCount / companies.length;

    return {
      timestamp: new Date().toISOString(),
      filterName,
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

  private getUniqueCompanyCount(companies: PreCategorizedCompany[]): number {
    return companies.filter((company, index, all) => this.findFirstMatchingCompanyIndex(all, company) === index).length;
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
    researchBriefs: import("../types").ResearchBrief[]
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
      overview: researchBrief?.overview,
      qualificationSummary: researchBrief?.qualificationSummary,
      linkedInMessage: researchBrief?.linkedInMessage,
      emailSubject: researchBrief?.emailSubject,
      emailBody: researchBrief?.emailBody,
      phoneScript: researchBrief?.phoneScript,
      riskFlags: researchBrief?.riskFlags
    };
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
    initialReviewCount: number,
    stoppedEarly: boolean
  ): FilterEvaluation {
    const categoryBreakdown = companies.reduce<Record<LeadCategory, number>>(
      (accumulator, company) => {
        accumulator[company.category] += 1;
        return accumulator;
      },
      {
        software_integrator: 0,
        ai_software_integrator: 0,
        machine_builder_with_vision_ai_need: 0,
        industrial_camera_vendor_without_ai_software: 0,
        irrelevant: 0,
        other: 0
      }
    );

    const relevantCount = this.getRelevantEuropeanCompanies(companies, filter).length;
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
}