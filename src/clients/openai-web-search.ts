import { env, openAIWebSearchModels, readiness } from "../config";
import { ApolloOrganizationFilter, CompanySample, CrawledWebsiteProfile, PreCategorizedCompany } from "../types";

interface SearchEvidence {
  context: string;
  citations: string[];
}

interface SourcePageCandidate {
  url?: string;
  reason?: string;
}

interface OpenAIResponsesOutput {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      text?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
      }>;
    }>;
  }>;
}

type WebSearchMode = "preResearch" | "deepResearch";

const SOURCE_DISCOVERY_MAX_SOURCE_PAGES = 2;
const SOURCE_DISCOVERY_MAX_INTERNAL_PAGES = 3;
const SOURCE_DISCOVERY_MAX_QUEUED_PAGES = 4;
const SOURCE_DISCOVERY_MAX_CANDIDATE_DOMAINS = 12;
const SOURCE_DISCOVERY_MAX_BUDGET_MS = 20000;
const SEARCH_RESULT_MAX_QUERIES = 6;
const SEARCH_RESULT_MAX_RESULTS_PER_QUERY = 10;

export class OpenAIWebSearchClient {
  async discoverCompanies(
    filter: ApolloOrganizationFilter,
    limit: number,
    page = 1
  ): Promise<CompanySample[]> {
    const companies: CompanySample[] = [];
    const seenKeys = new Set<string>();

    const searchResultCompanies = await this.discoverCompaniesFromKeywordSearch(filter, limit, page);
    for (const company of searchResultCompanies) {
      const companyKey = `${company.name.toLowerCase()}::${company.domain?.toLowerCase() ?? ""}`;
      if (seenKeys.has(companyKey)) {
        continue;
      }

      seenKeys.add(companyKey);
      companies.push(company);

      if (companies.length >= limit) {
        return companies.slice(0, limit);
      }
    }

    const scrapedCompanies = await this.discoverCompaniesFromSourcePages(filter, limit, page);
    for (const company of scrapedCompanies) {
      const companyKey = `${company.name.toLowerCase()}::${company.domain?.toLowerCase() ?? ""}`;
      if (seenKeys.has(companyKey)) {
        continue;
      }

      seenKeys.add(companyKey);
      companies.push(company);

      if (companies.length >= limit) {
        return companies.slice(0, limit);
      }
    }

    return companies.slice(0, limit);
  }

  private async discoverCompaniesFromKeywordSearch(
    filter: ApolloOrganizationFilter,
    limit: number,
    page: number
  ): Promise<CompanySample[]> {
    const companies: CompanySample[] = [];
    const seenDomains = new Set<string>();
    const queries = this.buildKeywordQueries(filter, page).slice(0, SEARCH_RESULT_MAX_QUERIES);

    for (const query of queries) {
      const candidateUrls = await this.searchDuckDuckGo(query);

      for (const candidateUrl of candidateUrls) {
        const normalizedDomain = this.normalizeUrl(candidateUrl);
        if (!normalizedDomain || seenDomains.has(normalizedDomain) || this.shouldIgnoreDomain(normalizedDomain)) {
          continue;
        }

        seenDomains.add(normalizedDomain);
        const websiteProfile = await this.fetchWebsiteCrawlProfile(normalizedDomain);
        if (!websiteProfile || !this.looksLikePotentialDeliveryFit(websiteProfile.summary)) {
          continue;
        }

        companies.push({
          name: this.deriveCompanyName(normalizedDomain, websiteProfile.summary),
          domain: normalizedDomain,
          country: this.inferCountryFromDomain(normalizedDomain, websiteProfile.summary),
          shortDescription: websiteProfile.summary,
          sourceFilter: `${filter.name} (browser-search)`
        });

        if (companies.length >= limit) {
          return companies;
        }
      }
    }

    return companies;
  }

