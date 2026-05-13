import { azureOpenAICostConfig, env, readiness } from "../config";
import {
  ApolloContactCandidate,
  ApolloOrganizationFilter,
  AzureUsageCost,
  FilterEvaluation,
  LeadCategory,
  LeadLearningData,
  PreCategorizedCompany,
  PrequalificationConfig,
  ResearchBrief
} from "../types";
import {
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

const MAX_AZURE_RETRIES = 3;
const AZURE_RETRY_DELAYS_MS = [500, 1000, 2000];
const CLASSIFIER_DEPLOYMENT = env.AZURE_OPENAI_CLASSIFIER_DEPLOYMENT ?? env.AZURE_OPENAI_DEPLOYMENT;
const COMPANY_CLASSIFIER_INPUT_LIMIT = 700;
const WEBSITE_CLASSIFIER_INPUT_LIMIT = 1100;
const QUICK_QUALIFICATION_CONTEXT = [
  "You classify lead fit for ONE WARE.",
  "Classify conservatively and completely unbiased before preferring any positive category.",
  "All categories are always available during classification; selected run categories are applied only after classification as a filtering step, never as a hint for the category choice.",
  "First identify the firm archetype: implementation-led integrator, industrial end customer, camera/imaging manufacturer, machine builder/OEM, software platform, or clearly irrelevant profile.",
  "Then decide whether the company is genuinely relevant, clearly irrelevant, or too ambiguous.",
  "Do not infer delivery ownership or category fit from the Apollo filter name, source filter, or a vague company name alone.",
  "Positive archetypes look similar to OCTUM, VEO Automation, Gestalt Automation, kubion, Strategion, visiontechnik.de, or Lachmann & Rink: customer project delivery, implementation ownership, industrial inspection or production relevance, and concrete engineering work rather than generic AI branding.",
  "Negative reference profiles include SemsoTec Group for display/HMI product engineering, exantas for a non-target automotive software-services profile, integralvision.eu for web/UI agency work, Eficode for DevOps/ITSM advisory, t3n for media, and CODESYS for product software/runtime tooling.",
  "High-signal fit phrases include AOI, automated optical inspection, inline inspection, optical quality control, industrial image processing, machine vision integration, embedded computer vision, feasibility study, camera calibration, lighting optimization, MES integration, SCADA integration, PLC software integration, OT integration, smart factory software, and industrial software engineering.",
  "If the company description is missing, generic, placeholder-like, or weak, return other or irrelevant unless there is strong explicit evidence for a positive category.",
  "Reject media companies, magazines, publishers, news portals, event businesses, associations, universities, research institutes, VCs, private equity, banks, insurers, recruiting/HR tech, generic consultancies without delivery ownership, resellers, and direct competing AI software vendors.",
  "Do not classify robot manufacturers, OEMs, hardware vendors, or product-led robotics brands as integrators unless they clearly sell implementation or integration services.",
  "Downgrade companies that mainly sell their own software platform, robot product, hardware portfolio, or generic consulting without visible recurring implementation responsibility.",
  "Return compact JSON only with category, relevanceScore 0-100, rationale.",
  "Keep rationale to one short sentence with at most 18 words."
].join(" ");
const MAX_FILTER_STRATEGY_HISTORY = 8;
const REFERENCE_COMPANY_CLASSIFICATIONS: Array<{
  match: RegExp;
  category: LeadCategory;
  relevanceScore: number;
  rationale: string;
}> = [
  {
    match: /gestalt automation/i,
    category: "integrator_vision_industrial_ai",
    relevanceScore: 94,
    rationale: "Operator reference company for industrial inspection and implementation-led AI delivery."
  },
  {
    match: /veo automation/i,
    category: "integrator_general_ai",
    relevanceScore: 90,
    rationale: "Operator reference company for implementation-led automation and AI delivery."
  },
  {
    match: /dataful minds/i,
    category: "integrator_general_ai",
    relevanceScore: 86,
    rationale: "Operator reference company for delivery-led data and AI engineering services."
  },
  {
    match: /kubion/i,
    category: "integrator_general_ai",
    relevanceScore: 88,
    rationale: "Operator reference company for delivery-led industrial software and automation services."
  },
  {
    match: /strategion/i,
    category: "integrator_general_ai",
    relevanceScore: 84,
    rationale: "Operator reference company for AI enablement with implementation and infrastructure ownership."
  },
  {
    match: /visiontechnik/i,
    category: "integrator_vision_industrial_ai",
    relevanceScore: 91,
    rationale: "Operator reference company for machine-vision integration, deep learning, and project delivery."
  },
  {
    match: /semsotec/i,
    category: "other",
    relevanceScore: 18,
    rationale: "Display, HMI, and optical product engineering profile rather than a target software integrator."
  },
  {
    match: /innoge/i,
    category: "irrelevant",
    relevanceScore: 18,
    rationale: "Generic software consulting, due diligence, and digitalization advisory profile without a clear ONE WARE-style delivery fit."
  },
  {
    match: /integral vision|integralvision/i,
    category: "irrelevant",
    relevanceScore: 10,
    rationale: "Web development and UI/UX agency profile without an industrial AI, edge AI, or automation delivery angle."
  },
  {
    match: /eficode/i,
    category: "irrelevant",
    relevanceScore: 16,
    rationale: "DevOps, ITSM, training, and advisory profile rather than a target AI or automation implementation partner."
  },
  {
    match: /vision[\s-]*domes/i,
    category: "irrelevant",
    relevanceScore: 5,
    rationale: "Geodesic domes and event/garden structures are outside the target software-integrator profile."
  },
  {
    match: /\bt3n\b/i,
    category: "irrelevant",
    relevanceScore: 2,
    rationale: "Digital media and publishing profile rather than a software integrator or delivery partner."
  },
  {
    match: /\bcodesys\b/i,
    category: "other",
    relevanceScore: 15,
    rationale: "Industrial software tooling and runtime product profile rather than a software services integrator."
  },
  {
    match: /imago technologies/i,
    category: "camera_manufacturer_partner",
    relevanceScore: 90,
    rationale: "Industrial camera and embedded vision product vendor profile rather than a software-integrator target."
  },
  {
    match: /exantas automotive|\bexantas\b/i,
    category: "irrelevant",
    relevanceScore: 8,
    rationale: "Reference profile is not a target industrial AI delivery integrator for ONE WARE."
  }
];

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
    if (deterministicCategory) {
      return deterministicCategory;
    }

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
          content: `${QUICK_QUALIFICATION_CONTEXT}\n\n${buildPrequalificationContextBlock(prequalification, undefined, mainContext)}`
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
      return this.categorizeDryRun(description);
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
  ): Promise<Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale">> {
    const deterministicCategory = this.categorizeDeterministic(name, crawledWebsiteSummary, learning);
    if (deterministicCategory) {
      return deterministicCategory;
    }

    if (dryRun || !readiness.azureConfigured) {
      return this.categorizeDryRun(crawledWebsiteSummary);
    }

    try {
      const compactWebsiteSummary = this.compactClassificationInput(crawledWebsiteSummary, WEBSITE_CLASSIFIER_INPUT_LIMIT);
      const content = await this.runChat([
        {
          role: "system",
          content: [
            QUICK_QUALIFICATION_CONTEXT,
            buildPrequalificationContextBlock(prequalification, undefined, mainContext),
            "You are classifying a company from its own crawled website pages only.",
            "Treat this as a cheap website-first precheck before any expensive web-search research.",
            "The crawled text may combine homepage, about, services, solutions, products, references, applications, and industry pages.",
            "Prefer implementation-led software integrators, automation integrators, embedded/industrial engineering services, and project-delivery firms.",
            "Downgrade product-heavy camera vendors, hardware sellers, marketplaces, and generic consultancies unless recurring customer implementation ownership is explicit."
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
      ], { maxTokens: 96, deployment: CLASSIFIER_DEPLOYMENT });

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
      return this.categorizeDryRun(crawledWebsiteSummary);
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

    const crawledWebsiteEvidence = company.domain
      ? {
          context: [
            "Crawled website evidence:",
            `Company: ${company.name}`,
            `Website: ${company.domain}`,
            `Website summary: ${company.shortDescription}`
          ].join("\n\n"),
          citations: [company.domain]
        }
      : undefined;

    const webResearchEvidence = includeWebResearch
      ? await this.webSearchAgent.buildResearchContext(company)
      : undefined;

    try {
      const content = await this.runChat([
        {
          role: "system",
          content: `${buildMainContextBlock(mainContext)}\n\nTask: Build a concise sales research brief for ONE WARE. Use the segment template as the base and only personalize where a clear factual hook exists. Do not fully rewrite the outreach. Keep the core USP visible: less trial and error, faster path to production-ready models, more predictable timelines, local training, smaller hardware-efficient models, lower development effort. Apply the category execution context strictly. Estimate whether the decision-makers or likely target contacts are German-speaking. If yes, produce outreach in German; otherwise produce it in English. Estimate all three commercial rankings on a 0-10 scale: customer, serviceProvider, partner. Estimate businessPotentialEUR as a realistic euro value, not a score. Use the following commercial framing: a single AI use case often starts around 7000 EUR, can be 20000 to 40000 EUR per AI for more complex or production-grade deployments, can multiply across many use cases, and OEM or camera-manufacturer partner rollouts can be much larger, including six- or seven-figure potential in recurring machine volumes. Also return targetIndustry and productsOffered. Use any supplied web evidence as your factual grounding. If no web evidence is supplied, reason only from the provided company facts and keep uncertainty explicit. If the evidence is weak or conflicting, say so in riskFlags instead of inventing certainty. Return strict JSON with: overview, qualificationSummary, qualifyingSignals (array of strings), riskFlags (array of strings), likelyGermanSpeaking, outreachLanguage, rankings { customer, serviceProvider, partner }, businessPotentialEUR, businessPotentialReasoning, targetIndustry, productsOffered, recommendedTemplateKey, personalizationRule, linkedInAngle, emailAngle, phoneAngle, linkedInMessage, emailSubject, emailBody, phoneScript, eventIdea.`
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
            `Base template LinkedIn message:\n${template.linkedInMessage}`,
            `Base template phone script:\n${template.phoneScript}`,
            crawledWebsiteEvidence?.context,
            webResearchEvidence?.context,
            learning ? this.buildLearningContext(learning) : undefined
          ].join("\n\n")
        }
      ]);

      const parsed = this.parseJsonObject<Omit<ResearchBrief, "companyName">>(content);
      return {
        companyName: company.name,
        appliedAgentContext: mainContext,
        citations: Array.from(new Set([
          ...(crawledWebsiteEvidence?.citations ?? []),
          ...(webResearchEvidence?.citations ?? [])
        ])),
        ...parsed
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

  private compactClassificationInput(text: string, maxLength: number): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
  }

  async chooseApolloContacts(
    company: PreCategorizedCompany,
    candidates: ApolloContactCandidate[],
    dryRun: boolean,
    mainContext?: string,
    brief?: ResearchBrief
  ): Promise<ApolloContactCandidate[]> {
    const rankedCandidates = this.rankApolloContacts(candidates).slice(0, 8);
    if (rankedCandidates.length <= 2 || dryRun || !readiness.azureConfigured) {
      return rankedCandidates.slice(0, 2);
    }

    try {
      const content = await this.runChat([
        {
          role: "system",
          content: `${buildMainContextBlock(mainContext)}\n\nTask: Select the best one or two Apollo contacts for outbound outreach. Prefer decision-makers and operational owners who can sponsor or own industrial AI, machine vision, automation, digitalization, engineering, operations, or innovation projects. Favor CEO, CTO, COO, Managing Director, Head of Automation, Head of Innovation, Head of Engineering, Head of Operations, and similar roles. Avoid HR, recruiting, finance, legal, support, marketing, and generic sales contacts unless no stronger option exists. Return strict JSON with {\"selectedPersonIds\":[\"...\"],\"reason\":\"...\"}.`
        },
        {
          role: "user",
          content: [
            `Company: ${company.name}`,
            company.domain ? `Domain: ${company.domain}` : undefined,
            `Category: ${company.category}`,
            brief?.qualificationSummary ? `Qualification summary: ${brief.qualificationSummary}` : undefined,
            `Apollo candidates JSON: ${JSON.stringify(rankedCandidates)}`
          ].filter(Boolean).join("\n\n")
        }
      ], { maxTokens: 160 });

      const parsed = this.parseJsonObject<{ selectedPersonIds?: string[] }>(content);
      const selected = rankedCandidates.filter((candidate) => (parsed.selectedPersonIds ?? []).includes(candidate.personId));
      return selected.length > 0 ? selected.slice(0, 2) : rankedCandidates.slice(0, 2);
    } catch {
      return rankedCandidates.slice(0, 2);
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
    baseFilters: ApolloOrganizationFilter[],
    dryRun: boolean,
    learning?: LeadLearningData
  ): Promise<ApolloOrganizationFilter[]> {
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
              "Model the positive archetype on the strongest known Apollo cluster: Gestalt Automation, VEO Automation, kubion, Lachmann & Rink, plus nearby implementation-led firms like OCTUM.",
              "Keep wording concrete and close to the winning examples because Apollo is highly sensitive to small phrasing changes.",
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

      const parsed = this.parseJsonObject<{ filters?: ApolloOrganizationFilter[] }>(content);
      const filters = (parsed.filters ?? [])
        .map((filter) => this.normalizeApolloFilter(filter))
        .filter((filter): filter is ApolloOrganizationFilter => Boolean(filter));

      return filters.length > 0 ? filters : baseFilters;
    } catch {
      return baseFilters;
    }
  }

  async reviseSearchFilter(
    failedFilter: ApolloOrganizationFilter,
    evaluation: FilterEvaluation,
    dryRun: boolean,
    learning?: LeadLearningData,
    market?: string,
    customGoal?: string,
    mainContext?: string
  ): Promise<ApolloOrganizationFilter | null> {
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
              "Move the failed filter toward the strongest known Apollo examples: Gestalt Automation, VEO Automation, kubion, Lachmann & Rink, and nearby firms like OCTUM when relevant.",
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

      const parsed = this.parseJsonObject<{ filter?: ApolloOrganizationFilter }>(content);
      const normalizedFilter = this.normalizeApolloFilter(parsed.filter);

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
    const industrialSignals = [
      "industrial",
      "automation",
      "inspection",
      "quality control",
      "machine",
      "robotics",
      "camera",
      "imaging",
      "embedded",
      "factory"
    ];

    const nonIndustrialHits = nonIndustrialPlatformSignals.filter((signal) => lowered.includes(signal)).length;
    const industrialHits = industrialSignals.filter((signal) => lowered.includes(signal)).length;
    const serviceDeliveryHits = serviceDeliverySignals.filter((signal) => lowered.includes(signal)).length;

    if (obviouslyIrrelevantSignals.some((signal) => lowered.includes(signal)) && serviceDeliveryHits === 0) {
      return {
        category: "irrelevant",
        relevanceScore: 3,
        rationale: "Description points to a media, finance, event, academic, or other clearly non-target profile."
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

    if (lowered.includes("camera") || lowered.includes("imaging") || lowered.includes("optics")) {
      return {
        category: "camera_manufacturer_partner",
        relevanceScore: 73,
        rationale: "Description suggests imaging hardware where AI software upsell may be relevant."
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

    if (lowered.includes("integrator") || lowered.includes("automation") || lowered.includes("software")) {
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
    const industrialSignals = [
      "industrial",
      "automation",
      "inspection",
      "quality control",
      "machine",
      "robotics",
      "camera",
      "imaging",
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
      "project delivery",
      "integration services"
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
      "inspection systems",
      "inspection solutions",
      "inspection automation",
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
      "software engineering"
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
      "branchenlösungen",
      "softwareprojekte",
      "it-projekthaus"
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
      "engineering teams"
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

    const recruitingHits = recruitingSignals.filter((signal) => lowered.includes(signal)).length;
    const serviceDeliveryHits = serviceDeliverySignals.filter((signal) => lowered.includes(signal)).length;
    const serviceHits = serviceSignals.filter((signal) => lowered.includes(signal)).length;
    const advisoryHits = advisoryOnlySignals.filter((signal) => lowered.includes(signal)).length;
    const webAgencyHits = webAgencySignals.filter((signal) => lowered.includes(signal)).length;
    const implementationStrengthHits = implementationStrengthSignals.filter((signal) => lowered.includes(signal)).length;
    if (obviouslyIrrelevantSignals.some((signal) => lowered.includes(signal)) && serviceDeliveryHits === 0 && serviceHits === 0) {
      return {
        category: "irrelevant",
        relevanceScore: 2,
        rationale: "Company description strongly matches a media, finance, event, academic, or other clearly non-target profile."
      };
    }

    if (recruitingHits >= 2) {
      return {
        category: "irrelevant",
        relevanceScore: 4,
        rationale: "Company description strongly matches recruiting, hiring, or applicant-tracking software rather than ONE WARE's ICP."
      };
    }

    const nonIndustrialHits = nonIndustrialPlatformSignals.filter((signal) => lowered.includes(signal)).length;
    const industrialHits = industrialSignals.filter((signal) => lowered.includes(signal)).length;
    if (nonIndustrialHits >= 1 && industrialHits === 0 && serviceDeliveryHits === 0) {
      return {
        category: "irrelevant",
        relevanceScore: 5,
        rationale: "Company description looks like a generic enterprise platform or logistics business rather than an industrial delivery fit."
      };
    }

    if (nonTargetInspectionSignals.some((signal) => lowered.includes(signal))) {
      return {
        category: "irrelevant",
        relevanceScore: 9,
        rationale: "Company description points to pipeline inspection, generic consulting, or another non-target inspection niche instead of industrial vision integration."
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
    if (displayVendorHits >= 1 && serviceHits === 0) {
      return {
        category: "other",
        relevanceScore: 20,
        rationale: "Company description looks like a display, HMI, or optical product engineering vendor rather than a target software integrator."
      };
    }

    if ((hardwareHits >= 2 || (mentionsImagingOrCamera && mentionsVendorOrHardware)) && serviceHits === 0) {
      return {
        category: "camera_manufacturer_partner",
        relevanceScore: 90,
        rationale: "Company description strongly matches an industrial imaging or camera vendor without a clear delivery-led services profile."
      };
    }

    const visionDeliveryHits = visionDeliverySignals.filter((signal) => lowered.includes(signal)).length;
    if (serviceHits >= 1 && visionDeliveryHits >= 1) {
      return {
        category: "integrator_vision_industrial_ai",
        relevanceScore: 88,
        rationale: "Company description shows clear machine-vision or inspection delivery ownership for customer projects."
      };
    }

    const automationDeliveryHits = automationDeliverySignals.filter((signal) => lowered.includes(signal)).length;
    if (serviceHits >= 1 && automationDeliveryHits >= 1) {
      return {
        category: "integrator_general_ai",
        relevanceScore: 84,
        rationale: "Company description shows service-led industrial software or automation implementation ownership."
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

    if (serviceDeliveryHits >= 2 && (lowered.includes("software") || lowered.includes("ai") || lowered.includes("data") || lowered.includes("engineering"))) {
      return {
        category: "integrator_general_ai",
        relevanceScore: 80,
        rationale: "Company description shows delivery-led software, data, or AI engineering services with customer implementation ownership."
      };
    }

    const softwarePlatformHits = softwarePlatformSignals.filter((signal) => lowered.includes(signal)).length;
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
      "Positive archetypes: OCTUM, VEO Automation, Gestalt Automation, Lachmann & Rink.",
      "Typical positive evidence: customer project delivery, industrial inspection or production software relevance, feasibility studies, integration, commissioning, image processing, AOI, smart factory, or embedded computer vision implementation."
    ];

    if (rejectedCompanies.length === 0) {
      return positiveArchetypes.join("\n");
    }

    return [
      ...positiveArchetypes,
      "Learned rejects:",
      ...rejectedCompanies.map((item) => `- ${item}`)
    ].join("\n");
  }

  private async runChat(messages: ChatMessage[], options: RunChatOptions = {}): Promise<string> {
    const deployment = options.deployment ?? env.AZURE_OPENAI_DEPLOYMENT;
    const url = `${env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${deployment}/chat/completions?api-version=${env.AZURE_OPENAI_API_VERSION}`;
    let response: Response | undefined;

    for (let attempt = 0; attempt <= MAX_AZURE_RETRIES; attempt += 1) {
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
        })
      });

      if (response.ok) {
        break;
      }

      if (response.status !== 429 || attempt === MAX_AZURE_RETRIES) {
        const errorText = await response.text();
        throw new Error(`Azure OpenAI request failed: ${response.status} ${errorText}`);
      }

      await this.delay(AZURE_RETRY_DELAYS_MS[attempt] ?? 2000);
    }

    if (!response?.ok) {
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

    const content = payload.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("Azure OpenAI returned no content.");
    }

    return content;
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

  private buildLearningContextForSearchStrategy(learning?: LeadLearningData): string | undefined {
    if (!learning) {
      return undefined;
    }

    const latestHistoryByName = new Map(
      learning.searchHistory
        .filter((entry) => entry.filterSnapshot)
        .map((entry) => [entry.filterName, entry])
    );

    const topFilters = Object.entries(learning.filterPerformance)
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

    const recentHistory = learning.searchHistory
      .slice()
      .sort((left, right) => Number(Boolean(right.filterSnapshot)) - Number(Boolean(left.filterSnapshot)))
      .slice(0, MAX_FILTER_STRATEGY_HISTORY)
      .map(
        (entry) =>
          [
            `${entry.filterName} | ${entry.batchType} | ${entry.relevantCount}/${entry.returnedCount} relevant | ${(entry.relevanceRatio * 100).toFixed(0)}% | ${entry.recommendation}`,
            entry.filterSnapshot ? `  Snapshot: ${this.formatFilterSnapshot(entry.filterSnapshot)}` : undefined
          ]
            .filter(Boolean)
            .join("\n")
      );

    const sections = [
      topFilters.length > 0 ? ["Known filter performance:", ...topFilters].join("\n") : undefined,
      recentHistory.length > 0 ? ["Recent search history:", ...recentHistory].join("\n") : undefined
    ].filter(Boolean);

    return sections.length > 0 ? sections.join("\n\n") : undefined;
  }

  private rankApolloContacts(candidates: ApolloContactCandidate[]): ApolloContactCandidate[] {
    return [...candidates].sort((left, right) => this.getApolloContactRank(right) - this.getApolloContactRank(left));
  }

  private getApolloContactRank(candidate: ApolloContactCandidate): number {
    const title = candidate.title?.toLowerCase() ?? "";
    const seniority = candidate.seniority?.toLowerCase() ?? "";
    const departmentText = `${candidate.departments?.join(" ") ?? ""} ${candidate.functions?.join(" ") ?? ""}`.toLowerCase();

    let score = 0;

    if (/\b(ceo|cto|coo|founder|owner|geschäftsführer|managing director)\b/.test(title)) {
      score += 12;
    }

    if (/\b(head|director|lead|vp)\b/.test(title) || /\b(head|director|vp|c_suite|founder|owner)\b/.test(seniority)) {
      score += 7;
    }

    if (/automation|innovation|engineering|operations|production|digital|vision|inspection|factory/.test(title)) {
      score += 6;
    }

    if (/engineering|operations|innovation|it|product/.test(departmentText)) {
      score += 4;
    }

    if (/hr|recruit|finance|legal|marketing|support|sales development/.test(`${title} ${departmentText}`)) {
      score -= 12;
    }

    if (candidate.hasEmail) {
      score += 2;
    }

    return score;
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

  private normalizeApolloFilter(filter: ApolloOrganizationFilter | undefined): ApolloOrganizationFilter | null {
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
      ["integrator_general_ai", ["integrator_general_ai", "ai integrator", "ai delivery integrator", "general ai integrator"]],
      ["integrator_relevant_focus", ["integrator_relevant_focus", "vertical integrator", "relevant industry integrator", "defence integrator", "surveillance integrator"]],
      ["industrial_end_customer_scaled", ["industrial_end_customer_scaled", "industrial_end_customer", "scaled industrial customer", "industrial customer"]],
      ["camera_manufacturer_partner", ["camera_manufacturer_partner", "industrial_camera_vendor_without_ai_software", "industrial camera vendor", "industrial_camera_vendor", "industrial camera/vendor", "industrial_vision_vendor"]],
      ["machine_builder_ai_enablement", ["machine_builder_ai_enablement", "machine_builder_with_vision_ai_need", "machine_builder", "machine_builder_oem", "potential_fit"]],
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

    const englishVariants: Record<string, { subject: string; emailBody: string; linkedInMessage: string; phoneScript: string }> = {
      integrator_vision_industrial_ai_template: {
        subject: "Deploy vision AI without long optimization cycles",
        emailBody: "Hello Mr./Ms. [Name],\n\nAre you currently running vision AI projects where it still takes many iterations until a model is actually production-ready or never becomes reliable enough?\n\nThat is exactly what we often see with integrators: weeks to months go into tuning and deployment instead of delivering the actual solution.\n\nWe built software that creates custom vision AI models in under 5 minutes and makes them production-ready right away. That helps teams iterate faster, plan project timelines more predictably, and deliver more projects with the same team.\n\nI would be interested to hear: where is the biggest bottleneck in your current vision AI projects - model generation or integration?\n\nBest regards,\n[Your Name]",
        linkedInMessage: "Quick question: how fast do you currently get a vision AI model into production? We often see integrators lose a lot of time in model selection and optimization. We automate exactly that step.",
        phoneScript: "Hello Mr./Ms. [Name], this is [Your Name] from ONE WARE. I will keep it short: we speak with integrators where model selection and optimization in vision AI projects take weeks or months. We automate exactly that step. Is that relevant for you right now?"
      },
      integrator_general_ai_template: {
        subject: "Move AI projects to production-ready vision AI faster",
        emailBody: "Hello Mr./Ms. [Name],\n\nTeams with a broader AI focus often see the same bottleneck in vision projects: model selection, optimization, and deployment-side adjustments take longer than expected.\n\nONE WARE automates exactly that step. From your data, production-ready vision AI models are created within minutes and optimized for the target hardware.\n\nThat allows you to deliver more client projects with the same team and with more predictable timelines.\n\nWould a short conversation make sense to see whether this is relevant for your current delivery projects?\n\nBest regards,\n[Your Name]",
        linkedInMessage: "Quick question: where is the biggest bottleneck in your current vision AI projects - model generation or integration? We automate exactly that step.",
        phoneScript: "Hello Mr./Ms. [Name], this is [Your Name] from ONE WARE. We speak with AI service providers where vision projects lose too much time in model selection and optimization. We automate exactly that step. Is that relevant for you?"
      },
      integrator_relevant_focus_template: {
        subject: "Deliver vision AI faster in demanding vertical projects",
        emailBody: "Hello Mr./Ms. [Name],\n\nIn demanding verticals like defence, surveillance, robotics, or medtech, vision AI is often on the critical path - and model selection plus optimization consume a disproportionate amount of time.\n\nWith ONE WARE, application-specific vision models can be created in minutes instead of months and deployed directly to target hardware.\n\nThat reduces delivery risk and makes project timelines more predictable.\n\nIf useful, we can look at a real use case and identify where the biggest leverage might be for your team.\n\nBest regards,\n[Your Name]",
        linkedInMessage: "Quick question: do you currently have vision AI workstreams in your vertical projects that are slowed down by model selection and tuning? That is exactly where we help.",
        phoneScript: "Hello Mr./Ms. [Name], this is [Your Name] from ONE WARE. We help integrators in demanding verticals bring vision AI projects to production much faster. Is that relevant for your team right now?"
      },
      industrial_end_customer_scaled_template: {
        subject: "Make quality inspection and vision AI economically viable",
        emailBody: "Hello Mr./Ms. [Name],\n\nIn many industrial projects, vision AI makes technical sense for quality inspection or process automation, but implementation is often too expensive, too slow, or too complex.\n\nThat is where ONE WARE comes in: application-specific vision AI models can be created in minutes instead of months and deployed directly on cost-efficient edge hardware. This makes use cases viable that previously failed on development effort or hardware cost.\n\nIf helpful, we can demonstrate on one of your datasets what our software can deliver in your use case.\n\nWould a short conversation make sense?\n\nBest regards,\n[Your Name]",
        linkedInMessage: "Quick question: are there quality inspection or process automation topics where vision AI would make sense for you, but has been too expensive or too complex so far? That is exactly where we help.",
        phoneScript: "Hello Mr./Ms. [Name], this is [Your Name] from ONE WARE. We help industrial teams bring vision AI for quality inspection and process automation into production much faster and at lower cost. Is that relevant for you right now?"
      },
      camera_manufacturer_partner_template: {
        subject: "Integrate vision AI into camera and imaging solutions faster",
        emailBody: "Hello Mr./Ms. [Name],\n\nMany camera and imaging manufacturers see vision AI as a strong differentiator, but end-to-end model and hardware optimization often takes too much internal effort.\n\nWith ONE WARE, production-ready vision AI models are created from data within minutes and optimized for the target hardware.\n\nThat enables you to offer AI-capable setups and solutions to customers much faster.\n\nWould a short conversation make sense to explore potential partner use cases?\n\nBest regards,\n[Your Name]",
        linkedInMessage: "Quick question: how much effort does it currently take to make vision AI production-ready for customers in your imaging setups? We automate exactly that part.",
        phoneScript: "Hello Mr./Ms. [Name], this is [Your Name] from ONE WARE. We help imaging manufacturers bring vision AI into customer-ready solutions much faster. Is that relevant for you?"
      },
      machine_builder_ai_enablement_template: {
        subject: "Integrate vision AI into machines and products more easily",
        emailBody: "Hello Mr./Ms. [Name],\n\nMany machine builders and hardware vendors see vision AI as an attractive feature, but developing a robust, hardware-optimized solution internally often takes too much time.\n\nWith ONE WARE, production-ready vision AI models are created from data within minutes and optimized for the target hardware. This makes it much easier and more economical to integrate vision AI into existing products.\n\nWould a short conversation be useful to see where this could be relevant for your product portfolio?\n\nBest regards,\n[Your Name]",
        linkedInMessage: "How much effort does it currently take for you to integrate vision AI into machines or hardware in a production-ready way? We often see model selection and hardware optimization create the biggest workload. That is exactly what we automate.",
        phoneScript: "Hello Mr./Ms. [Name], this is [Your Name] from ONE WARE. We help machine-building and hardware teams integrate vision AI into products much more easily because model generation and hardware optimization become largely automated. Is that relevant for you right now?"
      },
      software_platform_embedding_template: {
        subject: "Embeddable vision AI model engine for your platform",
        emailBody: "Hello Mr./Ms. [Name],\n\nIf your platform provides vision AI workflows to customers, model generation is often the most time-consuming step.\n\nONE WARE can be embedded as an alternative model engine: from data to production-ready, hardware-optimized models in minutes.\n\nThat adds meaningful capability for your users without forcing your team into long internal model-iteration cycles.\n\nWould a short technical discussion make sense to explore integration options?\n\nBest regards,\n[Your Name]",
        linkedInMessage: "Quick question: are you currently evaluating options that help your users get to production-ready vision models faster? We provide exactly that step as an embeddable engine.",
        phoneScript: "Hello Mr./Ms. [Name], this is [Your Name] from ONE WARE. We help platform providers offer vision-model generation as an embeddable layer. Is that something you are looking at right now?"
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
      integrator_general_ai: "General AI integrator with likely upsell into vision projects, but less concentrated than explicit vision specialists.",
      integrator_relevant_focus: "Vertical-specialist integrator where a few critical use cases can justify higher per-AI value.",
      industrial_end_customer_scaled: "Industrial end-customer value driven by multiple inspection or automation use cases and higher production impact.",
      camera_manufacturer_partner: "Partner-scale opportunity where ONE WARE can enable repeated customer deployments through the hardware vendor.",
      machine_builder_ai_enablement: "OEM or machine-builder opportunity with recurring machine volumes and downstream AI model creation potential.",
      software_platform_embedding: "Platform opportunity with partner leverage across many users or embedded workflows.",
      irrelevant: "Low-fit profile; value estimate remains minimal.",
      other: "Mixed profile; estimate remains conservative until fit is clearer."
    };

    return `${reasoningByCategory[category]} Estimated at about EUR ${businessPotentialEUR.toLocaleString("en-US")}.`;
  }

  private estimateTargetIndustry(category: LeadCategory): string {
    switch (category) {
      case "integrator_vision_industrial_ai":
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