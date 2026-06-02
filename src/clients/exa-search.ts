import { env, readiness } from "../config";
import { OrganizationFilter, CompanySample, CrawledWebsiteProfile, PreCategorizedCompany } from "../types";
import { OpenAIWebSearchClient } from "./openai-web-search";

interface SearchEvidence {
  context: string;
  citations: string[];
}

type ExaSearchResult = {
  title?: string;
  url?: string;
  highlights?: string[];
  summary?: string;
  text?: string;
};

type ExaSearchResponse = {
  results?: ExaSearchResult[];
  costDollars?: {
    total?: number;
  };
};

export type ExaSearchRequestPayload = {
  query: string;
  type: "auto";
  category?: "company";
  numResults: number;
  excludeDomains?: string[];
  contents: {
    summary: true;
    highlights: true;
  };
};

type ExaSearchPayloadOptions = {
  includeExcludeDomains?: boolean;
  includeCompanyCategoryFilter?: boolean;
  maxQueryCount?: number;
};

type ExaQueryBuildOptions = {
  targetCategoryRefinement?: string;
};

const EXA_ENDPOINT = "https://api.exa.ai/search";
const MAX_EXA_RESULTS_PER_QUERY = 20;
const MAX_EXA_EXCLUDE_DOMAINS = 1200;
const EXA_MIN_REQUEST_INTERVAL_MS = 250;
const EXA_MAX_RETRIES = 3;
const EXA_QUERY_CONCURRENCY = 3;
const EXA_REQUEST_TIMEOUT_MS = env.EXA_REQUEST_TIMEOUT_MS;
const HUBSPOT_EXCLUDED_DOMAIN_FETCH_TIMEOUT_MS = 10_000;
const GENERIC_COMPANY_NAMES = new Set(["home", "homepage", "startseite", "services", "solutions", "products", "company"]);
const COMPANY_NAME_STOP_WORDS = new Set(["ai", "the", "and", "for", "with", "vision", "industrial", "automation", "machine", "marking", "robotics", "solutions", "systems", "services"]);
export class ExaSearchClient {
  private static requestChain: Promise<void> = Promise.resolve();

  private static nextRequestAt = 0;

  private readonly fallbackResearchClient = new OpenAIWebSearchClient();

  private runtimeApiKey?: string;

  private spentUsd = 0;

  private acceptedCompanyDomains = new Set<string>();

  private knownExcludedDomainsPromise?: Promise<Set<string>>;

  private additionalExcludedDomains = new Set<string>();

  private includeExcludeDomains = true;

  private includeCompanyCategoryFilter = false;

  private maxQueryCount = Number.POSITIVE_INFINITY;

  setApiKey(apiKey: string | undefined): void {
    this.runtimeApiKey = apiKey?.trim() || undefined;
  }

  setSearchPayloadOptions(options: ExaSearchPayloadOptions): void {
    if (typeof options.includeExcludeDomains === "boolean") {
      this.includeExcludeDomains = options.includeExcludeDomains;
    }

    if (typeof options.includeCompanyCategoryFilter === "boolean") {
      this.includeCompanyCategoryFilter = options.includeCompanyCategoryFilter;
    }

    if (typeof options.maxQueryCount === "number") {
      this.maxQueryCount = Math.max(1, Math.floor(options.maxQueryCount ?? 1));
    }
  }

  setAdditionalExcludedDomains(domains: string[]): void {
    this.additionalExcludedDomains = new Set(
      domains
        .map((domain) => this.toExcludeDomain(domain))
        .filter((domain): domain is string => Boolean(domain))
    );
  }

  isConfigured(): boolean {
    return Boolean(this.runtimeApiKey || env.EXA_API_KEY);
  }

  resetMetrics(): void {
    this.spentUsd = 0;
    this.acceptedCompanyDomains.clear();
  }

  getMetrics(): { crawledPages: number; acceptedCompanyDomains: number } {
    return {
      crawledPages: this.acceptedCompanyDomains.size,
      acceptedCompanyDomains: this.acceptedCompanyDomains.size
    };
  }

