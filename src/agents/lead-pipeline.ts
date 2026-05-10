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
    const learning = await this.controlPlaneStore.getLearning();
    const earlyStopEnabled = request.earlyStopEnabled ?? true;
    const earlyStopReviewCount = Math.min(
      MAX_EARLY_STOP_REVIEW_COUNT,
      Math.max(MIN_EARLY_STOP_REVIEW_COUNT, request.earlyStopReviewCount ?? DEFAULT_EARLY_STOP_REVIEW_COUNT)
    );
    const earlyStopThreshold = request.earlyStopThreshold ?? DEFAULT_EARLY_STOP_THRESHOLD;
    const suggestedFilters = this.orderFiltersByLearning(
      await this.getSuggestedFilters(request.market, request.customGoal, request.agentContext, dryRun, learning),
      learning,
      request.market,
      request.customGoal
    );
    const evaluations: FilterEvaluation[] = [];
    const shortlistedCompanies: PreCategorizedCompany[] = [];
    const searchHistory: SearchHistoryEntry[] = [];
    let filtersStoppedEarly = 0;
    let companiesSkippedAfterEarlyStop = 0;

    for (const filter of suggestedFilters) {
      const candidateFilters: ApolloOrganizationFilter[] = [filter];
      let revisionCount = 0;

      while (candidateFilters.length > 0) {
        const activeFilter = candidateFilters.shift() as ApolloOrganizationFilter;
        const reviewedCompanies: PreCategorizedCompany[] = [];
        const probeSample = this.excludeRejectedCompanies(
          await this.apolloClient.fetchOrganizationSample(activeFilter, earlyStopReviewCount, dryRun, 1),
          learning
        );
        const categorizedInitialSample = await this.categorizeCompanies(probeSample, dryRun, request.agentContext, learning);
        reviewedCompanies.push(...categorizedInitialSample);

        const initialEvaluation = this.evaluateFilter(
          activeFilter.name,
          categorizedInitialSample,
          activeFilter,
          categorizedInitialSample.length,
          false
        );

        searchHistory.push(
          this.buildSearchHistoryEntry(
            activeFilter.name,
            "probe_15",
            1,
            earlyStopReviewCount,
            categorizedInitialSample,
            activeFilter,
            earlyStopThreshold
          )
        );

        shortlistedCompanies.push(...this.getRelevantEuropeanCompanies(categorizedInitialSample, activeFilter));

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
              request.agentContext
            );

            if (revisedFilter) {
              candidateFilters.push(revisedFilter);
              revisionCount += 1;
            }
          }

          if (this.getUniqueCompanyCount(shortlistedCompanies) >= request.targetLeadCount) {
            break;
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
            request.agentContext,
            learning
          );
          reviewedCompanies.push(...categorizedExpandedSample);
          shortlistedCompanies.push(...this.getRelevantEuropeanCompanies(categorizedExpandedSample, activeFilter));

          const batchEvaluation = this.evaluateFilter(
            activeFilter.name,
            categorizedExpandedSample,
            activeFilter,
            earlyStopReviewCount,
            false
          );

          searchHistory.push(
            this.buildSearchHistoryEntry(
              activeFilter.name,
              "expand_50",
              page,
              EXPANSION_BATCH_SIZE,
              categorizedExpandedSample,
              activeFilter,
              earlyStopThreshold
            )
          );

          if (batchEvaluation.relevanceRatio < earlyStopThreshold) {
            break;
          }

          if (expandedSample.length < EXPANSION_BATCH_SIZE || this.getUniqueCompanyCount(shortlistedCompanies) >= request.targetLeadCount) {
            break;
          }
        }

        evaluations.push(
          this.evaluateFilter(
            activeFilter.name,
            reviewedCompanies,
            activeFilter,
            categorizedInitialSample.length,
            false
          )
        );
        break;
      }

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
    dryRun: boolean,
    learning?: LeadLearningData
  ) {
    return this.azureClient.generateSuggestedFilters(
      market,
      customGoal,
      agentContext,
      buildSuggestedFilters(market, customGoal),
      dryRun,
      learning
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
          agentContext,
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

    if (company.sourceFilter.includes("Industrial Camera Partners")) {
      return categorization;
    }

    if (
      (categorization.category === "software_integrator" || categorization.category === "ai_software_integrator") &&
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

    if (normalizedName.includes("software integrators")) {
      bias += 0.45;
    }

    if (normalizedName.includes("ai delivery integrators")) {
      bias += 0.05;
    }

    if (normalizedName.includes("industrial customers")) {
      bias += 0.35;
    }

    if (normalizedName.includes("machine builders")) {
      bias += 0.25;
    }

    if (normalizedName.includes("camera partners")) {
      bias -= 0.15;
    }

    if ((market ?? "").toLowerCase() === "de" && normalizedName.includes("europe")) {
      bias -= 0.05;
    }

    if (/(software integrator|industrial|quality control|qc|process automation)/.test(normalizedGoal) && normalizedName.includes("camera partners")) {
      bias -= 0.1;
    }

    return bias;
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