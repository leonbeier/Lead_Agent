import { env, readiness } from "../config";
import { ApolloClient } from "./apollo";
import { AzureOpenAIClient } from "./azure-openai";
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
  companyName?: string;
  address?: string;
  city?: string;
  zip?: string;
  state?: string;
  country?: string;
}

interface OfficialWebsiteCompanyProfile {
  companyName?: string;
  entityScope?: "exact_operating_entity" | "parent_group" | "brand_or_product" | "uncertain";
  searchAliases: string[];
  address?: string;
  city?: string;
  zip?: string;
  state?: string;
  country?: string;
  emails: string[];
  phones: string[];
  linkedInUrls: string[];
  sourceUrls: string[];
}

interface WebSearchHit {
  url: string;
  title: string;
  snippet: string;
  query: string;
}

export interface HubSpotContactPreview {
  skipped: boolean;
  skipReason?: string;
  normalizedContact: PublicContactCandidate | null;
  properties: Record<string, string>;
  outreachNote?: string;
}

export interface HubSpotSyncPreview {
  companyProperties: Record<string, string>;
  contacts: HubSpotContactPreview[];
}

export interface PublicContactDebugResult {
  aliases: string[];
  queries: string[];
  websitePages?: Array<{
    url: string;
    evidenceSnippet: string;
    emails: string[];
    phones: string[];
    linkedInProfileUrl?: string;
    namedContacts: unknown[];
  }>;
  hitGroups: Array<{
    query: string;
    hits: Array<{
      url: string;
      title: string;
      snippet: string;
    }>;
  }>;
  heuristicContacts: PublicContactCandidate[];
  selectedContacts: PublicContactCandidate[];
}

interface BrowserSearchArticle {
  url: string;
  title: string;
  snippet: string;
}

const HUBSPOT_MAX_RETRIES = 5;
const HUBSPOT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 12000];
const HUBSPOT_SEARCH_MIN_INTERVAL_MS = 250;
const HUBSPOT_BROWSER_TASK_MIN_INTERVAL_MS = 250;
const HUBSPOT_REQUEST_TIMEOUT_MS = 15000;
const HUBSPOT_ASSOCIATION_CONTACT_TO_PRIMARY_COMPANY = 1;
const HUBSPOT_ASSOCIATION_CONTACT_TO_COMPANY = 279;
const PUBLIC_CONTACT_WEB_SEARCH_TIMEOUT_MS = 240_000;
const PUBLIC_CONTACT_ENRICHMENT_TIMEOUT_MS = 5000;
const EXECUTION_CONTACT_PAGE_COLLECTION_TIMEOUT_MS = 60_000;
const EXECUTION_CONTACT_WEBSITE_EXTRACTION_TIMEOUT_MS = 45_000;
const CONTACT_SYNC_PER_COMPANY_CONCURRENCY = 2;
const PUBLIC_CONTACT_SEARCH_QUERY_CONCURRENCY = 2;
const DDG_BROWSER_SEARCH_TIMEOUT_MS = 30000;
const WEBSITE_BROWSER_FETCH_TIMEOUT_MS = 12000;
// Amount of real visible page text handed to the AI website profiler so it can read the legal
// company entity, postal address, and contact block itself (agent-first, no role-keyword pre-filter).
const WEBSITE_EVIDENCE_VISIBLE_TEXT_LIMIT = 4000;
const PUBLIC_CONTACT_MANAGER_PATTERNS = [
  "CEO",
  "Chief Executive Officer",
  "CTO",
  "Chief Technology Officer",
  "COO",
  "Chief Operating Officer",
  "Founder",
  "Co-Founder",
  "Owner",
  "Inhaber",
  "Geschäftsführer",
  "Geschäftsführerin",
  "Geschäftsführung",
  "Geschäftsleitung",
  "Vertreten durch",
  "Innovation Manager",
  "Partner Manager",
  "Technology Manager",
  "Operations Manager",
  "Managing Director",
  "Managing Partner",
  "Head of Engineering",
  "Head of Operations",
  "Head of Product",
  "Head of Technology",
  "Director",
  "VP",
  "Vice President"
];
const PUBLIC_CONTACT_DEVELOPER_PATTERNS = [
  "Software Developer",
  "Software Engineer",
  "Engineer",
  "Developer",
  "Pipeline Engineer",
  "Technical Director",
  "Technical Artist",
  "Machine Learning Engineer",
  "AI Engineer",
  "Computer Vision Engineer"
];
const buildPublicContactRoleRegex = (patterns: string[]) =>
  new RegExp(`\\b(?:${patterns.map((pattern) => pattern.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")).join("|")})\\b`, "i");