  private buildKeywordQueries(filter: ApolloOrganizationFilter, page: number): string[] {
    const location = filter.locations[0] ?? "Germany";
    const keywordVariants = filter.keywords.slice(0, 8);
    const serviceSuffixes = [
      "dienstleister",
      "systemintegrator",
      "loesungsanbieter",
      "engineering services",
      "automation partner",
      "industrial software",
      "projektentwicklung",
      "sondermaschinen software"
    ];

    const baseQueries = keywordVariants.map((keyword, index) => {
      const suffix = serviceSuffixes[(page + index) % serviceSuffixes.length];
      return `${keyword} ${suffix} ${location}`;
    });

    const targetedQueries = [
      `gestalt automation aehnliche firmen industrielle bildverarbeitung ${location}`,
      `veo automation aehnliche firmen systemintegrator ${location}`,
      `visiontechnik aehnliche firmen industrielle bildverarbeitung ${location}`,
      `maschinen vision systemintegrator gmbh ${location}`,
      `industrielle bildverarbeitung softwareentwicklung ${location}`,
      `automation software engineering gmbh ${location}`
    ];

    return [...baseQueries, ...targetedQueries];
  }

  private buildSourcePageQueries(filter: ApolloOrganizationFilter, page: number): string[] {
    const location = filter.locations[0] ?? "Germany";
    const keywordVariants = filter.keywords.slice(0, 6);
    const sourceSuffixes = [
      "aussteller",
      "exhibitor list",
      "partner",
      "mitglieder",
      "systemintegratoren",
      "loesungsanbieter",
      "dienstleister"
    ];

    return keywordVariants.map((keyword, index) => `${keyword} ${sourceSuffixes[(page + index) % sourceSuffixes.length]} ${location}`);
  }

