import { env, readiness } from "../config";
import {
  ApolloOrganizationFilter,
  FilterEvaluation,
  LeadCategory,
  LeadLearningData,
  PreCategorizedCompany,
  ResearchBrief
} from "../types";
import {
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
}

const MAX_AZURE_RETRIES = 3;
const AZURE_RETRY_DELAYS_MS = [500, 1000, 2000];
const QUICK_QUALIFICATION_CONTEXT = [
  "You classify lead fit for ONE WARE.",
  "Prefer industrial software or AI delivery integrators, machine builders with clear vision/QC upside, and industrial camera vendors without a strong own AI software layer.",
  "Reject finance, HR tech, recruiting, applicant tracking, generic consulting without delivery ownership, and direct competing AI software vendors.",
  "Return JSON only with category, relevanceScore 0-100, rationale.",
  "Keep rationale to one short sentence."
].join(" ");
const MAX_FILTER_STRATEGY_HISTORY = 8;

export class AzureOpenAIClient {
  private readonly foundryAgentsClient = new FoundryAgentsClient();
  private readonly webSearchAgent = new WebSearchAgent();

  async categorizeCompany(
    name: string,
    description: string,
    dryRun: boolean,
    agentContext?: string,
    learning?: LeadLearningData
  ): Promise<Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale">> {
    const deterministicCategory = this.categorizeDeterministic(name, description, learning);
    if (deterministicCategory) {
      return deterministicCategory;
    }

    if (dryRun || !readiness.azureConfigured) {
      return this.categorizeDryRun(description);
    }

    const foundryCategorization = await this.foundryAgentsClient.categorizeCompany(name, description, agentContext, dryRun);
    if (foundryCategorization) {
      return foundryCategorization;
    }

    try {
      const content = await this.runChat([
        {
          role: "system",
          content: QUICK_QUALIFICATION_CONTEXT
        },
        {
          role: "user",
          content: [
            `Company=${name}`,
            `Description=${description}`,
            agentContext ? `Context=${agentContext}` : undefined,
            learning ? this.buildLearningContext(learning) : undefined
          ]
            .filter(Boolean)
            .join("\n")
        }
      ], { maxTokens: 140 });

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

  async buildResearchBrief(
    company: PreCategorizedCompany,
    dryRun: boolean,
    agentContext?: string,
    learning?: LeadLearningData
  ): Promise<ResearchBrief> {
    const template = getTemplateForCategory(company.category);
    const executionContext = buildExecutionContextBlock(company.category, agentContext);

    const foundryResearchBrief = await this.foundryAgentsClient.buildResearchBrief(company, agentContext, dryRun);
    if (foundryResearchBrief) {
      return foundryResearchBrief;
    }

    if (dryRun || !readiness.azureConfigured) {
      return this.buildFallbackResearchBrief(company, template, executionContext, agentContext);
    }

    const webResearchEvidence = await this.webSearchAgent.buildResearchContext(company);

    try {
      const content = await this.runChat([
        {
          role: "system",
          content: `${ONE_WARE_PROMPT_CONTEXT}\n\nTask: Build a concise sales research brief for ONE WARE. Use the segment template as the base and only personalize where a clear factual hook exists. Do not fully rewrite the outreach. Keep the core USP visible: less trial and error, faster path to production-ready models, more predictable timelines, local training, smaller hardware-efficient models, lower development effort. Apply the category execution context strictly. Use any supplied web evidence as your factual grounding. If the evidence is weak or conflicting, say so in riskFlags instead of inventing certainty. Return strict JSON with: overview, qualificationSummary, qualifyingSignals (array of strings), riskFlags (array of strings), recommendedTemplateKey, personalizationRule, linkedInAngle, emailAngle, phoneAngle, linkedInMessage, emailSubject, emailBody, phoneScript, eventIdea.`
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
            webResearchEvidence?.context,
            learning ? this.buildLearningContext(learning) : undefined
          ].join("\n\n")
        }
      ]);

      const parsed = this.parseJsonObject<Omit<ResearchBrief, "companyName">>(content);
      return {
        companyName: company.name,
        appliedAgentContext: agentContext,
        citations: webResearchEvidence?.citations?.length
          ? webResearchEvidence.citations
          : company.domain
            ? [company.domain]
            : [],
        ...parsed
      };
    } catch {
      return this.buildFallbackResearchBrief(company, template, executionContext, agentContext, webResearchEvidence?.citations);
    }
  }

