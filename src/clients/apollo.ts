import { env, readiness } from "../config";
import { ApolloOrganizationFilter, CompanySample } from "../types";
import { WebSearchAgent } from "./web-search-agent";

export class ApolloClient {
  private readonly webSearchAgent = new WebSearchAgent();

  async fetchOrganizationSample(
    filter: ApolloOrganizationFilter,
    limit: number,
    dryRun: boolean,
    page = 1,
    creditLessMode = false
  ): Promise<CompanySample[]> {
    if (dryRun) {
      return this.buildDryRunSample(filter, limit);
    }

    if (creditLessMode || !readiness.apolloConfigured) {
      return this.searchOrganizationsWithoutCredits(filter, limit, page);
    }

    const body = JSON.stringify({
      page,
      per_page: limit,
      q_organization_keyword_tags: filter.keywords,
      organization_locations: filter.locations,
      organization_num_employees_ranges: filter.employeeRanges,
      q_organization_industry_tags: filter.industries
    });

    let response: Response;
    try {
      response = await this.searchOrganizations(body);
    } catch (error) {
      if (this.isApolloCreditError(error)) {
        return this.searchOrganizationsWithoutCredits(filter, limit, page);
      }

      throw error;
    }

    const payload = (await response.json()) as {
      organizations?: Array<{
        name?: string;
        website_url?: string;
        short_description?: string;
        primary_location?: { country?: string };
        country?: string;
      }>;
    };

    const companies = (payload.organizations ?? []).map((organization, index) => ({
      name: organization.name ?? `${filter.name} Company ${index + 1}`,
      domain: organization.website_url,
      country: organization.primary_location?.country ?? organization.country,
      shortDescription: organization.short_description?.trim() || "No verified public company description was returned by Apollo.",
      sourceFilter: filter.name
    }));

    return this.enrichSparseCompanies(companies);
  }

  private async searchOrganizations(body: string): Promise<Response> {
    const primaryResponse = await this.postSearchRequest("mixed_companies/search", body);

    if (primaryResponse.ok) {
      return primaryResponse;
    }

    const primaryErrorText = await primaryResponse.text();
    if (primaryResponse.status !== 403 || !primaryErrorText.includes("API_INACCESSIBLE")) {
      throw new Error(`Apollo request failed: ${primaryResponse.status} ${primaryErrorText}`);
    }

    const fallbackResponse = await this.postSearchRequest("organizations/search", body);
    if (!fallbackResponse.ok) {
      const fallbackErrorText = await fallbackResponse.text();
      throw new Error(`Apollo request failed: ${fallbackResponse.status} ${fallbackErrorText}`);
    }

    return fallbackResponse;
  }

  private postSearchRequest(path: string, body: string): Promise<Response> {
    return fetch(`${env.APOLLO_BASE_URL}/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.APOLLO_API_KEY as string
      },
      body
    });
  }

  private async searchOrganizationsWithoutCredits(
    filter: ApolloOrganizationFilter,
    limit: number,
    page: number
  ): Promise<CompanySample[]> {
    const companies = await this.webSearchAgent.discoverCompaniesForFilter(filter, limit, page);
    return companies;
  }

  private isApolloCreditError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return /insufficient credits/i.test(error.message);
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

  private async enrichSparseCompanies(companies: CompanySample[]): Promise<CompanySample[]> {
    const enrichedCompanies = [...companies];
    const sparseIndexes = enrichedCompanies
      .map((company, index) => ({ company, index }))
      .filter(({ company }) => company.shortDescription.includes("No verified public company description was returned by Apollo."))
      .slice(0, 8);

    for (const { company, index } of sparseIndexes) {
      const enrichment = await this.webSearchAgent.summarizeCompany(company);
      if (!enrichment?.shortDescription) {
        continue;
      }

      enrichedCompanies[index] = {
        ...company,
        country: enrichment.country ?? company.country,
        shortDescription: enrichment.shortDescription
      };
    }

    return enrichedCompanies;
  }
}