import { azureOpenAICostConfig, env, readiness } from "../config";
import {
  OrganizationFilter,
  AzureUsageCost,
  ExaQueryHistoryInsight,
  FilterEvaluation,
  LeadCategory,
  LeadLearningData,
  normalizeOutreachLanguage,
  OutreachLanguage,
  PersonalizedContactOutreach,
  PreCategorizedCompany,
  PrequalificationConfig,
  PublicContactCandidate,
  ResearchBrief,
  SearchHistoryEntry
} from "../types";
import {
  CATEGORY_PREQUALIFICATION_CONTEXT,
  buildMainContextBlock,
  buildPrequalificationContextBlock,
  buildSearchStrategyContextBlock,
  buildExecutionContextBlock,
  getTemplateForCategory,
  ONE_WARE_PROMPT_CONTEXT,
  TARGET_REGIONS
} from "../prompting/one-ware-playbook";
import { FoundryAgentsClient } from "./foundry-agents";
import { WebSearchAgent } from "./web-search-agent";
import { readFileSync } from "fs";
import path from "path";

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface RunChatOptions {
  maxTokens?: number;
  deployment?: string;
}

interface BuildResearchBriefOptions {
  includeWebResearch?: boolean;
}

const MAX_AZURE_RETRIES = 6;
const AZURE_RETRY_DELAYS_MS = [2000, 4000, 8000, 12000, 20000, 30000];
const AZURE_REQUEST_TIMEOUT_MS = 60000;

/**
 * Self-tuning sliding-window rate limiter for Azure OpenAI chat requests.
 *
 * The Azure deployment advertises its own per-minute request ceiling via the
 * `x-ratelimit-limit-requests` response header (e.g. 10 RPM on a small deployment). Firing the
 * many concurrent classification/extraction calls a single website analysis needs blows straight
 * past that ceiling and Azure returns 429, which previously bubbled up as silently-dropped
 * contacts. This limiter spaces request dispatch so the app stays under the advertised ceiling,
 * and re-reads the header on every successful response so the pace auto-increases when the
 * operator raises the deployment quota — no code change required.
 *
 * It is also reactive: a 429 means the small TPM/RPM budget is exhausted (a single large contact
 * extraction can consume most of a 10K-tokens-per-minute deployment on its own), so the limiter
 * imposes a global cooldown honoring the server's retry-after hint. That makes every caller wait
 * out the window together instead of hammering the deployment and losing data.
 */
class AzureChatRateLimiter {
  private recent: number[] = [];
  private tail: Promise<void> = Promise.resolve();
  private cooldownUntil = 0;

  constructor(private maxPerWindow: number, private readonly windowMs = 60_000) {}

  /** Serialize slot acquisition so concurrent callers cannot race past the ceiling together. */
  acquire(): Promise<void> {
    const result = this.tail.then(() => this.waitForSlot());
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Adopt the deployment's advertised request ceiling, leaving 20% headroom for other callers. */
  updateLimitFromHeader(limitRequestsHeader: string | null): void {
    if (!limitRequestsHeader) {
      return;
    }
    const advertised = Number.parseInt(limitRequestsHeader, 10);
    if (Number.isFinite(advertised) && advertised > 0) {
      this.maxPerWindow = Math.max(1, Math.floor(advertised * 0.8));
    }
  }

  /** On a 429, pause all dispatch until the server-advised retry window (bounded) elapses. */
  registerThrottle(retryAfterMs: number): void {
    const boundedMs = Math.min(Math.max(retryAfterMs, 1_000), this.windowMs);
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + boundedMs);
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const cooldownRemaining = this.cooldownUntil - Date.now();
      if (cooldownRemaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, cooldownRemaining + 50));
        continue;
      }
      const now = Date.now();
      this.recent = this.recent.filter((timestamp) => now - timestamp < this.windowMs);
      if (this.recent.length < this.maxPerWindow) {
        this.recent.push(now);
        return;
      }
      const oldest = this.recent[0] ?? now;
      const waitMs = Math.max(50, this.windowMs - (now - oldest) + 50);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

// Start conservative (8 RPM) — below the smallest known deployment ceiling (10 RPM) — then
// auto-tune upward from the live x-ratelimit-limit-requests header on the first success.
const azureChatRateLimiter = new AzureChatRateLimiter(8);

const EXA_QUERY_PLANNER_TIMEOUT_MS = 45000;
const CLASSIFIER_DEPLOYMENT = env.AZURE_OPENAI_CLASSIFIER_DEPLOYMENT ?? env.AZURE_OPENAI_DEPLOYMENT;
const COMPANY_CLASSIFIER_INPUT_LIMIT = 700;

// Personalized per-person outreach uses the low-cost GPT-5.4 mini classifier deployment by default
// (repo rule: prefer the low-cost mini deployment for AI evaluation), with an explicit override.
const OUTREACH_DEPLOYMENT =
  env.AZURE_OPENAI_OUTREACH_DEPLOYMENT ?? CLASSIFIER_DEPLOYMENT;

// The ONE WARE LinkedIn outreach agent prompt lives in data/outreach-context.md (copied verbatim
// from the Outreach_Agent repo). The Dockerfile ships the data/ folder, so it is readable at
// runtime under process.cwd(). Loaded once and cached; a load failure is surfaced to the caller so
// the worker can fall back to the company-level brief instead of writing an empty outreach.
const OUTREACH_CONTEXT_PATH = path.join(process.cwd(), "data", "outreach-context.md");
let cachedOutreachContext: string | undefined;
function loadOutreachContext(): string {
  if (cachedOutreachContext !== undefined) {
    return cachedOutreachContext;
  }
  cachedOutreachContext = readFileSync(OUTREACH_CONTEXT_PATH, "utf8");
  return cachedOutreachContext;
}

const WEBSITE_CLASSIFIER_INPUT_LIMIT = 2200;
const QUICK_QUALIFICATION_CONTEXT = [
  "# Identity\nYou classify company fit for ONE WARE from company descriptions and crawled website text.",
  "# Goal\nChoose exactly one category. Stay conservative and unbiased. Do not prefer integrators by default.",
  "# Evidence Handling\nUse business-model evidence from homepage, about, products, services, documentation, integrations, reference pages, applications, and use cases. Ignore cookie banners, legal text, newsletter prompts, careers pages, and navigation fragments. Do not infer fit from the company name, source filter, or vague branding alone. Words such as vision, AI, smart, digital, or automation in the company name do not count as proof.",
  "# Category Map\nintegrator_vision_industrial_ai: explicit external delivery of machine vision, computer vision, industrial inspection AI, optical quality control, image-processing systems, or edge-vision deployment for customers. Choose this when the company clearly implements customer-specific vision or inspection solutions rather than only selling a product.\nintegrator_vision_ai_consulting: consulting-shaped firm or specialist boutique with explicit machine vision, industrial AI, AOI, embedded vision, or inspection implementation work for customers. Use when the business is clearly services-led and hands-on, but consulting-shaped rather than a broader integrator organization.\nintegrator_vision_ai_freelancer: solo specialist or freelancer with explicit machine vision, industrial AI, AOI, embedded vision, or inspection implementation work for customers. Use only when the profile is clearly person-led rather than a firm.\nintegrator_general_ai: explicit external delivery of AI, machine learning, data-science, predictive analytics, or broadly reusable AI software for customers. Plain automation, PLC, SCADA, MES, embedded, or industrial software delivery without explicit AI evidence should not be integrator_general_ai. Generic engineering, generic IT, or systems-engineering capability pages alone are not enough.\nintegrator_relevant_focus: explicit customer-specific implementation ownership in a relevant industrial or technical vertical such as industrial automation, embedded systems, MES, SCADA, PLC, semiconductors, instrumentation, regulated/medtech, defence, robotics, or measurement-heavy environments, even when explicit AI wording is absent. Pure MBSE, RBE, safety, or general development-process services alone are not enough.\nmachine_builder_ai_enablement: own shipped machine, OEM system, scanner, imaging product, hardware-centric inspection product, or single-purpose shipped software application where ONE WARE would improve the product itself. Use this when Vision AI is a potential future add-on or improvement, not yet the core purpose of the machine.\nmachine_builder_vision_ai: machines or systems where Vision AI, machine vision, optical inspection, LiDAR sensing, or computer vision is the PRIMARY purpose and core value proposition of the product. Examples: AOI machines, inline optical inspection systems, automated visual quality-control equipment, LiDAR sensor systems, 3D measurement machines, or machine-vision inspection stations sold as imaging/inspection products. Do NOT require the term Vision AI — a company selling AOI machines or optical inspection stations fits this category even with classical imaging language. Use machine_builder_vision_ai when optical inspection or machine vision sensing IS the product; use machine_builder_ai_enablement when Vision AI is only a potential future add-on to a machine whose current purpose is something else. When in doubt, prefer machine_builder_vision_ai if optical inspection or machine vision is the dominant product.\nsoftware_platform_embedding: own software platform or modular software product where customers use modules, drivers, plugins, APIs, workflow builders, runtimes, app stores, installable extensions, or vendor-managed app lifecycles. This also includes OEM digital-service platforms where customers package once and deploy across many sites or machines.\nindustrial_end_customer_scaled: company primarily operates factories, plants, or production and the fit is their own internal inspection or process-automation need.\ncamera_manufacturer_partner: own camera or imaging hardware manufacturer.\nother: real company but weak, ambiguous, closed-niche, or non-priority fit. Use this when evidence is mixed or the fit path is not explicit.\nirrelevant: clear non-target such as media, publisher, event, investor, bank, insurer, recruiter, university, association, or comparable profile.",
  "# Decision Process\n1. Identify the core business model: external delivery services, own shipped product, build-on-top platform, internal captive IT, industrial operator, camera/imaging manufacturer, or irrelevant.\n2. Identify the likely ONE WARE fit path: service delivery partner, embed into own product, embed into a customer-facing platform, internal industrial IT, end-customer need, or none.\n3. Map to the closest category from the full list.",
  "# Tie-Break Rules\nIf the main fit is embedding ONE WARE into the company's own shipped software product, diagnostic plugin, or hardware product, choose machine_builder_ai_enablement.\nIf customers can build, configure, distribute, train, or run their own apps, models, workflows, plugins, modules, or extensions on the company's platform, choose software_platform_embedding.\nIf the site describes packaging an app once, deploying it across customer sites, managing app lifecycles, monetizing digital services, controlled updates, turnkey appliances, dashboard builders, or modular extensibility, that is usually software_platform_embedding, not an external integrator.\nIf the vendor provides the productized integration stack so customers do not have to build the integration stack themselves, that is evidence for software_platform_embedding, not service delivery.\nMentions of PLC, OPC UA, MQTT, SCADA, MES, remote operations, or system integration use cases do not make a vendor an integrator when those capabilities are delivered through the vendor's own runtime, app, or platform product.\nIf the company sells a closed niche municipal or route-planning platform for one operational workflow, choose other unless there is a clear open build-on-top surface.\nIf the company is a captive internal IT unit building MES, EDI, BI, process, or enterprise software for a larger industrial group, prefer integrator_general_ai over industrial_end_customer_scaled.\nIf evidence mixes catalog hardware with explicit custom system integration or engineering delivery, prefer machine_builder_ai_enablement, integrator_relevant_focus, or other over irrelevant.\nIf evidence is mixed, weak, or only capability-oriented without explicit fit-path proof, choose other rather than any integrator category.",
  "# Examples\nExample A: a certified radiology or medical-imaging plugin integrated into PACS or viewer systems is machine_builder_ai_enablement when it is a shipped product, not an open platform.\nExample B: an industrial software vendor that packages digital services as apps, deploys them to many customer sites through a runtime or appliance, and manages billing or update lifecycles is software_platform_embedding, not integrator_general_ai.\nExample C: a municipal waste, winter-service, street-cleaning, telematics, or route-planning cloud product with onboarding or rollout help still stays other unless customers clearly build their own apps, models, or extensions on top.\nExample D: a broad engineering generalist with MBSE, requirements engineering, hardware/software development, or system engineering pages but no explicit AI, automation, MES/SCADA, inspection, or embeddable platform/product surface should stay other.",
  "# Non-Targets\nReject media, publishing, editorial, event, investor, finance, recruiting, academic, association, and reseller profiles unless the evidence clearly shows a different real business model.",
  "# Page Type Gate (decide first)\nBefore choosing any business category, decide whether the crawled evidence even describes ONE single operating company. If it does not, the category is irrelevant. Classify as irrelevant when the evidence describes:\n- a company directory, business listing, company register, member list, supplier index, regional or industry overview page, or aggregator that lists MANY different companies (for example a 'companies in Bavaria/Bayern' overview, a chamber-of-commerce listing, a startup map, or a portal that profiles multiple firms);\n- a news, press, magazine, blog portal, article, or editorial page whose purpose is publishing articles rather than selling the site owner's own product or service;\n- a file-sharing, file-hosting, cloud-storage, document-hosting, download, or asset/CDN page (for example a generic file or PDF host, an upload/share service, or a page served only to deliver static assets) that is not the company's own product/marketing site.\nThese page types are not a qualifiable company and must be irrelevant even if individual company names, AI, or industrial keywords appear on the page. Only classify into a business category when the evidence clearly belongs to one identifiable operating company's own site.",
  "# Output\nReturn compact JSON only with category, relevanceScore 0-100, rationale. Keep rationale to one short sentence with at most 18 words."
].join("\n\n");
const MAX_FILTER_STRATEGY_HISTORY = 8;
const REFERENCE_COMPANY_CLASSIFICATIONS: Array<{
  match: RegExp;
  category: LeadCategory;
  relevanceScore: number;
  rationale: string;
}> = [];