  async discoverCompanies(
    filter: OrganizationFilter,
    limit: number,
    page = 1,
    shouldSkipDomain?: (domain: string) => boolean
  ): Promise<CompanySample[]> {
    const apiKey = this.runtimeApiKey || env.EXA_API_KEY;
    if (!apiKey) {
      return [];
    }

    const queries = this.buildQueries(filter, page).slice(0, this.maxQueryCount);
    const requestedCompanyCount = Math.max(limit, MAX_EXA_RESULTS_PER_QUERY);
    const companies: CompanySample[] = [];
    const excludedDomains = await this.loadKnownExcludedDomains();
    for (const domain of this.additionalExcludedDomains) {
      excludedDomains.add(domain);
    }

    for (let start = 0; start < queries.length; start += EXA_QUERY_CONCURRENCY) {
      if (this.spentUsd >= env.EXA_MAX_BUDGET_USD || companies.length >= requestedCompanyCount) {
        break;
      }

      const queryBatch = queries.slice(start, start + EXA_QUERY_CONCURRENCY);
      const payloads = await Promise.all(
        queryBatch.map(async (query) => ({
          query,
          payload: await this.runSearch(apiKey, query, MAX_EXA_RESULTS_PER_QUERY, Array.from(excludedDomains))
        }))
      );

      for (const { query, payload } of payloads) {
        this.spentUsd += payload.costDollars?.total ?? 0;

        for (const result of payload.results ?? []) {
          const normalizedDomain = this.normalizeUrl(result.url);
          if (!normalizedDomain) {
            continue;
          }

          if (shouldSkipDomain?.(normalizedDomain)) {
            const excludeDomain = this.toExcludeDomain(normalizedDomain);
            if (excludeDomain) {
              excludedDomains.add(excludeDomain);
            }
            continue;
          }

          this.acceptedCompanyDomains.add(normalizedDomain);
          const excludeDomain = this.toExcludeDomain(normalizedDomain);
          if (excludeDomain) {
            excludedDomains.add(excludeDomain);
          }

          companies.push({
            name: this.deriveCompanyName(normalizedDomain, result.title),
            domain: this.toCanonicalCompanyDomain(normalizedDomain),
            country: this.inferCountryFromDomain(normalizedDomain, result, filter.locations[0]),
            shortDescription: this.buildDescription(result, filter),
            sourceFilter: `${filter.name} (exa-search: ${this.compactQueryLabel(query)})`,
            discoveryQuery: query
          });

          if (companies.length >= requestedCompanyCount) {
            break;
          }
        }

        if (this.spentUsd >= env.EXA_MAX_BUDGET_USD || companies.length >= requestedCompanyCount) {
          break;
        }
      }
    }

    return companies.slice(0, requestedCompanyCount);
  }

  async buildResearchContext(company: PreCategorizedCompany): Promise<SearchEvidence | null> {
    return this.fallbackResearchClient.buildResearchContext(company);
  }

  async summarizeCompany(company: CompanySample): Promise<Partial<CompanySample> | null> {
    return this.fallbackResearchClient.summarizeCompany(company);
  }

  async crawlCompanyWebsite(domain: string | undefined): Promise<CrawledWebsiteProfile | null> {
    return this.fallbackResearchClient.crawlCompanyWebsite(domain);
  }

