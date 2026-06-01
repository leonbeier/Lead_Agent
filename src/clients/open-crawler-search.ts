import { OrganizationFilter, CompanySample, CrawledWebsiteProfile, PreCategorizedCompany } from "../types";

interface SearchEvidence {
  context: string;
  citations: string[];
}

interface SourcePageCandidate {
  url: string;
  reason: string;
}

interface CrawlSignal {
  keyword: string;
  scoreDelta: number;
  signalType: "positive" | "integrator" | "negative";
}

interface PageCrawlResult {
  url: string;
  summary: string;
  signals: CrawlSignal[];
}

interface DomainCrawlResult {
  domain: string;
  companyName: string;
  country?: string;
  landingUrl: string;
  relevantUrls: string[];
  summary: string;
  totalScore: number;
  confidence: "high" | "review" | "low";
  signals: CrawlSignal[];
}

export interface OpenCrawlerDiscoveryMetrics {
  crawledPages: number;
  acceptedCompanyDomains: number;
}

const SEARCH_RESULT_MAX_QUERIES = 4;
const SEARCH_RESULT_MAX_RESULTS_PER_QUERY = 8;
const SEARCH_RESULT_QUERY_CONCURRENCY = 5;
const SEARCH_RESULT_DDG_TIMEOUT_MS = 3500;
const SEARCH_RESULT_BING_TIMEOUT_MS = 5000;
const SOURCE_PAGE_FETCH_TIMEOUT_MS = 5000;
const WEBSITE_CRAWL_TIMEOUT_MS = 4500;
const INTERNAL_PAGE_CRAWL_TIMEOUT_MS = 3500;
const WEBSITE_CRAWL_RETRY_ATTEMPTS = 2;
const WEBSITE_CRAWL_RETRY_DELAY_MS = 500;
const SOURCE_DISCOVERY_MAX_SOURCE_PAGES = 4;
const SOURCE_DISCOVERY_MAX_INTERNAL_PAGES = 2;
const SOURCE_DISCOVERY_MAX_CANDIDATE_DOMAINS = 6;
const SOURCE_DISCOVERY_MAX_QUEUED_PAGES = 4;
const CRAWL_DISCOVERY_CONCURRENCY = 8;
const INTERNAL_PAGE_CRAWL_CONCURRENCY = 3;
const MAX_INTERNAL_PAGES = 4;
const MAX_DEEP_DIVE_INTERNAL_PAGES = 6;
const MAX_CRAWL_QUEUE_MULTIPLIER = 2;
const SERVICE_LED_MAX_SOURCE_PAGES = 8;
const SERVICE_LED_MAX_CANDIDATE_DOMAINS = 14;
const SERVICE_LED_MAX_QUEUED_PAGES = 8;
const SERVICE_LED_MAX_INTERNAL_PAGES = 6;
const SERVICE_LED_MAX_DEEP_DIVE_INTERNAL_PAGES = 10;
const SERVICE_LED_CRAWL_QUEUE_MULTIPLIER = 5;
const SERVICE_LED_MIN_CRAWL_QUEUE_BUDGET = 40;
const MIN_ACCEPT_SCORE = 7;
const HIGH_CONFIDENCE_SCORE = 12;
const DEEP_DIVE_MIN_SCORE = MIN_ACCEPT_SCORE - 2;
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
const ALLOWED_SOURCE_HOST_HINTS = [
  "europages",
  "wlw",
  "werliefertwas",
  "kompass",
  "emva",
  "messe",
  "exhibitor",
  "member",
  "partner"
];
const REQUIRED_VISION_QUERY_TERMS = [
  "machine vision",
  "visual inspection",
  "optical inspection",
  "industrial image processing",
  "automated optical inspection"
];
const REQUIRED_SERVICE_QUERY_TERMS = [
  "industrial software",
  "manufacturing software",
  "smart factory",
  "mes integration",
  "scada integration",
  "plc software",
  "ot integration"
];
const REQUIRED_DELIVERY_QUERY_TERMS = [
  "system integrator",
  "engineering services",
  "turnkey",
  "custom solution",
  "automation solution",
  "customer-specific automation"
];
const REQUIRED_INDUSTRIAL_QUERY_TERMS = [
  "industrial automation",
  "quality inspection",
  "manufacturing",
  "factory automation",
  "production line"
];
const SEARCH_QUERY_EXCLUDE_TERMS = [
  "-jobs",
  "-job",
  "-career",
  "-careers",
  "-recruiting",
  "-staffing",
  "-shop",
  "-store",
  "-distributor",
  "-reseller",
  "-manufacturer",
  "-academy",
  "-university",
  "-association",
  "-blog",
  "-news",
  "-surveillance",
  "-security",
  "-cctv",
  "-biometrics",
  "-barcode",
  "-microscope",
  "-traffic",
  "-marketing"
];
const STRONG_INTEGRATOR_SIGNAL_KEYWORDS = new Set([
  "system integrator",
  "systems integrator",
  "systemintegration",
  "softwareintegration",
  "systemhaus",
  "integration partner",
  "turnkey",
  "custom solution",
  "customer-specific",
  "engineering services",
  "automation solution",
  "automatisierungsloesung",
  "automatisierungslösung",
  "automatisierungstechnik",
  "steuerungstechnik",
  "prozessautomation",
  "prozessleittechnik",
  "leitsystem",
  "sondermaschinenbau",
  "commissioning",
  "inbetriebnahme",
  "project delivery",
  "implementation",
  "reference project",
  "case study"
]);

const MARKET_LANGUAGE_HINTS: Array<{ match: RegExp; siteTlds: string[]; keywords: string[] }> = [
  {
    match: /germany|deutschland|dach|austria|oesterreich|switzerland|schweiz/i,
    siteTlds: ["site:.de", "site:.at", "site:.ch"],
    keywords: [
      "bildverarbeitung",
      "industrielle bildverarbeitung",
      "optische inspektion",
      "prueftechnik",
      "automatisierungstechnik",
      "sondermaschinenbau",
      "systemintegration"
    ]
  },
  {
    match: /france|frankreich/i,
    siteTlds: ["site:.fr"],
    keywords: ["vision industrielle", "inspection optique", "controle qualite automatise", "integrateur vision"]
  },
  {
    match: /italy|italien/i,
    siteTlds: ["site:.it"],
    keywords: ["visione artificiale", "visione industriale", "ispezione ottica", "controllo qualita"]
  },
  {
    match: /spain|spanien/i,
    siteTlds: ["site:.es"],
    keywords: ["vision artificial", "vision industrial", "inspeccion optica", "control de calidad"]
  },
  {
    match: /netherlands|niederlande|holland|belgium|belgien|belgie/i,
    siteTlds: ["site:.nl", "site:.be"],
    keywords: [
      "machine vision",
      "beeldverwerking",
      "visuele inspectie",
      "vision industrielle",
      "inspection optique",
      "system integrator"
    ]
  }
];

