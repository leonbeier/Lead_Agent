import { env } from "../config";
import { ApolloOrganizationFilter, CompanySample, CrawledWebsiteProfile, PreCategorizedCompany } from "../types";
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

const EXA_ENDPOINT = "https://api.exa.ai/search";
const MAX_EXA_RESULTS_PER_QUERY = 10;
const EXA_MIN_REQUEST_INTERVAL_MS = 250;
const EXA_MAX_RETRIES = 3;
const EXA_QUERY_CONCURRENCY = 3;
const GENERIC_COMPANY_NAMES = new Set(["home", "homepage", "startseite", "services", "solutions", "products", "company"]);
const IGNORED_HOST_HINTS = [
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "twitter.com",
  "xing.com",
  "crunchbase.com",
  "zoominfo.com",
  "bloomberg.com",
  "wlw.de",
  "it-in-germany.de",
  "europages",
  "kompass",
  "werliefertwas",
  "industryarena",
  "expodatabase"
];

export class ExaSearchClient {
  private static requestChain: Promise<void> = Promise.resolve();

  private static nextRequestAt = 0;

  private readonly fallbackResearchClient = new OpenAIWebSearchClient();

  private runtimeApiKey?: string;

  private spentUsd = 0;

  private acceptedCompanyDomains = new Set<string>();

  setApiKey(apiKey: string | undefined): void {
    this.runtimeApiKey = apiKey?.trim() || undefined;
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
    filter: ApolloOrganizationFilter,
    limit: number,
    page = 1,
    shouldSkipDomain?: (domain: string) => boolean
  ): Promise<CompanySample[]> {
    const apiKey = this.runtimeApiKey || env.EXA_API_KEY;
    if (!apiKey) {
      return [];
    }

    const queries = this.buildQueries(filter, page);
    const companies: CompanySample[] = [];
    const seenDomains = new Set<string>();

    for (let start = 0; start < queries.length; start += EXA_QUERY_CONCURRENCY) {
      if (this.spentUsd >= env.EXA_MAX_BUDGET_USD || companies.length >= limit) {
        break;
      }

      const queryBatch = queries.slice(start, start + EXA_QUERY_CONCURRENCY);
      const payloads = await Promise.all(
        queryBatch.map(async (query) => ({
          query,
          payload: await this.runSearch(apiKey, query, Math.min(MAX_EXA_RESULTS_PER_QUERY, Math.max(6, limit - companies.length)))
        }))
      );

      for (const { query, payload } of payloads) {
        this.spentUsd += payload.costDollars?.total ?? 0;

        for (const result of payload.results ?? []) {
          const normalizedDomain = this.normalizeUrl(result.url);
          if (
            !normalizedDomain ||
            seenDomains.has(normalizedDomain) ||
            this.shouldIgnoreDomain(normalizedDomain) ||
            shouldSkipDomain?.(normalizedDomain)
          ) {
            continue;
          }

          seenDomains.add(normalizedDomain);
          this.acceptedCompanyDomains.add(normalizedDomain);

          companies.push({
            name: this.deriveCompanyName(normalizedDomain, result.title),
            domain: this.toCanonicalCompanyDomain(normalizedDomain),
            country: this.inferCountryFromDomain(normalizedDomain, filter.locations[0]),
            shortDescription: this.buildDescription(result, filter),
            sourceFilter: `${filter.name} (exa-search: ${this.compactQueryLabel(query)})`
          });

          if (companies.length >= limit) {
            break;
          }
        }

        if (this.spentUsd >= env.EXA_MAX_BUDGET_USD || companies.length >= limit) {
          break;
        }
      }
    }

    return companies.slice(0, limit);
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

  private async runSearch(apiKey: string, query: string, numResults: number): Promise<ExaSearchResponse> {
    for (let attempt = 1; attempt <= EXA_MAX_RETRIES; attempt += 1) {
      await this.waitForRateLimitSlot();

      const response = await fetch(EXA_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey
        },
        body: JSON.stringify({
          query,
          type: "auto",
          category: "company",
          numResults,
          contents: {
            highlights: true
          }
        })
      });

      if (response.ok) {
        return await response.json() as ExaSearchResponse;
      }

      const errorText = await response.text();
      if (response.status !== 429 || attempt === EXA_MAX_RETRIES) {
        throw new Error(`Exa search failed: ${response.status} ${errorText}`);
      }

      await this.sleep(EXA_MIN_REQUEST_INTERVAL_MS * attempt * 2);
    }

    throw new Error("Exa search failed after exhausting retries.");
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

  private buildQueries(filter: ApolloOrganizationFilter, page: number): string[] {
    const locations = Array.from(new Set(filter.locations.map((location) => location.trim()).filter(Boolean))).slice(0, 2);
    const effectiveLocations = locations.length > 0 ? locations : ["Germany"];
    const keywords = filter.keywords.slice(0, 6).map((keyword) => keyword.trim()).filter(Boolean);
    const primaryKeywords = keywords.slice(0, 3);
    const secondaryKeywords = keywords.slice(3, 6);
    const intentTerms = this.buildIntentTerms(filter);
    const discoveryTerms = this.buildDiscoveryTerms(filter);
    const quotedPrimaryKeywords = primaryKeywords.map((keyword) => `"${keyword}"`);
    const quotedSecondaryKeywords = secondaryKeywords.map((keyword) => `"${keyword}"`);
    const queryPool = effectiveLocations.flatMap((location) => [
      `${filter.persona} ${location} ${discoveryTerms.join(" ")}`,
      `${quotedPrimaryKeywords.join(" ")} ${location} ${discoveryTerms.slice(0, 2).join(" ")}`,
      `${keywords.slice(0, 2).join(" ")} ${location} ${intentTerms.slice(0, 3).join(" ")}`,
      `${quotedPrimaryKeywords.join(" ")} ${quotedSecondaryKeywords.join(" ")} ${location} official company website ${discoveryTerms[0]}`
    ]);

    const baseQueries = Array.from(new Set(queryPool));

    const offset = Math.max(0, page - 1) % Math.max(1, baseQueries.length);
    return [...baseQueries.slice(offset), ...baseQueries.slice(0, offset)];
  }

  private buildIntentTerms(filter: ApolloOrganizationFilter): string[] {
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

  private buildDiscoveryTerms(filter: ApolloOrganizationFilter): string[] {
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

  private buildDescription(result: ExaSearchResult, filter: ApolloOrganizationFilter): string {
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
    const titleCandidate = title
      ?.replace(/\s*[|\-].*$/, "")
      .replace(/\b(home|homepage|startseite)\b/gi, "")
      .trim();

    if (titleCandidate && !GENERIC_COMPANY_NAMES.has(titleCandidate.toLowerCase())) {
      return titleCandidate;
    }

    const hostname = new URL(domain).hostname.replace(/^www\./i, "");
    const base = hostname.split(".")[0] ?? hostname;
    return base
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  private normalizeUrl(url: string | undefined): string | undefined {
    if (!url) {
      return undefined;
    }

    try {
      const parsed = new URL(url);
      parsed.hash = "";
      parsed.search = "";
      return parsed.origin;
    } catch {
      return undefined;
    }
  }

  private toCanonicalCompanyDomain(domain: string): string {
    return domain.replace(/\/$/, "");
  }

  private shouldIgnoreDomain(domain: string): boolean {
    return IGNORED_HOST_HINTS.some((hostHint) => domain.includes(hostHint));
  }

  private inferCountryFromDomain(domain: string, fallbackLocation?: string): string | undefined {
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

    return fallbackLocation;
  }
}