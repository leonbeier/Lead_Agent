import { env, readiness } from "../config";
import { LeadPipelineAgent } from "../agents/lead-pipeline";
import { AzureOpenAIClient } from "../clients/azure-openai";
import { DiffbotSearchClient } from "../clients/diffbot-search";
import { ExaSearchClient } from "../clients/exa-search";
import { HubSpotClient } from "../clients/hubspot";
import { WebSearchAgent } from "../clients/web-search-agent";
import { ControlPlaneStore } from "../control-plane";
import { ApolloOrganizationFilter, CompanySample, ExaQueryHistoryInsight, LeadCategory, PreCategorizedCompany, ResearchBrief, SelectableLeadCategory } from "../types";
import { buildDebugSearchFilter, DebugConsoleSearchMode, normalizeManualWebsites } from "./test-console";

export type DebugConsoleStage = "company_search" | "ai_prefilter" | "outreach_prep" | "contact_discovery";

export interface DebugConsoleRunRequest {
  stage: DebugConsoleStage;
  targetCategory: SelectableLeadCategory;
  targetCategories: SelectableLeadCategory[];
  targetCategoryRefinement?: string;
  region?: string;
  companySearchMode: DebugConsoleSearchMode;
  exaQueryCount?: number;
  limit: number;
  useExaExcludeDomains?: boolean;
  useExaCompanyCategory?: boolean;
  useAzureQueryPlanner?: boolean;
  aiPrefilterConcurrency?: number;
  outreachPrepConcurrency?: number;
  contactSearchConcurrency?: number;
  websites?: string[];
  exaApiKey?: string;
  diffbotToken?: string;
}

export interface DebugConsoleRunResult {
  stage: DebugConsoleStage;
  requested: DebugConsoleRunRequest;
  filter: ApolloOrganizationFilter;
  companySearch: DebugConsoleCompanySearchResult | null;
  aiPrefilter: DebugConsoleAiPrefilterResult | null;
  outreachPrep: DebugConsoleOutreachPrepResult | null;
  contactDiscovery: DebugConsoleContactDiscoveryResult | null;
}

export interface DebugConsoleSearchQueryResult {
  query: string;
  queryGeneration: {
    source: "azure_planner" | "baseline_default_queries";
    defaultQueries: string[];
    plannedQueries: string[];
    promptMessages?: Array<{
      role: string;
      content: string;
    }>;
  };
  exaRequestPayload?: unknown;
  rawResults: Array<{
    title?: string;
    url?: string;
    highlights?: string[];
    summary?: string;
    text?: string;
  }>;
  acceptedCompanies: CompanySample[];
  rejectedResults: Array<{
    title?: string;
    url?: string;
    reason: string;
  }>;
}

export interface DebugConsoleCompanySearchResult {
  backend: DebugConsoleSearchMode;
  usedFilters: ApolloOrganizationFilter[];
  generatedSearches: DebugConsoleSearchQueryResult[];
  discoveredCompanies: CompanySample[];
}

export interface DebugConsoleAzureEvaluation {
  rawInput: string;
  promptMessages: Array<{
    role: string;
    content: string;
  }>;
  compactRetryUsed: boolean;
  category: string;
  relevanceScore: number;
  rationale: string;
}

export interface DebugConsoleWebsiteAnalysis {
  company: CompanySample;
  websiteParser: {
    summary?: string;
    landingUrl?: string;
    relevantUrls?: string[];
  } | null;
  azureEvaluation: DebugConsoleAzureEvaluation;
  categorizedCompany: PreCategorizedCompany;
  error?: string;
}

export interface DebugConsoleAiPrefilterResult {
  analyzedWebsites: DebugConsoleWebsiteAnalysis[];
}

export interface DebugConsoleOutreachAnalysis extends DebugConsoleWebsiteAnalysis {
  researchBrief: {
    qualificationSummary: string;
    emailSubject: string;
    emailBody: string;
    linkedInConnectionRequest?: string;
    linkedInMessage: string;
    phoneScript: string;
    targetIndustry: string;
    productsOffered: string;
    rankings: {
      customer: number;
      serviceProvider: number;
      partner: number;
    };
    businessPotentialEUR: number;
  } | null;
  hubspotPreview: Awaited<ReturnType<HubSpotClient["previewHubSpotSync"]>> | null;
}

export interface DebugConsoleOutreachPrepResult {
  analyzedWebsites: DebugConsoleOutreachAnalysis[];
}