const POSITIVE_SIGNALS: CrawlSignal[] = [
  { keyword: "machine vision", scoreDelta: 5, signalType: "positive" },
  { keyword: "computer vision", scoreDelta: 5, signalType: "positive" },
  { keyword: "visual inspection", scoreDelta: 5, signalType: "positive" },
  { keyword: "optical inspection", scoreDelta: 5, signalType: "positive" },
  { keyword: "automated optical inspection", scoreDelta: 5, signalType: "positive" },
  { keyword: "aoi", scoreDelta: 4, signalType: "positive" },
  { keyword: "industrial image processing", scoreDelta: 4, signalType: "positive" },
  { keyword: "quality inspection", scoreDelta: 4, signalType: "positive" },
  { keyword: "bildverarbeitung", scoreDelta: 5, signalType: "positive" },
  { keyword: "industrielle bildverarbeitung", scoreDelta: 5, signalType: "positive" },
  { keyword: "optische inspektion", scoreDelta: 5, signalType: "positive" },
  { keyword: "prueftechnik", scoreDelta: 4, signalType: "positive" },
  { keyword: "vision industrielle", scoreDelta: 5, signalType: "positive" },
  { keyword: "visione artificiale", scoreDelta: 5, signalType: "positive" },
  { keyword: "vision artificial", scoreDelta: 5, signalType: "positive" },
  { keyword: "beeldverwerking", scoreDelta: 4, signalType: "positive" },
  { keyword: "inspection system", scoreDelta: 4, signalType: "positive" },
  { keyword: "industrial software", scoreDelta: 4, signalType: "positive" },
  { keyword: "manufacturing software", scoreDelta: 4, signalType: "positive" },
  { keyword: "smart factory", scoreDelta: 4, signalType: "positive" },
  { keyword: "factory automation software", scoreDelta: 4, signalType: "positive" },
  { keyword: "manufacturing execution system", scoreDelta: 4, signalType: "positive" },
  { keyword: "mes integration", scoreDelta: 4, signalType: "positive" },
  { keyword: "mes", scoreDelta: 2, signalType: "positive" },
  { keyword: "scada", scoreDelta: 2, signalType: "positive" },
  { keyword: "ot integration", scoreDelta: 4, signalType: "positive" },
  { keyword: "operational technology", scoreDelta: 3, signalType: "positive" },
  { keyword: "plc software", scoreDelta: 3, signalType: "positive" },
  { keyword: "automation software", scoreDelta: 3, signalType: "positive" },
  { keyword: "produktionssoftware", scoreDelta: 4, signalType: "positive" },
  { keyword: "leittechnik", scoreDelta: 3, signalType: "positive" },
  { keyword: "industrie 4.0", scoreDelta: 3, signalType: "positive" },
  { keyword: "industrial iot", scoreDelta: 3, signalType: "positive" },
  { keyword: "iiot", scoreDelta: 2, signalType: "positive" },
  { keyword: "prozessleittechnik", scoreDelta: 4, signalType: "positive" },
  { keyword: "prozessautomation", scoreDelta: 4, signalType: "positive" },
  { keyword: "steuerungstechnik", scoreDelta: 3, signalType: "positive" },
  { keyword: "leitsystem", scoreDelta: 3, signalType: "positive" },
  { keyword: "visualisierung", scoreDelta: 2, signalType: "positive" },
  { keyword: "hmi", scoreDelta: 1, signalType: "positive" },
  { keyword: "digitalisierung", scoreDelta: 2, signalType: "positive" },
  { keyword: "betriebsdatenerfassung", scoreDelta: 3, signalType: "positive" },
  { keyword: "prozessdaten", scoreDelta: 2, signalType: "positive" },
  { keyword: "sps", scoreDelta: 2, signalType: "positive" },
  { keyword: "vision guided robotics", scoreDelta: 2, signalType: "positive" },
  { keyword: "robot vision", scoreDelta: 2, signalType: "positive" }
];

const INTEGRATOR_SIGNALS: CrawlSignal[] = [
  { keyword: "system integrator", scoreDelta: 3, signalType: "integrator" },
  { keyword: "systems integrator", scoreDelta: 3, signalType: "integrator" },
  { keyword: "systemintegration", scoreDelta: 3, signalType: "integrator" },
  { keyword: "integration partner", scoreDelta: 3, signalType: "integrator" },
  { keyword: "turnkey", scoreDelta: 3, signalType: "integrator" },
  { keyword: "custom solution", scoreDelta: 3, signalType: "integrator" },
  { keyword: "customer-specific", scoreDelta: 3, signalType: "integrator" },
  { keyword: "engineering services", scoreDelta: 3, signalType: "integrator" },
  { keyword: "automation solution", scoreDelta: 3, signalType: "integrator" },
  { keyword: "automatisierungstechnik", scoreDelta: 3, signalType: "integrator" },
  { keyword: "systemhaus", scoreDelta: 3, signalType: "integrator" },
  { keyword: "softwareintegration", scoreDelta: 3, signalType: "integrator" },
  { keyword: "sps systemintegrator", scoreDelta: 4, signalType: "integrator" },
  { keyword: "steuerungstechnik", scoreDelta: 2, signalType: "integrator" },
  { keyword: "prozessautomation", scoreDelta: 2, signalType: "integrator" },
  { keyword: "prozessleittechnik", scoreDelta: 3, signalType: "integrator" },
  { keyword: "leitsystem", scoreDelta: 2, signalType: "integrator" },
  { keyword: "industrie 4.0", scoreDelta: 1, signalType: "integrator" },
  { keyword: "digitalisierung", scoreDelta: 1, signalType: "integrator" },
  { keyword: "sondermaschinenbau", scoreDelta: 3, signalType: "integrator" },
  { keyword: "commissioning", scoreDelta: 3, signalType: "integrator" },
  { keyword: "inbetriebnahme", scoreDelta: 3, signalType: "integrator" },
  { keyword: "retrofit", scoreDelta: 2, signalType: "integrator" },
  { keyword: "case study", scoreDelta: 2, signalType: "integrator" },
  { keyword: "reference project", scoreDelta: 2, signalType: "integrator" },
  { keyword: "project delivery", scoreDelta: 3, signalType: "integrator" },
  { keyword: "integration", scoreDelta: 2, signalType: "integrator" },
  { keyword: "implementation", scoreDelta: 2, signalType: "integrator" },
  { keyword: "plc", scoreDelta: 1, signalType: "integrator" },
  { keyword: "mes", scoreDelta: 1, signalType: "integrator" },
  { keyword: "scada", scoreDelta: 1, signalType: "integrator" }
];

const NEGATIVE_SIGNALS: CrawlSignal[] = [
  { keyword: "job board", scoreDelta: -8, signalType: "negative" },
  { keyword: "recruiting", scoreDelta: -8, signalType: "negative" },
  { keyword: "staffing", scoreDelta: -8, signalType: "negative" },
  { keyword: "video surveillance", scoreDelta: -8, signalType: "negative" },
  { keyword: "security camera", scoreDelta: -8, signalType: "negative" },
  { keyword: "cctv", scoreDelta: -8, signalType: "negative" },
  { keyword: "e-commerce", scoreDelta: -6, signalType: "negative" },
  { keyword: "shop", scoreDelta: -4, signalType: "negative" },
  { keyword: "distributor", scoreDelta: -4, signalType: "negative" },
  { keyword: "reseller", scoreDelta: -4, signalType: "negative" },
  { keyword: "camera manufacturer", scoreDelta: -4, signalType: "negative" },
  { keyword: "camera module", scoreDelta: -4, signalType: "negative" },
  { keyword: "smart camera", scoreDelta: -4, signalType: "negative" },
  { keyword: "vision sensor", scoreDelta: -4, signalType: "negative" },
  { keyword: "frame grabber", scoreDelta: -4, signalType: "negative" },
  { keyword: "lighting", scoreDelta: -3, signalType: "negative" },
  { keyword: "machine vision components", scoreDelta: -4, signalType: "negative" },
  { keyword: "embedded vision platform", scoreDelta: -5, signalType: "negative" },
  { keyword: "publisher", scoreDelta: -8, signalType: "negative" },
  { keyword: "magazine", scoreDelta: -8, signalType: "negative" },
  { keyword: "association", scoreDelta: -6, signalType: "negative" },
  { keyword: "university", scoreDelta: -6, signalType: "negative" }
];

export class OpenCrawlerSearchClient {
  private crawledPages = 0;

  private readonly acceptedCompanyDomains = new Set<string>();
  private currentDiscoveryPageBudget = Number.POSITIVE_INFINITY;

  resetMetrics(): void {
    this.crawledPages = 0;
    this.acceptedCompanyDomains.clear();
    this.currentDiscoveryPageBudget = Number.POSITIVE_INFINITY;
  }

