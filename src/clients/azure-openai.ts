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
const WEBSITE_CLASSIFIER_INPUT_LIMIT = 2200;
const QUICK_QUALIFICATION_CONTEXT = [
  "# Identity\nYou classify company fit for ONE WARE from company descriptions and crawled website text.",
  "# Goal\nChoose exactly one category. Stay conservative and unbiased. Do not prefer integrators by default.",
  "# Evidence Handling\nUse business-model evidence from homepage, about, products, services, documentation, integrations, reference pages, applications, and use cases. Ignore cookie banners, legal text, newsletter prompts, careers pages, and navigation fragments. Do not infer fit from the company name, source filter, or vague branding alone.",
  "# Category Map\nintegrator_general_ai: explicit external delivery of software, AI, automation, MES, SCADA, enterprise integration, or a captive internal IT unit repeatedly building and integrating those systems for an industrial group. Generic engineering, generic IT, or systems-engineering capability pages alone are not enough.\nintegrator_relevant_focus: explicit customer-specific implementation ownership in a relevant vertical such as industrial automation, embedded systems, semiconductors, instrumentation, regulated/medtech, defence, or measurement-heavy environments. Pure MBSE, RBE, safety, or general development-process services alone are not enough.\nmachine_builder_ai_enablement: own shipped machine, OEM system, scanner, imaging product, hardware-centric inspection product, or single-purpose shipped software application where ONE WARE would improve the product itself.\nsoftware_platform_embedding: own software platform or modular software product where customers use modules, drivers, plugins, APIs, workflow builders, runtimes, app stores, installable extensions, or vendor-managed app lifecycles. This also includes OEM digital-service platforms where customers package once and deploy across many sites or machines.\nindustrial_end_customer_scaled: company primarily operates factories, plants, or production and the fit is their own internal inspection or process-automation need.\ncamera_manufacturer_partner: own camera or imaging hardware manufacturer.\nother: real company but weak, ambiguous, closed-niche, or non-priority fit. Use this when evidence is mixed or the fit path is not explicit.\nirrelevant: clear non-target such as media, publisher, event, investor, bank, insurer, recruiter, university, association, or comparable profile.",
  "# Decision Process\n1. Identify the core business model: external delivery services, own shipped product, build-on-top platform, internal captive IT, industrial operator, camera/imaging manufacturer, or irrelevant.\n2. Identify the likely ONE WARE fit path: service delivery partner, embed into own product, embed into a customer-facing platform, internal industrial IT, end-customer need, or none.\n3. Map to the closest category from the full list.",
  "# Tie-Break Rules\nIf the main fit is embedding ONE WARE into the company's own shipped software product, diagnostic plugin, or hardware product, choose machine_builder_ai_enablement.\nIf customers can build, configure, distribute, train, or run their own apps, models, workflows, plugins, modules, or extensions on the company's platform, choose software_platform_embedding.\nIf the site describes packaging an app once, deploying it across customer sites, managing app lifecycles, monetizing digital services, controlled updates, turnkey appliances, dashboard builders, or modular extensibility, that is usually software_platform_embedding, not an external integrator.\nIf the vendor provides the productized integration stack so customers do not have to build the integration stack themselves, that is evidence for software_platform_embedding, not service delivery.\nMentions of PLC, OPC UA, MQTT, SCADA, MES, remote operations, or system integration use cases do not make a vendor an integrator when those capabilities are delivered through the vendor's own runtime, app, or platform product.\nIf the company sells a closed niche municipal or route-planning platform for one operational workflow, choose other unless there is a clear open build-on-top surface.\nIf the company is a captive internal IT unit building MES, EDI, BI, process, or enterprise software for a larger industrial group, prefer integrator_general_ai over industrial_end_customer_scaled.\nIf evidence mixes catalog hardware with explicit custom system integration or engineering delivery, prefer machine_builder_ai_enablement, integrator_relevant_focus, or other over irrelevant.\nIf evidence is mixed, weak, or only capability-oriented without explicit fit-path proof, choose other rather than any integrator category.",
  "# Examples\nExample A: a certified radiology or medical-imaging plugin integrated into PACS or viewer systems is machine_builder_ai_enablement when it is a shipped product, not an open platform.\nExample B: an industrial software vendor that packages digital services as apps, deploys them to many customer sites through a runtime or appliance, and manages billing or update lifecycles is software_platform_embedding, not integrator_general_ai.\nExample C: a municipal waste, winter-service, street-cleaning, telematics, or route-planning cloud product with onboarding or rollout help still stays other unless customers clearly build their own apps, models, or extensions on top.\nExample D: a broad engineering generalist with MBSE, requirements engineering, hardware/software development, or system engineering pages but no explicit AI, automation, MES/SCADA, inspection, or embeddable platform/product surface should stay other.",
  "# Non-Targets\nReject media, publishing, editorial, event, investor, finance, recruiting, academic, association, and reseller profiles unless the evidence clearly shows a different real business model.",
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

  async categorizeWebsiteCrawl(
    name: string,
    domain: string | undefined,
    crawledWebsiteSummary: string,
    dryRun: boolean,
    mainContext?: string,
    prequalification?: PrequalificationConfig,
    learning?: LeadLearningData
  ): Promise<Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale">> {
    if (dryRun || !readiness.azureConfigured) {
      return this.categorizeDryRun(crawledWebsiteSummary);
    }

    const websiteProfile = domain
      ? await this.webSearchAgent.crawlCompanyWebsite(domain)
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
        { maxTokens: 120, deployment: CLASSIFIER_DEPLOYMENT }
      );

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
          { maxTokens: 120, deployment: CLASSIFIER_DEPLOYMENT }
        );

        const retryParsed = this.parseJsonObject<{
          category: LeadCategory;
          relevanceScore: number;
          rationale: string;
        }>(retryContent);

        return {
          ...retryParsed,
          category: this.normalizeCategory(retryParsed.category)
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
      ? await this.webSearchAgent.crawlCompanyWebsite(company.domain)
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
          content: `${buildMainContextBlock(mainContext)}\n\nTask: Build a concise sales research brief for ONE WARE. Use the segment template as the base and only personalize where a clear factual hook exists. Do not fully rewrite the outreach. Keep the core USP visible: less trial and error, faster path to production-ready models, more predictable timelines, local training, smaller hardware-efficient models, lower development effort. Apply the category execution context strictly. Estimate whether the decision-makers or likely target contacts are German-speaking. If yes, produce outreach in German; otherwise produce it in English. For LinkedIn, always produce two separate texts: linkedInConnectionRequest as a short connection request with a hard maximum of 200 characters, and linkedInMessage as the longer follow-up message after connecting. For German outreach, always start emailBody naturally with "Hallo [Name]," and never with "Hello". Keep German phrasing natural and direct, avoid long list-like opener sentences, avoid vague department enumerations that sound AI-written, and do not use dash punctuation such as "–" or "—" in outreach copy. Prefer commas or full sentences instead. Estimate all three commercial rankings on a 0-10 scale: customer, serviceProvider, partner. Estimate businessPotentialEUR as a realistic euro value, not a score. Use the following commercial framing: a single AI use case often starts around 7000 EUR, can be 20000 to 40000 EUR per AI for more complex or production-grade deployments, can multiply across many use cases, and OEM or camera-manufacturer partner rollouts can be much larger, including six- or seven-figure potential in recurring machine volumes. Also return targetIndustry and productsOffered. Use any supplied web evidence as your factual grounding. If no web evidence is supplied, reason only from the provided company facts and keep uncertainty explicit. If the evidence is weak or conflicting, say so in riskFlags instead of inventing certainty. The outreach must not open with generic flattery. If the evidence contains a concrete company hook such as 2D/3D machine vision, AOI, visual inspection, quality control, robot guidance, Sondermaschinenbau, MES, SCADA, factory software, or a named industrial use case, reference that hook in the first sentence of linkedInMessage and emailBody. Make the first sentence sound company-specific, not template-generic. Keep linkedInConnectionRequest shorter, simpler, and curiosity-driven than linkedInMessage. For service-provider or partner-leaning companies, keep phoneScript collaboration-first: first ask whether they already implement Vision AI or have relevant experience, then position ONE WARE as a software layer for faster production-ready models, and finally test whether a delivery partnership or joint customer work could make sense. Keep placeholders only for the contact name and sender name, not for the company-specific hook. Return strict JSON with: overview, qualificationSummary, qualifyingSignals (array of strings), riskFlags (array of strings), likelyGermanSpeaking, outreachLanguage, rankings { customer, serviceProvider, partner }, businessPotentialEUR, businessPotentialReasoning, targetIndustry, productsOffered, recommendedTemplateKey, personalizationRule, linkedInAngle, emailAngle, phoneAngle, linkedInConnectionRequest, linkedInMessage, emailSubject, emailBody, phoneScript, eventIdea.`
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

      const parsed = this.parseJsonObject<Omit<ResearchBrief, "companyName">>(content);
      return {
        companyName: company.name,
        appliedAgentContext: mainContext,
        website: websiteProfile.landingUrl,
        isFallback: false,
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

  async chooseApolloContacts(
    company: PreCategorizedCompany,
    candidates: ApolloContactCandidate[],
    dryRun: boolean,
    mainContext?: string,
    brief?: ResearchBrief
  ): Promise<ApolloContactCandidate[]> {
    const rankedCandidates = this.rankApolloContacts(candidates).slice(0, 12);
    if (rankedCandidates.length <= 5 || dryRun || !readiness.azureConfigured) {
      return rankedCandidates.slice(0, 5);
    }

    try {
      const content = await this.runChat([
        {
          role: "system",
          content: `${buildMainContextBlock(mainContext)}\n\nTask: Select the best two or three Apollo contacts for outbound outreach. Prefer decision-makers and operational owners who can sponsor or own industrial AI, machine vision, automation, digitalization, engineering, operations, manufacturing, or innovation projects. Favor CEO, CTO, COO, Founder, Owner, Managing Director, Managing Partner, Head of Automation, Head of Engineering, Head of Operations, Head of Production, Head of Manufacturing, Head of Digitalization, and similar roles. Prefer a balanced stakeholder set when possible: one executive sponsor plus one operational or technical owner, optionally a third relevant stakeholder. Avoid HR, recruiting, finance, legal, support, marketing, SDR/BDR, and generic sales contacts unless no stronger option exists. Return strict JSON with {\"selectedPersonIds\":[\"...\"],\"reason\":\"...\"}.`
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
      const minimumSelectedCount = Math.min(5, rankedCandidates.length);
      if (selected.length >= minimumSelectedCount) {
        return selected.slice(0, 5);
      }

      const augmentedSelection = [...selected];
      for (const candidate of rankedCandidates) {
        if (augmentedSelection.some((existing) => existing.personId === candidate.personId)) {
          continue;
        }

        augmentedSelection.push(candidate);
        if (augmentedSelection.length >= minimumSelectedCount) {
          break;
        }
      }

      return augmentedSelection.slice(0, 5);
    } catch {
      return rankedCandidates.slice(0, 5);
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

    if (
      productManufacturerHits >= 2 &&
      machineProductHits >= 1 &&
      visionDeliveryHits >= 1 &&
      serviceHits <= 1
    ) {
      return {
        category: "machine_builder_ai_enablement",
        relevanceScore: 84,
        rationale: "Company description looks like a product manufacturer for scanning or inspection systems rather than a service-led integrator."
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
    this.enforceCostBudget();

    const content = payload.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("Azure OpenAI returned no content.");
    }

    return content;
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
      "# Website Decision Rules\nIf the website mainly sells external customer project delivery, choose an integrator category. If it mainly sells its own shipped software product or diagnostic plugin, choose machine_builder_ai_enablement. If it mainly sells a platform or runtime where customers deploy apps, modules, agents, or workflows, choose software_platform_embedding.",
      "# Website Specific Reminders\nA certified PACS/viewer-integrated medical plugin is machine_builder_ai_enablement. A runtime, turnkey appliance, or app-lifecycle platform for OEM digital services is software_platform_embedding even if PLC, OPC UA, MQTT, SCADA, MES, remote operations, or system integration is mentioned. If the product lets customers launch industrial apps without building the integration stack themselves, prefer software_platform_embedding. A closed municipal or route-planning platform stays other unless customers clearly build on top of it. Broad engineering or MBSE-style capability pages without explicit AI, automation, MES/SCADA, inspection, or embeddable product/platform proof should stay other.",
      "# Output Reminder\nChoose the closest archetype across all categories. Do not prefer integrators when the fit path is ambiguous."
    ].join("\n\n");

    const fullWebsiteContext = [
      compactWebsiteContext,
      "# Website Examples\nExample 1: a company that develops certified radiology AI software integrated as plug-ins into PACS or viewer workstations is machine_builder_ai_enablement.\nExample 2: a vendor that packages digital services as apps, deploys them across many customer sites via a runtime or turnkey appliance, and manages updates or monetization is software_platform_embedding.\nExample 3: a municipal operations cloud for waste, winter service, or route planning with rollout help but no open extension surface is other.\nExample 4: a general engineering services site with MBSE, requirements engineering, or hardware/software development pages but no explicit fit-path proof is other."
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
            `  Categories: ${Object.entries(entry.categoryBreakdown ?? {}).filter(([, count]) => count > 0).map(([category, count]) => `${category}=${count}`).join(", ") || "none"}`,
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

  private rankApolloContacts(candidates: ApolloContactCandidate[]): ApolloContactCandidate[] {
    return [...candidates].sort((left, right) => this.getApolloContactRank(right) - this.getApolloContactRank(left));
  }

  private getApolloContactRank(candidate: ApolloContactCandidate): number {
    const title = candidate.title?.toLowerCase() ?? "";
    const seniority = candidate.seniority?.toLowerCase() ?? "";
    const departmentText = `${candidate.departments?.join(" ") ?? ""} ${candidate.functions?.join(" ") ?? ""}`.toLowerCase();

    let score = 0;

    if (/\b(ceo|cto|coo|founder|owner|geschäftsführer|managing director|managing partner|general manager)\b/.test(title)) {
      score += 12;
    }

    if (/\b(head|director|lead|vp|manager)\b/.test(title) || /\b(head|director|vp|c_suite|founder|owner|manager)\b/.test(seniority)) {
      score += 7;
    }

    if (/automation|innovation|engineering|operations|production|manufacturing|digital|vision|inspection|factory|quality|plant/.test(title)) {
      score += 6;
    }

    if (/partner|account manager|business development|business developer|technology manager|technical manager|solutions|solution/.test(title)) {
      score += 6;
    }

    if (/engineering|operations|innovation|it|product|manufacturing|quality|automation/.test(departmentText)) {
      score += 4;
    }

    if (/partner|alliances|business development|business developer|account management|technology|solutions/.test(departmentText)) {
      score += 3;
    }

    if (/hr|recruit|finance|legal|marketing|support|sales development|sdr|bdr|account executive/.test(`${title} ${departmentText}`)) {
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
      ["integrator_vision_ai_consulting", ["integrator_vision_ai_consulting", "integrator_vision_ai_consulting_freelancer", "vision ai consulting", "vision ai consultant", "computer vision consultant", "industrial ai consulting", "industrial ai consultant", "embedded vision consultant"]],
      ["integrator_vision_ai_freelancer", ["integrator_vision_ai_freelancer", "vision ai freelancer", "computer vision freelancer", "embedded vision freelancer", "industrial ai freelancer"]],
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
        subject: "Deploy vision AI without long optimization cycles",
        emailBody: "Hello Mr./Ms. [Name],\n\nI saw that you work on vision-related integration projects. Have you already experienced how small datasets, repeated trial and error, and unstable model quality can slow these projects down?\n\nThat is exactly where ONE WARE comes in. Our software creates task-specific vision-AI models with much less trial and error, often from smaller datasets, and in many cases with better accuracy than universal models. At the same time, the result can be deployed on cost-efficient hardware.\n\nWe have already seen companies use this to move beyond one single use case and automate several inspection or process steps. For integrators this is especially relevant because projects become easier to deliver, and when it fits we can also connect partners with real customer opportunities.\n\nWould you be open to a short exchange to see whether this could be relevant for your current projects?\n\nBest regards,\n[Your Name]",
        linkedInConnectionRequest: "Quick question: are you already delivering vision-AI projects? We often see smaller datasets and less trial and error lead to much faster results.",
        linkedInMessage: "Quick question: are you already delivering vision-AI projects? We often see that with smaller datasets and far less trial and error, teams can reach better results than with generic models. Would that be interesting for you?",
        phoneScript: "Hello Mr./Ms. [Name], this is [Your Name] from ONE WARE. I wanted to ask whether you already implement vision-AI applications for customers or have hands-on experience there. We provide software that gets production-ready vision-AI models much faster. Because we cannot cover every integration and consulting project ourselves, we are speaking with partners where a collaboration could make sense. Would that be worth a conversation for you?"
      },
      integrator_vision_ai_consulting_template: {
        subject: "Deliver consulting-led vision-AI projects faster",
        emailBody: "Hello Mr./Ms. [Name],\n\nIf you advise customers on vision AI, you probably know the situation: the idea is clear, but model choice, data quality, and repeated iterations consume far more time than expected.\n\nWith ONE WARE we have a new approach that can generate production-ready vision-AI models very quickly from available data. That makes it easier to recommend a concrete path forward to customers, even when the dataset is not perfect.\n\nWe have already seen customers use this kind of efficient and accurate AI to automate several steps instead of only one. For consultancies this is valuable because it becomes a strong solution element for client work, and when it fits we can also bring relevant end-customer opportunities.\n\nWould you be open to a short exchange to see whether this could fit your client projects?\n\nBest regards,\n[Your Name]",
        linkedInConnectionRequest: "Quick question: are you already advising customers on vision AI? We have a new approach that gets to strong models much faster.",
        linkedInMessage: "Quick question: are you already advising customers on vision AI? We have a new approach that can get to strong models much faster and can work well as an additional solution for client projects.",
        phoneScript: "Hello Mr./Ms. [Name], this is [Your Name] from ONE WARE. I wanted to ask whether you already implement vision-AI applications for clients or have strong experience there. We provide software that gets production-ready vision-AI models much faster. Since we cannot take on every integration and consulting project ourselves, we are looking for partners for joint delivery where it fits. Would that be relevant for you?"
      },
      integrator_vision_ai_freelancer_template: {
        subject: "Reduce tuning effort in freelance vision-AI delivery",
        emailBody: "Hello Mr./Ms. [Name],\n\nIf you implement vision-AI projects independently, you probably know how much time can disappear into dataset issues, model selection, and repeated experimentation before the result is really stable.\n\nWith ONE WARE, task-specific vision-AI models can be created much faster, often from smaller datasets and with less trial and error. In many cases the result is more accurate than with generic models, and it can run on cost-efficient hardware.\n\nThat matters especially for freelancers because projects become easier to deliver. And if it fits, we can also connect specialists with relevant customer opportunities.\n\nWould a short exchange make sense to see whether this would be useful for your current work?\n\nBest regards,\n[Your Name]",
        linkedInConnectionRequest: "Quick question: are you already delivering vision-AI projects? Smaller datasets and less trial and error often lead to much faster strong results.",
        linkedInMessage: "Quick question: are you already delivering vision-AI projects? We often see that with smaller datasets and much less trial and error, teams can reach very strong results much faster. Would that be relevant for you?",
        phoneScript: "Hello Mr./Ms. [Name], this is [Your Name] from ONE WARE. I wanted to ask whether you already implement vision-AI applications for clients or have hands-on experience there. We provide software that gets production-ready vision-AI models much faster. Because we cannot cover every integration project ourselves, we are also exploring partnerships with experienced specialists. Would that be interesting for you?"
      },
      integrator_general_ai_template: {
        subject: "Move AI projects to production-ready vision AI faster",
        emailBody: "Hello Mr./Ms. [Name],\n\nI saw that you deliver software and AI projects. I would be interested to know whether you already have practical experience with vision AI as well.\n\nIf yes, ONE WARE could be relevant for you. Our software makes vision-AI model creation much more efficient, with far less trial and error and much less effort until the solution is ready for production.\n\nThat is attractive for service providers because projects become easier to deliver, and we also work with end customers where the right implementation partner can matter a lot.\n\nWould you be open to a short exchange to see whether this could be relevant for you?\n\nBest regards,\n[Your Name]",
        linkedInConnectionRequest: "Quick question: do you already have practical vision-AI experience in your software or AI projects? If yes, ONE WARE could be relevant.",
        linkedInMessage: "Quick question: have you already built up practical vision-AI experience in your software or AI projects? If yes, we could be relevant for making that part much more efficient.",
        phoneScript: "Hello Mr./Ms. [Name], this is [Your Name] from ONE WARE. I wanted to ask whether you already implement vision-AI applications for customers or are building that capability now. We provide software that gets production-ready vision-AI models much faster. Since we cannot deliver every integration and consulting project ourselves, we are speaking with service partners where collaboration could make sense. Would that be worth discussing?"
      },
      integrator_relevant_focus_template: {
        subject: "Deliver vision AI faster in demanding vertical projects",
        emailBody: "Hello Mr./Ms. [Name],\n\nIn demanding projects, vision AI is often the part that consumes the most time even when the actual application is already clear.\n\nWith ONE WARE, task-specific models can be generated much faster, with less trial and error, and in a way that also makes smaller or cheaper hardware setups realistic. That makes projects easier to plan and often opens the door to additional automation steps for the customer.\n\nFor integrators this is especially relevant because more projects become feasible in the same amount of time. And when it fits, we can also connect partners with concrete end-customer opportunities.\n\nWould a short exchange make sense to see whether this could fit your projects?\n\nBest regards,\n[Your Name]",
        linkedInConnectionRequest: "Quick question: do you already have hands-on vision-AI experience? Less trial and error often makes far more automation possible than expected.",
        linkedInMessage: "Quick question: do you already have hands-on vision-AI experience in your projects? We often see that with less trial and error and more efficient deployment, customers can automate much more than expected.",
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