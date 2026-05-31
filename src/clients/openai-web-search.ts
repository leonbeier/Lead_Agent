import { env, openAIWebSearchModels, readiness } from "../config";
import { OrganizationFilter, CompanySample, CrawledWebsiteProfile, PreCategorizedCompany } from "../types";

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

const SOURCE_DISCOVERY_MAX_SOURCE_PAGES = 4;
const SOURCE_DISCOVERY_MAX_INTERNAL_PAGES = 4;
const SOURCE_DISCOVERY_MAX_QUEUED_PAGES = 6;
const SOURCE_DISCOVERY_MAX_CANDIDATE_DOMAINS = 20;
const SOURCE_DISCOVERY_MAX_BUDGET_MS = 18000;
const SEARCH_RESULT_MAX_QUERIES = 6;
const SEARCH_RESULT_MAX_RESULTS_PER_QUERY = 25;
const SEARCH_RESULT_QUERY_CONCURRENCY = 4;
const SEARCH_RESULT_DDG_TIMEOUT_MS = 3500;
const SEARCH_RESULT_BING_TIMEOUT_MS = 5000;
const CRAWL_DISCOVERY_CONCURRENCY = 6;
const INTERNAL_PAGE_CRAWL_CONCURRENCY = 4;
const SOURCE_PAGE_FETCH_TIMEOUT_MS = 5000;
const WEBSITE_CRAWL_TIMEOUT_MS = 12000;
const INTERNAL_PAGE_CRAWL_TIMEOUT_MS = 8000;
const OPENAI_PRE_RESEARCH_TIMEOUT_MS = 8000;
const OPENAI_DEEP_RESEARCH_TIMEOUT_MS = 30000;
const DEFAULT_BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9,de;q=0.8"
};
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

export class OpenAIWebSearchClient {
  async discoverCompanies(
    filter: OrganizationFilter,
    limit: number,
    page = 1,
    shouldSkipDomain?: (domain: string) => boolean
  ): Promise<CompanySample[]> {
    const companies: CompanySample[] = [];
    const seenKeys = new Set<string>();

    const searchResultCompanies = await this.discoverCompaniesFromKeywordSearch(filter, limit, page, shouldSkipDomain);
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

    const scrapedCompanies = await this.discoverCompaniesFromSourcePages(filter, limit, page, shouldSkipDomain);
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
    filter: OrganizationFilter,
    limit: number,
    page: number,
    shouldSkipDomain?: (domain: string) => boolean
  ): Promise<CompanySample[]> {
    const queries = this.buildKeywordQueries(filter, page).slice(0, SEARCH_RESULT_MAX_QUERIES);
    const queryResults = await this.mapWithConcurrency(
      queries.map((query) => async () => ({
        query,
        candidateUrls: await this.searchCandidateUrls(query, filter, shouldSkipDomain)
      })),
      SEARCH_RESULT_QUERY_CONCURRENCY
    );

    const companies: CompanySample[] = [];
    const seenDomains = new Set<string>();
    const domainsToCrawl: Array<{ domain: string; query: string }> = [];

    for (const queryResult of queryResults) {
      for (const candidateUrl of queryResult.candidateUrls) {
        const normalizedDomain = this.normalizeUrl(candidateUrl);
        if (
          !normalizedDomain ||
          seenDomains.has(normalizedDomain) ||
          this.shouldIgnoreDomain(normalizedDomain) ||
          shouldSkipDomain?.(normalizedDomain)
        ) {
          continue;
        }

        seenDomains.add(normalizedDomain);
        domainsToCrawl.push({ domain: normalizedDomain, query: queryResult.query });
      }
    }

    const crawledCompanies = await this.mapWithConcurrency(
      domainsToCrawl.map(({ domain, query }) => async () => {
        const websiteProfile = await this.fetchWebsiteCrawlProfile(domain);
        if (!websiteProfile || !this.looksLikePotentialDeliveryFit(websiteProfile.summary)) {
          return null;
        }

        return {
          name: this.deriveCompanyName(domain, websiteProfile.summary),
          domain: this.toCanonicalCompanyDomain(domain),
          country: this.inferCountryFromDomain(domain, websiteProfile.summary),
          shortDescription: websiteProfile.summary,
          sourceFilter: `${filter.name} (browser-search: ${this.compactQueryLabel(query)})`
        } satisfies CompanySample;
      }),
      CRAWL_DISCOVERY_CONCURRENCY
    );

    for (const company of crawledCompanies) {
      if (!company) {
        continue;
      }

      companies.push(company);
      if (companies.length >= limit) {
        return companies;
      }
    }

    return companies;
  }

