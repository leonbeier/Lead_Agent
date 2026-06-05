import { env } from "../config";
import { OrganizationFilter, CompanySample, CrawledWebsiteProfile, PreCategorizedCompany } from "../types";
import { OpenCrawlerSearchClient } from "./open-crawler-search";

type DiffbotResponse = {
  data?: Array<Record<string, unknown>>;
  error?: string;
  message?: string;
};

function quoteTerm(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function unwrapValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => unwrapValue(entry));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("value" in record) {
      return unwrapValue(record.value);
    }

    if ("str" in record && Object.keys(record).length === 1) {
      return record.str;
    }
  }

  return value;
}

function entityPayload(item: unknown): Record<string, unknown> {
  if (item && typeof item === "object" && "entity" in item) {
    const entity = (item as { entity?: unknown }).entity;
    return entity && typeof entity === "object" ? entity as Record<string, unknown> : {};
  }

  return item && typeof item === "object" ? item as Record<string, unknown> : {};
}

function entityField(entity: Record<string, unknown>, fieldName: string): string {
  const raw = unwrapValue(entity[fieldName]);
  if (raw == null) {
    return "";
  }

  if (Array.isArray(raw)) {
    return raw.map((entry) => String(entry).trim()).filter(Boolean).join(" | ");
  }

  return String(raw).trim();
}

export class DiffbotSearchClient {
  private readonly fallbackResearchClient = new OpenCrawlerSearchClient();

  private runtimeToken?: string;

  private creditsExhausted = false;

  setToken(token: string | undefined): void {
    this.runtimeToken = token?.trim() || undefined;
    this.creditsExhausted = false;
  }

  async discoverCompanies(
    filter: OrganizationFilter,
    limit: number,
    page = 1,
    shouldSkipDomain?: (domain: string) => boolean
  ): Promise<CompanySample[]> {
    const token = this.runtimeToken || env.DIFFBOT_TOKEN;
    if (!token || this.creditsExhausted) {
      return [];
    }

    const size = Math.max(10, Math.min(50, limit * 2));
    const from = Math.max(0, (page - 1) * size);
    const params = new URLSearchParams({
      token,
      type: "query",
      query: this.buildQuery(filter),
      size: String(size),
      from: String(from),
      format: "json",
      filter: "$.name;$.homepageUri;$.description;$.location.country.name;$.locations.country.name"
    });

    const response = await fetch(`https://kg.diffbot.com/kg/v3/dql?${params.toString()}`, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ONE-WARE-Lead-Agent/1.0)"
      }
    });

    let payload: DiffbotResponse | undefined;
    try {
      payload = await response.json() as DiffbotResponse;
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const detail = payload?.error || payload?.message || `${response.status}`;
      if (/credit|quota|billing|payment|limit/i.test(detail)) {
        this.creditsExhausted = true;
        return [];
      }

      throw new Error(`Diffbot search failed: ${detail}`);
    }

    return (payload?.data ?? [])
      .map((item) => {
        const entity = entityPayload(item);
        const website = entityField(entity, "homepageUri");
        const normalizedWebsite = website
          ? `https://${website.replace(/^https?:\/\//i, "").replace(/\/$/, "")}`
          : undefined;
        const country = entityField(entity, "location.country.name") || entityField(entity, "locations.country.name") || filter.locations[0];

        return {
          name: entityField(entity, "name"),
          domain: normalizedWebsite,
          country,
          shortDescription: entityField(entity, "description") || filter.persona,
          sourceFilter: `${filter.name} (diffbot-search)`
        } satisfies CompanySample;
      })
      .filter((company) => company.name && company.domain)
      .filter((company) => !shouldSkipDomain?.(company.domain ?? ""))
      .slice(0, limit);
  }

  async buildResearchContext(company: PreCategorizedCompany) {
    return this.fallbackResearchClient.buildResearchContext(company);
  }

  async summarizeCompany(company: CompanySample): Promise<Partial<CompanySample> | null> {
    return this.fallbackResearchClient.summarizeCompany(company);
  }

  async crawlCompanyWebsite(domain: string | undefined): Promise<CrawledWebsiteProfile | null> {
    return this.fallbackResearchClient.crawlCompanyWebsite(domain);
  }

  private buildQuery(filter: OrganizationFilter): string {
    const countries = filter.locations.slice(0, 12).map(quoteTerm).join(", ");
    const keywords = filter.keywords.slice(0, 10).map(quoteTerm).join(", ");
    const industries = filter.industries.slice(0, 6).map(quoteTerm).join(", ");

    const queryParts = [
      "type:Organization",
      "has:description",
      "has:homepageUri",
      countries
        ? `or(location.country.name:or(${countries}), locations.country.name:or(${countries}))`
        : undefined,
      keywords
        ? `description:or(${keywords})`
        : undefined,
      industries
        ? `description:or(${industries})`
        : undefined
    ].filter(Boolean);

    return queryParts.join(" ");
  }
}