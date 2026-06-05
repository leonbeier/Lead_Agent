import { env, readiness } from "../config";
import { ApolloContactCandidate, OrganizationFilter, CompanySample, CompanySearchMode, PreCategorizedCompany, PublicContactCandidate } from "../types";
import { DiffbotSearchClient } from "./diffbot-search";
import { DiffbotTestDataClient } from "./diffbot-test-data";
import { WebSearchAgent } from "./web-search-agent";
import type { ExaSearchType } from "./exa-search";

interface ApolloResolvedOrganization {
  id?: string;
  name?: string;
  websiteUrl?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  zip?: string;
}

export class ApolloClient {
  private readonly webSearchAgent = new WebSearchAgent();
  private readonly diffbotSearchClient = new DiffbotSearchClient();
  private readonly diffbotTestDataClient = new DiffbotTestDataClient();
  private apolloCreditsUnavailableUntil = 0;

  setExaApiKey(apiKey: string | undefined): void {
    this.webSearchAgent.setExaApiKey(apiKey);
  }

  setExaExcludedDomains(domains: string[]): void {
    this.webSearchAgent.setExaExcludedDomains(domains);
  }

  setExaSearchPayloadOptions(options: { includeExcludeDomains?: boolean; includeCompanyCategoryFilter?: boolean; maxQueryCount?: number; searchType?: ExaSearchType; systemPrompt?: string | null }): void {
    this.webSearchAgent.setExaSearchPayloadOptions(options);
  }

  setDiffbotToken(token: string | undefined): void {
    this.webSearchAgent.setDiffbotToken(token);
    this.diffbotSearchClient.setToken(token);
  }

  resetDiscoveryMetrics(companySearchMode: CompanySearchMode): void {
    this.webSearchAgent.resetDiscoveryMetrics(companySearchMode);
  }

  private hasApolloCreditCapacity(): boolean {
    return Date.now() >= this.apolloCreditsUnavailableUntil;
  }

  private markApolloCreditsUnavailable(): void {
    this.apolloCreditsUnavailableUntil = Date.now() + 5 * 60 * 1000;
  }

  getDiscoveryMetrics(companySearchMode: CompanySearchMode) {
    return this.webSearchAgent.getDiscoveryMetrics(companySearchMode);
  }