  private async runSearch(apiKey: string, query: string, numResults: number, excludeDomains: string[] = []): Promise<ExaSearchResponse> {
    for (let attempt = 1; attempt <= EXA_MAX_RETRIES; attempt += 1) {
      await this.waitForRateLimitSlot();
      const payload = this.buildSearchPayload(query, numResults, excludeDomains);

      let response: Response;
      try {
        response = await fetch(EXA_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(EXA_REQUEST_TIMEOUT_MS)
        });
      } catch (error) {
        if (attempt === EXA_MAX_RETRIES) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Exa search request failed: ${message}`);
        }

        await this.sleep(EXA_MIN_REQUEST_INTERVAL_MS * attempt * 2);
        continue;
      }

      if (response.ok) {
        return JSON.parse(await this.readResponseTextWithTimeout(response)) as ExaSearchResponse;
      }

      const errorText = await this.readResponseTextWithTimeout(response);
      if (response.status !== 429 || attempt === EXA_MAX_RETRIES) {
        throw new Error(`Exa search failed: ${response.status} ${errorText}`);
      }

      await this.sleep(EXA_MIN_REQUEST_INTERVAL_MS * attempt * 2);
    }

    throw new Error("Exa search failed after exhausting retries.");
  }

  private buildSearchPayload(query: string, numResults: number, excludeDomains: string[] = []): ExaSearchRequestPayload {
    const normalizedExcludeDomains = Array.from(new Set([
      ...excludeDomains.map((domain) => domain.trim().toLowerCase()).filter(Boolean),
      ...this.additionalExcludedDomains
    ]))
      .slice(-MAX_EXA_EXCLUDE_DOMAINS);

    return {
      query,
      type: "auto",
      ...(this.includeCompanyCategoryFilter ? { category: "company" as const } : {}),
      numResults: Math.min(MAX_EXA_RESULTS_PER_QUERY, Math.max(1, numResults)),
      ...(this.includeExcludeDomains ? { excludeDomains: normalizedExcludeDomains } : {}),
      contents: {
        summary: true,
        highlights: true
      }
    };
  }

  private async loadKnownExcludedDomains(): Promise<Set<string>> {
    if (!this.knownExcludedDomainsPromise) {
      this.knownExcludedDomainsPromise = (async () => {
        const excluded = new Set<string>();
        const hubspotDomains = await this.fetchKnownHubSpotDomains();
        for (const domain of hubspotDomains) {
          const normalized = this.toExcludeDomain(domain);
          if (normalized) {
            excluded.add(normalized);
          }
        }
        return excluded;
      })();
    }

    return new Set(await this.knownExcludedDomainsPromise);
  }

  private async fetchKnownHubSpotDomains(): Promise<Set<string>> {
    if (!readiness.hubspotConfigured) {
      return new Set();
    }

    const domains = new Set<string>();
    let after: string | undefined;

    try {
      do {
        const query = new URLSearchParams({
          limit: "100",
          properties: "domain"
        });

        if (after) {
          query.set("after", after);
        }

        const response = await fetch(`${env.HUBSPOT_BASE_URL}/crm/v3/objects/companies?${query.toString()}`, {
          headers: {
            Authorization: `Bearer ${env.HUBSPOT_PRIVATE_APP_TOKEN}`,
            "Content-Type": "application/json"
          },
          signal: AbortSignal.timeout(HUBSPOT_EXCLUDED_DOMAIN_FETCH_TIMEOUT_MS)
        });

        if (!response.ok) {
          return domains;
        }

        const payload = await response.json() as {
          results?: Array<{ properties?: Record<string, string | null> }>;
          paging?: { next?: { after?: string } };
        };

        for (const company of payload.results ?? []) {
          const value = company.properties?.domain?.trim();
          if (value) {
            domains.add(value);
          }
        }

        after = payload.paging?.next?.after;
      } while (after);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("ExaSearchClient.fetchKnownHubSpotDomains skipped HubSpot domain sync", {
        message
      });
      return domains;
    }

    return domains;
  }

  private toExcludeDomain(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }

    try {
      const parsed = value.includes("://") ? new URL(value) : new URL(`https://${value}`);
      return parsed.hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
      return undefined;
    }
  }

