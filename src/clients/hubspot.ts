import { env, readiness } from "../config";
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
  errors: string[];
}

export class HubSpotClient {
  private readonly availableProperties = new Map<"companies" | "contacts", Promise<Set<string>>>();

  async findPublicContactsForCompany(company: PreCategorizedCompany): Promise<PublicContactCandidate[]> {
    return this.findPublicContacts(company);
  }

  async syncQualifiedCompanies(
    companies: PreCategorizedCompany[],
    researchBriefs: ResearchBrief[],
    dryRun: boolean
  ): Promise<HubSpotSyncResult> {
    if (dryRun || !readiness.hubspotConfigured) {
      return {
        mode: "dry-run",
        attempted: false,
        candidateCount: companies.length,
        syncedCount: 0,
        companySyncedCount: 0,
        contactSyncedCount: 0,
        errors: []
      };
    }

    const companyProperties = await this.getAvailableProperties("companies");
    const contactProperties = await this.getAvailableProperties("contacts");
    let companySyncedCount = 0;
    let contactSyncedCount = 0;
    const errors: string[] = [];

    for (const company of companies) {
      const brief = researchBriefs.find((item) => item.companyName === company.name);

      try {
        const syncedCompany = await this.upsertCompany(company, brief, companyProperties);
        companySyncedCount += 1;

        const publicContacts = await this.findPublicContacts(company);
        for (const publicContact of publicContacts) {
          try {
            const syncedContact = await this.upsertContact(publicContact, contactProperties);
            if (!syncedContact) {
              continue;
            }

            await this.associateContactToCompany(syncedContact.id, syncedCompany.id);
            contactSyncedCount += 1;
          } catch (error) {
            errors.push(`${company.name}: ${this.toErrorMessage(error)}`);
          }
        }
      } catch (error) {
        errors.push(`${company.name}: ${this.toErrorMessage(error)}`);
      }
    }

    return {
      mode: "live",
      attempted: true,
      candidateCount: companies.length,
      syncedCount: companySyncedCount + contactSyncedCount,
      companySyncedCount,
      contactSyncedCount,
      errors
    };
  }