export interface DebugConsoleContactAnalysis extends DebugConsoleOutreachAnalysis {
  publicContactDebug: Awaited<ReturnType<HubSpotClient["debugPublicContactDiscovery"]>> | null;
}

export interface DebugConsoleContactDiscoveryResult {
  analyzedWebsites: DebugConsoleContactAnalysis[];
}

const DEBUG_CONTACT_DISCOVERY_TIMEOUT_MS = 150_000;

const DEBUG_CONTACT_DISCOVERY_SELECTION_TIMEOUT_MS = 90_000;

export class DebugConsoleService {
  private readonly exaSearchClient = new ExaSearchClient();

  private readonly diffbotSearchClient = new DiffbotSearchClient();

  private readonly webSearchAgent = new WebSearchAgent();

  private readonly azureOpenAIClient = new AzureOpenAIClient();

  private readonly hubspotClient = new HubSpotClient();

  private readonly leadPipelineAgent = new LeadPipelineAgent();

  private readonly controlPlaneStore = new ControlPlaneStore();

  private readonly defaultAiPrefilterConcurrency = 20;

  private readonly defaultOutreachPrepConcurrency = 6;

  private readonly defaultContactSearchConcurrency = 8;

  createManualCompanyForWebsite(website: string, filter: ApolloOrganizationFilter): CompanySample {
    return this.buildManualCompany(website, filter);
  }

  async classifyCompanyForExecution(
    company: CompanySample,
    options: { annotateDebugStage?: boolean } = {}
  ): Promise<DebugConsoleWebsiteAnalysis> {
    return this.classifyWebsite(company, options);
  }

  async buildResearchBriefForExecution(company: PreCategorizedCompany): Promise<ResearchBrief> {
    return this.azureOpenAIClient.buildResearchBrief(company, false, undefined, undefined, {
      includeWebResearch: true
    });
  }

  async discoverContactsForExecution(
    company: PreCategorizedCompany,
    options: { selectedContactsTimeoutMs?: number } = {}
  ): Promise<{ selectedContacts: Awaited<ReturnType<HubSpotClient["discoverPublicContactsForExecution"]>> }> {
    const selectedContacts = await this.hubspotClient.discoverPublicContactsForExecution(company, options);
    return { selectedContacts };
  }

  async run(request: DebugConsoleRunRequest): Promise<DebugConsoleRunResult> {
    const filters = await this.resolveSearchFilters(request);
    const filter = filters[0] ?? buildDebugSearchFilter(request.targetCategory, request.region);

    if (request.companySearchMode === "diffbot_search") {
      this.diffbotSearchClient.setToken(request.diffbotToken);
    } else {
      this.exaSearchClient.setApiKey(request.exaApiKey);
      this.exaSearchClient.setSearchPayloadOptions({
        includeExcludeDomains: request.useExaExcludeDomains ?? true,
        includeCompanyCategoryFilter: request.useExaCompanyCategory ?? false
      });
    }

    const companySearch = request.stage === "company_search"
      ? await this.runCompanySearchStage(request, filters.length > 0 ? filters : [filter])
      : null;
    const aiPrefilter = request.stage === "ai_prefilter"
      ? await this.runAiPrefilterStage(request, filter)
      : null;
    const outreachPrep = request.stage === "outreach_prep"
      ? await this.runOutreachPrepStage(request, filter)
      : null;
    const contactDiscovery = request.stage === "contact_discovery"
      ? await this.runContactDiscoveryStage(request, filter)
      : null;

    return {
      stage: request.stage,
      requested: request,
      filter,
      companySearch,
      aiPrefilter,
      outreachPrep,
      contactDiscovery
    };
  }

  private async runCompanySearchStage(
    request: DebugConsoleRunRequest,
    filters: ApolloOrganizationFilter[]
  ): Promise<DebugConsoleCompanySearchResult> {
    if (request.companySearchMode === "diffbot_search") {
      return this.runDiffbotCompanySearch(filters, request.limit);
    }

    return this.runExaCompanySearch(request, filters, request.limit);
  }

  private async runAiPrefilterStage(
    request: DebugConsoleRunRequest,
    filter: ApolloOrganizationFilter
  ): Promise<DebugConsoleAiPrefilterResult> {
    const companies = this.buildWebsiteCompanies(request, filter);
    const aiPrefilterConcurrency = Math.max(1, request.aiPrefilterConcurrency ?? this.defaultAiPrefilterConcurrency);
    const analyzedWebsites = await this.mapWithConcurrency(
      companies.map((company) => async () => this.classifyWebsite(company)),
      aiPrefilterConcurrency
    );

    await this.persistScreeningResults(analyzedWebsites);

    return {
      analyzedWebsites
    };
  }