  getMetrics(): OpenCrawlerDiscoveryMetrics {
    return {
      crawledPages: this.crawledPages,
      acceptedCompanyDomains: this.acceptedCompanyDomains.size
    };
  }

  async discoverCompanies(
    filter: OrganizationFilter,
    limit: number,
    page = 1,
    shouldSkipDomain?: (domain: string) => boolean
  ): Promise<CompanySample[]> {
    const serviceLedFilter = this.isServiceLedFilter(filter);
    const seenDomains = new Set<string>();
    const companySamples: CompanySample[] = [];
    const crawlQueue: Array<{ domain: string; sourceLabel: string }> = [];
    const startingCrawlCount = this.crawledPages;
    this.currentDiscoveryPageBudget = startingCrawlCount + Math.max(
      serviceLedFilter ? 220 : 140,
      limit * (serviceLedFilter ? 6 : 4)
    );

    try {
      const crawlQueueBudget = Math.max(
        serviceLedFilter ? SERVICE_LED_MIN_CRAWL_QUEUE_BUDGET : 18,
        limit * (serviceLedFilter ? SERVICE_LED_CRAWL_QUEUE_MULTIPLIER : MAX_CRAWL_QUEUE_MULTIPLIER)
      );
      const querySeeds = this.selectQueryWindow(this.buildSeedQueries(filter, page), page, serviceLedFilter ? 6 : SEARCH_RESULT_MAX_QUERIES);
      const queryResults = await this.mapWithConcurrency(
        querySeeds.map((query) => async () => ({
          query,
          urls: await this.searchCandidateUrls(query, shouldSkipDomain, false, serviceLedFilter ? 12 : SEARCH_RESULT_MAX_RESULTS_PER_QUERY)
        })),
        SEARCH_RESULT_QUERY_CONCURRENCY
      );

      for (const queryResult of queryResults) {
        if (!this.canCrawlMorePages()) {
          break;
        }

        for (const candidateUrl of queryResult.urls) {
          if (crawlQueue.length >= crawlQueueBudget) {
            break;
          }

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
          crawlQueue.push({
            domain: normalizedDomain,
            sourceLabel: `search:${this.compactQueryLabel(queryResult.query)}`
          });
        }

        if (crawlQueue.length >= crawlQueueBudget) {
          break;
        }
      }

      const sourcePages = await this.discoverSourcePages(filter, page, shouldSkipDomain);
      const curatedSourcePages = this.buildCuratedSourcePages(filter);
      const combinedSourcePages = this.combineSourcePages(sourcePages, curatedSourcePages, filter);

      for (const sourcePage of combinedSourcePages) {
        if (!this.canCrawlMorePages()) {
          break;
        }

        if (crawlQueue.length >= crawlQueueBudget) {
          break;
        }

        const candidateDomains = await this.scrapeCandidateDomainsFromSourcePage(sourcePage.url, filter, shouldSkipDomain);
        for (const candidateDomain of candidateDomains) {
          if (crawlQueue.length >= crawlQueueBudget) {
            break;
          }

          if (seenDomains.has(candidateDomain)) {
            continue;
          }

          seenDomains.add(candidateDomain);
          crawlQueue.push({
            domain: candidateDomain,
            sourceLabel: `source:${this.compactQueryLabel(sourcePage.reason)}`
          });
        }
      }

      const crawledDomains = await this.mapWithConcurrency(
        crawlQueue.map(({ domain, sourceLabel }) => async () => {
          const crawl = await this.crawlDomain(domain, filter);
          if (!crawl || !this.meetsAcceptanceCriteria(crawl, filter)) {
            return null;
          }

          return {
            name: crawl.companyName,
            domain: this.toCanonicalCompanyDomain(crawl.domain),
            country: crawl.country,
            shortDescription: this.buildCompanySummary(crawl),
            sourceFilter: `${filter.name} (open-crawler: ${sourceLabel})`
          } satisfies CompanySample;
        }),
        CRAWL_DISCOVERY_CONCURRENCY
      );

      for (const company of crawledDomains) {
        if (!company) {
          continue;
        }

        if (company.domain) {
          this.acceptedCompanyDomains.add(company.domain);
        }

        companySamples.push(company);
        if (companySamples.length >= limit) {
          break;
        }
      }

      return companySamples.slice(0, limit);
    } finally {
      this.currentDiscoveryPageBudget = Number.POSITIVE_INFINITY;
    }
  }

  private canCrawlMorePages(): boolean {
    return this.crawledPages < this.currentDiscoveryPageBudget;
  }

  private recordCrawledPage(): void {
    this.crawledPages += 1;
  }

  private selectQueryWindow(queries: string[], page: number, maxQueries: number): string[] {
    if (queries.length <= maxQueries) {
      return queries;
    }

    const prioritizedCount = Math.min(2, maxQueries, queries.length);
    const selected = queries.slice(0, prioritizedCount);
    if (selected.length >= maxQueries) {
      return selected;
    }

    const stride = Math.max(1, Math.floor(queries.length / maxQueries));
    const startIndex = prioritizedCount + (((Math.max(page, 1) - 1) * stride) % Math.max(1, queries.length - prioritizedCount));

    for (let offset = 0; offset < queries.length && selected.length < maxQueries; offset += 1) {
      const query = queries[(startIndex + (offset * stride)) % queries.length];
      if (!selected.includes(query)) {
        selected.push(query);
      }
    }

    return selected;
  }

  private buildRequiredQueryPairs(
    location: string,
    filterKeywords: string[],
    marketKeywords: string[],
    siteScopes: string[],
    page: number,
    serviceLedFilter: boolean
  ): string[] {
    const positiveTerms = Array.from(new Set([
      ...(serviceLedFilter ? REQUIRED_SERVICE_QUERY_TERMS : REQUIRED_VISION_QUERY_TERMS),
      ...filterKeywords,
      ...marketKeywords
    ])).slice(0, 8);
    const deliveryTerms = serviceLedFilter
      ? ["implementation", "engineering services", "reference project", "case study", "commissioning", "system integrator"]
      : REQUIRED_DELIVERY_QUERY_TERMS;
    const industrialTerms = REQUIRED_INDUSTRIAL_QUERY_TERMS;
    const queries: string[] = [];

    positiveTerms.slice(0, 4).forEach((positiveTerm, index) => {
      const deliveryTerm = deliveryTerms[(page + index) % deliveryTerms.length];
      const industrialTerm = industrialTerms[(page + index) % industrialTerms.length];
      siteScopes.forEach((siteScope) => {
        queries.push(this.finalizeSearchQuery([siteScope, `"${positiveTerm}"`, `"${deliveryTerm}"`, `"${industrialTerm}"`, location]));
      });

      queries.push(this.finalizeSearchQuery([`"${positiveTerm}"`, `"${deliveryTerm}"`, `"${industrialTerm}"`, location]));
    });

    return Array.from(new Set(queries));
  }

  private getSearchLocations(filter: OrganizationFilter, page: number, maxLocations = 3): string[] {
    const locations = Array.from(new Set(filter.locations.map((location) => location.trim()).filter(Boolean)));
    if (locations.length === 0) {
      return ["Germany"];
    }

    if (locations.length <= maxLocations) {
      return locations;
    }

    const startIndex = ((Math.max(page, 1) - 1) * maxLocations) % locations.length;
    const selected: string[] = [];

    for (let offset = 0; offset < locations.length && selected.length < maxLocations; offset += 1) {
      const location = locations[(startIndex + offset) % locations.length];
      if (!selected.includes(location)) {
        selected.push(location);
      }
    }

    return selected;
  }

