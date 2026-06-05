import { OrganizationFilter, CompanySample, CompanySearchMode, CrawledWebsiteProfile, PreCategorizedCompany } from "../types";
import { DiffbotSearchClient } from "./diffbot-search";
import { ExaSearchClient } from "./exa-search";
import { OpenCrawlerDiscoveryMetrics, OpenCrawlerSearchClient } from "./open-crawler-search";

interface SearchEvidence {
  context: string;
  citations: string[];
}

export class WebSearchAgent {
  private readonly openCrawlerSearchClient = new OpenCrawlerSearchClient();

  private readonly diffbotSearchClient = new DiffbotSearchClient();

  private readonly exaSearchClient = new ExaSearchClient();

  setExaApiKey(apiKey: string | undefined): void {
    this.exaSearchClient.setApiKey(apiKey);
  }

  setExaExcludedDomains(domains: string[]): void {
    this.exaSearchClient.setAdditionalExcludedDomains(domains);
  }

  setExaSearchPayloadOptions(options: { includeExcludeDomains?: boolean; includeCompanyCategoryFilter?: boolean; maxQueryCount?: number }): void {
    this.exaSearchClient.setSearchPayloadOptions(options);
  }

  setDiffbotToken(token: string | undefined): void {
    this.diffbotSearchClient.setToken(token);
  }

  private getProvider(mode: CompanySearchMode) {
    if (mode === "exa_search") {
      return this.exaSearchClient.isConfigured() ? this.exaSearchClient : this.openCrawlerSearchClient;
    }

    if (mode === "diffbot_search") {
      return this.diffbotSearchClient;
    }

    return this.openCrawlerSearchClient;
  }

  resetDiscoveryMetrics(mode: CompanySearchMode): void {
    if (mode === "open_crawler_search") {
      this.openCrawlerSearchClient.resetMetrics();
      return;
    }

    if (mode === "exa_search" && this.exaSearchClient.isConfigured()) {
      this.exaSearchClient.resetMetrics();
    }
  }

  getDiscoveryMetrics(mode: CompanySearchMode): OpenCrawlerDiscoveryMetrics {
    if (mode === "open_crawler_search") {
      return this.openCrawlerSearchClient.getMetrics();
    }

    if (mode === "exa_search" && this.exaSearchClient.isConfigured()) {
      return this.exaSearchClient.getMetrics();
    }

    return {
      crawledPages: 0,
      acceptedCompanyDomains: 0
    };
  }

  async discoverCompaniesForFilter(
    filter: OrganizationFilter,
    limit: number,
    page = 1,
    shouldSkipDomain?: (domain: string) => boolean,
    mode: CompanySearchMode = "internet_research"
  ): Promise<CompanySample[]> {
    return this.getProvider(mode).discoverCompanies(filter, limit, page, shouldSkipDomain);
  }

  async buildResearchContext(company: PreCategorizedCompany, mode: CompanySearchMode = "internet_research"): Promise<SearchEvidence | null> {
    return this.getProvider(mode).buildResearchContext(company);
  }

  async summarizeCompany(company: CompanySample, mode: CompanySearchMode = "internet_research"): Promise<Partial<CompanySample> | null> {
    return this.getProvider(mode).summarizeCompany(company);
  }

  async crawlCompanyWebsite(domain: string | undefined, mode: CompanySearchMode = "internet_research"): Promise<CrawledWebsiteProfile | null> {
    return this.getProvider(mode).crawlCompanyWebsite(domain);
  }
}