  private async runOutreachPrepStage(
    request: DebugConsoleRunRequest,
    filter: ApolloOrganizationFilter
  ): Promise<DebugConsoleOutreachPrepResult> {
    const companies = this.buildWebsiteCompanies(request, filter);
    const analyzedWebsites = await this.mapWithConcurrency(
      companies.map((company) => async () => this.buildOutreachAnalysis(company)),
      request.outreachPrepConcurrency ?? this.defaultOutreachPrepConcurrency
    );

    return {
      analyzedWebsites
    };
  }

  private async runContactDiscoveryStage(
    request: DebugConsoleRunRequest,
    filter: ApolloOrganizationFilter
  ): Promise<DebugConsoleContactDiscoveryResult> {
    const companies = this.buildWebsiteCompanies(request, filter);
    const analyzedWebsites = await this.mapWithConcurrency(
      companies.map((company) => async () => this.buildContactAnalysis(company)),
      request.contactSearchConcurrency ?? this.defaultContactSearchConcurrency
    );

    return {
      analyzedWebsites
    };
  }

  private async classifyWebsite(
    company: CompanySample,
    options: { annotateDebugStage?: boolean } = {}
  ): Promise<DebugConsoleWebsiteAnalysis> {
    try {
      const websiteProfile = await this.webSearchAgent.crawlCompanyWebsite(company.domain, "open_crawler_search");
      const azureEvaluation = await this.debugCategorizeWebsite(company, websiteProfile?.summary ?? company.shortDescription);
      const sourceFilter = options.annotateDebugStage === false
        ? company.sourceFilter
        : `${company.sourceFilter} | debug-stage=ai_prefilter`;
      const categorizedCompany: PreCategorizedCompany = {
        ...company,
        category: azureEvaluation.category as LeadCategory,
        relevanceScore: azureEvaluation.relevanceScore,
        rationale: azureEvaluation.rationale,
        sourceFilter
      };

      return {
        company,
        websiteParser: websiteProfile
          ? {
              summary: websiteProfile.summary,
              landingUrl: websiteProfile.landingUrl,
              relevantUrls: websiteProfile.relevantUrls
            }
          : null,
        azureEvaluation,
        categorizedCompany
      };
    } catch (error) {
      return {
        company,
        websiteParser: null,
        azureEvaluation: {
          rawInput: company.shortDescription,
          promptMessages: [],
          compactRetryUsed: false,
          category: "other",
          relevanceScore: 0,
          rationale: "Debug analysis failed."
        },
        categorizedCompany: {
          ...company,
          category: "other",
          relevanceScore: 0,
          rationale: "Debug analysis failed."
        },
        error: error instanceof Error ? error.message : "Unknown debug analysis error."
      };
    }
  }

  private async persistScreeningResults(analyses: DebugConsoleWebsiteAnalysis[]): Promise<void> {
    const database = await this.controlPlaneStore.getCompanyScreeningDatabase();

    for (const analysis of analyses) {
      const normalizedDomain = analysis.company.domain?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
      const normalizedName = analysis.company.name.trim().toLowerCase();
      const existingIndex = database.records.findIndex((record) => {
        if (normalizedDomain && record.normalizedDomain === normalizedDomain) {
          return true;
        }

        return record.normalizedName === normalizedName;
      });

      const nextRecord = {
        ...(existingIndex >= 0 ? database.records[existingIndex] : {}),
        companyName: analysis.company.name,
        normalizedName,
        domain: analysis.company.domain,
        normalizedDomain,
        category: analysis.categorizedCompany.category,
        relevanceScore: analysis.categorizedCompany.relevanceScore,
        rationale: analysis.categorizedCompany.rationale,
        sourceFilter: analysis.company.sourceFilter,
        shortDescription: analysis.company.shortDescription,
        checkedAt: new Date().toISOString()
      };

      if (existingIndex >= 0) {
        database.records[existingIndex] = nextRecord;
      } else {
        database.records.unshift(nextRecord);
      }
    }

    await this.controlPlaneStore.writeCompanyScreeningDatabase(database);
  }