  async buildResearchContext(company: PreCategorizedCompany): Promise<SearchEvidence | null> {
    const crawl = await this.crawlDomain(company.domain);
    if (!crawl) {
      return null;
    }

    return {
      context: [
        "Open crawler evidence:",
        `Company: ${crawl.companyName}`,
        `Website: ${crawl.landingUrl}`,
        `Fit score: ${crawl.totalScore} (${crawl.confidence})`,
        `Signals: ${crawl.signals.map((signal) => `${signal.signalType}:${signal.keyword}`).slice(0, 10).join(" | ")}`,
        `Summary: ${crawl.summary}`
      ].join("\n\n"),
      citations: [crawl.landingUrl, ...crawl.relevantUrls]
    };
  }

  async summarizeCompany(company: CompanySample): Promise<Partial<CompanySample> | null> {
    const crawl = await this.crawlDomain(company.domain);
    if (!crawl) {
      return null;
    }

    return {
      country: crawl.country ?? company.country,
      shortDescription: this.buildCompanySummary(crawl)
    };
  }

  async crawlCompanyWebsite(domain: string | undefined): Promise<CrawledWebsiteProfile | null> {
    const crawl = await this.crawlDomainWithRetry(domain);
    if (!crawl) {
      return null;
    }

    return {
      summary: crawl.summary,
      landingUrl: crawl.landingUrl,
      relevantUrls: crawl.relevantUrls
    };
  }

  private async crawlDomainWithRetry(domain: string | undefined, filter?: OrganizationFilter): Promise<DomainCrawlResult | null> {
    for (let attempt = 0; attempt < WEBSITE_CRAWL_RETRY_ATTEMPTS; attempt += 1) {
      const crawl = await this.crawlDomain(domain, filter);
      if (crawl) {
        return crawl;
      }

      if (attempt < WEBSITE_CRAWL_RETRY_ATTEMPTS - 1) {
        await this.delay(WEBSITE_CRAWL_RETRY_DELAY_MS * (attempt + 1));
      }
    }

    return null;
  }

  private buildSeedQueries(filter: OrganizationFilter, page: number): string[] {
    const serviceLedFilter = this.isServiceLedFilter(filter);
    const integrationPhrases = [
      "system integrator",
      "systemintegration",
      "turnkey solution",
      "automation solution",
      "engineering services",
      "sondermaschinenbau",
      "automatisierung"
    ];
    const queries: string[] = [];

    for (const [locationIndex, location] of this.getSearchLocations(filter, page, 3).entries()) {
      const marketHints = this.resolveMarketHints(location, serviceLedFilter);
      const filterKeywords = filter.keywords.slice(0, 5).map((keyword) => keyword.trim()).filter(Boolean);
      const localKeywords = marketHints.keywords.slice(0, 4);
      const baseKeywords = Array.from(new Set([...filterKeywords, ...localKeywords])).slice(0, 6);
      const siteScopes = marketHints.siteTlds.length > 0 ? marketHints.siteTlds : [""];

      queries.push(...this.buildRequiredQueryPairs(location, filterKeywords, localKeywords, siteScopes, page, serviceLedFilter));

      queries.push(
        ...(serviceLedFilter
          ? [
              ["industrial software integrator", location],
              ["manufacturing software implementation", location],
              ["mes system integrator", location],
              ["scada system integrator", location],
              ["plc software integration", location],
              ["ot integration services", location],
              ["smart factory software", location],
              ["produktionssoftware dienstleister", location]
            ]
          : [
              ["machine vision integrator", location],
              ["visual inspection system integrator", location],
              ["industrial image processing", location],
              ["optical inspection automation", location],
              ["vision guided robotics integrator", location],
              ["industrielle bildverarbeitung", "systemintegration", location],
              ["optische inspektion", "automatisierung", location],
              ["bildverarbeitung", "sondermaschinenbau", location]
            ]).map((parts) => this.finalizeSearchQuery(parts))
      );

      baseKeywords.forEach((keyword, keywordIndex) => {
        const suffix = integrationPhrases[(page + locationIndex + keywordIndex) % integrationPhrases.length];
        siteScopes.forEach((siteScope) => {
          queries.push(this.finalizeSearchQuery([siteScope, `"${keyword}"`, `"${suffix}"`]));
        });

        queries.push(this.finalizeSearchQuery([`"${keyword}"`, `"${suffix}"`, location]));
      });
    }

    return Array.from(new Set(queries));
  }

  private buildSourcePageQueries(filter: OrganizationFilter, page: number): string[] {
    const serviceLedFilter = this.isServiceLedFilter(filter);
    const queries: string[] = [];

    for (const location of this.getSearchLocations(filter, page, 3)) {
      const marketHints = this.resolveMarketHints(location, serviceLedFilter);
      const baseKeywords = Array.from(new Set([...filter.keywords.slice(0, 4), ...marketHints.keywords.slice(0, 4)]));
      const rotatingKeyword = baseKeywords[(Math.max(page, 1) - 1) % Math.max(1, baseKeywords.length)] ?? (serviceLedFilter ? "industrial software" : "machine vision");
      const siteScopes = marketHints.siteTlds.length > 0 ? marketHints.siteTlds : [""];

      queries.push(...this.buildRequiredQueryPairs(location, filter.keywords.slice(0, 4), marketHints.keywords.slice(0, 4), siteScopes, page, serviceLedFilter));

      queries.push(
        ...(serviceLedFilter
          ? [
              `industrial software integrator directory ${location}`,
              `manufacturing software integrator directory ${location}`,
              `mes system integrator directory ${location}`,
              `scada system integrator directory ${location}`,
              `industrial automation software dienstleister ${location}`,
              `sps systemintegrator ${location}`,
              `industrial automation exhibitor system integrator ${location}`,
              `"${rotatingKeyword}" system integrator manufacturing ${location}`,
              `"${rotatingKeyword}" engineering services industrie ${location}`,
              `"${rotatingKeyword}" referenzen automatisierung ${location}`
            ]
          : [
              `VISION exhibitor index ${location}`,
              `vision exhibitor list machine vision ${location}`,
              `EMVA members machine vision`,
              `Basler partner machine vision`,
              `MVTec partner machine vision`,
              `Stemmer Imaging partner machine vision`,
              `industrial automation exhibitor list ${location}`,
              `machine vision partner network ${location}`,
              `"${rotatingKeyword}" partner ${location}`,
              `"${rotatingKeyword}" exhibitor ${location}`
            ]).map((query) => this.finalizeSearchQuery([query]))
      );
    }

    return Array.from(new Set(queries));
  }

  private finalizeSearchQuery(parts: string[]): string {
    return [...parts.filter(Boolean), ...SEARCH_QUERY_EXCLUDE_TERMS].join(" ").trim();
  }

  private resolveMarketHints(location: string, serviceLedFilter = false) {
    const matchedHints = MARKET_LANGUAGE_HINTS.find((entry) => entry.match.test(location));
    if (!serviceLedFilter) {
      return matchedHints ?? {
        siteTlds: [],
        keywords: ["machine vision", "visual inspection", "industrial automation", "system integrator"]
      };
    }

    const serviceKeywords = /germany|deutschland|dach|austria|oesterreich|switzerland|schweiz/i.test(location)
      ? ["automatisierung software", "produktionssoftware", "mes system integrator", "scada system integrator", "systemintegration", "automatisierungstechnik"]
      : /france|frankreich/i.test(location)
        ? ["logiciel industriel", "integrateur mes", "integrateur scada", "automatisation industrielle", "mise en service"]
        : /italy|italien/i.test(location)
          ? ["software industriale", "integratore mes", "integratore scada", "automazione industriale", "messa in servizio"]
          : /spain|spanien/i.test(location)
            ? ["software industrial", "integrador mes", "integrador scada", "automatizacion industrial", "puesta en marcha"]
            : /netherlands|niederlande|holland|belgium|belgien|belgie/i.test(location)
              ? ["industriele software", "mes integrator", "scada integrator", "automation software", "system integrator"]
              : ["industrial software", "manufacturing software", "mes integration", "scada integration", "industrial automation"];

    return {
      siteTlds: matchedHints?.siteTlds ?? [],
      keywords: serviceKeywords
    };
  }