  private async searchDuckDuckGo(query: string): Promise<string[]> {
    try {
      const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        signal: AbortSignal.timeout(10000),
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ONE-WARE-Lead-Agent/1.0)"
        }
      });

      if (!response.ok) {
        return [];
      }

      const html = await response.text();
      const matches = Array.from(html.matchAll(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>/gi));
      const urls: string[] = [];

      for (const match of matches) {
        if (urls.length >= SEARCH_RESULT_MAX_RESULTS_PER_QUERY) {
          break;
        }

        const rawHref = match[1]?.trim();
        if (!rawHref) {
          continue;
        }

        const resolvedHref = this.resolveSearchResultHref(rawHref);
        const normalizedHref = this.normalizeUrl(resolvedHref);
        if (!normalizedHref || this.shouldIgnoreDomain(normalizedHref) || urls.includes(normalizedHref)) {
          continue;
        }

        urls.push(normalizedHref);
      }

      return urls;
    } catch {
      return [];
    }
  }

  private resolveSearchResultHref(rawHref: string): string {
    if (/^https?:\/\//i.test(rawHref)) {
      return rawHref;
    }

    try {
      const parsed = new URL(rawHref, "https://html.duckduckgo.com");
      const target = parsed.searchParams.get("uddg");
      return target ? decodeURIComponent(target) : parsed.toString();
    } catch {
      return rawHref;
    }
  }

  private async discoverCompaniesFromSourcePages(
    filter: ApolloOrganizationFilter,
    limit: number,
    page: number
  ): Promise<CompanySample[]> {
    const startedAt = Date.now();
    const sourcePages = await this.discoverSourcePages(filter, page);
    if (sourcePages.length === 0) {
      return [];
    }

    const companies: CompanySample[] = [];
    const seenDomains = new Set<string>();

    for (const sourcePage of sourcePages.slice(0, SOURCE_DISCOVERY_MAX_SOURCE_PAGES)) {
      if (Date.now() - startedAt >= SOURCE_DISCOVERY_MAX_BUDGET_MS) {
        break;
      }

      const candidateDomains = await this.scrapeCandidateDomainsFromSourcePage(sourcePage.url as string);

      for (const candidateDomain of candidateDomains) {
        if (Date.now() - startedAt >= SOURCE_DISCOVERY_MAX_BUDGET_MS) {
          return companies;
        }

        const normalizedDomain = this.normalizeUrl(candidateDomain);
        if (!normalizedDomain || seenDomains.has(normalizedDomain) || this.shouldIgnoreDomain(normalizedDomain)) {
          continue;
        }

        seenDomains.add(normalizedDomain);
        const websiteProfile = await this.fetchWebsiteCrawlProfile(normalizedDomain);
        if (!websiteProfile || !this.looksLikePotentialDeliveryFit(websiteProfile.summary)) {
          continue;
        }

        companies.push({
          name: this.deriveCompanyName(normalizedDomain, websiteProfile.summary),
          domain: normalizedDomain,
          country: this.inferCountryFromDomain(normalizedDomain, websiteProfile.summary),
          shortDescription: websiteProfile.summary,
          sourceFilter: `${filter.name} (source-scrape)`
        });

        if (companies.length >= limit) {
          return companies;
        }
      }
    }

    return companies;
  }

  private async discoverSourcePages(filter: ApolloOrganizationFilter, page: number): Promise<SourcePageCandidate[]> {
    const pages: SourcePageCandidate[] = [];
    const seenUrls = new Set<string>();
    const queries = this.buildSourcePageQueries(filter, page).slice(0, 4);

    for (const query of queries) {
      const urls = await this.searchDuckDuckGo(query);
      for (const url of urls) {
        const normalizedUrl = this.normalizeUrl(url);
        if (!normalizedUrl || this.shouldIgnoreDomain(normalizedUrl) || seenUrls.has(normalizedUrl)) {
          continue;
        }

        seenUrls.add(normalizedUrl);
        pages.push({
          url: normalizedUrl,
          reason: `search:${query}`
        });
      }
    }

    return pages;
  }

  private async scrapeCandidateDomainsFromSourcePage(sourceUrl: string): Promise<string[]> {
    const startedAt = Date.now();
    const visitedPages = new Set<string>();
    const discoveredDomains = new Set<string>();
    const sourceHostname = new URL(sourceUrl).hostname.replace(/^www\./i, "");
    const pagesToVisit = [sourceUrl];

    while (
      pagesToVisit.length > 0 &&
      visitedPages.size < SOURCE_DISCOVERY_MAX_INTERNAL_PAGES &&
      discoveredDomains.size < SOURCE_DISCOVERY_MAX_CANDIDATE_DOMAINS &&
      Date.now() - startedAt < SOURCE_DISCOVERY_MAX_BUDGET_MS
    ) {
      const nextPage = pagesToVisit.shift() as string;
      if (visitedPages.has(nextPage)) {
        continue;
      }

      visitedPages.add(nextPage);

      try {
        const response = await fetch(nextPage, {
          redirect: "follow",
            signal: AbortSignal.timeout(10000),
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; ONE-WARE-Lead-Agent/1.0)"
            }
        });

        if (!response.ok) {
          continue;
        }

        const html = await response.text();
        const links = this.extractAnchors(html, nextPage);

        for (const link of links) {
          const normalizedHref = this.normalizeUrl(link.href);
          if (!normalizedHref) {
            continue;
          }

          const candidateHostname = new URL(normalizedHref).hostname.replace(/^www\./i, "");
          if (candidateHostname === sourceHostname) {
            if (
              visitedPages.size < SOURCE_DISCOVERY_MAX_INTERNAL_PAGES &&
              pagesToVisit.length < SOURCE_DISCOVERY_MAX_QUEUED_PAGES &&
              /(aussteller|exhibitor|member|mitglied|partner|company|unternehmen|supplier|vendor)/i.test(link.href + " " + link.text)
            ) {
              pagesToVisit.push(normalizedHref);
            }

            continue;
          }

          if (this.shouldIgnoreDomain(normalizedHref)) {
            continue;
          }

          discoveredDomains.add(normalizedHref);
          if (discoveredDomains.size >= SOURCE_DISCOVERY_MAX_CANDIDATE_DOMAINS) {
            break;
          }
        }
      } catch {
        continue;
      }
    }

    return Array.from(discoveredDomains);
  }

  private extractAnchors(html: string, baseUrl: string): Array<{ href: string; text: string }> {
    const anchors = Array.from(html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi));

    return anchors
      .map((match) => {
        const href = match[1]?.trim();
        const text = this.decodeHtml(match[2]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? "");
        if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) {
          return null;
        }

        try {
          return {
            href: new URL(href, baseUrl).toString(),
            text
          };
        } catch {
          return null;
        }
      })
      .filter((anchor): anchor is { href: string; text: string } => Boolean(anchor));
  }

  private looksLikePotentialDeliveryFit(summary: string): boolean {
    const lowered = summary.toLowerCase();
    const positiveSignals = [
      "system integrator",
      "software development",
      "engineering services",
      "implementation",
      "automation",
      "machine vision",
      "image processing",
      "inspection",
      "embedded software",
      "industrial software",
      "deep learning",
      "project"
    ];
    const negativeSignals = [
      "magazine",
      "publisher",
      "association",
      "university",
      "recruiting",
      "job board",
      "domain shop",
      "marketplace",
      "directory",
      "vendor directory",
      "company lists",
      "top 25",
      "oilfield",
      "distributor",
      "trader",
      "spare parts",
      "consulting",
      "pipeline inspection",
      "corrosion",
      "investor",
      "bank",
      "insurance"
    ];

    if (negativeSignals.some((signal) => lowered.includes(signal))) {
      return false;
    }

    return positiveSignals.some((signal) => lowered.includes(signal));
  }

  private deriveCompanyName(domain: string, summary: string): string {
    const titleCandidate = summary.split("|")[0]?.trim();
    if (titleCandidate && titleCandidate.length >= 3 && titleCandidate.length <= 80) {
      return titleCandidate;
    }

    const hostname = new URL(domain).hostname.replace(/^www\./i, "");
    const brand = hostname.split(".")[0].replace(/[-_]+/g, " ").trim();
    return brand.length > 0 ? brand : hostname;
  }

  async buildResearchContext(company: PreCategorizedCompany): Promise<SearchEvidence | null> {
    if (!readiness.openAIWebSearchConfigured) {
      return null;
    }

    const prompt = [
      "Research this company for ONE WARE using public web sources.",
      "Only use organization-level information.",
      "Do not include or search for personal data such as employee names, emails, direct phone numbers, or personal social profiles.",
      "Focus on company facts that help determine fit: business model, products, industries, delivery ownership, automation or vision signals, industrial use cases, geography, and recent business signals.",
      `Company name: ${company.name}`,
      company.domain ? `Known website: ${company.domain}` : undefined,
      company.country ? `Country: ${company.country}` : undefined,
      `Known description: ${company.shortDescription}`,
      `Current category: ${company.category}`,
      "Return strict JSON with {\"summary\":\"...\",\"findings\":[{\"fact\":\"...\",\"url\":\"https://...\"}],\"riskFlags\":[\"...\"]}."
    ].filter(Boolean).join("\n\n");

    try {
      const response = await this.runWebSearch(prompt, 1800, "deepResearch");
      const parsed = this.parseJson<{ summary?: string; findings?: Array<{ fact?: string; url?: string }>; riskFlags?: string[] }>(response.text);
      const citations = Array.from(
        new Set(
          [
            ...(parsed.findings ?? []).map((finding) => finding.url).filter((url): url is string => Boolean(url)),
            ...response.citations
          ]
        )
      );

      const findings = (parsed.findings ?? [])
        .filter((finding) => finding.fact && finding.url)
        .map((finding, index) => `Result ${index + 1}: ${finding.fact}\nURL: ${finding.url}`);

      return {
        context: [
          "OpenAI web search evidence:",
          `Company: ${company.name}`,
          parsed.summary ? `Summary: ${parsed.summary}` : undefined,
          parsed.riskFlags?.length ? `Risk flags: ${parsed.riskFlags.join(" | ")}` : undefined,
          ...findings
        ].filter(Boolean).join("\n\n"),
        citations
      };
    } catch {
      return null;
    }
  }

  async summarizeCompany(company: CompanySample): Promise<Partial<CompanySample> | null> {
    if (!readiness.openAIWebSearchConfigured) {
      return this.summarizeFromOfficialWebsite(company);
    }

    const prompt = [
      "Summarize this organization for lead qualification.",
      "Use only organization-level information.",
      "Do not include or search for personal data such as employee names, emails, direct phone numbers, or personal social profiles.",
      "Determine the company's actual business model, whether it primarily sells products or services, and whether it appears to implement customer projects.",
      "Be explicit if the company is mainly a product vendor, robotics maker, hardware company, publisher, media brand, investor, bank, recruiter, or other irrelevant profile instead of an implementation-led service provider.",
      `Company name: ${company.name}`,
      company.domain ? `Known website: ${company.domain}` : undefined,
      company.country ? `Known country: ${company.country}` : undefined,
      company.shortDescription ? `Current short description: ${company.shortDescription}` : undefined,
      "Return strict JSON with {\"country\":\"...\",\"shortDescription\":\"...\"}. Keep the shortDescription factual and concise."
    ].filter(Boolean).join("\n\n");

    try {
      const response = await this.runWebSearch(prompt, 320, "preResearch");
      const parsed = this.parseJson<{ country?: string; shortDescription?: string }>(response.text);
      const shortDescription = parsed.shortDescription?.trim();

      if (!shortDescription) {
        return this.summarizeFromOfficialWebsite(company);
      }

      return {
        country: parsed.country?.trim() || company.country,
        shortDescription
      };
    } catch {
      return this.summarizeFromOfficialWebsite(company);
    }
  }

  async crawlCompanyWebsite(domain: string | undefined): Promise<CrawledWebsiteProfile | null> {
    return this.fetchWebsiteCrawlProfile(domain);
  }

  private async summarizeFromOfficialWebsite(company: CompanySample): Promise<Partial<CompanySample> | null> {
    const websiteProfile = await this.fetchWebsiteCrawlProfile(company.domain);
    if (!websiteProfile) {
      return null;
    }

    return {
      country: company.country,
      shortDescription: websiteProfile.summary
    };
  }

  private async fetchHomepageSummary(domain: string | undefined): Promise<string | null> {
    const websiteProfile = await this.fetchWebsiteCrawlProfile(domain);
    return websiteProfile?.summary ?? null;
  }

  private async fetchWebsiteCrawlProfile(domain: string | undefined): Promise<CrawledWebsiteProfile | null> {
    const normalizedDomain = this.normalizeUrl(domain);
    if (!normalizedDomain) {
      return null;
    }

    const candidateUrls = this.buildCandidateUrls(normalizedDomain);

    for (const url of candidateUrls) {
      try {
        const response = await fetch(url, {
          redirect: "follow",
            signal: AbortSignal.timeout(10000),
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; ONE-WARE-Lead-Agent/1.0)"
            }
        });

        if (!response.ok) {
          continue;
        }

        const html = await response.text();
        const landingUrl = response.url || url;
        const summaries = [this.extractPageSummary(html, landingUrl, "home")].filter((value): value is string => Boolean(value));
        const relevantUrls: string[] = [];
        const relevantLinks = this.selectRelevantInternalLinks(html, landingUrl);

        for (const link of relevantLinks) {
          try {
            const pageResponse = await fetch(link.url, {
              redirect: "follow",
              signal: AbortSignal.timeout(10000),
              headers: {
                "User-Agent": "Mozilla/5.0 (compatible; ONE-WARE-Lead-Agent/1.0)"
              }
            });

            if (!pageResponse.ok) {
              continue;
            }

            const pageHtml = await pageResponse.text();
            const pageSummary = this.extractPageSummary(pageHtml, pageResponse.url || link.url, link.label);
            if (!pageSummary) {
              continue;
            }

            relevantUrls.push(pageResponse.url || link.url);
            summaries.push(pageSummary);
          } catch {
            continue;
          }
        }

        const summary = summaries.join(" || ").slice(0, 1600);
        if (summary) {
          return {
            summary,
            landingUrl,
            relevantUrls
          };
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private buildCandidateUrls(normalizedDomain: string): string[] {
    const parsed = new URL(normalizedDomain);
    const hostname = parsed.hostname.replace(/^www\./i, "");

    return Array.from(new Set([
      `https://${hostname}`,
      `https://www.${hostname}`,
      `http://${hostname}`,
      `http://www.${hostname}`
    ]));
  }

  private extractHomepageSummary(html: string): string | null {
    return this.extractPageSummary(html, "", "home");
  }

  private extractPageSummary(html: string, url: string, label: string): string | null {
    const title = this.extractTagContent(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
    const metaDescription =
      this.extractMetaContent(html, "description") ||
      this.extractMetaPropertyContent(html, "og:description");
    const firstHeading = this.extractTagContent(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const bodyText = this.extractVisibleText(html)
      .split(/\s{2,}|\n+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 40)
      .slice(0, 3);

    const parts = [title, metaDescription, firstHeading, ...bodyText]
      .map((part) => part?.trim())
      .filter((part): part is string => Boolean(part));

    if (parts.length === 0) {
      return null;
    }

    const normalizedLabel = label.trim().toLowerCase();
    const prefix = normalizedLabel && normalizedLabel !== "home" ? `${label}: ` : "";
    const pathHint = url ? this.describePath(url) : undefined;

    return [pathHint, `${prefix}${parts.join(" | ")}`]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 700);
  }

  private selectRelevantInternalLinks(html: string, baseUrl: string): Array<{ url: string; label: string }> {
    const baseHostname = new URL(baseUrl).hostname.replace(/^www\./i, "");
    const positivePattern = /(about|ueber|uber|unternehmen|company|services|service|leistungen|solutions|solution|loesungen|products|product|produkte|kompetenzen|portfolio|applications|anwendungen|industries|branchen|use cases|referenzen|references)/i;
    const negativePattern = /(news|blog|jobs|karriere|career|kontakt|contact|impressum|datenschutz|privacy|legal|terms|shop|cart|login)/i;
    const seenUrls = new Set<string>();
    const selected: Array<{ url: string; label: string; score: number }> = [];

    for (const anchor of this.extractAnchors(html, baseUrl)) {
      const candidateUrl = new URL(anchor.href, baseUrl);
      if (candidateUrl.hostname.replace(/^www\./i, "") !== baseHostname) {
        continue;
      }

      const haystack = `${candidateUrl.pathname} ${anchor.text}`;
      if (!positivePattern.test(haystack) || negativePattern.test(haystack)) {
        continue;
      }

      const pageUrl = candidateUrl.toString();
      if (seenUrls.has(pageUrl)) {
        continue;
      }

      seenUrls.add(pageUrl);
      selected.push({
        url: pageUrl,
        label: this.buildPageLabel(anchor.text, candidateUrl.pathname),
        score: this.scoreRelevantLink(haystack)
      });
    }

    return selected
      .sort((left, right) => right.score - left.score)
      .slice(0, 3)
      .map(({ url, label }) => ({ url, label }));
  }

  private scoreRelevantLink(value: string): number {
    const lowered = value.toLowerCase();
    let score = 0;

    if (/(about|ueber|uber|unternehmen|company)/.test(lowered)) {
      score += 3;
    }

    if (/(services|service|leistungen|solutions|loesungen|kompetenzen)/.test(lowered)) {
      score += 4;
    }

    if (/(products|product|produkte|applications|anwendungen|industries|branchen|references|referenzen)/.test(lowered)) {
      score += 2;
    }

    return score;
  }

  private buildPageLabel(anchorText: string, pathname: string): string {
    const cleanedAnchor = anchorText.replace(/\s+/g, " ").trim();
    if (cleanedAnchor.length >= 3) {
      return cleanedAnchor;
    }

    const pathSegment = pathname.split("/").filter(Boolean).pop()?.replace(/[-_]+/g, " ").trim();
    if (pathSegment && pathSegment.length >= 3) {
      return pathSegment;
    }

    return "page";
  }

  private describePath(url: string): string | undefined {
    try {
      const path = new URL(url).pathname;
      const segment = path.split("/").filter(Boolean).pop();
      if (!segment) {
        return undefined;
      }

      return segment.replace(/[-_]+/g, " ").trim();
    } catch {
      return undefined;
    }
  }

  private inferCountryFromDomain(domain: string, summary: string): string | undefined {
    const hostname = new URL(domain).hostname.toLowerCase();

    if (hostname.endsWith(".de") || /\bgmbh\b|\bdeutschland\b|\bgermany\b/i.test(summary)) {
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

    return undefined;
  }

  private extractMetaContent(html: string, name: string): string | undefined {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`<meta[^>]+name=["']${escapedName}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escapedName}["'][^>]*>`, "i")
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        return this.decodeHtml(match[1]);
      }
    }

    return undefined;
  }

  private extractMetaPropertyContent(html: string, property: string): string | undefined {
    const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`<meta[^>]+property=["']${escapedProperty}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escapedProperty}["'][^>]*>`, "i")
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        return this.decodeHtml(match[1]);
      }
    }

    return undefined;
  }

  private extractTagContent(html: string, pattern: RegExp): string | undefined {
    const match = html.match(pattern);
    if (!match?.[1]) {
      return undefined;
    }

    return this.decodeHtml(match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  }

  private extractVisibleText(html: string): string {
    return this.decodeHtml(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );
  }

  private decodeHtml(value: string): string {
    return value
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&shy;/gi, "")
      .replace(/&uuml;/gi, "u")
      .replace(/&ouml;/gi, "o")
      .replace(/&auml;/gi, "a")
      .replace(/&Uuml;/g, "U")
      .replace(/&Ouml;/g, "O")
      .replace(/&Auml;/g, "A")
      .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)));
  }

  private async runWebSearch(
    prompt: string,
    maxOutputTokens: number,
    mode: WebSearchMode
  ): Promise<{ text: string; citations: string[] }> {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`
      },
        signal: AbortSignal.timeout(mode === "preResearch" ? 30000 : 45000),
        body: JSON.stringify({
        model: openAIWebSearchModels[mode],
        tools: [{ type: "web_search_preview" }],
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: "You are the ONE WARE organization web search agent. Search only for company-level facts. Never include or infer personal data. Return only the requested JSON."
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: prompt
              }
            ]
          }
        ],
        max_output_tokens: maxOutputTokens
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI web search failed: ${response.status} ${await response.text()}`);
    }

    const payload = await response.json() as OpenAIResponsesOutput;
    const text = (
      payload.output_text?.trim() ||
      payload.output
        ?.flatMap((item) => item.content ?? [])
        .map((content) => content.text?.trim())
        .find((value): value is string => Boolean(value))
    );

    if (!text) {
      throw new Error("OpenAI web search returned no output text.");
    }

    const citations = Array.from(
      new Set(
        (payload.output ?? [])
          .flatMap((item) => item.content ?? [])
          .flatMap((content) => content.annotations ?? [])
          .filter((annotation) => annotation.type === "url_citation" && annotation.url)
          .map((annotation) => annotation.url as string)
      )
    );

    return { text, citations };
  }

  private parseJson<T>(value: string): T {
    const trimmed = value.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return JSON.parse((fenced?.[1] ?? trimmed).trim()) as T;
  }

  private normalizeCompany(
    company: { name?: string; domain?: string; country?: string; shortDescription?: string; whyRelevant?: string },
    filter: ApolloOrganizationFilter
  ): CompanySample | null {
    const name = company.name?.trim();
    if (!name) {
      return null;
    }

    const domain = this.normalizeUrl(company.domain);
    if (!domain || this.shouldIgnoreDomain(domain)) {
      return null;
    }

    return {
      name,
      domain,
      country: company.country?.trim() || filter.locations[0],
      shortDescription: company.shortDescription?.trim() || company.whyRelevant?.trim() || filter.persona,
      sourceFilter: `${filter.name} (openai-web-search)`
    };
  }

  private normalizeUrl(url: string | undefined): string | undefined {
    if (!url) {
      return undefined;
    }

    try {
      const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
      return `${parsed.protocol}//${parsed.hostname}`;
    } catch {
      return undefined;
    }
  }

  private shouldIgnoreDomain(url: string): boolean {
    const lowered = url.toLowerCase();
    const blockedDomains = [
      "bing.com",
      "google.com",
      "wikipedia.org",
      "duden.de",
      "linkedin.com",
      "youtube.com",
      "facebook.com",
      "instagram.com",
      "builtin.com",
      "indeed.com",
      "glassdoor.com",
      "crunchbase.com",
      "clutch.co",
      "automation-list.com",
      "inven.ai",
      "tracxn.com",
      "f6s.com",
      "ensun.io",
      "wlw.de",
      "werliefertwas.com"
    ];

    return blockedDomains.some((domain) => lowered.includes(domain));
  }
}