  private async buildOutreachAnalysis(company: CompanySample): Promise<DebugConsoleOutreachAnalysis> {
    const baseAnalysis = await this.classifyWebsite(company);

    if (baseAnalysis.error) {
      return {
        ...baseAnalysis,
        researchBrief: null,
        hubspotPreview: null
      };
    }

    const [researchBrief, extractedAddress] = await Promise.all([
      this.azureOpenAIClient.buildResearchBrief(baseAnalysis.categorizedCompany, false, undefined, undefined, {
        includeWebResearch: true
      }),
      this.hubspotClient.resolveCompanyAddress(baseAnalysis.categorizedCompany)
    ]);
    const hubspotPreview = await this.hubspotClient.previewHubSpotSync(baseAnalysis.categorizedCompany, researchBrief, [], {
      includeAddressLookup: true,
      extractedAddress
    });

    return {
      ...baseAnalysis,
      researchBrief: this.toResearchBriefPreview(researchBrief),
      hubspotPreview
    };
  }

  private async buildContactAnalysis(company: CompanySample): Promise<DebugConsoleContactAnalysis> {
    const baseAnalysis = await this.classifyWebsite(company);

    if (baseAnalysis.error) {
      return {
        ...baseAnalysis,
        researchBrief: null,
        hubspotPreview: null,
        publicContactDebug: null
      };
    }

    try {
      const [researchBrief, publicContactDebug, extractedAddress] = await this.withTimeout(
        Promise.all([
          this.azureOpenAIClient.buildResearchBrief(baseAnalysis.categorizedCompany, false, undefined, undefined, {
            includeWebResearch: true
          }),
          this.buildDetailedContactDebug(baseAnalysis.categorizedCompany, {
            selectedContactsTimeoutMs: DEBUG_CONTACT_DISCOVERY_SELECTION_TIMEOUT_MS
          }),
          this.hubspotClient.resolveCompanyAddress(baseAnalysis.categorizedCompany)
        ]),
        DEBUG_CONTACT_DISCOVERY_TIMEOUT_MS,
        `Kontakt-Check hat nach ${Math.round(DEBUG_CONTACT_DISCOVERY_TIMEOUT_MS / 1000)}s das Zeitlimit erreicht.`
      );

      const hubspotPreview = await this.hubspotClient.previewHubSpotSync(
        baseAnalysis.categorizedCompany,
        researchBrief,
        publicContactDebug.selectedContacts,
        {
          includeAddressLookup: true,
          extractedAddress
        }
      );

      return {
        ...baseAnalysis,
        researchBrief: this.toResearchBriefPreview(researchBrief),
        publicContactDebug,
        hubspotPreview
      };
    } catch (error) {
      return {
        ...baseAnalysis,
        researchBrief: null,
        hubspotPreview: null,
        publicContactDebug: null,
        error: error instanceof Error ? error.message : "Kontakt-Check ist fehlgeschlagen."
      };
    }
  }

  private buildManualCompany(website: string, filter: ApolloOrganizationFilter): CompanySample {
    const hostname = new URL(website).hostname.replace(/^www\./i, "");
    const label = hostname.split(".")[0] ?? hostname;

    return {
      name: label
        .split(/[-_]+/)
        .filter(Boolean)
        .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join(" ") || hostname,
      domain: website,
      country: filter.locations[0],
      shortDescription: "Manual debug website input.",
      sourceFilter: `${filter.name} (manual-debug-input)`
    };
  }

  private buildWebsiteCompanies(request: DebugConsoleRunRequest, filter: ApolloOrganizationFilter): CompanySample[] {
    return normalizeManualWebsites(request.websites)
      .map((website) => this.buildManualCompany(website, filter))
      .slice(0, request.limit);
  }