  private async searchCandidateUrls(
    query: string,
    filter: OrganizationFilter,
    shouldSkipDomain?: (domain: string) => boolean
  ): Promise<string[]> {
    const duckDuckGoUrls = await this.searchDuckDuckGo(query, shouldSkipDomain);
    if (duckDuckGoUrls.length > 0) {
      return duckDuckGoUrls;
    }

    const bingUrls = await this.searchBing(query, shouldSkipDomain);
    if (bingUrls.length > 0 || !readiness.openAIWebSearchConfigured) {
      return bingUrls;
    }

    return this.searchWithOpenAIWebFallback(query, filter, shouldSkipDomain);
  }

  private async searchBing(query: string, shouldSkipDomain?: (domain: string) => boolean): Promise<string[]> {
    try {
      const response = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
        signal: AbortSignal.timeout(SEARCH_RESULT_BING_TIMEOUT_MS),
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ONE-WARE-Lead-Agent/1.0)"
        }
      });

      if (!response.ok) {
        return [];
      }

      const html = await response.text();
      const matches = Array.from(html.matchAll(/<h2[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["']/gi));
      const urls: string[] = [];

      for (const match of matches) {
        if (urls.length >= SEARCH_RESULT_MAX_RESULTS_PER_QUERY) {
          break;
        }

        const resolvedHref = this.resolveSearchResultHref(match[1]?.trim() ?? "");
        const normalizedHref = this.normalizeUrl(resolvedHref);
        if (
          !normalizedHref ||
          this.shouldIgnoreDomain(normalizedHref) ||
          shouldSkipDomain?.(normalizedHref) ||
          urls.includes(normalizedHref)
        ) {
          continue;
        }

        urls.push(normalizedHref);
      }

      return urls;
    } catch {
      return [];
    }
  }

  private buildKeywordQueries(filter: OrganizationFilter, page: number): string[] {
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

    const primaryKeywords = keywordVariants.slice(0, 3);
    const secondaryKeywords = keywordVariants.slice(3, 6);

    const targetedQueries = [
      `${primaryKeywords.join(" ")} kundenprojekte ${location}`,
      `${primaryKeywords.join(" ")} gmbh ${location}`,
      `${primaryKeywords.join(" ")} ${secondaryKeywords.join(" ")} ${location}`,
      `${filter.persona} ${location}`,
      `${keywordVariants.slice(0, 2).join(" ")} engineering services ${location}`,
      `${keywordVariants.slice(1, 4).join(" ")} systemintegrator ${location}`
    ];

    return [...baseQueries, ...targetedQueries];
  }

  private buildSourcePageQueries(filter: OrganizationFilter, page: number): string[] {
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

  private async searchDuckDuckGo(query: string, shouldSkipDomain?: (domain: string) => boolean): Promise<string[]> {
    try {
      const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        signal: AbortSignal.timeout(SEARCH_RESULT_DDG_TIMEOUT_MS),
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
        if (
          !normalizedHref ||
          this.shouldIgnoreDomain(normalizedHref) ||
          shouldSkipDomain?.(normalizedHref) ||
          urls.includes(normalizedHref)
        ) {
          continue;
        }

        urls.push(normalizedHref);
      }

      return urls;
    } catch {
      return [];
    }
  }

  private async searchWithOpenAIWebFallback(
    query: string,
    filter: OrganizationFilter,
    shouldSkipDomain?: (domain: string) => boolean
  ): Promise<string[]> {
    try {
      const response = await this.runWebSearch(
        [
          "Find official company websites for this company discovery query.",
          "Return only organization homepages or official company sites.",
          "Exclude directories, media sites, LinkedIn, social profiles, marketplaces, events, and article pages.",
          `Market intent: ${filter.persona}`,
          `Target region: ${filter.locations.join(", ") || "Germany"}`,
          `Search query: ${query}`,
          `Keywords: ${filter.keywords.slice(0, 8).join(", ")}`,
          "Return strict JSON with {\"websites\":[\"https://example.com\"]}. Limit to 12 websites."
        ].join("\n\n"),
        160,
        "preResearch"
      );

      const parsed = this.parseJson<{ websites?: string[] }>(response.text);
      const candidateUrls = [...(parsed.websites ?? []), ...response.citations];

      return Array.from(
        new Set(
          candidateUrls
            .map((url) => this.normalizeUrl(url))
            .filter((url): url is string => Boolean(url))
            .filter((url) => !this.shouldIgnoreDomain(url))
            .filter((url) => !shouldSkipDomain?.(url))
        )
      ).slice(0, SEARCH_RESULT_MAX_RESULTS_PER_QUERY);
    } catch {
      return [];
    }
  }

  private resolveSearchResultHref(rawHref: string): string {
    const decodedHref = this.decodeHtml(rawHref);

    if (/^https?:\/\//i.test(decodedHref)) {
      try {
        const parsed = new URL(decodedHref);

        if (/bing\.com$/i.test(parsed.hostname)) {
          const directTarget = parsed.searchParams.get("target") ?? parsed.searchParams.get("url");
          if (directTarget) {
            return decodeURIComponent(directTarget);
          }

          const encodedTarget = parsed.searchParams.get("u");
          if (encodedTarget) {
            const normalizedTarget = encodedTarget.startsWith("a1") ? encodedTarget.slice(2) : encodedTarget;

            try {
              const decodedTarget = Buffer.from(normalizedTarget, "base64").toString("utf8");
              if (/^https?:\/\//i.test(decodedTarget)) {
                return decodedTarget;
              }
            } catch {
              return decodedHref;
            }
          }
        }

        return decodedHref;
      } catch {
        return decodedHref;
      }
    }

    try {
      const parsed = new URL(decodedHref, "https://html.duckduckgo.com");
      const target = parsed.searchParams.get("uddg");
      return target ? decodeURIComponent(target) : parsed.toString();
    } catch {
      return decodedHref;
    }
  }

  private compactQueryLabel(query: string): string {
    const normalized = query.replace(/^search:/i, "").replace(/\s+/g, " ").trim();
    return normalized.length <= 70 ? normalized : `${normalized.slice(0, 67)}...`;
  }

  private async discoverCompaniesFromSourcePages(
    filter: OrganizationFilter,
    limit: number,
    page: number,
    shouldSkipDomain?: (domain: string) => boolean
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
      const crawlDomains: string[] = [];

      for (const candidateDomain of candidateDomains) {
        if (Date.now() - startedAt >= SOURCE_DISCOVERY_MAX_BUDGET_MS) {
          return companies;
        }

        const normalizedDomain = this.normalizeUrl(candidateDomain);
        if (
          !normalizedDomain ||
          seenDomains.has(normalizedDomain) ||
          this.shouldIgnoreDomain(normalizedDomain) ||
          shouldSkipDomain?.(normalizedDomain)
        ) {
          continue;
        }

        seenDomains.add(normalizedDomain);
        crawlDomains.push(normalizedDomain);
      }

      const crawledCompanies = await this.mapWithConcurrency(
        crawlDomains.map((domain) => async () => {
          const websiteProfile = await this.fetchWebsiteCrawlProfile(domain);
          if (!websiteProfile || !this.looksLikePotentialDeliveryFit(websiteProfile.summary)) {
            return null;
          }

          return {
            name: this.deriveCompanyName(domain, websiteProfile.summary),
            domain: this.toCanonicalCompanyDomain(domain),
            country: this.inferCountryFromDomain(domain, websiteProfile.summary),
            shortDescription: websiteProfile.summary,
            sourceFilter: `${filter.name} (source-scrape: ${this.compactQueryLabel(sourcePage.reason ?? sourcePage.url ?? "source-page")})`
          } satisfies CompanySample;
        }),
        CRAWL_DISCOVERY_CONCURRENCY
      );

      for (const company of crawledCompanies) {
        if (!company) {
          continue;
        }

        companies.push(company);

        if (companies.length >= limit) {
          return companies;
        }
      }
    }

    return companies;
  }

  private async discoverSourcePages(filter: OrganizationFilter, page: number): Promise<SourcePageCandidate[]> {
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
            signal: AbortSignal.timeout(SOURCE_PAGE_FETCH_TIMEOUT_MS),
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
      "implementation services",
      "implementation",
      "automation",
      "machine vision",
      "image processing",
      "inspection",
      "embedded software",
      "industrial software",
      "industrial ai",
      "computer vision",
      "aoi",
      "automated optical inspection",
      "quality inspection",
      "feasibility study",
      "solution provider",
      "deep learning",
      "project"
    ];
    const specialistConsultingSignals = [
      "machine vision consultant",
      "computer vision consultant",
      "vision ai consulting",
      "industrial ai consulting",
      "embedded vision consultant",
      "inspection ai consultant",
      "freelancer",
      "freiberuf",
      "beratung",
      "consulting services"
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
      "top 10",
      "best of",
      "ranked list",
      "oilfield",
      "distributor",
      "trader",
      "spare parts",
      "pipeline inspection",
      "corrosion",
      "investor",
      "bank",
      "insurance",
      "newsroom",
      "press release",
      "academy",
      "training center",
      "shop",
      "e-commerce"
    ];

    const hasSpecialistConsultingSignal = specialistConsultingSignals.some((signal) => lowered.includes(signal));
    const hasPositiveSignal = positiveSignals.some((signal) => lowered.includes(signal));
    const hasStrongDeliveryContext = /(customer|kunden|implementation|integration|engineering|projekt|delivery|services|dienstleistung)/.test(lowered);

    if (negativeSignals.some((signal) => lowered.includes(signal))) {
      return false;
    }

    if (lowered.includes("consulting") && !hasSpecialistConsultingSignal) {
      return false;
    }

    if (hasSpecialistConsultingSignal) {
      return hasPositiveSignal || hasStrongDeliveryContext;
    }

    return hasPositiveSignal;
  }

  private deriveCompanyName(domain: string, summary: string): string {
    const hostname = new URL(domain).hostname.replace(/^www\./i, "");
    const registrableHostname = this.toRegistrableHostname(hostname);
    const brand = registrableHostname.split(".")[0].replace(/[-_]+/g, " ").trim();
    const normalizedBrand = brand.replace(/\s+/g, "").toLowerCase();
    const candidates = summary
      .split("|")
      .map((part) => part.trim())
      .filter((part) => part.length >= 3 && part.length <= 80)
      .slice(0, 6);

    const preferredCandidate = candidates.find((candidate) => this.looksLikeCompanyName(candidate, normalizedBrand));
    if (preferredCandidate) {
      return preferredCandidate;
    }

    return brand.length > 0 ? this.toTitleCaseWords(brand) : registrableHostname;
  }

  private looksLikeCompanyName(candidate: string, normalizedBrand: string): boolean {
    const lowered = candidate.toLowerCase();
    const normalizedCandidate = lowered.replace(/[^a-z0-9]+/g, "");
    const looksLikeSlogan = /(trusted by|powered by|built for|made for|future of|designed for|engineered for|your partner|tailored for|driven by)/i.test(candidate);
    const genericNames = [
      "home",
      "startseite",
      "homepage",
      "welcome",
      "press",
      "news",
      "blog",
      "weltweite qualitaetskontrollen",
      "worldwide quality controls",
      "quality controls",
      "quality control"
    ];
    if (genericNames.includes(lowered)) {
      return false;
    }

    if (/(home|startseite|welcome|solutions|services|products|news|blog)\s*[-|:]/i.test(candidate)) {
      return false;
    }

    if (looksLikeSlogan) {
      return false;
    }

    if (normalizedBrand && normalizedCandidate.includes(normalizedBrand)) {
      return true;
    }

    if (/(gmbh|mbh|ag|kg|ug|llc|inc|ltd|corp|bv|oy|ab|group|international)$/i.test(lowered)) {
      return true;
    }

    return candidate.split(/\s+/).length <= 3 && !/(weltweite|worldwide|global|international quality|quality controls)/i.test(candidate);
  }

  private toTitleCaseWords(value: string): string {
    return value
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  }

  private toCanonicalCompanyDomain(domain: string): string {
    const parsed = new URL(domain);
    return `${parsed.protocol}//${this.toRegistrableHostname(parsed.hostname)}`;
  }

  private toRegistrableHostname(hostname: string): string {
    const normalizedHostname = hostname.toLowerCase().replace(/^www\./, "");
    const labels = normalizedHostname.split(".").filter(Boolean);
    if (labels.length <= 2) {
      return normalizedHostname;
    }

    const compoundTld = labels.slice(-2).join(".");
    return COMMON_COMPOUND_TLDS.has(compoundTld)
      ? labels.slice(-3).join(".")
      : labels.slice(-2).join(".");
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

  async findCompanyAddress(company: Pick<PreCategorizedCompany, "name" | "domain" | "country">): Promise<{
    address?: string;
    city?: string;
    zip?: string;
    state?: string;
    country?: string;
  } | null> {
    if (!readiness.openAIWebSearchConfigured) {
      return null;
    }

    const prompt = [
      "Find the official postal address of this company using public organization-level web sources.",
      "Use only organization-level information from the company website, legal notice, contact page, map listing, or reputable company directory.",
      "Do not include or search for personal data such as employee names, personal emails, direct phone numbers, or personal social profiles.",
      "Return only the best verified headquarters or main office mailing address if available.",
      "Accept an address only when a full street-level postal address is explicitly shown in a trustworthy source.",
      "Reject marketing copy, news fragments, certifications, slogans, award text, date strings, boilerplate, or generic company descriptions even if they contain numbers or locations.",
      "If you cannot verify a full postal address confidently, return empty strings and mark verificationStatus as not_found or uncertain instead of guessing.",
      `Company name: ${company.name}`,
      company.domain ? `Known website: ${company.domain}` : undefined,
      company.country ? `Known country: ${company.country}` : undefined,
      "Return strict JSON with {\"address\":\"...\",\"city\":\"...\",\"zip\":\"...\",\"state\":\"...\",\"country\":\"...\",\"verificationStatus\":\"verified|uncertain|not_found\",\"confidence\":0.0,\"sourceType\":\"official_website|legal_notice|map_listing|directory|other\",\"reason\":\"...\"}. Use empty strings for unknown values."
    ].filter(Boolean).join("\n\n");

    try {
      const response = await this.runWebSearch(prompt, 320, "preResearch");
      const parsed = this.parseJson<{
        address?: string;
        city?: string;
        zip?: string;
        state?: string;
        country?: string;
        verificationStatus?: string;
        confidence?: number | string;
      }>(response.text);
      const verificationStatus = parsed.verificationStatus?.trim().toLowerCase();
      const confidence = typeof parsed.confidence === "number"
        ? parsed.confidence
        : Number.parseFloat(String(parsed.confidence ?? ""));
      const result = {
        address: parsed.address?.trim(),
        city: parsed.city?.trim(),
        zip: parsed.zip?.trim(),
        state: parsed.state?.trim(),
        country: parsed.country?.trim() || company.country
      };

      if (!this.looksLikeStructuredPostalAddress(result.address, result.city, result.zip)) {
        return null;
      }

      if (verificationStatus === "not_found") {
        return null;
      }

      if (Number.isFinite(confidence) && confidence < 0.2) {
        return null;
      }

      return result.address || result.city || result.zip || result.state || result.country ? result : null;
    } catch {
      return null;
    }
  }

  private looksLikeStructuredPostalAddress(address?: string, city?: string, zip?: string): boolean {
    const street = address?.trim();
    const locality = city?.trim();
    const postalCode = zip?.trim();

    if (!street || !locality || !postalCode) {
      return false;
    }

    if (street.length > 120 || /[.!?]/.test(street)) {
      return false;
    }

    const hasStreetKeyword = /(straße|strasse|street|road|avenue|platz|allee|gasse|lane|boulevard|drive|ring|weg|damm|ufer|rue|calle|carrer|plaza|laan|straat|via|viale|quai|court|terrace|chauss[ée]e)/i.test(street);
    const hasSimpleHouseNumberPattern = /^\d{1,4}[a-zA-Z]?\s+.+/.test(street)
      || /^.+\s+\d{1,4}[a-zA-Z]?$/.test(street);

    if (!hasStreetKeyword && !hasSimpleHouseNumberPattern) {
      return false;
    }

    if (/\d/.test(locality) || locality.split(/\s+/).length > 4) {
      return false;
    }

    return /^[A-Z]{0,2}[\- ]?\d{4,5}$/i.test(postalCode.replace(/\s+/g, " "));
  }

  async findCompanyContactInfo(company: Pick<PreCategorizedCompany, "name" | "domain" | "country">): Promise<{
    emails: string[];
    phones: string[];
    urls: string[];
  } | null> {
    if (!readiness.openAIWebSearchConfigured) {
      return null;
    }

    const prompt = [
      "Find the official public company contact details for this organization using only organization-level web sources.",
      "Use only the official company website, official contact page, legal notice/impressum, or reputable company directory pages that cite the official contact details.",
      "Do not include personal data such as employee names, personal emails, direct personal phone numbers, or personal social profiles.",
      "Prefer shared company inboxes and main office or switchboard phone numbers.",
      `Company name: ${company.name}`,
      company.domain ? `Known website: ${company.domain}` : undefined,
      company.country ? `Known country: ${company.country}` : undefined,
      "Return strict JSON with {\"emails\":[\"info@example.com\"],\"phones\":[\"+49 ...\"],\"urls\":[\"https://example.com/kontakt\"]}. Use empty arrays when unknown."
    ].filter(Boolean).join("\n\n");

    try {
      const response = await this.runWebSearch(prompt, 320, "preResearch");
      const parsed = this.parseJson<{ emails?: string[]; phones?: string[]; urls?: string[] }>(response.text);
      const result = {
        emails: Array.from(new Set((parsed.emails ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))),
        phones: Array.from(new Set((parsed.phones ?? []).map((value) => value.trim()).filter(Boolean))),
        urls: Array.from(new Set((parsed.urls ?? []).map((value) => value.trim()).filter(Boolean)))
      };

      return result.emails.length > 0 || result.phones.length > 0 || result.urls.length > 0
        ? result
        : null;
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

  async fetchOfficialWebsitePageHtml(url: string, timeoutMs = INTERNAL_PAGE_CRAWL_TIMEOUT_MS): Promise<string | null> {
    try {
      const response = await this.fetchWebsitePage(url, timeoutMs);
      if (!response.ok) {
        return null;
      }

      return response.text();
    } catch {
      return null;
    }
  }

  private async summarizeOfficialSiteViaWebSearch(domain: string): Promise<CrawledWebsiteProfile | null> {
    if (!readiness.openAIWebSearchConfigured) {
      return null;
    }

    const prompt = [
      "Summarize this organization using only pages from its official website.",
      "Use only organization-level information.",
      "Do not include or search for personal data such as employee names, emails, direct phone numbers, or personal social profiles.",
      "Review the official site broadly, including about, products, services, integrations, documentation, applications, references, and industry pages when available.",
      "Ignore careers, legal, privacy, cookie, login, newsletter, and generic navigation pages.",
      "Determine the company's actual business model, whether it primarily sells products or services, whether it exposes an embeddable product surface, and whether it appears to implement customer projects.",
      `Official website: ${domain}`,
      "Return strict JSON with {\"summary\":\"...\",\"urls\":[\"https://example.com/page\"]}. Keep summary factual and concise."
    ].join("\n\n");

    try {
      const response = await this.runWebSearch(prompt, 420, "preResearch");
      const parsed = this.parseJson<{ summary?: string; urls?: string[] }>(response.text);
      const baseHostname = this.toRegistrableHostname(new URL(domain).hostname);
      const relevantUrls = Array.from(
        new Set(
          [...(parsed.urls ?? []), ...response.citations]
            .filter((url): url is string => Boolean(url))
            .filter((url) => {
              try {
                return this.toRegistrableHostname(new URL(url).hostname) === baseHostname;
              } catch {
                return false;
              }
            })
        )
      ).slice(0, 6);

      const summary = parsed.summary?.trim();
      if (!summary) {
        return null;
      }

      return {
        summary,
        landingUrl: domain,
        relevantUrls
      };
    } catch {
      return null;
    }
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
        const response = await this.fetchWebsitePage(url, WEBSITE_CRAWL_TIMEOUT_MS);

        if (!response.ok) {
          continue;
        }

        const html = await response.text();
        const landingUrl = response.url || url;
        const summaries = [this.extractPageSummary(html, landingUrl, "home")].filter((value): value is string => Boolean(value));
        const relevantLinks = this.selectRelevantInternalLinks(html, landingUrl);
        const linkedPageResults = await this.mapWithConcurrency(
          relevantLinks.map((link) => async () => {
            try {
              const pageResponse = await this.fetchWebsitePage(link.url, INTERNAL_PAGE_CRAWL_TIMEOUT_MS);

              if (!pageResponse.ok) {
                return null;
              }

              const pageHtml = await pageResponse.text();
              const resolvedUrl = pageResponse.url || link.url;
              const pageSummary = this.extractPageSummary(pageHtml, resolvedUrl, link.label);
              if (!pageSummary) {
                return null;
              }

              return {
                url: resolvedUrl,
                summary: pageSummary
              };
            } catch {
              return null;
            }
          }),
          INTERNAL_PAGE_CRAWL_CONCURRENCY
        );

        const relevantUrls: string[] = [];
        const seenRelevantUrls = new Set<string>();
        for (const linkedPage of linkedPageResults) {
          if (!linkedPage) {
            continue;
          }

          if (!seenRelevantUrls.has(linkedPage.url)) {
            seenRelevantUrls.add(linkedPage.url);
            relevantUrls.push(linkedPage.url);
          }
          summaries.push(linkedPage.summary);
        }

        const summary = summaries.join("\n").slice(0, 3600);
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

    return this.summarizeOfficialSiteViaWebSearch(normalizedDomain);
  }

  private buildCandidateUrls(normalizedDomain: string): string[] {
    const parsed = new URL(normalizedDomain);
    const hostname = parsed.hostname.replace(/^www\./i, "");

    return Array.from(new Set([
      `https://${hostname}`,
      `https://${hostname}/en/`,
      `https://${hostname}/de/`,
      `https://www.${hostname}`,
      `https://www.${hostname}/en/`,
      `https://www.${hostname}/de/`,
      `http://${hostname}`
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
    const visibleText = this.extractVisibleText(html);
    const bodyExcerpt = visibleText
      .split(/\n+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 30)
      .filter((part) => !/(cookie|privacy|datenschutz|newsletter|career|karriere|jobs|bewerbung|additional links|powered by|impressum|legal terms)/i.test(part))
      .slice(0, 18)
      .join(" | ")
      .slice(0, 1600);

    const parts = [title, metaDescription, firstHeading, bodyExcerpt]
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
      .slice(0, 1800);
  }

  private selectRelevantInternalLinks(html: string, baseUrl: string): Array<{ url: string; label: string }> {
    const baseHostname = new URL(baseUrl).hostname.replace(/^www\./i, "");
    const positivePattern = /(about|ueber|uber|unternehmen|company|services|service|leistungen|solutions|solution|loesungen|products|product|produkte|kompetenzen|portfolio|applications|anwendungen|industries|branchen|use cases|usecases|referenzen|references|docs|documentation|api|schnittstellen|integration|integrations|plugins|plugin|modules|module|drivers|devices|instrument|instrumente|platform|plattform|workflow|automation|diagnostic|pacs|viewer|scanner|scan|vision|inspection|quality|kontakt|contact|ansprechpartner|team|management|leadership|people|staff|employee|profil|profile|impressum|legal|imprint)/i;
    const negativePattern = /(news|blog|jobs|karriere|career|datenschutz|privacy|terms|shop|cart|login)/i;
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
        .slice(0, 6)
      .map(({ url, label }) => ({ url, label }));
  }

  private scoreRelevantLink(value: string): number {
    const lowered = value.toLowerCase();
    let score = 0;

    if (/(about|ueber|uber|unternehmen|company)/.test(lowered)) {
      score += 1;
    }

    if (/(kontakt|contact|ansprechpartner|team|management|leadership|people|staff|employee|profil|profile|impressum|imprint|legal)/.test(lowered)) {
      score += 5;
    }

    if (/(services|service|leistungen|solutions|loesungen|kompetenzen)/.test(lowered)) {
      score += 2;
    }

    if (/(products|product|produkte|applications|anwendungen|industries|branchen|references|referenzen)/.test(lowered)) {
      score += /(industries|branchen)/.test(lowered) ? 1 : 3;
    }

    if (/(api|schnittstellen|integration|integrations|plugins|plugin|modules|module|drivers|devices|instrument|instrumente|platform|plattform|workflow|automation|docs|documentation)/.test(lowered)) {
      score += 4;
    }

    if (/(custom|customer-specific|system integration|engineering|industrial automation|embedded computing|racks|chassis|inspection|machine vision|diagnostic|pacs|viewer|scanner|scan|vision|quality)/.test(lowered)) {
      score += 4;
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

  private async mapWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
    const results: T[] = [];

    for (let start = 0; start < tasks.length; start += concurrency) {
      const batch = tasks.slice(start, start + concurrency);
      results.push(...(await Promise.all(batch.map((task) => task()))));
    }

    return results;
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
        .replace(/<\s*br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|section|article|li|ul|ol|h1|h2|h3|h4|h5|h6|table|tr)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s+/g, "\n")
        .replace(/\n{2,}/g, "\n")
        .trim()
    );
  }

  private async fetchWebsitePage(url: string, timeoutMs: number): Promise<Response> {
    try {
      return await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: DEFAULT_BROWSER_HEADERS
      });
    } catch (error) {
      if (!this.isTlsValidationError(error)) {
        throw error;
      }

      const undici = await import("undici");
      const dispatcher = new undici.Agent({
        connect: { rejectUnauthorized: false }
      } as any);

      return fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: DEFAULT_BROWSER_HEADERS,
        dispatcher: dispatcher as any
      } as any);
    }
  }

  private isTlsValidationError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const causeCode = typeof (error as Error & { cause?: { code?: string } }).cause?.code === "string"
      ? (error as Error & { cause?: { code?: string } }).cause?.code
      : undefined;

    return causeCode === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || /certificate/i.test(error.message);
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
        signal: AbortSignal.timeout(mode === "preResearch" ? OPENAI_PRE_RESEARCH_TIMEOUT_MS : OPENAI_DEEP_RESEARCH_TIMEOUT_MS),
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
    filter: OrganizationFilter
  ): CompanySample | null {
    const rawName = company.name?.trim();
    const domain = this.normalizeUrl(company.domain);
    const name = rawName && domain ? this.looksLikeCompanyName(rawName, this.toRegistrableHostname(new URL(domain).hostname).split(".")[0])
      ? rawName
      : this.deriveCompanyName(domain, [rawName, company.shortDescription, company.whyRelevant].filter(Boolean).join(" | "))
      : rawName;
    if (!name) {
      return null;
    }

    if (!domain || this.shouldIgnoreDomain(domain)) {
      return null;
    }

    return {
      name,
      domain: this.toCanonicalCompanyDomain(domain),
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