  private async waitForRateLimitSlot(): Promise<void> {
    const previousRequest = ExaSearchClient.requestChain;
    let releaseRequest = () => {};
    ExaSearchClient.requestChain = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });

    await previousRequest;

    const waitMs = Math.max(0, ExaSearchClient.nextRequestAt - Date.now());
    if (waitMs > 0) {
      await this.sleep(waitMs);
    }

    ExaSearchClient.nextRequestAt = Date.now() + EXA_MIN_REQUEST_INTERVAL_MS;
    releaseRequest();
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async readResponseTextWithTimeout(response: Response): Promise<string> {
    return await Promise.race([
      response.text(),
      new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error(`Exa response body timed out after ${EXA_REQUEST_TIMEOUT_MS}ms`)), EXA_REQUEST_TIMEOUT_MS);
      })
    ]);
  }

  buildQueries(filter: OrganizationFilter, page: number, options: ExaQueryBuildOptions = {}): string[] {
    const locations = Array.from(new Set(filter.locations.map((location) => location.trim()).filter(Boolean))).slice(0, 2);
    const effectiveLocations = locations.length > 0 ? locations : ["Germany"];
    const locationVariants = Array.from(new Set(effectiveLocations.flatMap((location) => this.buildLocationVariants(location))));
    const compactPersona = this.compactSearchPhrase(filter.persona, 6);
    const keywords = filter.keywords.slice(0, 6).map((keyword) => this.compactSearchPhrase(keyword, 4)).filter(Boolean);
    const primaryKeywords = keywords.slice(0, 3);
    const semanticFocus = this.buildSemanticSearchFocus(filter, compactPersona, primaryKeywords);
    const applicationAngles = this.buildApplicationAngles(filter);
    const primaryCategory = filter.targetCategories?.[0];
    const refinementClause = this.buildRefinementClause(options.targetCategoryRefinement);
    const queryPool = locationVariants.flatMap((location) => {
      const primaryQueries = primaryCategory === "industrial_end_customer_scaled"
        ? this.buildIndustrialEndCustomerPrimaryQueries(location, filter, semanticFocus)
        : [
            `${location} companies that provide ${semanticFocus}. Prefer official company websites of system integrators or solution providers. Exclude directories, marketplaces, job boards, news articles, PDFs, and pure component manufacturers.`,
            `${location} system integrators and solution providers that deliver ${semanticFocus} for customer projects. Prefer official company websites and exclude directories, marketplaces, job boards, news articles, PDFs, and pure component manufacturers.`,
            `${location} industrial automation and machine vision companies that deliver turnkey inspection or vision integration projects. Prefer official company websites of integrators or solution providers, not directories, news pages, PDFs, or component vendors.`
          ];

      const angleQueries = applicationAngles.map((angle) => primaryCategory === "industrial_end_customer_scaled"
        ? this.buildIndustrialEndCustomerAngleQuery(location, filter, semanticFocus, angle)
        : `${location} companies that provide ${semanticFocus} for ${angle}. Prefer official company websites of system integrators or solution providers. Exclude directories, marketplaces, job boards, news articles, PDFs, and pure component manufacturers.`
      );

      return [...primaryQueries, ...angleQueries].map((query) => refinementClause ? `${query} ${refinementClause}` : query);
    }).filter(Boolean);

    const baseQueries = Array.from(new Set(queryPool));

    const offset = Math.max(0, page - 1) % Math.max(1, baseQueries.length);
    return [...baseQueries.slice(offset), ...baseQueries.slice(0, offset)];
  }

  private buildRefinementClause(targetCategoryRefinement: string | undefined): string {
    const normalizedRefinement = targetCategoryRefinement?.trim();
    if (!normalizedRefinement) {
      return "";
    }

    return `Within the selected target categories, narrow results to: ${normalizedRefinement}.`;
  }

  private buildIntentTerms(filter: OrganizationFilter): string[] {
    const text = [filter.persona, filter.notes, ...filter.keywords].join(" ").toLowerCase();

    if (/(mes|scada|plc|ot integration|automation software|sondermaschinen)/.test(text)) {
      return ["customer projects", "project delivery", "industrial automation", "engineering services"];
    }

    if (/(machine vision|bildverarbeitung|inspection|aoi|image processing|computer vision)/.test(text)) {
      return ["customer projects", "inspection systems", "engineering services", "system integrator"];
    }

    if (/(embedded|edge ai|industrial software|software engineering)/.test(text)) {
      return ["engineering services", "customer implementation", "project delivery", "industrial customers"];
    }

    return ["customer projects", "implementation", "engineering services", "system integrator"];
  }

  private buildDiscoveryTerms(filter: OrganizationFilter): string[] {
    const text = [filter.persona, filter.notes, ...filter.keywords].join(" ").toLowerCase();

    if (/(machine vision|bildverarbeitung|inspection|aoi|image processing|computer vision)/.test(text)) {
      return ["system integrator", "customer projects", "industrial inspection", "engineering services"];
    }

    if (/(embedded|edge ai|industrial software|software engineering)/.test(text)) {
      return ["engineering services", "customer implementation", "system integrator", "industrial software"];
    }

    if (/(mes|scada|plc|ot integration|automation software|sondermaschinen)/.test(text)) {
      return ["industrial automation", "system integrator", "project delivery", "customer projects"];
    }

    return ["system integrator", "customer projects", "engineering services", "implementation partner"];
  }

  private buildSemanticSearchFocus(
    filter: OrganizationFilter,
    compactPersona: string,
    primaryKeywords: string[]
  ): string {
    const normalizedText = [filter.persona, filter.notes, ...filter.keywords].join(" ").toLowerCase();

    if (filter.targetCategories?.includes("industrial_end_customer_scaled")) {
      return "in-house quality control, visual inspection, process automation, production-line inspection, and machine-vision adoption";
    }

    if (/(machine vision|bildverarbeitung|inspection|aoi|image processing|computer vision)/.test(normalizedText)) {
      return "machine vision system integration for industrial automation, industrial image processing, optical inspection systems, camera-based quality control, robot guidance, and turnkey vision inspection solutions";
    }

    if (/(mes|scada|plc|ot integration|automation software|sondermaschinen)/.test(normalizedText)) {
      return "industrial automation integration, PLC or SCADA implementation, MES connectivity, production software delivery, and project-based engineering services";
    }

    return [compactPersona, ...primaryKeywords]
      .filter(Boolean)
      .join(", ") || "industrial AI and automation integration services";
  }

  private buildApplicationAngles(filter: OrganizationFilter): string[] {
    const normalizedText = [filter.persona, filter.notes, ...filter.keywords].join(" ").toLowerCase();

    if (filter.targetCategories?.includes("industrial_end_customer_scaled")) {
      return [
        "quality control and visual quality inspection on production lines",
        "inline inspection, defect detection, and yield improvement",
        "packaging, sorting, and verification in factory operations",
        "process monitoring, traceability, and production optimization"
      ];
    }

    if (/(machine vision|bildverarbeitung|inspection|aoi|image processing|computer vision)/.test(normalizedText)) {
      return [
        "quality control and visual quality inspection",
        "robot guidance and pick-and-place automation",
        "inline inspection and defect detection",
        "optical inspection and camera-based production monitoring",
        "sorting, verification, and industrial image processing"
      ];
    }

    if (/(mes|scada|plc|ot integration|automation software|sondermaschinen)/.test(normalizedText)) {
      return [
        "production control and shop-floor automation",
        "machine connectivity and line integration",
        "MES, SCADA, and PLC modernization",
        "quality management and process monitoring"
      ];
    }

    return [
      "quality control",
      "industrial inspection",
      "automation projects",
      "production monitoring"
    ];
  }

  private buildIndustrialEndCustomerPrimaryQueries(
    location: string,
    filter: OrganizationFilter,
    semanticFocus: string
  ): string[] {
    const industries = filter.industries.slice(0, 3).join(", ");
    const industryFocus = industries ? `${industries} factory operators, producers, processors, and production groups` : "factory operators, producers, processors, and production groups";
    const operatorExclusion = "Exclude system integrators, consultancies, machine builders, OEMs, automation vendors, directories, marketplaces, job boards, news articles, PDFs, and component vendors.";

    return [
      `${location} ${industryFocus} with own production operations and likely need for ${semanticFocus}. Prefer official company websites of industrial end customers, factories, processing plants, production groups, or plant operators that buy and run production equipment. ${operatorExclusion}`,
      `${location} industrial end customers running factories or production lines in ${industries || "manufacturing"} with visible quality control, visual inspection, or process automation needs. Prefer official websites of factory operators, producers, processors, or production groups that operate plants and purchase machinery for their own production, not system integrators, machine builders, OEMs, resellers, or directories.`,
      `${location} scaled industrial end customers with internal QC, inspection, or production-automation upside across ${industries || "manufacturing"}. Prefer official company websites of factory operators, producers, processors, and production groups using production lines in-house. ${operatorExclusion}`
    ];
  }

  private buildIndustrialEndCustomerAngleQuery(
    location: string,
    filter: OrganizationFilter,
    semanticFocus: string,
    angle: string
  ): string {
    const industries = filter.industries.slice(0, 2).join(" and ") || "manufacturing";
    return `${location} industrial end customers in ${industries} with own production lines and need for ${angle}, ${semanticFocus}. Prefer official company websites of factories, plant operators, producers, processors, and production groups that buy and operate machinery in-house. Exclude system integrators, consultancies, machine builders, OEMs, directories, marketplaces, job boards, news articles, PDFs, and component vendors.`;
  }

  private buildLocationVariants(location: string): string[] {
    const normalized = location.trim();
    const lowered = normalized.toLowerCase();

    if (["germany", "de", "deutschland"].includes(lowered)) {
      return [
        "Germany",
        "Deutschland",
        "Berlin Germany",
        "Munich Germany",
        "Stuttgart Germany",
        "Hamburg Germany",
        "Cologne Germany",
        "Ruhr area Germany"
      ];
    }

    if (["austria", "at", "oesterreich", "österreich"].includes(lowered)) {
      return ["Austria", "Oesterreich"];
    }

    if (["switzerland", "ch", "schweiz"].includes(lowered)) {
      return ["Switzerland", "Schweiz"];
    }

    return [normalized];
  }

  private compactSearchPhrase(text: string | undefined, maxWords: number): string {
    const cleanedWords = (text ?? "")
      .replace(/[|,;:()\[\]{}]+/g, " ")
      .split(/\s+/)
      .map((word) => word.trim())
      .filter(Boolean)
      .filter((word, index, all) => all.findIndex((candidate) => candidate.toLowerCase() === word.toLowerCase()) === index);

    return cleanedWords.slice(0, maxWords).join(" ");
  }

  private buildQuery(parts: Array<string | undefined>): string {
    return parts
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private buildDescription(result: ExaSearchResult, filter: OrganizationFilter): string {
    const highlights = result.highlights?.slice(0, 3).join(" | ");
    const title = result.title?.trim();
    return [title, highlights, result.summary?.trim(), result.text?.trim(), filter.persona]
      .filter(Boolean)
      .join(". ")
      .slice(0, 1400);
  }

  private compactQueryLabel(query: string): string {
    return query.replace(/\s+/g, " ").trim().slice(0, 72);
  }

  private deriveCompanyName(domain: string, title?: string): string {
    const hostname = new URL(domain).hostname.replace(/^www\./i, "");
    const base = hostname.split(".")[0] ?? hostname;
    const titleCandidate = title
      ?.replace(/\s*[|\-].*$/, "")
      .replace(/\b(home|homepage|startseite)\b/gi, "")
      .trim();

    if (titleCandidate && !GENERIC_COMPANY_NAMES.has(titleCandidate.toLowerCase()) && this.looksLikeCompanyName(titleCandidate, base)) {
      return titleCandidate;
    }

    return base
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  private looksLikeCompanyName(titleCandidate: string, domainBase: string): boolean {
    const normalizedTitle = titleCandidate.toLowerCase();
    if (titleCandidate.length > 60 || titleCandidate.split(/\s+/).length > 6) {
      return false;
    }

    if (/[\/]|[▶►]|\b(?:learn more|contact us|case study|our services|our solutions)\b/i.test(titleCandidate)) {
      return false;
    }

    const titleTokens = normalizedTitle
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3)
      .filter((token) => !COMPANY_NAME_STOP_WORDS.has(token));
    const domainTokens = domainBase
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3);

    if (domainTokens.length > 0 && titleTokens.some((token) => domainTokens.includes(token))) {
      return true;
    }

    return /\b(gmbh|ag|ug|kg|llc|ltd|inc|corp|company|group)\b/i.test(titleCandidate);
  }

  private normalizeUrl(url: string | undefined): string | undefined {
    if (!url) {
      return undefined;
    }

    try {
      const parsed = new URL(url);
      parsed.protocol = "https:";
      parsed.hash = "";
      parsed.search = "";
      parsed.pathname = "/";
      return parsed.toString().replace(/\/$/, "");
    } catch {
      return undefined;
    }
  }

  private toCanonicalCompanyDomain(domain: string): string {
    const normalized = this.normalizeUrl(domain);
    return normalized ?? domain.replace(/\/$/, "");
  }

  private inferCountryFromDomain(domain: string, result: ExaSearchResult, fallbackLocation?: string): string | undefined {
    const hostname = new URL(domain).hostname.toLowerCase();
    if (hostname.endsWith(".de") || hostname.includes("gmbh")) {
      return "Germany";
    }

    if (hostname.endsWith(".at")) {
      return "Austria";
    }

    if (hostname.endsWith(".ch")) {
      return "Switzerland";
    }

    if (hostname.endsWith(".nl")) {
      return "Netherlands";
    }

    if (hostname.endsWith(".be")) {
      return "Belgium";
    }

    if (hostname.endsWith(".it")) {
      return "Italy";
    }

    if (hostname.endsWith(".fr")) {
      return "France";
    }

    if (hostname.endsWith(".hu")) {
      return "Hungary";
    }

    if (hostname.endsWith(".es")) {
      return "Spain";
    }

    if (hostname.endsWith(".pt")) {
      return "Portugal";
    }

    if (hostname.endsWith(".pl")) {
      return "Poland";
    }

    if (hostname.endsWith(".cz")) {
      return "Czech Republic";
    }

    const evidence = [
      result.title,
      ...(result.highlights ?? []),
      result.summary,
      result.text
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const germanEvidence = [" germany", " deutschland", " german", " berlin", " munich", " muenchen", " münchen", " hamburg", " stuttgart", " cologne", " köln", " koln", " frankfurt"];
    if (germanEvidence.some((token) => evidence.includes(token.trim()))) {
      return "Germany";
    }

    const austrianEvidence = [" austria", " österreich", " oesterreich", " vienna", " wien", " graz", " linz"];
    if (austrianEvidence.some((token) => evidence.includes(token.trim()))) {
      return "Austria";
    }

    const swissEvidence = [" switzerland", " schweiz", " suisse", " zurich", " zürich", " basel", " geneva"];
    if (swissEvidence.some((token) => evidence.includes(token.trim()))) {
      return "Switzerland";
    }

    const dutchEvidence = [" netherlands", " nederland", " amsterdam", " eindhoven", " rotterdam"];
    if (dutchEvidence.some((token) => evidence.includes(token.trim()))) {
      return "Netherlands";
    }

    const belgianEvidence = [" belgium", " belgique", " belgië", " antwerp", " brussels", " gent", " ghent"];
    if (belgianEvidence.some((token) => evidence.includes(token.trim()))) {
      return "Belgium";
    }

    const italianEvidence = [" italy", " italia", " milan", " milano", " turin", " torino", " vicenza", " bologna"];
    if (italianEvidence.some((token) => evidence.includes(token.trim()))) {
      return "Italy";
    }

    const frenchEvidence = [" france", " français", " francaise", " paris", " lyon", " toulouse", " aix-en-provence"];
    if (frenchEvidence.some((token) => evidence.includes(token.trim()))) {
      return "France";
    }

    const hungarianEvidence = [" hungary", " magyarország", " budapest", " debrecen", " szeged"];
    if (hungarianEvidence.some((token) => evidence.includes(token.trim()))) {
      return "Hungary";
    }

    if (fallbackLocation) {
      const normalizedFallback = fallbackLocation.trim().toLowerCase();
      if (evidence.includes(normalizedFallback)) {
        if (["germany", "deutschland", "berlin", "hamburg", "munich", "muenchen", "münchen", "stuttgart", "frankfurt", "cologne", "köln", "koln"].includes(normalizedFallback)) {
          return "Germany";
        }

        if (["austria", "österreich", "oesterreich", "vienna", "wien", "graz", "linz"].includes(normalizedFallback)) {
          return "Austria";
        }

        if (["switzerland", "schweiz", "suisse", "zurich", "zürich", "basel", "geneva"].includes(normalizedFallback)) {
          return "Switzerland";
        }
      }
    }

    return undefined;
  }
}