  private async runExaCompanySearch(request: DebugConsoleRunRequest, filters: ApolloOrganizationFilter[], limit: number): Promise<DebugConsoleCompanySearchResult> {
    const exaClient = this.exaSearchClient as unknown as {
      buildQueries: (filter: ApolloOrganizationFilter, page: number, options?: { targetCategoryRefinement?: string }) => string[];
      runSearch: (apiKey: string, query: string, numResults: number, excludeDomains?: string[]) => Promise<{ results?: Array<{ title?: string; url?: string; highlights?: string[]; summary?: string; text?: string }> }>;
      buildSearchPayload: (query: string, numResults: number, excludeDomains?: string[]) => unknown;
      loadKnownExcludedDomains: () => Promise<Set<string>>;
      toExcludeDomain: (value: string | undefined) => string | undefined;
      normalizeUrl: (url: string | undefined) => string | undefined;
      toCanonicalCompanyDomain: (url: string) => string;
      deriveCompanyName: (domain: string, title?: string) => string;
      inferCountryFromDomain: (domain: string, result: { title?: string; highlights?: string[]; summary?: string; text?: string }, fallbackLocation?: string) => string | undefined;
      buildDescription: (result: { title?: string; highlights?: string[]; summary?: string; text?: string }, filter: ApolloOrganizationFilter) => string;
    };
    const apiKey = (this.exaSearchClient as unknown as { runtimeApiKey?: string }).runtimeApiKey ?? env.EXA_API_KEY;
    if (!apiKey) {
      return {
        backend: "exa_search",
        usedFilters: filters,
        generatedSearches: [],
        discoveredCompanies: []
      };
    }

    const generatedSearches: DebugConsoleSearchQueryResult[] = [];
    const discoveredCompanies: CompanySample[] = [];
    const requestedCompanyCount = Math.max(limit, 20);
    const requestedQueryCount = Math.max(1, request.exaQueryCount ?? 4);
    const usedFilters: ApolloOrganizationFilter[] = [];
    const [settings, learning] = request.useAzureQueryPlanner
      ? await Promise.all([
        this.controlPlaneStore.getSettings(),
        this.controlPlaneStore.getLearning()
      ])
      : [undefined, undefined];
    const hubSpotExcludedDomains = await exaClient.loadKnownExcludedDomains();
    const testLabCache = await this.controlPlaneStore.getTestLabExaCache();
    testLabCache.queryInsights = Array.isArray(testLabCache.queryInsights)
      ? testLabCache.queryInsights
      : testLabCache.queryHistory.map((query) => ({ query }));
    const screeningDatabase = await this.controlPlaneStore.getCompanyScreeningDatabase();
    const prioritizedExcludedDomains = this.leadPipelineAgent.buildPrioritizedDirectExaExcludedDomains(
      screeningDatabase,
      request.targetCategories,
      hubSpotExcludedDomains,
      {
        screeningScope: "debug",
        historicalExaDomains: testLabCache.discoveredDomains
      }
    );
    const excludedDomains = prioritizedExcludedDomains.localExcludedDomains;
    let executedQueryCount = 0;

    for (const filter of filters) {
      if (executedQueryCount >= requestedQueryCount) {
        break;
      }

      usedFilters.push(filter);
      const recentQueryHistory = this.buildRecentExaQueryHistory(testLabCache.queryInsights, learning);
      const defaultQueries = exaClient.buildQueries(filter, 1, {
        targetCategoryRefinement: request.targetCategoryRefinement ?? settings?.targetCategoryRefinement
      });
      const remainingQueryCount = requestedQueryCount - executedQueryCount;
      const plannerQueryCount = request.useAzureQueryPlanner
        ? Math.min(defaultQueries.length, Math.max(remainingQueryCount, 4))
        : remainingQueryCount;
      let queryGenerationPromptMessages: Array<{ role: string; content: string }> | undefined;
      const queries = request.useAzureQueryPlanner
        ? await this.azureOpenAIClient.planExaSearchQueries(
          filter,
          defaultQueries.slice(0, plannerQueryCount),
          learning,
          false,
          settings?.mainContext,
          settings?.searchStrategyContext,
          plannerQueryCount,
          {
            recentQueryHistory,
            prequalification: settings?.prequalification,
            excludedDomainExamples: prioritizedExcludedDomains.requestExcludedDomains.slice(0, 30),
            requestedTargetCategories: request.targetCategories,
            targetCategoryRefinement: request.targetCategoryRefinement ?? settings?.targetCategoryRefinement,
            debugCapture: (details) => {
              queryGenerationPromptMessages = details.promptMessages;
            }
          }
        )
        : defaultQueries;
      const candidateQueries = Array.from(new Set([...queries, ...defaultQueries].map((query) => query.trim()).filter(Boolean)));
      const unseenQueries = candidateQueries.filter((query) => !testLabCache.queryHistory.includes(query));
      const queriesToRun = (unseenQueries.length > 0 ? unseenQueries : candidateQueries).slice(0, remainingQueryCount);

      for (const query of queriesToRun) {
        if (executedQueryCount >= requestedQueryCount) {
          break;
        }

        const exaRequestPayload = exaClient.buildSearchPayload(query, 20, prioritizedExcludedDomains.requestExcludedDomains);
        const payload = await exaClient.runSearch(apiKey, query, 20, prioritizedExcludedDomains.requestExcludedDomains);
        const acceptedCompanies: CompanySample[] = [];
        const rejectedResults: Array<{ title?: string; url?: string; reason: string }> = [];

        for (const result of payload.results ?? []) {
          const normalizedDomain = exaClient.normalizeUrl(result.url);
          if (!normalizedDomain) {
            rejectedResults.push({ title: result.title, url: result.url, reason: "invalid_url" });
            continue;
          }
          const excludeDomain = exaClient.toExcludeDomain(normalizedDomain);
          if (excludeDomain && excludedDomains.has(excludeDomain)) {
            rejectedResults.push({ title: result.title, url: result.url, reason: "excluded_domain" });
            continue;
          }
          if (excludeDomain) {
            excludedDomains.add(excludeDomain);
          }
          const company = {
            name: exaClient.deriveCompanyName(normalizedDomain, result.title),
            domain: exaClient.toCanonicalCompanyDomain(normalizedDomain),
            country: exaClient.inferCountryFromDomain(normalizedDomain, result, filter.locations[0]),
            shortDescription: exaClient.buildDescription(result, filter),
            sourceFilter: `${filter.name} (exa-search: ${query.slice(0, 72)})`,
            discoveryQuery: query
          } satisfies CompanySample;

          acceptedCompanies.push(company);
          discoveredCompanies.push(company);
        }

        generatedSearches.push({
          query,
          queryGeneration: {
            source: request.useAzureQueryPlanner ? "azure_planner" : "baseline_default_queries",
            defaultQueries: defaultQueries.slice(0, plannerQueryCount),
            plannedQueries: queries,
            promptMessages: queryGenerationPromptMessages
          },
          exaRequestPayload,
          rawResults: payload.results ?? [],
          acceptedCompanies,
          rejectedResults
        });
        executedQueryCount += 1;

        testLabCache.queryHistory.unshift(query);
        testLabCache.queryInsights.unshift(this.buildSimulatedTestLabQueryInsight(query, filter));
        for (const result of payload.results ?? []) {
          const normalized = exaClient.toExcludeDomain(result.url);
          if (normalized) {
            testLabCache.discoveredDomains.unshift(normalized);
          }
        }
      }
    }

    await this.controlPlaneStore.writeTestLabExaCache({
      queryHistory: testLabCache.queryHistory,
      queryInsights: testLabCache.queryInsights,
      discoveredDomains: testLabCache.discoveredDomains
    });

    return {
      backend: "exa_search",
      usedFilters,
      generatedSearches,
      discoveredCompanies
    };
  }