  private async upsertCompany(
    company: PreCategorizedCompany,
    brief: ResearchBrief | undefined,
    availableProperties: Set<string>
  ): Promise<HubSpotObjectResponse> {
    const properties = this.pickAvailableProperties(
      {
        name: company.name,
        domain: company.domain,
        country: company.country,
        description: company.shortDescription,
        ai_cc_summary_short: brief?.qualificationSummary ?? company.rationale,
        ai_cc_summary_long: brief?.overview,
        ai_cc_pain_points: brief?.emailAngle ?? brief?.phoneAngle,
        ai_cc_cold_call_email: brief?.emailBody,
        ai_cc__ow_business_potential: String(company.relevanceScore),
        ai_cc_ranking_partner: this.getNumericRanking(company.category, "partner"),
        ai_cc_ranking_serviceprovider: this.getNumericRanking(company.category, "serviceprovider"),
        ai_ranking_customer: this.getNumericRanking(company.category, "customer")
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
    if (!contact.email) {
      return null;
    }

    const properties = this.pickAvailableProperties(
      {
        email: contact.email,
        firstname: contact.firstName,
        lastname: contact.lastName,
        phone: contact.phone,
        jobtitle: contact.jobTitle,
        hs_lead_status: "NEW"
      },
      availableProperties
    );

    const existingContact = await this.findExistingContact(contact.email);
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

  private async associateContactToCompany(contactId: string, companyId: string): Promise<void> {
    await this.requestJson(
      `${env.HUBSPOT_BASE_URL}/crm/v4/objects/contacts/${contactId}/associations/default/companies/${companyId}`,
      {
        method: "PUT"
      }
    );
  }

  private async findExistingCompany(company: PreCategorizedCompany): Promise<HubSpotObjectResponse | null> {
    if (company.domain) {
      const byDomain = await this.searchObject("companies", "domain", company.domain);
      if (byDomain) {
        return byDomain;
      }
    }

    return this.searchObject("companies", "name", company.name);
  }

  private async findExistingContact(email: string): Promise<HubSpotObjectResponse | null> {
    return this.searchObject("contacts", "email", email);
  }

  private async searchObject(
    objectType: "companies" | "contacts",
    propertyName: string,
    value: string
  ): Promise<HubSpotObjectResponse | null> {
    const response = await this.requestJson<{ results?: HubSpotObjectResponse[] }>(
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
    );

    return response.results?.[0] ?? null;
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
      return [];
    }

    const rootUrl = this.normalizeCompanyUrl(company.domain);
    const allowedEmailDomains = this.buildAllowedEmailDomains(rootUrl);
    const pages = await this.collectCandidatePages(rootUrl);
    const candidates = new Map<string, PublicContactCandidate>();

    for (const page of pages) {
      const emails = this.extractEmails(page.html, allowedEmailDomains);
      const phones = this.extractPhones(page.html);
      const primaryPhone = phones[0];

      for (const email of emails) {
        const existing = candidates.get(email);
        const inferredName = this.inferNameFromEmail(email);
        candidates.set(email, {
          email,
          phone: existing?.phone ?? primaryPhone,
          sourceUrl: page.url,
          label: this.isGenericMailbox(email) ? "public_generic_mailbox" : "public_named_mailbox",
          firstName: existing?.firstName ?? inferredName.firstName,
          lastName: existing?.lastName ?? inferredName.lastName,
          jobTitle: existing?.jobTitle ?? (this.isGenericMailbox(email) ? "General contact" : "Public contact")
        });
      }
    }

    return [...candidates.values()]
      .filter((candidate) => !this.isLowValueMailbox(candidate.email ?? ""))
      .sort((left, right) => Number(this.isGenericMailbox(left.email ?? "")) - Number(this.isGenericMailbox(right.email ?? "")))
      .slice(0, 2);
  }

  private async collectCandidatePages(rootUrl: string): Promise<Array<{ url: string; html: string }>> {
    const visited = new Set<string>();
    const queue = [rootUrl];
    const pages: Array<{ url: string; html: string }> = [];

    while (queue.length > 0 && pages.length < 4) {
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
        if (!visited.has(link) && queue.length + pages.length < 8) {
          queue.push(link);
        }
      }
    }

    return pages;
  }

  private extractRelevantLinks(rootUrl: string, html: string): string[] {
    const matches = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)]
      .map((match) => match[1])
      .filter((href) => /contact|kontakt|impressum|about|team|management/i.test(href));

    const root = new URL(rootUrl);
    return Array.from(
      new Set(
        matches
          .map((href) => {
            try {
              return new URL(href, root).toString();
            } catch {
              return null;
            }
          })
          .filter((value): value is string => Boolean(value))
          .filter((value) => new URL(value).host === root.host)
      )
    ).slice(0, 4);
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
    return Array.from(
      new Set(
        [...html.matchAll(/(?:\+|00)[0-9][0-9\s()\/-]{6,}[0-9]/g)]
          .map((match) => match[0].replace(/\s+/g, " ").trim())
          .filter((phone) => phone.replace(/\D/g, "").length >= 8)
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
    const localPart = email.split("@")[0] ?? "";
    const normalized = localPart.replace(/[^a-z.\-_]/gi, "");
    const separators = normalized.includes(".") ? normalized.split(".") : normalized.split("_");

    if (separators.length >= 2 && separators[0].length > 1 && separators[1].length > 1) {
      return {
        firstName: this.toTitleCase(separators[0]),
        lastName: this.toTitleCase(separators[1])
      };
    }

    return {};
  }

  private isGenericMailbox(email: string): boolean {
    return /^(info|sales|office|kontakt|contact|hello|team|support|service|mail)@/i.test(email);
  }

  private isLowValueMailbox(email: string): boolean {
    return /^(privacy|datenschutz|compliance|legal|impressum|career|careers|jobs|bewerbung|hr|people|invoice|billing)@/i.test(email);
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
  ): string | undefined {
    if (rankingType === "partner") {
      return category === "industrial_camera_vendor_without_ai_software" ? "85" : undefined;
    }

    if (rankingType === "serviceprovider") {
      return category === "software_integrator" || category === "ai_software_integrator" ? "85" : undefined;
    }

    return category === "machine_builder_with_vision_ai_need" ? "85" : undefined;
  }

  private async requestJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.HUBSPOT_PRIVATE_APP_TOKEN}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {})
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HubSpot request failed: ${response.status} ${errorText}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown error";
  }
}