  async generateSuggestedFilters(
    market: string | undefined,
    customGoal: string | undefined,
    agentContext: string | undefined,
    targetCategories: LeadCategory[] | undefined,
    baseFilters: ApolloOrganizationFilter[],
    dryRun: boolean,
    learning?: LeadLearningData
  ): Promise<ApolloOrganizationFilter[]> {
    const foundryFilters = await this.foundryAgentsClient.generateSuggestedFilters(
      market,
      customGoal,
      agentContext,
      targetCategories,
      baseFilters,
      dryRun
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
              ONE_WARE_PROMPT_CONTEXT,
              "You are the Apollo Search Strategy Agent.",
              "Return strict JSON with {\"filters\":[...]}",
              "Produce 4 to 6 practical Apollo company filters for ONE WARE.",
              "Optimize for at least 50% relevant firms in the first 15-company sample.",
              "Relevant means Europe-first and a plausible ONE WARE target category.",
              "Prioritize Germany first, then strong European industrial regions.",
              "Avoid VCs, generic consultancies, recruiting, banks, China, Saudi Arabia, and direct AI platform competitors.",
              "Keep industries, keywords, employee ranges, and locations realistic for Apollo."
            ].join(" ")
          },
          {
            role: "user",
            content: [
              market ? `Market focus: ${market}` : undefined,
              customGoal ? `Custom goal: ${customGoal}` : undefined,
              agentContext ? `Operator context: ${agentContext}` : undefined,
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
    agentContext?: string
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
              ONE_WARE_PROMPT_CONTEXT,
              "You revise one failing Apollo company search filter.",
              "Return strict JSON with {\"filter\":{...}}.",
              "The revised filter must aim for at least 50% relevant firms in the next 15-company probe.",
              "Tighten geography and commercial fit before broadening.",
              "Prefer service-led integrators and industrial accounts in Europe over broad AI vendors or generic consultancies."
            ].join(" ")
          },
          {
            role: "user",
            content: [
              market ? `Market focus: ${market}` : undefined,
              customGoal ? `Custom goal: ${customGoal}` : undefined,
              agentContext ? `Operator context: ${agentContext}` : undefined,
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

    const nonIndustrialHits = nonIndustrialPlatformSignals.filter((signal) => lowered.includes(signal)).length;
    const industrialHits = industrialSignals.filter((signal) => lowered.includes(signal)).length;

    if (nonIndustrialHits >= 1 && industrialHits === 0) {
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
        category: "industrial_camera_vendor_without_ai_software",
        relevanceScore: 73,
        rationale: "Description suggests imaging hardware where AI software upsell may be relevant."
      };
    }

    if (lowered.includes("ai") || lowered.includes("machine learning") || lowered.includes("computer vision")) {
      return {
        category: "ai_software_integrator",
        relevanceScore: 87,
        rationale: "Description signals AI or computer vision delivery capability."
      };
    }

    if (lowered.includes("machine") || lowered.includes("quality") || lowered.includes("inspection")) {
      return {
        category: "machine_builder_with_vision_ai_need",
        relevanceScore: 78,
        rationale: "Description suggests manufacturing workflow and potential QC or inspection use cases."
      };
    }

    if (lowered.includes("integrator") || lowered.includes("automation") || lowered.includes("software")) {
      return {
        category: "software_integrator",
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
    const serviceSignals = [
      "system integrator",
      "software development",
      "consultancy",
      "services",
      "project delivery",
      "integration services"
    ];
    const recruitingSignals = [
      "recruiting software",
      "applicant tracking",
      "job board",
      "job boards",
      "hiring platform",
      "candidate management",
      "talent acquisition",
      "multiposting",
      "ats"
    ];

    const recruitingHits = recruitingSignals.filter((signal) => lowered.includes(signal)).length;
    if (recruitingHits >= 2) {
      return {
        category: "irrelevant",
        relevanceScore: 4,
        rationale: "Company description strongly matches recruiting, hiring, or applicant-tracking software rather than ONE WARE's ICP."
      };
    }

    const nonIndustrialHits = nonIndustrialPlatformSignals.filter((signal) => lowered.includes(signal)).length;
    const industrialHits = industrialSignals.filter((signal) => lowered.includes(signal)).length;
    if (nonIndustrialHits >= 1 && industrialHits === 0) {
      return {
        category: "irrelevant",
        relevanceScore: 5,
        rationale: "Company description looks like a generic enterprise platform or logistics business rather than an industrial delivery fit."
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
    const serviceHits = serviceSignals.filter((signal) => lowered.includes(signal)).length;

    if ((hardwareHits >= 2 || (mentionsImagingOrCamera && mentionsVendorOrHardware)) && serviceHits === 0) {
      return {
        category: "industrial_camera_vendor_without_ai_software",
        relevanceScore: 90,
        rationale: "Company description strongly matches an industrial imaging or camera vendor without a clear delivery-led services profile."
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

    if (rejectedCompanies.length === 0) {
      return undefined;
    }

    return ["Learned rejects:", ...rejectedCompanies.map((item) => `- ${item}`)].join("\n");
  }

  private async runChat(messages: ChatMessage[], options: RunChatOptions = {}): Promise<string> {
    const url = `${env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${env.AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${env.AZURE_OPENAI_API_VERSION}`;
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
          temperature: 0.2,
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
    };

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

    const topFilters = Object.entries(learning.filterPerformance)
      .sort((left, right) => right[1].averageRelevanceRatio - left[1].averageRelevanceRatio)
      .slice(0, MAX_FILTER_STRATEGY_HISTORY)
      .map(([name, stats]) => `${name}: avg ${(stats.averageRelevanceRatio * 100).toFixed(0)}%, runs ${stats.runs}, early stops ${stats.earlyStopCount}`);

    const recentHistory = learning.searchHistory
      .slice(0, MAX_FILTER_STRATEGY_HISTORY)
      .map(
        (entry) =>
          `${entry.filterName} | ${entry.batchType} | ${entry.relevantCount}/${entry.returnedCount} relevant | ${(entry.relevanceRatio * 100).toFixed(0)}% | ${entry.recommendation}`
      );

    const sections = [
      topFilters.length > 0 ? ["Known filter performance:", ...topFilters].join("\n") : undefined,
      recentHistory.length > 0 ? ["Recent search history:", ...recentHistory].join("\n") : undefined
    ].filter(Boolean);

    return sections.length > 0 ? sections.join("\n\n") : undefined;
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
      ["software_integrator", ["software_integrator", "industrial software / delivery integrator", "industrial software / ai delivery integrator", "delivery integrator", "software integrator", "relevant", "fit", "strong fit", "good fit"]],
      ["ai_software_integrator", ["ai_software_integrator", "ai integrator", "ai delivery integrator", "industrial software / ai delivery integrator"]],
      ["machine_builder_with_vision_ai_need", ["machine_builder_with_vision_ai_need", "machine_builder", "machine_builder_oem", "industrial_end_customer", "potential_fit"]],
      ["industrial_camera_vendor_without_ai_software", ["industrial_camera_vendor_without_ai_software", "industrial camera vendor", "industrial_camera_vendor", "industrial camera/vendor", "industrial_vision_vendor"]],
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
    agentContext?: string,
    citations?: string[]
  ): ResearchBrief {
    return {
      companyName: company.name,
      appliedAgentContext: agentContext,
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
      recommendedTemplateKey: template.key,
      personalizationRule: "Keep the template structure and personalize only if there is a clear factual hook in the company description.",
      linkedInAngle: "Use a short question around delivery bottlenecks, not a generic compliment.",
      emailAngle: "Keep ONE WARE USP visible: less trial and error, faster delivery, lower development effort.",
      phoneAngle: "Lead with the operational bottleneck, not platform features.",
      linkedInMessage: template.linkedInMessage,
      emailSubject: template.subject,
      emailBody: template.emailBody,
      phoneScript: template.phoneScript,
      eventIdea: "Check for presence at SPS, Automatica, Vision, or regional automation events."
    };
  }

  private delay(durationMs: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, durationMs);
    });
  }
}