  private buildSimulatedTestLabQueryInsight(query: string, filter: ApolloOrganizationFilter): ExaQueryHistoryInsight {
    const weightedCategories: LeadCategory[] = [];
    const queryText = query.toLowerCase();
    const addCategory = (category: LeadCategory, weight = 1) => {
      for (let index = 0; index < weight; index += 1) {
        weightedCategories.push(category);
      }
    };

    for (const category of filter.targetCategories ?? []) {
      addCategory(category, 2);
    }

    if (/consulting|consultant|beratung/.test(queryText)) {
      addCategory("integrator_vision_ai_consulting", 3);
    }
    if (/freelance|freelancer/.test(queryText)) {
      addCategory("integrator_vision_ai_freelancer", 3);
    }
    if (/system integrator|integrator|solution provider/.test(queryText)) {
      addCategory("integrator_vision_industrial_ai", 3);
      addCategory("integrator_relevant_focus", 1);
    }
    if (/industrial automation|automation/.test(queryText)) {
      addCategory("integrator_relevant_focus", 2);
      addCategory("machine_builder_ai_enablement", 1);
    }
    if (/platform|embedding/.test(queryText)) {
      addCategory("software_platform_embedding", 2);
    }
    if (/camera|imaging|optical/.test(queryText)) {
      addCategory("camera_manufacturer_partner", 1);
    }
    if (/general ai|machine learning|artificial intelligence/.test(queryText)) {
      addCategory("integrator_general_ai", 2);
    }

    if (weightedCategories.length === 0) {
      addCategory("integrator_vision_industrial_ai", 1);
      addCategory("integrator_relevant_focus", 1);
    }

    const detectedCategories: LeadCategory[] = [];
    const hash = Array.from(queryText).reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 7);
    const pickCount = Math.min(Array.from(new Set(weightedCategories)).length, hash % 2 === 0 ? 2 : 1);
    let cursor = hash % weightedCategories.length;

