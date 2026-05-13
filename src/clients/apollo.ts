import { env, readiness } from "../config";
import { ApolloContactCandidate, ApolloOrganizationFilter, CompanySample, PreCategorizedCompany, PublicContactCandidate } from "../types";
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

    if (creditLessMode) {
      return this.searchOrganizationsWithoutCredits(filter, limit, page);
    }

    if (!readiness.apolloConfigured) {
      return [];
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

  async searchContactsForCompany(company: PreCategorizedCompany, limit = 10): Promise<ApolloContactCandidate[]> {
    const normalizedDomain = this.normalizeDomain(company.domain);
    if (!readiness.apolloConfigured || !normalizedDomain) {
      return [];
    }

    const response = await fetch(`${env.APOLLO_BASE_URL}/mixed_people/api_search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.APOLLO_API_KEY as string
      },
      body: JSON.stringify({
        page: 1,
        per_page: limit,
        q_organization_domains_list: [normalizedDomain],
        person_seniorities: ["owner", "founder", "c_suite", "vp", "head", "director", "manager"],
        person_titles: [
          "CEO",
          "CTO",
          "COO",
          "Managing Director",
          "Head of Automation",
          "Head of Innovation",
          "Head of Engineering",
          "Head of Operations",
          "Head of Production",
          "Digitalization"
        ],
        include_similar_titles: true,
        contact_email_status: ["verified", "likely to engage", "unverified"]
      })
    });

    if (!response.ok) {
      throw new Error(`Apollo contact search failed: ${response.status} ${await response.text()}`);
    }

    const payload = (await response.json()) as {
      people?: Array<{
        id?: string;
        first_name?: string;
        last_name?: string;
        last_name_obfuscated?: string;
        name?: string;
        title?: string | null;
        seniority?: string | null;
        departments?: string[];
        functions?: string[];
        linkedin_url?: string | null;
        has_email?: boolean;
        organization_id?: string;
        organization?: { name?: string };
      }>;
    };

    const candidates = (payload.people ?? []).map<ApolloContactCandidate | null>((person) => {
        if (!person.id) {
          return null;
        }

        return {
          personId: person.id,
          firstName: person.first_name?.trim(),
          lastName: person.last_name?.trim() || person.last_name_obfuscated?.trim(),
          name: person.name?.trim() || [person.first_name, person.last_name_obfuscated].filter(Boolean).join(" "),
          title: person.title?.trim() || undefined,
          seniority: person.seniority?.trim() || undefined,
          departments: person.departments ?? [],
          functions: person.functions ?? [],
          organizationId: person.organization_id,
          organizationName: person.organization?.name?.trim(),
          linkedinUrl: person.linkedin_url?.trim() || undefined,
          hasEmail: Boolean(person.has_email)
        } satisfies ApolloContactCandidate;
      });

    return candidates.filter((person): person is ApolloContactCandidate => person !== null);
  }

  async enrichContactEmail(
    candidate: ApolloContactCandidate,
    company: Pick<PreCategorizedCompany, "domain" | "name">
  ): Promise<PublicContactCandidate | null> {
    const normalizedDomain = this.normalizeDomain(company.domain);
    if (!readiness.apolloConfigured || !normalizedDomain) {
      return null;
    }

    const response = await fetch(
      `${env.APOLLO_BASE_URL}/people/match?run_waterfall_email=false&run_waterfall_phone=false&reveal_personal_emails=false&reveal_phone_number=false`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.APOLLO_API_KEY as string
        },
        body: JSON.stringify({
          id: candidate.personId,
          domain: normalizedDomain,
          organization_name: company.name
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Apollo contact enrichment failed: ${response.status} ${await response.text()}`);
    }

    const payload = (await response.json()) as {
      person?: {
        id?: string;
        first_name?: string;
        last_name?: string;
        title?: string;
        email?: string;
        linkedin_url?: string;
      };
    };

    const email = payload.person?.email?.trim().toLowerCase();
    if (!email || this.isLowValueBusinessEmail(email)) {
      return null;
    }

    return {
      personId: payload.person?.id ?? candidate.personId,
      email,
      sourceUrl: payload.person?.linkedin_url?.trim() || candidate.linkedinUrl || `apollo:person:${candidate.personId}`,
      label: "apollo_selected_contact",
      firstName: payload.person?.first_name?.trim() || candidate.firstName,
      lastName: payload.person?.last_name?.trim() || candidate.lastName,
      jobTitle: payload.person?.title?.trim() || candidate.title,
      linkedinUrl: payload.person?.linkedin_url?.trim() || candidate.linkedinUrl
    };
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

  private normalizeDomain(domain: string | undefined): string | undefined {
    if (!domain) {
      return undefined;
    }

    return domain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/$/, "");
  }

  private isLowValueBusinessEmail(email: string): boolean {
    return /^(info|sales|office|kontakt|contact|hello|team|support|service|mail|privacy|datenschutz|legal|career|careers|jobs|bewerbung|hr|people|invoice|billing)@/i.test(email);
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
      .filter(({ company }) => this.isSparseCompanyDescription(company.shortDescription))
      .slice(0, Math.min(8, enrichedCompanies.length));

    const enrichments = await Promise.all(
      sparseIndexes.map(async ({ company, index }) => ({
        index,
        company,
        enrichment: await this.enrichCompanyDescription(company)
      }))
    );

    for (const { company, index, enrichment } of enrichments) {
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

  private isSparseCompanyDescription(description: string | undefined): boolean {
    const normalizedDescription = description?.trim().toLowerCase() ?? "";

    return (
      normalizedDescription.length < 80 ||
      normalizedDescription.includes("no verified public company description was returned by apollo") ||
      normalizedDescription.includes("no verified public company description") ||
      normalizedDescription.includes("signal is mixed and needs deeper manual review")
    );
  }

  private async enrichCompanyDescription(company: CompanySample): Promise<Partial<CompanySample> | null> {
    return this.webSearchAgent.summarizeCompany(company);
  }
}