export class AzureOpenAIClient {
  private readonly foundryAgentsClient = new FoundryAgentsClient();
  private readonly webSearchAgent = new WebSearchAgent();
  private readonly usageTotals: AzureUsageCost = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0
  };

  async categorizeCompany(
    name: string,
    description: string,
    dryRun: boolean,
    mainContext?: string,
    prequalification?: PrequalificationConfig,
    targetCategories?: LeadCategory[],
    learning?: LeadLearningData
  ): Promise<Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale">> {
    const deterministicCategory = this.categorizeDeterministic(name, description, learning);

    if (dryRun || !readiness.azureConfigured) {
      return this.categorizeDryRun(description);
    }

    const foundryCategorization = await this.foundryAgentsClient.categorizeCompany(
      name,
      description,
      mainContext,
      prequalification,
      undefined,
      dryRun
    );
    if (foundryCategorization) {
      return foundryCategorization;
    }

    try {
      const compactDescription = this.compactClassificationInput(description, COMPANY_CLASSIFIER_INPUT_LIMIT);
      const content = await this.runChat([
        {
          role: "system",
          content: [
            QUICK_QUALIFICATION_CONTEXT,
            buildPrequalificationContextBlock(prequalification, undefined, mainContext),
            "Do not prefer integrators over other categories. Pick the closest archetype from all available categories, including machine builders/OEMs, software platforms, end customers, camera vendors, irrelevant, and other.",
            "If the firm mainly sells its own AOI system, machine, hardware-assisted inspection product, or productized API offering, do not force it into an integrator category unless customer project-delivery ownership clearly dominates."
          ].join("\n\n")
        },
        {
          role: "user",
          content: [
            `Company=${name}`,
            `Description=${compactDescription}`,
            prequalification?.mainContext ? `Prequalification main context=${prequalification.mainContext}` : undefined,
            learning ? this.buildLearningContext(learning) : undefined
          ]
            .filter(Boolean)
            .join("\n")
        }
      ], { maxTokens: 80, deployment: CLASSIFIER_DEPLOYMENT });

      const parsed = this.parseJsonObject<{
        category: LeadCategory;
        relevanceScore: number;
        rationale: string;
      }>(content);

      return {
        ...parsed,
        category: this.normalizeCategory(parsed.category)
      };
    } catch {
      return deterministicCategory ?? this.categorizeDryRun(description);
    }
  }

  /**
   * Flexible, AI-based region membership. Given a free-text target-market description (e.g. "DE",
   * "Europa", "EU und USA", "DACH", "Benelux") and one or more headquarters countries, decides for
   * each country whether a company headquartered there falls inside the described market. The market
   * wording is the authoritative scope contract — this replaces hardcoded country lists so arbitrary
   * market descriptions work without code changes. The whole country list is classified in a single
   * call, and callers cache by (market, country) so each distinct country costs at most one request.
   * Returns null when Azure is not configured so callers can fall back to a deterministic check.
   */
  async classifyCountriesInTargetMarket(
    market: string,
    countries: string[]
  ): Promise<Record<string, boolean> | null> {
    const normalizedCountries = Array.from(
      new Set(countries.map((country) => country.trim()).filter(Boolean))
    );
    if (normalizedCountries.length === 0) {
      return {};
    }
    const normalizedMarket = market?.trim();
    if (!normalizedMarket || !readiness.azureConfigured) {
      return null;
    }

    try {
      const content = await this.runChat(
        [
          {
            role: "system",
            content: [
              "You decide whether companies belong to a target sales market based ONLY on their headquarters country.",
              "The target market is a free-text description and is a HARD constraint. Interpret it precisely and flexibly:",
              "- A single country code or name means that country only (e.g. 'DE' or 'Germany' = Germany only).",
              "- Region words include their member countries (e.g. 'Europe'/'EU' = European countries; 'DACH' = Germany, Austria, Switzerland; 'Benelux' = Belgium, Netherlands, Luxembourg; 'Nordics' = Denmark, Sweden, Norway, Finland, Iceland).",
              "- Combinations joined by 'und'/'and'/'+'/',' are unions (e.g. 'EU und USA' = European countries plus the United States).",
              "Set inMarket=true only when a company headquartered in that country clearly belongs to the described market.",
              "Respond as JSON {\"results\":[{\"country\":string,\"inMarket\":boolean}]} with exactly one entry per input country, echoing the country string exactly as given."
            ].join("\n")
          },
          {
            role: "user",
            content: [`Target market: ${normalizedMarket}`, `Countries: ${normalizedCountries.join(", ")}`].join("\n")
          }
        ],
        { maxTokens: Math.min(60 + normalizedCountries.length * 14, 600), deployment: CLASSIFIER_DEPLOYMENT }
      );

      const parsed = this.parseJsonObject<{ results?: Array<{ country?: string; inMarket?: boolean }> }>(content);
      const verdicts: Record<string, boolean> = {};
      for (const entry of parsed.results ?? []) {
        const key = entry.country?.trim().toLowerCase();
        if (key) {
          verdicts[key] = entry.inMarket === true;
        }
      }
      return verdicts;
    } catch {
      return null;
    }
  }

  async categorizeWebsiteCrawl(
    name: string,
    domain: string | undefined,
    crawledWebsiteSummary: string,
    dryRun: boolean,
    mainContext?: string,
    prequalification?: PrequalificationConfig,
    learning?: LeadLearningData
  ): Promise<Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale" | "country">> {
    if (dryRun || !readiness.azureConfigured) {
      return this.categorizeDryRun(crawledWebsiteSummary);
    }

    const websiteProfile = domain
      ? await this.webSearchAgent.crawlCompanyWebsite(domain, "open_crawler_search")
      : null;
    if (domain && !websiteProfile) {
      return {
        category: "irrelevant",
        relevanceScore: 0,
        rationale: "Official website could not be loaded reliably, so the company is rejected before qualification."
      };
    }

    const websiteEvidence = websiteProfile?.summary?.trim() || crawledWebsiteSummary;

    try {
      const compactWebsiteSummary = this.compactClassificationInput(websiteEvidence, WEBSITE_CLASSIFIER_INPUT_LIMIT);
      const content = await this.runChat(
        this.buildWebsiteClassificationMessages(
          name,
          domain,
          compactWebsiteSummary,
          mainContext,
          prequalification,
          learning,
          false
        ),
        { maxTokens: 160, deployment: CLASSIFIER_DEPLOYMENT }
      );

      const parsed = this.parseJsonObject<{
        category: LeadCategory;
        relevanceScore: number;
        rationale: string;
        country?: string;
      }>(content);

      return {
        ...parsed,
        category: this.normalizeCategory(parsed.category),
        country: parsed.country?.trim() || undefined
      };
    } catch {
      try {
        const compactRetrySummary = this.compactClassificationInput(websiteEvidence, 1500);
        const retryContent = await this.runChat(
          this.buildWebsiteClassificationMessages(
            name,
            domain,
            compactRetrySummary,
            mainContext,
            prequalification,
            learning,
            true
          ),
          { maxTokens: 160, deployment: CLASSIFIER_DEPLOYMENT }
        );

        const retryParsed = this.parseJsonObject<{
          category: LeadCategory;
          relevanceScore: number;
          rationale: string;
          country?: string;
        }>(retryContent);

        return {
          ...retryParsed,
          category: this.normalizeCategory(retryParsed.category),
          country: retryParsed.country?.trim() || undefined
        };
      } catch {
        return {
          category: "other",
          relevanceScore: 25,
          rationale: "Website evidence could not be classified reliably and should stay in manual-review territory."
        };
      }
    }
  }

  async buildResearchBrief(
    company: PreCategorizedCompany,
    dryRun: boolean,
    mainContext?: string,
    learning?: LeadLearningData,
    options: BuildResearchBriefOptions = {}
  ): Promise<ResearchBrief> {
    const includeWebResearch = options.includeWebResearch !== false;
    const template = getTemplateForCategory(company.category);
    const executionContext = buildExecutionContextBlock(company.category, mainContext);

    const foundryResearchBrief = includeWebResearch
      ? await this.foundryAgentsClient.buildResearchBrief(company, mainContext, dryRun)
      : null;
    if (foundryResearchBrief) {
      return foundryResearchBrief;
    }

    if (dryRun || !readiness.azureConfigured) {
      return this.buildFallbackResearchBrief(company, template, executionContext, mainContext);
    }

    const websiteProfile = company.domain
      ? await this.webSearchAgent.crawlCompanyWebsite(company.domain, "open_crawler_search")
      : null;

    if (!websiteProfile) {
      return this.buildFallbackResearchBrief(company, template, executionContext, mainContext);
    }

    const crawledWebsiteEvidence = {
      context: [
        "Crawled website evidence:",
        `Company: ${company.name}`,
        `Website: ${websiteProfile.landingUrl}`,
        `Website summary: ${websiteProfile.summary}`
      ].join("\n\n"),
      citations: [websiteProfile.landingUrl, ...websiteProfile.relevantUrls]
    };

    const webResearchEvidence = includeWebResearch
      ? await this.webSearchAgent.buildResearchContext(company)
      : undefined;

    try {
      const content = await this.runChat([
        {
          role: "system",
          content: `${buildMainContextBlock(mainContext)}\n\nTask: Build a concise sales research brief for ONE WARE. Use the segment template as the base and only personalize where a clear factual hook exists. Do not fully rewrite the outreach. Keep the core USP visible: less trial and error, faster path to production-ready models, more predictable timelines, local training, smaller hardware-efficient models, lower development effort. Apply the category execution context strictly. Estimate whether the decision-makers or likely target contacts are German-speaking. If yes, produce outreach in German; otherwise produce it in English. For LinkedIn, always produce two separate texts: linkedInConnectionRequest as a short connection request with a hard maximum of 200 characters, and linkedInMessage as the longer follow-up message after connecting. Treat linkedInConnectionRequest as a compact teaser, not a compressed full pitch. Good example style for German outreach: "Hi Marc, eure Physical-AI Loesungen bei Sereact finde ich sehr spannend. Wir haben einen neuen Ansatz, der passende Vision-AI-Architekturen automatisiert erzeugt. Wuerde mich ueber einen Austausch freuen". For German outreach, always start emailBody naturally with "Hallo [Name]," and never with "Hello". Keep German phrasing natural and direct, avoid long list-like opener sentences, avoid vague department enumerations that sound AI-written, and do not use dash punctuation such as "–" or "—" in outreach copy. Prefer commas or full sentences instead. Estimate all three commercial rankings on a 0-10 scale: customer, serviceProvider, partner. Estimate businessPotentialEUR as a realistic euro value, not a score. Use the following commercial framing: a single AI use case often starts around 7000 EUR, can be 20000 to 40000 EUR per AI for more complex or production-grade deployments, can multiply across many use cases, and OEM or camera-manufacturer partner rollouts can be much larger, including six- or seven-figure potential in recurring machine volumes. Also return targetIndustry and productsOffered. Use any supplied web evidence as your factual grounding. If no web evidence is supplied, reason only from the provided company facts and keep uncertainty explicit. If the evidence is weak or conflicting, say so in riskFlags instead of inventing certainty. The outreach must not open with generic flattery. If the evidence contains a concrete company hook such as 2D/3D machine vision, AOI, visual inspection, quality control, robot guidance, Sondermaschinenbau, MES, SCADA, factory software, or a named industrial use case, reference that hook in the first sentence of linkedInMessage and emailBody. Make the first sentence sound company-specific, not template-generic. Keep linkedInConnectionRequest shorter, simpler, and curiosity-driven than linkedInMessage. For service-provider or partner-leaning companies, keep phoneScript collaboration-first: first ask whether they already implement Vision AI or have relevant experience, then position ONE WARE as a software layer for faster production-ready models, and finally test whether a delivery partnership or joint customer work could make sense. Keep placeholders only for the contact name ([Name]) and sender name ([Ihr Name]), not for company-specific hooks. All other placeholders such as [Branche / Anwendung], [Branche], [Anwendungsfall], [für die visuelle Qualitätskontrolle], or any similar bracketed content MUST be replaced with concrete, company-specific language drawn from the crawled website evidence or company description. If you cannot find a specific hook, write a plausible and concrete industry or application based on what the company does — never leave a bracketed placeholder for anything other than [Name] and [Ihr Name]. Return strict JSON with: overview, qualificationSummary, qualifyingSignals (array of strings), riskFlags (array of strings), likelyGermanSpeaking, outreachLanguage, rankings { customer, serviceProvider, partner }, businessPotentialEUR, businessPotentialReasoning, targetIndustry, productsOffered, recommendedTemplateKey, personalizationRule, linkedInAngle, emailAngle, phoneAngle, linkedInConnectionRequest, linkedInMessage, emailSubject, emailBody, phoneScript, eventIdea.`
        },
        {
          role: "user",
          content: [
            `Company: ${company.name}`,
            company.domain ? `Known website: ${company.domain}` : undefined,
            company.country ? `Country: ${company.country}` : undefined,
            `Known description: ${company.shortDescription}`,
            `Category: ${company.category}`,
            executionContext,
            `Source filter: ${company.sourceFilter}`,
            `Relevance score: ${company.relevanceScore}`,
            `Base template key: ${template.key}`,
            `Base template subject: ${template.subject}`,
            `Base template email body:\n${template.emailBody}`,
            `Base template LinkedIn connection request:\n${template.linkedInConnectionRequest}`,
            `Base template LinkedIn message:\n${template.linkedInMessage}`,
            `Base template phone script:\n${template.phoneScript}`,
            crawledWebsiteEvidence?.context,
            webResearchEvidence?.context,
            learning ? this.buildLearningContext(learning) : undefined
          ].join("\n\n")
        }
      ]);

      const parsed = this.parseJsonObject<Omit<ResearchBrief, "companyName" | "outreachLanguage"> & { outreachLanguage?: string }>(content);
      return {
        companyName: company.name,
        appliedAgentContext: mainContext,
        website: websiteProfile.landingUrl,
        isFallback: false,
        citations: Array.from(new Set([
          ...(crawledWebsiteEvidence?.citations ?? []),
          ...(webResearchEvidence?.citations ?? [])
        ])),
        ...parsed,
        outreachLanguage: normalizeOutreachLanguage(parsed.outreachLanguage, parsed.likelyGermanSpeaking ? "de" : "en")
      };
    } catch {
      return this.buildFallbackResearchBrief(
        company,
        template,
        executionContext,
        mainContext,
        Array.from(new Set([
          ...(crawledWebsiteEvidence?.citations ?? []),
          ...(webResearchEvidence?.citations ?? [])
        ]))
      );
    }
  }

  /**
   * Generate an individual, website-grounded outreach message for ONE specific contact, using the
   * verbatim ONE WARE LinkedIn outreach agent prompt (data/outreach-context.md) as the system
   * contract. Every contact gets its own call so the message is personalized per person. The model
   * receives the company's crawled website evidence plus the person's role/name, and returns a
   * structured JSON object mirroring the context.md "Output Format" section. Agent-first: the prompt
   * and schema are the contract; we do not post-process or rewrite the model's message.
   */
  async generatePersonalizedContactOutreach(input: {
    company: { name: string; website?: string; country?: string; category?: string };
    websiteEvidence: string;
    outreachLanguage: OutreachLanguage;
    contact: {
      firstName?: string;
      lastName?: string;
      jobTitle?: string;
      linkedinUrl?: string;
    };
  }): Promise<PersonalizedContactOutreach> {
    const context = loadOutreachContext();
    const personName = [input.contact.firstName, input.contact.lastName].filter(Boolean).join(" ").trim();
    const languageInstruction = input.outreachLanguage === "de"
      ? "Write the final outreach message in natural German."
      : "Write the final outreach message in natural English.";

    const systemPrompt = [
      context,
      "",
      "---",
      "",
      "# Runtime Output Contract (this overrides the prose 'Output Format' section above)",
      "Return ONLY a single JSON object, no markdown fences, with exactly these keys:",
      "{",
      '  "researchFinding": string,        // one sentence',
      '  "underlyingLimitation": string,   // one sentence: a real technical constraint, not an industry',
      '  "selectedStory": string,          // the ONE WARE demo/benchmark you matched',
      '  "customerValue": string,          // one sentence: the concrete benefit for THIS person',
      '  "whyMatchWorks": string,          // 2-3 sentences',
      '  "message": string,                // the final outreach message, 70-120 words, no em/en dashes',
      '  "language": "de" | "en",',
      '  "confidence": "high" | "medium" | "low"',
      "}",
      languageInstruction,
      "The message must be individual for THIS person and address them by their first name when it is known.",
      "Only use the company's own website evidence below for the prospect anchor; do not invent products, customers, case studies, or numbers that are not in the context or that evidence.",
      "Never use the characters '\u2014' or '\u2013' anywhere in the message."
    ].join("\n");

    const userContent = [
      `Prospect company: ${input.company.name}`,
      input.company.website ? `Company website: ${input.company.website}` : undefined,
      input.company.country ? `Country: ${input.company.country}` : undefined,
      input.company.category ? `Category: ${input.company.category}` : undefined,
      "",
      "Website evidence (crawled from the company's own site - use this to pick the concrete anchor and limitation):",
      input.websiteEvidence || "(no website evidence available - keep the anchor honest and general, and lower confidence)",
      "",
      "Person to write to:",
      personName ? `Name: ${personName}` : "Name: unknown (write a natural opener without a first name)",
      input.contact.jobTitle ? `Role: ${input.contact.jobTitle}` : undefined,
      input.contact.linkedinUrl ? `LinkedIn: ${input.contact.linkedinUrl}` : undefined
    ].filter((line): line is string => line !== undefined).join("\n");

    const content = await this.runChat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
      ],
      { maxTokens: 900, deployment: OUTREACH_DEPLOYMENT }
    );

    const parsed = this.parseJsonObject<Partial<PersonalizedContactOutreach> & { language?: string }>(content);
    if (!parsed.message || !parsed.message.trim()) {
      throw new Error("Personalized outreach agent returned an empty message.");
    }

    const confidence = parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
      ? parsed.confidence
      : undefined;

    return {
      message: parsed.message.trim(),
      language: normalizeOutreachLanguage(parsed.language, input.outreachLanguage),
      researchFinding: parsed.researchFinding,
      underlyingLimitation: parsed.underlyingLimitation,
      selectedStory: parsed.selectedStory,
      customerValue: parsed.customerValue,
      whyMatchWorks: parsed.whyMatchWorks,
      confidence
    };
  }

  private compactClassificationInput(text: string, maxLength: number): string {
    const normalized = text.replace(/\r/g, "\n").replace(/\t/g, " ");
    const segments = normalized
      .split(/\n+/)
      .map((segment) => segment.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    const noisePatterns = [
      /cookie/i,
      /privacy/i,
      /datenschutz/i,
      /impressum/i,
      /newsletter/i,
      /career|karriere|jobs|bewerbung/i,
      /accept all|reject all|save settings|consent/i,
      /copyright/i,
      /powered by/i,
      /additional links/i,
      /home$/i,
      /contact us|kontakt/i
    ];
    const ordered = segments
      .filter((segment) => !noisePatterns.some((pattern) => pattern.test(segment)))
      .filter((segment, index, all) => all.indexOf(segment) === index);

    const compacted: string[] = [];
    let length = 0;
    for (const segment of ordered) {
      const addition = compacted.length === 0 ? segment : ` ${segment}`;
      if (length + addition.length > maxLength) {
        break;
      }
      compacted.push(segment);
      length += addition.length;
    }

    const result = compacted.join(" ").trim() || segments.join(" ").replace(/\s+/g, " ").trim();
    return result.length <= maxLength ? result : `${result.slice(0, maxLength - 3)}...`;
  }

  async choosePublicContacts(
    company: Pick<PreCategorizedCompany, "name" | "domain" | "country" | "category">,
    candidates: PublicContactCandidate[],
    dryRun: boolean
  ): Promise<PublicContactCandidate[]> {
    const rankedCandidates = candidates.slice(0, 12);
    if (rankedCandidates.length === 0 || dryRun || !readiness.azureConfigured) {
      return rankedCandidates.slice(0, 4);
    }

    try {
      const contactPayload = rankedCandidates.map((candidate, index) => ({
        contactId: `contact_${index + 1}`,
        firstName: candidate.firstName,
        lastName: candidate.lastName,
        jobTitle: candidate.jobTitle,
        email: candidate.email,
        phone: candidate.phone,
        linkedinUrl: candidate.linkedinUrl,
        linkedinConnectionCount: candidate.linkedinConnectionCount,
        sourceUrl: candidate.sourceUrl,
        sourceQuery: candidate.sourceQuery,
        sourceSnippet: candidate.sourceSnippet,
        label: candidate.label
      }));

      const content = await this.runChat([
        {
          role: "system",
          content: `${buildMainContextBlock(undefined)}\n\nTask: Rank and select up to 4 public web-search contacts for outbound outreach. Use this step mainly to prioritize, not to aggressively discard. Managers and decision-makers first; if fewer than 4 relevant manager-type people are evidence-backed, fill remaining slots with developers or engineering contacts. Reject only candidates that are clearly invalid, for example one-word names, CTA text, navigation fragments, generic phrases such as represented by, our customers, about us, team, contact, company, business, or similar non-person labels. Reject candidates whose evidence points to a different company, parent brand, partner brand, directory, or unrelated domain unless the evidence explicitly says they work for the supplied company. A candidate whose only reachable channel is an email on a different company's corporate domain than the supplied company (for example a distributor, reseller, marketplace, integrator partner, or component-supplier employee surfaced through the supplied company's pages) must be rejected unless the evidence explicitly states that person works for the supplied company; never keep such a foreign-domain email contact, because it would attach outreach to the wrong company. Do not treat LinkedIn company pages or generic company mailboxes as people, but you may keep one such company-level fallback contact when it is the only evidence-backed public outreach channel for the supplied company. Treat founder or company-founding evidence in snippets, for example wording like "we founded <company>", as a strong executive-leadership signal even if no explicit CEO title is present. Prefer one executive sponsor plus one technical or operational owner when possible. Prefer contacts that combine multiple reachable data points such as personal LinkedIn URL, named company email, and phone. Avoid HR, recruiting, finance, legal, support, generic sales, marketing, students, advisors, and unrelated contacts when stronger company-matching contacts exist. When evidence-backed personal LinkedIn profiles or named employee contacts exist for the supplied company, keep them rather than returning an empty result. Use only the provided evidence. Return strict JSON with {"selectedContactIds":["..."],"reason":"..."}.`
        },
        {
          role: "user",
          content: [
            `Company: ${company.name}`,
            company.domain ? `Domain: ${company.domain}` : undefined,
            company.country ? `Country: ${company.country}` : undefined,
            company.category ? `Category: ${company.category}` : undefined,
            `Candidates JSON: ${JSON.stringify(contactPayload)}`
          ].filter(Boolean).join("\n\n")
        }
      ], { maxTokens: 220 });

      const parsed = this.parseJsonObject<{ selectedContactIds?: string[] }>(content);
      if (Array.isArray(parsed.selectedContactIds)) {
        const selectedIds = new Set(parsed.selectedContactIds);
        return rankedCandidates.filter((_, index) => selectedIds.has(`contact_${index + 1}`)).slice(0, 4);
      }

      const selectedIds = new Set<string>(parsed.selectedContactIds ?? []);
      const selected = rankedCandidates.filter((_, index) => selectedIds.has(`contact_${index + 1}`));
      if (selected.length > 0) {
        return selected.slice(0, 4);
      }
    } catch {
      // Fall back to the heuristic order provided by the caller.
    }

    return rankedCandidates.slice(0, 4);
  }

  async extractPublicContactsFromEvidence(
    company: Pick<PreCategorizedCompany, "name" | "domain" | "country" | "category">,
    evidence: {
      websitePages: Array<{
        url: string;
        evidenceSnippet: string;
        emails?: string[];
        phones?: string[];
        linkedInProfileUrl?: string;
        namedContacts?: unknown[];
      }>;
      hitGroups: Array<{
        query: string;
        hits: Array<{
          url: string;
          title: string;
          snippet: string;
        }>;
      }>;
    },
    dryRun: boolean
  ): Promise<PublicContactCandidate[]> {
    if (dryRun || !readiness.azureConfigured) {
      return [];
    }

    const evidencePayload = {
      websitePages: evidence.websitePages.slice(0, 8).map((page) => ({
        url: page.url,
        evidenceSnippet: page.evidenceSnippet,
        emails: page.emails ?? [],
        phones: page.phones ?? [],
        linkedInProfileUrl: page.linkedInProfileUrl
      })),
      hitGroups: evidence.hitGroups.slice(0, 4)
    };

    if (evidencePayload.websitePages.length === 0 && evidencePayload.hitGroups.length === 0) {
      return [];
    }

    try {
      const content = await this.runChat([
        {
          role: "system",
          content: `${buildMainContextBlock(undefined)}\n\nTask: Extract and match public contact data for outbound outreach from raw official-website evidence and raw public web-search evidence. This step is for extraction and matching, not for aggressive filtering. Read the raw evidenceSnippet text yourself to identify named people (for example Geschäftsführung/management, Ansprechpartner/contact persons, named team members) together with their role and a reachable channel. Return all evidence-backed contacts for the supplied company up to 6 entries. Keep every evidence-backed personal LinkedIn /in/ profile that belongs to the supplied company, and treat company-name variations as the same company: legal-form suffixes (for example GmbH vs GmbH & Co. KG vs AG vs KG), brand short forms, the domain token, and a parent/holding or group name that shares the same core brand all refer to the supplied company. Do not drop a personal LinkedIn /in/ profile only because its title shows a slightly different legal form, group name, or brand spelling. Exclude a LinkedIn profile only when its snippet clearly shows the person has already left the company (a past end date) or it clearly belongs to an unrelated company. When a personal LinkedIn /in/ profile in the hitGroups matches a current named person you also extracted from the website evidence (same person name), attach that linkedinUrl (and linkedinConnectionCount when visible) to that person's existing contact instead of dropping it or emitting a duplicate; otherwise emit the current LinkedIn person as a standalone linkedin_profile contact. For every linkedin_profile contact you MUST set linkedinUrl to that person's personal LinkedIn /in/ URL (the exact same /in/ URL you reference as sourceUrl); never leave linkedinUrl empty for a linkedin_profile contact. Always include at least one current personal LinkedIn /in/ profile in the returned contacts when the evidence contains one, even when named website officers are also present. Keep website email addresses and phone numbers even when they cannot be matched to a named person; in that case emit a separate generic website contact instead of guessing. If the evidenceSnippet mentions named company officers (Geschäftsführer, Inhaber, Geschäftsleitung, CEO, Managing Director, Vertreten durch) by full name, always emit each named officer as a separate website_named_contact using the company's shared phone or email as the channel — even if their personal email is not listed. If the only public LinkedIn evidence is a company LinkedIn page or other non-person LinkedIn reference that clearly belongs to the supplied company, keep at most one such company-level fallback contact instead of dropping LinkedIn entirely. Email addresses on public websites are frequently obfuscated to defeat scrapers, especially on legacy German and European pages: they may carry anti-harvest tokens inside the domain or local part (for example info@remove-this.example.com, kontakt@nospam.example.de, name@example.de.nospam) or use textual separators (name (at) example.de, name [at] example [dot] de, name AT example DOT de). Before returning an email, reconstruct the real address: remove anti-harvest tokens such as remove-this., removethis., remove., nospam., no-spam., kein-spam., delete-this., antispam. from the domain and local part, and decode textual separators ( (at)/[at]/ AT to @ and (dot)/[dot]/ DOT to .). The domain you emit must be a real registrable domain — never keep a fabricated label such as remove-this. or nospam. as part of the domain. Only emit an email you can confidently reconstruct into a valid address; otherwise omit the email rather than returning an obfuscated or invalid one. Match email addresses and phone numbers to a named person only when the evidence clearly supports the match. Never treat call-to-action, navigation, menu, button, slogan, or heading text (for example "Mehr erfahren", "Learn More", "Nehmen Sie Kontakt", "What To Expect") as a person name. Reject only gibberish, broken encoding, CTA text, navigation text, placeholders, and corrupted names. Never use the supplied company's own name, brand, product, or domain label as a person's firstName or lastName (for example do not return firstName "Edgeglobe" for company EdgeGlobe); a contact must be an actual human, so when only the company/brand name is present leave firstName and lastName empty and emit it as a generic mailbox label instead of a fake person. The jobTitle field must be a short, real role title (for example "Geschäftsführer", "CTO", "Head of Sales", "Founder", "Ansprechpartner Vertrieb"); never place a company description, value proposition, marketing slogan, partnership statement, or any multi-clause sentence into jobTitle (for example never return "Operated in partnership with X / contact person" or "Industrial EdgeAI solutions provider" as a jobTitle) — leave jobTitle empty when no genuine human role is evident. Do not invent names, titles, emails, phones, or LinkedIn URLs. Return strict JSON with {"contacts":[{"firstName":"...","lastName":"...","jobTitle":"...","email":"...","phone":"...","linkedinUrl":"...","linkedinConnectionCount":123,"sourceUrl":"...","sourceQuery":"...","sourceSnippet":"...","label":"linkedin_profile|website_named_contact|public_named_mailbox|public_generic_mailbox|web_search_contact"}]}. Keep up to 6 contacts, best first.`
        },
        {
          role: "user",
          content: [
            `Company: ${company.name}`,
            company.domain ? `Domain: ${company.domain}` : undefined,
            company.country ? `Country: ${company.country}` : undefined,
            company.category ? `Category: ${company.category}` : undefined,
            `Raw contact evidence JSON: ${JSON.stringify(evidencePayload)}`
          ].filter(Boolean).join("\n\n")
        }
      ], { maxTokens: 2800 });

      const parsed = this.parseJsonObject<{ contacts?: PublicContactCandidate[] }>(content);
      const usableContacts = (parsed.contacts ?? [])
        .map((contact) => this.reconcileLinkedInUrl(contact))
        .filter((contact) => Boolean(
          contact.sourceUrl
          || contact.linkedinUrl
          || contact.email
          || contact.phone
          || contact.firstName
          || contact.lastName
        ));
      return this.dedupePublicContacts(usableContacts).slice(0, 6);
    } catch (error) {
      console.error(`[AzureOpenAI.extractPublicContactsFromEvidence] failed for ${company.name}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * Repair the model's own self-inconsistent output: the extraction prompt asks for a personal
   * LinkedIn /in/ URL in linkedinUrl for every linkedin_profile contact, but the model sometimes
   * places that /in/ URL only in sourceUrl and leaves linkedinUrl empty. Downstream code (HubSpot
   * sync, personalLinkedInCount) reads linkedinUrl, so an empty value silently loses a real
   * personal LinkedIn profile. This only promotes the contact's OWN sourceUrl into its OWN
   * linkedinUrl when sourceUrl is a personal /in/ profile and linkedinUrl is empty — it never
   * fabricates, guesses, or cross-references another contact's data.
   */
  private reconcileLinkedInUrl(contact: PublicContactCandidate): PublicContactCandidate {
    const isPersonalLinkedIn = (url?: string): boolean =>
      typeof url === "string" && /linkedin\.com\/in\//i.test(url);

    if (!contact.linkedinUrl?.trim() && isPersonalLinkedIn(contact.sourceUrl)) {
      return { ...contact, linkedinUrl: contact.sourceUrl };
    }

    return contact;
  }

  /**
   * Collapse contacts the model emitted more than once for the same person. The extraction prompt
   * occasionally returns the same person twice — for example once as a standalone LinkedIn /in/
   * profile (URL but no email) and once as a named website contact (email/source but no URL) — which
   * would otherwise waste a selection slot and create a duplicate HubSpot contact. Each contact can
   * be identified by several keys (normalized LinkedIn /in/ URL, email, and full name); when a
   * contact shares any key with an already-seen contact they are merged into one, keeping the richest
   * value of every field so no reachable channel (URL, email, phone, source) is lost.
   */
  private dedupePublicContacts(contacts: PublicContactCandidate[]): PublicContactCandidate[] {
    const normalizeLinkedIn = (url?: string): string | undefined => {
      if (!url) {
        return undefined;
      }
      const match = url.toLowerCase().match(/linkedin\.com\/in\/([^/?#]+)/);
      return match ? `in:${match[1]}` : undefined;
    };
    const candidateKeys = (contact: PublicContactCandidate): string[] => {
      const keys: string[] = [];
      const linkedinKey = normalizeLinkedIn(contact.linkedinUrl);
      if (linkedinKey) {
        keys.push(linkedinKey);
      }
      const email = contact.email?.trim().toLowerCase();
      if (email) {
        keys.push(`email:${email}`);
      }
      // Normalize the name to Unicode NFC and collapse internal whitespace so the same person does
      // not split into two clusters when one source uses a precomposed umlaut (ö = U+00F6) and the
      // other a decomposed one (o + U+0308) — common with German names across LinkedIn vs website.
      const fullName = [contact.firstName, contact.lastName]
        .map((part) => part?.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " "))
        .filter(Boolean)
        .join(" ");
      // Only treat a full (multi-token) name as an identity — a lone first name is too weak and
      // could collapse two different people.
      if (fullName.includes(" ")) {
        keys.push(`name:${fullName}`);
      }
      return keys;
    };
    const pick = <T>(primary: T | undefined, fallback: T | undefined): T | undefined => {
      if (typeof primary === "string") {
        return primary.trim() ? primary : (fallback ?? primary);
      }
      return primary ?? fallback;
    };
    const mergeContacts = (existing: PublicContactCandidate, incoming: PublicContactCandidate): PublicContactCandidate => ({
      ...existing,
      firstName: pick(existing.firstName, incoming.firstName),
      lastName: pick(existing.lastName, incoming.lastName),
      jobTitle: pick(existing.jobTitle, incoming.jobTitle),
      email: pick(existing.email, incoming.email),
      phone: pick(existing.phone, incoming.phone),
      linkedinUrl: pick(existing.linkedinUrl, incoming.linkedinUrl),
      linkedinConnectionCount: existing.linkedinConnectionCount ?? incoming.linkedinConnectionCount,
      sourceUrl: pick(existing.sourceUrl, incoming.sourceUrl) ?? existing.sourceUrl,
      sourceQuery: pick(existing.sourceQuery, incoming.sourceQuery),
      sourceSnippet: pick(existing.sourceSnippet, incoming.sourceSnippet),
      label: pick(existing.label, incoming.label) ?? existing.label
    });

    const clusters: PublicContactCandidate[] = [];
    const keyToCluster = new Map<string, number>();

    for (const contact of contacts) {
      const keys = candidateKeys(contact);
      const targetIndex = keys.map((key) => keyToCluster.get(key)).find((index) => index !== undefined);
      if (targetIndex === undefined) {
        const newIndex = clusters.length;
        clusters.push(contact);
        for (const key of keys) {
          keyToCluster.set(key, newIndex);
        }
        continue;
      }
      clusters[targetIndex] = mergeContacts(clusters[targetIndex], contact);
      // Register any new keys this contact contributes so later duplicates also collapse here.
      for (const key of candidateKeys(clusters[targetIndex])) {
        if (!keyToCluster.has(key)) {
          keyToCluster.set(key, targetIndex);
        }
      }
    }

    return clusters;
  }

  async analyzeCompanyHomepage(
    company: Pick<PreCategorizedCompany, "name" | "domain" | "country" | "category">,
    homepage: {
      url: string;
      evidenceSnippet: string;
      candidateLinks: Array<{ url: string; anchorText: string }>;
    },
    dryRun: boolean
  ): Promise<{
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
    followUpUrls: string[];
  } | null> {
    if (dryRun || !readiness.azureConfigured) {
      return null;
    }

    try {
      const content = await this.runChat([
        {
          role: "system",
          content: `${buildMainContextBlock(undefined)}\n\nTask: Read official company homepage evidence and extract organization-level company information only. Extract the exact legal operating entity for the supplied domain, postal address, shared company inboxes, and main switchboard phone numbers when they are explicitly visible. The legal entity named in this website's own impressum, legal notice, or contact/footer block is the operating entity for this website: return it as companyName with entityScope "exact_operating_entity" even when its registered name differs from the public brand, the person operating the site, or the domain label. Only withhold the name (leaving companyName empty with the matching entityScope) when the evidence shows it belongs to a separate parent group, holding company, umbrella brand, or an unrelated third-party brand rather than the operator of this site. A company name shown with a legal form in this website's own footer, copyright line, header, logo block, or impressum — for example "© 2026 Example Co.,Ltd.", "Example GmbH", "Example Inc.", "Example S.A.", "Example Ltd." — is this site's exact operating entity: return it as companyName with entityScope "exact_operating_entity" unless the evidence clearly shows it is a separate parent group or unrelated brand. Exception: a footer credit, copyright line, or "created/realised/designed/developed by", "réalisé par", "site by", "webdesign by", "powered by" attribution that names the web design or web development AGENCY that built the site — recognisable because it usually links to a DIFFERENT external domain than this site and/or sits next to such wording — is NOT the operating entity; ignore that agency name and instead use the entity named as the owner/operator in the impressum or legal notice ("Propriétaire", "Inhaber", "Betreiber", "Herausgeber", "Owner", e.g. a "SAS"/"SARL"/"GmbH" company) as the exact operating entity. The supplied Country is an unverified hint that may be wrong; determine the country from this website's own evidence (registered office, "headquartered in" statements, impressum or postal address, or the international phone dialing code such as +49 Germany, +972 Israel, +82 South Korea, +86 China) and return that country, only falling back to the hint when the website gives no country evidence. A natural person's name listed as the site operator's representative, owner, proprietor, or managing director — for example the name following "Vertreten durch", "Vertretungsberechtigt", "Inhaber", "Inhaberin", "Geschäftsführer", "Geschäftsführerin", "Owner", "Proprietor", "Represented by", "Managing Director", "CEO", or "Founder" in an impressum or legal notice — is the human REPRESENTATIVE of the business, NOT the company name: never return a bare personal name (a given name plus surname with no legal form and no brand word, e.g. "Anton Lytvynenko") as companyName. When the operator is a sole proprietorship / Einzelunternehmen whose only named entity is a person, set companyName to the business's trading or brand name instead — the name under which it actually operates, taken from the logo, header, site title, or domain label (e.g. "ki-aktiv") — with entityScope "exact_operating_entity"; if no trading or brand name is evident anywhere in the evidence, leave companyName empty and set entityScope "uncertain" rather than returning the person's name. When the homepage evidence is genuinely ambiguous, leave companyName empty and set entityScope accordingly. Also produce searchAliases: 1 to 4 short, search-friendly names for the exact operating entity that a recruiter could type to find this company's employees on LinkedIn. Include only the legal entity name, its brand or short form, and the domain token. searchAliases must never contain call-to-action, marketing, slogan, navigation, menu, button, or heading phrases (for example "Nehmen Sie Kontakt", "Learn More", "Mehr erfahren", "Contact us"), and never a parent group or unrelated brand. If you are unsure, return only the domain token. Then choose the best 1 to 5 follow-up links that are most likely to contain missing official company information, legal identity, address details, or company-level contact details. Prefer kontakt, contact, impressum, imprint, legal, about, company, team, and footer-linked pages when relevant. If this site's own impressum, legal notice, or contact page is hosted on a different domain (common for sole proprietors, freelancers, and agencies that link their impressum/contact to a separate operating-company domain), include that exact impressum/legal/contact URL as a follow-up link so the legal entity, address, and contacts can be read. Do not include personal data. Do not invent information. Email addresses on public websites are frequently obfuscated to defeat scrapers (for example info@remove-this.example.com, kontakt@nospam.example.de, name (at) example [dot] de): reconstruct the real address by removing anti-harvest tokens such as remove-this., removethis., remove., nospam., no-spam., kein-spam., delete-this., antispam. from the domain and local part and by decoding textual separators ( (at)/[at]/ AT to @ and (dot)/[dot]/ DOT to .). The emitted domain must be a real registrable domain — never keep a fabricated label like remove-this. or nospam. as part of it; only emit an email you can confidently reconstruct into a valid address, otherwise omit it. A partner, client, customer, supplier, reseller, distributor, or any third party merely mentioned or credited on the page (for example after "in partnership with", "operated in partnership with", "powered by", "a partner of", "client:", "reseller of", "distributor for") is NOT the operating entity of this site and must never be returned as companyName; the operating entity is the one that owns this domain and is named as owner/operator in its own impressum/legal notice/footer, so when the only legal-form name on the page belongs to such a third party whose brand does not match this domain, leave companyName empty with entityScope "uncertain". companyName must be a human-readable brand or legal entity name, never the bare domain string: never return the domain with its TLD or in all caps (for example never "QUBBERVISION.COM", "EXAMPLE.COM", or "example.com") as companyName. When the only available name is the domain, use its clean brand form without the TLD and in normal capitalisation (for example "Qubber", not "QUBBERVISION.COM"), and always prefer any real brand or legal entity evident elsewhere on the page (logo, header, site title, impressum, or footer) over the domain token. Always extract the operating entity's full postal address exactly as written in the impressum, legal notice, contact, or footer evidence: the street name and number, the postal/ZIP code, the city or town, and the state or region when shown. Whenever a street line or a postal code appears anywhere in the evidence, you MUST populate address, city, and zip from it — never leave city or zip empty and return only the country when the evidence contains them. Never infer, guess, or invent an address, city, or postal code that is not present in the evidence. Return strict JSON with {"companyName":"...","entityScope":"exact_operating_entity|parent_group|brand_or_product|uncertain","searchAliases":["..."],"address":"...","city":"...","zip":"...","state":"...","country":"...","emails":["..."],"phones":["..."],"followUpUrls":["https://..."]}. Use empty strings or empty arrays when unknown.`
        },
        {
          role: "user",
          content: [
            `Company: ${company.name}`,
            company.domain ? `Domain: ${company.domain}` : undefined,
            company.country ? `Country: ${company.country}` : undefined,
            `Homepage URL: ${homepage.url}`,
            `Homepage evidence: ${homepage.evidenceSnippet}`,
            `Candidate links JSON: ${JSON.stringify(homepage.candidateLinks.slice(0, 30))}`
          ].filter(Boolean).join("\n\n")
        }
      ], { maxTokens: 600 });

      const parsed = this.parseJsonObject<{
        companyName?: string;
        entityScope?: string;
        searchAliases?: string[];
        address?: string;
        city?: string;
        zip?: string;
        state?: string;
        country?: string;
        emails?: string[];
        phones?: string[];
        followUpUrls?: string[];
      }>(content);

      const normalizedEntityScope = (() => {
        switch (parsed.entityScope?.trim().toLowerCase()) {
          case "exact_operating_entity":
          case "parent_group":
          case "brand_or_product":
          case "uncertain":
            return parsed.entityScope.trim().toLowerCase() as "exact_operating_entity" | "parent_group" | "brand_or_product" | "uncertain";
          default:
            return undefined;
        }
      })();

      return {
        companyName: parsed.companyName?.trim(),
        entityScope: normalizedEntityScope,
        searchAliases: Array.from(new Set((parsed.searchAliases ?? []).map((value) => value.trim()).filter(Boolean))).slice(0, 4),
        address: parsed.address?.trim(),
        city: parsed.city?.trim(),
        zip: parsed.zip?.trim(),
        state: parsed.state?.trim(),
        country: parsed.country?.trim(),
        emails: Array.from(new Set((parsed.emails ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))),
        phones: Array.from(new Set((parsed.phones ?? []).map((value) => value.trim()).filter(Boolean))),
        followUpUrls: Array.from(new Set((parsed.followUpUrls ?? []).map((value) => value.trim()).filter(Boolean))).slice(0, 5)
      };
    } catch {
      return null;
    }
  }

  async extractCompanyProfileFromWebsiteEvidence(
    company: Pick<PreCategorizedCompany, "name" | "domain" | "country" | "category">,
    pages: Array<{
      url: string;
      evidenceSnippet: string;
      emails?: string[];
      phones?: string[];
      linkedInProfileUrl?: string;
      namedContacts?: unknown[];
    }>,
    dryRun: boolean
  ): Promise<{
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
  } | null> {
    if (dryRun || !readiness.azureConfigured || pages.length === 0) {
      return null;
    }

    try {
      const content = await this.runChat([
        {
          role: "system",
          content: `${buildMainContextBlock(undefined)}\n\nTask: Consolidate organization-level company information from official website evidence only. Use the supplied homepage and follow-up pages to extract the exact legal operating entity for the supplied domain, the postal address, shared company inboxes, main switchboard phone numbers, and company LinkedIn page URLs. Prefer impressum/legal notice/contact/footer evidence over marketing copy. The legal entity named in this website's own impressum, legal notice, or contact/footer block is the operating entity for this website: return it as companyName with entityScope "exact_operating_entity" even when its registered name differs from the public brand, the person operating the site, or the domain label. Only withhold the name (leaving companyName empty with the matching entityScope) when the evidence shows it belongs to a separate parent group, holding company, umbrella brand, or an unrelated third-party brand rather than the operator of this site. A company name shown with a legal form in this website's own footer, copyright line, header, logo block, or impressum — for example "© 2026 Example Co.,Ltd.", "Example GmbH", "Example Inc.", "Example S.A.", "Example Ltd." — is this site's exact operating entity: return it as companyName with entityScope "exact_operating_entity" unless the evidence clearly shows it is a separate parent group or unrelated brand. Exception: a footer credit, copyright line, or "created/realised/designed/developed by", "réalisé par", "site by", "webdesign by", "powered by" attribution that names the web design or web development AGENCY that built the site — recognisable because it usually links to a DIFFERENT external domain than this site and/or sits next to such wording — is NOT the operating entity; ignore that agency name and instead use the entity named as the owner/operator in the impressum or legal notice ("Propriétaire", "Inhaber", "Betreiber", "Herausgeber", "Owner", e.g. a "SAS"/"SARL"/"GmbH" company) as the exact operating entity. The supplied Country is an unverified hint that may be wrong; determine the country from this website's own evidence (registered office, "headquartered in" statements, impressum or postal address, or the international phone dialing code such as +49 Germany, +972 Israel, +82 South Korea, +86 China) and return that country, only falling back to the hint when the website gives no country evidence. A natural person's name listed as the site operator's representative, owner, proprietor, or managing director — for example the name following "Vertreten durch", "Vertretungsberechtigt", "Inhaber", "Inhaberin", "Geschäftsführer", "Geschäftsführerin", "Owner", "Proprietor", "Represented by", "Managing Director", "CEO", or "Founder" in an impressum or legal notice — is the human REPRESENTATIVE of the business, NOT the company name: never return a bare personal name (a given name plus surname with no legal form and no brand word, e.g. "Anton Lytvynenko") as companyName. When the operator is a sole proprietorship / Einzelunternehmen whose only named entity is a person, set companyName to the business's trading or brand name instead — the name under which it actually operates, taken from the logo, header, site title, or domain label (e.g. "ki-aktiv") — with entityScope "exact_operating_entity"; if no trading or brand name is evident anywhere in the evidence, leave companyName empty and set entityScope "uncertain" rather than returning the person's name. When the evidence is genuinely ambiguous, leave companyName empty and set entityScope accordingly. Also produce searchAliases: 1 to 4 short, search-friendly names for the exact operating entity that a recruiter could type to find this company's employees on LinkedIn. Include only the legal entity name, its brand or short form, and the domain token. searchAliases must never contain call-to-action, marketing, slogan, navigation, menu, button, or heading phrases (for example "Nehmen Sie Kontakt", "Learn More", "Mehr erfahren", "Contact us"), and never a parent group or unrelated brand. If you are unsure, return only the domain token. Do not include personal data and do not invent values. Email addresses on public websites are frequently obfuscated to defeat scrapers (for example info@remove-this.example.com, kontakt@nospam.example.de, name (at) example [dot] de): reconstruct the real address by removing anti-harvest tokens such as remove-this., removethis., remove., nospam., no-spam., kein-spam., delete-this., antispam. from the domain and local part and by decoding textual separators ( (at)/[at]/ AT to @ and (dot)/[dot]/ DOT to .). The emitted domain must be a real registrable domain — never keep a fabricated label like remove-this. or nospam. as part of it; only emit an email you can confidently reconstruct into a valid address, otherwise omit it. A partner, client, customer, supplier, reseller, distributor, or any third party merely mentioned or credited on the page (for example after "in partnership with", "operated in partnership with", "powered by", "a partner of", "client:", "reseller of", "distributor for") is NOT the operating entity of this site and must never be returned as companyName; the operating entity is the one that owns this domain and is named as owner/operator in its own impressum/legal notice/footer, so when the only legal-form name on the page belongs to such a third party whose brand does not match this domain, leave companyName empty with entityScope "uncertain". companyName must be a human-readable brand or legal entity name, never the bare domain string: never return the domain with its TLD or in all caps (for example never "QUBBERVISION.COM", "EXAMPLE.COM", or "example.com") as companyName. When the only available name is the domain, use its clean brand form without the TLD and in normal capitalisation (for example "Qubber", not "QUBBERVISION.COM"), and always prefer any real brand or legal entity evident elsewhere on the page (logo, header, site title, impressum, or footer) over the domain token. Always extract the operating entity's full postal address exactly as written in the impressum, legal notice, contact, or footer evidence: the street name and number, the postal/ZIP code, the city or town, and the state or region when shown. Whenever a street line or a postal code appears anywhere in the evidence, you MUST populate address, city, and zip from it — never leave city or zip empty and return only the country when the evidence contains them. Never infer, guess, or invent an address, city, or postal code that is not present in the evidence. Return strict JSON with {"companyName":"...","entityScope":"exact_operating_entity|parent_group|brand_or_product|uncertain","searchAliases":["..."],"address":"...","city":"...","zip":"...","state":"...","country":"...","emails":["..."],"phones":["..."],"linkedInUrls":["https://..."]}. Use empty strings or arrays when unknown.`
        },
        {
          role: "user",
          content: [
            `Company: ${company.name}`,
            company.domain ? `Domain: ${company.domain}` : undefined,
            company.country ? `Country: ${company.country}` : undefined,
            `Official website evidence JSON: ${JSON.stringify(pages.slice(0, 6))}`
          ].filter(Boolean).join("\n\n")
        }
      ], { maxTokens: 900 });

      const parsed = this.parseJsonObject<{
        companyName?: string;
        entityScope?: string;
        searchAliases?: string[];
        address?: string;
        city?: string;
        zip?: string;
        state?: string;
        country?: string;
        emails?: string[];
        phones?: string[];
        linkedInUrls?: string[];
      }>(content);

      const normalizedEntityScope = (() => {
        switch (parsed.entityScope?.trim().toLowerCase()) {
          case "exact_operating_entity":
          case "parent_group":
          case "brand_or_product":
          case "uncertain":
            return parsed.entityScope.trim().toLowerCase() as "exact_operating_entity" | "parent_group" | "brand_or_product" | "uncertain";
          default:
            return undefined;
        }
      })();

      return {
        companyName: parsed.companyName?.trim(),
        entityScope: normalizedEntityScope,
        searchAliases: Array.from(new Set((parsed.searchAliases ?? []).map((value) => value.trim()).filter(Boolean))).slice(0, 4),
        address: parsed.address?.trim(),
        city: parsed.city?.trim(),
        zip: parsed.zip?.trim(),
        state: parsed.state?.trim(),
        country: parsed.country?.trim(),
        emails: Array.from(new Set((parsed.emails ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))),
        phones: Array.from(new Set((parsed.phones ?? []).map((value) => value.trim()).filter(Boolean))),
        linkedInUrls: Array.from(new Set((parsed.linkedInUrls ?? []).map((value) => value.trim()).filter(Boolean)))
      };
    } catch {
      return null;
    }
  }

  /**
   * Given a crawled page and all links found on it, ask Azure AI to select the URLs most
   * likely to contain named employees, management contacts, impressum, or team information.
   * Returns up to `maxLinks` URLs ordered by priority.
   */
  async selectLinksForCrawl(
    pageUrl: string,
    pageSnippet: string,
    candidateLinks: Array<{ url: string; anchorText: string }>,
    maxLinks: number,
    dryRun: boolean
  ): Promise<string[]> {
    if (dryRun || !readiness.azureConfigured || candidateLinks.length === 0) {
      return [];
    }

    try {
      const content = await this.runChat([
        {
          role: "system",
          content: [
            "You are a web crawl assistant for a B2B lead generation system.",
            "Your goal is to find pages that contain: named employees or managers, contact details (email/phone), impressum (legal notice), team or about-us pages.",
            "Given a crawled page URL, a short content snippet, and a list of candidate links with anchor texts, select up to " + maxLinks + " URLs most likely to reveal contact persons or the legal company entity.",
            "Prioritize in this order:",
            "1. Impressum / legal notice / imprint pages (contain the legal company name)",
            "2. Kontakt / contact / ansprechpartner pages (named contact persons, emails, phones)",
            "3. Team / über-uns / about / management / geschäftsführung pages",
            "4. Other pages with anchor texts suggesting named individuals or roles",
            "Exclude: product pages, news, blog, jobs, career, privacy, cookie, login, newsletter, shop, download, PDF links.",
            "Return strict JSON: {\"urls\": [\"https://...\", ...]}"
          ].join("\n")
        },
        {
          role: "user",
          content: [
            `Current page: ${pageUrl}`,
            `Page snippet: ${pageSnippet.slice(0, 800)}`,
            `Candidate links (${candidateLinks.length}): ${JSON.stringify(candidateLinks.slice(0, 40))}`
          ].join("\n\n")
        }
      ], { maxTokens: 400 });

      const parsed = this.parseJsonObject<{ urls?: unknown }>(content);
      if (!Array.isArray(parsed.urls)) {
        return [];
      }

      return (parsed.urls as unknown[])
        .filter((value): value is string => typeof value === "string" && value.startsWith("http"))
        .slice(0, maxLinks);
    } catch {
      return [];
    }
  }

  getUsageTotals(): AzureUsageCost {
    return { ...this.usageTotals };
  }

  async generateSuggestedFilters(
    market: string | undefined,
    customGoal: string | undefined,
    mainContext: string | undefined,
    searchStrategyContext: string | undefined,
    targetCategories: LeadCategory[] | undefined,
    baseFilters: OrganizationFilter[],
    dryRun: boolean,
    learning?: LeadLearningData
  ): Promise<OrganizationFilter[]> {
    const foundryFilters = await this.foundryAgentsClient.generateSuggestedFilters(
      market,
      customGoal,
      mainContext,
      searchStrategyContext,
      targetCategories,
      baseFilters,
      dryRun,
      learning
    );

    if (foundryFilters !== baseFilters) {
      return foundryFilters;
    }

    if (dryRun || !readiness.azureConfigured) {
      return baseFilters;
    }

    try {
      const content = await this.runChat(
        [
          {
            role: "system",
            content: [
              buildSearchStrategyContextBlock(searchStrategyContext, mainContext),
              "You are the Apollo Search Strategy Agent.",
              "Return strict JSON with {\"filters\":[...]}",
              "Produce 4 to 6 practical Apollo company filters for ONE WARE.",
              "Optimize for at least 50% relevant firms in the first 15-company sample.",
              "Relevant means Europe-first and a plausible ONE WARE target category.",
              "Prioritize Germany first, then strong European industrial regions.",
              "Model the positive archetype on delivery-led industrial software and automation firms with recurring project ownership.",
              "Keep wording concrete and close to the strongest service-led archetypes because Apollo is highly sensitive to small phrasing changes.",
              "Treat exclusions as equally important as inclusion terms.",
              "Avoid magazines, publishers, media portals, event businesses, associations, universities, research institutes, VCs, generic consultancies, recruiting, banks, insurers, China, Saudi Arabia, and direct AI platform competitors.",
              "Explicitly avoid hardware vendors, OEMs, publishers, media brands, and pure consultancies unless the operator context says otherwise.",
              "Prefer implementation-oriented software and automation service providers over product vendors or editorial/media brands.",
              "Do not use broad keywords like robotics or AI alone when they are likely to pull robot makers, OEMs, hardware vendors, investors, or magazines.",
              "Do not broaden with terms like AI solutions, manufacturing alone, or looser employee ranges when those changes risk generic AI or generic software-company results.",
              "Prefer concrete service-intent keywords such as project-based software integrator, system integrator, implementation, software services, engineering services, custom software, automation projects, machine vision, industrial inspection, image processing, embedded development, or solution provider.",
              "High-signal keyword families include AOI, automated optical inspection, inline inspection, optical quality control, industrial image processing, embedded computer vision, feasibility study, camera calibration, lighting optimization, MES integration, SCADA integration, PLC software integration, OT integration, smart factory software, and industrial software engineering.",
              "When a search theme is broad, split it into neighboring variants with one clear angle each instead of one generic umbrella filter.",
              "Keep industries, keywords, employee ranges, and locations realistic for Apollo."
            ].join(" ")
          },
          {
            role: "user",
            content: [
              market ? `Market focus: ${market}` : undefined,
              customGoal ? `Custom goal: ${customGoal}` : undefined,
              mainContext ? `Main context: ${mainContext}` : undefined,
              targetCategories?.length ? `Target categories: ${targetCategories.join(", ")}` : undefined,
              `Base filters JSON:\n${JSON.stringify(baseFilters)}`,
              this.buildLearningContextForSearchStrategy(learning)
            ]
              .filter(Boolean)
              .join("\n\n")
          }
        ],
        { maxTokens: 900 }
      );

      const parsed = this.parseJsonObject<{ filters?: OrganizationFilter[] }>(content);
      const filters = (parsed.filters ?? [])
        .map((filter) => this.normalizeOrganizationFilter(filter))
        .filter((filter): filter is OrganizationFilter => Boolean(filter));

      return filters.length > 0 ? filters : baseFilters;
    } catch {
      return baseFilters;
    }
  }

  async planExaSearchQueries(
    filter: OrganizationFilter,
    defaultQueries: string[],
    learning: LeadLearningData | undefined,
    dryRun: boolean,
    mainContext?: string,
    searchStrategyContext?: string,
    maxQueryCount = 3,
    options: {
      recentQueryHistory?: ExaQueryHistoryInsight[];
      prequalification?: PrequalificationConfig;
      excludedDomainExamples?: string[];
      requestedTargetCategories?: LeadCategory[];
      targetCategoryRefinement?: string;
      plannerTimeoutMs?: number;
      debugCapture?: (details: { promptMessages: Array<{ role: "system" | "user"; content: string }> }) => void;
    } = {}
  ): Promise<string[]> {
    const targetQueryCount = Math.max(1, maxQueryCount);
    const baselineQueries = Array.from(new Set(defaultQueries.map((query) => query.trim()).filter(Boolean))).slice(0, targetQueryCount);
    if (baselineQueries.length === 0) {
      return [];
    }

    if (!readiness.azureConfigured) {
      throw new Error("Exa query planner requires Azure AI to be configured.");
    }

    const requestedLocalities = Array.from(new Set((filter.locations ?? []).map((location) => location.trim()).filter(Boolean)));
    const requestedCategories = Array.from(new Set((options.requestedTargetCategories ?? filter.targetCategories ?? []).map((category) => category.trim()).filter(Boolean)));
    const recentQueryHistory = (options.recentQueryHistory ?? [])
      .filter((entry) => entry?.query?.trim())
      .slice(0, 50);
    const exaLearning = learning?.searchHistoryByMode?.exa_search?.searchHistory ?? [];
    const goodSignalsContext = this.buildExaSearchGoodSignalsContext(options.prequalification, requestedCategories as LeadCategory[]);
    const avoidSignalsContext = this.buildExaSearchAvoidSignalsContext(options.prequalification, requestedCategories as LeadCategory[]);
    const recentExaContext = this.buildExaSearchPerformanceSummary(exaLearning);
    const excludedDomainExamples = Array.from(new Set((options.excludedDomainExamples ?? []).map((domain) => domain.trim().toLowerCase()).filter(Boolean))).slice(0, 30);
    const forbiddenBroadeningTerms = this.getPlannerForbiddenBroadeningTerms(requestedLocalities);

    const promptMessages: Array<{ role: "system" | "user"; content: string }> = [
      {
        role: "system",
        content: this.buildExaPlannerSystemPrompt(mainContext, searchStrategyContext, targetQueryCount, requestedLocalities, forbiddenBroadeningTerms)
      },
      {
        role: "user",
        content: this.buildExaPlannerUserPrompt(
          filter,
          requestedLocalities,
          requestedCategories as LeadCategory[],
          options.targetCategoryRefinement,
          goodSignalsContext,
          avoidSignalsContext,
          baselineQueries,
          recentQueryHistory,
          recentExaContext,
          excludedDomainExamples,
          targetQueryCount,
          forbiddenBroadeningTerms
        )
      }
    ];
    options.debugCapture?.({ promptMessages });
    const plannerTimeoutMs = Math.max(1, options.plannerTimeoutMs ?? EXA_QUERY_PLANNER_TIMEOUT_MS);

    const content = await this.runChatWithTimeout(
      promptMessages,
      { maxTokens: 4000 },
      plannerTimeoutMs,
      "Exa query planner"
    );

    const parsed = this.parseJsonObject<{
      queries?: string[];
      error?: string;
      constraintCheck?: {
        requiredLocalities?: string[];
        allQueriesPreserveLocality?: boolean;
        forbiddenBroadeningTermsPresent?: boolean;
        preservedLocalitiesByQuery?: Array<{ query?: string; preservedLocalities?: string[] }>;
      };
    }>(content);
    const initialQueries = this.validateExaPlannerQueries(
      parsed,
      requestedLocalities,
      forbiddenBroadeningTerms,
      targetQueryCount,
      "Exa query planner"
    );

    if (initialQueries.length > 1 && this.exaQueriesNeedDiversification(initialQueries, requestedLocalities, baselineQueries)) {
      const rewrittenContent = await this.runChatWithTimeout(
        [
          promptMessages[0],
          {
            role: "user",
            content: this.buildExaPlannerDiversityRewritePrompt(
              filter,
              requestedLocalities,
              requestedCategories as LeadCategory[],
              baselineQueries,
              recentQueryHistory,
              excludedDomainExamples,
              initialQueries,
              targetQueryCount,
              forbiddenBroadeningTerms
            )
          }
        ],
        { maxTokens: 4000 },
        plannerTimeoutMs,
        "Exa query planner diversity rewrite"
      );

      const rewrittenParsed = this.parseJsonObject<{
        queries?: string[];
        error?: string;
        constraintCheck?: {
          requiredLocalities?: string[];
          allQueriesPreserveLocality?: boolean;
          forbiddenBroadeningTermsPresent?: boolean;
          preservedLocalitiesByQuery?: Array<{ query?: string; preservedLocalities?: string[] }>;
        };
      }>(rewrittenContent);
      return this.validateExaPlannerQueries(
        rewrittenParsed,
        requestedLocalities,
        forbiddenBroadeningTerms,
        targetQueryCount,
        "Exa query planner diversity rewrite"
      );
    }

    return initialQueries;
  }

  private validateExaPlannerQueries(
    response: {
      queries?: string[];
      error?: string;
      constraintCheck?: {
        requiredLocalities?: string[];
        allQueriesPreserveLocality?: boolean;
        forbiddenBroadeningTermsPresent?: boolean;
        preservedLocalitiesByQuery?: Array<{ query?: string; preservedLocalities?: string[] }>;
      };
    },
    requestedLocalities: string[],
    forbiddenBroadeningTerms: string[],
    targetQueryCount: number,
    label: string
  ): string[] {
    if (response.error?.trim()) {
      throw new Error(`${label} returned error: ${response.error.trim()}`);
    }

    if (response.constraintCheck?.allQueriesPreserveLocality === false) {
      throw new Error(`${label} returned queries that violate locality constraints.`);
    }

    if (response.constraintCheck?.forbiddenBroadeningTermsPresent) {
      throw new Error(`${label} returned broadened queries outside the requested locality.`);
    }

    const queries = Array.from(new Set((response.queries ?? []).map((query) => query.trim()).filter(Boolean)));
    if (queries.length !== targetQueryCount) {
      throw new Error(`${label} returned ${queries.length} queries, expected exactly ${targetQueryCount}.`);
    }

    const normalizedLocalities = Array.from(new Set(requestedLocalities.map((value) => this.normalizePlannerPhrase(value)).filter(Boolean)));
    for (const query of queries) {
      const normalizedQuery = this.normalizePlannerPhrase(query);
      if (normalizedLocalities.length > 0 && !normalizedLocalities.some((locality) => this.normalizedPlannerPhraseIncludes(normalizedQuery, locality))) {
        throw new Error(`${label} returned a query without the required locality: ${query}`);
      }

      const forbiddenTerm = forbiddenBroadeningTerms.find((term) => this.normalizedPlannerPhraseIncludes(normalizedQuery, term));
      if (forbiddenTerm) {
        throw new Error(`${label} returned a query with forbidden broadening term '${forbiddenTerm}': ${query}`);
      }
    }

    return queries;
  }

  private getPlannerForbiddenBroadeningTerms(requestedLocalities: string[]): string[] {
    const normalizedRequestedLocalities = new Set(requestedLocalities.map((value) => this.normalizePlannerPhrase(value)).filter(Boolean));
    const candidates = [
      "europe",
      "european",
      "eu",
      "emea",
      "dach",
      "global",
      "worldwide",
      "international"
    ];

    return candidates
      .map((value) => this.normalizePlannerPhrase(value))
      .filter((value) => value && !normalizedRequestedLocalities.has(value));
  }

  private normalizePlannerPhrase(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private normalizedPlannerPhraseIncludes(normalizedHaystack: string, normalizedNeedle: string): boolean {
    return ` ${normalizedHaystack} `.includes(` ${normalizedNeedle} `);
  }


  private getPlannerPrimaryLocality(requestedLocalities: string[]): string {
    return requestedLocalities.map((value) => value.trim()).find(Boolean) ?? "Europe";
  }

  private buildPlannerGeographyAngleExamples(requestedLocalities: string[]): string[] {
    const primaryLocality = this.getPlannerPrimaryLocality(requestedLocalities);
    const normalizedPrimaryLocality = this.normalizePlannerPhrase(primaryLocality);

    if (normalizedPrimaryLocality === "germany") {
      return [
        "* Germany nationwide",
        "* DACH",
        "* NRW / Ruhr",
        "* OWL",
        "* Bavaria / Munich",
        "* Baden-Wuerttemberg / Stuttgart",
        "* Hamburg / Northern Germany",
        "* Benelux",
        "* Nordics",
        "* another relevant Europe-first cluster if it stays inside the target geography"
      ];
    }

    if (normalizedPrimaryLocality === "europe") {
      return [
        "* Europe-wide",
        "* France",
        "* DACH",
        "* Benelux",
        "* Nordics",
        "* Italy / Northern Italy",
        "* Iberia",
        "* Central Europe",
        "* a single-country angle that stays inside Europe",
        "* another relevant Europe-first cluster that still stays inside Europe"
      ];
    }

    return [
      `* ${primaryLocality} nationwide`,
      `* capital-region angle inside ${primaryLocality}`,
      `* northern ${primaryLocality}`,
      `* southern ${primaryLocality}`,
      `* a major industrial cluster inside ${primaryLocality}`,
      `* another relevant sub-region that still stays inside ${primaryLocality}`
    ];
  }

  private buildPlannerAngleVariationExamples(requestedLocalities: string[]): {
    integrator: string[];
    machineBuilder: string[];
    cameraManufacturer: string[];
    nonIndustrial: string[];
  } {
    const primaryLocality = this.getPlannerPrimaryLocality(requestedLocalities);
    const normalizedPrimaryLocality = this.normalizePlannerPhrase(primaryLocality);

    if (normalizedPrimaryLocality === "germany") {
      return {
        integrator: [
          "* Germany official company websites of computer vision and industrial image processing service providers focused on quality control, defect detection, and production-line inspection, with customer-specific implementation or deployment work - not camera manufacturers, imaging component suppliers, hardware resellers, factories, industrial end customers, directories, marketplaces, job boards, news articles, PDFs, or irrelevant content pages.",
          "* Germany official company websites of OWL, NRW, or Ruhr-area automation integrators delivering machine vision, PLC or SCADA integration, OT connectivity, and inspection-related software projects for customers - not machine builders, OEM equipment vendors, camera hardware sellers, measurement-only specialists, staffing agencies, directories, marketplaces, job boards, news pages, PDFs, or irrelevant content pages.",
          "* Germany official company websites of Bavaria or Munich-area AI engineering boutiques implementing embedded vision, edge AI, inspection AI, or hardware-efficient computer vision models for customer projects, with hands-on deployment work - not generic AI advisory firms, training-only providers, staffing marketplaces, SaaS vendors, directories, job boards, news articles, PDFs, or irrelevant content pages."
        ],
        machineBuilder: [
          "* Germany official company websites of AOI system manufacturers, automated optical inspection machine companies, or inline vision quality-control equipment OEMs where machine vision or optical inspection IS the core product they sell — not general machine builders that could add Vision AI as a side option, not service-led automation integrators, not camera component distributors, not directories, marketplaces, job boards, news articles, PDFs, or irrelevant content pages.",
          "* DACH official company websites of companies that ship their own visual inspection machines, LiDAR sensing systems, 3D measurement systems, or industrial camera-based quality-control systems as a primary product to industrial customers — not automation consultancies, not generic Sondermaschinenbau without a vision-primary product, not staffing firms, not directories, marketplaces, job boards, news articles, PDFs, or irrelevant content pages."
        ],
        cameraManufacturer: [
          "* Germany official company websites of camera manufacturers, imaging module vendors, or machine-vision hardware companies that sell camera systems into technical applications and could benefit from AI-ready model generation or edge vision capabilities - not generic distributors, resellers without product control, job boards, directories, marketplaces, news articles, PDFs, or irrelevant content pages."
        ],
        nonIndustrial: [
          "* Germany official company websites of drone technology companies delivering autonomous inspection, camera-based perception, mapping, or edge AI workflows with real product deployment or customer implementation - not hobby drone shops, training providers, directories, marketplaces, job boards, news articles, PDFs, or irrelevant content pages.",
          "* Germany official company websites of medtech imaging or medical device companies using computer vision, image analysis, embedded AI, or AI-assisted inspection workflows with productization or deployment ownership - not hospitals, academic labs without commercial product path, directories, marketplaces, job boards, news articles, PDFs, or irrelevant content pages."
        ]
      };
    }

    if (normalizedPrimaryLocality === "europe") {
      return {
        integrator: [
          "* France official company websites of computer vision and industrial image processing service providers focused on quality control, defect detection, and production-line inspection, with customer-specific implementation or deployment work - not camera manufacturers, imaging component suppliers, hardware resellers, factories, industrial end customers, directories, marketplaces, job boards, news articles, PDFs, or irrelevant content pages.",
          "* Benelux official company websites of automation integrators delivering machine vision, PLC or SCADA integration, OT connectivity, and inspection-related software projects for customers - not machine builders, OEM equipment vendors, camera hardware sellers, measurement-only specialists, staffing agencies, directories, marketplaces, job boards, news pages, PDFs, or irrelevant content pages.",
          "* Nordics official company websites of AI engineering boutiques implementing embedded vision, edge AI, inspection AI, or hardware-efficient computer vision models for customer projects, with hands-on deployment work - not generic AI advisory firms, training-only providers, staffing marketplaces, SaaS vendors, directories, job boards, news articles, PDFs, or irrelevant content pages."
        ],
        machineBuilder: [
          "* DACH official company websites of AOI system manufacturers, automated optical inspection machine companies, or inline vision quality-control equipment OEMs where machine vision or optical inspection IS the core product they sell — not general machine builders that could add Vision AI as a side option, not service-led automation integrators, not camera component distributors, not directories, marketplaces, job boards, news articles, PDFs, or irrelevant content pages.",
          "* Italy or Spain official company websites of companies that ship their own visual inspection machines, 3D measurement systems, or industrial camera-based quality-control products as a primary offering — not automation consultancies, not generic machine builders without a vision-primary product, not staffing firms, not directories, marketplaces, job boards, news articles, PDFs, or irrelevant content pages."
        ],
        cameraManufacturer: [
          "* Europe official company websites of camera manufacturers, imaging module vendors, or machine-vision hardware companies that sell camera systems into technical applications and could benefit from AI-ready model generation or edge vision capabilities - not generic distributors, resellers without product control, job boards, directories, marketplaces, news articles, PDFs, or irrelevant content pages."
        ],
        nonIndustrial: [
          "* Europe official company websites of drone technology companies delivering autonomous inspection, camera-based perception, mapping, or edge AI workflows with real product deployment or customer implementation - not hobby drone shops, training providers, directories, marketplaces, job boards, news articles, PDFs, or irrelevant content pages.",
          "* Europe official company websites of medtech imaging or medical device companies using computer vision, image analysis, embedded AI, or AI-assisted inspection workflows with productization or deployment ownership - not hospitals, academic labs without commercial product path, directories, marketplaces, job boards, news articles, PDFs, or irrelevant content pages."
        ]
      };
    }

    return {
      integrator: [
        `* ${primaryLocality} official company websites of computer vision and industrial image processing service providers focused on quality control, defect detection, and production-line inspection, with customer-specific implementation or deployment work - not camera manufacturers, imaging component suppliers, hardware resellers, factories, industrial end customers, directories, marketplaces, job boards, news articles, PDFs, or irrelevant content pages.`,
        `* ${primaryLocality} official company websites of automation integrators delivering machine vision, PLC or SCADA integration, OT connectivity, and inspection-related software projects for customers - not machine builders, OEM equipment vendors, camera hardware sellers, measurement-only specialists, staffing agencies, directories, marketplaces, job boards, news pages, PDFs, or irrelevant content pages.`,
        `* ${primaryLocality} official company websites of AI engineering boutiques implementing embedded vision, edge AI, inspection AI, or hardware-efficient computer vision models for customer projects, with hands-on deployment work - not generic AI advisory firms, training-only providers, staffing marketplaces, SaaS vendors, directories, job boards, news articles, PDFs, or irrelevant content pages.`
      ],
      machineBuilder: [
        `* ${primaryLocality} official company websites of AOI system manufacturers, automated optical inspection machine companies, or inline vision quality-control equipment OEMs where machine vision or optical inspection IS the core product they sell — not general machine builders that could add Vision AI as a side option, not service-led automation integrators, not camera component distributors, not directories, marketplaces, job boards, news articles, PDFs, or irrelevant content pages.`,
        `* ${primaryLocality} official company websites of companies that ship their own visual inspection machines, LiDAR sensing systems, 3D measurement systems, or industrial camera-based quality-control systems as a primary product to industrial customers — not automation consultancies, not generic OEMs without a vision-primary product, not staffing firms, not directories, marketplaces, job boards, news articles, PDFs, or irrelevant content pages.`
      ],
      cameraManufacturer: [
        `* ${primaryLocality} official company websites of camera manufacturers, imaging module vendors, or machine-vision hardware companies that sell camera systems into technical applications and could benefit from AI-ready model generation or edge vision capabilities - not generic distributors, resellers without product control, job boards, directories, marketplaces, news articles, PDFs, or irrelevant content pages.`
      ],
      nonIndustrial: [
        `* ${primaryLocality} official company websites of drone technology companies delivering autonomous inspection, camera-based perception, mapping, or edge AI workflows with real product deployment or customer implementation - not hobby drone shops, training providers, directories, marketplaces, job boards, news articles, PDFs, or irrelevant content pages.`,
        `* ${primaryLocality} official company websites of medtech imaging or medical device companies using computer vision, image analysis, embedded AI, or AI-assisted inspection workflows with productization or deployment ownership - not hospitals, academic labs without commercial product path, directories, marketplaces, job boards, news articles, PDFs, or irrelevant content pages.`
      ]
    };
  }

  private buildExaPlannerSystemPrompt(
    mainContext: string | undefined,
    searchStrategyContext: string | undefined,
    queryCount: number,
    requestedLocalities: string[],
    forbiddenBroadeningTerms: string[]
  ): string {
    const requiresLiteralGermany = requestedLocalities
      .map((value) => this.normalizePlannerPhrase(value))
      .includes("germany");
    const plannerOpeningExample = this.getPlannerPrimaryLocality(requestedLocalities);
    const geographyAngleExamples = this.buildPlannerGeographyAngleExamples(requestedLocalities);
    const angleVariationExamples = this.buildPlannerAngleVariationExamples(requestedLocalities);
    const queryExample = JSON.stringify({
      queries: Array.from({ length: Math.max(1, queryCount) }, (_, index) => `query ${index + 1}`),
      constraintCheck: {
        requiredLocalities: requestedLocalities,
        allQueriesPreserveLocality: true,
        forbiddenBroadeningTermsPresent: false,
        preservedLocalitiesByQuery: Array.from({ length: Math.max(1, queryCount) }, (_, index) => ({
          query: `query ${index + 1}`,
          preservedLocalities: requestedLocalities
        }))
      }
    });

    return [
      "You are the Exa Query Planner for ONE WARE.",
      "",
      "ONE WARE context:",
      "You represent ONE WARE GmbH only as strategic context for target selection.",
      mainContext?.trim()
        ? mainContext.trim()
        : "ONE WARE sells software that automatically creates production-ready Physical AI, Vision AI, and Edge AI models in minutes instead of months. The core business value is less trial and error, faster delivery, more predictable project timelines, smaller and more efficient models, lower development costs, local training options, open API access, and vendor-independent deployment.",
      "",
      "ONE WARE is useful for companies that need to create, deploy, adapt, or embed efficient AI models for real-world technical systems.",
      "Do not narrow ONE WARE too strongly to classic industrial manufacturing.",
      "Relevant fit can exist in industrial automation, machine vision, drones, robotics, medtech imaging, embedded vision, smart cameras, inspection systems, autonomous systems, edge devices, sensor-based applications, and other technical domains where Vision AI, Physical AI, or Edge AI must work reliably outside a pure software demo.",
      "",
      "Your job is not to sell ONE WARE.",
      "Your job is to create Exa company-discovery queries that find official company websites of relevant target companies.",
      "",
      "Hard constraints:",
      requestedLocalities.length > 0 ? `* Required localities: ${requestedLocalities.join(", ")}` : "* No locality provided.",
      requestedLocalities.length > 0 ? "* Every query must contain at least one exact required locality term verbatim." : "* Preserve the exact requested scope.",
      requestedLocalities.length > 0 ? "* Search explicitly only inside the required locality scope. Do not broaden to a parent region or wider market." : undefined,
      forbiddenBroadeningTerms.length > 0 ? `* Forbidden broadening terms unless explicitly requested in the locality list: ${forbiddenBroadeningTerms.join(", ")}.` : undefined,
      requiresLiteralGermany ? "* If the required locality is Germany, every query must literally contain Germany and must not replace it with Europe, European, DACH, EU, EMEA, global, worldwide, or international." : undefined,
      "* If you cannot satisfy all hard constraints, return an explicit planner error JSON and do not guess.",
      "",
      "Query-planning rules:",
      "",
      "* Do not write outreach, sales copy, personalization, email text, LinkedIn messages, or company-specific messaging.",
      "* Do not mention ONE WARE inside the search queries unless the user explicitly requests it.",
      "* Your only job is to create Exa company-discovery queries that help find official company websites matching the supplied target profile.",
      "* Keep the search intent close to the supplied ICP, filter, target categories, locations, industries, and avoid rules.",
      "* Prioritize concrete capability, ownership, productization, deployment, implementation, integration, or operational signals over generic AI wording.",
      "* Every query should make clear what kind of company should be found.",
      "* Every query should make clear what kind of company should not be found.",
      "* Every query should prefer official company websites.",
      "* Every query should explicitly ask for official company websites or official websites, not just companies in general.",
      "* Every query should aim for the official root domain or homepage of the company, not a subpage path.",
      "* Every query should avoid broad content results such as lists, news, PDFs, job pages, events, and directories.",
      "* Avoid results that are mainly documentation pages, blog posts, article pages, team pages, contact pages, product pages, support pages, investor pages, patent pages, academic paper pages, or other subpage-style results instead of the company's main website.",
      "* Every query should steer away from press pages, patents, academic pages, product brochures, trade-fair profiles, association member pages, investor pages, and other non-company targets.",
      "* Good queries should mention implementation, integration, deployment, project delivery, customer-specific engineering, production use cases, field deployment, embedded deployment, hardware-aware AI, or retained technical support.",
      "* Query wording should help Exa preselect companies before the later AI check.",
      "* Each query should already encode who is wanted, which use cases matter, which company types are unwanted, and which noisy result types should be excluded.",
      "* Avoid generic AI hype, startup lists, trend articles, directories, marketplaces, and companies that only publish thought leadership without evidence of implementation, productization, deployment, or customer value.",
      "",
      "Always-not-wanted result types:",
      "Unless the user explicitly asks for them, the following result types are never the goal:",
      "* directories",
      "* company databases",
      "* marketplaces",
      "* agency marketplaces",
      "* freelancer marketplaces",
      "* job boards",
      "* career pages",
      "* job ads",
      "* PDFs",
      "* brochures as standalone results",
      "* listicles",
      "* ranking pages",
      "* news articles",
      "* press releases",
      "* media pages",
      "* event pages",
      "* trade fair profile pages as final targets",
      "* expo catalog pages as final targets",
      "* association member listings as final targets",
      "* generic vendor pages without company fit",
      "* startup lists",
      "* funding announcements",
      "* investor pages",
      "* academic papers",
      "* university lab pages without commercial company path",
      "* research-only pages",
      "* training-only pages",
      "* workshop-only pages",
      "* pure thought-leadership content",
      "* blog posts without a clear company target",
      "* irrelevant content pages",
      "Always include a natural-language exclusion tail that blocks these noisy result types.",
      "Use wording such as: not directories, marketplaces, job boards, career pages, news articles, press releases, PDFs, trade fair profiles, listicles, academic pages, or irrelevant content pages.",
      "",
      "Common wrong-company types:",
      "The following company types often create false positives.",
      "Do not automatically exclude all of them in every run.",
      "Only exclude them when they are not part of the desired target categories for the current run.",
      "When they are not desired, explicitly name them in the query, not only in a generic exclusion tail.",
      "Potential wrong-company types to exclude when not desired:",
      "* pure component vendors",
      "* pure hardware sellers",
      "* camera manufacturers",
      "* imaging hardware vendors",
      "* machine-vision component suppliers",
      "* lighting suppliers",
      "* lens suppliers",
      "* sensor distributors",
      "* industrial PC sellers",
      "* embedded board vendors",
      "* robot manufacturers",
      "* drone shops",
      "* hardware resellers",
      "* distributors without own product or implementation ownership",
      "* machine builders",
      "* OEM equipment vendors",
      "* scanner vendors",
      "* inspection-station product companies",
      "* factories",
      "* plant operators",
      "* manufacturers running their own production",
      "* industrial end customers",
      "* generic SaaS platforms",
      "* workflow software suites",
      "* measurement and test software platforms",
      "* app ecosystems",
      "* tool environments",
      "* generic AI consultants",
      "* strategy consultancies",
      "* management consultancies",
      "* training providers",
      "* staffing agencies",
      "* contractor pools",
      "* freelancers or solo profiles when freelancers are not selected",
      "* agencies with no technical implementation evidence",
      "* pure product vendors without project delivery or productization path",
      "* direct competing AI-platform vendors when the target is a partner or customer profile",
      "",
      "Search strategy context:",
      searchStrategyContext?.trim()
        ? searchStrategyContext.trim()
        : "You are steering the search and qualification loop for ONE WARE.",
      "",
      "The queries you create are the first step in the pipeline:",
      "",
      "1. Exa finds candidate company websites.",
      "2. A later AI check qualifies those websites.",
      "3. A later research step goes deeper only on promising companies.",
      "",
      "That means Exa should already do as much preselection work as possible.",
      "Do not create broad, noisy queries that rely entirely on the later AI check.",
      "",
      "Targeting priorities:",
      "",
      "* Follow the target locations from the user input.",
      "* Follow the desired target categories exactly.",
      "* Follow the non-desired categories exactly.",
      "* Do not hardcode one permanent ICP. The supplied target categories and filter decide the ICP for this run.",
      "* Strong fit usually means the company has real delivery ownership, technical implementation capability, customer-specific projects, productization capability, or a plausible path to Vision AI, Edge AI, Physical AI, embedded AI, camera-based AI, sensor-based AI, or hardware-efficient model deployment.",
      "* Do not overfocus on classic industrial manufacturing unless the supplied filter explicitly requires it.",
      "* When the supplied filter is industrial, stay industrial.",
      "* When the supplied filter includes machine builders, OEMs, hardware partners, medtech, drones, robotics, platforms, end customers, or other non-integrator categories, treat those as valid targets and do not exclude them.",
      "* Prefer companies that build, integrate, deploy, customize, operate, or support AI-enabled technical solutions.",
      "* Prefer real implementation, deployment, productization, or operational ownership over advisory-only positioning.",
      "* Deprioritize finance, HR, recruiting, investors, generic consulting, pure resellers, generic SaaS products, and directory-like aggregator pages unless the supplied target profile explicitly says otherwise.",
      "",
      "Category handling rules:",
      "The user input contains automatically assembled category sections.",
      "Use those sections as the source of truth.",
      "",
      "You will receive:",
      "",
      "* Desired target categories for this run.",
      "* Non-desired selectable categories for this run.",
      "* Also avoid drifting into.",
      "* Good Signals.",
      "* Avoid.",
      "* Target-category disqualifiers.",
      "* Non-target categories to avoid.",
      "",
      "Rules:",
      "",
      "* Categories listed as desired are valid targets.",
      "* Categories listed as non-desired should be avoided.",
      "* Categories listed under also avoid drifting into should be avoided.",
      "* Do not exclude a category, vertical, or company type if it is listed as desired.",
      "* If a category appears in both desired and avoid-related text, the desired target category wins for this run.",
      "* Use avoid guidance only when it applies to categories that are not desired in this run.",
      "* Do not blindly copy avoid wording into every query.",
      "* Put avoid wording into a query only when it helps prevent likely wrong results for that specific search angle.",
      "* If machine builders are desired, do not write not machine builders or not OEMs.",
      "* If camera manufacturers are desired, do not write not camera manufacturers or not imaging hardware vendors.",
      "* If industrial end customers are desired, do not write not factories, not manufacturers, or not plant operators.",
      "* If software platforms are desired, do not write not software platforms, not workflow suites, or not tool environments.",
      "* If freelancers are desired, do not write not freelancers or not solo specialists.",
      "* If a vertical such as drones, robotics, medtech, embedded systems, surveillance, agriculture tech, automotive, or inspection systems is desired or clearly relevant to a desired category, do not exclude it.",
      "* Only avoid a vertical when it is outside the supplied target profile or the recent query history shows that it caused wrong-category drift.",
      "",
      "False-positive prevention:",
      "Each query must contain two kinds of exclusions:",
      "1. Noisy-result exclusions: always block directories, marketplaces, job boards, career pages, news, press, PDFs, trade fair pages, listicles, academic pages, and irrelevant content pages.",
      "2. Wrong-company exclusions: block the most likely non-target company types for that query, based on the current desired and non-desired categories.",
      "Do not use only this weak exclusion: Exclude directories, marketplaces, job boards, news articles, PDFs, and pure component manufacturers.",
      "That is not enough.",
      "Use stronger, angle-specific exclusions that explicitly name the wrong company types for that search route.",
      "When known excluded websites or already-covered domains are supplied in the user prompt, treat them as negative evidence and write queries that are less likely to retrieve those same sites or the same noisy company families again.",
      "",
      "Official-website preference:",
      "Every query should explicitly prefer or request official company websites.",
      "The goal is to find the company's own website, not third-party profiles.",
      "The preferred target is the company's root domain or homepage, not a deep link or subpage.",
      "Good wording: official company websites of..., find official websites for companies that..., prefer official company websites of...",
      "Weak wording: companies that provide..., find companies..., machine vision Germany.",
      "",
      "Avoid broad keyword stuffing:",
      "Do not create one huge synonym list that describes everything.",
      "Instead, write focused natural-language queries with one target company type, one or two capability families, one use-case angle, one delivery or ownership signal, one geography or cluster if useful, and a strong exclusion clause.",
      "",
      "Task:",
      `Your job is to create exactly ${queryCount} Exa company-discovery queries for ONE WARE.`,
      "",
      "These queries are for an AI/semantic search system, not a traditional keyword search engine.",
      "Write them as natural-language instructions for Exa to find official company websites.",
      "",
      "The queries should:",
      "",
      "* preserve the required locality terms,",
      "* stay inside the supplied target categories,",
      "* avoid the supplied non-target categories,",
      "* reflect the supplied filter context,",
      "* use the recent query history as evidence,",
      "* avoid exact or near-repeat queries,",
      "* deliberately test different search angles,",
      "* include explicit delivery, deployment, productization, or implementation signals,",
      "* include strong natural-language exclusions for the wrong companies,",
      "* and find official company websites, not broad content pages.",
      "",
      "Do not change the filter logic, qualification logic, target-category logic, or avoid-category logic.",
      "Preserve the ICP and target intent from the supplied filter.",
      "",
      "Most important rule: do not repeat old queries.",
      "You will receive recent query history with outcomes.",
      "Use that history as negative and positive evidence.",
      "",
      "Never copy an old query exactly.",
      "Do not return a query that is only a lightly rewritten version of an old query.",
      "Do not use the same sentence structure as an old query if the angle is essentially unchanged.",
      "Do not simply swap one synonym, one region, or one exclusion phrase and call it new.",
      `Do not repeat overused openings such as ${plannerOpeningExample} official company websites of machine vision system integrators unless the history clearly proves that wording is necessary and you substantially change the search angle.`,
      "",
      "Before writing the final queries, compare each new query against the old queries.",
      "A new query is acceptable only if it differs in at least two meaningful ways, such as:",
      "",
      "* different target company self-description,",
      "* different use case,",
      "* different region or cluster,",
      "* different capability family,",
      "* different delivery model,",
      "* different exclusion focus,",
      "* different discovery route into the ICP.",
      "",
      "If recent history shows an angle produced no useful results, do not retry the same angle unless you materially change the search route.",
      "If recent history shows drift into a wrong category, explicitly name that wrong category as something to avoid in the next relevant query, unless that category is desired in this run.",
      "",
      "Output:",
      "Return only strict JSON with this exact shape:",
      queryExample,
      "",
      `Return exactly ${queryCount} query strings.`,
      "Do not add explanations outside the JSON.",
      "Do not add markdown.",
      "Do not add comments.",
      "Do not include numbering inside the query strings.",
      "",
      "Query style:",
      "Write natural-language Exa queries.",
      "Think of them as detailed but readable work instructions for Exa.",
      "Do not write Boolean queries.",
      "Do not write keyword dumps.",
      "Do not write SEO-style search strings.",
      "Do not use site:, long quoted keyword packs, long OR chains, or large negative keyword blocks.",
      "Each query should usually be one detailed sentence.",
      "Queries should be more specific than a generic web search, but still natural enough for Exa semantic search.",
      "",
      "Each query should usually include:",
      "",
      "1. The required locality term.",
      "2. The target company type.",
      "3. The relevant capability, vertical, or use case.",
      "4. A delivery, deployment, productization, integration, implementation, or ownership phrase.",
      "5. A natural-language exclusion clause naming the most likely wrong company types for that angle.",
      "6. A noisy-result exclusion tail.",
      "",
      "Useful delivery and ownership phrases:",
      "",
      "* implementation ownership",
      "* customer-specific implementation",
      "* customer project delivery",
      "* integration work",
      "* production deployment",
      "* field deployment",
      "* embedded deployment",
      "* prototyping and deployment",
      "* retained engineering support",
      "* AI model deployment",
      "* system integration",
      "* productization",
      "* engineering services",
      "* hands-on technical delivery",
      "* hardware-aware AI deployment",
      "* model generation and deployment workflow",
      "",
      "Noisy-result exclusion tail:",
      "Every query must include a natural-language exclusion tail covering directories, marketplaces, job boards, news articles, PDFs, and irrelevant content pages.",
      "Also add category-specific exclusions where useful and allowed by the desired/non-desired category setup.",
      "",
      "Example tail:",
      "not directories, marketplaces, job boards, news articles, PDFs, or irrelevant content pages.",
      "",
      "Expanded example tail:",
      "not directories, marketplaces, job boards, news articles, PDFs, pure component vendors, resellers, or irrelevant content pages.",
      "",
      "Do not automatically include not hardware vendors, not machine builders, not camera manufacturers, not factories, or not software platforms.",
      "Only include those exclusions when the corresponding company type is not desired in this run.",
      "",
      "Critical query diversity requirement:",
      `The ${queryCount} queries must be different search probes inside the same target frame.`,
      "Do not produce near-duplicates that only swap one synonym.",
      "Each query should test a meaningfully different route to the same ICP while preserving the required locality and selected target categories.",
      "Treat each query as its own discovery probe, not as a paraphrase of the previous query.",
      "When multiple desired categories exist, distribute the queries across those categories instead of repeating the same hybrid company-type phrase in every query.",
      "Prefer one clear lead company archetype per query unless combining two desired archetypes is necessary for that specific search route.",
      "Across the full set, vary at least four of these dimensions: company self-description, capability family, use case, delivery model, deployment context, region, or exclusion focus.",
      "No more than two queries may share the same opening pattern, such as the same first company-type phrase or the same geography-led opening.",
      "If recent history overused one opening or synonym family, force new openings that enter through a different route into the ICP.",
      `Do not begin every query with ${plannerOpeningExample} official company websites of. Some queries should enter through capability, use case, delivery model, or region first, while still clearly asking Exa to find official company websites.`,
      "When queryCount allows it, spread the set across these probe types: company-type-led, capability-led, use-case-led, deployment-led, region-cluster-led, and service-shape-led.",
      "Those probe types are an internal planning checklist. Do not output the labels; just make the queries visibly different.",
      "If both integrators and freelancers are desired, dedicate separate queries to them instead of repeating the same integrator-and-freelancer pairing throughout the set.",
      "",
      "A good query set can vary across several of these dimensions:",
      "",
      "Capability angle:",
      "* MES implementation",
      "* SCADA integration",
      "* PLC software integration",
      "* OT integration",
      "* industrial software implementation",
      "* manufacturing software delivery",
      "* smart factory projects",
      "* machine vision",
      "* computer vision",
      "* industrial image processing",
      "* visual inspection",
      "* automated optical inspection / AOI",
      "* defect detection",
      "* quality inspection",
      "* edge AI vision",
      "* AI camera deployment",
      "* embedded vision",
      "* robotics perception",
      "* drone perception",
      "* autonomous inspection",
      "* medtech imaging",
      "* sensor-based AI",
      "* smart camera systems",
      "* hardware-efficient model deployment",
      "* Physical AI prototypes",
      "* AI-enabled device workflows",
      "",
      "Company self-description angle:",
      "* system integrator",
      "* automation software integrator",
      "* automation software service provider",
      "* industrial software engineering firm",
      "* manufacturing software implementation partner",
      "* AI engineering boutique",
      "* machine vision consultant",
      "* computer vision specialist",
      "* industrial image processing service provider",
      "* implementation partner",
      "* solo specialist or freelancer, only when freelancer is a selected target category",
      "* machine builder or OEM, only when machine-builder categories are selected",
      "* camera manufacturer or imaging hardware vendor, only when camera-manufacturer categories are selected",
      "* software platform or workflow tool provider, only when platform categories are selected",
      "* industrial end customer or manufacturer, only when end-customer categories are selected",
      "* drone technology provider, medtech imaging company, robotics company, embedded systems company, or smart-device company when such verticals fit the selected target categories",
      "",
      "Buyer, vertical, or use-case angle:",
      "* quality control",
      "* defect detection",
      "* production-line inspection",
      "* manufacturing software implementation",
      "* machine connectivity",
      "* OT data integration",
      "* factory automation",
      "* MES / SCADA / PLC project delivery",
      "* industrial AI prototypes",
      "* customer-specific deployment",
      "* inspection AI implementation",
      "* production software modernization",
      "* drone inspection",
      "* robotics perception",
      "* medical imaging workflows",
      "* embedded vision deployment",
      "* AI camera applications",
      "* sensor-based classification",
      "* autonomous system perception",
      "* device-side model deployment",
      "* hardware-constrained AI models",
      "",
      "Geography angle:",
      ...geographyAngleExamples,
      "",
      "Exclusion angle:",
      "Use exclusions dynamically based on the non-desired categories for this run.",
      "Possible exclusions include:",
      "* avoid camera manufacturers and imaging hardware vendors, only when not desired",
      "* avoid machine-vision component suppliers, only when not desired",
      "* avoid machine builders and OEM equipment vendors, only when not desired",
      "* avoid scanner vendors and inspection-station product companies, only when not desired",
      "* avoid factories, plant operators, manufacturers, and industrial end customers, only when not desired",
      "* avoid generic SaaS platforms and workflow software suites, only when not desired",
      "* avoid app ecosystems, installable tool environments, and measurement/test software platforms, only when not desired",
      "* avoid generic AI advisors and strategy consultancies",
      "* avoid training-only providers and thought-leadership-only firms",
      "* avoid staffing agencies, contractor pools, and freelancer marketplaces, unless freelancers are desired",
      "* avoid directories, marketplaces, job boards, news pages, PDFs, listicles, and irrelevant content pages",
      "",
      "Important:",
      "Queries should be detailed enough to steer Exa away from noisy results.",
      "A short query like Germany computer vision service providers for quality control is too weak.",
      "A strong query names the target company type, delivery model, use case, region where useful, and several non-target company types to avoid.",
      "",
      "Example of too-similar queries:",
      `* ${plannerOpeningExample} machine vision system integrators for industrial visual inspection...`,
      `* ${plannerOpeningExample} machine vision solution providers for industrial quality inspection...`,
      `* ${plannerOpeningExample} industrial image processing integrators for AOI...`,
      "",
      "These are too similar because they likely search the same result space.",
      "",
      "Example of acceptable angle variation when integrators are desired and machine builders, camera manufacturers, software platforms, and end customers are not desired:",
      ...angleVariationExamples.integrator,
      "",
      "Example of acceptable angle variation when machine builders are explicitly desired:",
      ...angleVariationExamples.machineBuilder,
      "",
      "Example of acceptable angle variation when camera manufacturers are explicitly desired:",
      ...angleVariationExamples.cameraManufacturer,
      "",
      "Example of acceptable angle variation when non-industrial technical verticals are desired:",
      ...angleVariationExamples.nonIndustrial,
      "",
      "The examples are not templates to copy exactly.",
      "They demonstrate the expected level of specificity: same ICP, different search angle, explicit ownership signal, concrete use case, useful region where relevant, and strong natural-language exclusions that do not conflict with selected target categories.",
      "A weak set repeats the same company type, same geography phrasing, and same use-case family with only light synonym swaps.",
      "A strong set deliberately spreads the six queries across different entry routes into the same target frame.",
      "",
      "Old-query avoidance:",
      "You will be given recent query history with outcomes.",
      "Treat these as queries that have already been tried.",
      "",
      `The final ${queryCount} queries must not be identical or near-identical to them.`,
      "When reading old queries, identify:",
      "* repeated opening phrases,",
      "* repeated target company descriptions,",
      "* repeated use cases,",
      "* repeated regions,",
      "* repeated synonym families,",
      "* repeated exclusion tails,",
      "* underperforming angles,",
      "* angles that caused wrong-category drift,",
      "* angles that produced at least one relevant result.",
      "",
      "Then create new queries that:",
      "* keep what worked,",
      "* avoid repeating what failed,",
      "* deliberately open new but still relevant search routes,",
      "* add clearer exclusions for wrong categories seen in history,",
      "* and never exclude categories that are desired in this run.",
      "",
      "Avoid rules:",
      "Use the automatically supplied Avoid, Target-category disqualifiers, and Non-target categories to avoid sections.",
      "Do not invent additional hard exclusions that conflict with desired categories.",
      "Do not globally exclude verticals such as drones, robotics, medtech, embedded systems, surveillance, agriculture tech, automotive, camera hardware, machine builders, software platforms, or industrial end customers.",
      "They may be valid when selected by the target categories.",
      "",
      "Always avoid noisy result types unless explicitly requested otherwise:",
      "* directories",
      "* marketplaces",
      "* job boards",
      "* PDFs",
      "* listicles",
      "* news articles",
      "* media pages",
      "* generic vendor pages",
      "* startup lists",
      "* funding announcements",
      "* event-only pages",
      "* training-only pages",
      "* pure thought-leadership content",
      "* irrelevant content pages",
      "",
      "Output reminder:",
      "Return only strict JSON.",
      `Return exactly ${queryCount} queries when successful.`,
      "Every query must be a detailed natural-language Exa search instruction.",
      "Every query must preserve the required locality term.",
      "Every query must stay only within the required locality scope.",
      "Every query must include explicit exclusions.",
      "Every query must avoid exact or near-exact repetition of recent query history.",
      "Every query must respect the selected target categories and must not exclude desired categories.",
      "Successful output shape:",
      queryExample,
      "Failure output shape:",
      JSON.stringify({
        queries: [],
        error: "locality_constraint_unsatisfied",
        constraintCheck: {
          requiredLocalities: requestedLocalities,
          allQueriesPreserveLocality: false,
          forbiddenBroadeningTermsPresent: true,
          preservedLocalitiesByQuery: []
        }
      })
    ].filter(Boolean).join("\n");
  }

  private buildExaPlannerUserPrompt(
    filter: OrganizationFilter,
    requestedLocalities: string[],
    requestedCategories: LeadCategory[],
    targetCategoryRefinement: string | undefined,
    goodSignalsContext: string | undefined,
    avoidSignalsContext: string | undefined,
    baselineQueries: string[],
    recentQueryHistory: ExaQueryHistoryInsight[],
    recentExaContext: string | undefined,
    excludedDomainExamples: string[],
    queryCount: number,
    forbiddenBroadeningTerms: string[]
  ): string {
    const targetCategorySections = this.splitExaSearchAvoidSignalsContext(avoidSignalsContext);
    const queryPlaceholderExample = JSON.stringify({
      queries: Array.from({ length: Math.max(1, queryCount) }, () => "..."),
      constraintCheck: {
        requiredLocalities: requestedLocalities,
        allQueriesPreserveLocality: true,
        forbiddenBroadeningTermsPresent: false,
        preservedLocalitiesByQuery: Array.from({ length: Math.max(1, queryCount) }, () => ({ query: "...", preservedLocalities: requestedLocalities }))
      }
    });

    return [
      [
        "Target:",
        "This section defines the exact kind of companies you are trying to find.",
        requestedLocalities.length > 0 ? `* Required locality terms to preserve in every query: ${requestedLocalities.join(", ")}` : undefined,
        requestedLocalities.length > 0 ? `* Search only inside these required localities. Do not broaden beyond them: ${requestedLocalities.join(", ")}` : undefined,
        forbiddenBroadeningTerms.length > 0 ? `* Forbidden broadening terms for this run: ${forbiddenBroadeningTerms.join(", ")}` : undefined,
        requestedCategories.length > 0 ? `* Desired target categories for this run: ${requestedCategories.join(", ")}` : undefined,
        targetCategoryRefinement?.trim()
          ? [
              "* Additional narrowing instruction for this run:",
              "  Innerhalb der gesuchten Gruppen sollen ausschliesslich folgende gesucht werden:",
              `  ${targetCategoryRefinement.trim()}`
            ].join("\n")
          : undefined,
        this.buildExaSearchUndesiredCategorySummary(requestedCategories),
        "* Find official company websites for the intended target profile.",
        "* Prefer the official root domain or homepage for each company, not team pages, contact pages, docs pages, product pages, article pages, or other deep links.",
        "* Do not broaden the ICP beyond the supplied filter."
      ].filter(Boolean).join("\n"),
      this.buildExaSearchFilterNarrative(filter),
      [
        "Good Signals:",
        "Use this section to understand what a good target looks like before the later AI check happens.",
        goodSignalsContext
      ].filter(Boolean).join("\n\n"),
      [
        "Avoid:",
        "Use this section to understand what should be filtered out already at the query-writing stage whenever possible.",
        "* Avoid repeating recent openings, target descriptions, regions, or synonym families when they already underperformed.",
        "* If a recent angle produced no useful results, do not retry it unless the search route materially changes.",
        "* If recent history shows wrong-category drift, name that wrong company type explicitly as something to avoid when it is not a desired category in this run.",
        ...this.buildExaSearchCategorySpecificExclusionLines(requestedCategories),
        avoidSignalsContext ? avoidSignalsContext.split("\n").filter(Boolean) : []
      ].flat().filter(Boolean).join("\n") ,
      [
        "Target-category disqualifiers:",
        targetCategorySections.targetCategoryDisqualifiers ?? "None supplied."
      ].join("\n"),
      [
        "Non-target categories to avoid:",
        targetCategorySections.nonTargetCategoriesToAvoid ?? "None supplied."
      ].join("\n"),
      excludedDomainExamples.length > 0
        ? [
            "Search-surface saturation warning:",
            "The active Exa surface already excludes many root-domain families separately. Do not restate or target those same families again.",
            "A major failure mode is that too many results come back as the same companies on alternate subpages or deep links. Counter this by making the new queries visibly more different, more niche, and more specific in company type, capability, use case, deployment shape, and exclusion framing.",
            "Prefer fresh official root domains or homepages from new site families rather than alternate deep links of similar already-covered websites."
          ].join("\n")
        : undefined,
      [
        "Recent query history with outcomes:",
        `These are the last ${recentQueryHistory.length} queries, newest first.`,
        "These queries have already been tried.",
        "Do not repeat them exactly.",
        "Do not produce near-duplicates.",
        "Use them as evidence for what worked, what failed, and what caused category drift.",
        "Use this recent history to decide which synonym families, category angles, and regional variants have been overused or underused.",
        "",
        this.buildExaRecentQueryHistorySummary(recentQueryHistory)
      ].join("\n"),
      recentExaContext
        ? [
            "Recent Exa search history summary:",
            recentExaContext
          ].join("\n")
        : undefined,
      [
        "Final task:",
        `Create exactly ${queryCount} new Exa company-discovery queries.`,
        "",
        `The ${queryCount} queries must:`,
        "* preserve the required locality term in every query,",
        "* search explicitly only within the required locality scope,",
        "* avoid any forbidden broadening term for this run,",
        "* stay inside the supplied target profile,",
        "* avoid exact and near-duplicate versions of recent queries,",
        "* use different but still relevant search angles,",
        "* distribute the set across different company-type entry routes instead of repeating one hybrid archetype phrase,",
        "* use a visible mix of company-type-led, capability-led, use-case-led, deployment-led, region-led, and service-shape-led openings whenever the target profile allows it,",
        "* include clear ownership language,",
        "* include concrete use cases,",
        "* include strong natural-language exclusions,",
        "* not exclude any desired target category,",
        "* and return only official company website discovery queries aimed at company root domains/homepages rather than deep links.",
        "",
        "A weak set repeats the same opening, the same geography pattern, and the same core company type with light synonym changes.",
        "A strong set rotates openings, company self-descriptions, use-case families, and exclusion focus while preserving the same ICP.",
        "",
        `Baseline query angles to build on:\n${this.buildExaBaselineQuerySummary(baselineQueries)}`,
        "",
        "If you cannot satisfy the locality constraints exactly, return the failure JSON with error=locality_constraint_unsatisfied.",
        "",
        "Return only:",
        queryPlaceholderExample
      ].join("\n")
    ].filter(Boolean).join("\n\n");
  }

  private buildExaPlannerDiversityRewritePrompt(
    filter: OrganizationFilter,
    requestedLocalities: string[],
    requestedCategories: LeadCategory[],
    baselineQueries: string[],
    recentQueryHistory: ExaQueryHistoryInsight[],
    excludedDomainExamples: string[],
    draftQueries: string[],
    queryCount: number,
    forbiddenBroadeningTerms: string[]
  ): string {
    const probeTypes = [
      "1. company-type-led",
      "2. capability-led",
      "3. use-case-led",
      "4. deployment-led",
      "5. region-cluster-led",
      "6. service-shape-led"
    ].slice(0, Math.max(1, queryCount));
    const plannerOpeningExample = this.getPlannerPrimaryLocality(requestedLocalities);

    return [
      "Rewrite the draft Exa queries below because they are still too similar to each other.",
      "Keep the same ICP, locality intent, desired categories, and exclusion logic, but make the full set visibly more diverse.",
      "Do not explain the rewrite. Return only strict JSON.",
      "",
      "Non-negotiable rewrite rules:",
      "* Keep the same target profile and do not broaden the ICP.",
      "* Preserve the required locality intent in every query.",
      "* Search explicitly only inside the required locality scope.",
      forbiddenBroadeningTerms.length > 0 ? `* Do not use these forbidden broadening terms unless they are explicitly requested: ${forbiddenBroadeningTerms.join(", ")}.` : undefined,
      "* Do not copy any draft query or recent historical query too closely.",
      "* Do not let more than two queries share the same opening pattern.",
      "* Use the exact probe-type spread listed below. Make each query visibly feel like its assigned probe type.",
      `* At least half of the queries must avoid opening with ${plannerOpeningExample} official company websites of.`,
      "* Do not reuse any baseline query verbatim.",
      "* At most one query may keep the baseline-style companies that provide ... Prefer official company websites ... Exclude ... template.",
      "* At least four queries must explicitly ask for official company websites of a concrete company type and must name wrong-company exclusions before the noisy-result tail.",
      "* If integrators and freelancers are both desired, dedicate separate queries to them instead of repeating the same combined phrasing.",
      "* Keep explicit ownership, delivery, implementation, or deployment language in every query.",
      "* Keep strong natural-language exclusions, but do not exclude desired categories.",
      "",
      "Assigned probe types for the rewritten set:",
      ...probeTypes,
      "",
      `Required locality terms: ${requestedLocalities.join(", ") || "None supplied"}`,
      forbiddenBroadeningTerms.length > 0 ? `Forbidden broadening terms: ${forbiddenBroadeningTerms.join(", ")}` : undefined,
      `Desired target categories: ${requestedCategories.join(", ") || "None supplied"}`,
      `Filter: ${filter.name}`,
      "",
      `Baseline query angles to build on:\n${this.buildExaBaselineQuerySummary(baselineQueries)}`,
      "",
      `Recent query history with outcomes (last ${recentQueryHistory.length} queries, newest first):\n${this.buildExaRecentQueryHistorySummary(recentQueryHistory)}`,
      excludedDomainExamples.length > 0
        ? [
            "Search-surface saturation warning:",
            "Many root-domain families are already excluded separately in the active Exa surface.",
            "Do not rewrite the draft toward the same site families with alternate wording.",
            "Make the rewritten queries more niche and more visibly different so they reach fresh official root domains instead of similar companies on subpages or deep links."
          ].join("\n")
        : undefined,
      "",
      `Draft queries to rewrite:\n${draftQueries.map((query, index) => `${index + 1}. ${query}`).join("\n")}`,
      "",
      `Return only {\"queries\":[...],\"constraintCheck\":{...}} with exactly ${queryCount} rewritten query strings. If you cannot preserve locality exactly, return {\"queries\":[],\"error\":\"locality_constraint_unsatisfied\",\"constraintCheck\":{...}}.`
    ].filter(Boolean).join("\n");
  }

  private exaQueriesNeedDiversification(queries: string[], requestedLocalities: string[], baselineQueries: string[] = []): boolean {
    if (queries.length < 3) {
      return false;
    }

    const normalizedBaselineQueries = new Set(
      baselineQueries
        .map((query) => this.normalizeExaQueryTemplate(query))
        .filter(Boolean)
    );
    const baselineReuseCount = queries.reduce((count, query) => {
      return count + (normalizedBaselineQueries.has(this.normalizeExaQueryTemplate(query)) ? 1 : 0);
    }, 0);

    if (baselineReuseCount >= Math.max(2, Math.ceil(queries.length / 3))) {
      return true;
    }

    const stopWords = new Set([
      "a", "an", "and", "area", "areas", "articles", "based", "clear", "companies", "company", "content", "customer", "customers", "definitely", "delivery", "directories", "engineering", "exclude", "excluding", "exclusions", "find", "for", "from", "hands", "implementation", "in", "integrated", "integration", "irrelevant", "job", "jobs", "led", "marketplaces", "news", "not", "official", "or", "pages", "pdfs", "project", "projects", "providing", "quality", "query", "retained", "service", "services", "specific", "support", "system", "systems", "the", "their", "these", "through", "turnkey", "with", "websites"
    ]);
    const localityTokens = new Set(
      requestedLocalities
        .flatMap((value) => value.toLowerCase().split(/[^a-z0-9]+/i))
        .filter((token) => token.length > 1)
    );
    const contentTokensByQuery = queries.map((query) => this.extractExaDiversityTokens(query, stopWords, localityTokens));
    const openingFingerprints = queries.map((query) => this.buildExaQueryOpeningFingerprint(query, stopWords, localityTokens));
    const uniqueOpenings = new Set(openingFingerprints.filter(Boolean));

    if (uniqueOpenings.size <= Math.ceil(queries.length / 2)) {
      return true;
    }

    let highSimilarityPairs = 0;
    for (let index = 0; index < contentTokensByQuery.length; index += 1) {
      for (let compareIndex = index + 1; compareIndex < contentTokensByQuery.length; compareIndex += 1) {
        const left = contentTokensByQuery[index];
        const right = contentTokensByQuery[compareIndex];
        const intersectionSize = [...left].filter((token) => right.has(token)).length;
        const denominator = Math.max(left.size, right.size, 1);
        if (intersectionSize / denominator >= 0.6) {
          highSimilarityPairs += 1;
        }
      }
    }

    return highSimilarityPairs >= Math.max(2, queries.length - 2);
  }

  private buildExaQueryOpeningFingerprint(query: string, stopWords: Set<string>, localityTokens: Set<string>): string {
    return Array.from(this.extractExaDiversityTokens(query, stopWords, localityTokens)).slice(0, 5).join(" ");
  }

  private normalizeExaQueryTemplate(query: string): string {
    return query
      .toLowerCase()
      .replace(/germany|deutschland|dach|nrw|ruhr|owl|berlin|munich|bavaria|baden[-\s]?wuerttemberg|stuttgart|hamburg/gi, "<loc>")
      .replace(/quality control|visual quality inspection|inline inspection|defect detection|robot guidance|pick-and-place automation|optical inspection|camera-based production monitoring/gi, "<use_case>")
      .replace(/\s+/g, " ")
      .trim();
  }

  private extractExaDiversityTokens(query: string, stopWords: Set<string>, localityTokens: Set<string>): Set<string> {
    return new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length > 2 && !stopWords.has(token) && !localityTokens.has(token))
    );
  }

  private buildExaSearchGoodSignalsContext(
    prequalification: PrequalificationConfig | undefined,
    requestedCategories: LeadCategory[]
  ): string | undefined {
    const requestedSet = new Set(requestedCategories);
    const foundSections = Object.values(CATEGORY_PREQUALIFICATION_CONTEXT)
      .filter((context) => requestedSet.has(context.category) && context.category !== "irrelevant" && context.category !== "other")
      .map((context) => this.formatExaCategoryGoodSignals(context.category, prequalification));

    return foundSections.length > 0 ? foundSections.join("\n\n") : undefined;
  }

  private buildExaSearchAvoidSignalsContext(
    prequalification: PrequalificationConfig | undefined,
    requestedCategories: LeadCategory[]
  ): string | undefined {
    const requestedSet = new Set(requestedCategories);
    const requestedCategoryDisqualifiers = Object.values(CATEGORY_PREQUALIFICATION_CONTEXT)
      .filter((context) => requestedSet.has(context.category) && context.category !== "irrelevant" && context.category !== "other")
      .map((context) => this.formatExaCategoryTargetAvoidSignals(context.category, prequalification));
    const nonTargetSections = Object.values(CATEGORY_PREQUALIFICATION_CONTEXT)
      .filter((context) => !requestedSet.has(context.category))
      .map((context) => this.formatExaCategoryDriftAvoidSignals(context.category, prequalification));

    return [
      requestedCategoryDisqualifiers.length > 0 ? "Target-category disqualifiers:" : undefined,
      ...requestedCategoryDisqualifiers,
      nonTargetSections.length > 0 ? "Non-target categories to avoid:" : undefined,
      ...nonTargetSections
    ].filter(Boolean).join("\n\n");
  }

  private formatExaCategoryGoodSignals(category: LeadCategory, prequalification?: PrequalificationConfig): string {
    const baseContext = CATEGORY_PREQUALIFICATION_CONTEXT[category];
    const override = category !== "irrelevant" && category !== "other"
      ? prequalification?.categoryContexts?.[category as Exclude<LeadCategory, "irrelevant" | "other">]
      : undefined;
    const classificationRules = this.uniquePromptLines(baseContext.classificationRules, override?.classificationRules ?? []);
    const addOnContext = override?.addOnContext?.trim();

    return [
      `Category: ${baseContext.category} (${baseContext.label})`,
      "This is what a good match for this category looks like:",
      ...classificationRules.map((rule) => `- Good signal: ${rule}`),
      addOnContext ? `- Extra guidance: ${addOnContext}` : undefined
    ].filter(Boolean).join("\n");
  }

  private formatExaCategoryTargetAvoidSignals(category: LeadCategory, prequalification?: PrequalificationConfig): string {
    const baseContext = CATEGORY_PREQUALIFICATION_CONTEXT[category];
    const override = category !== "irrelevant" && category !== "other"
      ? prequalification?.categoryContexts?.[category as Exclude<LeadCategory, "irrelevant" | "other">]
      : undefined;
    const disqualifiers = this.uniquePromptLines(baseContext.disqualifiers, override?.disqualifiers ?? []);

    return [
      `Category: ${baseContext.category} (${baseContext.label})`,
      "Even inside the target category, avoid companies with these warning signs:",
      ...disqualifiers.map((rule) => `- Avoid signal: ${rule}`)
    ].filter(Boolean).join("\n");
  }

  private formatExaCategoryDriftAvoidSignals(category: LeadCategory, prequalification?: PrequalificationConfig): string {
    const baseContext = CATEGORY_PREQUALIFICATION_CONTEXT[category];
    const override = category !== "irrelevant" && category !== "other"
      ? prequalification?.categoryContexts?.[category as Exclude<LeadCategory, "irrelevant" | "other">]
      : undefined;
    const classificationRules = this.uniquePromptLines(baseContext.classificationRules, override?.classificationRules ?? []).slice(0, 2);
    const disqualifiers = this.uniquePromptLines(baseContext.disqualifiers, override?.disqualifiers ?? []).filter((rule) => rule !== "None - this is an uncertainty bucket").slice(0, 3);
    const addOnContext = override?.addOnContext?.trim();

    return [
      `Category to avoid drifting into: ${baseContext.category} (${baseContext.label})`,
      "These are signals that the query is drifting toward the wrong company type:",
      ...classificationRules.map((rule) => `- Avoid companies that mainly look like this: ${rule}`),
      ...disqualifiers.map((rule) => `- Avoid signal: ${rule}`),
      addOnContext ? `- Extra guidance: ${addOnContext}` : undefined
    ].filter(Boolean).join("\n");
  }

  private buildExaSearchUndesiredCategorySummary(requestedCategories: LeadCategory[]): string | undefined {
    const requestedSet = new Set(requestedCategories);
    const nonTargetSelectable = Object.values(CATEGORY_PREQUALIFICATION_CONTEXT)
      .map((context) => context.category)
      .filter((category) => category !== "irrelevant" && category !== "other" && !requestedSet.has(category));

    return [
      nonTargetSelectable.length > 0 ? `* Non-desired selectable categories for this run: ${nonTargetSelectable.join(", ")}` : undefined,
      "* Also avoid drifting into: other, irrelevant"
    ].filter(Boolean).join("\n");
  }

  private buildExaSearchCategorySpecificExclusionLines(requestedCategories: LeadCategory[]): string[] {
    const requestedSet = new Set(requestedCategories);
    const exclusionLines: Partial<Record<LeadCategory, string>> = {
      integrator_vision_ai_consulting: "- If integrator_vision_ai_consulting is not selected, explicitly say not consulting-led boutiques, strategy-heavy consultancies, or advisory-only firms.",
      integrator_vision_ai_freelancer: "- If integrator_vision_ai_freelancer is not selected, explicitly say not solo freelancers, solo consultants, or independent contractor profiles.",
      integrator_general_ai: "- If integrator_general_ai is not selected, explicitly say not generic AI agencies, broad software consultancies, or non-specialized AI service firms.",
      integrator_relevant_focus: "- If integrator_relevant_focus is not selected, explicitly say not surveillance, defence, medtech vision, robotics, agriculture tech, automotive tech, semiconductor, embedded, or measurement-heavy specialist integrators unless another desired category requires them.",
      industrial_end_customer_scaled: "- If industrial_end_customer_scaled is not selected, explicitly say not factories, plant operators, manufacturers, or industrial end customers running their own production.",
      camera_manufacturer_partner: "- If camera_manufacturer_partner is not selected, explicitly say not camera manufacturers, imaging hardware vendors, machine-vision component suppliers, or pure hardware sellers.",
      machine_builder_ai_enablement: "- If machine_builder_ai_enablement is not selected, explicitly say not OEMs, machine builders, scanner vendors, inspection stations, or hardware-centric inspection product companies.",
      machine_builder_vision_ai: "- If machine_builder_vision_ai is not selected, explicitly say not companies that already ship AOI machines, inline inspection systems, or machines whose primary purpose is Vision AI or optical quality control.",
      software_platform_embedding: "- If software_platform_embedding is not selected, explicitly say not workflow platforms, app ecosystems, software suites, installable tool environments, or measurement/test software platforms."
    };

    return Object.entries(exclusionLines)
      .filter(([category]) => !requestedSet.has(category as LeadCategory))
      .map(([, line]) => line as string);
  }

  private buildExaBaselineQuerySummary(baselineQueries: string[]): string {
    return baselineQueries.map((query, index) => `Angle ${index + 1}: ${this.compactPromptText(query, 180)}`).join("\n");
  }

  private buildExaRecentQueryHistorySummary(recentQueryHistory: ExaQueryHistoryInsight[]): string {
    if (recentQueryHistory.length === 0) {
      return "No recent query history is available yet.";
    }

    return recentQueryHistory.map((entry) => [
      `Query: ${entry.query}`,
      entry.detectedCategories?.length ? `Detected query classes: ${entry.detectedCategories.join(", ")}` : undefined,
      [
        "Observed counts:",
        `returned=${entry.returnedResults ?? 0}`,
        `excluded=${entry.filteredByExcludedDomains ?? 0}`,
        `duplicates=${entry.duplicates ?? 0}`,
        `accepted=${entry.accepted ?? 0}`,
        `wrong_category=${entry.rejectedDifferentCategory ?? 0}`,
        `other=${entry.rejectedOther ?? 0}`,
        `raw_found=${entry.rawFound ?? 0}`
      ].join(" "),
      entry.foundCategoryBreakdown
        ? `Found company categories: ${Object.entries(entry.foundCategoryBreakdown).filter(([, count]) => (count ?? 0) > 0).map(([category, count]) => `${category}=${count}`).join(", ") || "none"}`
        : "Found company categories: none",
      entry.note ? `Note: ${entry.note}` : undefined
    ].filter(Boolean).join("\n")).join("\n\n");
  }

  private splitExaSearchAvoidSignalsContext(avoidSignalsContext: string | undefined): {
    targetCategoryDisqualifiers?: string;
    nonTargetCategoriesToAvoid?: string;
  } {
    if (!avoidSignalsContext?.trim()) {
      return {};
    }

    const [targetSection, nonTargetSection] = avoidSignalsContext.split(/\n\nNon-target categories to avoid:\n\n/i);
    return {
      targetCategoryDisqualifiers: targetSection?.replace(/^Target-category disqualifiers:\n\n/i, "").trim() || undefined,
      nonTargetCategoriesToAvoid: nonTargetSection?.trim() || undefined
    };
  }

  private buildExaSearchPerformanceSummary(searchHistory: SearchHistoryEntry[]): string | undefined {
    const summary = searchHistory
      .slice(0, MAX_FILTER_STRATEGY_HISTORY)
      .map((entry) => {
        const topCategories = Object.entries(entry.categoryBreakdown ?? {})
          .filter(([, count]) => Number(count ?? 0) > 0)
          .sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0))
          .slice(0, 3)
          .map(([category, count]) => `${category}=${count}`)
          .join(", ");
        const queryStats = entry.queryStats?.slice(0, 3).map((queryStat: NonNullable<SearchHistoryEntry["queryStats"]>[number]) => `${queryStat.query} => accepted ${queryStat.accepted}, wrong-category ${queryStat.rejectedDifferentCategory}, other ${queryStat.rejectedOther}, duplicates ${queryStat.duplicates}`).join(" || ");
        const fallbackQueries = !queryStats && entry.discoveryQueries?.length
          ? entry.discoveryQueries.slice(0, 3).join(" || ")
          : undefined;

        return [
          `${entry.filterName} | ${entry.relevantCount}/${entry.returnedCount} relevant | ${(entry.relevanceRatio * 100).toFixed(0)}%`,
          topCategories ? `Top categories: ${topCategories}` : undefined,
          queryStats ? `Sample query outcomes: ${queryStats}` : undefined,
          fallbackQueries ? `Sample discovery queries: ${fallbackQueries}` : undefined
        ].filter(Boolean).join("\n");
      })
      .join("\n\n");

    return summary || undefined;
  }

  private uniquePromptLines(...groups: string[][]): string[] {
    const seen = new Set<string>();

    return groups
      .flat()
      .map((line) => line?.trim())
      .filter((line): line is string => Boolean(line))
      .filter((line) => {
        const normalized = line.toLowerCase();
        if (seen.has(normalized)) {
          return false;
        }
        seen.add(normalized);
        return true;
      });
  }

  private compactPromptText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }

    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
  }

  private buildExaSearchFilterNarrative(filter: OrganizationFilter): string {
    return [
      "Search filter context:",
      `- Filter name: ${filter.name}`,
      filter.persona?.trim() ? `- Persona: ${filter.persona.trim()}` : undefined,
      filter.targetCategories?.length ? `- Target categories in the filter: ${filter.targetCategories.join(", ")}` : undefined,
      filter.locations?.length ? `- Target locations in the filter: ${filter.locations.join(", ")}` : undefined,
      filter.industries?.length ? `- Relevant industries: ${filter.industries.join(", ")}` : undefined,
      filter.keywords?.length ? `- Important keyword signals: ${filter.keywords.join(", ")}` : undefined,
      filter.employeeRanges?.length ? `- Employee ranges: ${filter.employeeRanges.join(", ")}` : undefined,
      filter.notes?.trim() ? `- Filter notes: ${filter.notes.trim()}` : undefined
    ].filter(Boolean).join("\n");
  }

  async reviseSearchFilter(
    failedFilter: OrganizationFilter,
    evaluation: FilterEvaluation,
    dryRun: boolean,
    learning?: LeadLearningData,
    market?: string,
    customGoal?: string,
    mainContext?: string
  ): Promise<OrganizationFilter | null> {
    if (dryRun || !readiness.azureConfigured) {
      return null;
    }

    try {
      const content = await this.runChat(
        [
          {
            role: "system",
            content: [
              buildMainContextBlock(mainContext),
              "You revise one failing Apollo company search filter.",
              "Return strict JSON with {\"filter\":{...}}.",
              "The revised filter must aim for at least 50% relevant firms in the next 15-company probe.",
              "Tighten geography and commercial fit before broadening.",
              "Prefer service-led integrators and industrial accounts in Europe over broad AI vendors or generic consultancies.",
              "Move the failed filter toward delivery-led industrial software and automation archetypes when relevant.",
              "If the prior filter was too broad, narrow one dimension only: either keywords, industries, or geography, but do not rewrite the whole idea into another generic bucket.",
              "Do not rescue a weak filter by adding broadeners like AI solutions, manufacturing alone, or wider employee ranges.",
              "Prefer keyword families such as AOI, inline inspection, machine vision integration, industrial image processing, embedded computer vision, MES integration, SCADA integration, PLC software integration, OT integration, smart factory software, and industrial software engineering."
            ].join(" ")
          },
          {
            role: "user",
            content: [
              market ? `Market focus: ${market}` : undefined,
              customGoal ? `Custom goal: ${customGoal}` : undefined,
              mainContext ? `Main context: ${mainContext}` : undefined,
              `Failing filter JSON:\n${JSON.stringify(failedFilter)}`,
              `Evaluation JSON:\n${JSON.stringify(evaluation)}`,
              this.buildLearningContextForSearchStrategy(learning)
            ]
              .filter(Boolean)
              .join("\n\n")
          }
        ],
        { maxTokens: 500 }
      );

      const parsed = this.parseJsonObject<{ filter?: OrganizationFilter }>(content);
      const normalizedFilter = this.normalizeOrganizationFilter(parsed.filter);

      if (!normalizedFilter) {
        return null;
      }

      return {
        ...normalizedFilter,
        name:
          normalizedFilter.name === failedFilter.name
            ? `${normalizedFilter.name} Retry`
            : normalizedFilter.name
      };
    } catch {
      return null;
    }
  }

  private categorizeDryRun(description: string): Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale"> {
    const lowered = description.toLowerCase();
    const serviceDeliverySignals = [
      "custom software",
      "software development",
      "softwareentwicklung",
      "software engineering",
      "engineering services",
      "it services",
      "it-services",
      "it-dienstleistung",
      "integration",
      "implementation",
      "project delivery",
      "digital transformation",
      "digitale transformation",
      "platform engineering",
      "data & ai",
      "machine learning",
      "computer vision",
      "dedicated teams",
      "beratung",
      "dienstleistung",
      "umsetzung",
      "prozessautomatisierung",
      "branchenloesungen",
      "branchenlösungen"
    ];
    const obviouslyIrrelevantSignals = [
      "magazine",
      "magazin",
      "publisher",
      "publishing",
      "media company",
      "media house",
      "news portal",
      "newsroom",
      "editorial",
      "event organizer",
      "conference",
      "association",
      "university",
      "research institute",
      "venture capital",
      "private equity",
      "bank",
      "insurance"
    ];
    const mediaProductionSignals = [
      "videoproduktion",
      "video production",
      "content- und videoproduktion",
      "filmproduktion",
      "film production",
      "filmmaker",
      "videographer",
      "cinematography",
      "post-production",
      "post production",
      "production company",
      "video agency",
      "content creation",
      "content creator",
      "commercial production",
      "vfx",
      "storytelling"
    ];
    const nonIndustrialPlatformSignals = [
      "enterprise software",
      "erp",
      "crm",
      "human resources",
      "hr software",
      "logistics",
      "parcel",
      "supply chain",
      "e-commerce",
      "marketing platform",
      "cloud platform",
      "business software",
      "marketplace",
      "distributor",
      "trader",
      "spare parts"
    ];
    const clinicalSoftwareSignals = [
      "clinical trial",
      "clinical trials",
      "ctms",
      "etmf",
      "trial master file",
      "trial supply management",
      "life sciences software",
      "cro",
      "pharma",
      "biotech",
      "clinical operations",
      "study startup"
    ];
    const productizedVisionSoftwareSignals = [
      "vision ai",
      "computer vision",
      "image analysis",
      "image recognition",
      "medical imaging",
      "radiology",
      "mri",
      "diagnostic imaging",
      "pacs",
      "befundsystem",
      "bilddaten"
    ];
    const embeddedProductWorkflowSignals = [
      "plug-in",
      "plugin",
      "plug in",
      "integrates into existing",
      "existing pacs",
      "existing systems",
      "existing workflows",
      "reporting systems",
      "certified product",
      "our product",
      "our products"
    ];
    const industrialSignals = [
      "industrial",
      "automation",
      "automatisierung",
      "automatisierungstechnik",
      "inspection",
      "quality control",
      "control de calidad",
      "machine",
      "robotics",
      "camera",
      "imaging",
      "bildverarbeitung",
      "industrielle bildverarbeitung",
      "vision artificial",
      "línea de producción",
      "linea de produccion",
      "lineas de produccion",
      "líneas de producción",
      "embedded",
      "factory",
      "anlagenbau",
      "sondermaschinenbau",
      "maschinenbau"
    ];
    const publisherSignals = [
      "publisher",
      "publishing",
      "verlag",
      "fachzeitschrift",
      "magazine",
      "editorial",
      "media",
      "newsletter",
      "events",
      "trade fair"
    ];
    const relevantVerticalSignals = [
      "rail",
      "mobility",
      "defence",
      "defense",
      "aerospace",
      "medical",
      "medtech",
      "radiology",
      "regulated"
    ];
    const platformIntegrationSignals = [
      "one integration",
      "single integration",
      "clinical api",
      "api",
      "orchestration",
      "marketplace",
      "operating system",
      "workflow integration",
      "third-party ai",
      "third party ai",
      "vendor-neutral",
      "vendor neutral",
      "platform"
    ];
    const captiveItSignals = [
      "it partner",
      "for the group",
      "for our colleagues",
      "value chain integration",
      "wertschöpfungskette",
      "mes",
      "enterprise application",
      "process integration",
      "within our group",
      "group-wide"
    ];
    const aiConsultancySignals = [
      "ai consulting",
      "data science",
      "machine learning",
      "generative ai",
      "production implementations",
      "implemented for clients",
      "delivery for clients",
      "client projects"
    ];
    const integrationSoftwareSignals = [
      "plug-in",
      "plugin",
      "plug in",
      "device integration",
      "workflow automation",
      "test equipment",
      "instruments",
      "existing systems",
      "customer integration",
      "integration layer"
    ];
    const genericEngineeringAgencySignals = [
      "iot",
      "cloud",
      "embedded systems",
      "hardware engineering",
      "software engineering",
      "prototyping",
      "technical consulting",
      "custom projects",
      "safety-critical engineering",
      "safety critical engineering"
    ];
    const machineProductSignals = [
      "scanner",
      "scanners",
      "digitization systems",
      "digitisation systems",
      "product lines",
      "product line",
      "own product",
      "own products",
      "inspection systems",
      "imaging hardware"
    ];
    const cameraManufacturerSignals = [
      "industrial camera",
      "industrial cameras",
      "camera manufacturer",
      "machine vision cameras",
      "3d camera",
      "3d cameras",
      "area scan camera",
      "area scan cameras",
      "gige interfaces",
      "usb interfaces",
      "camera portfolio"
    ];

    const nonIndustrialHits = nonIndustrialPlatformSignals.filter((signal) => lowered.includes(signal)).length;
    const industrialHits = industrialSignals.filter((signal) => lowered.includes(signal)).length;
    const serviceDeliveryHits = serviceDeliverySignals.filter((signal) => lowered.includes(signal)).length;
    const clinicalSoftwareHits = clinicalSoftwareSignals.filter((signal) => lowered.includes(signal)).length;
    const publisherHits = publisherSignals.filter((signal) => lowered.includes(signal)).length;
    const relevantVerticalHits = relevantVerticalSignals.filter((signal) => lowered.includes(signal)).length;
    const platformIntegrationHits = platformIntegrationSignals.filter((signal) => lowered.includes(signal)).length;
    const captiveItHits = captiveItSignals.filter((signal) => lowered.includes(signal)).length;
    const aiConsultancyHits = aiConsultancySignals.filter((signal) => lowered.includes(signal)).length;
    const genericEngineeringAgencyHits = genericEngineeringAgencySignals.filter((signal) => lowered.includes(signal)).length;
    const machineProductHits = machineProductSignals.filter((signal) => lowered.includes(signal)).length;
    const cameraManufacturerHits = cameraManufacturerSignals.filter((signal) => lowered.includes(signal)).length;
    const integrationSoftwareHits = integrationSoftwareSignals.filter((signal) => lowered.includes(signal)).length;
    const productizedVisionSoftwareHits = productizedVisionSoftwareSignals.filter((signal) => lowered.includes(signal)).length;
    const embeddedProductWorkflowHits = embeddedProductWorkflowSignals.filter((signal) => lowered.includes(signal)).length;

    if (publisherHits >= 2) {
      return {
        category: "other",
        relevanceScore: 8,
        rationale: "Description points to a publisher, trade-media, or editorial business rather than a delivery or platform target."
      };
    }

    if (obviouslyIrrelevantSignals.some((signal) => lowered.includes(signal)) && serviceDeliveryHits === 0) {
      return {
        category: "irrelevant",
        relevanceScore: 3,
        rationale: "Description points to a media, finance, event, academic, or other clearly non-target profile."
      };
    }

    if (mediaProductionSignals.some((signal) => lowered.includes(signal))) {
      return {
        category: "irrelevant",
        relevanceScore: 2,
        rationale: "Description points to a film, video, or content-production business rather than a software integrator or AI delivery target."
      };
    }

    if (clinicalSoftwareHits >= 2 && industrialHits <= 1) {
      return {
        category: "irrelevant",
        relevanceScore: 4,
        rationale: "Description points to clinical-trial or life-sciences software rather than an industrial Vision-AI target."
      };
    }

    if (
      productizedVisionSoftwareHits >= 2 &&
      embeddedProductWorkflowHits >= 1 &&
      !lowered.includes("consulting") &&
      !lowered.includes("consultant") &&
      !lowered.includes("services")
    ) {
      return {
        category: "machine_builder_ai_enablement",
        relevanceScore: 79,
        rationale: "Description suggests a productized Vision-AI software vendor with its own application in customer workflows."
      };
    }

    if ((platformIntegrationHits >= 3 && lowered.includes("ai")) || (integrationSoftwareHits >= 2 && lowered.includes("software platform"))) {
      return {
        category: "software_platform_embedding",
        relevanceScore: 86,
        rationale: "Description suggests an AI platform or orchestration layer embedded through one integration or API."
      };
    }

    if (aiConsultancyHits >= 2 && productizedVisionSoftwareHits >= 1 && (embeddedProductWorkflowHits >= 1 || serviceDeliveryHits >= 2)) {
      return {
        category: "integrator_vision_ai_consulting",
        relevanceScore: 84,
        rationale: "Description suggests an AI consultancy with explicit computer-vision delivery and customer implementation ownership."
      };
    }

    if (genericEngineeringAgencyHits >= 3 && platformIntegrationHits === 0 && productizedVisionSoftwareHits === 0) {
      return {
        category: "other",
        relevanceScore: 28,
        rationale: "Description suggests a broad engineering agency rather than a focused AI integrator or product platform."
      };
    }

    if (cameraManufacturerHits >= 2 && !lowered.includes("scanner") && !lowered.includes("digitization")) {
      return {
        category: "camera_manufacturer_partner",
        relevanceScore: 88,
        rationale: "Description suggests an explicit industrial camera manufacturer with partner-fit hardware and imaging products."
      };
    }

    if (machineProductHits >= 3 && cameraManufacturerHits === 0 && (lowered.includes("imaging") || lowered.includes("system"))) {
      return {
        category: "machine_builder_ai_enablement",
        relevanceScore: 82,
        rationale: "Description suggests a product vendor for scanners or inspection systems with AI-enableable product potential."
      };
    }

    if (captiveItHits >= 2 && (serviceDeliveryHits >= 2 || industrialHits >= 1)) {
      return {
        category: "integrator_general_ai",
        relevanceScore: 72,
        rationale: "Description suggests a captive industrial IT delivery unit with recurring integration and software implementation ownership."
      };
    }

    if (aiConsultancyHits >= 2 && serviceDeliveryHits >= 2) {
      return {
        category: "integrator_general_ai",
        relevanceScore: 80,
        rationale: "Description suggests an AI consultancy delivering applied implementation projects for clients."
      };
    }

    if ((lowered.includes("system integrator") || lowered.includes("systems integrator")) && relevantVerticalHits >= 1) {
      return {
        category: "integrator_relevant_focus",
        relevanceScore: 76,
        rationale: "Description suggests a system integrator delivering in a concrete regulated or industrial vertical."
      };
    }

    if (nonIndustrialHits >= 1 && industrialHits === 0 && serviceDeliveryHits === 0) {
      return {
        category: "irrelevant",
        relevanceScore: 6,
        rationale: "Description points to a generic enterprise platform or logistics business rather than an industrial delivery target."
      };
    }

    if (
      lowered.includes("venture capital") ||
      lowered.includes("private equity") ||
      lowered.includes("bank") ||
      lowered.includes("financial") ||
      lowered.includes("generic consultancy")
    ) {
      return {
        category: "irrelevant",
        relevanceScore: 8,
        rationale: "Description points to a non-target financial or non-delivery profile."
      };
    }

    if ((lowered.includes("camera") || lowered.includes("imaging") || lowered.includes("optics")) && machineProductHits < 2) {
      return {
        category: "camera_manufacturer_partner",
        relevanceScore: 73,
        rationale: "Description suggests imaging hardware where AI software upsell may be relevant."
      };
    }

    if (
      (lowered.includes("consultant") || lowered.includes("consulting") || lowered.includes("freelancer") || lowered.includes("beratung")) &&
      (lowered.includes("computer vision") || lowered.includes("machine vision") || lowered.includes("industrial ai") || lowered.includes("embedded vision") || lowered.includes("inspection"))
    ) {
      const looksLikeFreelancer = lowered.includes("freelancer") || lowered.includes("freiberuf") || lowered.includes("independent consultant") || lowered.includes("solo consultant");
      return {
        category: looksLikeFreelancer ? "integrator_vision_ai_freelancer" : "integrator_vision_ai_consulting",
        relevanceScore: 84,
        rationale: looksLikeFreelancer
          ? "Description suggests hands-on vision or industrial AI freelance delivery."
          : "Description suggests hands-on vision or industrial AI consulting delivery."
      };
    }

    if (lowered.includes("computer vision") || lowered.includes("machine vision") || lowered.includes("industrial ai")) {
      return {
        category: "integrator_vision_industrial_ai",
        relevanceScore: 87,
        rationale: "Description signals vision or industrial AI delivery capability."
      };
    }

    if ((lowered.includes("platform") || lowered.includes("api") || lowered.includes("workflow")) && serviceDeliveryHits === 0) {
      return {
        category: "software_platform_embedding",
        relevanceScore: 78,
        rationale: "Description suggests software-platform structure that could embed model generation capabilities."
      };
    }

    if (serviceDeliveryHits >= 2 && (lowered.includes("software") || lowered.includes("ai") || lowered.includes("data") || lowered.includes("engineering"))) {
      return {
        category: "integrator_general_ai",
        relevanceScore: 81,
        rationale: "Description suggests a delivery-led software and AI engineering partner with customer implementation ownership."
      };
    }

    if (
      (lowered.includes("software") || lowered.includes("integration") || lowered.includes("engineering") || lowered.includes("implementation")) &&
      (lowered.includes("factory") || lowered.includes("production") || lowered.includes("industrial") || lowered.includes("automation"))
    ) {
      return {
        category: "integrator_general_ai",
        relevanceScore: 79,
        rationale: "Description suggests service-led industrial software or automation implementation ownership."
      };
    }

    if (lowered.includes("oem") || lowered.includes("maschinenbau") || lowered.includes("special machinery") || lowered.includes("sondermaschinen")) {
      return {
        category: "machine_builder_ai_enablement",
        relevanceScore: 76,
        rationale: "Description suggests machine-building profile with AI-upgrade potential."
      };
    }

    if (lowered.includes("production") || lowered.includes("quality") || lowered.includes("factory")) {
      return {
        category: "industrial_end_customer_scaled",
        relevanceScore: 75,
        rationale: "Description suggests industrial production context where QC/process automation is relevant."
      };
    }

    if (lowered.includes("integrator") || lowered.includes("automation") || (lowered.includes("software") && genericEngineeringAgencyHits < 3 && integrationSoftwareHits < 2)) {
      return {
        category: "integrator_general_ai",
        relevanceScore: 75,
        rationale: "Description suggests implementation or integration services."
      };
    }

    return {
      category: "other",
      relevanceScore: 40,
      rationale: "Signal is mixed and needs deeper manual review."
    };
  }

  private categorizeDeterministic(
    name: string,
    description: string,
    learning?: LeadLearningData
  ): Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale"> | null {
    const lowered = `${name} ${description}`.toLowerCase();
    const matchedReference = REFERENCE_COMPANY_CLASSIFICATIONS.find((entry) => entry.match.test(`${name} ${description}`));
    if (matchedReference) {
      return {
        category: matchedReference.category,
        relevanceScore: matchedReference.relevanceScore,
        rationale: matchedReference.rationale
      };
    }
    const normalizedDescription = description.trim().toLowerCase();
    const hasPlaceholderDescription =
      normalizedDescription.length === 0 ||
      normalizedDescription.includes("no verified public company description was returned by apollo");
    const obviouslyIrrelevantSignals = [
      "magazine",
      "magazin",
      "publisher",
      "publishing",
      "media company",
      "media house",
      "news portal",
      "newsroom",
      "editorial",
      "blog network",
      "event organizer",
      "conference",
      "association",
      "foundation",
      "university",
      "research institute",
      "institute",
      "venture capital",
      "private equity",
      "investor",
      "bank",
      "financial services",
      "insurance"
    ];
    const mediaProductionSignals = [
      "videoproduktion",
      "video production",
      "content- und videoproduktion",
      "filmproduktion",
      "film production",
      "filmmaker",
      "videographer",
      "cinematography",
      "post-production",
      "post production",
      "production company",
      "video agency",
      "content creation",
      "content creator",
      "commercial production",
      "vfx",
      "storytelling"
    ];
    const nonIndustrialPlatformSignals = [
      "enterprise software",
      "erp",
      "crm",
      "human resources",
      "hr software",
      "logistics",
      "parcel",
      "supply chain",
      "e-commerce",
      "marketing platform",
      "cloud platform",
      "business software"
    ];
    const clinicalSoftwareSignals = [
      "clinical trial",
      "clinical trials",
      "ctms",
      "etmf",
      "trial master file",
      "trial supply management",
      "life sciences software",
      "cro",
      "pharma",
      "biotech",
      "clinical operations",
      "study startup"
    ];
    const productizedVisionSoftwareSignals = [
      "vision ai",
      "computer vision",
      "image analysis",
      "image recognition",
      "medical imaging",
      "radiology",
      "mri",
      "diagnostic imaging",
      "pacs",
      "befundsystem",
      "bilddaten"
    ];
    const embeddedProductWorkflowSignals = [
      "plug-in",
      "plugin",
      "plug in",
      "integrates into existing",
      "existing pacs",
      "existing systems",
      "existing workflows",
      "reporting systems",
      "certified product",
      "our product",
      "our products"
    ];
    const industrialSignals = [
      "industrial",
      "automation",
      "inspection",
      "quality control",
      "control de calidad",
      "machine",
      "robotics",
      "camera",
      "imaging",
      "vision artificial",
      "línea de producción",
      "linea de produccion",
      "lineas de produccion",
      "líneas de producción",
      "embedded",
      "factory"
    ];
    const hardwareVendorSignals = [
      "industrial camera",
      "machine vision",
      "camera manufacturer",
      "imaging systems",
      "camera systems",
      "optics",
      "embedded vision",
      "image sensor"
    ];
    const displayVendorSignals = [
      "display solution",
      "display solutions",
      "display customization",
      "cockpit solutions",
      "optical bonding",
      "hmi",
      "autostereoscopic",
      "3d displays"
    ];
    const serviceSignals = [
      "system integrator",
      "systems integrator",
      "systemintegration",
      "bildverarbeitungsintegrator",
      "solution provider",
      "provider of turnkey",
      "turnkey",
      "software development",
      "custom software",
      "customized",
      "customised",
      "engineering services",
      "consultancy",
      "delivering",
      "providing",
      "implementing",
      "implementation",
      "implementamos",
      "soluciones a medida",
      "asesoramiento",
      "seguimiento",
      "project delivery",
      "integration services",
      "generalunternehmer",
      "dienstleister",
      "service"
    ];
    const softwarePlatformSignals = [
      "software platform",
      "platform tools",
      "developer tools",
      "development environment",
      "runtime system",
      "control runtime",
      "sdk",
      "api"
    ];
    const visionDeliverySignals = [
      "machine vision",
      "industrial image processing",
      "image processing",
      "bildverarbeitung",
      "industrielle bildverarbeitung",
      "inspection systems",
      "inspection solutions",
      "inspection automation",
      "vision artificial",
      "control de calidad",
      "deteccion de defectos",
      "detección de defectos",
      "lectura de códigos",
      "lectura de codigos",
      "verificación",
      "verificacion",
      "optische inspektion",
      "oberflaecheninspektion",
      "oberflächeninspektion",
      "schweissnahtpruefung",
      "schweißnahtprüfung",
      "code-verifikation",
      "pruefsysteme",
      "prüfsysteme",
      "quality assurance systems",
      "aoi",
      "inspection",
      "vision systems",
      "quality inspection",
      "inline",
      "end-of-line",
      "computer vision"
    ];
    const automationDeliverySignals = [
      "industrial automation",
      "automation software",
      "automatización industrial",
      "automatizacion industrial",
      "automatisierungstechnik",
      "steuerungstechnik",
      "mes",
      "scada",
      "plc",
      "embedded software",
      "embedded systems",
      "industrial software",
      "smart factory",
      "mom",
      "iiot",
      "co-engineering",
      "co engineering",
      "commissioning",
      "software engineering",
      "inbetriebnahme",
      "schaltschrankbau"
    ];
    const productBrandSignals = [
      "robotics",
      "robot",
      "automation",
      "systems",
      "machine",
      "industrial"
    ];
    const productOnlySignals = [
      "humanoid robot",
      "mobile robot",
      "robot arm",
      "service robot",
      "open-source robot",
      "pre-order",
      "hardware platform",
      "robot platform",
      "robotics platform",
      "robot manufacturer"
    ];
    const recruitingSignals = [
      "recruiting software",
      "applicant tracking",
      "job board",
      "job boards",
      "job platform",
      "career platform",
      "job search",
      "career advice",
      "resume tool",
      "cv tool",
      "headhunter",
      "employment marketplace",
      "hiring platform",
      "candidate management",
      "talent acquisition",
      "multiposting",
      "ats"
    ];
    const nonTargetInspectionSignals = [
      "pipeline inspection",
      "ili consulting",
      "corrosion",
      "geometric inspection",
      "pre-inspection",
      "post-inspection support",
      "inspection data",
      "supply chain solutions",
      "creative visual studio"
    ];
    const verticalErpSignals = [
      "textile",
      "garment",
      "apparel",
      "fashion industry",
      "textile industry"
    ];
    const serviceDeliverySignals = [
      "custom software",
      "software development",
      "softwareentwicklung",
      "software engineering",
      "engineering services",
      "it services",
      "it-services",
      "it-dienstleistung",
      "integration",
      "implementation",
      "project delivery",
      "digital transformation",
      "digitale transformation",
      "platform engineering",
      "data & ai",
      "machine learning",
      "computer vision",
      "dedicated teams",
      "beratung",
      "dienstleistung",
      "dienstleistungen",
      "umsetzung",
      "software a medida",
      "soluciones a medida",
      "implementación",
      "implementacion",
      "integración",
      "integracion",
      "prozessautomatisierung",
      "branchenloesungen",
      "branchenlösungen",
      "softwareprojekte",
      "it-projekthaus",
      "generalunternehmer",
      "inbetriebnahme",
      "systemintegration"
    ];
    const advisoryOnlySignals = [
      "unternehmensberatung",
      "management consulting",
      "it due diligence",
      "due diligence",
      "training",
      "academy",
      "workshop",
      "governance",
      "risk and compliance",
      "itsm",
      "service management",
      "product management",
      "advisory",
      "consulting"
    ];
    const specialistConsultingSignals = [
      "machine vision consultant",
      "computer vision consultant",
      "computer vision and image analysis",
      "image analysis",
      "object detection",
      "industrial ai consulting",
      "industrial ai consultant",
      "vision ai consultant",
      "vision ai consulting",
      "ai services company",
      "ai services",
      "ai development company",
      "ai software development",
      "embedded vision consultant",
      "inspection ai consultant",
      "bildverarbeitung beratung",
      "beratung fuer bildverarbeitung",
      "beratung für bildverarbeitung",
      "freelancer",
      "freiberuf",
      "independent consultant"
    ];
    const webAgencySignals = [
      "ui/ux",
      "web development",
      "drupal",
      "wordpress",
      "brand design",
      "creative studio"
    ];
    const implementationStrengthSignals = [
      "custom software",
      "full-cycle",
      "full cycle",
      "dedicated teams",
      "solutions & development",
      "solution development",
      "software product development",
      "platform engineering",
      "infrastructure & engineering",
      "infrastructure and engineering",
      "implementieren",
      "implements ai solutions",
      "entwickeln von individuellen",
      "engineering teams",
      "kundenspezifisch",
      "generalunternehmer",
      "de principio a fin",
      "integran de forma automática",
      "integran de forma automatica",
      "projekte",
      "ueber 300 projekte",
      "über 300 projekte"
    ];
    const machineBuilderSignals = [
      "maschinenbau",
      "anlagenbau",
      "sondermaschinenbau",
      "sondermaschinenbauer",
      "special machinery",
      "machine builder",
      "industrial machinery manufacturing",
      "quality control system",
      "quality control systems",
      "quality inspection system",
      "quality inspection systems",
      "inspection machine",
      "inspection machines",
      "inspection station",
      "inspection stations",
      "visual inspection system",
      "visual inspection systems",
      "oem",
      "lagertechnik",
      "intralogistik",
      "schaltschrankbau"
    ];
    const productManufacturerSignals = [
      "product family",
      "product families",
      "our products",
      "developing and delivering",
      "develops and delivers",
      "developing innovative",
      "designs and produces",
      "design and production",
      "we produce",
      "manufactures",
      "manufacturing our",
      "built by us",
      "technology market leader"
    ];
    const machineProductSignals = [
      "scanner",
      "scanners",
      "scan bar",
      "scan bars",
      "digitization solution",
      "digitization solutions",
      "inspection device",
      "inspection devices",
      "inspection system",
      "inspection systems",
      "machine vision products",
      "product line",
      "hardware system",
      "hardware systems"
    ];
    const cameraManufacturerSignals = [
      "industrial camera",
      "industrial cameras",
      "camera manufacturer",
      "machine vision cameras",
      "3d camera",
      "3d cameras",
      "area scan camera",
      "area scan cameras",
      "gige interfaces",
      "usb interfaces",
      "camera portfolio"
    ];
    const municipalPlatformSignals = [
      "municipal",
      "kommunal",
      "waste collection",
      "abfallsammlung",
      "winter service",
      "winterdienst",
      "street cleaning",
      "straßenreinigung",
      "strassenreinigung",
      "route planning",
      "routenplanung",
      "telematics",
      "container tracking",
      "fleet management"
    ];
    const softwareToolVendorSignals = [
      "development environment",
      "runtime system",
      "programming system",
      "developer tools",
      "software platform",
      "control runtime",
      "ide"
    ];
    const genericEngineeringAgencySignals = [
      "iot & embedded",
      "embedded systems",
      "software development",
      "cloud & devops",
      "cloud architecture",
      "cloud architectures",
      "rapid prototyping",
      "mvp development",
      "proof of concept",
      "hardware prototyping",
      "web applications",
      "backend development",
      "mobile apps",
      "api design",
      "microservices",
      "legacy system modernization",
      "cloud migration",
      "kubernetes",
      "ci/cd",
      "infrastructure as code",
      "monitoring and logging",
      "technical consulting",
      "tailored solutions"
    ];
    const simulationAndPlanningSignals = [
      "digital twin",
      "simulation software",
      "simulationssoftware",
      "3d simulation",
      "material flow",
      "materialfluss",
      "warehouse planning",
      "intralogistics planning",
      "logistics planning",
      "visualization software",
      "planungssoftware",
      "plant simulation"
    ];
    const publisherSignals = [
      "publisher",
      "publishing",
      "verlag",
      "fachzeitschrift",
      "magazine",
      "editorial",
      "media",
      "newsletter",
      "trade media",
      "events"
    ];
    const relevantVerticalSignals = [
      "rail",
      "mobility",
      "defence",
      "defense",
      "aerospace",
      "medical",
      "medtech",
      "radiology",
      "regulated"
    ];
    const platformIntegrationSignals = [
      "one integration",
      "single integration",
      "clinical api",
      "api",
      "orchestration",
      "marketplace",
      "operating system",
      "workflow integration",
      "third-party ai",
      "third party ai",
      "vendor-neutral",
      "vendor neutral"
    ];
    const captiveItSignals = [
      "it partner",
      "for the group",
      "for our colleagues",
      "value chain integration",
      "wertschöpfungskette",
      "mes",
      "enterprise application",
      "process integration",
      "within our group",
      "group-wide"
    ];
    const aiConsultancySignals = [
      "ai consulting",
      "data science",
      "machine learning",
      "generative ai",
      "production implementations",
      "implemented for clients",
      "delivery for clients",
      "client projects"
    ];
    const integrationSoftwareSignals = [
      "plug-in",
      "plugin",
      "plug in",
      "device integration",
      "workflow automation",
      "test equipment",
      "instruments",
      "existing systems",
      "customer integration",
      "integration layer"
    ];

    const recruitingHits = recruitingSignals.filter((signal) => lowered.includes(signal)).length;
    const serviceDeliveryHits = serviceDeliverySignals.filter((signal) => lowered.includes(signal)).length;
    const serviceHits = serviceSignals.filter((signal) => lowered.includes(signal)).length;
    const clinicalSoftwareHits = clinicalSoftwareSignals.filter((signal) => lowered.includes(signal)).length;
    const productizedVisionSoftwareHits = productizedVisionSoftwareSignals.filter((signal) => lowered.includes(signal)).length;
    const embeddedProductWorkflowHits = embeddedProductWorkflowSignals.filter((signal) => lowered.includes(signal)).length;
    const advisoryHits = advisoryOnlySignals.filter((signal) => lowered.includes(signal)).length;
    const specialistConsultingHits = specialistConsultingSignals.filter((signal) => lowered.includes(signal)).length;
    const webAgencyHits = webAgencySignals.filter((signal) => lowered.includes(signal)).length;
    const implementationStrengthHits = implementationStrengthSignals.filter((signal) => lowered.includes(signal)).length;
    const verticalErpHits = verticalErpSignals.filter((signal) => lowered.includes(signal)).length;
    if (recruitingHits >= 2) {
      return {
        category: "irrelevant",
        relevanceScore: 4,
        rationale: "Company description strongly matches recruiting, hiring, or applicant-tracking software rather than ONE WARE's ICP."
      };
    }

    const nonIndustrialHits = nonIndustrialPlatformSignals.filter((signal) => lowered.includes(signal)).length;
    const industrialHits = industrialSignals.filter((signal) => lowered.includes(signal)).length;
    const genericEngineeringAgencyHits = genericEngineeringAgencySignals.filter((signal) => lowered.includes(signal)).length;
    const simulationAndPlanningHits = simulationAndPlanningSignals.filter((signal) => lowered.includes(signal)).length;
    const publisherHits = publisherSignals.filter((signal) => lowered.includes(signal)).length;
    const relevantVerticalHits = relevantVerticalSignals.filter((signal) => lowered.includes(signal)).length;
    const platformIntegrationHits = platformIntegrationSignals.filter((signal) => lowered.includes(signal)).length;
    const captiveItHits = captiveItSignals.filter((signal) => lowered.includes(signal)).length;
    const aiConsultancyHits = aiConsultancySignals.filter((signal) => lowered.includes(signal)).length;
    const integrationSoftwareHits = integrationSoftwareSignals.filter((signal) => lowered.includes(signal)).length;
    const softwarePlatformHits = softwarePlatformSignals.filter((signal) => lowered.includes(signal)).length;

    if (publisherHits >= 2) {
      return {
        category: "other",
        relevanceScore: 8,
        rationale: "Company description points to a publisher, trade-media, or editorial business rather than a delivery or platform target."
      };
    }

    if (obviouslyIrrelevantSignals.some((signal) => lowered.includes(signal)) && serviceDeliveryHits === 0 && serviceHits === 0) {
      return {
        category: "irrelevant",
        relevanceScore: 2,
        rationale: "Company description strongly matches a media, finance, event, academic, or other clearly non-target profile."
      };
    }

    if (mediaProductionSignals.some((signal) => lowered.includes(signal))) {
      return {
        category: "irrelevant",
        relevanceScore: 2,
        rationale: "Company description strongly matches a film, video, or content-production business rather than an industrial AI integrator."
      };
    }

    if (clinicalSoftwareHits >= 2 && industrialHits <= 1) {
      return {
        category: "irrelevant",
        relevanceScore: 4,
        rationale: "Company description points to clinical-trial or life-sciences software rather than an industrial Vision-AI delivery target."
      };
    }

    if (
      productizedVisionSoftwareHits >= 2 &&
      embeddedProductWorkflowHits >= 1 &&
      serviceHits === 0 &&
      serviceDeliveryHits <= 1 &&
      !lowered.includes("consulting") &&
      !lowered.includes("consultant")
    ) {
      return {
        category: "machine_builder_ai_enablement",
        relevanceScore: 80,
        rationale: "Company description fits a productized Vision-AI software vendor with AI-enableable product potential."
      };
    }

    if (
      (platformIntegrationHits >= 3 && lowered.includes("ai")) ||
      (integrationSoftwareHits >= 2 && (softwarePlatformHits >= 1 || lowered.includes("software product") || lowered.includes("platform-style deployment") || lowered.includes("platform style deployment")))
    ) {
      return {
        category: "software_platform_embedding",
        relevanceScore: 88,
        rationale: "Company description fits an AI platform or orchestration layer accessed through one integration or API."
      };
    }

    if (captiveItHits >= 2 && (serviceDeliveryHits >= 2 || industrialHits >= 1)) {
      return {
        category: "integrator_general_ai",
        relevanceScore: 72,
        rationale: "Company description fits a captive industrial IT delivery unit with recurring integration ownership."
      };
    }

    if (aiConsultancyHits >= 2 && serviceDeliveryHits >= 2) {
      return {
        category: "integrator_general_ai",
        relevanceScore: 80,
        rationale: "Company description fits an AI consultancy delivering applied implementation projects for clients."
      };
    }

    if ((lowered.includes("system integrator") || lowered.includes("systems integrator")) && relevantVerticalHits >= 1) {
      return {
        category: "integrator_relevant_focus",
        relevanceScore: 78,
        rationale: "Company description fits a system integrator with delivery in a concrete regulated or industrial vertical."
      };
    }

    if (nonIndustrialHits >= 1 && industrialHits === 0 && serviceDeliveryHits === 0) {
      return {
        category: "other",
        relevanceScore: 12,
        rationale: "Company description looks like a generic enterprise, logistics, or platform software business rather than a ONE WARE-relevant delivery fit."
      };
    }

    if (nonTargetInspectionSignals.some((signal) => lowered.includes(signal))) {
      return {
        category: "irrelevant",
        relevanceScore: 9,
        rationale: "Company description points to pipeline inspection, generic consulting, or another non-target inspection niche instead of industrial vision integration."
      };
    }

    if (
      verticalErpHits >= 1 &&
      lowered.includes("erp") &&
      lowered.includes("mes") &&
      !visionDeliverySignals.some((signal) => lowered.includes(signal))
    ) {
      return {
        category: "other",
        relevanceScore: 18,
        rationale: "Company description points to sector-specific ERP/MES software rather than a vision, inspection, or AI delivery specialist."
      };
    }

    if (webAgencyHits >= 2 && implementationStrengthHits < 2 && serviceDeliveryHits < 3) {
      return {
        category: "irrelevant",
        relevanceScore: 12,
        rationale: "Company description looks like a web or UI/UX agency rather than an industrial or AI implementation partner."
      };
    }

    const hardwareHits = hardwareVendorSignals.filter((signal) => lowered.includes(signal)).length;
    const mentionsImagingOrCamera = lowered.includes("imaging") || lowered.includes("camera");
    const mentionsVendorOrHardware =
      lowered.includes("vendor") ||
      lowered.includes("hardware") ||
      lowered.includes("oem") ||
      lowered.includes("manufacturer") ||
      lowered.includes("optics");
    const distributorLikeSignals = [
      "distributor",
      "one-stop",
      "multi brand",
      "multibrand",
      "parts from distributors",
      "buy, sell and manage",
      "platform for industrial automation traders"
    ];
    const negatesServiceLedModel =
      lowered.includes("not a pure implementation-led services firm") ||
      lowered.includes("not a pure implementation led services firm") ||
      lowered.includes("not an implementation-led services firm") ||
      lowered.includes("product vendor, not a pure implementation-led services firm") ||
      lowered.includes("primarily sells software products");

    if (hasPlaceholderDescription && productBrandSignals.some((signal) => lowered.includes(signal)) && serviceHits === 0) {
      return {
        category: "other",
        relevanceScore: 25,
        rationale: "Company name alone suggests an automation or robotics brand, but there is no verified evidence of service-led delivery ownership."
      };
    }

    if (productOnlySignals.some((signal) => lowered.includes(signal)) && serviceHits === 0) {
      return {
        category: "machine_builder_ai_enablement",
        relevanceScore: 32,
        rationale: "Company description looks product-led or robotics-hardware-led rather than like a software integrator."
      };
    }

    if (distributorLikeSignals.some((signal) => lowered.includes(signal))) {
      return {
        category: "irrelevant",
        relevanceScore: 10,
        rationale: "Company description looks like a distributor, trader platform, or parts marketplace rather than an implementation-led delivery partner."
      };
    }

    const displayVendorHits = displayVendorSignals.filter((signal) => lowered.includes(signal)).length;
    const machineProductHits = machineProductSignals.filter((signal) => lowered.includes(signal)).length;
    const cameraManufacturerHits = cameraManufacturerSignals.filter((signal) => lowered.includes(signal)).length;
    if (displayVendorHits >= 1 && serviceHits === 0) {
      return {
        category: "other",
        relevanceScore: 20,
        rationale: "Company description looks like a display, HMI, or optical product engineering vendor rather than a target software integrator."
      };
    }

    if (cameraManufacturerHits >= 2 && serviceHits === 0 && !lowered.includes("scanner") && !lowered.includes("digitization")) {
      return {
        category: "camera_manufacturer_partner",
        relevanceScore: 91,
        rationale: "Company description strongly matches an industrial camera manufacturer with partner-fit imaging products."
      };
    }

    if ((hardwareHits >= 2 || (mentionsImagingOrCamera && mentionsVendorOrHardware)) && serviceHits === 0 && machineProductHits < 2) {
      return {
        category: "camera_manufacturer_partner",
        relevanceScore: 90,
        rationale: "Company description strongly matches an industrial imaging or camera vendor without a clear delivery-led services profile."
      };
    }

    const visionDeliveryHits = visionDeliverySignals.filter((signal) => lowered.includes(signal)).length;
    const automationDeliveryHits = automationDeliverySignals.filter((signal) => lowered.includes(signal)).length;
    const machineBuilderHits = machineBuilderSignals.filter((signal) => lowered.includes(signal)).length;
    const productManufacturerHits = productManufacturerSignals.filter((signal) => lowered.includes(signal)).length;
    const municipalPlatformHits = municipalPlatformSignals.filter((signal) => lowered.includes(signal)).length;
    if (machineProductHits >= 3 && cameraManufacturerHits === 0 && (lowered.includes("imaging") || lowered.includes("system"))) {
      return {
        category: "machine_builder_ai_enablement",
        relevanceScore: 82,
        rationale: "Company description suggests a product vendor for scanners or inspection systems with AI-enableable product potential."
      };
    }

    const productizedSolutionHits = [
      "aoi system",
      "quality control system",
      "quality control systems",
      "inspection system",
      "inspection systems",
      "aoi machine",
      "aoi machines",
      "inspection machine",
      "inspection machines",
      "inspection station",
      "inspection stations",
      "plug & play",
      "plug and play",
      "subscription plan",
      "one-time purchase",
      "one time purchase",
      "rent one of our machines",
      "purchase price",
      "runs locally",
      "online/offline solution",
      "online solution",
      "offline solution",
      "connect your own machine",
      "use our api",
      "api integration"
    ].filter((signal) => lowered.includes(signal)).length;
    if (
      municipalPlatformHits >= 2 &&
      softwarePlatformHits >= 1 &&
      visionDeliveryHits === 0 &&
      automationDeliveryHits === 0 &&
      machineBuilderHits === 0
    ) {
      return {
        category: "other",
        relevanceScore: 22,
        rationale: "Company description looks like a municipal operations software platform rather than an industrial AI delivery integrator."
      };
    }

    if (
      simulationAndPlanningHits >= 1 &&
      visionDeliveryHits === 0 &&
      automationDeliveryHits === 0
    ) {
      return {
        category: "other",
        relevanceScore: 24,
        rationale: "Company description looks like simulation, planning, or digital-twin software rather than a ONE WARE-relevant AI integrator."
      };
    }

    if (
      genericEngineeringAgencyHits >= 2 &&
      visionDeliveryHits === 0 &&
      automationDeliveryHits === 0 &&
      machineBuilderHits === 0
    ) {
      return {
        category: "other",
        relevanceScore: 28,
        rationale: "Company description looks like a generic software, IoT, embedded, or cloud engineering agency rather than a focused AI integrator."
      };
    }

    const aoiPrimarySignals = [
      "aoi system", "aoi systems", "aoi machine", "aoi machines",
      "automated optical inspection", "automatische optische inspektion",
      "optical inspection system", "optical inspection systems",
      "optical inspection machine", "optical inspection machines",
      "inline inspection machine", "inline inspection system",
      "visual inspection machine", "visual inspection system",
      "vision inspection machine", "vision inspection system",
      "visual quality control machine", "visual quality control system",
      "machine vision product", "machine vision products",
      "machine vision system", "machine vision systems"
    ];
    const aoiPrimaryHits = aoiPrimarySignals.filter((s) => lowered.includes(s)).length;
    if (aoiPrimaryHits >= 1 && serviceHits === 0 && serviceDeliveryHits <= 1) {
      return {
        category: "machine_builder_vision_ai",
        relevanceScore: 86,
        rationale: "Company description matches a machine or system vendor whose primary product is Vision AI, automated optical inspection, or machine-vision quality control."
      };
    }

    if (
      productManufacturerHits >= 2 &&
      machineProductHits >= 1 &&
      visionDeliveryHits >= 1 &&
      serviceHits <= 1
    ) {
      return {
        category: aoiPrimaryHits >= 1 ? "machine_builder_vision_ai" : "machine_builder_ai_enablement",
        relevanceScore: 84,
        rationale: aoiPrimaryHits >= 1
          ? "Company description matches a productized Vision AI machine or inspection system vendor."
          : "Company description looks like a product manufacturer for scanning or inspection systems rather than a service-led integrator."
      };
    }

    if (machineBuilderHits >= 2 && (visionDeliveryHits >= 1 || automationDeliveryHits >= 1) && (serviceHits >= 1 || serviceDeliveryHits >= 1 || implementationStrengthHits >= 1)) {
      return {
        category: "machine_builder_ai_enablement",
        relevanceScore: 82,
        rationale: "Company description shows a machine-builder or OEM profile with industrial automation or vision delivery evidence and clear AI-upgrade potential."
      };
    }

    if (
      (machineBuilderHits >= 1 || productizedSolutionHits >= 3) &&
      (productOnlySignals.some((signal) => lowered.includes(signal)) || hardwareHits >= 1 || lowered.includes("machine") || lowered.includes("system")) &&
      visionDeliveryHits >= 1
    ) {
      return {
        category: "machine_builder_ai_enablement",
        relevanceScore: 79,
        rationale: "Company description looks closer to a productized AOI or OEM system supplier than to a service-led integrator."
      };
    }

    if ((specialistConsultingHits >= 1 || advisoryHits >= 1) && visionDeliveryHits >= 1 && (serviceHits >= 1 || serviceDeliveryHits >= 2 || implementationStrengthHits >= 1)) {
      const freelancerHits = ["freelancer", "freiberuf", "solo consultant", "independent consultant"].filter((signal) => lowered.includes(signal)).length;
      return {
        category: freelancerHits >= 1 ? "integrator_vision_ai_freelancer" : "integrator_vision_ai_consulting",
        relevanceScore: 86,
        rationale: freelancerHits >= 1
          ? "Company description shows hands-on machine-vision or industrial AI freelance delivery for clients."
          : "Company description shows hands-on machine-vision or industrial AI consulting delivery for clients."
      };
    }

    if (aiConsultancyHits >= 2 && visionDeliveryHits >= 1 && (implementationStrengthHits >= 1 || serviceDeliveryHits >= 2)) {
      return {
        category: "integrator_vision_ai_consulting",
        relevanceScore: 85,
        rationale: "Company description shows an AI consultancy with explicit computer-vision delivery and customer implementation ownership."
      };
    }

    if (serviceHits >= 1 && visionDeliveryHits >= 1) {
      return {
        category: "integrator_vision_industrial_ai",
        relevanceScore: 88,
        rationale: "Company description shows clear machine-vision or inspection delivery ownership for customer projects."
      };
    }

    if (serviceHits >= 1 && automationDeliveryHits >= 1) {
      return {
        category: "integrator_general_ai",
        relevanceScore: 84,
        rationale: "Company description shows service-led industrial software or automation implementation ownership."
      };
    }

    if (
      serviceDeliveryHits >= 2 &&
      industrialHits >= 1 &&
      automationDeliveryHits === 0 &&
      visionDeliveryHits === 0 &&
      machineBuilderHits === 0 &&
      softwarePlatformHits === 0
    ) {
      return {
        category: "integrator_relevant_focus",
        relevanceScore: 74,
        rationale: "Company description suggests project delivery in a relevant vertical, but broad AI integrator evidence is limited."
      };
    }

    const softwareToolVendorHits = softwareToolVendorSignals.filter((signal) => lowered.includes(signal)).length;
    if (softwareToolVendorHits >= 2 && serviceHits === 0 && automationDeliveryHits === 0 && visionDeliveryHits === 0) {
      return {
        category: "other",
        relevanceScore: 18,
        rationale: "Company description looks like a software tooling or runtime product vendor rather than a delivery-led integrator."
      };
    }

    if (advisoryHits >= 3 && implementationStrengthHits < 2 && automationDeliveryHits === 0 && visionDeliveryHits === 0 && serviceDeliveryHits < 4) {
      return {
        category: "irrelevant",
        relevanceScore: 18,
        rationale: "Company description looks more like advisory, training, or transformation consulting than a target implementation partner."
      };
    }

    if (
      serviceDeliveryHits >= 2 &&
      genericEngineeringAgencyHits >= 2 &&
      visionDeliveryHits === 0 &&
      automationDeliveryHits === 0 &&
      industrialHits === 0
    ) {
      return {
        category: "other",
        relevanceScore: 30,
        rationale: "Company description suggests a broad engineering agency, not a focused AI delivery integrator for ONE WARE."
      };
    }

    if (serviceDeliveryHits >= 2 && (lowered.includes("software") || lowered.includes("ai") || lowered.includes("data") || lowered.includes("engineering"))) {
      return {
        category: "integrator_general_ai",
        relevanceScore: 80,
        rationale: "Company description shows delivery-led software, data, or AI engineering services with customer implementation ownership."
      };
    }

    if (softwarePlatformHits >= 2 && (serviceHits === 0 && serviceDeliveryHits === 0 || negatesServiceLedModel) && nonIndustrialHits === 0) {
      return {
        category: "software_platform_embedding",
        relevanceScore: 82,
        rationale: "Company description looks like an industrial software platform or developer-tool business with partner or embedding potential."
      };
    }

    const rejectedFeedback = learning?.companyFeedback.find(
      (entry) => entry.verdict === "reject" && lowered.includes(entry.companyName.toLowerCase())
    );

    if (rejectedFeedback) {
      return {
        category: "irrelevant",
        relevanceScore: 3,
        rationale: `Previously rejected by operator feedback: ${rejectedFeedback.reason}`
      };
    }

    return null;
  }

  private buildLearningContext(learning: LeadLearningData): string | undefined {
    const rejectedCompanies = learning.companyFeedback
      .filter((entry) => entry.verdict === "reject")
      .slice(0, 10)
      .map((entry) => `${entry.companyName}: ${entry.reason}`);

    const positiveArchetypes = [
      "Positive archetypes: delivery-led industrial software, automation, AI, or integration firms with recurring implementation ownership.",
      "Typical positive evidence: customer project delivery, industrial inspection or production software relevance, feasibility studies, integration, commissioning, image processing, AOI, smart factory, or embedded computer vision implementation."
    ];

    if (rejectedCompanies.length === 0) {
      return positiveArchetypes.join("\n");
    }

    return [
      ...positiveArchetypes,
      "Learned rejects:",
      ...rejectedCompanies.map((item) => `- ${item.split(": ").slice(1).join(": ") || item}`)
    ].join("\n");
  }

  private async runChat(messages: ChatMessage[], options: RunChatOptions = {}): Promise<string> {
    this.enforceCostBudget();
    const deployment = options.deployment ?? env.AZURE_OPENAI_DEPLOYMENT;
    const url = `${env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${deployment}/chat/completions?api-version=${env.AZURE_OPENAI_API_VERSION}`;
    let response: Response | undefined;
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_AZURE_RETRIES; attempt += 1) {
      try {
        await azureChatRateLimiter.acquire();
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "api-key": env.AZURE_OPENAI_API_KEY as string
          },
          body: JSON.stringify({
            messages,
            temperature: 0,
            max_completion_tokens: options.maxTokens,
            response_format: { type: "json_object" }
          }),
          signal: AbortSignal.timeout(AZURE_REQUEST_TIMEOUT_MS)
        });
      } catch (error) {
        lastError = error;
        if (!this.isRetryableAzureError(error) || attempt === MAX_AZURE_RETRIES) {
          throw error;
        }

        await this.delay(AZURE_RETRY_DELAYS_MS[attempt] ?? AZURE_RETRY_DELAYS_MS[AZURE_RETRY_DELAYS_MS.length - 1] ?? 30000);
        continue;
      }

      if (response.ok) {
        azureChatRateLimiter.updateLimitFromHeader(response.headers.get("x-ratelimit-limit-requests"));
        break;
      }

      if (!this.isRetryableAzureStatus(response.status) || attempt === MAX_AZURE_RETRIES) {
        const errorText = await response.text();
        throw new Error(`Azure OpenAI request failed: ${response.status} ${errorText}`);
      }

      const retryDelayMs = this.resolveAzureRetryDelayMs(response, attempt);
      if (response.status === 429) {
        // Quota exhausted for this minute — make every concurrent caller wait the window out
        // together instead of repeatedly re-hitting the throttled deployment.
        azureChatRateLimiter.registerThrottle(retryDelayMs);
      }
      await this.delay(retryDelayMs);
    }

    if (!response?.ok) {
      if (lastError instanceof Error) {
        throw lastError;
      }

      throw new Error("Azure OpenAI request failed without a usable response.");
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };

    this.usageTotals.requests += 1;
    this.usageTotals.promptTokens += payload.usage?.prompt_tokens ?? 0;
    this.usageTotals.completionTokens += payload.usage?.completion_tokens ?? 0;
    this.usageTotals.totalTokens += payload.usage?.total_tokens ?? 0;
    this.usageTotals.estimatedCostUsd +=
      ((payload.usage?.prompt_tokens ?? 0) / 1000) * azureOpenAICostConfig.inputCostPer1kTokens +
      ((payload.usage?.completion_tokens ?? 0) / 1000) * azureOpenAICostConfig.outputCostPer1kTokens;
    this.enforceCostBudget();

    const content = payload.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("Azure OpenAI returned no content.");
    }

    return content;
  }

  private async runChatWithTimeout(messages: ChatMessage[], options: RunChatOptions, timeoutMs: number, label: string): Promise<string> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.runChat(messages, options),
        new Promise<string>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`${label} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private enforceCostBudget(): void {
    const maxCostUsd = azureOpenAICostConfig.maxCostUsd;
    if (maxCostUsd <= 0) {
      return;
    }

    if (this.usageTotals.estimatedCostUsd >= maxCostUsd) {
      throw new Error(
        `Azure OpenAI cost limit reached: ${this.usageTotals.estimatedCostUsd.toFixed(4)} >= ${maxCostUsd.toFixed(4)} budget units.`
      );
    }
  }

  private isRetryableAzureStatus(status: number): boolean {
    return status === 408 || status === 409 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  }

  private isRetryableAzureError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return error.name === "AbortError" || error.name === "TimeoutError" || /fetch failed/i.test(error.message);
  }

  private resolveAzureRetryDelayMs(response: Response, attempt: number): number {
    const retryAfterMsHeader = response.headers.get("retry-after-ms");
    const retryAfterHeader = response.headers.get("retry-after");

    const retryAfterMs = retryAfterMsHeader ? Number.parseInt(retryAfterMsHeader, 10) : Number.NaN;
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      return retryAfterMs;
    }

    const retryAfterSeconds = retryAfterHeader ? Number.parseFloat(retryAfterHeader) : Number.NaN;
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      return Math.ceil(retryAfterSeconds * 1000);
    }

    return AZURE_RETRY_DELAYS_MS[attempt] ?? AZURE_RETRY_DELAYS_MS[AZURE_RETRY_DELAYS_MS.length - 1] ?? 30000;
  }

  private parseJsonObject<T>(content: string): T {
    const normalizedContent = content.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();

    try {
      return JSON.parse(normalizedContent) as T;
    } catch {
      const objectStart = normalizedContent.indexOf("{");
      const objectEnd = normalizedContent.lastIndexOf("}");

      if (objectStart >= 0 && objectEnd > objectStart) {
        return JSON.parse(normalizedContent.slice(objectStart, objectEnd + 1)) as T;
      }

      throw new Error(`Azure OpenAI returned invalid JSON: ${normalizedContent}`);
    }
  }

  private buildWebsiteClassificationMessages(
    name: string,
    domain: string | undefined,
    compactWebsiteSummary: string,
    mainContext?: string,
    prequalification?: PrequalificationConfig,
    learning?: LeadLearningData,
    compactMode = false
  ): ChatMessage[] {
    const compactWebsiteContext = [
      "# Website Task\nClassify the company only from its own crawled website pages.",
      "# Website Page Type Gate\nFirst confirm the crawled pages are the self-owned site of ONE single operating company. If instead they are a company directory/business-listing/register/regional-or-industry overview page that lists many firms, a news/press/magazine/blog-portal/editorial page, or a file-sharing/file-hosting/cloud-storage/download/asset-CDN page, classify the company as irrelevant regardless of any company, AI, or industrial keywords on the page. A page that profiles or lists multiple companies, publishes articles, or only hosts files is never a qualifiable company.",
      "# Website Decision Rules\nIf the website mainly sells external customer project delivery, choose an integrator category. If it mainly sells its own shipped software product or diagnostic plugin, choose machine_builder_ai_enablement. If it mainly sells a platform or runtime where customers deploy apps, modules, agents, or workflows, choose software_platform_embedding.",
      "# Website Specific Reminders\nA certified PACS/viewer-integrated medical plugin is machine_builder_ai_enablement. A runtime, turnkey appliance, or app-lifecycle platform for OEM digital services is software_platform_embedding even if PLC, OPC UA, MQTT, SCADA, MES, remote operations, or system integration is mentioned. If the product lets customers launch industrial apps without building the integration stack themselves, prefer software_platform_embedding. A closed municipal or route-planning platform stays other unless customers clearly build on top of it. Broad engineering or MBSE-style capability pages without explicit AI, automation, MES/SCADA, inspection, or embeddable product/platform proof should stay other. Research institutes, Fraunhofer-style institutes, universities, labs, clusters, and publicly funded competence centers are not integrators or customer delivery partners unless the website clearly sells commercial external implementation services as the main business model.",
      "# Country Rule\nAlso determine the company's headquarters country from the website's own evidence only: a registered office or postal address, an 'impressum'/'legal notice', a 'headquartered in' statement, or an international phone dialing code (e.g. +49 Germany, +43 Austria, +41 Switzerland, +31 Netherlands, +1 United States, +972 Israel, +86 China). Return the English country name. Do NOT infer the country from the domain TLD, the website language, or any supplied hint. If the website shows no reliable country evidence, return an empty string for country. A US/non-European company must be reported with its real country even when the page is in German or English.",
      "# Output Reminder\nChoose the closest archetype across all categories. Do not prefer integrators when the fit path is ambiguous. Respond with a JSON object: {\"category\": string, \"relevanceScore\": number, \"rationale\": string, \"country\": string}."
    ].join("\n\n");


    const fullWebsiteContext = [
      compactWebsiteContext,
      "# Website Examples\nExample 1: a company that develops certified radiology AI software integrated as plug-ins into PACS or viewer workstations is machine_builder_ai_enablement.\nExample 2: a vendor that packages digital services as apps, deploys them across many customer sites via a runtime or turnkey appliance, and manages updates or monetization is software_platform_embedding.\nExample 3: a municipal operations cloud for waste, winter service, or route planning with rollout help but no open extension surface is other.\nExample 4: a general engineering services site with MBSE, requirements engineering, or hardware/software development pages but no explicit fit-path proof is other.\nExample 5: a Fraunhofer-style institute, university lab, or research center with projects, publications, grants, consortium work, or transfer activities but no clear commercial implementation-service offering is irrelevant or other, not an integrator."
    ].join("\n\n");

    return [
      {
        role: "system",
        content: [
          QUICK_QUALIFICATION_CONTEXT,
          buildPrequalificationContextBlock(prequalification, undefined, mainContext),
          compactMode ? compactWebsiteContext : fullWebsiteContext
        ].join("\n\n")
      },
      {
        role: "user",
        content: [
          `Company=${name}`,
          domain ? `Website=${domain}` : undefined,
          `Crawled website evidence=${compactWebsiteSummary}`,
          prequalification?.mainContext ? `Prequalification main context=${prequalification.mainContext}` : undefined,
          learning ? this.buildLearningContext(learning) : undefined
        ]
          .filter(Boolean)
          .join("\n")
      }
    ];
  }

  private buildLearningContextForSearchStrategy(learning?: LeadLearningData): string | undefined {
    if (!learning) {
      return undefined;
    }

    const modeSections = Object.entries(learning.searchHistoryByMode ?? {})
      .filter(([, modeLearning]) => modeLearning && (modeLearning.searchHistory.length > 0 || Object.keys(modeLearning.filterPerformance).length > 0))
      .map(([mode, modeLearning]) => {
        const latestHistoryByName = new Map(
          modeLearning.searchHistory
            .filter((entry) => entry.filterSnapshot)
            .map((entry) => [entry.filterName, entry])
        );

        const topFilters = Object.entries(modeLearning.filterPerformance)
          .sort((left, right) => {
            const leftHasSnapshot = latestHistoryByName.has(left[0]) ? 1 : 0;
            const rightHasSnapshot = latestHistoryByName.has(right[0]) ? 1 : 0;
            if (rightHasSnapshot !== leftHasSnapshot) {
              return rightHasSnapshot - leftHasSnapshot;
            }

            return right[1].averageRelevanceRatio - left[1].averageRelevanceRatio;
          })
          .slice(0, MAX_FILTER_STRATEGY_HISTORY)
          .map(([name, stats]) => {
            const snapshot = latestHistoryByName.get(name)?.filterSnapshot;
            return [
              `${name}: avg ${(stats.averageRelevanceRatio * 100).toFixed(0)}%, runs ${stats.runs}, early stops ${stats.earlyStopCount}`,
              snapshot ? `  Snapshot: ${this.formatFilterSnapshot(snapshot)}` : undefined
            ]
              .filter(Boolean)
              .join("\n");
          });

        const recentHistory = modeLearning.searchHistory
          .slice()
          .sort((left, right) => Number(Boolean(right.filterSnapshot)) - Number(Boolean(left.filterSnapshot)))
          .slice(0, MAX_FILTER_STRATEGY_HISTORY)
          .map((entry) => [
            `${entry.filterName} | ${entry.batchType} | ${entry.relevantCount}/${entry.returnedCount} relevant | ${(entry.relevanceRatio * 100).toFixed(0)}% | ${entry.recommendation}`,
            entry.fetchedSampleCount !== undefined
              ? `  Prefilter: fetched ${entry.fetchedSampleCount}, eligible ${entry.eligibleSampleCount ?? entry.returnedCount}, rejected feedback ${entry.dropOffSummary?.filteredByPriorFeedback ?? 0}, cache ${entry.dropOffSummary?.filteredByCache ?? 0}, hubspot ${entry.dropOffSummary?.filteredByHubSpot ?? 0}`
              : undefined,
            entry.discoveryQueries && entry.discoveryQueries.length > 0
              ? `  Queries: ${entry.discoveryQueries.join(" || ")}`
              : undefined,
            `  Categories: ${Object.entries(entry.categoryBreakdown ?? {}).filter(([, count]) => count > 0).map(([category, count]) => `${category}=${count}`).join(", ") || "none"}`,
            entry.decisionSamples && entry.decisionSamples.length > 0
              ? `  Decisions: ${entry.decisionSamples.slice(0, 3).map((sample) => `${sample.companyName} => ${sample.category} (${sample.relevanceScore}) because ${sample.rationale}`).join(" || ")}`
              : undefined,
            entry.filterSnapshot ? `  Snapshot: ${this.formatFilterSnapshot(entry.filterSnapshot)}` : undefined
          ].filter(Boolean).join("\n"));

        return [
          `Backend ${mode}:`,
          topFilters.length > 0 ? ["Known filter performance:", ...topFilters].join("\n") : undefined,
          recentHistory.length > 0 ? ["Recent search history:", ...recentHistory].join("\n") : undefined
        ].filter(Boolean).join("\n\n");
      });

    return modeSections.length > 0 ? modeSections.join("\n\n") : undefined;
  }

  private formatFilterSnapshot(snapshot: {
    persona: string;
    industries: string[];
    keywords: string[];
    locations: string[];
    employeeRanges: string[];
    notes: string;
  }): string {
    return [
      `Persona=${snapshot.persona}`,
      `Industries=${snapshot.industries.join(", ")}`,
      `Keywords=${snapshot.keywords.join(", ")}`,
      `Locations=${snapshot.locations.join(", ")}`,
      `Employees=${snapshot.employeeRanges.join(", ")}`,
      `Notes=${snapshot.notes}`
    ].join(" | ");
  }

  private normalizeOrganizationFilter(filter: OrganizationFilter | undefined): OrganizationFilter | null {
    if (!filter) {
      return null;
    }

    const industries = this.normalizeStringList(filter.industries, 6);
    const keywords = this.normalizeStringList(filter.keywords, 8);
    const locations = this.normalizeStringList(filter.locations, 6);
    const employeeRanges = this.normalizeStringList(filter.employeeRanges, 6);

    if (!filter.name?.trim() || !filter.persona?.trim() || industries.length === 0 || keywords.length === 0 || locations.length === 0) {
      return null;
    }

    return {
      name: filter.name.trim(),
      persona: filter.persona.trim(),
      industries,
      keywords,
      locations,
      employeeRanges: employeeRanges.length > 0 ? employeeRanges : ["11,50", "51,200", "201,500"],
      targetCategories: this.normalizeTargetCategories(filter.targetCategories),
      notes: filter.notes?.trim() || "Adaptive Azure search strategy"
    };
  }

  private normalizeTargetCategories(categories: LeadCategory[] | undefined): LeadCategory[] | undefined {
    const normalized = Array.from(
      new Set(
        (categories ?? [])
          .map((category) => this.normalizeCategory(category))
          .filter((category) => category !== "irrelevant" && category !== "other")
      )
    );

    return normalized.length > 0 ? normalized : undefined;
  }

  private normalizeStringList(values: string[] | undefined, maxItems: number): string[] {
    return Array.from(
      new Set(
        (values ?? [])
          .map((value) => value?.trim())
          .filter((value): value is string => Boolean(value))
      )
    ).slice(0, maxItems);
  }

  private normalizeCategory(category: string): LeadCategory {
    const normalizedCategory = category.trim().toLowerCase();

    const aliases: Array<[LeadCategory, string[]]> = [
      ["integrator_vision_industrial_ai", ["integrator_vision_industrial_ai", "software_integrator", "ai_software_integrator", "vision ai integrator", "industrial software / ai delivery integrator", "delivery integrator", "software integrator"]],
      ["integrator_vision_ai_consulting", ["integrator_vision_ai_consulting", "integrator_vision_ai_consulting_freelancer", "vision ai consulting", "vision ai consultant", "computer vision consultant", "industrial ai consulting", "industrial ai consultant", "embedded vision consultant"]],
      ["integrator_vision_ai_freelancer", ["integrator_vision_ai_freelancer", "vision ai freelancer", "computer vision freelancer", "embedded vision freelancer", "industrial ai freelancer"]],
      ["integrator_general_ai", ["integrator_general_ai", "ai integrator", "ai delivery integrator", "general ai integrator"]],
      ["integrator_relevant_focus", ["integrator_relevant_focus", "vertical integrator", "relevant industry integrator", "defence integrator", "surveillance integrator"]],
      ["industrial_end_customer_scaled", ["industrial_end_customer_scaled", "industrial_end_customer", "scaled industrial customer", "industrial customer"]],
      ["camera_manufacturer_partner", ["camera_manufacturer_partner", "industrial_camera_vendor_without_ai_software", "industrial camera vendor", "industrial_camera_vendor", "industrial camera/vendor", "industrial_vision_vendor"]],
      ["machine_builder_ai_enablement", ["machine_builder_ai_enablement", "machine_builder_with_vision_ai_need", "machine_builder", "machine_builder_oem", "potential_fit"]],
      ["machine_builder_vision_ai", ["machine_builder_vision_ai", "machine_builder_with_existing_vision_ai", "vision_ai_machine_builder", "aoi_machine_builder", "inspection_machine_builder"]],
      ["software_platform_embedding", ["software_platform_embedding", "platform embedding", "software platform partner", "roboflow-like"]],
      ["irrelevant", ["irrelevant", "reject", "direct_competitor"]],
      ["other", ["other"]]
    ];

    for (const [targetCategory, values] of aliases) {
      if (values.includes(normalizedCategory)) {
        return targetCategory;
      }
    }

    return "other";
  }

  private buildFallbackResearchBrief(
    company: PreCategorizedCompany,
    template: ReturnType<typeof getTemplateForCategory>,
    executionContext: string,
    mainContext?: string,
    citations?: string[]
  ): ResearchBrief {
    const likelyGermanSpeaking = this.isLikelyGermanSpeaking(company);
    const outreachLanguage = likelyGermanSpeaking ? "de" as const : "en" as const;
    const localizedTemplate = this.localizeTemplate(template, outreachLanguage);
    const rankings = this.estimateRankings(company.category);
    const businessPotentialEUR = this.estimateBusinessPotentialEUR(company.category, company.shortDescription);

    return {
      companyName: company.name,
      appliedAgentContext: mainContext,
      isFallback: true,
      citations: citations?.length ? citations : company.domain ? [company.domain] : [],
      overview: `${company.name} appears relevant based on its positioning around ${company.shortDescription.toLowerCase()}.`,
      qualificationSummary: "Potential fit for ONE WARE where faster Vision-AI delivery and reduced trial-and-error are commercially relevant.",
      qualifyingSignals: [
        `Category fit: ${company.category}`,
        `Source filter: ${company.sourceFilter}`,
        `Target region bias: ${TARGET_REGIONS[0]} first, then wider EU/US/JP/KR.`,
        `Execution context applied: ${executionContext.split("\n")[0]}`
      ],
      riskFlags: ["Needs manual verification against direct competing own Vision AI software before outreach."],
      likelyGermanSpeaking,
      outreachLanguage,
      rankings,
      businessPotentialEUR,
      businessPotentialReasoning: this.buildBusinessPotentialReasoning(company.category, businessPotentialEUR),
      targetIndustry: this.estimateTargetIndustry(company.category),
      productsOffered: this.estimateProductsOffered(company.category),
      recommendedTemplateKey: localizedTemplate.key,
      personalizationRule: "Keep the template structure and personalize only if there is a clear factual hook in the company description.",
      linkedInAngle: "Use a short question around delivery bottlenecks, not a generic compliment.",
      linkedInConnectionRequest: localizedTemplate.linkedInConnectionRequest,
      emailAngle: "Keep ONE WARE USP visible: less trial and error, faster delivery, lower development effort.",
      phoneAngle: "Lead with the operational bottleneck, not platform features.",
      linkedInMessage: localizedTemplate.linkedInMessage,
      emailSubject: localizedTemplate.subject,
      emailBody: localizedTemplate.emailBody,
      phoneScript: localizedTemplate.phoneScript,
      eventIdea: "Check for presence at SPS, Automatica, Vision, or regional automation events."
    };
  }

  private isLikelyGermanSpeaking(company: Pick<PreCategorizedCompany, "country" | "domain" | "name">): boolean {
    const normalizedCountry = company.country?.trim().toLowerCase();
    if (["germany", "austria", "switzerland", "de", "at", "ch"].includes(normalizedCountry ?? "")) {
      return true;
    }

    const normalizedDomain = company.domain?.trim().toLowerCase() ?? "";
    if (normalizedDomain.includes(".de") || normalizedDomain.includes(".at") || normalizedDomain.includes(".ch")) {
      return true;
    }

    return /[äöüß]/i.test(company.name);
  }

  private localizeTemplate(template: ReturnType<typeof getTemplateForCategory>, language: "de" | "en") {
    if (language === "de") {
      return template;
    }

    const englishVariants: Record<string, { subject: string; emailBody: string; linkedInConnectionRequest: string; linkedInMessage: string; phoneScript: string }> = {
      integrator_vision_industrial_ai_template: {
        subject: "Solving difficult Vision AI applications",
        emailBody: "Hello [Name],\n\nI saw that you work on computer vision projects.\n\nWe develop a technology for Vision AI applications where standard approaches reach their limits, for example with small datasets, very small objects or limited compute on edge hardware.\n\nInstead of fine-tuning existing foundation models and optimizing the application around a fixed model, our technology generates a tailored AI model with an individual architecture for each use case. This creates additional solution options when known models do not deliver the required accuracy, speed or efficiency.\n\nIn a joint whitepaper with chip manufacturer Altera, we show for example that models can be generated that run over 1000x faster while producing 24x fewer errors than conventional approaches.\n\nDo you currently have challenges in Vision AI applications or noticed that conventional approaches are reaching their limits?\n\nBest regards,\n[Your Name]",
        linkedInConnectionRequest: "Hi [Name], I'm Leon from ONE WARE. I saw that you work on computer vision projects. We're working on making difficult Vision AI applications easier to solve.",
        linkedInMessage: "Hi [Name], thanks for connecting.\n\nI saw that you work on computer vision projects. In some Vision AI applications, standard approaches quickly reach their limits, for example with small datasets, very small objects, high accuracy requirements or limited compute on edge hardware.\n\nWe have developed a technology where the application does not need to be optimized around an existing model. Instead, a suitable AI model is generated automatically for the specific use case, available data and target hardware.\n\nThis is especially useful when foundation models or classical computer vision approaches do not deliver the required accuracy, speed or efficiency.\n\nDo you currently have projects where existing models are reaching their limits?",
        phoneScript: "Hello Mr./Ms. [Name], this is [Your Name] from ONE WARE. I wanted to ask whether you currently implement Vision AI applications for customers or have experience in that area. We provide software that creates production-ready Vision AI models much faster. Because we cannot cover every integration and consulting project ourselves, we are also exploring partnerships with experienced specialists. Would that be interesting for you?"
      },
      integrator_vision_ai_consulting_template: {
        subject: "Deliver consulting-led vision-AI projects faster",
        emailBody: "Hello Mr./Ms. [Name],\n\nIf you advise customers on vision AI, you probably know the situation: the idea is clear, but model choice, data quality, and repeated iterations consume far more time than expected.\n\nWith ONE WARE we have a new approach that can generate production-ready vision-AI models very quickly from available data. That makes it easier to recommend a concrete path forward to customers, even when the dataset is not perfect.\n\nWe have already seen customers use this kind of efficient and accurate AI to automate several steps instead of only one. For consultancies this is valuable because it becomes a strong solution element for client work, and when it fits we can also bring relevant end-customer opportunities.\n\nWould you be open to a short exchange to see whether this could fit your client projects?\n\nBest regards,\n[Your Name]",
        linkedInConnectionRequest: "Quick question: are you already advising customers on vision AI? We have a new approach that gets to strong models much faster.",
        linkedInMessage: "Quick question: are you already advising customers on vision AI? We have a new approach that can get to strong models much faster and can work well as an additional solution for client projects.",
        phoneScript: "Hello Mr./Ms. [Name], this is [Your Name] from ONE WARE. I wanted to ask whether you already implement vision-AI applications for clients or have strong experience there. We provide software that gets production-ready vision-AI models much faster. Since we cannot take on every integration and consulting project ourselves, we are looking for partners for joint delivery where it fits. Would that be relevant for you?"
      },
      integrator_vision_ai_freelancer_template: {
        subject: "Solving difficult Vision AI applications",
        emailBody: "Hello [Name],\n\nI saw that you work on computer vision projects.\n\nWe develop a technology for Vision AI applications where standard approaches reach their limits, for example with small datasets, very small objects or limited compute on edge hardware.\n\nInstead of fine-tuning existing foundation models and optimizing the application around a fixed model, our technology generates a tailored AI model with an individual architecture for each use case. This creates additional solution options when known models do not deliver the required accuracy, speed or efficiency.\n\nIn a joint whitepaper with chip manufacturer Altera, we show for example that models can be generated that run over 1000x faster while producing 24x fewer errors than conventional approaches.\n\nDo you currently have challenges in Vision AI applications or noticed that conventional approaches are reaching their limits?\n\nBest regards,\n[Your Name]",
        linkedInConnectionRequest: "Hi [Name], I'm Leon from ONE WARE. I saw that you work on computer vision projects. We're working on making difficult Vision AI applications easier to solve.",
        linkedInMessage: "Hi [Name], thanks for connecting.\n\nI saw that you work on computer vision projects. In some Vision AI applications, standard approaches quickly reach their limits, for example with small datasets, very small objects, high accuracy requirements or limited compute on edge hardware.\n\nWe have developed a technology where the application does not need to be optimized around an existing model. Instead, a suitable AI model is generated automatically for the specific use case, available data and target hardware.\n\nThis is especially useful when foundation models or classical computer vision approaches do not deliver the required accuracy, speed or efficiency.\n\nDo you currently have projects where existing models are reaching their limits?",
        phoneScript: "Hello Mr./Ms. [Name], this is [Your Name] from ONE WARE. I wanted to ask whether you currently implement Vision AI applications for customers or have experience in that area. We provide software that creates production-ready Vision AI models much faster. Because we cannot cover every integration and consulting project ourselves, we are also exploring partnerships with experienced specialists. Would that be interesting for you?"
      },
      integrator_general_ai_template: {
        subject: "Vision AI without long optimization cycles",
        emailBody: "Hello Mr./Ms. [Name],\n\nare you already implementing Vision AI projects or receiving related requests from customers?\n\nWe have developed a new technology that makes Vision AI applications much faster to implement. Instead of investing a lot of time in model selection, fine-tuning and optimization, suitable AI models can be generated automatically for specific applications.\n\nThis also makes it possible to address projects where universal AI models are too expensive, too slow or not accurate enough.\n\nIn a joint whitepaper with chip manufacturer Altera, we show for example that models can be generated that run over 1000x faster while producing 24x fewer errors than conventional approaches.\n\nIf this sounds interesting, I would be happy to have a short exchange.\n\nBest regards,\n[Your Name]",
        linkedInConnectionRequest: "Hi [Name], I'm Leon from ONE WARE. I saw that you work on AI projects. We're working on making Vision AI development easier.",
        linkedInMessage: "Hi [Name], thanks for connecting.\n\nI saw that you work on AI projects. With Vision AI, we often see that the use cases are promising, but development quickly becomes much more complex than in typical AI projects. It is not just about the model, but also about data, accuracy, optimization and deployment on the target hardware.\n\nWe have therefore developed a technology where the application does not need to be optimized around an existing AI model. Instead, a suitable model is generated automatically for the specific use case and available hardware.\n\nThis makes Vision AI projects faster to test and easier to implement, even without a long ML optimization process.\n\nIs Vision AI currently a topic for you?",
        phoneScript: "Hello Mr./Ms. [Name], this is [Your Name] from ONE WARE. I wanted to ask whether you already implement Vision AI projects for customers or receive such requests. We provide software that makes Vision AI models production-ready much faster. Since we cannot deliver every integration and consulting project ourselves, we are speaking with partners where collaboration could make sense. Would that be interesting for you?"
      },
      integrator_relevant_focus_template: {
        subject: "Deliver vision AI faster in demanding vertical projects",
        emailBody: "Hello Mr./Ms. [Name],\n\nI saw that you implement topics such as quality management and production control. Have you already had practical experience integrating vision AI for use cases such as quality inspection?\n\nThat is exactly where ONE WARE can be relevant. Our software creates task-specific vision-AI models much faster, with far less trial and error, and often in a way that also makes smaller or cheaper hardware setups realistic.\n\nFor integrators this is especially valuable because projects become easier to deliver and additional automation use cases often become economically feasible. And when it fits, we can also connect partners with concrete end-customer opportunities.\n\nWould a short exchange make sense to see whether this could fit your projects?\n\nBest regards,\n[Your Name]",
        linkedInConnectionRequest: "Quick question: have you already integrated vision AI in cases such as quality inspection? If yes, ONE WARE could be relevant.",
        linkedInMessage: "Quick question: have you already integrated vision AI in projects such as quality inspection? If yes, ONE WARE could help make that part much faster and more efficient.",
        phoneScript: "Hello Mr./Ms. [Name], this is [Your Name] from ONE WARE. I wanted to ask whether your team already implements vision-AI applications in customer projects or has relevant experience there. We provide software that gets production-ready vision-AI models much faster. Because we cannot cover every integration project ourselves, we are talking to specialized partners about joint delivery where it fits. Would that be interesting for your team?"
      },
      industrial_end_customer_scaled_template: {
        subject: "Make quality inspection and vision AI economically viable",
        emailBody: "Hello Mr./Ms. [Name],\n\nIn use cases like quality inspection, vision AI often makes perfect sense, but implementation through external engineering support can become too expensive or too time-consuming.\n\nWith ONE WARE, task-specific models can be created much faster and deployed on lower-cost hardware. That has already made projects possible with less effort and lower hardware cost than in classic setups.\n\nFor industrial teams this is especially relevant because our software license can be far more economical than repeatedly commissioning fully custom development from outside providers.\n\nIf helpful, we can look at a concrete quality-inspection or automation use case from your side and assess whether it could be a fit.\n\nBest regards,\n[Your Name]",
        linkedInConnectionRequest: "Quick question: are there quality-inspection or process-automation topics where vision AI would help, but implementation has been too much effort?",
        linkedInMessage: "Quick question: are there quality-inspection or process-automation topics where vision AI would help, but where implementation has simply been too expensive or too much effort so far? That is exactly where we can help.",
        phoneScript: "Hello Mr./Ms. [Name], this is [Your Name] from ONE WARE. I wanted to ask whether topics like quality inspection or process automation are currently relevant for you. We have seen that vision AI for these cases can often be implemented with much less effort and on lower-cost hardware than many teams expect. Would that be interesting for you?"
      },
      camera_manufacturer_partner_template: {
        subject: "Integrate vision AI into camera and imaging solutions faster",
        emailBody: "Hello Mr./Ms. [Name],\n\nIn imaging projects there are always customers where standard models are not good enough for the exact use case or where the available dataset is difficult. That is exactly when model selection and optimization start taking too long.\n\nWith ONE WARE, you can give customers an additional option that gets them to the right vision-AI model much faster. This is especially useful when customers need a tailored result and standard approaches are not enough.\n\nThat way, your customers get to a reliable outcome faster and vision AI becomes easier to offer as part of your solution stack.\n\nWould a short conversation make sense to see whether this could be relevant for your customer setups?\n\nBest regards,\n[Your Name]",
        linkedInConnectionRequest: "Quick question: do you also see customers where standard models are not enough or the dataset is difficult? That is where ONE WARE helps.",
        linkedInMessage: "Quick question: do you also have customers where standard models are not enough for the exact vision use case or where the dataset is difficult? That is exactly where ONE WARE can be valuable.",
        phoneScript: "Hello Mr./Ms. [Name], this is [Your Name] from ONE WARE. I wanted to ask whether you also see customer cases where standard models are not enough for the exact vision use case or where the dataset is difficult. That is exactly where ONE WARE can add value by helping customers reach the right model much faster. Would that be relevant for you?"
      },
      machine_builder_ai_enablement_template: {
        subject: "Integrate vision AI into machines and products more easily",
        emailBody: "Hello Mr./Ms. [Name],\n\nIn machine-building and product environments, there are often customer cases where a standard model does not perform well enough or where the available dataset is too small and too specific. That is exactly when the path to a strong vision-AI model starts taking far too long.\n\nWith ONE WARE, you can integrate an additional option that helps find the best-fitting model for the exact use case much faster. This is especially valuable when customers need a tailored solution and standard approaches are not enough.\n\nThat makes it easier to offer vision AI as a robust product feature or customer option.\n\nWould a short conversation make sense to explore whether this could be relevant for your product side?\n\nBest regards,\n[Your Name]",
        linkedInConnectionRequest: "Quick question: do you see customer cases where standard models are not enough or the dataset is difficult? That is where ONE WARE can help.",
        linkedInMessage: "Quick question: do you see customer cases where standard models are not enough for the concrete vision use case or where the dataset is difficult? That is exactly where ONE WARE can help.",
        phoneScript: "Hello Mr./Ms. [Name], this is [Your Name] from ONE WARE. I wanted to ask whether you have customer projects where standard models are not enough for the specific vision use case or where the dataset is difficult. With ONE WARE, teams can find the right model much faster and offer it as an additional option inside products or machines. Would that be relevant for you?"
      },
      software_platform_embedding_template: {
        subject: "Embeddable vision AI model engine for your platform",
        emailBody: "Hello Mr./Ms. [Name],\n\nWhen users work with vision AI on a platform, there are almost always cases where standard models are not good enough or where the dataset is difficult. That is exactly when model generation becomes the bottleneck.\n\nONE WARE can be embedded as an additional option so that users reach the best-fitting model for the specific use case much faster. This is especially valuable for platforms that want to offer more than a generic standard path.\n\nWould a short technical discussion make sense to see whether this could be relevant as an extension to your platform?\n\nBest regards,\n[Your Name]",
        linkedInConnectionRequest: "Quick question: do your users also hit cases where standard models are not enough or the dataset is difficult? ONE WARE could help there.",
        linkedInMessage: "Quick question: do your users also run into cases where standard models are not enough or the dataset is difficult? ONE WARE could be valuable as an additional model option for exactly those cases.",
        phoneScript: "Hello Mr./Ms. [Name], this is [Your Name] from ONE WARE. I wanted to ask whether your users also run into cases where standard models are not enough or the dataset is difficult. That is exactly where ONE WARE can work as an additional model option so users reach the best result faster. Would that be relevant for your platform?"
      }
    };

    const variant = englishVariants[template.key] ?? englishVariants.integrator_vision_industrial_ai_template;

    return {
      ...template,
      ...variant
    };
  }

  private estimateRankings(category: LeadCategory): ResearchBrief["rankings"] {
    switch (category) {
      case "integrator_vision_industrial_ai":
        return { customer: 4, serviceProvider: 10, partner: 5 };
      case "integrator_vision_ai_consulting":
        return { customer: 3, serviceProvider: 9, partner: 4 };
      case "integrator_vision_ai_freelancer":
        return { customer: 2, serviceProvider: 8, partner: 3 };
      case "integrator_general_ai":
        return { customer: 3, serviceProvider: 8, partner: 4 };
      case "integrator_relevant_focus":
        return { customer: 4, serviceProvider: 9, partner: 5 };
      case "industrial_end_customer_scaled":
        return { customer: 9, serviceProvider: 2, partner: 3 };
      case "camera_manufacturer_partner":
        return { customer: 2, serviceProvider: 3, partner: 10 };
      case "machine_builder_ai_enablement":
        return { customer: 5, serviceProvider: 2, partner: 9 };
      case "software_platform_embedding":
        return { customer: 2, serviceProvider: 4, partner: 9 };
      default:
        return { customer: 1, serviceProvider: 1, partner: 1 };
    }
  }

  private estimateBusinessPotentialEUR(category: LeadCategory, description: string): number {
    const lowered = description.toLowerCase();
    const multiUseCaseSignals = ["multiple", "portfolio", "platform", "series", "production line", "plants", "global", "oem"];
    const signalMultiplier = 1 + multiUseCaseSignals.filter((signal) => lowered.includes(signal)).length;

    switch (category) {
      case "integrator_vision_industrial_ai":
        return 20000 * signalMultiplier;
      case "integrator_vision_ai_consulting":
        return 12000 * signalMultiplier;
      case "integrator_vision_ai_freelancer":
        return 9000 * signalMultiplier;
      case "integrator_general_ai":
        return 14000 * signalMultiplier;
      case "integrator_relevant_focus":
        return 25000 * signalMultiplier;
      case "industrial_end_customer_scaled":
        return 40000 * signalMultiplier;
      case "camera_manufacturer_partner":
        return 150000 * signalMultiplier;
      case "machine_builder_ai_enablement":
        return 250000 * signalMultiplier;
      case "software_platform_embedding":
        return 120000 * signalMultiplier;
      default:
        return 7000;
    }
  }

  private buildBusinessPotentialReasoning(category: LeadCategory, businessPotentialEUR: number): string {
    const reasoningByCategory: Record<LeadCategory, string> = {
      integrator_vision_industrial_ai: "Service-provider fit with recurring project delivery and room for multiple production-ready AI use cases.",
      integrator_vision_ai_consulting: "Specialist consulting fit where ONE WARE can increase throughput for a delivery team handling custom client work.",
      integrator_vision_ai_freelancer: "Freelance specialist fit where ONE WARE can reduce manual tuning overhead for solo delivery work.",
      integrator_general_ai: "General AI integrator with likely upsell into vision projects, but less concentrated than explicit vision specialists.",
      integrator_relevant_focus: "Vertical-specialist integrator where a few critical use cases can justify higher per-AI value.",
      industrial_end_customer_scaled: "Industrial end-customer value driven by multiple inspection or automation use cases and higher production impact.",
      camera_manufacturer_partner: "Partner-scale opportunity where ONE WARE can enable repeated customer deployments through the hardware vendor.",
      machine_builder_ai_enablement: "Machine-builder or productized Vision-AI opportunity where better model generation can improve shipped products and downstream deployments.",
      machine_builder_vision_ai: "Vision-AI machine builder where ONE WARE can improve model accuracy, handle difficult datasets, and enable customer-specific model variants for existing inspection or quality-control machines.",
      software_platform_embedding: "Platform opportunity with partner leverage across many users or embedded workflows.",
      irrelevant: "Low-fit profile; value estimate remains minimal.",
      other: "Mixed profile; estimate remains conservative until fit is clearer."
    };

    return `${reasoningByCategory[category]} Estimated at about EUR ${businessPotentialEUR.toLocaleString("en-US")}.`;
  }

  private estimateTargetIndustry(category: LeadCategory): string {
    switch (category) {
      case "integrator_vision_industrial_ai":
      case "integrator_vision_ai_consulting":
      case "integrator_vision_ai_freelancer":
      case "integrator_general_ai":
      case "integrator_relevant_focus":
        return "Industrial automation, robotics, machine vision, and AI project delivery";
      case "industrial_end_customer_scaled":
        return "Manufacturing, quality inspection, and process automation";
      case "camera_manufacturer_partner":
        return "Industrial imaging, machine vision, and camera manufacturing";
      case "machine_builder_ai_enablement":
        return "Machinery, OEM equipment, and industrial production systems";
      case "software_platform_embedding":
        return "Vision software platforms, developer tools, and workflow platforms";
      default:
        return "Unclear";
    }
  }

  private estimateProductsOffered(category: LeadCategory): string {
    switch (category) {
      case "integrator_vision_industrial_ai":
        return "Vision AI integration projects, industrial AI deployment, custom software delivery";
      case "integrator_vision_ai_consulting":
        return "Specialist consulting, feasibility work, prototype delivery, and customer-specific vision AI implementation";
      case "integrator_vision_ai_freelancer":
        return "Freelance implementation, feasibility work, prototype delivery, and customer-specific vision AI support";
      case "integrator_general_ai":
        return "AI delivery services, software implementation, applied ML projects";
      case "integrator_relevant_focus":
        return "Vertical-specific AI/vision systems, integration projects, edge deployments";
      case "industrial_end_customer_scaled":
        return "Manufactured products plus internal quality inspection and automation workflows";
      case "camera_manufacturer_partner":
        return "Industrial cameras, imaging components, machine vision hardware";
      case "machine_builder_ai_enablement":
        return "Machines, OEM equipment, fixtures, and automation systems";
      case "software_platform_embedding":
        return "Software platform, APIs, workflows, and embeddable vision tooling";
      default:
        return "Needs clarification";
    }
  }

  private delay(durationMs: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, durationMs);
    });
  }
}