    while (detectedCategories.length < pickCount) {
      const candidate = weightedCategories[cursor % weightedCategories.length];
      if (!detectedCategories.includes(candidate)) {
        detectedCategories.push(candidate);
      }
      cursor += 3;
    }

    return {
      query,
      timestamp: new Date().toISOString(),
      detectedCategories,
      note: "Test-Lab simulation: erkannte Query-Klassen aus dem Query-Text abgeleitet."
    };
  }

  private buildRecentExaQueryHistory(
    testLabQueryInsights: ExaQueryHistoryInsight[],
    learning?: Awaited<ReturnType<ControlPlaneStore["getLearning"]>>
  ): ExaQueryHistoryInsight[] {
    const liveQueryInsights = (learning?.searchHistoryByMode?.exa_search?.searchHistory ?? [])
      .slice(0, 40)
      .flatMap((entry) => (entry.queryStats ?? []).map((queryStat) => ({
        query: queryStat.query,
        timestamp: entry.timestamp,
        foundCategoryBreakdown: { ...queryStat.categoryBreakdown },
        note: `${entry.filterName} | accepted ${queryStat.accepted}, wrong-category ${queryStat.rejectedDifferentCategory}, other ${queryStat.rejectedOther}, duplicates ${queryStat.duplicates}`
      })));

    return [...testLabQueryInsights, ...liveQueryInsights]
      .filter((entry) => entry.query?.trim())
      .sort((left, right) => {
        const leftTime = left.timestamp ? Date.parse(left.timestamp) : 0;
        const rightTime = right.timestamp ? Date.parse(right.timestamp) : 0;
        return rightTime - leftTime;
      })
      .slice(0, 50);
  }

  private async runDiffbotCompanySearch(filters: ApolloOrganizationFilter[], limit: number): Promise<DebugConsoleCompanySearchResult> {
    const diffbotClient = this.diffbotSearchClient as unknown as {
      buildQuery: (filter: ApolloOrganizationFilter) => string;
      runtimeToken?: string;
      creditsExhausted?: boolean;
    };
    const filter = filters[0];
    if (!filter) {
      return {
        backend: "diffbot_search",
        usedFilters: [],
        generatedSearches: [],
        discoveredCompanies: []
      };
    }

    const query = diffbotClient.buildQuery(filter);
    const discoveredCompanies = await this.diffbotSearchClient.discoverCompanies(filter, limit, 1);

    return {
      backend: "diffbot_search",
      usedFilters: [filter],
      generatedSearches: [
        {
          query,
          queryGeneration: {
            source: "baseline_default_queries",
            defaultQueries: [query],
            plannedQueries: [query]
          },
          rawResults: discoveredCompanies.map((company) => ({
            title: company.name,
            url: company.domain,
            summary: company.shortDescription
          })),
          exaRequestPayload: undefined,
          acceptedCompanies: discoveredCompanies,
          rejectedResults: []
        }
      ],
      discoveredCompanies
    };
  }

  private async resolveSearchFilters(request: DebugConsoleRunRequest): Promise<ApolloOrganizationFilter[]> {
    const preview = await this.leadPipelineAgent.preview({
      targetLeadCount: Math.max(1, request.limit),
      market: request.region,
      companySearchMode: request.companySearchMode,
      targetCategories: request.targetCategories,
      dryRun: true,
      syncToHubSpot: false,
      exaApiKey: request.exaApiKey,
      diffbotToken: request.diffbotToken
    });

    if (preview.suggestedFilters.length > 0) {
      return preview.suggestedFilters;
    }

    return [buildDebugSearchFilter(request.targetCategory, request.region)];
  }

  private async debugCategorizeWebsite(
    company: CompanySample,
    websiteEvidence: string
  ): Promise<DebugConsoleAzureEvaluation> {
    const azureClient = this.azureOpenAIClient as unknown as {
      compactClassificationInput: (value: string, limit: number) => string;
      buildWebsiteClassificationMessages: (
        name: string,
        domain: string | undefined,
        compactWebsiteSummary: string,
        mainContext?: string,
        prequalification?: unknown,
        learning?: unknown,
        compactMode?: boolean
      ) => Array<{ role: string; content: string }>;
      runChat: (messages: Array<{ role: string; content: string }>, options: { maxTokens?: number; deployment?: string }) => Promise<string>;
      parseJsonObject: <T>(content: string) => T;
      normalizeCategory: (category: string) => string;
      categorizeDryRun: (description: string) => { category: string; relevanceScore: number; rationale: string };
    };

    const fullRawInput = azureClient.compactClassificationInput(websiteEvidence, 2200);
    const fullMessages = azureClient.buildWebsiteClassificationMessages(company.name, company.domain, fullRawInput, undefined, undefined, undefined, false);

    if (!readiness.azureConfigured) {
      const fallback = azureClient.categorizeDryRun(websiteEvidence);
      return {
        rawInput: fullRawInput,
        promptMessages: fullMessages,
        compactRetryUsed: false,
        category: fallback.category,
        relevanceScore: fallback.relevanceScore,
        rationale: fallback.rationale
      };
    }

    try {
      const content = await azureClient.runChat(fullMessages, { maxTokens: 120 });
      const parsed = azureClient.parseJsonObject<{ category: string; relevanceScore: number; rationale: string }>(content);
      return {
        rawInput: fullRawInput,
        promptMessages: fullMessages,
        compactRetryUsed: false,
        category: azureClient.normalizeCategory(parsed.category),
        relevanceScore: parsed.relevanceScore,
        rationale: parsed.rationale
      };
    } catch {
      const compactRawInput = azureClient.compactClassificationInput(websiteEvidence, 1500);
      const compactMessages = azureClient.buildWebsiteClassificationMessages(company.name, company.domain, compactRawInput, undefined, undefined, undefined, true);

      try {
        const content = await azureClient.runChat(compactMessages, { maxTokens: 120 });
        const parsed = azureClient.parseJsonObject<{ category: string; relevanceScore: number; rationale: string }>(content);
        return {
          rawInput: compactRawInput,
          promptMessages: compactMessages,
          compactRetryUsed: true,
          category: azureClient.normalizeCategory(parsed.category),
          relevanceScore: parsed.relevanceScore,
          rationale: parsed.rationale
        };
      } catch {
        return {
          rawInput: compactRawInput,
          promptMessages: compactMessages,
          compactRetryUsed: true,
          category: "other",
          relevanceScore: 25,
          rationale: "Website evidence could not be classified reliably and should stay in manual-review territory."
        };
      }
    }
  }

  private async buildDetailedContactDebug(
    company: PreCategorizedCompany,
    options: { selectedContactsTimeoutMs?: number } = {}
  ): Promise<Awaited<ReturnType<HubSpotClient["debugPublicContactDiscovery"]>>> {
    const baseDebug = await this.hubspotClient.debugPublicContactDiscovery(company, options);
    return baseDebug;
  }

  private toResearchBriefPreview(researchBrief: ResearchBrief) {
    return {
      qualificationSummary: researchBrief.qualificationSummary,
      emailSubject: researchBrief.emailSubject,
      emailBody: researchBrief.emailBody,
      linkedInConnectionRequest: researchBrief.linkedInConnectionRequest,
      linkedInMessage: researchBrief.linkedInMessage,
      phoneScript: researchBrief.phoneScript,
      targetIndustry: researchBrief.targetIndustry,
      productsOffered: researchBrief.productsOffered,
      rankings: researchBrief.rankings,
      businessPotentialEUR: researchBrief.businessPotentialEUR
    };
  }

  private async ensureResearchBrief(
    company: PreCategorizedCompany,
    preview: DebugConsoleOutreachAnalysis["researchBrief"]
  ): Promise<ResearchBrief> {
    if (!preview) {
      return this.azureOpenAIClient.buildResearchBrief(company, false, undefined, undefined, {
        includeWebResearch: true
      });
    }

    const fullBrief = await this.azureOpenAIClient.buildResearchBrief(company, false, undefined, undefined, {
      includeWebResearch: true
    });
    return fullBrief;
  }

  private mergeCompanies(primary: CompanySample[], manual: CompanySample[]): CompanySample[] {
    const seenDomains = new Set<string>();
    const result: CompanySample[] = [];

    for (const company of [...primary, ...manual]) {
      const key = company.domain?.trim().toLowerCase() || company.name.trim().toLowerCase();
      if (!key || seenDomains.has(key)) {
        continue;
      }

      seenDomains.add(key);
      result.push(company);
    }

    return result;
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

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(timeoutMessage));
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}