  private async searchCandidateUrls(
    query: string,
    shouldSkipDomain?: (domain: string) => boolean,
    allowSourceDomains = false,
    maxResults = SEARCH_RESULT_MAX_RESULTS_PER_QUERY
  ): Promise<string[]> {
    const [duckDuckGoUrls, bingUrls] = await Promise.all([
      this.searchDuckDuckGo(query, shouldSkipDomain, allowSourceDomains, maxResults),
      this.searchBing(query, shouldSkipDomain, allowSourceDomains, maxResults)
    ]);

    return Array.from(new Set([...duckDuckGoUrls, ...bingUrls])).slice(0, maxResults);
  }

  private async searchDuckDuckGo(
    query: string,
    shouldSkipDomain?: (domain: string) => boolean,
    allowSourceDomains = false,
    maxResults = SEARCH_RESULT_MAX_RESULTS_PER_QUERY
  ): Promise<string[]> {
    if (!this.canCrawlMorePages()) {
      return [];
    }
    try {
      const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        signal: AbortSignal.timeout(SEARCH_RESULT_DDG_TIMEOUT_MS),
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ONE-WARE-Lead-Agent/1.0; +https://one-ware.com)"
        }
      });

      if (!response.ok) {
        return [];
      }

      const html = await this.readResponseTextWithTimeout(response, SEARCH_RESULT_DDG_TIMEOUT_MS);
      this.recordCrawledPage();
      const matches = Array.from(html.matchAll(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>/gi));
      return this.extractSearchResultUrls(matches.map((match) => match[1] ?? ""), shouldSkipDomain, allowSourceDomains, maxResults);
    } catch {
      return [];
    }
  }

  private async searchBing(
    query: string,
    shouldSkipDomain?: (domain: string) => boolean,
    allowSourceDomains = false,
    maxResults = SEARCH_RESULT_MAX_RESULTS_PER_QUERY
  ): Promise<string[]> {
    if (!this.canCrawlMorePages()) {
      return [];
    }
    try {
      const response = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
        signal: AbortSignal.timeout(SEARCH_RESULT_BING_TIMEOUT_MS),
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ONE-WARE-Lead-Agent/1.0; +https://one-ware.com)"
        }
      });

      if (!response.ok) {
        return [];
      }

      const html = await this.readResponseTextWithTimeout(response, SEARCH_RESULT_BING_TIMEOUT_MS);
      this.recordCrawledPage();
      const matches = Array.from(html.matchAll(/<h2[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["']/gi));
      return this.extractSearchResultUrls(matches.map((match) => match[1] ?? ""), shouldSkipDomain, allowSourceDomains, maxResults);
    } catch {
      return [];
    }
  }

  private extractSearchResultUrls(
    rawUrls: string[],
    shouldSkipDomain?: (domain: string) => boolean,
    allowSourceDomains = false,
    maxResults = SEARCH_RESULT_MAX_RESULTS_PER_QUERY
  ): string[] {
    const urls: string[] = [];

    for (const rawUrl of rawUrls) {
      if (urls.length >= maxResults) {
        break;
      }

      const resolvedHref = this.resolveSearchResultHref(rawUrl.trim());
      const normalizedHref = allowSourceDomains ? this.normalizeSourceUrl(resolvedHref) : this.normalizeUrl(resolvedHref);
      const normalizedDomain = this.normalizeUrl(resolvedHref);
      if (
        !normalizedHref ||
        !normalizedDomain ||
        (this.shouldIgnoreDomain(normalizedDomain) && !this.isAllowedSourceDomain(normalizedHref, allowSourceDomains)) ||
        shouldSkipDomain?.(normalizedDomain) ||
        urls.includes(normalizedHref)
      ) {
        continue;
      }

      urls.push(normalizedHref);
    }

    return urls;
  }

  private async discoverSourcePages(
    filter: OrganizationFilter,
    page: number,
    shouldSkipDomain?: (domain: string) => boolean
  ): Promise<SourcePageCandidate[]> {
    const serviceLedFilter = this.isServiceLedFilter(filter);
    const maxSourcePages = serviceLedFilter ? SERVICE_LED_MAX_SOURCE_PAGES : SOURCE_DISCOVERY_MAX_SOURCE_PAGES;
    const queries = this.selectQueryWindow(this.buildSourcePageQueries(filter, page), page, serviceLedFilter ? 6 : 5);
    const pages: SourcePageCandidate[] = [];
    const seenUrls = new Set<string>();

    const discoveredQueryResults = await this.mapWithConcurrency(
      queries.map((query) => async () => ({
        query,
        urls: await this.searchCandidateUrls(query, shouldSkipDomain, true, serviceLedFilter ? 12 : SEARCH_RESULT_MAX_RESULTS_PER_QUERY)
      })),
      SEARCH_RESULT_QUERY_CONCURRENCY
    );

    for (const { query, urls } of discoveredQueryResults) {
      for (const url of urls) {
        const normalizedUrl = this.normalizeSourceUrl(url);
        if (
          !normalizedUrl ||
          seenUrls.has(normalizedUrl) ||
          (this.shouldIgnoreDomain(normalizedUrl) && !this.isAllowedSourceDomain(normalizedUrl, true))
        ) {
          continue;
        }

        seenUrls.add(normalizedUrl);
        pages.push({ url: normalizedUrl, reason: query });
      }
    }

    return pages.slice(0, maxSourcePages);
  }

  private buildCuratedSourcePages(filter: OrganizationFilter): SourcePageCandidate[] {
    const location = (filter.locations[0] ?? "Germany").toLowerCase();
    const pages: SourcePageCandidate[] = [];
    const serviceLedFilter = this.isServiceLedFilter(filter);
    const dachLikeLocation = /germany|deutschland|dach|austria|oesterreich|switzerland|schweiz/.test(location);

    if (!serviceLedFilter || !dachLikeLocation) {
      pages.push(
        {
          url: "https://www.emva.org/standards-technology/members/",
          reason: "curated:emva-members"
        },
        {
          url: "https://www.visiononline.org/suppliers",
          reason: "curated:visiononline-suppliers"
        }
      );
    }

    if (dachLikeLocation && serviceLedFilter) {
      pages.push(
        {
          url: "https://www.wlw.de/de/suche/automatisierungstechnik",
          reason: "curated:wlw-automatisierungstechnik"
        },
        {
          url: "https://www.europages.de/unternehmen/automatisierungstechnik.html",
          reason: "curated:europages-automatisierungstechnik"
        }
      );
    }

    if (dachLikeLocation && !serviceLedFilter) {
      pages.push(
        {
          url: "https://www.wlw.de/de/suche/bildverarbeitung",
          reason: "curated:wlw-bildverarbeitung"
        },
        {
          url: "https://www.europages.de/unternehmen/bildverarbeitung.html",
          reason: "curated:europages-bildverarbeitung"
        },
        {
          url: "https://www.messe-stuttgart.de/vision/en/exhibition/exhibitors-products/exhibitor-index/",
          reason: "curated:vision-exhibitor-index"
        }
      );
    }

    return pages;
  }

  private isServiceLedFilter(filter: OrganizationFilter): boolean {
    const text = [filter.name, filter.persona, filter.notes, ...filter.keywords].join(" ").toLowerCase();
    const visionFocusedFilter = /(machine vision|computer vision|visual inspection|optical inspection|industrial image processing|bildverarbeitung|aoi|embedded vision|inspection ai)/i.test(text);
    const serviceSoftwareFilter = /(industrial software|manufacturing software|smart factory|mes|scada|plc|ot integration|automation software|software engineering|produktionssoftware)/i.test(text);

    if (visionFocusedFilter && !serviceSoftwareFilter) {
      return false;
    }

    return /(integrator|system integration|systemintegrator|engineering services|solution provider|turnkey|customer-specific|commissioning|sondermaschinenbau|automation partner)/i.test(text);
  }

  private combineSourcePages(
    discoveredSourcePages: SourcePageCandidate[],
    curatedSourcePages: SourcePageCandidate[],
    filter: OrganizationFilter
  ): SourcePageCandidate[] {
    const combined: SourcePageCandidate[] = [];
    const seenUrls = new Set<string>();
    const maxSourcePages = this.isServiceLedFilter(filter) ? 6 : SOURCE_DISCOVERY_MAX_SOURCE_PAGES;
    const discoveredBudget = Math.max(2, maxSourcePages - 1);

    for (const sourcePage of discoveredSourcePages) {
      if (combined.length >= discoveredBudget) {
        break;
      }

      if (seenUrls.has(sourcePage.url)) {
        continue;
      }

      seenUrls.add(sourcePage.url);
      combined.push(sourcePage);
    }

    for (const sourcePage of curatedSourcePages) {
      if (combined.length >= maxSourcePages) {
        break;
      }

      if (seenUrls.has(sourcePage.url)) {
        continue;
      }

      seenUrls.add(sourcePage.url);
      combined.push(sourcePage);
    }

    return combined;
  }

  private async scrapeCandidateDomainsFromSourcePage(
    sourceUrl: string,
    filter: OrganizationFilter,
    shouldSkipDomain?: (domain: string) => boolean
  ): Promise<string[]> {
    const serviceLedFilter = this.isServiceLedFilter(filter);
    const maxCandidateDomains = serviceLedFilter ? SERVICE_LED_MAX_CANDIDATE_DOMAINS : SOURCE_DISCOVERY_MAX_CANDIDATE_DOMAINS;
    const maxQueuedPages = serviceLedFilter ? SERVICE_LED_MAX_QUEUED_PAGES : SOURCE_DISCOVERY_MAX_QUEUED_PAGES;
    const serviceDirectoryHint = /(dienstleister|software|automatisierung|systemintegrator|system integrator|mes|scada|plc|industrie|industrial|ot|referenzen|branchen|loesungen|solutions|leistungen)/i;
    const serviceDirectoryPathHint = /\/(firma|company|supplier|profil|profile|member|members|anbieter|dienstleister|unternehmen|software|automatisierung|systemintegrator|referenzen|branchen)\b/i;
    const visitedPages = new Set<string>();
    const queuedPages = [sourceUrl];
    const discoveredDomains = new Set<string>();
    const sourceHostname = new URL(sourceUrl).hostname.replace(/^www\./i, "");
    const isDirectoryStyleSource = this.isAllowedSourceDomain(sourceUrl, true);

    while (
      queuedPages.length > 0 &&
      visitedPages.size < SOURCE_DISCOVERY_MAX_INTERNAL_PAGES &&
      discoveredDomains.size < maxCandidateDomains
    ) {
      if (!this.canCrawlMorePages()) {
        break;
      }

      const nextPage = queuedPages.shift() as string;
      if (visitedPages.has(nextPage)) {
        continue;
      }

      visitedPages.add(nextPage);

      try {
        const response = await fetch(nextPage, {
          redirect: "follow",
          signal: AbortSignal.timeout(SOURCE_PAGE_FETCH_TIMEOUT_MS),
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; ONE-WARE-Lead-Agent/1.0; +https://one-ware.com)"
          }
        });

        if (!response.ok) {
          continue;
        }

        const html = await this.readResponseTextWithTimeout(response, SOURCE_PAGE_FETCH_TIMEOUT_MS);
        this.recordCrawledPage();
        const anchors = this.extractAnchors(html, response.url || nextPage);
        const embeddedUrls = this.extractEmbeddedUrls(html);

        for (const anchor of anchors) {
          const normalizedHref = this.normalizeUrl(anchor.href);
          if (!normalizedHref) {
            continue;
          }

          const hostname = new URL(normalizedHref).hostname.replace(/^www\./i, "");
          if (hostname === sourceHostname) {
            const pathname = new URL(anchor.href).pathname;
            const navigationHint = `${anchor.href} ${anchor.text}`;
            if (
              queuedPages.length < maxQueuedPages &&
              (
                /(aussteller|exhibitor|member|mitglied|partner|company|unternehmen|supplier|vendor|integrator)/i.test(navigationHint) ||
                (isDirectoryStyleSource && serviceLedFilter && (serviceDirectoryHint.test(navigationHint) || serviceDirectoryPathHint.test(pathname))) ||
                (isDirectoryStyleSource && /\/(firma|company|supplier|profil|profile|member|members)\b/i.test(pathname))
              )
            ) {
              queuedPages.push(normalizedHref);
            }

            continue;
          }

          if (this.shouldIgnoreDomain(normalizedHref) || shouldSkipDomain?.(normalizedHref)) {
            continue;
          }

          discoveredDomains.add(normalizedHref);
          if (discoveredDomains.size >= maxCandidateDomains) {
            break;
          }
        }

        for (const embeddedUrl of embeddedUrls) {
          const normalizedEmbeddedDomain = this.normalizeUrl(embeddedUrl);
          if (
            !normalizedEmbeddedDomain ||
            normalizedEmbeddedDomain.includes(sourceHostname) ||
            this.shouldIgnoreDomain(normalizedEmbeddedDomain) ||
            shouldSkipDomain?.(normalizedEmbeddedDomain)
          ) {
            continue;
          }

          discoveredDomains.add(normalizedEmbeddedDomain);
          if (discoveredDomains.size >= maxCandidateDomains) {
            break;
          }
        }
      } catch {
        continue;
      }
    }

    return Array.from(discoveredDomains);
  }

  private async crawlDomain(domain: string | undefined, filter?: OrganizationFilter): Promise<DomainCrawlResult | null> {
    const normalizedDomain = this.normalizeUrl(domain);
    if (!normalizedDomain) {
      return null;
    }

    const serviceLedFilter = filter ? this.isServiceLedFilter(filter) : false;
    const maxInternalPages = serviceLedFilter ? SERVICE_LED_MAX_INTERNAL_PAGES : MAX_INTERNAL_PAGES;
    const maxDeepDiveInternalPages = serviceLedFilter ? SERVICE_LED_MAX_DEEP_DIVE_INTERNAL_PAGES : MAX_DEEP_DIVE_INTERNAL_PAGES;

    const candidateUrls = this.buildCandidateUrls(normalizedDomain);
    for (const url of candidateUrls) {
      if (!this.canCrawlMorePages()) {
        break;
      }

      try {
        const response = await fetch(url, {
          redirect: "follow",
          signal: AbortSignal.timeout(WEBSITE_CRAWL_TIMEOUT_MS),
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; ONE-WARE-Lead-Agent/1.0; +https://one-ware.com)"
          }
        });

        if (!response.ok) {
          continue;
        }

        const landingUrl = response.url || url;
        const html = await this.readResponseTextWithTimeout(response, WEBSITE_CRAWL_TIMEOUT_MS);
        this.recordCrawledPage();
        const homePage = this.extractPageCrawlResult(html, landingUrl, "home");
        if (!homePage) {
          continue;
        }

        const pageResults: PageCrawlResult[] = [homePage];
        const fetchedInternalUrls = new Set<string>();
        const initialLinks = this.selectRelevantInternalLinks(html, landingUrl, maxInternalPages - 1);
        const internalResults = await this.fetchInternalPageResults(initialLinks, fetchedInternalUrls);

        for (const result of internalResults) {
          if (result) {
            pageResults.push(result);
          }
        }

        let signals = this.deduplicateSignals(pageResults.flatMap((result) => result.signals));
        let totalScore = signals.reduce((sum, signal) => sum + signal.scoreDelta, 0);

        if (this.shouldDeepDive(pageResults, signals, totalScore, serviceLedFilter, maxDeepDiveInternalPages)) {
          const deepDiveLinks = this.selectDeepDiveInternalLinks(
            html,
            landingUrl,
            fetchedInternalUrls,
            serviceLedFilter,
            maxInternalPages,
            maxDeepDiveInternalPages
          );
          const deepDiveResults = await this.fetchInternalPageResults(deepDiveLinks, fetchedInternalUrls);

          for (const result of deepDiveResults) {
            if (result) {
              pageResults.push(result);
            }
          }

          signals = this.deduplicateSignals(pageResults.flatMap((result) => result.signals));
          totalScore = signals.reduce((sum, signal) => sum + signal.scoreDelta, 0);
        }

        const summary = pageResults.map((result) => result.summary).join(" || ").slice(0, 1800);

        return {
          domain: normalizedDomain,
          companyName: this.extractCompanyName(html, landingUrl, summary),
          country: this.inferCountryFromDomain(normalizedDomain, summary),
          landingUrl,
          relevantUrls: pageResults.slice(1).map((result) => result.url),
          summary,
          totalScore,
          confidence: totalScore >= HIGH_CONFIDENCE_SCORE ? "high" : totalScore >= MIN_ACCEPT_SCORE ? "review" : "low",
          signals
        };
      } catch {
        continue;
      }
    }

    return null;
  }

  private delay(durationMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
  }

  private async readResponseTextWithTimeout(response: Response, timeoutMs: number): Promise<string> {
    return await Promise.race([
      response.text(),
      new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error(`Open crawler response body timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  }

  private extractPageCrawlResult(html: string, url: string, label: string): PageCrawlResult | null {
    const summary = this.extractPageSummary(html, url, label);
    if (!summary) {
      return null;
    }

    const text = this.extractVisibleText(html).slice(0, 12000);
    const signals = this.scoreText(`${summary} || ${text}`);

    return {
      url,
      summary,
      signals
    };
  }

  private buildCompanySummary(crawl: DomainCrawlResult): string {
    const signalList = crawl.signals.map((signal) => signal.keyword).slice(0, 8).join(", ");
    const confidenceLabel = crawl.confidence === "high" ? "high-fit" : crawl.confidence === "review" ? "review-fit" : "low-fit";

    return [
      `Open-crawler ${confidenceLabel} score ${crawl.totalScore}.`,
      signalList ? `Matched signals: ${signalList}.` : undefined,
      crawl.summary
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, 1400);
  }

  private scoreText(text: string): CrawlSignal[] {
    const lowered = text.toLowerCase();
    const collected: CrawlSignal[] = [];

    for (const signal of [...POSITIVE_SIGNALS, ...INTEGRATOR_SIGNALS, ...NEGATIVE_SIGNALS]) {
      if (lowered.includes(signal.keyword.toLowerCase())) {
        collected.push(signal);
      }
    }

    return this.deduplicateSignals(collected);
  }

  private deduplicateSignals(signals: CrawlSignal[]): CrawlSignal[] {
    const seen = new Set<string>();
    return signals.filter((signal) => {
      const key = `${signal.signalType}:${signal.keyword.toLowerCase()}`;
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
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

  private async fetchInternalPageResults(
    links: Array<{ url: string; label: string }>,
    fetchedInternalUrls: Set<string>
  ): Promise<Array<PageCrawlResult | null>> {
    return this.mapWithConcurrency(
      links.map((link) => async () => {
        if (!this.canCrawlMorePages()) {
          return null;
        }

        if (fetchedInternalUrls.has(link.url)) {
          return null;
        }

        fetchedInternalUrls.add(link.url);

        try {
          const pageResponse = await fetch(link.url, {
            redirect: "follow",
            signal: AbortSignal.timeout(INTERNAL_PAGE_CRAWL_TIMEOUT_MS),
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; ONE-WARE-Lead-Agent/1.0; +https://one-ware.com)"
            }
          });

          if (!pageResponse.ok) {
            return null;
          }

          const pageHtml = await this.readResponseTextWithTimeout(pageResponse, INTERNAL_PAGE_CRAWL_TIMEOUT_MS);
          this.recordCrawledPage();
          return this.extractPageCrawlResult(pageHtml, pageResponse.url || link.url, link.label);
        } catch {
          return null;
        }
      }),
      INTERNAL_PAGE_CRAWL_CONCURRENCY
    );
  }

  private selectRelevantInternalLinks(
    html: string,
    baseUrl: string,
    maxInternalPages: number
  ): Array<{ url: string; label: string }> {
    const baseHostname = new URL(baseUrl).hostname.replace(/^www\./i, "");
    const positivePattern = /(about|ueber|uber|unternehmen|company|services|service|leistungen|solutions|solution|loesungen|products|product|produkte|kompetenzen|portfolio|applications|anwendungen|industries|branchen|use cases|referenzen|references|case stud(y|ies)|projekt(e)?|projects|inspection|vision|automation|commissioning|inbetriebnahme)/i;
    const negativePattern = /(news|blog|jobs|karriere|career|kontakt|contact|datenschutz|privacy|legal|terms|shop|cart|login)/i;
    const selected: Array<{ url: string; label: string; score: number }> = [];
    const seenUrls = new Set<string>();

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
      .slice(0, maxInternalPages)
      .map(({ url, label }) => ({ url, label }));
  }

  private selectDeepDiveInternalLinks(
    html: string,
    baseUrl: string,
    fetchedInternalUrls: Set<string>,
    serviceLedFilter: boolean,
    maxInternalPages: number,
    maxDeepDiveInternalPages: number
  ): Array<{ url: string; label: string }> {
    const deepDiveCandidates = this.selectRelevantInternalLinks(
      html,
      baseUrl,
      (serviceLedFilter ? maxDeepDiveInternalPages : MAX_DEEP_DIVE_INTERNAL_PAGES) - 1
    );
    return deepDiveCandidates
      .filter((candidate) => !fetchedInternalUrls.has(candidate.url))
      .slice(0, maxDeepDiveInternalPages - maxInternalPages);
  }

  private shouldDeepDive(
    pageResults: PageCrawlResult[],
    signals: CrawlSignal[],
    totalScore: number,
    serviceLedFilter: boolean,
    maxDeepDiveInternalPages: number
  ): boolean {
    if (pageResults.length >= maxDeepDiveInternalPages) {
      return false;
    }

    const positiveCount = signals.filter((signal) => signal.signalType === "positive").length;
    const integratorCount = signals.filter((signal) => signal.signalType === "integrator").length;

    if (serviceLedFilter) {
      return totalScore >= DEEP_DIVE_MIN_SCORE - 1 && (integratorCount <= 1 || positiveCount >= 1);
    }

    return totalScore >= DEEP_DIVE_MIN_SCORE && (integratorCount === 0 || (positiveCount >= 2 && totalScore < HIGH_CONFIDENCE_SCORE));
  }

  private meetsAcceptanceCriteria(crawl: DomainCrawlResult, filter?: OrganizationFilter): boolean {
    if (crawl.totalScore < MIN_ACCEPT_SCORE) {
      return false;
    }

    const serviceLedFilter = filter ? this.isServiceLedFilter(filter) : false;

    const positiveCount = crawl.signals.filter((signal) => signal.signalType === "positive").length;
    const integratorCount = crawl.signals.filter((signal) => signal.signalType === "integrator").length;
    const negativeCount = crawl.signals.filter((signal) => signal.signalType === "negative").length;
    const strongIntegratorCount = crawl.signals.filter(
      (signal) => signal.signalType === "integrator" && STRONG_INTEGRATOR_SIGNAL_KEYWORDS.has(signal.keyword.toLowerCase())
    ).length;

    if (positiveCount === 0) {
      return false;
    }

    if (negativeCount > 0) {
      return false;
    }

    if (integratorCount === 0) {
      return false;
    }

    if (serviceLedFilter) {
      if (strongIntegratorCount > 0 && positiveCount >= 1) {
        return true;
      }

      if (integratorCount >= 1 && positiveCount >= 1 && crawl.totalScore >= MIN_ACCEPT_SCORE + 1) {
        return true;
      }
    }

    if (strongIntegratorCount > 0 && positiveCount >= 1 && crawl.totalScore >= HIGH_CONFIDENCE_SCORE - 1) {
      return true;
    }

    if (integratorCount >= 2 && positiveCount >= 2 && crawl.totalScore >= HIGH_CONFIDENCE_SCORE) {
      return true;
    }

    return integratorCount >= 1 && positiveCount >= 2 && crawl.totalScore >= HIGH_CONFIDENCE_SCORE;
  }

  private scoreRelevantLink(value: string): number {
    const lowered = value.toLowerCase();
    let score = 0;

    if (/(about|ueber|uber|unternehmen|company)/.test(lowered)) {
      score += 3;
    }

    if (/(services|service|leistungen|solutions|loesungen|kompetenzen|engineering)/.test(lowered)) {
      score += 4;
    }

    if (/(references|referenzen|case stud(y|ies)|projects|projekt(e)?|applications|anwendungen|industries|branchen|inspection|vision|automation|commissioning|inbetriebnahme)/.test(lowered)) {
      score += 3;
    }

    if (/(products|product|produkte)/.test(lowered)) {
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
    return pathSegment && pathSegment.length >= 3 ? pathSegment : "page";
  }

  private extractCompanyName(html: string, url: string, summary: string): string {
    const ogSiteName = this.extractMetaPropertyContent(html, "og:site_name");
    if (ogSiteName) {
      return ogSiteName.trim();
    }

    const title = this.extractTagContent(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
    if (title) {
      const normalizedTitle = title.split("|")[0]?.split("-")[0]?.trim();
      if (normalizedTitle && normalizedTitle.length >= 3 && normalizedTitle.length <= 80) {
        return normalizedTitle;
      }
    }

    const firstHeading = this.extractTagContent(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (firstHeading && firstHeading.length <= 80) {
      return firstHeading;
    }

    return this.deriveCompanyName(url, summary);
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
    if (/(home|startseite|welcome|solutions|services|products|news|blog)\s*[-|:]/i.test(candidate)) {
      return false;
    }

    if (looksLikeSlogan) {
      return false;
    }

    if (normalizedBrand && normalizedCandidate.includes(normalizedBrand)) {
      return true;
    }

    if (/(gmbh|mbh|ag|kg|ug|llc|inc|ltd|corp|bv|oy|ab|group)$/i.test(lowered)) {
      return true;
    }

    return candidate.split(/\s+/).length <= 3;
  }

  private extractPageSummary(html: string, url: string, label: string): string | null {
    const title = this.extractTagContent(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
    const metaDescription = this.extractMetaContent(html, "description") || this.extractMetaPropertyContent(html, "og:description");
    const firstHeading = this.extractTagContent(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const bodyText = this.extractVisibleText(html)
      .split(/\s{2,}|\n+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 40)
      .slice(0, 3);

    const parts = [title, metaDescription, firstHeading, ...bodyText].filter((part): part is string => Boolean(part));
    if (parts.length === 0) {
      return null;
    }

    const prefix = label.trim().toLowerCase() !== "home" ? `${label}: ` : "";
    const pathHint = this.describePath(url);

    return [pathHint, `${prefix}${parts.join(" | ")}`]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 700);
  }

  private inferCountryFromDomain(domain: string, summary: string): string | undefined {
    const hostname = new URL(domain).hostname.toLowerCase();

    if (
      hostname.endsWith(".de") ||
      hostname.includes("gmbh") ||
      /\bgmbh\b|\bdeutschland\b|\bgermany\b|\bdeutsch\b/i.test(summary)
    ) {
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

    if (hostname.endsWith(".fr")) {
      return "France";
    }

    if (hostname.endsWith(".it")) {
      return "Italy";
    }

    if (hostname.endsWith(".es")) {
      return "Spain";
    }

    return undefined;
  }

  private describePath(url: string): string | undefined {
    try {
      const path = new URL(url).pathname;
      const segment = path.split("/").filter(Boolean).pop();
      return segment ? segment.replace(/[-_]+/g, " ").trim() : undefined;
    } catch {
      return undefined;
    }
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
    return match?.[1]
      ? this.decodeHtml(match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
      : undefined;
  }

  private extractVisibleText(html: string): string {
    return this.decodeHtml(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
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

  private extractEmbeddedUrls(html: string): string[] {
    const matches = Array.from(html.matchAll(/https?:\/\/[^"'\s<>()]+/gi));
    return matches.map((match) => this.decodeHtml(match[0] ?? "")).filter(Boolean);
  }

  private compactQueryLabel(query: string): string {
    const normalized = query.replace(/^search:/i, "").replace(/\s+/g, " ").trim();
    return normalized.length <= 70 ? normalized : `${normalized.slice(0, 67)}...`;
  }

  private buildCandidateUrls(normalizedDomain: string): string[] {
    const parsed = new URL(normalizedDomain);
    const hostname = parsed.hostname.replace(/^www\./i, "");
    return Array.from(new Set([`https://${hostname}`, `https://www.${hostname}`, `http://${hostname}`]));
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
    return COMMON_COMPOUND_TLDS.has(compoundTld) ? labels.slice(-3).join(".") : labels.slice(-2).join(".");
  }

  private toTitleCaseWords(value: string): string {
    return value
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  }

  private normalizeUrl(url: string | undefined): string | undefined {
    if (!url) {
      return undefined;
    }

    try {
      const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
      if (!parsed.hostname.includes(".")) {
        return undefined;
      }

      return `${parsed.protocol}//${parsed.hostname}`;
    } catch {
      return undefined;
    }
  }

  private normalizeSourceUrl(url: string | undefined): string | undefined {
    if (!url) {
      return undefined;
    }

    try {
      const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
      if (!parsed.hostname.includes(".")) {
        return undefined;
      }

      const normalizedPath = parsed.pathname.replace(/\/$/, "") || "/";
      return `${parsed.protocol}//${parsed.hostname}${normalizedPath}`;
    } catch {
      return undefined;
    }
  }

  private shouldIgnoreDomain(url: string): boolean {
    const lowered = url.toLowerCase();
    const blockedDomains = [
      "bing.com",
      "google.com",
      "duckduckgo.com",
      "wikipedia.org",
      "linkedin.com",
      "youtube.com",
      "facebook.com",
      "instagram.com",
      "twitter.com",
      "x.com",
      "whatsapp",
      "t.me",
      "bsky.app",
      "apps.apple.com",
      "cloudfront.net",
      "sentry.io",
      "visable.com",
      "api.visable.io",
      "schema.org",
      "w3.org",
      "wlw.de",
      "wlw.at",
      "wlw.ch",
      "openwebinarworld.com",
      "one-ware.com",
      "indeed.com",
      "glassdoor.com",
      "crunchbase.com",
      "clutch.co",
      "wlw.de",
      "werliefertwas.com",
      "kompass.com",
      "europages.com"
    ];

    return blockedDomains.some((domain) => lowered.includes(domain));
  }

  private isAllowedSourceDomain(url: string, allowSourceDomains: boolean): boolean {
    if (!allowSourceDomains) {
      return false;
    }

    const lowered = url.toLowerCase();
    return ALLOWED_SOURCE_HOST_HINTS.some((hint) => lowered.includes(hint));
  }

  private async mapWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
    const results: T[] = [];

    for (let start = 0; start < tasks.length; start += concurrency) {
      const batch = tasks.slice(start, start + concurrency);
      results.push(...(await Promise.all(batch.map((task) => task()))));
    }

    return results;
  }
}
