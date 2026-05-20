import { env, readiness } from "../config";
import { ApolloClient } from "./apollo";
import { FoundryAgentsClient } from "./foundry-agents";
import { OpenAIWebSearchClient } from "./openai-web-search";
import { PreCategorizedCompany, PublicContactCandidate, ResearchBrief } from "../types";

interface HubSpotPropertyDefinition {
  name: string;
}

interface HubSpotObjectResponse {
  id: string;
  properties?: Record<string, string | null>;
}

interface HubSpotSyncResult {
  mode: "dry-run" | "live";
  attempted: boolean;
  candidateCount: number;
  syncedCount: number;
  companySyncedCount: number;
  contactSyncedCount: number;
  successfulCompanyKeys: string[];
  failedCompanyKeys: string[];
  errors: string[];
}

interface HubSpotSyncProgress {
  completedCompanies: number;
  totalCompanies: number;
  companyName: string;
}

interface ExtractedCompanyAddress {
  address?: string;
  city?: string;
  zip?: string;
  state?: string;
  country?: string;
}

interface WebSearchHit {
  url: string;
  title: string;
  snippet: string;
  query: string;
}

const HUBSPOT_MAX_RETRIES = 5;
const HUBSPOT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 12000];
const HUBSPOT_SEARCH_MIN_INTERVAL_MS = 250;
const HUBSPOT_REQUEST_TIMEOUT_MS = 15000;
const PUBLIC_CONTACT_ROLE_PATTERNS = [
  "CEO",
  "Chief Executive Officer",
  "CTO",
  "Chief Technology Officer",
  "COO",
  "Chief Operating Officer",
  "Innovation Manager",
  "Partner Manager",
  "Technology Manager",
  "Operations Manager",
  "Managing Director"
];
const PUBLIC_CONTACT_ROLE_REGEX = new RegExp(PUBLIC_CONTACT_ROLE_PATTERNS.join("|"), "i");
const HIGH_PRIORITY_PAGE_PATTERNS = ["contact", "kontakt", "impressum", "imprint", "legal", "legal notice", "legal-notice", "about", "team", "management"];
const MEDIUM_PRIORITY_PAGE_PATTERNS = [
  "software",
  "service",
  "services",
  "leistung",
  "loesung",
  "lösung",
  "solution",
  "solutions",
  "produkt",
  "product",
  "produkte",
  "products",
  "automation",
  "vision",
  "industrie",
  "industry",
  "branchen",
  "applications",
  "anwendungen"
];
const EXCLUDED_PAGE_PATTERNS = [
  "jobs",
  "karriere",
  "career",
  "news",
  "blog",
  "datenschutz",
  "privacy",
  "agb",
  "terms",
  "login",
  "signin",
  "facebook",
  "instagram",
  "youtube",
  "xing",
  "linkedin.com",
  "mailto:",
  "tel:"
];
const HUBSPOT_STANDARD_INDUSTRIES = new Set([
  "AUTOMOTIVE",
  "COMPUTER_SOFTWARE",
  "ELECTRICAL_ELECTRONIC_MANUFACTURING",
  "INDUSTRIAL_AUTOMATION",
  "INFORMATION_TECHNOLOGY_AND_SERVICES",
  "MACHINERY",
  "MANAGEMENT_CONSULTING",
  "MECHANICAL_OR_INDUSTRIAL_ENGINEERING",
  "SEMICONDUCTORS"
]);
const COMMON_COMPOUND_TLDS = new Set([
  "co.uk",
  "com.au",
  "com.br",
  "com.mx",
  "co.jp",
  "co.kr",
  "co.nz",
  "com.sg",
  "com.cn",
  "com.tw",
  "com.hk"
]);

export class HubSpotClient {
  private readonly availableProperties = new Map<"companies" | "contacts", Promise<Set<string>>>();

  private readonly apolloClient = new ApolloClient();

  private readonly foundryAgentsClient = new FoundryAgentsClient();

  private readonly openAIWebSearchClient = new OpenAIWebSearchClient();

  private searchRequestQueue = Promise.resolve();

  async getAllCompanyDomains(): Promise<Set<string>> {
    if (!readiness.hubspotConfigured) {
      return new Set();
    }

    const domains = new Set<string>();
    let after: string | undefined;

    do {
      const query = new URLSearchParams({
        limit: "100",
        properties: "domain"
      });

      if (after) {
        query.set("after", after);
      }

      const response = await this.requestJson<{
        results?: HubSpotObjectResponse[];
        paging?: { next?: { after?: string } };
      }>(`${env.HUBSPOT_BASE_URL}/crm/v3/objects/companies?${query.toString()}`);

      for (const company of response.results ?? []) {
        const normalizedDomain = this.normalizeDomain(company.properties?.domain ?? undefined);
        if (normalizedDomain) {
          domains.add(normalizedDomain);
        }
      }

      after = response.paging?.next?.after;
    } while (after);

    return domains;
  }

  async getExistingCompanyDomains(domains: string[]): Promise<Set<string>> {
    if (!readiness.hubspotConfigured || domains.length === 0) {
      return new Set();
    }

    const uniqueDomains = Array.from(
      new Set(
        domains
          .map((domain) => this.normalizeDomain(domain))
          .filter((domain): domain is string => Boolean(domain))
      )
    );

    const existingDomains = new Set<string>();
    for (const domain of uniqueDomains) {
      const existingCompany = await this.searchObject("companies", "domain", domain);
      if (existingCompany) {
        existingDomains.add(domain);
      }
    }

    return existingDomains;
  }

  async findPublicContactsForCompany(company: PreCategorizedCompany): Promise<PublicContactCandidate[]> {
    return this.findPublicContacts(company);
  }

  async syncQualifiedCompanies(
    companies: PreCategorizedCompany[],
    researchBriefs: ResearchBrief[],
    contactsByCompany: Map<string, PublicContactCandidate[]>,
    dryRun: boolean,
    onProgress?: (progress: HubSpotSyncProgress) => void
  ): Promise<HubSpotSyncResult> {
    if (dryRun || !readiness.hubspotConfigured) {
      return {
        mode: "dry-run",
        attempted: false,
        candidateCount: companies.length,
        syncedCount: 0,
        companySyncedCount: 0,
        contactSyncedCount: 0,
        successfulCompanyKeys: [],
        failedCompanyKeys: [],
        errors: []
      };
    }

    const companyProperties = await this.getAvailableProperties("companies");
    const contactProperties = await this.getAvailableProperties("contacts");
    let completedCompanies = 0;
    const companyResults = await this.mapWithConcurrency(
      companies.map((company) => async () => {
        const brief = researchBriefs.find((item) => item.companyName === company.name);
        const companyKey = this.getCompanyKey(company);
        let companySyncedCount = 0;
        let contactSyncedCount = 0;
        const errors: string[] = [];
        let companyWriteSucceeded = false;

        try {
          const syncedCompany = await this.upsertCompany(company, brief, companyProperties);
          companySyncedCount = 1;
          companyWriteSucceeded = true;

          const selectedContacts = contactsByCompany.get(this.getCompanyKey(company)) ?? [];
          for (const publicContact of selectedContacts) {
            try {
              const syncedContact = await this.upsertContact(publicContact, contactProperties);
              if (!syncedContact) {
                continue;
              }

              await this.associateContactToCompany(syncedContact.id, syncedCompany.id);
              await this.createOutreachNotes(syncedCompany.id, syncedContact.id, company, publicContact, brief);
              contactSyncedCount += 1;
            } catch (error) {
              errors.push(`${company.name}: ${this.toErrorMessage(error)}`);
            }
          }
        } catch (error) {
          errors.push(`${company.name}: ${this.toErrorMessage(error)}`);
        } finally {
          completedCompanies += 1;
          onProgress?.({
            completedCompanies,
            totalCompanies: companies.length,
            companyName: company.name
          });
        }

        return {
          companyKey,
          companyWriteSucceeded,
          companySyncedCount,
          contactSyncedCount,
          errors
        };
      }),
      env.HUBSPOT_SYNC_CONCURRENCY
    );

    const companySyncedCount = companyResults.reduce((sum, result) => sum + result.companySyncedCount, 0);
    const contactSyncedCount = companyResults.reduce((sum, result) => sum + result.contactSyncedCount, 0);
    const successfulCompanyKeys = companyResults
      .filter((result) => result.companyWriteSucceeded)
      .map((result) => result.companyKey);
    const failedCompanyKeys = companyResults
      .filter((result) => !result.companyWriteSucceeded)
      .map((result) => result.companyKey);
    const errors = companyResults.flatMap((result) => result.errors);

    return {
      mode: "live",
      attempted: true,
      candidateCount: companies.length,
      syncedCount: companySyncedCount + contactSyncedCount,
      companySyncedCount,
      contactSyncedCount,
      successfulCompanyKeys,
      failedCompanyKeys,
      errors
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

  private async upsertCompany(
    company: PreCategorizedCompany,
    brief: ResearchBrief | undefined,
    availableProperties: Set<string>
  ): Promise<HubSpotObjectResponse> {
    const companyDescription = this.buildCompanyDescription(company, brief);
    const extractedAddress = await this.extractCompanyAddress(company);

    const properties = this.pickAvailableProperties(
      {
        name: company.name,
        domain: this.normalizeDomain(company.domain),
        country: extractedAddress?.country ?? company.country,
        address: extractedAddress?.address,
        city: extractedAddress?.city,
        zip: extractedAddress?.zip,
        state: extractedAddress?.state,
        industry: this.normalizeHubSpotIndustryValue(brief?.targetIndustry, companyDescription),
        description: companyDescription,
        ai_cc_category: this.mapCompanyCategory(company.category),
        ai_cc_summary_short: brief?.isFallback ? company.rationale : (brief?.qualificationSummary ?? company.rationale),
        ai_cc_summary_long: companyDescription,
        ai_cc_pain_points: brief?.isFallback ? undefined : (brief?.businessPotentialReasoning ?? brief?.emailAngle ?? brief?.phoneAngle),
        ai_cc_linkedin_message: brief?.linkedInMessage,
        ai_cc_cold_call_linkedin: brief?.linkedInConnectionRequest ?? brief?.linkedInMessage,
        ai_cc_email_subject: brief?.emailSubject,
        ai_cc_cold_call_email: brief?.emailBody,
        ai_cc_phone_script: brief?.phoneScript,
        ai_cc__ow_business_potential: this.toNumericPropertyValue(brief?.businessPotentialEUR),
        ai_cc_ranking_partner: this.toNumericPropertyValue(brief?.rankings.partner ?? this.getNumericRanking(company.category, "partner")),
        ai_cc_ranking_serviceprovider: this.toNumericPropertyValue(brief?.rankings.serviceProvider ?? this.getNumericRanking(company.category, "serviceprovider")),
        ai_cc_ranking_customer: this.toNumericPropertyValue(brief?.rankings.customer ?? this.getNumericRanking(company.category, "customer")),
        ai_ranking_customer: this.toNumericPropertyValue(brief?.rankings.customer ?? this.getNumericRanking(company.category, "customer")),
        ai_cc_customer_products_offered: brief?.productsOffered,
        ai_cc_customer_target_industry: brief?.targetIndustry
      },
      availableProperties
    );

    if (!properties.name) {
      throw new Error("No writable company properties are available for the record.");
    }

    const existingCompany = await this.findExistingCompany(company);
    if (existingCompany) {
      return this.requestJson<HubSpotObjectResponse>(
        `${env.HUBSPOT_BASE_URL}/crm/v3/objects/companies/${existingCompany.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ properties })
        }
      );
    }

    return this.requestJson<HubSpotObjectResponse>(`${env.HUBSPOT_BASE_URL}/crm/v3/objects/companies`, {
      method: "POST",
      body: JSON.stringify({ properties })
    });
  }

  private async upsertContact(
    contact: PublicContactCandidate,
    availableProperties: Set<string>
  ): Promise<HubSpotObjectResponse | null> {
    const normalizedContact = this.normalizeContactForHubSpot(contact);
    if (!normalizedContact?.email) {
      return null;
    }

    const properties = this.pickAvailableProperties(
      {
        email: normalizedContact.email,
        firstname: normalizedContact.firstName,
        lastname: normalizedContact.lastName,
        phone: normalizedContact.phone,
        jobtitle: normalizedContact.jobTitle,
        hs_lead_status: "NEW",
        lead_source: "AI Agent",
        lead_source_details: "AI Agent"
      },
      availableProperties
    );

    const existingContact = await this.findExistingContact(normalizedContact.email);
    if (existingContact) {
      return this.requestJson<HubSpotObjectResponse>(
        `${env.HUBSPOT_BASE_URL}/crm/v3/objects/contacts/${existingContact.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ properties })
        }
      );
    }

    return this.requestJson<HubSpotObjectResponse>(`${env.HUBSPOT_BASE_URL}/crm/v3/objects/contacts`, {
      method: "POST",
      body: JSON.stringify({ properties })
    });
  }

