import { ApolloOrganizationFilter, CompanySample, CompanySearchMode } from "../types";
import { DiffbotSearchClient } from "./diffbot-search";
import { DiffbotTestDataClient } from "./diffbot-test-data";
import { WebSearchAgent } from "./web-search-agent";

export class ApolloClient {
  private readonly webSearchAgent = new WebSearchAgent();
  private readonly diffbotSearchClient = new DiffbotSearchClient();
  private readonly diffbotTestDataClient = new DiffbotTestDataClient();

  setExaApiKey(apiKey: string | undefined): void {
    this.webSearchAgent.setExaApiKey(apiKey);
  }

  setExaExcludedDomains(domains: string[]): void {
    this.webSearchAgent.setExaExcludedDomains(domains);
  }

  setExaSearchPayloadOptions(options: { includeExcludeDomains?: boolean; includeCompanyCategoryFilter?: boolean; maxQueryCount?: number }): void {
    this.webSearchAgent.setExaSearchPayloadOptions(options);
  }

  setDiffbotToken(token: string | undefined): void {
    this.webSearchAgent.setDiffbotToken(token);
    this.diffbotSearchClient.setToken(token);
  }

  resetDiscoveryMetrics(companySearchMode: CompanySearchMode): void {
    this.webSearchAgent.resetDiscoveryMetrics(companySearchMode);
  }

  getDiscoveryMetrics(companySearchMode: CompanySearchMode) {
    return this.webSearchAgent.getDiscoveryMetrics(companySearchMode);
  }

  async fetchOrganizationSample(
    filter: ApolloOrganizationFilter,
    limit: number,
    dryRun: boolean,
    page = 1,
    companySearchMode: CompanySearchMode = "internet_research",
    shouldSkipDomain?: (domain: string) => boolean
  ): Promise<CompanySample[]> {
    if (companySearchMode === "diffbot_test_data") {
      return this.diffbotTestDataClient.fetchOrganizationSample(filter, limit, page, shouldSkipDomain);
    }

    if (companySearchMode === "diffbot_search") {
      return this.diffbotSearchClient.discoverCompanies(filter, limit, page, shouldSkipDomain);
    }

    if (dryRun) {
      return this.buildDryRunSample(filter, limit);
    }

    return this.webSearchAgent.discoverCompaniesForFilter(filter, limit, page, shouldSkipDomain, companySearchMode);
  }

  private buildDryRunSample(filter: ApolloOrganizationFilter, limit: number): CompanySample[] {
    return Array.from({ length: limit }, (_, index) => ({
      name: `${filter.name} Prospect ${index + 1}`,
      domain: `https://example-${index + 1}.com`,
      country: filter.locations[0],
      shortDescription: this.buildDryRunDescription(filter, index),
      sourceFilter: filter.name
    }));
  }

  private buildDryRunDescription(filter: ApolloOrganizationFilter, index: number): string {
    if (filter.name.includes("Software Integrators") && index % 6 === 0) {
      return "Generic IT consultancy focused on ERP rollouts and back-office transformation with little industrial execution depth.";
    }

    if (filter.name.includes("Software Integrators") && !filter.name.includes("AI")) {
      return "Industrial automation system integrator delivering SCADA, MES, PLC and plant software integration projects for manufacturing clients.";
    }

    if (filter.name.includes("AI Software Integrators") && index % 8 === 0) {
      return "Corporate innovation consultancy focused on workshops and strategy decks for headquarters teams rather than plant-floor delivery.";
    }

    if (filter.name.includes("AI Software Integrators")) {
      return "AI and computer vision integrator delivering machine learning, defect detection and industrial analytics projects for production environments.";
    }

    if (filter.name.includes("Machine Builders") && index % 3 === 0) {
      return "Packaging equipment OEM with a broad mechanical portfolio and no visible signal around digital inspection or software-led optimization.";
    }

    if (filter.name.includes("Machine Builders")) {
      return "Specialized machine builder for production lines and assembly systems with potential need for inline quality inspection and visual quality control.";
    }

    if (filter.name.includes("Industrial Camera Vendors") && index % 4 === 0) {
      return "Broadline electronics distributor reselling factory components without a differentiated proprietary product stack.";
    }

    if (filter.name.includes("Industrial Camera Vendors")) {
      return "Industrial camera and machine vision hardware vendor focused on imaging components, optics and inspection cameras without a clear software AI layer.";
    }

    return `${filter.persona}. Keywords: ${filter.keywords.slice(0, 3).join(", ")}`;
  }
}