const PUBLIC_CONTACT_ROLE_PATTERNS = [...PUBLIC_CONTACT_MANAGER_PATTERNS, ...PUBLIC_CONTACT_DEVELOPER_PATTERNS];
const PUBLIC_CONTACT_ROLE_REGEX = buildPublicContactRoleRegex(PUBLIC_CONTACT_ROLE_PATTERNS);
const PUBLIC_CONTACT_MANAGER_REGEX = buildPublicContactRoleRegex(PUBLIC_CONTACT_MANAGER_PATTERNS);
const PUBLIC_CONTACT_DEVELOPER_REGEX = buildPublicContactRoleRegex(PUBLIC_CONTACT_DEVELOPER_PATTERNS);
const PUBLIC_CONTACT_EXCLUDED_REGEX = /\b(hr|human resources|recruit(ing|er)|talent|people ops|finance|legal|support|customer support|student|intern|marketing|sdr|bdr|account executive|sales representative)\b/i;
const HIGH_PRIORITY_PAGE_PATTERNS = ["contact", "kontakt", "impressum", "imprint", "legal", "legal notice", "legal-notice", "about", "team", "management", "ansprechpartner", "leadership", "people", "staff", "employee", "employees", "profil", "profile", "ueber-uns", "ueber uns", "about-us", "about us"];
// Legal/contact pages (impressum, imprint, contact) are frequently hosted on a separate
// company domain for sole proprietors, freelancers, and agencies (e.g. labview-freiberufler.de
// links its impressum at ak-concept.de/impressum). These are the only cross-domain links we
// allow the AI to see and follow, so the official legal entity, address, and reachable contacts
// are not lost behind a same-domain restriction.
const CROSS_DOMAIN_LEGAL_CONTACT_PATTERNS = ["impressum", "imprint", "legal-notice", "legal_notice", "legalnotice", "legal notice", "mentions-legales", "kontakt", "contact", "ansprechpartner"];
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
  private readonly searchResultCache = new Map<string, Promise<WebSearchHit[]>>();
  private readonly officialWebsiteProfileCache = new Map<string, Promise<OfficialWebsiteCompanyProfile | null>>();
  private readonly candidatePagesCache = new Map<string, Promise<Array<{ url: string; html: string }>>>();
  private readonly fetchHtmlCache = new Map<string, Promise<string | null>>();
  private readonly apolloClient = new ApolloClient();

  private readonly azureOpenAIClient = new AzureOpenAIClient();

  private readonly foundryAgentsClient = new FoundryAgentsClient();

  private readonly openAIWebSearchClient = new OpenAIWebSearchClient();

  private searchRequestQueue = Promise.resolve();
  private browserTaskQueue = Promise.resolve();

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

  async discoverPublicContactsForExecution(
    company: PreCategorizedCompany,
    options: { selectedContactsTimeoutMs?: number } = {}
  ): Promise<PublicContactCandidate[]> {
    if (!company.domain) {
      return this.discoverWebSearchContacts(company, []);
    }

    const pages = await this.withTimeout(
      this.collectCandidatePages(this.normalizeCompanyUrl(company.domain)).catch(() => [] as Array<{ url: string; html: string }>),
      EXECUTION_CONTACT_PAGE_COLLECTION_TIMEOUT_MS,
      [] as Array<{ url: string; html: string }>
    );
    const websiteContacts = await this.withTimeout(
      this.extractWebsiteContactsFromPages(company, pages, undefined, { includeOfficialWebsiteSearch: false }).catch(() => [] as PublicContactCandidate[]),
      EXECUTION_CONTACT_WEBSITE_EXTRACTION_TIMEOUT_MS,
      [] as PublicContactCandidate[]
    );
    const fallbackSelectedContacts = this.selectReachableWebsiteFallbackContacts(websiteContacts).slice(0, 4);
    const contactDiscoveryFallback = this.buildTimeoutFallbackPublicContacts([
      ...websiteContacts,
      ...fallbackSelectedContacts
    ]);

    const selectedContacts = options.selectedContactsTimeoutMs
      ? await this.withTimeout(
          this.findPublicContactsFromPages(company, pages, websiteContacts).catch((err) => {
            console.error(`[discoverPublicContactsForExecution] findPublicContactsFromPages error for ${company.name}: ${err instanceof Error ? err.message : String(err)}`);
            return contactDiscoveryFallback;
          }),
          options.selectedContactsTimeoutMs,
          contactDiscoveryFallback
        )
      : await this.findPublicContactsFromPages(company, pages, websiteContacts).catch((err) => {
          console.error(`[discoverPublicContactsForExecution] findPublicContactsFromPages error for ${company.name}: ${err instanceof Error ? err.message : String(err)}`);
          return contactDiscoveryFallback;
        });

    // Guarantee the reachable website mailbox/phone is never lost when the richer LinkedIn/named
    // discovery times out or returns empty: fall back to the deterministic website contact.
    return selectedContacts.length > 0 ? selectedContacts : contactDiscoveryFallback;
  }

  async previewHubSpotSync(
    company: PreCategorizedCompany,
    brief: ResearchBrief | undefined,
    contacts: PublicContactCandidate[],
    options: {
      includeAddressLookup?: boolean;
      extractedAddress?: {
        address?: string;
        city?: string;
        zip?: string;
        state?: string;
        country?: string;
      } | null;
    } = {}
  ): Promise<HubSpotSyncPreview> {
    const extractedAddress = options.includeAddressLookup
      ? (options.extractedAddress ?? await this.extractCompanyAddress(company))
      : null;
    const companyProperties = this.stripUndefinedProperties(this.buildRawCompanyProperties(company, brief, extractedAddress));

    const contactPreviews = contacts.map((contact) => {
      const normalizedContact = this.normalizeContactForHubSpot(contact);
      if (!normalizedContact) {
        return {
          skipped: true,
          skipReason: "Contact has no reachable identity.",
          normalizedContact: null,
          properties: {}
        } satisfies HubSpotContactPreview;
      }

      if (
        this.shouldSkipHubSpotContact(normalizedContact)
      ) {
        return {
          skipped: true,
          skipReason: "Generic mailbox without person identity or phone is skipped.",
          normalizedContact,
          properties: {}
        } satisfies HubSpotContactPreview;
      }

      return {
        skipped: false,
        normalizedContact,
        properties: this.stripUndefinedProperties(this.buildRawContactProperties(normalizedContact)),
        outreachNote: brief ? this.buildCombinedOutreachNote(company, normalizedContact, brief) : undefined
      } satisfies HubSpotContactPreview;
    });

    return {
      companyProperties,
      contacts: contactPreviews
    };
  }

  async resolveCompanyAddress(company: PreCategorizedCompany): Promise<ExtractedCompanyAddress | null> {
    return this.extractCompanyAddress(company);
  }

  async debugResolveCompanyIdentity(company: PreCategorizedCompany): Promise<{
    officialWebsiteProfile: OfficialWebsiteCompanyProfile | null;
    legalEntityCandidates: string[];
    isTrustedOfficialWebsiteProfile: boolean;
  }> {
    const officialWebsiteProfile = company.domain
      ? await this.getOfficialWebsiteCompanyProfile(company).catch(() => null)
      : null;
    const pages = company.domain
      ? await this.collectCandidatePages(this.normalizeCompanyUrl(company.domain)).catch(() => [] as Array<{ url: string; html: string }>)
      : [];
    return {
      officialWebsiteProfile,
      legalEntityCandidates: this.extractLegalEntityCandidatesFromPages(company, pages),
      isTrustedOfficialWebsiteProfile: officialWebsiteProfile
        ? this.isTrustedOfficialWebsiteProfile(officialWebsiteProfile, company)
        : false
    };
  }

  async debugPublicContactDiscovery(
    company: PreCategorizedCompany,
    options: { selectedContactsTimeoutMs?: number } = {}
  ): Promise<PublicContactDebugResult> {
    const pages = company.domain
      ? await this.withTimeout(
          this.collectCandidatePages(this.normalizeCompanyUrl(company.domain)).catch(() => [] as Array<{ url: string; html: string }>),
          EXECUTION_CONTACT_PAGE_COLLECTION_TIMEOUT_MS,
          [] as Array<{ url: string; html: string }>
        )
      : [];
    const officialWebsiteProfile = company.domain
      ? await this.withTimeout(
          this.getOfficialWebsiteCompanyProfile(company).catch(() => null),
          EXECUTION_CONTACT_PAGE_COLLECTION_TIMEOUT_MS,
          null as OfficialWebsiteCompanyProfile | null
        )
      : null;
    const aliases = this.extractCompanySearchAliases(company, pages, officialWebsiteProfile);
    const websitePages = this.buildWebsitePageDebugEntries(company, pages);
    const { queries, hitGroups, contacts: llmContacts } = await this.extractAzureMatchedContacts(company, pages, aliases, websitePages);
    const websiteContacts = await this.extractWebsiteContactsFromPages(company, pages);
    const fallbackSelectedContacts = llmContacts.length > 0
      ? llmContacts.slice(0, 4)
      : this.selectReachableWebsiteFallbackContacts(websiteContacts).slice(0, 4);
    const selectedContacts = options.selectedContactsTimeoutMs
      ? await this.withTimeout(
          this.findPublicContactsFromPages(company, pages, websiteContacts, llmContacts),
          options.selectedContactsTimeoutMs,
          fallbackSelectedContacts
        )
      : await this.findPublicContactsFromPages(company, pages, websiteContacts, llmContacts);

    return {
      aliases,
      queries,
      websitePages,
      hitGroups: hitGroups.map((group) => ({
        query: group.query,
        hits: group.hits.map((hit) => ({
          url: hit.url,
          title: hit.title,
          snippet: hit.snippet
        }))
      })),
      heuristicContacts: llmContacts,
      selectedContacts
    };
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
          const contactResults = await this.mapWithConcurrency(
            selectedContacts.map((publicContact) => async () => {
              try {
                const syncedContact = await this.upsertContact(publicContact, contactProperties, syncedCompany.id);
                if (!syncedContact) {
                  return 0;
                }

                await this.associateContactToCompany(syncedContact.id, syncedCompany.id);
                await this.createOutreachNotes(syncedCompany.id, syncedContact.id, company, publicContact, brief);
                return 1;
              } catch (error) {
                errors.push(`${company.name}: ${this.toErrorMessage(error)}`);
                return 0;
              }
            }),
            CONTACT_SYNC_PER_COMPANY_CONCURRENCY
          );
          contactSyncedCount = contactResults.reduce<number>((sum, value) => sum + value, 0);
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

  private async upsertCompany(
    company: PreCategorizedCompany,
    brief: ResearchBrief | undefined,
    availableProperties: Set<string>
  ): Promise<HubSpotObjectResponse> {
    // Cap address extraction so that slow Azure AI retries or hung browser fetches
    // do not consume the entire HubSpot worker budget (360 s).  Address data is
    // enrichment; missing it is acceptable — the company record must still be written.
    const extractedAddress = await this.withTimeout(
      this.extractCompanyAddress(company),
      90_000,
      null
    );

    const properties = this.pickAvailableProperties(
      this.buildRawCompanyProperties(company, brief, extractedAddress),
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
    availableProperties: Set<string>,
    companyId?: string
  ): Promise<HubSpotObjectResponse | null> {
    const normalizedContact = this.normalizeContactForHubSpot(contact);
    if (!normalizedContact) {
      return null;
    }

    if (
      this.shouldSkipHubSpotContact(normalizedContact)
    ) {
      return null;
    }

    const properties = this.pickAvailableProperties(
      this.buildRawContactProperties(normalizedContact),
      availableProperties
    );

    if (Object.keys(properties).length === 0 || (!properties.email && !properties.firstname && !properties.lastname && !properties.hs_linkedin_url)) {
      return null;
    }

    const existingContact = await this.findExistingContact(normalizedContact, availableProperties);
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
      body: JSON.stringify({
        properties,
        ...(companyId
          ? {
              associations: [
                {
                  to: {
                    id: companyId
                  },
                  types: [
                    {
                      associationCategory: "HUBSPOT_DEFINED",
                      associationTypeId: HUBSPOT_ASSOCIATION_CONTACT_TO_PRIMARY_COMPANY
                    },
                    {
                      associationCategory: "HUBSPOT_DEFINED",
                      associationTypeId: HUBSPOT_ASSOCIATION_CONTACT_TO_COMPANY
                    }
                  ]
                }
              ]
            }
          : {})
      })
    });
  }

  private normalizeContactForHubSpot(contact: PublicContactCandidate): PublicContactCandidate | null {
    const rawEmail = contact.email?.trim().toLowerCase();
    // Reject emails with percent-encoded characters or non-ASCII/non-standard whitespace in the local part.
    // Covers artifacts like "%20khe@..." (URL-encoded) and "\u00a0info@..." (&nbsp; from HTML).
    const emailLocalPart = rawEmail?.split("@")[0] ?? "";
    const email = rawEmail && (/%[0-9a-f]{2}/i.test(emailLocalPart) || /[^\x20-\x7e]/.test(emailLocalPart)) ? undefined : rawEmail;
    const linkedinUrl = this.normalizeLinkedInUrl(contact.linkedinUrl);
    const firstName = this.normalizeNamePart(contact.firstName);
    const lastName = this.normalizeNamePart(contact.lastName);
    const hasReachableIdentity = Boolean(email || linkedinUrl || firstName || lastName);
    if (!hasReachableIdentity) {
      return null;
    }

    return {
      ...contact,
      email,
      linkedinUrl,
      firstName,
      lastName
    };
  }

  private shouldSkipHubSpotContact(contact: PublicContactCandidate): boolean {
    return Boolean(
      contact.email
      && this.isGenericMailbox(contact.email)
      && !contact.firstName
      && !contact.lastName
      && !contact.linkedinUrl
      && !contact.phone
    );
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

    const combinedNote = this.buildCombinedOutreachNote(company, contact, brief);
    if (combinedNote) {
      await this.createAssociatedNote(companyId, contactId, combinedNote);
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
    for (const domainVariant of this.buildCompanyDomainSearchVariants(company.domain)) {
      const byDomain = await this.searchObject("companies", "domain", domainVariant);
      if (byDomain) {
        return byDomain;
      }
    }

    return this.searchObject("companies", "name", company.name);
  }

  private async findExistingContact(
    contact: PublicContactCandidate,
    availableProperties: Set<string>
  ): Promise<HubSpotObjectResponse | null> {
    if (contact.email) {
      const byEmail = await this.searchObject("contacts", "email", contact.email);
      if (byEmail) {
        return byEmail;
      }
    }

    if (contact.linkedinUrl && availableProperties.has("hs_linkedin_url")) {
      const byLinkedIn = await this.searchObject("contacts", "hs_linkedin_url", contact.linkedinUrl);
      if (byLinkedIn) {
        return byLinkedIn;
      }
    }

    if (contact.firstName && contact.lastName) {
      return this.searchContactByName(contact.firstName, contact.lastName);
    }

    return null;
  }

  private async searchContactByName(firstName: string, lastName: string): Promise<HubSpotObjectResponse | null> {
    const response = await this.scheduleSearchRequest(() =>
      this.requestJson<{ results?: HubSpotObjectResponse[] }>(
        `${env.HUBSPOT_BASE_URL}/crm/v3/objects/contacts/search`,
        {
          method: "POST",
          body: JSON.stringify({
            limit: 1,
            filterGroups: [
              {
                filters: [
                  {
                    propertyName: "firstname",
                    operator: "EQ",
                    value: firstName
                  },
                  {
                    propertyName: "lastname",
                    operator: "EQ",
                    value: lastName
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

  private buildCompanyDomainSearchVariants(domain: string | undefined): string[] {
    const normalizedDomain = this.normalizeDomain(domain);
    if (!normalizedDomain) {
      return [];
    }

    // HubSpot stores the domain property without scheme in modern records, but older records
    // may have been stored with a protocol or www prefix. Search the four most common forms.
    // Capped at 4 variants (down from 7) to avoid 429 rate-limit cascades from serialized
    // HubSpot search requests.
    return [
      normalizedDomain,
      `www.${normalizedDomain}`,
      `https://${normalizedDomain}`,
      `https://www.${normalizedDomain}`
    ];
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
    const normalizedTargetIndustry = this.toSingleLineText(targetIndustry) ?? "";
    const normalized = `${normalizedTargetIndustry} ${companyDescription}`.toLowerCase();
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

    return HUBSPOT_STANDARD_INDUSTRIES.has(normalizedTargetIndustry)
      ? normalizedTargetIndustry
      : undefined;
  }

  private buildRawCompanyProperties(
    company: PreCategorizedCompany,
    brief: ResearchBrief | undefined,
    extractedAddress: ExtractedCompanyAddress | null
  ): Record<string, string | undefined> {
    const companyDescription = this.buildCompanyDescription(company, brief);
    const rawExtractedName = extractedAddress?.companyName?.trim();
    // Reject extracted company names that are longer than 120 chars or contain sentence-like
    // boilerplate text (e.g. Impressum paragraphs mistakenly captured as company name).
    // Reject names that are clearly sentence fragments: contain sentence-ending punctuation
    // (period/exclamation/question mark followed by a space and another word, indicating prose),
    // are very long, or have too many space-separated words (real company names rarely exceed 8).
    // Note: "CO. KG", "GmbH & Co. KG", "e.K." etc. contain periods that are part of the legal
    // form abbreviation and must NOT be rejected.
    const wordCount = rawExtractedName ? rawExtractedName.trim().split(/\s+/).length : 0;
    const looksLikeSentence = rawExtractedName
      ? /[.!?]\s+[a-zäöü]/.test(rawExtractedName) || /^[a-zäöü]/.test(rawExtractedName)
      : false;
    const isPlausibleExtractedName = rawExtractedName
      && rawExtractedName.length <= 80
      && wordCount <= 8
      && !looksLikeSentence;
    const canonicalCompanyName = (isPlausibleExtractedName ? rawExtractedName : undefined) || company.name;

    return {
      name: canonicalCompanyName,
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
      ai_cc_customer_products_offered: this.toSingleLineText(brief?.productsOffered),
      ai_cc_customer_target_industry: this.toSingleLineText(brief?.targetIndustry)
    };
  }

  private buildRawContactProperties(contact: PublicContactCandidate): Record<string, string | undefined> {
    return {
      email: contact.email,
      firstname: contact.firstName,
      lastname: contact.lastName,
      phone: contact.phone,
      jobtitle: contact.jobTitle,
      hs_linkedin_url: contact.linkedinUrl,
      linkedinconnections: this.toNumericPropertyValue(contact.linkedinConnectionCount),
      hs_lead_status: "NEW",
      lead_source: "AI Agent",
      lead_source_details: "AI Agent"
    };
  }

  private stripUndefinedProperties(properties: Record<string, string | undefined>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(properties).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
    );
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

    const pages = await this.collectCandidatePages(this.normalizeCompanyUrl(company.domain));
    return this.findPublicContactsFromPages(company, pages);
  }

  private async findPublicContactsFromPages(
    company: PreCategorizedCompany,
    pages: Array<{ url: string; html: string }>,
    seedWebsiteContacts?: PublicContactCandidate[],
    seedAzureContacts?: PublicContactCandidate[]
  ): Promise<PublicContactCandidate[]> {
    if (!company.domain) {
      return this.discoverWebSearchContacts(company, pages);
    }

    const officialWebsiteProfile = pages.length > 0
      ? await this.getOfficialWebsiteCompanyProfile(company).catch(() => null)
      : null;
    const officialWebsiteFallbackContacts = pages.length === 0
      ? await this.discoverOfficialWebsiteSearchContacts(company, officialWebsiteProfile)
      : [];
    const websiteContacts = this.mergeDiscoveredContacts(
      officialWebsiteFallbackContacts,
      seedWebsiteContacts ?? await this.extractWebsiteContactsFromPages(company, pages, officialWebsiteProfile)
    );
    const reachableWebsiteFallbackContacts = this.selectReachableWebsiteFallbackContacts(websiteContacts).slice(0, 2);

    if (pages.length === 0 && officialWebsiteFallbackContacts.length > 0 && (seedWebsiteContacts?.length ?? 0) === 0 && reachableWebsiteFallbackContacts.length > 0) {
      const linkedInFallbackContacts = (await this.withTimeout(
        this.discoverWebSearchContacts(company, pages, websiteContacts, officialWebsiteProfile),
        PUBLIC_CONTACT_WEB_SEARCH_TIMEOUT_MS,
        [] as PublicContactCandidate[]
      ))
        .filter((contact) => contact.label === "linkedin_profile" || this.isPersonalLinkedInUrl(contact.linkedinUrl))
        .slice(0, Math.max(0, 4 - reachableWebsiteFallbackContacts.length));

      return this.mergeDiscoveredContacts(linkedInFallbackContacts, reachableWebsiteFallbackContacts).slice(0, 4);
    }

    const websitePages = this.buildWebsitePageDebugEntries(company, pages);
    const azureMatchedContacts = seedAzureContacts ?? (await this.extractAzureMatchedContacts(
      company,
      pages,
      this.extractCompanySearchAliases(company, pages, officialWebsiteProfile),
      websitePages,
      officialWebsiteProfile
    )).contacts;
    const normalizedAzureContacts = this.collapseDuplicateMailboxContacts(
      azureMatchedContacts.map((contact) => ({
        ...contact,
        jobTitle: this.normalizeJobTitle(contact.jobTitle) ?? contact.jobTitle,
        linkedinUrl: this.normalizeLinkedInUrl(contact.linkedinUrl),
        sourceUrl: contact.sourceUrl || contact.linkedinUrl || company.domain || company.name,
        label: this.normalizeAzureContactLabel(contact)
      }))
    ).filter((contact) => !this.isLowValueMailbox(contact.email ?? ""));

    const websiteFallbackContacts = reachableWebsiteFallbackContacts;

    if (normalizedAzureContacts.length > 0) {
      // When the AI extracted contacts from website pages but none have a LinkedIn profile,
      // supplement with LinkedIn people via the Foundry bing_grounding agent so named employees
      // (e.g. Norbert Kalkert GF for tesium.com) are added on top of /kontakt/ page contacts.
      const hasLinkedInProfile = normalizedAzureContacts.some(
        (contact) => contact.label === "linkedin_profile" || this.isPersonalLinkedInUrl(contact.linkedinUrl)
      );
      const spotsLeft = 4 - Math.min(normalizedAzureContacts.length, 4);
      if (!hasLinkedInProfile && spotsLeft > 0) {
        const linkedInPeople = (await this.withTimeout(
          this.discoverWebSearchContacts(company, pages, normalizedAzureContacts, officialWebsiteProfile),
          PUBLIC_CONTACT_WEB_SEARCH_TIMEOUT_MS,
          [] as PublicContactCandidate[]
        ))
          .filter((contact) => contact.label === "linkedin_profile" || this.isPersonalLinkedInUrl(contact.linkedinUrl))
          .slice(0, spotsLeft);
        if (linkedInPeople.length > 0) {
          return this.composeFinalPublicContacts(
            this.mergeDiscoveredContacts(linkedInPeople, normalizedAzureContacts).slice(0, 4),
            this.mergeDiscoveredContacts(normalizedAzureContacts, websiteFallbackContacts)
          ).slice(0, 4);
        }
      }
      return this.composeFinalPublicContacts(
        normalizedAzureContacts.slice(0, 4),
        this.mergeDiscoveredContacts(normalizedAzureContacts, websiteFallbackContacts)
      ).slice(0, 4);
    }

    const expandedWebsiteFallbackContacts = websiteFallbackContacts.slice(0, 4);
    const namedWebsiteFallbackContacts = websiteContacts
      .filter((contact) => this.isNamedFallbackContact(contact))
      .filter((contact) => !expandedWebsiteFallbackContacts.some((existing) => this.getPublicContactIdentity(existing) === this.getPublicContactIdentity(contact)))
      .sort((left, right) => this.getPublicContactScore(right) - this.getPublicContactScore(left))
      .slice(0, Math.max(0, 4 - expandedWebsiteFallbackContacts.length));

    // Always attempt LinkedIn discovery even when we already have generic website contacts.
    // A generic info@ mailbox must not block named employee profiles from Bing/LinkedIn.
    const knownFallbackContacts = this.mergeDiscoveredContacts(namedWebsiteFallbackContacts, expandedWebsiteFallbackContacts);
    const spotsLeft = 4 - knownFallbackContacts.length;
    const webSearchContacts = await this.withTimeout(
      this.discoverWebSearchContacts(company, pages, websiteContacts, officialWebsiteProfile),
      PUBLIC_CONTACT_WEB_SEARCH_TIMEOUT_MS,
      [] as PublicContactCandidate[]
    );
    const linkedInFallbackContacts = webSearchContacts
      .filter((contact) => contact.label === "linkedin_profile" || this.isPersonalLinkedInUrl(contact.linkedinUrl))
      .slice(0, Math.max(0, spotsLeft));

    return this.mergeDiscoveredContacts(
      namedWebsiteFallbackContacts,
      this.mergeDiscoveredContacts(linkedInFallbackContacts, expandedWebsiteFallbackContacts)
    ).slice(0, 4);
  }

  private async extractAzureMatchedContacts(
    company: Pick<PreCategorizedCompany, "name" | "domain" | "country" | "category">,
    pages: Array<{ url: string; html: string }>,
    aliases: string[],
    websitePages?: Array<{
      url: string;
      evidenceSnippet: string;
      emails: string[];
      phones: string[];
      linkedInProfileUrl?: string;
      namedContacts: unknown[];
    }>,
    officialWebsiteProfile?: OfficialWebsiteCompanyProfile | null
  ): Promise<{
    queries: string[];
    hitGroups: Array<{
      query: string;
      hits: WebSearchHit[];
    }>;
    contacts: PublicContactCandidate[];
  }> {
    const normalizedWebsitePages: Array<{
      url: string;
      evidenceSnippet: string;
      emails: string[];
      phones: string[];
      linkedInProfileUrl?: string;
      namedContacts: unknown[];
    }> = websitePages ?? this.buildWebsitePageDebugEntries(company, pages) ?? [];
    // Agent-first: let the Foundry query planner propose the LinkedIn people-search queries from
    // the website evidence and the validated company aliases. The deterministic combinatorial
    // builder only supplements/falls back when the planner is unavailable.
    //
    // When the Azure website profiler has identified the exact legal operating entity
    // (entityScope=exact_operating_entity), use that AI-extracted name as the company name for
    // Foundry agents. This avoids Foundry searching for a marketing-label company name
    // (e.g. "LabVIEW Freelancer & Experte...") instead of the real entity ("AK-concept").
    const aiEntityName = officialWebsiteProfile?.entityScope === "exact_operating_entity"
      ? officialWebsiteProfile.companyName?.trim()
      : undefined;
    const foundryCompany = aiEntityName && aiEntityName !== company.name
      ? { ...company, name: aiEntityName }
      : company;
    const queryPlanningEvidence = [
      normalizedWebsitePages
        .map((page) => page.evidenceSnippet)
        .filter(Boolean)
        .slice(0, 4)
        .join("\n\n"),
      aliases.length > 0 ? `Company aliases: ${aliases.join(" | ")}` : undefined
    ].filter(Boolean).join("\n\n");
    // Query planning only — 60 s is ample. Do not use the full web-search timeout here or
    // the budget is consumed before discoverWebSearchContacts even starts.
    const suggestedLinkedInQueries = (await this.withTimeout(
      this.foundryAgentsClient.suggestPublicContactQueries(foundryCompany, queryPlanningEvidence, false),
      60_000,
      [] as string[]
    )).filter((query) => /site:linkedin\.com\/in/i.test(query));
    const deterministicLinkedInQueries = this.buildPublicContactSearchQueries(company, aliases)
      .filter((query) => /site:linkedin\.com\/in/i.test(query));
    const queries = Array.from(new Set([...suggestedLinkedInQueries, ...deterministicLinkedInQueries]))
      .slice(0, 10);
    const hitGroups = await this.mapWithSearchInterval(
      queries.map((query) => async () => ({
        query,
        hits: await this.searchBingResults(query, 5)
      })),
      PUBLIC_CONTACT_SEARCH_QUERY_CONCURRENCY
    );
    const contacts = await this.azureOpenAIClient.extractPublicContactsFromEvidence(foundryCompany, {
      websitePages: normalizedWebsitePages.map((page) => ({
        url: page.url,
        evidenceSnippet: page.evidenceSnippet,
        emails: page.emails,
        phones: page.phones,
        linkedInProfileUrl: page.linkedInProfileUrl
      })),
      hitGroups: hitGroups.map((group) => ({
        query: group.query,
        hits: group.hits.map((hit) => ({
          url: hit.url,
          title: hit.title,
          snippet: hit.snippet
        }))
      }))
    }, false);

    return {
      queries,
      hitGroups,
      contacts
    };
  }

  private async extractWebsiteContactsFromPages(
    company: Pick<PreCategorizedCompany, "name" | "domain" | "country">,
    pages: Array<{ url: string; html: string }>,
    officialWebsiteProfile?: OfficialWebsiteCompanyProfile | null,
    options: { includeOfficialWebsiteSearch?: boolean } = {}
  ): Promise<PublicContactCandidate[]> {
    if (!company.domain) {
      return [];
    }

    const includeOfficialWebsiteSearch = options.includeOfficialWebsiteSearch ?? true;

    const rootUrl = this.normalizeCompanyUrl(company.domain);
    const allowedEmailDomains = this.buildAllowedEmailDomains(rootUrl);
    const candidates = new Map<string, PublicContactCandidate>();
    const namedWebsiteContacts: PublicContactCandidate[] = [];

    for (const page of pages) {
      // Allow emails on the page's own domain too: a deliberately-followed cross-domain
      // legal/contact page (e.g. ak-concept.de/impressum) carries the real operating
      // company's inbox, which the root-domain-only filter would otherwise drop.
      const pageAllowedEmailDomains = this.isSameCompanyWebsiteUrl(rootUrl, page.url)
        ? allowedEmailDomains
        : new Set([...allowedEmailDomains, ...this.buildAllowedEmailDomains(page.url)]);
      const emails = this.extractEmails(page.html, pageAllowedEmailDomains);
      const phones = this.extractPhones(page.html);
      const primaryPhone = phones[0];

      for (const email of emails) {
        const existing = candidates.get(email);
        const isGenericMailbox = this.isGenericMailbox(email);
        const inferredName = isGenericMailbox
          ? {}
          : (this.inferNameFromPageContext(page.html, email) ?? this.inferNameFromEmail(email));
        candidates.set(email, {
          email,
          phone: existing?.phone ?? primaryPhone,
          sourceUrl: page.url,
          label: isGenericMailbox ? "public_generic_mailbox" : "public_named_mailbox",
          firstName: existing?.firstName ?? inferredName.firstName,
          lastName: existing?.lastName ?? inferredName.lastName,
          jobTitle: existing?.jobTitle ?? (isGenericMailbox ? "General contact" : (this.inferJobTitleFromPageContext(page.html, email) ?? "Public contact")),
          linkedinUrl: existing?.linkedinUrl ?? (isGenericMailbox ? undefined : this.extractLinkedInProfileUrlFromPage(page.html))
        });
      }

      // Agent-first: when Azure is configured, named people are extracted by the AI agent
      // directly from the raw page evidence (extractPublicContactsFromEvidence). The line-pairing
      // text heuristic only runs as a fallback when Azure is unavailable.
      if (!readiness.azureConfigured) {
        namedWebsiteContacts.push(...this.extractNamedContactsFromPage(page.url, page.html, primaryPhone, emails));
      }
    }

    const websiteContacts = this.mergeDiscoveredContacts(
      [...candidates.values()].filter((candidate) => !this.isLowValueMailbox(candidate.email ?? "")),
      namedWebsiteContacts
    );

    if (!includeOfficialWebsiteSearch) {
      // Deterministic regex-only website contacts (emails/phones from already-fetched HTML).
      // Skips the slow official-website AI profile so the cheap reachable contact is never
      // starved by an AI/browser call under a tight execution timeout.
      return websiteContacts;
    }

    const officialWebsiteSearchContacts = await this.discoverOfficialWebsiteSearchContacts(company, officialWebsiteProfile);

    return this.mergeDiscoveredContacts(officialWebsiteSearchContacts, websiteContacts);
  }

  private buildTimeoutFallbackPublicContacts(contacts: PublicContactCandidate[]): PublicContactCandidate[] {
    const dedupedContacts = this.collapseDuplicateMailboxContacts(contacts)
      .filter((candidate) => !this.isLowValueMailbox(candidate.email ?? ""))
      .filter((candidate) => !this.isLowConfidenceWebsiteNamedContact(candidate));
    const websiteFallbackContacts = this.selectReachableWebsiteFallbackContacts(dedupedContacts);
    const namedFallbackContacts = dedupedContacts
      .filter((contact) => this.isNamedFallbackContact(contact))
      .sort((left, right) => this.getPublicContactScore(right) - this.getPublicContactScore(left))
      .slice(0, Math.max(0, 4 - websiteFallbackContacts.length));

    if (namedFallbackContacts.length > 0 || websiteFallbackContacts.length > 0) {
      return this.mergeDiscoveredContacts(namedFallbackContacts, websiteFallbackContacts).slice(0, 4);
    }

    return dedupedContacts
      .sort((left, right) => this.getPublicContactScore(right) - this.getPublicContactScore(left))
      .slice(0, 4);
  }

  private buildWebsitePageDebugEntries(
    company: Pick<PreCategorizedCompany, "domain">,
    pages: Array<{ url: string; html: string }>
  ): PublicContactDebugResult["websitePages"] {
    if (!company.domain) {
      return [];
    }

    const allowedDomains = this.buildAllowedEmailDomains(this.normalizeCompanyUrl(company.domain));
    return pages.map((page) => {
      const emails = this.extractEmails(page.html, allowedDomains);
      const phones = this.extractPhones(page.html);
      const primaryPhone = phones[0];

      return {
        url: page.url,
        evidenceSnippet: this.buildWebsiteEvidenceSnippet(page.url, page.html),
        emails,
        phones,
        linkedInProfileUrl: this.extractLinkedInProfileUrlFromPage(page.html),
        namedContacts: readiness.azureConfigured ? [] : this.extractNamedContactsFromPage(page.url, page.html, primaryPhone, emails)
      };
    });
  }

  private selectReachableWebsiteFallbackContacts(contacts: PublicContactCandidate[]): PublicContactCandidate[] {
    const genericWebsiteMailbox = contacts
      .filter((contact) => contact.label === "public_generic_mailbox" && Boolean(contact.email) && Boolean(contact.phone || contact.sourceUrl))
      .sort((left, right) => this.getPublicContactScore(right) - this.getPublicContactScore(left))[0];
    if (genericWebsiteMailbox) {
      return [genericWebsiteMailbox];
    }

    const directWebsiteContact = contacts
      .filter((contact) => ["public_named_mailbox", "website_named_contact"].includes(contact.label))
      .filter((contact) => Boolean(contact.email || contact.phone))
      .sort((left, right) => this.getPublicContactScore(right) - this.getPublicContactScore(left))[0];
    return directWebsiteContact ? [directWebsiteContact] : [];
  }

  private async discoverOfficialWebsiteSearchContacts(
    company: Pick<PreCategorizedCompany, "name" | "domain" | "country">,
    officialWebsiteProfile?: OfficialWebsiteCompanyProfile | null
  ): Promise<PublicContactCandidate[]> {
    const resolvedOfficialWebsiteProfile = officialWebsiteProfile ?? await this.getOfficialWebsiteCompanyProfile(company as PreCategorizedCompany).catch(() => null);
    if (resolvedOfficialWebsiteProfile) {
      const sourceUrl = resolvedOfficialWebsiteProfile.sourceUrls[0] || (company.domain ? this.normalizeCompanyUrl(company.domain) : company.name);
      const primaryPhone = resolvedOfficialWebsiteProfile.phones[0];
      const aiContacts = resolvedOfficialWebsiteProfile.emails.map<PublicContactCandidate>((email) => ({
        email,
        phone: primaryPhone,
        sourceUrl,
        label: this.isGenericMailbox(email) ? "public_generic_mailbox" : "public_named_mailbox",
        jobTitle: this.isGenericMailbox(email) ? "General contact" : "Public contact",
        linkedinUrl: resolvedOfficialWebsiteProfile.linkedInUrls[0],
        ...(!this.isGenericMailbox(email) ? this.inferNameFromEmail(email) : {})
      }));

      if (aiContacts.length > 0) {
        return aiContacts;
      }

      if (primaryPhone) {
        return [
          {
            phone: primaryPhone,
            sourceUrl,
            linkedinUrl: resolvedOfficialWebsiteProfile.linkedInUrls[0],
            label: "public_generic_mailbox",
            jobTitle: "General contact"
          }
        ];
      }
    }

    if (!company.domain) {
      return [];
    }

    const pages = await this.collectCandidatePages(this.normalizeCompanyUrl(company.domain));
    return this.extractGenericWebsiteContactsFromPages(company, pages);
  }

  private composeFinalPublicContacts(
    selectedEmployees: PublicContactCandidate[],
    allContacts: PublicContactCandidate[]
  ): PublicContactCandidate[] {
    const websiteFallbackContacts = this.selectReachableWebsiteFallbackContacts(allContacts)
      .filter((contact) => !selectedEmployees.some((existing) => this.getPublicContactIdentity(existing) === this.getPublicContactIdentity(contact)))
      .slice(0, 1);
    const supplementalLinkedInContacts = this.dedupeNamedEmployeeContacts(allContacts)
      .filter((contact) => this.isPersonalLinkedInUrl(contact.linkedinUrl))
      .filter((contact) => !selectedEmployees.some((existing) => this.getPublicContactIdentity(existing) === this.getPublicContactIdentity(contact)))
      .filter((contact) => !this.isExcludedContact(contact))
      .sort((left, right) => this.getPublicContactScore(right) - this.getPublicContactScore(left));
    const prioritizedEmployees = this.mergeDiscoveredContacts(selectedEmployees, supplementalLinkedInContacts)
      .sort((left, right) => this.getPublicContactScore(right) - this.getPublicContactScore(left))
      .slice(0, Math.max(0, 4 - websiteFallbackContacts.length));

    return this.mergeDiscoveredContacts(prioritizedEmployees, websiteFallbackContacts)
      .slice(0, 4);
  }

  private normalizeAzureContactLabel(contact: PublicContactCandidate): string {
    if (typeof contact.label === "string" && contact.label.trim().length > 0) {
      return contact.label.trim();
    }

    if (contact.email) {
      return this.isGenericMailbox(contact.email) ? "public_generic_mailbox" : "public_named_mailbox";
    }

    if (this.isPersonalLinkedInUrl(contact.linkedinUrl)) {
      return "linkedin_profile";
    }

    return "web_search_contact";
  }

  private collapseDuplicateMailboxContacts(contacts: PublicContactCandidate[]): PublicContactCandidate[] {
    const bestByKey = new Map<string, PublicContactCandidate>();

    for (const contact of contacts) {
      const fullName = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim().toLowerCase();
      const key = contact.email && this.isGenericMailbox(contact.email)
        ? `generic:${contact.email.trim().toLowerCase()}`
        : (contact.linkedinUrl?.trim().toLowerCase()
          || contact.email?.trim().toLowerCase()
          || (fullName ? `person:${fullName}` : this.getPublicContactIdentity(contact)));
      const existing = bestByKey.get(key);
      if (!existing || this.getPublicContactScore(contact) > this.getPublicContactScore(existing)) {
        bestByKey.set(key, contact);
      }
    }

    return [...bestByKey.values()];
  }

  private async discoverWebSearchContacts(
    company: PreCategorizedCompany,
    pages: Array<{ url: string; html: string }>,
    knownContacts: PublicContactCandidate[] = [],
    officialWebsiteProfile?: OfficialWebsiteCompanyProfile | null
  ): Promise<PublicContactCandidate[]> {
    const companyAliases = this.extractCompanySearchAliases(company, pages, officialWebsiteProfile);
    // Agent-first: use the Azure website profiler's identified legal entity name for Foundry agent
    // calls when available. The website profiler already determined the correct operating entity
    // (e.g. "AK-concept Anton Kopylow") — pass that to Foundry so it searches for the right entity
    // instead of the marketing label stored in company.name.
    const aiEntityName = officialWebsiteProfile?.entityScope === "exact_operating_entity"
      ? officialWebsiteProfile.companyName?.trim()
      : undefined;
    const foundryCompany = aiEntityName && aiEntityName !== company.name
      ? { ...company, name: aiEntityName }
      : company;
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
    // Query planning only — 60 s is ample.
    const suggestedQueries = await this.withTimeout(
      this.foundryAgentsClient.suggestPublicContactQueries(foundryCompany, queryPlanningEvidence, false),
      60_000,
      [] as string[]
    );
    const preferredQueries = this.buildPublicContactSearchQueries(company, companyAliases)
      .filter((query) => /site:linkedin\.com\/in/i.test(query));
    const queries = Array.from(new Set([...preferredQueries, ...suggestedQueries])).slice(0, 8);
    const hitGroups = await this.mapWithSearchInterval(
      queries.map((query) => async () => this.searchBingResults(query, 5)),
      PUBLIC_CONTACT_SEARCH_QUERY_CONCURRENCY
    );
    // Agent-first: pass all search hits directly to the AI agents. Do not filter hits with
    // isRelevantCompanyHit or extract names/titles via regex heuristics. The Foundry discovery
    // agent reads raw evidence and uses bing_grounding to find and evaluate real contacts.
    const allHits = hitGroups.flat();
    const searchEvidence = allHits
      .map((hit) => `Query: ${hit.query}\nTitle: ${hit.title}\nURL: ${hit.url}\nSnippet: ${hit.snippet}`)
      .join("\n\n");
    const evidence = [
      websiteEvidence ? `Official website evidence:\n${websiteEvidence}` : undefined,
      knownContactEvidence ? `Known website contacts:\n${knownContactEvidence}` : undefined,
      searchEvidence ? `Web search evidence:\n${searchEvidence}` : undefined
    ].filter(Boolean).join("\n\n");
    // Foundry bing_grounding agent is the primary discovery path: it reads the full evidence and
    // performs additional web searches as needed. Always call Foundry — even when external Bing
    // searches returned no hits — because Foundry has its own bing_grounding tool and can search
    // independently. Only the company name and domain are sufficient as minimal evidence.
    const minimalEvidence = [
      `Company: ${company.name}`,
      company.domain ? `Website: ${company.domain}` : undefined,
      company.country ? `Country: ${company.country}` : undefined
    ].filter(Boolean).join("\n");
    // Foundry contact discovery — allow up to 200 s. Longer runs are not useful and would
    // push the total contact-selection budget past its limit.
    const foundryContacts = await this.withTimeout(
      this.foundryAgentsClient.discoverPublicContacts(
        foundryCompany,
        evidence.trim() || minimalEvidence,
        false
      ),
      200_000,
      [] as Awaited<ReturnType<typeof this.foundryAgentsClient.discoverPublicContacts>>
    );

    const withLinkedIn = foundryContacts.filter((c) => c.linkedinUrl && /\/in\//i.test(c.linkedinUrl));
    console.log(`[discoverWebSearchContacts] ${company.name}: foundry returned ${foundryContacts.length} contacts, ${withLinkedIn.length} with /in/ LinkedIn`);
    if (foundryContacts.length > 0 && withLinkedIn.length === 0) {
      console.log(`[discoverWebSearchContacts] ${company.name}: foundry contacts WITHOUT LinkedIn: ${foundryContacts.map(c => `${c.firstName||''} ${c.lastName||''} label=${c.label} li=${c.linkedinUrl||'none'}`).join('; ')}`);
    }

    return foundryContacts.map((contact) => ({
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
    const prioritizedAliases = Array.from(new Set(aliases.map((alias) => alias.trim()).filter(Boolean)))
      .sort((left, right) => this.getSearchAliasPriority(right) - this.getSearchAliasPriority(left));
    const preferredCompanyName = this.looksLikeDescriptiveCompanyLabel(companyName)
      ? prioritizedAliases.find((alias) => alias.length >= 4) ?? simplifiedCompanyToken ?? companyToken ?? companyName
      : companyName;
    const managerRoleQuery = '"CEO" OR "CTO" OR "COO" OR "Founder" OR "Managing Director" OR "Head of Engineering" OR "Head of Operations" OR "Technology Manager" OR "Operations Manager"';
    const developerRoleQuery = '"Engineer" OR "Developer" OR "Software Engineer" OR "Pipeline Engineer" OR "Technical Director"';
    const aliasQueries = prioritizedAliases.flatMap((alias) => [
      `${alias} site:linkedin.com/in`,
      `site:linkedin.com/in "${alias}"`,
      `${alias} ${managerRoleQuery}`,
      `site:linkedin.com/company "${alias}" people`,
      `site:linkedin.com/in "${alias}" ${managerRoleQuery}`,
      `site:linkedin.com/in "${alias}" ${developerRoleQuery}`,
      `${alias} linkedin ${managerRoleQuery}`,
      `${alias} linkedin ${developerRoleQuery}`
    ]);

    return Array.from(
      new Set(
        [
          ...aliasQueries,
          `${preferredCompanyName} site:linkedin.com/in`,
          `site:linkedin.com/in "${preferredCompanyName}"`,
          `${preferredCompanyName} ${managerRoleQuery}`,
          simplifiedCompanyName && simplifiedCompanyName !== companyName ? `${simplifiedCompanyName} site:linkedin.com/in` : undefined,
          simplifiedCompanyName && simplifiedCompanyName !== companyName ? `site:linkedin.com/in "${simplifiedCompanyName}"` : undefined,
          simplifiedCompanyName && simplifiedCompanyName !== companyName ? `${simplifiedCompanyName} ${managerRoleQuery}` : undefined,
          `site:linkedin.com/company "${preferredCompanyName}" people`,
          simplifiedCompanyName && simplifiedCompanyName !== companyName ? `site:linkedin.com/company "${simplifiedCompanyName}" people` : undefined,
          `site:linkedin.com/in "${preferredCompanyName}" ${managerRoleQuery}`,
          `site:linkedin.com/in "${preferredCompanyName}" ${developerRoleQuery}`,
          simplifiedCompanyName && simplifiedCompanyName !== companyName ? `site:linkedin.com/in "${simplifiedCompanyName}" ${managerRoleQuery}` : undefined,
          simplifiedCompanyName && simplifiedCompanyName !== companyName ? `site:linkedin.com/in "${simplifiedCompanyName}" ${developerRoleQuery}` : undefined,
          normalizedDomain ? `site:linkedin.com/in "${normalizedDomain}" ${managerRoleQuery}` : undefined,
          companyToken ? `${companyToken} site:linkedin.com/in` : undefined,
          companyToken ? `site:linkedin.com/in "${companyToken}"` : undefined,
          companyToken ? `site:linkedin.com/in "${companyToken}" ${managerRoleQuery}` : undefined,
          simplifiedCompanyToken && simplifiedCompanyToken !== companyToken ? `${simplifiedCompanyToken} site:linkedin.com/in` : undefined,
          simplifiedCompanyToken && simplifiedCompanyToken !== companyToken ? `site:linkedin.com/in "${simplifiedCompanyToken}"` : undefined,
          simplifiedCompanyToken && simplifiedCompanyToken !== companyToken ? `site:linkedin.com/in "${simplifiedCompanyToken}" ${managerRoleQuery}` : undefined,
          `${preferredCompanyName} linkedin ${managerRoleQuery}`,
          `${preferredCompanyName} linkedin ${developerRoleQuery}`
        ].filter((query): query is string => Boolean(query))
      )
    );
  }

  private getSearchAliasPriority(alias: string): number {
    let score = alias.length;
    if (/\b(gmbh|ag|ug|ltd|llc|inc)\b/i.test(alias)) {
      score += 50;
    }
    if (/\s/.test(alias)) {
      score += 10;
    }
    return score;
  }

  private extractCompanySearchAliases(
    company: Pick<PreCategorizedCompany, "name" | "domain">,
    _pages: Array<{ url: string; html: string }>,
    officialWebsiteProfile?: OfficialWebsiteCompanyProfile | null
  ): string[] {
    const companyName = company.name.trim();
    const normalizedDomain = this.normalizeDomain(company.domain);
    const primaryToken = (normalizedDomain?.split(".")[0] ?? companyName)
      .split(/[-_\s]+/)
      .find((token) => token && token.length >= 4 && !/^(ai|the|group)$/i.test(token));

    // Agent-first: the Azure website profiler is the authoritative source for search aliases.
    // It reads raw page content and returns validated legal/brand/domain aliases without
    // CTA, marketing, navigation, or heading text. We never mine aliases from page text with
    // regex heuristics anymore.
    const aiAliases = (officialWebsiteProfile?.searchAliases ?? [])
      .map((alias) => alias.replace(/\s+/g, " ").trim())
      .filter((alias) => alias.length > 0 && alias.length <= 40);

    // Deterministic company master-data fallbacks (no page-text parsing). These are used
    // alongside the AI aliases and as the only source when Azure is unavailable.
    const officialWebsiteAlias = officialWebsiteProfile?.entityScope === "exact_operating_entity"
      ? officialWebsiteProfile.companyName?.trim()
      : undefined;
    const deterministicAliases = [
      officialWebsiteAlias,
      companyName,
      officialWebsiteAlias?.replace(/\b(GmbH|AG|UG|Ltd|LLC|Inc)\b/gi, " ").replace(/\s+/g, " ").trim(),
      companyName.replace(/\b(GmbH|AG|UG|Ltd|LLC|Inc)\b/gi, " ").replace(/\s+/g, " ").trim(),
      primaryToken ? this.toTitleCase(primaryToken) : undefined
    ]
      .filter((alias): alias is string => Boolean(alias))
      .map((alias) => alias.replace(/\s+/g, " ").trim())
      .filter((alias) => alias.length > 0 && alias.length <= 40)
      // Domain-token relevance guard keeps descriptive labels from leaking into LinkedIn queries.
      .filter((alias) => !primaryToken || alias.toLowerCase().includes(primaryToken.toLowerCase()));

    return Array.from(new Set([...aiAliases, ...deterministicAliases])).slice(0, 6);
  }

  private extractLegalEntityCandidatesFromPages(
    company: Pick<PreCategorizedCompany, "name" | "domain">,
    pages: Array<{ url: string; html: string }>
  ): string[] {
    const comparisonTokens = this.buildCompanyIdentityTokens(company);
    const candidates = pages.flatMap((page) =>
      this.extractPlainTextLines(page.html)
        .map((line) => {
          const candidate = this.extractLegalEntityNameFromLine(line);
          if (!candidate) {
            return null;
          }

          const normalizedCandidate = this.normalizeCompanyComparisonValue(candidate);
          const matchedTokens = comparisonTokens.filter((token) => normalizedCandidate.includes(token)).length;
          // Allow impressum-sourced candidates even when they don't share tokens with the known
          // short name (e.g. "Aulbach Automation GmbH" for domain "abk-pressenbau.de").
          const isImpressumPage = /(impressum|imprint|legal)/i.test(page.url);
          if (comparisonTokens.length > 0 && matchedTokens === 0 && !isImpressumPage) {
            return null;
          }

          let score = candidate.length + matchedTokens * 15;
          if (/(impressum|imprint|legal)/i.test(page.url)) {
            score += 50;
          }
          if (/\b(firma|company|legal name|diensteanbieter|anbieter|betreiber|inhaber)\b/i.test(line)) {
            score += 20;
          }
          if (candidate === candidate.toUpperCase()) {
            score += 5;
          }

          return {
            candidate,
            score
          };
        })
        .filter((value): value is { candidate: string; score: number } => Boolean(value))
    );

    return Array.from(
      new Set(
        candidates
          .sort((left, right) => right.score - left.score || right.candidate.length - left.candidate.length)
          .map((entry) => entry.candidate)
      )
    );
  }

  private extractLegalEntityNameFromLine(line: string): string | null {
    const normalizedLine = line.replace(/\s+/g, " ").trim();
    if (!normalizedLine || normalizedLine.length > 600) {
      return null;
    }

    const cleanedLine = normalizedLine
      .replace(/^(impressum|firma|company|legal name|diensteanbieter|anbieter|betreiber(?:in)?|inhaber(?:in)?)\s*[:\-]\s*/i, "")
      .replace(/^(?:©|\(c\))?\s*(?:19|20)\d{2}(?:\s*[-\/]\s*(?:19|20)\d{2})?\s+/i, "")
      .trim();
    const match = cleanedLine.match(/\b([A-ZÄÖÜ0-9][A-Za-zÄÖÜäöüß0-9&.,'’\-\/()]+?(?:\s+[A-ZÄÖÜ0-9][A-Za-zÄÖÜäöüß0-9&.,'’\-\/()]+?){0,6}\s+(?:GmbH\s*&\s*Co\.\s*KG|GmbH\s*&\s*Co\.\s*KGaA|GmbH|UG\s*\(haftungsbeschr(?:a|ä)nkt\)|UG|AG|SE|e\.\s*K\.?|e\.\s*Kfm\.?|KG|OHG|GbR|Ltd\.?|LLC|Inc\.?|AS|ASA|A\/S|AB|OY|OYJ))\b/i);
    if (!match?.[1]) {
      return null;
    }

    return match[1]
      .replace(/\s*&\s*/g, " & ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private buildCompanyIdentityTokens(company: Pick<PreCategorizedCompany, "name" | "domain">): string[] {
    const normalizedDomain = this.normalizeDomain(company.domain);
    const domainTokens = (normalizedDomain?.split(".")[0] ?? "")
      .split(/[-_]+/)
      .map((token) => this.normalizeCompanyComparisonValue(token))
      .filter((token) => token.length >= 3)
      .filter((token) => !/^(www|the|group|holding|company|legal|vision|automation|solutions|systems|info)$/i.test(token));
    const nameTokens = company.name
      .split(/[^A-Za-zÄÖÜäöüß0-9]+/)
      .map((token) => this.normalizeCompanyComparisonValue(token))
      .filter((token) => token.length >= 3)
      .filter((token) => !/^(gmbh|ag|ug|kg|www|the|group|holding|company|legal|vision|automation|solutions|systems|info)$/i.test(token));

    return Array.from(new Set([...domainTokens, ...nameTokens]));
  }

  private normalizeCompanyComparisonValue(value: string): string {
    return value
      .replace(/ä/gi, "ae")
      .replace(/ö/gi, "oe")
      .replace(/ü/gi, "ue")
      .replace(/ß/g, "ss")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private async searchBingResults(query: string, maxResults: number): Promise<WebSearchHit[]> {
    const cacheKey = `${query.trim().toLowerCase()}::${maxResults}`;
    const cachedResult = this.searchResultCache.get(cacheKey);
    if (cachedResult) {
      return cachedResult;
    }

    const searchPromise = this.executeSearchBingResults(query, maxResults);
    this.searchResultCache.set(cacheKey, searchPromise);
    if (this.searchResultCache.size > 128) {
      this.searchResultCache.clear();
      this.searchResultCache.set(cacheKey, searchPromise);
    }

    return searchPromise;
  }

  private async executeSearchBingResults(query: string, maxResults: number): Promise<WebSearchHit[]> {
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

    const wantsLinkedInResults = /site:linkedin\.com\/(?:in|company)/i.test(query);
    if (wantsLinkedInResults) {
      const browserDuckDuckGoHits = await this.searchDuckDuckGoBrowserResults(query, maxResults);
      if (browserDuckDuckGoHits.length > 0) {
        return normalizedHits(browserDuckDuckGoHits);
      }

      const rawDuckDuckGoHits = await this.searchDuckDuckGoResults(query, maxResults);
      if (rawDuckDuckGoHits.length > 0) {
        return normalizedHits(rawDuckDuckGoHits);
      }
    }

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
        if (!wantsLinkedInResults || normalizedBingHits.some((hit) => /linkedin\.com\/(?:in|company)\//i.test(hit.url))) {
          return normalizedBingHits;
        }

        const fallbackHits: WebSearchHit[] = [];
        fallbackHits.push(...(await this.searchDuckDuckGoResults(query, maxResults)));
        fallbackHits.push(...(await this.searchBingRssResults(query, maxResults)));
        return normalizedHits([...fallbackHits, ...normalizedBingHits]);
      }
    } catch {
      // Fall back to alternative search endpoints below.
    }

    const fallbackHits: WebSearchHit[] = [];
    fallbackHits.push(...(await this.searchBingRssResults(query, maxResults)));
    fallbackHits.push(...(await this.searchDuckDuckGoResults(query, maxResults)));
    return normalizedHits(fallbackHits);
  }

  private async searchDuckDuckGoBrowserResults(query: string, maxResults: number): Promise<WebSearchHit[]> {
    try {
      return await this.scheduleBrowserTask(async () => {
        const browser = await this.launchBrowserForWebTasks();

        try {
          const page = await browser.newPage({
            locale: "de-DE",
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36"
          });

          await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web`, {
            waitUntil: "domcontentloaded",
            timeout: DDG_BROWSER_SEARCH_TIMEOUT_MS
          });
          await page.waitForSelector('article[data-testid="result"]', {
            timeout: DDG_BROWSER_SEARCH_TIMEOUT_MS
          }).catch(() => undefined);
          await page.waitForTimeout(3000);

          const articles = await page.evaluate((limit) => {
            const parseSnippet = (articleText: string, title: string, url: string): string => {
              const normalizedUrl = url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
              const lines = articleText
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .filter((line) => line !== title)
                .filter((line) => line !== url)
                .filter((line) => line !== normalizedUrl)
                .filter((line) => !/^LinkedIn/i.test(line));

              return lines.join(" ");
            };

            return Array.from(document.querySelectorAll('article[data-testid="result"]'))
              .map((article) => {
                const element = article as HTMLElement;
                const titleLinks = Array.from(element.querySelectorAll('a[href*="linkedin.com/in"]')) as HTMLAnchorElement[];
                const titleLink = titleLinks.find((link) => {
                  const text = (link.textContent || "").trim();
                  return text.length > 0 && /linkedin/i.test(text) && !/^https?:/i.test(text) && !/›/.test(text);
                }) ?? titleLinks.find((link) => {
                  const text = (link.textContent || "").trim();
                  return text.length > 0 && !/^https?:/i.test(text) && !/›/.test(text);
                });
                if (!titleLink) {
                  return null;
                }

                const title = (titleLink.textContent || "").trim();
                const url = titleLink.href;
                const snippet = parseSnippet(element.innerText || "", title, url);

                return {
                  url,
                  title,
                  snippet
                };
              })
              .filter((article): article is BrowserSearchArticle => Boolean(article))
              .slice(0, limit);
          }, Math.max(maxResults, 8));

          return articles.map((article) => ({
            ...article,
            query
          }));
        } finally {
          await browser.close().catch(() => undefined);
        }
      });
    } catch {
      return [];
    }
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
      const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=de-de`, {
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
      const blocks = [...html.matchAll(/<div class="result results_links[\s\S]*?<div class="clear"><\/div>\s*<\/div>\s*<\/div>/gi)].map((match) => match[0]);
      return blocks
        .map<WebSearchHit | null>((block) => {
          const url = block.match(/class="result__a" href="([^"]+)"/i)?.[1] ?? block.match(/class="result__url" href="([^"]+)"/i)?.[1];
          if (!url) {
            return null;
          }

          const title = this.decodeHtmlEntities(this.stripHtml(block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "")).trim();
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
    // For impressum/contact/legal pages, prefer the main content block over the full page
    // (navigation menus at the top can easily overwhelm the 2600-char window).
    const looksLikeLegalPage = /\/(impressum|imprint|kontakt|contact|legal|ansprechpartner|team)/i.test(url);
    let sourceHtml = html;
    if (looksLikeLegalPage) {
      // Extract <main>, <article>, or the first large <section> to skip navigation
      const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
        ?? html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
        ?? html.match(/<div[^>]+(?:class|id)=["'][^"']*(?:content|main|impressum|kontakt|page)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
      if (mainMatch?.[1] && mainMatch[1].length > 200) {
        sourceHtml = mainMatch[1];
      }
    }
    const plainText = this.decodeHtmlEntities(this.stripHtml(sourceHtml)).replace(/\s+/g, " ").trim();
    // Agent-first: hand the model the actual visible page text so it can read the legal company
    // entity, postal address, and contact block itself.
    const visibleText = plainText.slice(0, WEBSITE_EVIDENCE_VISIBLE_TEXT_LIMIT);
    const roleAdjacentText = Array.from(
      new Set(
        [...plainText.matchAll(new RegExp(`[^.!?]{0,120}(?:${PUBLIC_CONTACT_ROLE_PATTERNS.join("|")})[^.!?]{0,120}`, "gi"))]
          .map((match) => match[0].trim())
          .filter(Boolean)
      )
    ).slice(0, 6);
    const linkedInUrls = Array.from(new Set((html.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/[^"]+/gi) ?? []).slice(0, 4)));
    const emails = Array.from(new Set([
      ...this.extractVisibleEmailsForAi(html),
      ...(html.match(/mailto:([^"'>\s]+)/gi) ?? []).map((match) => match.replace(/^mailto:/i, ""))
    ])).slice(0, 6);

    return [
      `Page: ${url}`,
      visibleText.length > 0 ? `Visible page text: ${visibleText}` : undefined,
      roleAdjacentText.length > 0 ? `Role mentions: ${roleAdjacentText.join(" | ")}` : undefined,
      linkedInUrls.length > 0 ? `LinkedIn URLs: ${linkedInUrls.join(" | ")}` : undefined,
      emails.length > 0 ? `Emails: ${emails.join(" | ")}` : undefined
    ].filter(Boolean).join("\n");
  }

  private mergeDiscoveredContacts(
    primaryContacts: PublicContactCandidate[],
    additionalContacts: PublicContactCandidate[]
  ): PublicContactCandidate[] {
    const merged = new Map<string, PublicContactCandidate>();

    for (const contact of primaryContacts) {
      this.upsertMergedContact(merged, contact);
    }

    for (const contact of additionalContacts) {
      this.upsertMergedContact(merged, contact);
    }

    return [...merged.values()];
  }

  private upsertMergedContact(target: Map<string, PublicContactCandidate>, contact: PublicContactCandidate): void {
    const mergeKeys = this.getPublicContactMergeKeys(contact);
    const existingKey = mergeKeys.find((key) => target.has(key));
    if (!existingKey) {
      target.set(mergeKeys[0] ?? this.getPublicContactIdentity(contact), contact);
      return;
    }

    const existing = target.get(existingKey)!;
    target.set(existingKey, this.mergePublicContactRecord(existing, contact));
  }

  private getPublicContactMergeKeys(contact: PublicContactCandidate): string[] {
    const fullName = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim().toLowerCase();
    return Array.from(new Set([
      contact.linkedinUrl?.trim().toLowerCase(),
      contact.email?.trim().toLowerCase(),
      fullName ? `name:${fullName}` : undefined,
      contact.phone?.trim() ? `phone:${contact.phone.trim()}` : undefined,
      this.getPublicContactIdentity(contact)
    ].filter((value): value is string => Boolean(value))));
  }

  private mergePublicContactRecord(existing: PublicContactCandidate, incoming: PublicContactCandidate): PublicContactCandidate {
    const preferred = this.getPublicContactScore(incoming) > this.getPublicContactScore(existing)
      ? incoming
      : existing;
    const secondary = preferred === incoming ? existing : incoming;

    return {
      ...preferred,
      personId: preferred.personId ?? secondary.personId,
      email: preferred.email || secondary.email,
      phone: preferred.phone || secondary.phone,
      firstName: preferred.firstName || secondary.firstName,
      lastName: preferred.lastName || secondary.lastName,
      jobTitle: preferred.jobTitle || secondary.jobTitle,
      linkedinUrl: preferred.linkedinUrl || secondary.linkedinUrl,
      linkedinConnectionCount: preferred.linkedinConnectionCount ?? secondary.linkedinConnectionCount,
      sourceUrl: preferred.sourceUrl || secondary.sourceUrl,
      sourceQuery: preferred.sourceQuery ?? secondary.sourceQuery,
      sourceSnippet: preferred.sourceSnippet ?? secondary.sourceSnippet,
      label: preferred.label || secondary.label
    };
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
    if (contact.linkedinUrl && this.isPersonalLinkedInUrl(contact.linkedinUrl)) {
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
      score += 8;
    } else if (this.isDeveloperContact(contact)) {
      score += 4;
    }

    if (contact.label.includes("website")) {
      score += 1;
    }

    if (contact.linkedinConnectionCount) {
      score += Math.min(6, Math.floor(contact.linkedinConnectionCount / 100));
    }

    if (this.isExcludedContact(contact)) {
      score -= 20;
    }

    return score;
  }

  private isPriorityContactTitle(jobTitle: string | undefined): boolean {
    return Boolean(jobTitle && PUBLIC_CONTACT_MANAGER_REGEX.test(jobTitle));
  }

  private isDeveloperContact(contact: PublicContactCandidate): boolean {
    return Boolean(contact.jobTitle && PUBLIC_CONTACT_DEVELOPER_REGEX.test(contact.jobTitle));
  }

  private isExcludedContact(contact: PublicContactCandidate): boolean {
    return Boolean(contact.jobTitle && PUBLIC_CONTACT_EXCLUDED_REGEX.test(contact.jobTitle));
  }

  private isNamedEmployeeContact(contact: PublicContactCandidate): boolean {
    return Boolean(
      (contact.firstName || contact.lastName)
      && !this.isGenericMailbox(contact.email ?? "")
      && !this.isLowConfidenceWebsiteNamedContact(contact)
    );
  }

  private isNamedFallbackContact(contact: PublicContactCandidate): boolean {
    return Boolean(
      (contact.firstName || contact.lastName)
      && !this.isExcludedContact(contact)
      && !this.isLowConfidenceWebsiteNamedContact(contact)
      && (
        this.isPersonalLinkedInUrl(contact.linkedinUrl)
        || Boolean(contact.email && !this.isGenericMailbox(contact.email))
        || this.isPriorityContactTitle(contact.jobTitle)
        || this.isDeveloperContact(contact)
      )
    );
  }

  private isLowConfidenceWebsiteNamedContact(contact: PublicContactCandidate): boolean {
    if (contact.label !== "website_named_contact") {
      return false;
    }

    const hasName = Boolean(contact.firstName && contact.lastName);
    if (!hasName) {
      return true;
    }

    const normalizedName = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`
      .toLowerCase()
      .replace(/[^a-z\s]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (
      this.isClearlyNonPersonLine(normalizedName)
      || normalizedName.split(" ").some((token) => [
        "ai",
        "cloud",
        "data",
        "analytics",
        "semantic",
        "model",
        "document",
        "intelligence",
        "computer",
        "vision",
        "consulting"
      ].includes(token))
    ) {
      return true;
    }

    return !Boolean(
      (contact.email && !this.isGenericMailbox(contact.email))
      || this.isPersonalLinkedInUrl(contact.linkedinUrl)
      || this.isPriorityContactTitle(contact.jobTitle)
      || this.isDeveloperContact(contact)
    );
  }

  private dedupeNamedEmployeeContacts(contacts: PublicContactCandidate[]): PublicContactCandidate[] {
    const bestByKey = new Map<string, PublicContactCandidate>();

    for (const contact of contacts) {
      const nameKey = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim().toLowerCase();
      const key = nameKey || this.getPublicContactIdentity(contact);
      const existing = bestByKey.get(key);

      if (!existing || this.getPublicContactScore(contact) > this.getPublicContactScore(existing)) {
        bestByKey.set(key, contact);
      }
    }

    return [...bestByKey.values()];
  }

  private async selectRelevantEmployeeContacts(
    company: PreCategorizedCompany,
    contacts: PublicContactCandidate[]
  ): Promise<PublicContactCandidate[]> {
    const employeeCandidates = this.dedupeNamedEmployeeContacts(contacts)
      .filter((contact) => this.isNamedEmployeeContact(contact))
      .filter((contact) => !this.isExcludedContact(contact))
      .sort((left, right) => this.getPublicContactScore(right) - this.getPublicContactScore(left));

    if (employeeCandidates.length === 0) {
      return [];
    }

    const managers = employeeCandidates.filter((contact) => this.isPriorityContactTitle(contact.jobTitle));
    const developers = employeeCandidates.filter((contact) => !this.isPriorityContactTitle(contact.jobTitle) && this.isDeveloperContact(contact));
    const unclear = employeeCandidates
      .filter((contact) => !this.isPriorityContactTitle(contact.jobTitle) && !this.isDeveloperContact(contact))
      .sort((left, right) => (right.linkedinConnectionCount ?? 0) - (left.linkedinConnectionCount ?? 0));

    const heuristicSelection = [...managers];
    for (const contact of developers) {
      if (heuristicSelection.some((existing) => this.getPublicContactIdentity(existing) === this.getPublicContactIdentity(contact))) {
        continue;
      }

      heuristicSelection.push(contact);
      if (heuristicSelection.length >= 4) {
        break;
      }
    }

    if (heuristicSelection.length < 4) {
      for (const contact of unclear) {
        if (heuristicSelection.some((existing) => this.getPublicContactIdentity(existing) === this.getPublicContactIdentity(contact))) {
          continue;
        }

        heuristicSelection.push(contact);
        if (heuristicSelection.length >= 4) {
          break;
        }
      }
    }

    const rankedForAzure = heuristicSelection.length > 0
      ? heuristicSelection.concat(employeeCandidates.filter((contact) => !heuristicSelection.includes(contact)))
      : employeeCandidates;

    const azureSelected = await this.azureOpenAIClient.choosePublicContacts(company, rankedForAzure.slice(0, 12), false);
    const completedSelection = [...azureSelected];

    for (const contact of rankedForAzure) {
      if (completedSelection.length >= Math.min(4, rankedForAzure.length)) {
        break;
      }

      if (completedSelection.some((existing) => this.getPublicContactIdentity(existing) === this.getPublicContactIdentity(contact))) {
        continue;
      }

      completedSelection.push(contact);
    }

    return completedSelection;
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  private isPersonalLinkedInUrl(url: string | undefined): boolean {
    return Boolean(url && /linkedin\.com\/in\//i.test(url));
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

      // Reject company pages — only personal /in/ profiles are valid contact LinkedIn URLs
      if (/^\/company\//i.test(parsed.pathname)) {
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
    const pagePersonalLinkedInUrl = this.isPersonalLinkedInUrl(pageLinkedInUrl) ? pageLinkedInUrl : undefined;

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
        linkedinUrl: pagePersonalLinkedInUrl
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
        linkedinUrl: pagePersonalLinkedInUrl
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
          linkedinUrl: pagePersonalLinkedInUrl
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
    if (this.isClearlyNonPersonLine(value)) {
      return null;
    }

    const nameParts = value
      .split(/\s+/)
      .map((part) => part.replace(/[^A-Za-zÄÖÜäöüß'’-]/g, ""))
      .filter(Boolean);

    const normalizedNameParts = nameParts.map((part) => part.toLowerCase());
    if (
      normalizedNameParts.some((part) => ["learn", "more", "what", "expect", "area", "scan", "camera", "cameras", "line"].includes(part))
      || (normalizedNameParts.length === 3 && ["to", "for", "and", "with", "of"].includes(normalizedNameParts[1]))
    ) {
      return null;
    }

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

  private isClearlyNonPersonLine(value: string): boolean {
    const normalized = value
      .toLowerCase()
      .replace(/[^a-zäöüß\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!normalized) {
      return true;
    }

    if (["wer wir sind", "in sensorik", "kontakt", "unternehmen", "about us", "contact person"].includes(normalized)) {
      return true;
    }

    return normalized.split(" ").some((token) => ["wer", "wir", "sind", "sensorik"].includes(token));
  }

  private looksLikeDescriptiveCompanyLabel(value: string): boolean {
    const normalized = value
      .toLowerCase()
      .replace(/[^a-z0-9\s/]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) {
      return false;
    }

    const wordCount = normalized.split(" ").filter(Boolean).length;
    return wordCount >= 5
      && !/\b(gmbh|ag|ug|ltd|llc|inc)\b/i.test(normalized)
      && /(vision|industrial|automation|inspection|marking|software|ai|computer vision|machine vision)/i.test(normalized);
  }

  private decodeHtmlEntities(value: string): string {
    return value
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#(\d+);?/g, (_match, codePoint) => String.fromCodePoint(Number(codePoint)))
      .replace(/&#x([0-9a-f]+);?/gi, (_match, codePoint) => String.fromCodePoint(Number.parseInt(codePoint, 16)));
  }

  private normalizeObfuscatedContactText(value: string): string {
    return this.decodeHtmlEntities(value)
      .replace(/([A-Z0-9._%+-]+)\s*(?:\[|\(|\{)\s*(?:at|ät)\s*(?:\]|\)|\})\s*([A-Z0-9.-]+\.[A-Z]{2,})/gi, "$1@$2")
      .replace(/([A-Z0-9._%+-]+)\s+(?:at|ät)\s+([A-Z0-9.-]+\.[A-Z]{2,})/gi, "$1@$2")
      .replace(/\s*@\s*/g, "@");
  }

  private async extractCompanyAddress(company: PreCategorizedCompany): Promise<ExtractedCompanyAddress | null> {
    if (!company.domain) {
      return this.extractCompanyAddressWithWebSearch(company);
    }

    const officialWebsiteProfile = await this.getOfficialWebsiteCompanyProfile(company).catch(() => null);
    const rootUrl = this.normalizeCompanyUrl(company.domain);
    const pages = await this.collectCandidatePages(rootUrl);
    // Pass already-collected pages to avoid a redundant second crawl in extractCompanyAddressWithWebSearch.
    const webSearchAddress = await this.extractCompanyAddressWithWebSearch(company, pages);
    const legalEntityName = this.extractLegalEntityCandidatesFromPages(company, pages)[0];
    const trustedOfficialWebsiteCompanyName = officialWebsiteProfile && this.isTrustedOfficialWebsiteProfile(officialWebsiteProfile, company)
      ? officialWebsiteProfile.companyName
      : undefined;

    if (webSearchAddress || officialWebsiteProfile?.address || officialWebsiteProfile?.city || officialWebsiteProfile?.zip) {
      return {
        companyName: trustedOfficialWebsiteCompanyName ?? legalEntityName ?? webSearchAddress?.companyName,
        address: officialWebsiteProfile?.address ?? webSearchAddress?.address,
        city: officialWebsiteProfile?.city ?? webSearchAddress?.city,
        zip: officialWebsiteProfile?.zip ?? webSearchAddress?.zip,
        state: officialWebsiteProfile?.state ?? webSearchAddress?.state,
        country: this.normalizeCountryName(officialWebsiteProfile?.country) ?? webSearchAddress?.country ?? company.country
      };
    }

    for (const page of pages) {
      const extractedAddress = this.extractPostalAddress(page.html, company.country);
      if (extractedAddress && this.isPlausibleCompanyAddress(extractedAddress)) {
        return {
          companyName: trustedOfficialWebsiteCompanyName ?? legalEntityName ?? extractedAddress.companyName,
          address: extractedAddress.address ?? officialWebsiteProfile?.address,
          city: extractedAddress.city ?? officialWebsiteProfile?.city,
          zip: extractedAddress.zip ?? officialWebsiteProfile?.zip,
          state: extractedAddress.state ?? officialWebsiteProfile?.state,
          country: extractedAddress.country ?? this.normalizeCountryName(officialWebsiteProfile?.country) ?? company.country
        };
      }
    }

    const apolloAddress = await this.apolloClient.getOrganizationAddress(company);
    if (apolloAddress) {
      return {
        companyName: trustedOfficialWebsiteCompanyName ?? legalEntityName,
        address: officialWebsiteProfile?.address ?? apolloAddress.address,
        city: officialWebsiteProfile?.city ?? apolloAddress.city,
        zip: officialWebsiteProfile?.zip ?? apolloAddress.zip,
        state: officialWebsiteProfile?.state ?? apolloAddress.state,
        country: this.normalizeCountryName(officialWebsiteProfile?.country) ?? this.normalizeCountryName(apolloAddress.country) ?? company.country
      };
    }

    return trustedOfficialWebsiteCompanyName || legalEntityName || officialWebsiteProfile?.address || officialWebsiteProfile?.city || officialWebsiteProfile?.zip
      ? {
          companyName: trustedOfficialWebsiteCompanyName ?? legalEntityName,
          address: officialWebsiteProfile?.address,
          city: officialWebsiteProfile?.city,
          zip: officialWebsiteProfile?.zip,
          state: officialWebsiteProfile?.state,
          country: this.normalizeCountryName(officialWebsiteProfile?.country) ?? company.country
        }
      : null;
  }

  private async extractCompanyAddressWithWebSearch(company: PreCategorizedCompany, pages?: Array<{ url: string; html: string }>): Promise<ExtractedCompanyAddress | null> {
    if (!company.domain) {
      return null;
    }

    const resolvedPages = pages ?? await this.collectCandidatePages(this.normalizeCompanyUrl(company.domain));
    for (const page of resolvedPages) {
      const extractedAddress = this.extractPostalAddress(page.html, company.country);
      if (!extractedAddress) {
        continue;
      }

      return {
        companyName: extractedAddress.companyName?.trim(),
        address: extractedAddress.address,
        city: extractedAddress.city,
        zip: extractedAddress.zip,
        state: extractedAddress.state,
        country: this.normalizeCountryName(extractedAddress.country) ?? company.country
      };
    }

    return null;
  }

  private extractGenericWebsiteContactsFromPages(
    company: Pick<PreCategorizedCompany, "name" | "domain" | "country">,
    pages: Array<{ url: string; html: string }>
  ): PublicContactCandidate[] {
    if (!company.domain) {
      return [];
    }

    const allowedEmailDomains = this.buildAllowedEmailDomains(this.normalizeCompanyUrl(company.domain));
    const rootUrl = this.normalizeCompanyUrl(company.domain);
    const contactsByEmail = new Map<string, PublicContactCandidate>();
    const phoneOnlyContacts: PublicContactCandidate[] = [];

    for (const page of pages) {
      const pageAllowedEmailDomains = this.isSameCompanyWebsiteUrl(rootUrl, page.url)
        ? allowedEmailDomains
        : new Set([...allowedEmailDomains, ...this.buildAllowedEmailDomains(page.url)]);
      const emails = this.extractEmails(page.html, pageAllowedEmailDomains);
      const phones = this.extractPhones(page.html);
      const primaryPhone = phones[0];

      for (const email of emails) {
        if (this.isLowValueMailbox(email)) {
          continue;
        }

        const isGenericMailbox = this.isGenericMailbox(email);
        contactsByEmail.set(email, {
          email,
          phone: contactsByEmail.get(email)?.phone ?? primaryPhone,
          sourceUrl: page.url,
          label: isGenericMailbox ? "public_generic_mailbox" : "public_named_mailbox",
          jobTitle: isGenericMailbox ? "General contact" : "Public contact",
          ...(!isGenericMailbox ? this.inferNameFromEmail(email) : {})
        });
      }

      if (emails.length === 0 && primaryPhone) {
        phoneOnlyContacts.push({
          phone: primaryPhone,
          sourceUrl: page.url,
          label: "public_generic_mailbox",
          jobTitle: "General contact"
        });
      }
    }

    const emailContacts = Array.from(contactsByEmail.values());
    if (emailContacts.length > 0) {
      return emailContacts;
    }

    return phoneOnlyContacts.slice(0, 1);
  }

  private async getOfficialWebsiteCompanyProfile(company: PreCategorizedCompany): Promise<OfficialWebsiteCompanyProfile | null> {
    const companyKey = this.getCompanyKey(company);
    const existing = this.officialWebsiteProfileCache.get(companyKey);
    if (existing) {
      return existing;
    }

    const task = this.extractOfficialWebsiteCompanyProfile(company);
    this.officialWebsiteProfileCache.set(companyKey, task);
    return task;
  }

  private async extractOfficialWebsiteCompanyProfile(company: PreCategorizedCompany): Promise<OfficialWebsiteCompanyProfile | null> {
    if (!company.domain || !readiness.azureConfigured) {
      return null;
    }

    const rootUrl = this.normalizeCompanyUrl(company.domain);
    const homepageHtml = await this.fetchHtml(rootUrl);
    if (!homepageHtml) {
      return null;
    }

    const homepagePhones = this.extractPhones(homepageHtml);
    const homepageEmails = this.extractVisibleEmailsForAi(homepageHtml);
    const homepageAnalysis = await this.azureOpenAIClient.analyzeCompanyHomepage(
      company,
      {
        url: rootUrl,
        evidenceSnippet: this.buildWebsiteEvidenceSnippet(rootUrl, homepageHtml),
        candidateLinks: this.extractInternalLinksForAi(rootUrl, homepageHtml)
      },
      false
    );
    // Always probe impressum/contact pages proactively so the legal entity name is reliably
    // sourced from the impressum even when the AI homepage analysis does not suggest them.
    const proactiveUrls = this.buildLikelyContactPageUrls(rootUrl);
    const followUpUrls = Array.from(new Set([
      ...proactiveUrls,
      ...(homepageAnalysis?.followUpUrls ?? [])
    ]))
      .filter((url) => this.isSameCompanyWebsiteUrl(rootUrl, url) || this.isLegalOrContactPageUrl(url))
      .slice(0, 7);
    const followUpPages = await Promise.all(
      followUpUrls.map(async (url) => {
        // Use fetchHtml (with Playwright fallback) so JS-rendered pages (e.g. impressum) are retrieved.
        const html = await this.fetchHtml(url);
        return html ? { url, html } : null;
      })
    );
    const evidencePages = [
      {
        url: rootUrl,
        evidenceSnippet: this.buildWebsiteEvidenceSnippet(rootUrl, homepageHtml),
        emails: homepageEmails,
        phones: homepagePhones,
        linkedInProfileUrl: this.extractLinkedInProfileUrlFromPage(homepageHtml),
        namedContacts: []
      },
      ...followUpPages
        .filter((page): page is { url: string; html: string } => Boolean(page))
        .map((page) => {
          const emails = this.extractVisibleEmailsForAi(page.html);
          const phones = this.extractPhones(page.html);
          return {
            url: page.url,
            evidenceSnippet: this.buildWebsiteEvidenceSnippet(page.url, page.html),
            emails,
            phones,
            linkedInProfileUrl: this.extractLinkedInProfileUrlFromPage(page.html),
            namedContacts: []
          };
        })
    ];
    const finalProfile = await this.azureOpenAIClient.extractCompanyProfileFromWebsiteEvidence(company, evidencePages, false);
    if (!homepageAnalysis && !finalProfile) {
      return null;
    }

    return {
      companyName: finalProfile?.companyName ?? homepageAnalysis?.companyName,
      entityScope: finalProfile?.entityScope ?? homepageAnalysis?.entityScope,
      searchAliases: Array.from(new Set([
        ...(finalProfile?.searchAliases ?? []),
        ...(homepageAnalysis?.searchAliases ?? [])
      ])),
      address: finalProfile?.address ?? homepageAnalysis?.address,
      city: finalProfile?.city ?? homepageAnalysis?.city,
      zip: finalProfile?.zip ?? homepageAnalysis?.zip,
      state: finalProfile?.state ?? homepageAnalysis?.state,
      country: finalProfile?.country ?? homepageAnalysis?.country,
      emails: Array.from(new Set([...(homepageAnalysis?.emails ?? []), ...(finalProfile?.emails ?? []), ...homepageEmails])),
      phones: Array.from(new Set([...(homepageAnalysis?.phones ?? []), ...(finalProfile?.phones ?? []), ...homepagePhones])),
      linkedInUrls: Array.from(new Set(finalProfile?.linkedInUrls ?? [])),
      sourceUrls: Array.from(new Set([rootUrl, ...followUpUrls]))
    };
  }

  private isTrustedOfficialWebsiteProfile(profile: OfficialWebsiteCompanyProfile, company: PreCategorizedCompany): boolean {
    const companyName = profile.companyName?.trim();
    if (!companyName || profile.entityScope !== "exact_operating_entity") {
      return false;
    }

    const legalEntityName = this.extractLegalEntityNameFromLine(companyName);
    if (legalEntityName) {
      const normalizedLegalEntityName = this.normalizeCompanyComparisonValue(legalEntityName);
      const normalizedShortName = this.normalizeCompanyComparisonValue(company.name);
      return normalizedLegalEntityName !== normalizedShortName || /\b(gmbh|mbh|ag|kg|kgaa|llc|inc|corp|corporation|limited|ltd|oy|ab|as|srl|spa|bv|nv)\b/i.test(companyName);
    }

    // Sole proprietors, freelancers, and agencies often have no legal-form suffix
    // (e.g. "Anton Kopylow Software Engineering", "Danny de Waard"). Trust the AI's
    // exact_operating_entity verdict for a multi-word name only when it was sourced from
    // this company's own impressum/legal/contact page, so a marketing slogan is not adopted.
    const hasLegalSource = (profile.sourceUrls ?? []).some((url) => this.isLegalOrContactPageUrl(url));
    const wordCount = companyName.split(/\s+/).filter(Boolean).length;
    return hasLegalSource && wordCount >= 2 && companyName.length <= 80;
  }

  private isPlausibleCompanyAddress(address: ExtractedCompanyAddress): boolean {
    return Boolean(address.address || (address.city && address.zip));
  }

  private extractInternalLinksForAi(rootUrl: string, html: string): Array<{ url: string; anchorText: string }> {
    const root = new URL(rootUrl);
    const normalizedRootHost = this.normalizeDomain(root.host) ?? root.host.replace(/^www\./i, "").toLowerCase();
    const linkMap = new Map<string, { url: string; anchorText: string }>();

    for (const match of html.matchAll(/<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      try {
        const url = new URL(match[1], root).toString();
        const parsedUrl = new URL(url);
        const normalizedHost = this.normalizeDomain(parsedUrl.host) ?? parsedUrl.host.replace(/^www\./i, "").toLowerCase();
        const anchorText = this.decodeHtmlEntities(this.stripHtml(match[2] ?? "")).replace(/\s+/g, " ").trim();
        // Keep same-domain links, plus cross-domain legal/contact pages (impressum often lives
        // on a separate company domain) so the AI can choose to read them for the legal entity.
        if (normalizedHost !== normalizedRootHost && !this.isLegalOrContactPageUrl(url, anchorText)) {
          continue;
        }

        linkMap.set(url, { url, anchorText });
      } catch {
        continue;
      }
    }

    return [...linkMap.values()].slice(0, 30);
  }

  private isSameCompanyWebsiteUrl(rootUrl: string, candidateUrl: string): boolean {
    try {
      const root = new URL(rootUrl);
      const candidate = new URL(candidateUrl);
      const normalizedRootHost = this.normalizeDomain(root.host) ?? root.host.replace(/^www\./i, "").toLowerCase();
      const normalizedCandidateHost = this.normalizeDomain(candidate.host) ?? candidate.host.replace(/^www\./i, "").toLowerCase();
      return normalizedRootHost === normalizedCandidateHost;
    } catch {
      return false;
    }
  }

  private extractVisibleEmailsForAi(html: string): string[] {
    const stripped = this.normalizeObfuscatedContactText(html).replace(/<[^>]+>/g, "");
    return Array.from(
      new Set(
        [...stripped.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)]
          .map((match) => match[0].toLowerCase())
          .filter((email) => !email.endsWith(".png") && !email.endsWith(".jpg") && !email.endsWith(".jpeg") && !email.endsWith(".webp"))
      )
    );
  }

  private async collectCandidatePages(rootUrl: string, dryRun = false): Promise<Array<{ url: string; html: string }>> {
    // Use per-run cache so contact discovery and address extraction share the same crawl result.
    if (!dryRun) {
      const cached = this.candidatePagesCache.get(rootUrl);
      if (cached) {
        return cached;
      }
      const task = this.doCollectCandidatePages(rootUrl, false);
      this.candidatePagesCache.set(rootUrl, task);
      return task;
    }
    return this.doCollectCandidatePages(rootUrl, dryRun);
  }

  private async doCollectCandidatePages(rootUrl: string, dryRun = false): Promise<Array<{ url: string; html: string }>> {
    // Phase 1: Fetch seed pages in parallel (homepage + proactive contact/impressum URLs).
    const seedUrls = Array.from(new Set([rootUrl, ...this.buildLikelyContactPageUrls(rootUrl)]));
    const seedResults = await Promise.all(
      seedUrls.map(async (url) => {
        const html = await this.fetchHtml(url);
        return html ? { url, html } : null;
      })
    );
    const seedPages = seedResults.filter((page): page is { url: string; html: string } => Boolean(page));

    // Collect all candidate links from seed pages (deduplicated by URL).
    const linkMap = new Map<string, { url: string; anchorText: string }>();
    for (const page of seedPages) {
      for (const link of this.extractAllCandidateLinks(rootUrl, page.html)) {
        if (!linkMap.has(link.url)) {
          linkMap.set(link.url, link);
        }
      }
    }
    const allCandidateLinks = Array.from(linkMap.values());

    // Phase 2: One AI call to select the best follow-up URLs from all seed page links.
    const visitedUrls = new Set(seedPages.map((page) => page.url));
    let followUpUrls: string[] = [];
    if (allCandidateLinks.length > 0) {
      const combinedSnippet = seedPages
        .map((page) => this.stripHtml(page.html).replace(/\s+/g, " ").slice(0, 300))
        .join("\n");
      const aiLinks = await this.azureOpenAIClient.selectLinksForCrawl(
        rootUrl, combinedSnippet, allCandidateLinks, 10, dryRun
      );
      followUpUrls = aiLinks.length > 0
        ? aiLinks.filter((url) => !visitedUrls.has(url))
        : this.extractRelevantLinks(rootUrl, seedPages[0]?.html ?? "").filter((url) => !visitedUrls.has(url));
    }

    // Phase 3: Fetch follow-up pages in parallel.
    const followUpResults = await Promise.all(
      followUpUrls.slice(0, 10).map(async (url) => {
        const html = await this.fetchHtml(url);
        return html ? { url, html } : null;
      })
    );
    const followUpPages = followUpResults.filter((page): page is { url: string; html: string } => Boolean(page));

    return [...seedPages, ...followUpPages].slice(0, 14);
  }

  /** Extract all internal same-domain links (+ cross-domain legal/contact pages) without heuristic scoring. */
  private extractAllCandidateLinks(rootUrl: string, html: string): Array<{ url: string; anchorText: string }> {
    const root = new URL(rootUrl);
    const normalizedRootHost = this.normalizeDomain(root.host) ?? root.host.replace(/^www\./i, "").toLowerCase();
    return [...html.matchAll(/<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .map((match) => ({
        href: match[1],
        anchorText: this.decodeHtmlEntities(this.stripHtml(match[2] ?? "")).replace(/\s+/g, " ").trim()
      }))
      .flatMap((link) => {
        try {
          const url = new URL(link.href, root).toString();
          const parsedUrl = new URL(url);
          const normalizedParsedHost = this.normalizeDomain(parsedUrl.host) ?? parsedUrl.host.replace(/^www\./i, "").toLowerCase();
          if (normalizedParsedHost !== normalizedRootHost && !this.isLegalOrContactPageUrl(url, link.anchorText)) {
            return [];
          }
          // Skip anchor-only fragment links on the same page
          if (parsedUrl.pathname === root.pathname && parsedUrl.hash) {
            return [];
          }
          // Exclude obvious non-content resources
          const ext = parsedUrl.pathname.split(".").pop()?.toLowerCase();
          if (ext && ["pdf", "zip", "png", "jpg", "jpeg", "gif", "webp", "svg", "css", "js"].includes(ext)) {
            return [];
          }
          return [{ url, anchorText: link.anchorText }];
        } catch {
          return [];
        }
      });
  }

  private isLikelyContactPageUrl(rootUrl: string, candidateUrl: string): boolean {
    try {
      const root = new URL(rootUrl);
      const candidate = new URL(candidateUrl, root);
      const haystack = `${candidate.pathname} ${candidate.search}`.toLowerCase();
      return HIGH_PRIORITY_PAGE_PATTERNS.some((pattern) => haystack.includes(pattern));
    } catch {
      return false;
    }
  }

  // True when a URL clearly points to an official legal/contact page (impressum, imprint,
  // legal notice, kontakt, contact, ansprechpartner). Used to let the AI see and follow such
  // pages even when they are hosted on a different domain than the company's marketing site.
  private isLegalOrContactPageUrl(candidateUrl: string, anchorText?: string): boolean {
    try {
      const candidate = new URL(candidateUrl);
      const haystack = `${candidate.pathname} ${candidate.search} ${candidate.hash} ${anchorText ?? ""}`.toLowerCase();
      return CROSS_DOMAIN_LEGAL_CONTACT_PATTERNS.some((pattern) => haystack.includes(pattern));
    } catch {
      return false;
    }
  }

  private buildLikelyContactPageUrls(rootUrl: string): string[] {
    try {
      const root = new URL(rootUrl);
      const candidates = [
        "kontakt/",
        "kontakt.html",
        "kontakt.php",
        "impressum/",
        "impressum.html",
        "impressum.php",
        "ansprechpartner/",
        "team/",
        "ueber-uns/"
      ];

      return candidates.map((path) => new URL(path, root).toString());
    } catch {
      return [];
    }
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
          // Keep same-domain links, plus cross-domain legal/contact pages (impressum/kontakt is
          // frequently hosted on a separate company domain) so reachable contacts are not lost.
          if (normalizedParsedHost !== normalizedRootHost && !this.isLegalOrContactPageUrl(url, link.anchorText)) {
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
    const decoded = this.normalizeObfuscatedContactText(html);
    // Extract emails from href="mailto:..." attributes BEFORE stripping tags — entity-encoded
    // addresses (e.g. &#105;&#110;&#102;&#111;&#64;...) survive entity-decode but get erased
    // when the wrapping <a> tag is stripped.
    const hrefEmails = [...decoded.matchAll(/href=["']mailto:([A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,})["']/gi)]
      .map((match) => match[1].toLowerCase());
    const stripped = decoded.replace(/<[^>]+>/g, "");
    const textEmails = [...stripped.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)]
      .map((match) => match[0].toLowerCase());
    return Array.from(
      new Set([...hrefEmails, ...textEmails])
    )
      .filter((email) => !email.endsWith('.png') && !email.endsWith('.jpg') && !email.endsWith('.jpeg') && !email.endsWith('.webp'))
      .filter((email) => this.isAllowedCompanyEmail(email, allowedDomains));
  }

  private extractPhones(html: string): string[] {
    const decodedHtml = this.decodeHtmlEntities(html);
    const telLinks = Array.from(
      new Set(
        [...decodedHtml.matchAll(/href=["']tel:([^"']+)["']/gi)]
          .map((match) => decodeURIComponent(match[1]).replace(/\s+/g, " ").trim())
          .filter((phone) => phone.replace(/\D/g, "").length >= 8)
      )
    );
    if (telLinks.length > 0) {
      return telLinks;
    }

    return Array.from(
      new Set(
        [...decodedHtml.matchAll(/(?:\+|00)?[0-9][0-9\s()\/-]{6,}[0-9]/g)]
          .map((match) => {
            const phone = match[0].replace(/\s+/g, " ").trim();
            const context = decodedHtml.slice(Math.max(0, (match.index ?? 0) - 60), Math.min(decodedHtml.length, (match.index ?? 0) + phone.length + 60));
            return { phone, context };
          })
          .filter(({ phone, context }) => phone.replace(/\D/g, "").length >= 8 && /(tel|telefon|phone|mobile|mobil|call|kontakt|contact)/i.test(context))
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

    // Single-token emails (e.g. "vertrieb@", "hoffmann@", "amichel@") cannot reliably be split
    // into a person's first and last name. Skip single-token inference entirely to avoid
    // storing role names, city names, or ambiguous single words as contact first names.

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
        if (firstName && lastName && !this.isClearlyNonPersonLine(`${firstName} ${lastName}`)) {
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
    if (!firstName || !lastName || this.isClearlyNonPersonLine(`${firstName} ${lastName}`)) {
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

      const inlineSegments = line.split(",").map((segment) => segment.replace(/\s+/g, " ").trim()).filter(Boolean);
      const postalSegmentIndex = inlineSegments.findIndex((segment) => segment.includes(postalMatch[0] ?? ""));
      if (postalSegmentIndex >= 1) {
        const inlineAddress = inlineSegments[postalSegmentIndex - 1] ?? "";
        if (/\d/.test(inlineAddress) && !/(tel|phone|fax|mail|email|www\.|http|@)/i.test(inlineAddress)) {
          const inlineCompany = inlineSegments.slice(0, Math.max(0, postalSegmentIndex - 1)).join(", ").trim();
          const inlineCountry = inlineSegments[postalSegmentIndex + 1] ?? "";
          return {
            companyName: this.extractLegalEntityNameFromLine(inlineCompany) ?? (inlineCompany || undefined),
            address: inlineAddress,
            zip: postalMatch[1].replace(/\s+/g, " ").trim(),
            city: postalMatch[2].trim(),
            country: this.normalizeCountryName(inlineCountry) ?? fallbackCountry
          };
        }
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

    if (/norway|norge/.test(normalized)) {
      return "Norway";
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
    // Person name tokens are typically 2–14 characters (e.g. "thomas", "schreier").
    // Anything longer is almost certainly a compound word, location, or role name.
    if (!/^[a-z]{2,14}$/.test(token)) {
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
      "technology",
      "technologies",
      "digital",
      "software",
      "hardware",
      "robotics",
      "robotik",
      "industrial",
      "analytics",
      "consulting",
      "machine",
      "learning",
      "smart",
      "factory",
      "mes",
      "erp",
      "group",
      "company",
      "corp",
      "pcb",
      "anfrage",
      "anfragen",
      "bestellung",
      "post",
      "webmaster",
      "newsletter",
      "press",
      "presse",
      "media",
      "vertrieb",
      "verkauf",
      "technik",
      "technical",
      "it",
      "karriere",
      "server",
      "frankfurt",
      "berlin",
      "munich",
      "hamburg",
      "muenchen",
      "holding",
      "headquarters",
      "hq",
      "branch",
      "office",
      "geschaeftsfuehrung",
      "geschaeftsleitung",
      "sekretariat",
      "empfang",
      "reception",
      "orders",
      "order",
      "shipping",
      "logistics",
      "logistik"
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
    const cached = this.fetchHtmlCache.get(url);
    if (cached) {
      return cached;
    }
    const task = this.doFetchHtml(url);
    this.fetchHtmlCache.set(url, task);
    return task;
  }

  private async doFetchHtml(url: string): Promise<string | null> {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; LeadAgent/1.0; +https://leadagent-production-4555.up.railway.app)"
        },
        redirect: "follow",
        signal: AbortSignal.timeout(10000)
      });

      const html = await response.text();
      if (!this.shouldRetryHtmlFetchInBrowser(response.status, html)) {
        return response.ok ? html : null;
      }

      console.warn("HubSpotClient.fetchHtml retrying in browser", {
        url,
        status: response.status,
        responseLength: html.trim().length
      });
    } catch {
      // Fall through to browser fetch below.
    }

    return this.fetchHtmlWithBrowser(url);
  }

  private shouldRetryHtmlFetchInBrowser(status: number, html: string): boolean {
    if (status === 401 || status === 403 || status === 408 || status === 429 || status >= 500) {
      return true;
    }

    if (status >= 400) {
      return false;
    }

    const normalizedHtml = html.trim();
    if (/(mailto:|tel:)/i.test(normalizedHtml)) {
      return false;
    }

    if (normalizedHtml.length < 250) {
      return true;
    }

    const challengeSignals = [
      /403\s*-\s*forbidden/i,
      /access to this page is forbidden/i,
      /please verify you are human/i,
      /verify you are human/i,
      /checking if the site connection is secure/i,
      /enable javascript and cookies to continue/i,
      /cf-chl|__cf_chl/i,
      /cloudflare/i,
      /turnstile/i,
      /attention required/i,
      /one more step/i
    ];

    const embeddedCaptchaSignal = /g-recaptcha|hcaptcha/i;

    if (challengeSignals.some((signal) => signal.test(normalizedHtml))) {
      return true;
    }

    if (embeddedCaptchaSignal.test(normalizedHtml) && normalizedHtml.length < 5000) {
      return true;
    }

    return false;
  }

  private async fetchHtmlWithBrowser(url: string): Promise<string | null> {
    try {
      return await this.scheduleBrowserTask(async () => {
        const browser = await this.launchBrowserForWebTasks();

        try {
          const page = await browser.newPage({
            locale: "de-DE",
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36",
            ignoreHTTPSErrors: true
          });

          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: WEBSITE_BROWSER_FETCH_TIMEOUT_MS
          });
          await page.waitForLoadState("networkidle", {
            timeout: 5000
          }).catch(() => undefined);

          const html = await page.content();
          return html.trim().length > 0 ? html : null;
        } finally {
          await browser.close().catch(() => undefined);
        }
      });
    } catch (error) {
      console.warn("HubSpotClient.fetchHtmlWithBrowser failed", {
        url,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private async launchBrowserForWebTasks() {
    const { chromium } = await import("playwright");

    // --disable-dev-shm-usage avoids Chromium crashing in containers where /dev/shm defaults to
    // 64MB (Railway/Docker); --no-sandbox is required because the container runs as a constrained
    // user. Without these the browser process is SIGKILLed mid-search and the request 502s.
    const launchArgs = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];

    try {
      return await chromium.launch({
        headless: true,
        channel: "chromium",
        args: launchArgs
      });
    } catch {
      return chromium.launch({
        headless: true,
        args: launchArgs
      });
    }
  }

  private async scheduleBrowserTask<T>(task: () => Promise<T>): Promise<T> {
    const previousTask = this.browserTaskQueue;
    let releaseQueue: (() => void) | undefined;

    this.browserTaskQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await previousTask;

    try {
      return await task();
    } finally {
      await this.delay(HUBSPOT_BROWSER_TASK_MIN_INTERVAL_MS);
      releaseQueue?.();
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
        case "machine_builder_vision_ai":
          return 8;
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
        case "machine_builder_vision_ai":
          return 5;
        default:
          return 1;
      }
    }

    switch (category) {
      case "industrial_end_customer_scaled":
        return 9;
      case "machine_builder_ai_enablement":
        return 5;
      case "machine_builder_vision_ai":
        return 3;
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
      .map((value) => this.toSingleLineText(value))
      .filter((value): value is string => Boolean(value));

    const uniqueSections = Array.from(new Set(sections));
    return uniqueSections.join(" ").slice(0, 1800);
  }

  private toSingleLineText(value: unknown): string | undefined {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }

    if (Array.isArray(value)) {
      const flattened = value
        .map((entry) => this.toSingleLineText(entry))
        .filter((entry): entry is string => Boolean(entry));
      return flattened.length > 0 ? flattened.join(", ") : undefined;
    }

    return undefined;
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

  private buildCombinedOutreachNote(
    company: PreCategorizedCompany,
    contact: PublicContactCandidate,
    brief: ResearchBrief
  ): string | undefined {
    const sections = [
      this.buildEmailOutreachNote(company, contact, brief),
      this.buildLinkedInOutreachNote(company, contact, brief),
      this.buildPhoneOutreachNote(company, contact, brief)
    ].filter((value): value is string => Boolean(value));

    if (sections.length === 0) {
      return undefined;
    }

    return sections.join("<br><br><hr><br><br>");
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
    const salutation = this.buildSuggestedSalutation(contact, this.normalizeOutreachLanguage(outreachLanguage));

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

  private normalizeOutreachLanguage(value: ResearchBrief["outreachLanguage"] | string | undefined): ResearchBrief["outreachLanguage"] {
    const normalized = value?.trim().toLowerCase();
    if (normalized === "german" || normalized === "deutsch") {
      return "de";
    }
    if (normalized === "english" || normalized === "englisch") {
      return "en";
    }

    return value === "de" ? "de" : "en";
  }

  private buildSuggestedSalutation(contact: PublicContactCandidate, outreachLanguage: ResearchBrief["outreachLanguage"]): string {
    const lastName = contact.lastName?.trim();
    const firstName = contact.firstName?.trim();

    if (outreachLanguage === "de") {
      if (firstName && lastName) {
        return `Hallo ${firstName} ${lastName},`;
      }

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
      case "machine_builder_vision_ai":
        return "machine_builder_vision_ai";
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

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallbackValue: T): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        promise,
        new Promise<T>((resolve) => {
          timeoutHandle = setTimeout(() => resolve(fallbackValue), timeoutMs);
        })
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
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