  private normalizeContactForHubSpot(contact: PublicContactCandidate): PublicContactCandidate | null {
    const email = contact.email?.trim().toLowerCase();
    const linkedinUrl = this.normalizeLinkedInUrl(contact.linkedinUrl);
    if (!email) {
      return null;
    }

    const firstName = this.normalizeNamePart(contact.firstName);
    const lastName = this.normalizeNamePart(contact.lastName);

    return {
      ...contact,
      email,
      linkedinUrl,
      firstName,
      lastName
    };
  }

  private async associateContactToCompany(contactId: string, companyId: string): Promise<void> {
    await this.requestJson(
      `${env.HUBSPOT_BASE_URL}/crm/v4/objects/contacts/${contactId}/associations/default/companies/${companyId}`,
      {
        method: "PUT"
      }
    );
  }

  private async createOutreachNotes(
    companyId: string,
    contactId: string,
    company: PreCategorizedCompany,
    contact: PublicContactCandidate,
    brief: ResearchBrief | undefined
  ): Promise<void> {
    if (!brief) {
      return;
    }

    const emailNote = this.buildEmailOutreachNote(company, contact, brief);
    const linkedInNote = this.buildLinkedInOutreachNote(company, contact, brief);
    const phoneNote = this.buildPhoneOutreachNote(company, contact, brief);

    if (emailNote) {
      await this.createAssociatedNote(companyId, contactId, emailNote);
    }

    if (linkedInNote) {
      await this.createAssociatedNote(companyId, contactId, linkedInNote);
    }

    if (phoneNote) {
      await this.createAssociatedNote(companyId, contactId, phoneNote);
    }
  }

  private async createAssociatedNote(companyId: string, contactId: string, body: string): Promise<void> {
    const note = await this.requestJson<HubSpotObjectResponse>(`${env.HUBSPOT_BASE_URL}/crm/v3/objects/notes`, {
      method: "POST",
      body: JSON.stringify({
        properties: {
          hs_timestamp: new Date().toISOString(),
          hs_note_body: body
        }
      })
    });

    await this.requestJson(`${env.HUBSPOT_BASE_URL}/crm/v4/objects/notes/${note.id}/associations/default/contacts/${contactId}`, {
      method: "PUT"
    });

    await this.requestJson(`${env.HUBSPOT_BASE_URL}/crm/v4/objects/notes/${note.id}/associations/default/companies/${companyId}`, {
      method: "PUT"
    });
  }

  private async findExistingCompany(company: PreCategorizedCompany): Promise<HubSpotObjectResponse | null> {
    const normalizedDomain = this.normalizeDomain(company.domain);
    if (normalizedDomain) {
      const byDomain = await this.searchObject("companies", "domain", normalizedDomain);
      if (byDomain) {
        return byDomain;
      }
    }

    return this.searchObject("companies", "name", company.name);
  }

  private async findExistingContact(email: string): Promise<HubSpotObjectResponse | null> {
    return this.searchObject("contacts", "email", email);
  }

  private getCompanyKey(company: Pick<PreCategorizedCompany, "name" | "domain">): string {
    return this.normalizeDomain(company.domain) || company.name.trim().toLowerCase();
  }

  private async searchObject(
    objectType: "companies" | "contacts",
    propertyName: string,
    value: string
  ): Promise<HubSpotObjectResponse | null> {
    const response = await this.scheduleSearchRequest(() =>
      this.requestJson<{ results?: HubSpotObjectResponse[] }>(
        `${env.HUBSPOT_BASE_URL}/crm/v3/objects/${objectType}/search`,
        {
          method: "POST",
          body: JSON.stringify({
            limit: 1,
            filterGroups: [
              {
                filters: [
                  {
                    propertyName,
                    operator: "EQ",
                    value
                  }
                ]
              }
            ]
          })
        }
      )
    );

    return response.results?.[0] ?? null;
  }

  private async scheduleSearchRequest<T>(task: () => Promise<T>): Promise<T> {
    const previousRequest = this.searchRequestQueue;
    let releaseQueue: (() => void) | undefined;

    this.searchRequestQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await previousRequest;

    try {
      return await task();
    } finally {
      await this.delay(HUBSPOT_SEARCH_MIN_INTERVAL_MS);
      releaseQueue?.();
    }
  }