  async fetchOrganizationSample(
    filter: OrganizationFilter,
    limit: number,
    dryRun: boolean,
    page = 1,
    companySearchMode: CompanySearchMode = "apollo_search",
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

    if (companySearchMode === "internet_research" || companySearchMode === "open_crawler_search" || companySearchMode === "exa_search") {
      return this.searchOrganizationsWithoutCredits(filter, limit, page, shouldSkipDomain, companySearchMode);
    }

    if (!readiness.apolloConfigured || !this.hasApolloCreditCapacity()) {
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
        this.markApolloCreditsUnavailable();
        return this.searchOrganizationsWithoutCredits(filter, limit, page, shouldSkipDomain, companySearchMode);
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

  async searchContactsForCompany(company: PreCategorizedCompany, limit = 15): Promise<ApolloContactCandidate[]> {
    const normalizedDomain = this.normalizeDomain(company.domain);
    if (!readiness.apolloConfigured || !normalizedDomain || !this.hasApolloCreditCapacity()) {
      return [];
    }

    let resolvedOrganization: ApolloResolvedOrganization | null = null;
    try {
      resolvedOrganization = await this.resolveOrganizationForCompany(company);
    } catch (error) {
      if (this.isApolloCreditError(error)) {
        this.markApolloCreditsUnavailable();
        return [];
      }

      throw error;
    }

    const candidateDomains = Array.from(
      new Set([
        normalizedDomain,
        this.normalizeDomain(resolvedOrganization?.websiteUrl)
      ].filter((domain): domain is string => Boolean(domain)))
    );

    const candidatesByPersonId = new Map<string, ApolloContactCandidate>();
    for (const domain of candidateDomains) {
      let candidates: ApolloContactCandidate[] = [];
      try {
        candidates = await this.searchContactsByApolloDomain(domain, limit);
      } catch (error) {
        if (this.isApolloCreditError(error)) {
          this.markApolloCreditsUnavailable();
          return [];
        }

        throw error;
      }

      for (const candidate of candidates) {
        if (!candidatesByPersonId.has(candidate.personId)) {
          candidatesByPersonId.set(candidate.personId, candidate);
        }
      }
    }

    return [...candidatesByPersonId.values()]
      .sort((left, right) => this.getApolloOrganizationMatchScore(right, company, resolvedOrganization) - this.getApolloOrganizationMatchScore(left, company, resolvedOrganization))
      .slice(0, limit);
  }

  async enrichContactEmail(
    candidate: ApolloContactCandidate,
    company: Pick<PreCategorizedCompany, "domain" | "name">
  ): Promise<PublicContactCandidate | null> {
    const normalizedDomain = this.normalizeDomain(company.domain);
    if (!readiness.apolloConfigured || !normalizedDomain || !this.hasApolloCreditCapacity()) {
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
      const errorText = await response.text();
      const error = new Error(`Apollo contact enrichment failed: ${response.status} ${errorText}`);
      if (this.isApolloCreditError(error)) {
        this.markApolloCreditsUnavailable();
        return null;
      }

      throw error;
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

  async getOrganizationAddress(company: Pick<PreCategorizedCompany, "domain" | "name">): Promise<{
    address?: string;
    city?: string;
    state?: string;
    country?: string;
    zip?: string;
  } | null> {
    if (!this.hasApolloCreditCapacity()) {
      return null;
    }

    let organization: ApolloResolvedOrganization | null = null;
    try {
      organization = await this.resolveOrganizationForCompany(company);
    } catch (error) {
      if (this.isApolloCreditError(error)) {
        this.markApolloCreditsUnavailable();
        return null;
      }

      throw error;
    }

    if (!organization) {
      return null;
    }

    return organization.address || organization.city || organization.state || organization.country || organization.zip
      ? {
          address: organization.address,
          city: organization.city,
          state: organization.state,
          country: organization.country,
          zip: organization.zip
        }
      : null;
  }

  private async searchOrganizationsWithoutCredits(
    filter: OrganizationFilter,
    limit: number,
    page: number,
    shouldSkipDomain?: (domain: string) => boolean,
    companySearchMode: CompanySearchMode = "internet_research"
  ): Promise<CompanySample[]> {
    const companies = await this.webSearchAgent.discoverCompaniesForFilter(filter, limit, page, shouldSkipDomain, companySearchMode);
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

  private async resolveOrganizationForCompany(company: Pick<PreCategorizedCompany, "domain" | "name">): Promise<ApolloResolvedOrganization | null> {
    const normalizedDomain = this.normalizeDomain(company.domain);
    if (!normalizedDomain || !readiness.apolloConfigured) {
      return null;
    }

    const response = await this.postSearchRequest("organizations/search", JSON.stringify({
      page: 1,
      per_page: 5,
      q_organization_domains_list: [normalizedDomain]
    }));

    if (!response.ok) {
      throw new Error(`Apollo request failed: ${response.status} ${await response.text()}`);
    }

    const payload = (await response.json()) as {
      organizations?: Array<{
        id?: string;
        organization_id?: string;
        name?: string;
        website_url?: string;
        raw_address?: string;
        street_address?: string;
        city?: string;
        state?: string;
        country?: string;
        postal_code?: string;
      }>;
    };

    const normalizedCompanyName = this.normalizeCompanyName(company.name);
    const organizations = (payload.organizations ?? []).map((organization) => ({
      id: organization.id ?? organization.organization_id,
      name: organization.name?.trim(),
      websiteUrl: organization.website_url?.trim(),
      address: organization.street_address?.trim() || organization.raw_address?.trim(),
      city: organization.city?.trim(),
      state: organization.state?.trim(),
      country: organization.country?.trim(),
      zip: organization.postal_code?.trim()
    }));

    return organizations
      .sort((left, right) => this.getOrganizationResolutionScore(right, normalizedDomain, normalizedCompanyName) - this.getOrganizationResolutionScore(left, normalizedDomain, normalizedCompanyName))[0] ?? null;
  }

  private async searchContactsByApolloDomain(domain: string, limit: number): Promise<ApolloContactCandidate[]> {
    const searchBodies = [
      {
        page: 1,
        per_page: limit,
        q_organization_domains_list: [domain],
        person_seniorities: ["owner", "founder", "c_suite", "vp", "head", "director", "manager"],
        person_titles: [
          "CEO",
          "CTO",
          "COO",
          "Founder",
          "Owner",
          "Managing Director",
          "Managing Partner",
          "General Manager",
          "Operations Manager",
          "Plant Manager",
          "Head of Automation",
          "Head of Innovation",
          "Head of Engineering",
          "Head of Operations",
          "Head of Production",
          "Head of Manufacturing",
          "Head of Digitalization",
          "Innovation Manager",
          "Innovation Lead",
          "Innovation Director",
          "Head of AI",
          "Head of Computer Vision",
          "Technical Director",
          "Technology Manager",
          "Technical Manager",
          "Partner Manager",
          "Account Manager",
          "Business Development Manager",
          "Business Developer",
          "Solution Manager",
          "Project Manager",
          "Digitalization"
        ],
        include_similar_titles: true,
        contact_email_status: ["verified", "likely to engage", "unverified"]
      },
      {
        page: 1,
        per_page: limit,
        q_organization_domains_list: [domain],
        person_titles: [
          "Technology Manager",
          "Technical Manager",
          "Partner Manager",
          "Account Manager",
          "Business Development Manager",
          "Business Developer",
          "Business Development",
          "Solution Manager",
          "Project Manager",
          "Innovation Manager",
          "Operations Manager",
          "Engineering Manager"
        ],
        include_similar_titles: true
      }
    ];

    const candidatesByPersonId = new Map<string, ApolloContactCandidate>();
    for (const body of searchBodies) {
      const candidates = await this.searchApolloPeople(body);
      for (const candidate of candidates) {
        if (!candidatesByPersonId.has(candidate.personId)) {
          candidatesByPersonId.set(candidate.personId, candidate);
        }
      }
    }

    return [...candidatesByPersonId.values()].slice(0, limit);
  }

  private async searchApolloPeople(body: Record<string, unknown>): Promise<ApolloContactCandidate[]> {
    const response = await fetch(`${env.APOLLO_BASE_URL}/mixed_people/api_search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.APOLLO_API_KEY as string
      },
      body: JSON.stringify(body)
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

    return (payload.people ?? [])
      .map<ApolloContactCandidate | null>((person) => {
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
      })
      .filter((person): person is ApolloContactCandidate => person !== null);
  }

  private getOrganizationResolutionScore(
    organization: ApolloResolvedOrganization,
    normalizedDomain: string,
    normalizedCompanyName: string
  ): number {
    let score = 0;
    const organizationDomain = this.normalizeDomain(organization.websiteUrl);
    if (organizationDomain === normalizedDomain) {
      score += 3;
    }

    if (this.normalizeCompanyName(organization.name) === normalizedCompanyName) {
      score += 2;
    }

    return score;
  }

  private getApolloOrganizationMatchScore(
    candidate: ApolloContactCandidate,
    company: Pick<PreCategorizedCompany, "name">,
    resolvedOrganization: ApolloResolvedOrganization | null
  ): number {
    let score = 0;
    const normalizedCompanyName = this.normalizeCompanyName(company.name);
    const normalizedCandidateOrgName = this.normalizeCompanyName(candidate.organizationName);
    const normalizedResolvedOrgName = this.normalizeCompanyName(resolvedOrganization?.name);

    if (candidate.hasEmail) {
      score += 2;
    }

    if (resolvedOrganization?.id && candidate.organizationId === resolvedOrganization.id) {
      score += 4;
    }

    if (normalizedCandidateOrgName && normalizedCandidateOrgName === normalizedCompanyName) {
      score += 3;
    }

    if (normalizedCandidateOrgName && normalizedResolvedOrgName && normalizedCandidateOrgName === normalizedResolvedOrgName) {
      score += 2;
    }

    return score;
  }

  private normalizeCompanyName(name: string | undefined): string {
    return (name ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\b(gmbh|ag|bv|b v|sarl|s l|sl|sas|spa|s p a|sa|nv|oy|ab|kg|co|inc|ltd|llc)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private isLowValueBusinessEmail(email: string): boolean {
    return /^(info|sales|office|kontakt|contact|hello|team|support|service|mail|privacy|datenschutz|legal|career|careers|jobs|bewerbung|hr|people|invoice|billing)@/i.test(email);
  }

  private buildDryRunSample(filter: OrganizationFilter, limit: number): CompanySample[] {
    return Array.from({ length: limit }, (_, index) => ({
      name: `${filter.name} Prospect ${index + 1}`,
      domain: `https://example-${index + 1}.com`,
      country: filter.locations[0],
      shortDescription: this.buildDryRunDescription(filter, index),
      sourceFilter: filter.name
    }));
  }

  private buildDryRunDescription(filter: OrganizationFilter, index: number): string {
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