  private normalizeDomain(domain: string | undefined): string | undefined {
    if (!domain) {
      return undefined;
    }

    try {
      const hostname = new URL(domain.startsWith("http") ? domain : `https://${domain}`).hostname.toLowerCase().replace(/^www\./, "");
      const labels = hostname.split(".").filter(Boolean);
      if (labels.length <= 2) {
        return hostname;
      }

      const compoundTld = labels.slice(-2).join(".");
      return COMMON_COMPOUND_TLDS.has(compoundTld)
        ? labels.slice(-3).join(".")
        : labels.slice(-2).join(".");
    } catch {
      return domain
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/$/, "");
    }
  }

  private async getAvailableProperties(objectType: "companies" | "contacts"): Promise<Set<string>> {
    const cached = this.availableProperties.get(objectType);
    if (cached) {
      return cached;
    }

    const propertiesPromise = this.requestJson<{ results?: HubSpotPropertyDefinition[] }>(
      `${env.HUBSPOT_BASE_URL}/crm/v3/properties/${objectType}`
    ).then((response) => new Set((response.results ?? []).map((property) => property.name)));

    this.availableProperties.set(objectType, propertiesPromise);
    return propertiesPromise;
  }

  private normalizeHubSpotIndustryValue(targetIndustry: string | undefined, companyDescription: string): string | undefined {
    const normalized = `${targetIndustry ?? ""} ${companyDescription}`.toLowerCase();
    if (!normalized.trim()) {
      return undefined;
    }

    if (/(industrial automation|automatisierung|automation software|plc|scada|mes|ot integration)/i.test(normalized)) {
      return "INDUSTRIAL_AUTOMATION";
    }

    if (/(machine vision|computer vision|software development|software engineering|embedded software|saas|platform)/i.test(normalized)) {
      return "COMPUTER_SOFTWARE";
    }

    if (/(mechanical engineering|mechatronic|sondermaschinen|mechanical|industrial engineering)/i.test(normalized)) {
      return "MECHANICAL_OR_INDUSTRIAL_ENGINEERING";
    }

    if (/(automation machinery|machinery|maschinenbau|machine builder|robotics)/i.test(normalized)) {
      return "MACHINERY";
    }

    if (/(electrical|electronic|electronics|imaging hardware|camera manufacturer)/i.test(normalized)) {
      return "ELECTRICAL_ELECTRONIC_MANUFACTURING";
    }

    if (/(it services|information technology|digital transformation|system integration)/i.test(normalized)) {
      return "INFORMATION_TECHNOLOGY_AND_SERVICES";
    }

    if (/(consulting|beratung)/i.test(normalized)) {
      return "MANAGEMENT_CONSULTING";
    }

    if (/(semiconductor|chip)/i.test(normalized)) {
      return "SEMICONDUCTORS";
    }

    return HUBSPOT_STANDARD_INDUSTRIES.has((targetIndustry ?? "").trim())
      ? (targetIndustry ?? "").trim()
      : undefined;
  }

  private pickAvailableProperties(
    properties: Record<string, string | undefined>,
    availableProperties: Set<string>
  ): Record<string, string> {
    return Object.fromEntries(
      Object.entries(properties).filter(
        ([name, value]) => typeof value === "string" && value.trim().length > 0 && availableProperties.has(name)
      ) as Array<[string, string]>
    );
  }

  private async findPublicContacts(company: PreCategorizedCompany): Promise<PublicContactCandidate[]> {
    if (!company.domain) {
      return this.discoverWebSearchContacts(company, []);
    }

    const rootUrl = this.normalizeCompanyUrl(company.domain);
    const allowedEmailDomains = this.buildAllowedEmailDomains(rootUrl);
    const pages = await this.collectCandidatePages(rootUrl);
    const candidates = new Map<string, PublicContactCandidate>();
    const namedWebsiteContacts: PublicContactCandidate[] = [];

    for (const page of pages) {
      const emails = this.extractEmails(page.html, allowedEmailDomains);
      const phones = this.extractPhones(page.html);
      const primaryPhone = phones[0];

      for (const email of emails) {
        const existing = candidates.get(email);
        const inferredName = this.inferNameFromPageContext(page.html, email) ?? this.inferNameFromEmail(email);
        const isGenericMailbox = this.isGenericMailbox(email);
        candidates.set(email, {
          email,
          phone: existing?.phone ?? primaryPhone,
          sourceUrl: page.url,
          label: isGenericMailbox ? "public_generic_mailbox" : "public_named_mailbox",
          firstName: existing?.firstName ?? inferredName.firstName,
          lastName: existing?.lastName ?? inferredName.lastName,
          jobTitle: existing?.jobTitle ?? (isGenericMailbox ? "General contact" : (this.inferJobTitleFromPageContext(page.html, email) ?? "Public contact")),
          linkedinUrl: existing?.linkedinUrl ?? this.extractLinkedInProfileUrlFromPage(page.html)
        });
      }

      namedWebsiteContacts.push(...this.extractNamedContactsFromPage(page.url, page.html, primaryPhone, emails));
    }

    const websiteContacts = this.mergeDiscoveredContacts(
      [...candidates.values()].filter((candidate) => !this.isLowValueMailbox(candidate.email ?? "")),
      namedWebsiteContacts
    );
    const webSearchContacts = await this.discoverWebSearchContacts(company, pages, websiteContacts);
    const mergedContacts = this.mergeDiscoveredContacts(websiteContacts, webSearchContacts);
    const enrichedContacts = await this.mapWithSearchInterval(
      mergedContacts.map((contact) => async () => this.enrichContactWithLinkedInUrl(company, contact)),
      1
    );

    return enrichedContacts
      .filter((candidate) => !this.isLowValueMailbox(candidate.email ?? ""))
      .sort((left, right) => this.getPublicContactScore(right) - this.getPublicContactScore(left))
      .slice(0, 5);
  }

  private async discoverWebSearchContacts(
    company: PreCategorizedCompany,
    pages: Array<{ url: string; html: string }>,
    knownContacts: PublicContactCandidate[] = []
  ): Promise<PublicContactCandidate[]> {
    const companyAliases = this.extractCompanySearchAliases(company, pages);
    const websiteEvidence = pages
      .map((page) => this.buildWebsiteEvidenceSnippet(page.url, page.html))
      .filter(Boolean)
      .join("\n\n");
    const knownContactEvidence = knownContacts
      .map((contact) => [
        [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() || contact.email || contact.label,
        contact.jobTitle,
        contact.email,
        contact.linkedinUrl,
        contact.sourceUrl
      ].filter(Boolean).join(" | "))
      .join("\n");
    const queryPlanningEvidence = [
      websiteEvidence ? `Official website evidence:\n${websiteEvidence}` : undefined,
      knownContactEvidence ? `Known website contacts:\n${knownContactEvidence}` : undefined,
      companyAliases.length > 0 ? `Company aliases: ${companyAliases.join(" | ")}` : undefined
    ].filter(Boolean).join("\n\n");
    const suggestedQueries = await this.foundryAgentsClient.suggestPublicContactQueries(company, queryPlanningEvidence, false);
    const queries = Array.from(new Set([...suggestedQueries, ...this.buildPublicContactSearchQueries(company, companyAliases)])).slice(0, 12);
    const hitGroups = await this.mapWithSearchInterval(
      queries.map((query) => async () => this.searchBingResults(query, 5)),
      1
    );
    const hits = hitGroups.flat();
    const relevantHits = hits.filter((hit) =>
      this.isRelevantCompanyHit(
        company,
        companyAliases,
        [hit.title, hit.snippet].filter(Boolean).join(" | ")
      )
    );
    const searchEvidence = relevantHits
      .map((hit) => `Query: ${hit.query}\nTitle: ${hit.title}\nURL: ${hit.url}\nSnippet: ${hit.snippet}`)
      .join("\n\n");

    const evidence = [
      websiteEvidence ? `Official website evidence:\n${websiteEvidence}` : undefined,
      knownContactEvidence ? `Known website contacts:\n${knownContactEvidence}` : undefined,
      searchEvidence ? `Web search evidence:\n${searchEvidence}` : undefined
    ].filter(Boolean).join("\n\n");

    if (!evidence.trim()) {
      return [];
    }

    const heuristicContacts = this.extractContactsFromSearchHits(company, relevantHits, companyAliases);
    const foundryContacts = await this.foundryAgentsClient.discoverPublicContacts(company, evidence, false);
    const mergedContacts = this.mergeDiscoveredContacts(foundryContacts, heuristicContacts);

    return mergedContacts.map((contact) => ({
      ...contact,
      jobTitle: this.normalizeJobTitle(contact.jobTitle) ?? contact.jobTitle,
      linkedinUrl: this.normalizeLinkedInUrl(contact.linkedinUrl),
      sourceUrl: contact.sourceUrl || contact.linkedinUrl || company.domain || company.name
    }));
  }

  private buildPublicContactSearchQueries(company: Pick<PreCategorizedCompany, "name" | "domain">, aliases: string[] = []): string[] {
    const companyName = company.name.trim();
    const normalizedDomain = this.normalizeDomain(company.domain);
    const companyToken = normalizedDomain?.split(".")[0];
    const simplifiedCompanyToken = companyToken?.split(/[-_]/).filter(Boolean)[0];
    const simplifiedCompanyName = companyName.replace(/\b(ai|gmbh|ug|ag|ltd|llc|inc)\b/gi, "").replace(/\s+/g, " ").trim();
    const roleQuery = '"CEO" OR "CTO" OR "COO" OR "Innovation Manager" OR "Partner Manager" OR "Technology Manager" OR "Operations Manager" OR "Managing Director"';
    const aliasQueries = aliases.flatMap((alias) => [
      `site:linkedin.com/in "${alias}"`,
      `${alias} ${roleQuery}`,
      `site:linkedin.com/company "${alias}" people`,
      `site:linkedin.com/in "${alias}" ${roleQuery}`,
      `${alias} linkedin ${roleQuery}`
    ]);

    return Array.from(
      new Set(
        [
          `site:linkedin.com/in "${companyName}"`,
          `${companyName} ${roleQuery}`,
          simplifiedCompanyName && simplifiedCompanyName !== companyName ? `site:linkedin.com/in "${simplifiedCompanyName}"` : undefined,
          simplifiedCompanyName && simplifiedCompanyName !== companyName ? `${simplifiedCompanyName} ${roleQuery}` : undefined,
          `site:linkedin.com/company "${companyName}" people`,
          simplifiedCompanyName && simplifiedCompanyName !== companyName ? `site:linkedin.com/company "${simplifiedCompanyName}" people` : undefined,
          `site:linkedin.com/in "${companyName}" ${roleQuery}`,
          simplifiedCompanyName && simplifiedCompanyName !== companyName ? `site:linkedin.com/in "${simplifiedCompanyName}" ${roleQuery}` : undefined,
          normalizedDomain ? `site:linkedin.com/in "${normalizedDomain}" ${roleQuery}` : undefined,
          companyToken ? `site:linkedin.com/in "${companyToken}" ${roleQuery}` : undefined,
          simplifiedCompanyToken && simplifiedCompanyToken !== companyToken ? `site:linkedin.com/in "${simplifiedCompanyToken}" ${roleQuery}` : undefined,
          `${companyName} linkedin ${roleQuery}`,
          ...aliasQueries
        ].filter((query): query is string => Boolean(query))
      )
    );
  }

  private extractCompanySearchAliases(
    company: Pick<PreCategorizedCompany, "name" | "domain">,
    pages: Array<{ url: string; html: string }>
  ): string[] {
    const companyName = company.name.trim();
    const normalizedDomain = this.normalizeDomain(company.domain);
    const primaryToken = (normalizedDomain?.split(".")[0] ?? companyName)
      .split(/[-_\s]+/)
      .find((token) => token && token.length >= 4 && !/^(ai|the|group)$/i.test(token));
    const aliasPattern = /\b([A-ZÄÖÜ][A-Za-zÄÖÜäöüß0-9&.'’\-]+(?:\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß0-9&.'’\-]+){0,2}\s+(?:GmbH|AG|UG|Ltd|LLC|Inc))\b/;
    const pageAliases = pages.flatMap((page) =>
      this.extractPlainTextLines(page.html)
        .map((line) => line.match(aliasPattern)?.[1]?.trim())
        .filter((alias): alias is string => Boolean(alias))
    );

    return Array.from(
      new Set(
        [companyName, companyName.replace(/\b(GmbH|AG|UG|Ltd|LLC|Inc)\b/gi, " ").replace(/\s+/g, " ").trim(), ...pageAliases]
          .map((alias) => alias.replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .filter((alias) => alias.length <= 40)
          .filter((alias) => !primaryToken || alias.toLowerCase().includes(primaryToken.toLowerCase()))
      )
    ).slice(0, 6);
  }

  private extractContactsFromSearchHits(
    company: Pick<PreCategorizedCompany, "name" | "domain">,
    hits: WebSearchHit[],
    aliases: string[] = []
  ): PublicContactCandidate[] {
    const contacts: PublicContactCandidate[] = [];

    for (const hit of hits) {
      const linkedinUrl = this.normalizeLinkedInUrl(hit.url);
      const title = this.decodeHtmlEntities(this.stripHtml(hit.title)).replace(/\s+/g, " ").trim();
      const snippet = this.decodeHtmlEntities(this.stripHtml(hit.snippet)).replace(/\s+/g, " ").trim();
      const relevantText = [title, snippet].filter(Boolean).join(" | ");

      if (!this.isRelevantCompanyHit(company, aliases, relevantText)) {
        continue;
      }

      if (linkedinUrl && /linkedin\.com\/in\//i.test(linkedinUrl)) {
        const name = this.extractNameFromSearchTitle(title);
        if (!name.firstName && !name.lastName) {
          continue;
        }

        contacts.push({
          ...name,
          jobTitle: this.extractJobTitleFromSearchText(title, snippet),
          linkedinUrl,
          sourceUrl: linkedinUrl,
          label: "linkedin_profile"
        });
        continue;
      }

      const name = this.extractNameFromSearchTitle(title);
      if (!name.firstName && !name.lastName) {
        continue;
      }

      contacts.push({
        ...name,
        jobTitle: this.extractJobTitleFromSearchText(title, snippet),
        sourceUrl: hit.url,
        label: "web_search_contact"
      });
    }

    return contacts;
  }

  private isRelevantCompanyHit(
    company: Pick<PreCategorizedCompany, "name" | "domain">,
    aliases: string[],
    text: string
  ): boolean {
    const haystack = text.toLowerCase();
    const normalizedHaystack = haystack.replace(/[^a-z0-9]+/g, " ");
    if (/(wikipedia|wiktionary|dictionary|cambridge dictionary|collins dictionary|definition\b|meaning\b|translation\b)/i.test(haystack)) {
      return false;
    }

    const exactAliases = aliases
      .map((alias) => alias.trim().toLowerCase())
      .filter((alias) => alias.split(/\s+/).length >= 2 || /(gmbh|ag|ug|ltd|llc|inc)/i.test(alias));
    if (exactAliases.some((alias) => haystack.includes(alias))) {
      return true;
    }

    const normalizedPhrases = Array.from(
      new Set(
        [
          company.name,
          company.name.replace(/\b(gmbh|ag|ug|ltd|llc|inc)\b/gi, " "),
          ...aliases,
          this.normalizeDomain(company.domain)?.split(".")[0]?.replace(/[-_]+/g, " ")
        ]
          .filter((value): value is string => Boolean(value))
          .map((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim())
          .filter((value) => value.length >= 6)
      )
    );
    if (normalizedPhrases.some((phrase) => normalizedHaystack.includes(phrase))) {
      return true;
    }

    const normalizedDomain = this.normalizeDomain(company.domain);
    const companyTokens = Array.from(
      new Set(
        [company.name, normalizedDomain ?? ""]
          .flatMap((value) => value.split(/[^a-z0-9]+/i))
          .map((token) => token.toLowerCase())
          .filter((token) => token.length >= 4 && !/^(https|www|linkedin|company|people|jobs|team|group|gmbh|ag|ug|ltd|llc|inc)$/i.test(token))
      )
    );

    if (companyTokens.length < 2) {
      return false;
    }

    return companyTokens.filter((token) => haystack.includes(token)).length >= Math.min(2, companyTokens.length);
  }

  private extractNameFromSearchTitle(title: string): { firstName?: string; lastName?: string } {
    const primarySegment = title
      .replace(/\|\s*LinkedIn.*$/i, "")
      .split(" - ")[0]
      ?.trim();
    if (!primarySegment) {
      return {};
    }

    const nameParts = primarySegment
      .split(/\s+/)
      .map((part) => part.replace(/[^A-Za-zÄÖÜäöüß'’-]/g, ""))
      .filter(Boolean);
    if (nameParts.length < 2) {
      return {};
    }

    const firstName = this.normalizeNamePart(nameParts[0]);
    const lastName = this.normalizeNamePart(nameParts[1]);
    if (!firstName || !lastName) {
      return {};
    }

    return { firstName, lastName };
  }

  private extractJobTitleFromSearchText(title: string, snippet: string): string | undefined {
    const directRole = PUBLIC_CONTACT_ROLE_PATTERNS.find((role) => new RegExp(`\\b${role}\\b`, "i").test(`${title} ${snippet}`));
    if (directRole) {
      return directRole;
    }

    const titleSegments = title.split(" - ").map((segment) => segment.trim()).filter(Boolean);
    const likelyTitle = titleSegments.find((segment, index) => index > 0 && segment.split(/\s+/).length <= 6 && !/linkedin/i.test(segment));
    return likelyTitle || undefined;
  }

  private async searchBingResults(query: string, maxResults: number): Promise<WebSearchHit[]> {
    const normalizedHits = (hits: WebSearchHit[]): WebSearchHit[] => {
      const seenUrls = new Set<string>();
      const normalizedResults: WebSearchHit[] = [];

      for (const hit of hits) {
        const normalizedUrl = this.normalizeSearchResultUrl(hit.url);
        if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
          continue;
        }

        seenUrls.add(normalizedUrl);
        normalizedResults.push({
          ...hit,
          url: normalizedUrl
        });

        if (normalizedResults.length >= maxResults) {
          break;
        }
      }

      return normalizedResults;
    };

    try {
      const response = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; LeadAgent/1.0; +https://leadagent-production-4555.up.railway.app)"
        },
        redirect: "follow",
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        return [];
      }

      const html = await response.text();
      const blocks = [...html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/gi)].map((match) => match[0]);
      const bingHtmlHits = blocks
        .map<WebSearchHit | null>((block) => {
          const url = block.match(/<a[^>]+href="([^"]+)"/i)?.[1];
          if (!url) {
            return null;
          }

          const title = this.decodeHtmlEntities(this.stripHtml(block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? "")).trim();
          const snippet = this.decodeHtmlEntities(
            this.stripHtml(block.match(/<div class="b_caption"[\s\S]*?<p>([\s\S]*?)<\/p>/i)?.[1] ?? block.match(/<p>([\s\S]*?)<\/p>/i)?.[1] ?? "")
          ).trim();

          return { url, title, snippet, query };
        })
        .filter((hit): hit is WebSearchHit => Boolean(hit))
        .filter((hit) => /^https?:\/\//i.test(hit.url));

      if (bingHtmlHits.length > 0 && !/Noch ein letzter Schritt|challenge|turnstile/i.test(html)) {
        const normalizedBingHits = normalizedHits(bingHtmlHits);
        const wantsLinkedInResults = /site:linkedin\.com\/(?:in|company)/i.test(query);
        if (!wantsLinkedInResults || normalizedBingHits.some((hit) => /linkedin\.com\/(?:in|company)\//i.test(hit.url))) {
          return normalizedBingHits;
        }

        const fallbackHits: WebSearchHit[] = [];
        fallbackHits.push(...(await this.searchBingRssResults(query, maxResults)));
        fallbackHits.push(...(await this.searchDuckDuckGoResults(query, maxResults)));
        return normalizedHits([...normalizedBingHits, ...fallbackHits]);
      }
    } catch {
      // Fall back to alternative search endpoints below.
    }

    const fallbackHits: WebSearchHit[] = [];
    fallbackHits.push(...(await this.searchBingRssResults(query, maxResults)));
    fallbackHits.push(...(await this.searchDuckDuckGoResults(query, maxResults)));
    return normalizedHits(fallbackHits);
  }

  private async searchBingRssResults(query: string, maxResults: number): Promise<WebSearchHit[]> {
    try {
      const response = await fetch(`https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; LeadAgent/1.0; +https://leadagent-production-4555.up.railway.app)"
        },
        redirect: "follow",
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        return [];
      }

      const xml = await response.text();
      return [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<\/item>/gi)]
        .map((match) => ({
          title: this.decodeHtmlEntities(match[1]).trim(),
          url: this.decodeHtmlEntities(match[2]).trim(),
          snippet: this.decodeHtmlEntities(match[3]).trim(),
          query
        }))
        .slice(0, maxResults);
    } catch {
      return [];
    }
  }

  private async searchDuckDuckGoResults(query: string, maxResults: number): Promise<WebSearchHit[]> {
    try {
      const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; LeadAgent/1.0; +https://leadagent-production-4555.up.railway.app)"
        },
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        return [];
      }

      const html = await response.text();
      const blocks = [...html.matchAll(/<div class="result results_links[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi)].map((match) => match[0]);
      return blocks
        .map<WebSearchHit | null>((block) => {
          const url = block.match(/class="result__a" href="([^"]+)"/i)?.[1] ?? block.match(/class="result__url" href="([^"]+)"/i)?.[1];
          if (!url) {
            return null;
          }

          const title = this.decodeHtmlEntities(this.stripHtml(block.match(/class="result__title">([\s\S]*?)<\/h2>/i)?.[1] ?? "")).trim();
          const snippet = this.decodeHtmlEntities(this.stripHtml(block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "")).trim();

          return {
            url,
            title,
            snippet,
            query
          };
        })
        .filter((hit): hit is WebSearchHit => Boolean(hit))
        .slice(0, maxResults);
    } catch {
      return [];
    }
  }

  private normalizeSearchResultUrl(url: string | undefined): string | undefined {
    const trimmed = url?.trim();
    if (!trimmed) {
      return undefined;
    }

    try {
      const parsed = new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);
      const redirected = parsed.searchParams.get("uddg");
      if (redirected) {
        return decodeURIComponent(redirected);
      }

      return parsed.toString();
    } catch {
      return undefined;
    }
  }

  private buildWebsiteEvidenceSnippet(url: string, html: string): string {
    const plainText = this.decodeHtmlEntities(this.stripHtml(html)).replace(/\s+/g, " ").trim();
    const relevantText = Array.from(
      new Set(
        [...plainText.matchAll(new RegExp(`[^.!?]{0,120}(?:${PUBLIC_CONTACT_ROLE_PATTERNS.join("|")})[^.!?]{0,120}`, "gi"))]
          .map((match) => match[0].trim())
          .filter(Boolean)
      )
    ).slice(0, 4);
    const linkedInUrls = Array.from(new Set((html.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/[^"]+/gi) ?? []).slice(0, 4)));
    const mailTos = Array.from(new Set((html.match(/mailto:([^"'>\s]+)/gi) ?? []).map((match) => match.replace(/^mailto:/i, "")).slice(0, 4)));

    return [
      `Page: ${url}`,
      relevantText.length > 0 ? `Relevant text: ${relevantText.join(" | ")}` : undefined,
      linkedInUrls.length > 0 ? `LinkedIn URLs: ${linkedInUrls.join(" | ")}` : undefined,
      mailTos.length > 0 ? `Emails: ${mailTos.join(" | ")}` : undefined
    ].filter(Boolean).join("\n");
  }

  private mergeDiscoveredContacts(
    primaryContacts: PublicContactCandidate[],
    additionalContacts: PublicContactCandidate[]
  ): PublicContactCandidate[] {
    const merged = [...primaryContacts];
    const seenKeys = new Set(primaryContacts.map((contact) => this.getPublicContactIdentity(contact)));

    for (const contact of additionalContacts) {
      const contactKey = this.getPublicContactIdentity(contact);
      if (seenKeys.has(contactKey)) {
        continue;
      }

      seenKeys.add(contactKey);
      merged.push(contact);
    }

    return merged;
  }

  private getPublicContactIdentity(contact: PublicContactCandidate): string {
    return [
      contact.email?.trim().toLowerCase(),
      contact.linkedinUrl?.trim().toLowerCase(),
      `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim().toLowerCase(),
      contact.phone?.trim(),
      contact.sourceUrl.trim().toLowerCase()
    ].filter(Boolean).join("::");
  }

  private async enrichContactWithLinkedInUrl(
    company: Pick<PreCategorizedCompany, "name" | "domain">,
    contact: PublicContactCandidate
  ): Promise<PublicContactCandidate> {
    if (contact.linkedinUrl) {
      return {
        ...contact,
        linkedinUrl: this.normalizeLinkedInUrl(contact.linkedinUrl)
      };
    }

    const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim();
    if (!fullName) {
      return contact;
    }

    const normalizedDomain = this.normalizeDomain(company.domain);
    const companyToken = normalizedDomain?.split(".")[0];
    const simplifiedCompanyToken = companyToken?.split(/[-_]/).filter(Boolean)[0];
    const simplifiedCompanyName = company.name.replace(/\b(ai|gmbh|ug|ag|ltd|llc|inc)\b/gi, "").replace(/\s+/g, " ").trim();

    const queries = [
      `site:linkedin.com/in "${fullName}" "${company.name}"`,
      simplifiedCompanyName && simplifiedCompanyName !== company.name ? `site:linkedin.com/in "${fullName}" "${simplifiedCompanyName}"` : undefined,
      companyToken ? `site:linkedin.com/in "${fullName}" "${companyToken}"` : undefined,
      simplifiedCompanyToken && simplifiedCompanyToken !== companyToken ? `site:linkedin.com/in "${fullName}" "${simplifiedCompanyToken}"` : undefined,
      contact.jobTitle ? `site:linkedin.com/in "${fullName}" "${company.name}" "${contact.jobTitle}"` : undefined,
      contact.jobTitle && simplifiedCompanyName && simplifiedCompanyName !== company.name ? `site:linkedin.com/in "${fullName}" "${simplifiedCompanyName}" "${contact.jobTitle}"` : undefined,
      `${fullName} linkedin ${company.name}`,
      simplifiedCompanyName && simplifiedCompanyName !== company.name ? `${fullName} linkedin ${simplifiedCompanyName}` : undefined,
      companyToken ? `${fullName} linkedin ${companyToken}` : undefined,
      simplifiedCompanyToken && simplifiedCompanyToken !== companyToken ? `${fullName} linkedin ${simplifiedCompanyToken}` : undefined,
      `site:linkedin.com/in "${fullName}" linkedin`
    ].filter((query): query is string => Boolean(query));

    for (const query of queries) {
      const hits = await this.searchBingResults(query, 3);
      const linkedInHit = hits.find((hit) => /linkedin\.com\/in\//i.test(hit.url));
      if (linkedInHit) {
        return {
          ...contact,
          linkedinUrl: this.normalizeLinkedInUrl(linkedInHit.url),
          sourceUrl: contact.sourceUrl || linkedInHit.url
        };
      }
    }

    return contact;
  }

  private getPublicContactScore(contact: PublicContactCandidate): number {
    let score = 0;

    if (contact.firstName || contact.lastName) {
      score += 4;
    }

    if (contact.linkedinUrl) {
      score += 4;
    }

    if (contact.email && !this.isGenericMailbox(contact.email)) {
      score += 5;
    } else if (contact.email) {
      score += 1;
    }

    if (contact.phone) {
      score += 1;
    }

    if (this.isPriorityContactTitle(contact.jobTitle)) {
      score += 4;
    }

    if (contact.label.includes("website")) {
      score += 1;
    }

    return score;
  }

  private isPriorityContactTitle(jobTitle: string | undefined): boolean {
    return Boolean(jobTitle && PUBLIC_CONTACT_ROLE_REGEX.test(jobTitle));
  }

  private inferJobTitleFromPageContext(html: string, anchor: string): string | undefined {
    const loweredHtml = html.toLowerCase();
    const loweredAnchor = anchor.toLowerCase();
    const matchIndex = loweredHtml.indexOf(loweredAnchor);
    if (matchIndex < 0) {
      return undefined;
    }

    const contextSnippet = html.slice(Math.max(0, matchIndex - 240), Math.min(html.length, matchIndex + 240));
    const plainText = this.decodeHtmlEntities(this.stripHtml(contextSnippet)).replace(/\s+/g, " ").trim();
    const matchedRole = PUBLIC_CONTACT_ROLE_PATTERNS.find((role) => new RegExp(role, "i").test(plainText));
    return matchedRole ? this.normalizeJobTitle(matchedRole) : undefined;
  }

  private normalizeJobTitle(jobTitle: string | undefined): string | undefined {
    const trimmed = jobTitle?.trim();
    if (!trimmed) {
      return undefined;
    }

    const matchedRole = PUBLIC_CONTACT_ROLE_PATTERNS.find((role) => new RegExp(`^${role}$`, "i").test(trimmed));
    return matchedRole ?? trimmed;
  }

  private extractLinkedInProfileUrlFromPage(html: string): string | undefined {
    const linkedInUrl = (html.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|company)\/[^\"'\s]+/i) ?? [])[0];
    return this.normalizeLinkedInUrl(linkedInUrl);
  }

  private normalizeLinkedInUrl(url: string | undefined): string | undefined {
    const trimmed = url?.trim();
    if (!trimmed) {
      return undefined;
    }

    try {
      const parsed = new URL(trimmed);
      const hostname = parsed.hostname.replace(/^www\./, "").toLowerCase();
      if (hostname !== "linkedin.com" && hostname !== "de.linkedin.com" && hostname !== "www.linkedin.com") {
        return undefined;
      }

      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().replace(/\/$/, "");
    } catch {
      return undefined;
    }
  }

  private stripHtml(value: string): string {
    return value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ");
  }

  private extractPlainTextLines(html: string): string[] {
    return this.decodeHtmlEntities(
      html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|h5|h6)>/gi, "\n")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
    )
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  private extractNamedContactsFromPage(url: string, html: string, fallbackPhone?: string, pageEmails: string[] = []): PublicContactCandidate[] {
    const lines = this.extractPlainTextLines(html);
    const contacts: PublicContactCandidate[] = [];
    const primaryEmail = pageEmails.find((email) => !this.isLowValueMailbox(email)) ?? pageEmails[0];
    const pageLinkedInUrl = this.extractLinkedInProfileUrlFromPage(html);

    for (let index = 0; index < lines.length - 1; index += 1) {
      const currentLine = lines[index] ?? "";
      const nextLine = lines[index + 1] ?? "";
      const normalizedRole = this.normalizeWebsiteRole(currentLine);
      const name = normalizedRole ? this.extractNameFromLine(nextLine) : null;
      if (!normalizedRole || !name) {
        continue;
      }

      contacts.push({
        firstName: name.firstName,
        lastName: name.lastName,
        jobTitle: normalizedRole,
        email: primaryEmail,
        phone: fallbackPhone,
        sourceUrl: url,
        label: "website_named_contact",
        linkedinUrl: pageLinkedInUrl
      });
    }

    for (let index = 0; index < lines.length - 2; index += 1) {
      const cueLine = lines[index] ?? "";
      if (!/ansprechpartner|ihr kontakt|kontaktperson|your contact|sales contact|vertrieb/i.test(cueLine)) {
        continue;
      }

      const name = this.extractNameFromLine(lines[index + 1] ?? "");
      if (!name) {
        continue;
      }

      contacts.push({
        firstName: name.firstName,
        lastName: name.lastName,
        jobTitle: this.normalizePotentialJobTitle(lines[index + 2] ?? "") ?? this.normalizePotentialJobTitle(cueLine),
        email: primaryEmail,
        phone: fallbackPhone,
        sourceUrl: url,
        label: "website_named_contact",
        linkedinUrl: pageLinkedInUrl
      });
    }

    for (const line of lines) {
      if (!/(geschäftsführung|geschaeftsfuehrung|managing directors?|represented by|vertretungsberechtigt)/i.test(line) && !/\bmanagement\b\s*[:\-]/i.test(line)) {
        continue;
      }

      const extractedNames = this.extractMultipleNamesFromManagementLine(line);
      for (const extractedName of extractedNames) {
        contacts.push({
          firstName: extractedName.firstName,
          lastName: extractedName.lastName,
          jobTitle: extractedName.jobTitle,
          email: primaryEmail,
          phone: fallbackPhone,
          sourceUrl: url,
          label: "website_named_contact",
          linkedinUrl: pageLinkedInUrl
        });
      }
    }

    return this.mergeDiscoveredContacts([], contacts);
  }

  private extractMultipleNamesFromManagementLine(line: string): Array<{ firstName?: string; lastName: string; jobTitle: string }> {
    const normalizedLine = line
      .replace(/Geschäftsführung/gi, "Management")
      .replace(/Geschaeftsfuehrung/gi, "Management")
      .replace(/Managing Directors?/gi, "Management")
      .replace(/represented by/gi, "Management")
      .replace(/vertretungsberechtigt/gi, "Management");
    const namesPart = normalizedLine.split(/:/, 2)[1]?.trim() ?? normalizedLine.replace(/^(Management)\s*/i, "").trim();
    if (!namesPart) {
      return [];
    }

    const extracted = namesPart
      .replace(/\b(Managing Director|Gesch[aä]ftsf[uü]hrer(?:in)?)\b/gi, ",")
      .replace(/([a-zäöüß])([A-ZÄÖÜ][a-zäöüß])/g, "$1, $2")
      .split(/,|;|\bund\b|&/i)
      .map((value) => value.replace(/\b(Prof\.?|Dr\.?|Dipl\.?-?Ing\.?|M\.Sc\.?|B\.Sc\.?|Management)\b/gi, " ").replace(/\s+/g, " ").trim())
      .map((value) => {
        const parsedName = this.extractNameFromLine(value)
          ?? this.extractNameFromLine(
            value
              .split(/\s+/)
              .slice(-2)
              .join(" ")
          );
        if (!parsedName) {
          return null;
        }

        return {
          firstName: parsedName.firstName,
          lastName: parsedName.lastName,
          jobTitle: "Managing Director"
        };
      });

    return extracted.filter((value) => Boolean(value)) as Array<{ firstName?: string; lastName: string; jobTitle: string }>;
  }

  private normalizeWebsiteRole(value: string): string | undefined {
    const trimmed = value.replace(/:$/, "").trim();
    if (!trimmed) {
      return undefined;
    }

    if (/vertreten durch|geschäftsführer/i.test(trimmed)) {
      return "Managing Director";
    }

    if (/ansprechpartner/i.test(trimmed)) {
      return this.normalizePotentialJobTitle(trimmed.replace(/^ihr\s+/i, "")) ?? "Contact person";
    }

    return PUBLIC_CONTACT_ROLE_REGEX.test(trimmed) ? this.normalizeJobTitle(trimmed) : undefined;
  }

  private normalizePotentialJobTitle(value: string): string | undefined {
    const trimmed = value.replace(/:$/, "").trim();
    if (!trimmed) {
      return undefined;
    }

    if (/^(kontakt|kontaktieren sie uns|e-mail schreiben|jetzt kontakt aufnehmen|qualit[aä]t|leistung|technologie)$/i.test(trimmed)) {
      return undefined;
    }

    if (trimmed.length > 80 || /@|\+\d|www\.|http/i.test(trimmed)) {
      return undefined;
    }

    return trimmed.split(/\s+/).length <= 8 ? trimmed : undefined;
  }

  private extractNameFromLine(value: string): { firstName: string; lastName: string } | null {
    const nameParts = value
      .split(/\s+/)
      .map((part) => part.replace(/[^A-Za-zÄÖÜäöüß'’-]/g, ""))
      .filter(Boolean);

    if (nameParts.length < 2 || nameParts.length > 3) {
      return null;
    }

    const firstName = this.normalizeNamePart(nameParts[0]);
    const lastName = nameParts
      .slice(1)
      .map((part) => this.normalizeNamePart(part))
      .filter((part): part is string => Boolean(part))
      .join(" ");
    if (!firstName || !lastName) {
      return null;
    }

    return { firstName, lastName };
  }

  private decodeHtmlEntities(value: string): string {
    return value
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">");
  }

  private async extractCompanyAddress(company: PreCategorizedCompany): Promise<ExtractedCompanyAddress | null> {
    if (!company.domain) {
      return this.extractCompanyAddressWithWebSearch(company);
    }

    const rootUrl = this.normalizeCompanyUrl(company.domain);
    const pages = await this.collectCandidatePages(rootUrl);

    for (const page of pages) {
      const extractedAddress = this.extractPostalAddress(page.html, company.country);
      if (extractedAddress) {
        return extractedAddress;
      }
    }

    const apolloAddress = await this.apolloClient.getOrganizationAddress(company);
    if (apolloAddress) {
      return {
        address: apolloAddress.address,
        city: apolloAddress.city,
        zip: apolloAddress.zip,
        state: apolloAddress.state,
        country: this.normalizeCountryName(apolloAddress.country) ?? company.country
      };
    }

    return this.extractCompanyAddressWithWebSearch(company);
  }

  private async extractCompanyAddressWithWebSearch(company: PreCategorizedCompany): Promise<ExtractedCompanyAddress | null> {
    const extractedAddress = await this.openAIWebSearchClient.findCompanyAddress(company);
    if (!extractedAddress) {
      return null;
    }

    return {
      address: extractedAddress.address,
      city: extractedAddress.city,
      zip: extractedAddress.zip,
      state: extractedAddress.state,
      country: this.normalizeCountryName(extractedAddress.country) ?? company.country
    };
  }

  private async collectCandidatePages(rootUrl: string): Promise<Array<{ url: string; html: string }>> {
    const visited = new Set<string>();
    const queue = [rootUrl];
    const pages: Array<{ url: string; html: string }> = [];

    while (queue.length > 0 && pages.length < 6) {
      const url = queue.shift();
      if (!url || visited.has(url)) {
        continue;
      }

      visited.add(url);
      const html = await this.fetchHtml(url);
      if (!html) {
        continue;
      }

      pages.push({ url, html });

      for (const link of this.extractRelevantLinks(rootUrl, html)) {
        if (!visited.has(link) && queue.length + pages.length < 12) {
          queue.push(link);
        }
      }
    }

    return pages;
  }

  private extractRelevantLinks(rootUrl: string, html: string): string[] {
    const root = new URL(rootUrl);
    const normalizedRootHost = this.normalizeDomain(root.host) ?? root.host.replace(/^www\./i, "").toLowerCase();
    const links = [...html.matchAll(/<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .map((match) => ({
        href: match[1],
        anchorText: this.decodeHtmlEntities(this.stripHtml(match[2] ?? "")).replace(/\s+/g, " ").trim()
      }))
      .map((link) => {
        try {
          const url = new URL(link.href, root).toString();
          const parsedUrl = new URL(url);
          const normalizedParsedHost = this.normalizeDomain(parsedUrl.host) ?? parsedUrl.host.replace(/^www\./i, "").toLowerCase();
          if (normalizedParsedHost !== normalizedRootHost) {
            return null;
          }

          if (parsedUrl.pathname === root.pathname && parsedUrl.hash) {
            return null;
          }

          const haystack = `${url} ${link.anchorText}`.toLowerCase();
          if (EXCLUDED_PAGE_PATTERNS.some((pattern) => haystack.includes(pattern))) {
            return null;
          }

          const score = HIGH_PRIORITY_PAGE_PATTERNS.some((pattern) => haystack.includes(pattern))
            ? 3
            : MEDIUM_PRIORITY_PAGE_PATTERNS.some((pattern) => haystack.includes(pattern))
              ? 1
              : 0;
          if (score === 0) {
            return null;
          }

          return { url, score, pathLength: new URL(url).pathname.length };
        } catch {
          return null;
        }
      })
      .filter((value): value is { url: string; score: number; pathLength: number } => Boolean(value))
      .sort((left, right) => right.score - left.score || left.pathLength - right.pathLength);

    return Array.from(
      new Set(links.map((link) => link.url))
    ).slice(0, 8);
  }

  private extractEmails(html: string, allowedDomains: Set<string>): string[] {
    return Array.from(
      new Set(
        [...html.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)]
          .map((match) => match[0].toLowerCase())
          .filter((email) => !email.endsWith('.png') && !email.endsWith('.jpg') && !email.endsWith('.jpeg') && !email.endsWith('.webp'))
          .filter((email) => this.isAllowedCompanyEmail(email, allowedDomains))
      )
    );
  }

  private extractPhones(html: string): string[] {
    const telLinks = Array.from(
      new Set(
        [...html.matchAll(/href=["']tel:([^"']+)["']/gi)]
          .map((match) => decodeURIComponent(match[1]).replace(/\s+/g, " ").trim())
          .filter((phone) => phone.replace(/\D/g, "").length >= 8)
      )
    );
    if (telLinks.length > 0) {
      return telLinks;
    }

    return Array.from(
      new Set(
        [...html.matchAll(/(?:\+|00)[0-9][0-9\s()\/-]{6,}[0-9]/g)]
          .map((match) => {
            const phone = match[0].replace(/\s+/g, " ").trim();
            const context = html.slice(Math.max(0, match.index - 60), Math.min(html.length, (match.index ?? 0) + phone.length + 60));
            return { phone, context };
          })
          .filter(({ phone, context }) => phone.replace(/\D/g, "").length >= 10 && /(tel|telefon|phone|mobile|mobil|call|kontakt|contact)/i.test(context))
          .map(({ phone }) => phone)
      )
    );
  }

  private buildAllowedEmailDomains(rootUrl: string): Set<string> {
    const hostname = new URL(rootUrl).hostname.toLowerCase().replace(/^www\./, "");
    const labels = hostname.split(".");
    const registrableDomain = labels.length >= 2 ? labels.slice(-2).join(".") : hostname;

    return new Set([hostname, registrableDomain]);
  }

  private isAllowedCompanyEmail(email: string, allowedDomains: Set<string>): boolean {
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain || domain === "example.com") {
      return false;
    }

    return [...allowedDomains].some((allowedDomain) => domain === allowedDomain || domain.endsWith(`.${allowedDomain}`));
  }

  private inferNameFromEmail(email: string): { firstName?: string; lastName?: string } {
    const localPart = (email.split("@")[0] ?? "").split("+")[0] ?? "";
    const normalized = localPart.replace(/[^a-z.\-_]/gi, "").toLowerCase();
    const separators = normalized.split(/[._-]+/).filter(Boolean);

    if (
      separators.length >= 2 &&
      this.isLikelyPersonNameToken(separators[0]) &&
      this.isLikelyPersonNameToken(separators[1])
    ) {
      return {
        firstName: this.toTitleCase(separators[0]),
        lastName: this.toTitleCase(separators[1])
      };
    }

    if (separators.length === 1 && this.isLikelyPersonNameToken(separators[0])) {
      return {
        firstName: this.toTitleCase(separators[0])
      };
    }

    return {};
  }

  private inferNameFromPageContext(html: string, email: string): { firstName?: string; lastName?: string } | null {
    const escapedEmail = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const anchorContextMatch = html.match(
      new RegExp(`([A-ZÄÖÜ][^<]{0,80})<a[^>]+href=["']mailto:${escapedEmail}["']`, "i")
    );
    if (anchorContextMatch) {
      const plainAnchorContext = anchorContextMatch[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const anchorNameMatch = plainAnchorContext.match(/([A-ZÄÖÜ][a-zäöüß'’-]{1,30})\s+([A-ZÄÖÜ][a-zäöüß'’-]{1,30})\s*$/);
      if (anchorNameMatch) {
        const firstName = this.normalizeNamePart(anchorNameMatch[1]);
        const lastName = this.normalizeNamePart(anchorNameMatch[2]);
        if (firstName && lastName) {
          return { firstName, lastName };
        }
      }
    }

    const loweredHtml = html.toLowerCase();
    const loweredEmail = email.toLowerCase();
    const matchIndex = loweredHtml.indexOf(loweredEmail);
    if (matchIndex < 0) {
      return null;
    }

    const contextSnippet = html.slice(Math.max(0, matchIndex - 220), matchIndex);
    const plainText = contextSnippet
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();

    const twoPartMatch = plainText.match(/([A-ZÄÖÜ][a-zäöüß'’-]{1,30})\s+([A-ZÄÖÜ][a-zäöüß'’-]{1,30})\s*$/);
    if (!twoPartMatch) {
      return null;
    }

    const firstName = this.normalizeNamePart(twoPartMatch[1]);
    const lastName = this.normalizeNamePart(twoPartMatch[2]);
    if (!firstName || !lastName) {
      return null;
    }

    return { firstName, lastName };
  }

  private extractPostalAddress(html: string, fallbackCountry?: string): ExtractedCompanyAddress | null {
    const plainText = html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\r/g, "")
      .replace(/[ \t]+/g, " ");

    const lines = plainText
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const postalMatch = line.match(/\b([A-Z]{0,2}[\- ]?\d{4,5})\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß'’\-. ]{1,60})\b/);
      if (!postalMatch) {
        continue;
      }

      const addressLine = lines[index - 1] ?? "";
      if (!/\d/.test(addressLine) || /(tel|phone|fax|mail|email|www\.|http|@)/i.test(addressLine)) {
        continue;
      }

      const countryLine = lines[index + 1] ?? "";
      return {
        address: addressLine,
        zip: postalMatch[1].replace(/\s+/g, " ").trim(),
        city: postalMatch[2].trim(),
        country: this.normalizeCountryName(countryLine) ?? fallbackCountry
      };
    }

    return null;
  }

  private normalizeCountryName(value: string | undefined): string | undefined {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }

    if (/deutschland|germany/.test(normalized)) {
      return "Germany";
    }

    if (/spain|españa|espana/.test(normalized)) {
      return "Spain";
    }

    if (/france|frankreich/.test(normalized)) {
      return "France";
    }

    if (/italy|italia/.test(normalized)) {
      return "Italy";
    }

    if (/netherlands|niederlande/.test(normalized)) {
      return "Netherlands";
    }

    if (/belgium|belgien|belgique/.test(normalized)) {
      return "Belgium";
    }

    if (/austria|österreich|osterreich/.test(normalized)) {
      return "Austria";
    }

    if (/switzerland|schweiz|suisse/.test(normalized)) {
      return "Switzerland";
    }

    return undefined;
  }

  private isGenericMailbox(email: string): boolean {
    return /^(info|sales|office|kontakt|contact|hello|team|support|service|mail)@/i.test(email);
  }

  private isLowValueMailbox(email: string): boolean {
    return /^(privacy|datenschutz|compliance|legal|impressum|career|careers|jobs|bewerbung|hr|people|invoice|billing)@/i.test(email);
  }

  private isLikelyPersonNameToken(value: string): boolean {
    const token = value.trim().toLowerCase();
    if (!/^[a-z]{2,20}$/.test(token)) {
      return false;
    }

    if ([
      "info",
      "sales",
      "office",
      "kontakt",
      "contact",
      "hello",
      "team",
      "support",
      "service",
      "mail",
      "admin",
      "marketing",
      "automail",
      "career",
      "careers",
      "jobs",
      "bewerbung",
      "hr",
      "people",
      "privacy",
      "datenschutz",
      "legal",
      "impressum",
      "invoice",
      "billing",
      "buchhaltung",
      "finance",
      "accounting",
      "einkauf",
      "purchase",
      "procurement",
      "noreply",
      "noreply",
      "robot",
      "automation",
      "vision",
      "systems",
      "solutions",
      "group",
      "company",
      "corp",
      "pcb"
    ].includes(token)) {
      return false;
    }

    return /[aeiouy]/.test(token);
  }

  private normalizeNamePart(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) {
      return undefined;
    }

    return this.isLikelyPersonNameToken(trimmed.toLowerCase()) ? this.toTitleCase(trimmed) : undefined;
  }

  private toTitleCase(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
  }

  private normalizeCompanyUrl(domain: string): string {
    return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
  }

  private async fetchHtml(url: string): Promise<string | null> {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; LeadAgent/1.0; +https://leadagent-production-4555.up.railway.app)"
        },
        redirect: "follow"
      });

      if (!response.ok) {
        return null;
      }

      return response.text();
    } catch {
      return null;
    }
  }

  private getNumericRanking(
    category: PreCategorizedCompany["category"],
    rankingType: "partner" | "serviceprovider" | "customer"
  ): number {
    if (rankingType === "partner") {
      switch (category) {
        case "camera_manufacturer_partner":
          return 10;
        case "software_platform_embedding":
          return 9;
        case "machine_builder_ai_enablement":
          return 9;
        case "integrator_vision_industrial_ai":
        case "integrator_relevant_focus":
          return 5;
        case "integrator_vision_ai_consulting":
          return 4;
        case "integrator_vision_ai_freelancer":
          return 3;
        case "integrator_general_ai":
          return 4;
        case "industrial_end_customer_scaled":
          return 3;
        default:
          return 1;
      }
    }

    if (rankingType === "serviceprovider") {
      switch (category) {
        case "integrator_vision_industrial_ai":
          return 10;
        case "integrator_relevant_focus":
          return 9;
        case "integrator_vision_ai_consulting":
          return 9;
        case "integrator_vision_ai_freelancer":
          return 8;
        case "integrator_general_ai":
          return 8;
        case "software_platform_embedding":
          return 4;
        case "camera_manufacturer_partner":
          return 3;
        case "industrial_end_customer_scaled":
        case "machine_builder_ai_enablement":
          return 2;
        default:
          return 1;
      }
    }

    switch (category) {
      case "industrial_end_customer_scaled":
        return 9;
      case "machine_builder_ai_enablement":
        return 5;
      case "integrator_vision_industrial_ai":
      case "integrator_relevant_focus":
        return 4;
      case "integrator_vision_ai_consulting":
        return 3;
      case "integrator_vision_ai_freelancer":
        return 2;
      case "integrator_general_ai":
        return 3;
      case "camera_manufacturer_partner":
      case "software_platform_embedding":
        return 2;
      default:
        return 1;
    }
  }

  private buildCompanyDescription(company: PreCategorizedCompany, brief: ResearchBrief | undefined): string {
    const hasSyntheticCrawlerSummary = /^open-crawler\s+(?:high-fit|review-fit)\s+score\s+\d+/i.test(company.shortDescription.trim());
    const sections = [
      brief?.isFallback ? undefined : brief?.overview,
      brief?.isFallback ? undefined : brief?.qualificationSummary,
      hasSyntheticCrawlerSummary ? undefined : company.shortDescription,
      company.rationale
    ]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));

    const uniqueSections = Array.from(new Set(sections));
    return uniqueSections.join(" ").slice(0, 1800);
  }

  private buildEmailOutreachNote(
    company: PreCategorizedCompany,
    contact: PublicContactCandidate,
    brief: ResearchBrief
  ): string | undefined {
    if (!brief.emailBody) {
      return undefined;
    }

    return this.buildOutreachNoteBody(
      "Email Outreach",
      this.personalizeOutreachMessage(brief.emailBody, contact, brief.outreachLanguage)
    );
  }

  private buildLinkedInOutreachNote(
    company: PreCategorizedCompany,
    contact: PublicContactCandidate,
    brief: ResearchBrief
  ): string | undefined {
    if (!brief.linkedInMessage) {
      return undefined;
    }

    const personalizedMessage = this.personalizeOutreachMessage(brief.linkedInMessage, contact, brief.outreachLanguage);
    const personalizedConnectionRequest = brief.linkedInConnectionRequest
      ? this.personalizeOutreachMessage(brief.linkedInConnectionRequest, contact, brief.outreachLanguage)
      : undefined;
    const connectionRequest = this.buildLinkedInConnectionRequest(personalizedConnectionRequest ?? personalizedMessage);
    const sections = [
      contact.linkedinUrl ? `LinkedIn URL: ${contact.linkedinUrl}` : undefined,
      connectionRequest ? `LinkedIn Vernetzungsanfrage (max. 200 Zeichen): ${connectionRequest}` : undefined,
      `LinkedIn Outreach: ${personalizedMessage}`
    ].filter(Boolean);

    return this.buildOutreachNoteBody("LinkedIn Outreach", sections.join("\n\n"));
  }

  private buildLinkedInConnectionRequest(message: string): string | undefined {
    const normalized = message
      .replace(/^Hallo [^,]+,\s*/i, "")
      .replace(/^Hello [^,]+,\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!normalized) {
      return undefined;
    }

    if (normalized.length <= 200) {
      return normalized;
    }

    const truncated = normalized.slice(0, 200);
    const lastWhitespace = truncated.lastIndexOf(" ");
    const safeCut = lastWhitespace >= 140 ? lastWhitespace : 197;
    return `${normalized.slice(0, safeCut).trim()}...`;
  }

  private buildPhoneOutreachNote(
    company: PreCategorizedCompany,
    contact: PublicContactCandidate,
    brief: ResearchBrief
  ): string | undefined {
    if (!brief.phoneScript) {
      return undefined;
    }

    return this.buildOutreachNoteBody(
      "Call Outreach",
      this.personalizeOutreachMessage(brief.phoneScript, contact, brief.outreachLanguage)
    );
  }

  private buildOutreachNoteBody(channelLabel: string, message: string): string {
    return `${this.escapeNoteHtml(channelLabel)}<br><br>${this.escapeNoteHtml(message).replace(/\n/g, "<br>")}`;
  }

  private formatContactDisplayName(contact: PublicContactCandidate): string {
    const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim();
    return fullName || contact.email || contact.label;
  }

  private personalizeOutreachMessage(
    message: string,
    contact: PublicContactCandidate,
    outreachLanguage: ResearchBrief["outreachLanguage"]
  ): string {
    const salutation = this.buildSuggestedSalutation(contact, outreachLanguage);

    return message
      .replace(/^Hallo Herr\/Frau \[Name\],?/m, salutation)
      .replace(/^Hello Mr\.\/Ms\. \[Name\],?/m, salutation)
      .replace(/Herr\/Frau \[Name\]/g, salutation.replace(/[,:]$/g, ""))
      .replace(/Mr\.\/Ms\. \[Name\]/g, salutation.replace(/[,:]$/g, ""))
      .replace(/\[Name\]/g, this.formatContactDisplayName(contact))
      .replace(/\[Your Name\] from ONE WARE/g, "ONE WARE")
      .replace(/\[Ihr Name\] von ONE WARE hier/g, "ONE WARE hier")
      .replace(/\[Ihr Name\] von ONE WARE/g, "ONE WARE")
      .replace(/\[Your Name\]/g, "ONE WARE")
      .replace(/\[Ihr Name\]/g, "ONE WARE");
  }

  private buildSuggestedSalutation(contact: PublicContactCandidate, outreachLanguage: ResearchBrief["outreachLanguage"]): string {
    const lastName = contact.lastName?.trim();
    const firstName = contact.firstName?.trim();

    if (outreachLanguage === "de") {
      if (lastName) {
        return `Hallo Herr/Frau ${lastName},`;
      }

      if (firstName) {
        return `Hallo ${firstName},`;
      }

      return "Hallo,";
    }

    if (firstName) {
      return `Hello ${firstName},`;
    }

    if (lastName) {
      return `Hello Mr./Ms. ${lastName},`;
    }

    return "Hello,";
  }

  private escapeNoteHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  private mapCompanyCategory(category: PreCategorizedCompany["category"]): string {
    switch (category) {
      case "integrator_vision_industrial_ai":
        return "integrator_vision_industrial_ai";
      case "integrator_vision_ai_consulting":
        return "integrator_vision_ai_consulting";
      case "integrator_vision_ai_freelancer":
        return "integrator_vision_ai_freelancer";
      case "integrator_general_ai":
        return "integrator_general_ai";
      case "integrator_relevant_focus":
        return "integrator_relevant_focus";
      case "industrial_end_customer_scaled":
        return "industrial_end_customer_scaled";
      case "camera_manufacturer_partner":
        return "camera_manufacturer_partner";
      case "machine_builder_ai_enablement":
        return "machine_builder_ai_enablement";
      case "software_platform_embedding":
        return "software_platform_embedding";
      case "other":
        return "other";
      case "irrelevant":
        return "other";
      default:
        return "other";
    }
  }

  private toNumericPropertyValue(value: number | undefined): string | undefined {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return undefined;
    }

    return String(Math.round(value * 100) / 100);
  }

  private async requestJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
    for (let attempt = 0; attempt <= HUBSPOT_MAX_RETRIES; attempt += 1) {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(HUBSPOT_REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${env.HUBSPOT_PRIVATE_APP_TOKEN}`,
          "Content-Type": "application/json",
          ...(init?.headers ?? {})
        }
      });

      if (response.ok) {
        if (response.status === 204) {
          return undefined as T;
        }

        return (await response.json()) as T;
      }

      const errorText = await response.text();
      if (response.status === 429 && attempt < HUBSPOT_MAX_RETRIES) {
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterMs = retryAfterHeader ? Number.parseFloat(retryAfterHeader) * 1000 : Number.NaN;
        const delayMs = Number.isFinite(retryAfterMs)
          ? retryAfterMs
          : HUBSPOT_RETRY_DELAYS_MS[Math.min(attempt, HUBSPOT_RETRY_DELAYS_MS.length - 1)];

        await this.delay(delayMs);
        continue;
      }

      throw new Error(`HubSpot request failed: ${response.status} ${errorText}`);
    }

    throw new Error("HubSpot request failed after retries.");
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async mapWithSearchInterval<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
    const results: T[] = [];

    for (let start = 0; start < tasks.length; start += concurrency) {
      const batch = tasks.slice(start, start + concurrency);
      results.push(...(await Promise.all(batch.map((task) => task()))));
      if (start + concurrency < tasks.length) {
        await this.delay(HUBSPOT_SEARCH_MIN_INTERVAL_MS);
      }
    }

    return results;
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown error";
  }
}