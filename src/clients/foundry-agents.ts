import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";
import { env, readiness } from "../config";
import { ApolloOrganizationFilter, LeadCategory, LeadLearningData, PreCategorizedCompany, PrequalificationConfig, ResearchBrief, StoredFilterSnapshot } from "../types";
import {
  ONE_WARE_PROMPT_CONTEXT,
  TARGET_REGIONS,
  buildExecutionContextBlock,
  buildPrequalificationContextBlock,
  buildSearchStrategyContextBlock,
  getTemplateForCategory
} from "../prompting/one-ware-playbook";

type AgentKind = "filters" | "qualification" | "research";

interface CachedAgentReference {
  name: string;
  version: string;
}

interface AgentTextResponse {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
      }>;
    }>;
  }>;
}

export class FoundryAgentsClient {
  private projectClient?: AIProjectClient;

  private openAIClient?: {
    responses: {
      create: (body: Record<string, unknown>, options?: Record<string, unknown>) => Promise<AgentTextResponse>;
    };
  };

  private readonly agentCache = new Map<AgentKind, Promise<CachedAgentReference>>();

  async generateSuggestedFilters(
    market: string | undefined,
    customGoal: string | undefined,
    agentContext: string | undefined,
    searchStrategyContext: string | undefined,
    targetCategories: LeadCategory[] | undefined,
    baseFilters: ApolloOrganizationFilter[],
    dryRun: boolean,
    learning?: LeadLearningData
  ): Promise<ApolloOrganizationFilter[]> {
    if (dryRun || !readiness.foundryConfigured) {
      return baseFilters;
    }

    try {
      const content = await this.runAgent("filters", [
        `Market focus: ${market ?? "Germany"}`,
        customGoal ? `Custom goal: ${customGoal}` : "Custom goal: Keep focus on the highest-conviction ICP.",
        agentContext ? `Operator context: ${agentContext}` : undefined,
        buildSearchStrategyContextBlock(searchStrategyContext, agentContext),
        targetCategories?.length ? `Target categories: ${targetCategories.join(", ")}` : undefined,
        `Existing Apollo filters JSON:\n${JSON.stringify(baseFilters)}`,
        this.buildLearningContextForSearchStrategy(learning)
      ].filter(Boolean).join("\n\n"));

      const parsed = JSON.parse(content) as { filters?: ApolloOrganizationFilter[] };
      const filters = (parsed.filters ?? []).filter((filter) => this.isValidApolloFilter(filter));

      return filters.length > 0 ? filters : baseFilters;
    } catch {
      return baseFilters;
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
      .slice(0, 8)
      .map(([name, stats]) => {
        const snapshot = latestHistoryByName.get(name)?.filterSnapshot;
        return [
          `${name}: avg ${(stats.averageRelevanceRatio * 100).toFixed(0)}%, runs ${stats.runs}, early stops ${stats.earlyStopCount}`,
          snapshot ? `Snapshot: ${this.formatFilterSnapshot(snapshot)}` : undefined
        ].filter(Boolean).join("\n");
      });

    const recentHistory = learning.searchHistory
      .slice()
      .sort((left, right) => Number(Boolean(right.filterSnapshot)) - Number(Boolean(left.filterSnapshot)))
      .slice(0, 8)
      .map((entry) => [
        `${entry.filterName} | ${entry.batchType} | ${entry.relevantCount}/${entry.returnedCount} relevant | ${(entry.relevanceRatio * 100).toFixed(0)}% | ${entry.recommendation}`,
        entry.filterSnapshot ? `Snapshot: ${this.formatFilterSnapshot(entry.filterSnapshot)}` : undefined
      ].filter(Boolean).join("\n"));

    const sections = [
      topFilters.length > 0 ? ["Known filter performance:", ...topFilters].join("\n") : undefined,
      recentHistory.length > 0 ? ["Recent search history:", ...recentHistory].join("\n") : undefined
    ].filter(Boolean);

    return sections.length > 0 ? sections.join("\n\n") : undefined;
  }

  private formatFilterSnapshot(snapshot: StoredFilterSnapshot): string {
    return [
      `Persona=${snapshot.persona}`,
      `Industries=${snapshot.industries.join(", ")}`,
      `Keywords=${snapshot.keywords.join(", ")}`,
      `Locations=${snapshot.locations.join(", ")}`,
      `Employees=${snapshot.employeeRanges.join(", ")}`,
      `Notes=${snapshot.notes}`
    ].join(" | ");
  }

  async categorizeCompany(
    name: string,
    description: string,
    mainContext: string | undefined,
    prequalification: PrequalificationConfig | undefined,
    targetCategories: LeadCategory[] | undefined,
    dryRun: boolean
  ): Promise<Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale"> | null> {
    if (dryRun || !readiness.foundryConfigured) {
      return null;
    }

    try {
      const content = await this.runAgent(
        "qualification",
        [
          `Company: ${name}`,
          `Description: ${description}`,
          `Target regions: ${TARGET_REGIONS.join(", ")}`,
          buildPrequalificationContextBlock(prequalification, targetCategories, mainContext),
          targetCategories?.length ? `Active target categories: ${targetCategories.join(", ")}` : undefined
        ]
          .filter(Boolean)
          .join("\n")
      );

      const parsed = JSON.parse(content) as {
        category?: LeadCategory;
        relevanceScore?: number;
        rationale?: string;
      };

      if (!parsed.category || typeof parsed.relevanceScore !== "number" || !parsed.rationale) {
        return null;
      }

      return {
        category: parsed.category,
        relevanceScore: parsed.relevanceScore,
        rationale: parsed.rationale
      };
    } catch {
      return null;
    }
  }

  async buildResearchBrief(
    company: PreCategorizedCompany,
    mainContext: string | undefined,
    dryRun: boolean
  ): Promise<ResearchBrief | null> {
    if (dryRun || !readiness.foundryConfigured) {
      return null;
    }

    const template = getTemplateForCategory(company.category);

    try {
      const response = await this.runAgentWithMetadata(
        "research",
        [
          `Company: ${company.name}`,
          company.domain ? `Website: ${company.domain}` : "Website: unknown",
          company.country ? `Country: ${company.country}` : "Country: unknown",
          `Known description: ${company.shortDescription}`,
          `Category: ${company.category}`,
          buildExecutionContextBlock(company.category, mainContext),
          `Source filter: ${company.sourceFilter}`,
          `Relevance score: ${company.relevanceScore}`,
          `Template key: ${template.key}`,
          `Template subject: ${template.subject}`,
          `Template email body:\n${template.emailBody}`,
          `Template LinkedIn message:\n${template.linkedInMessage}`,
          `Template phone script:\n${template.phoneScript}`
        ].join("\n\n")
      );

      const parsed = JSON.parse(response.text) as Omit<ResearchBrief, "companyName">;

      return {
        companyName: company.name,
        appliedAgentContext: mainContext,
        citations: response.citations,
        ...parsed
      };
    } catch {
      return null;
    }
  }

  private async runAgent(kind: AgentKind, input: string): Promise<string> {
    const response = await this.runAgentWithMetadata(kind, input);

    if (!response.text) {
      throw new Error(`Foundry agent '${kind}' returned no text.`);
    }

    return response.text;
  }

  private async runAgentWithMetadata(
    kind: AgentKind,
    input: string
  ): Promise<{ text: string; citations: string[] }> {
    const agent = await this.ensureAgent(kind);
    const response = await this.openAI.responses.create(
      {
        input
      },
      {
        body: {
          agent: { name: agent.name, type: "agent_reference" },
          tool_choice: kind === "research" ? "auto" : undefined
        }
      }
    );

    const citations = Array.from(
      new Set(
        (response.output ?? [])
          .flatMap((item) => item.content ?? [])
          .flatMap((content) => content.annotations ?? [])
          .filter((annotation) => annotation.type === "url_citation" && annotation.url)
          .map((annotation) => annotation.url as string)
      )
    );

    return {
      text: response.output_text ?? "",
      citations
    };
  }

  private async ensureAgent(kind: AgentKind): Promise<CachedAgentReference> {
    const cached = this.agentCache.get(kind);
    if (cached) {
      return cached;
    }

    const creation = this.createAgent(kind);
    this.agentCache.set(kind, creation);
    return creation;
  }

  private async createAgent(kind: AgentKind): Promise<CachedAgentReference> {
    const agentName = `lead-agent-${kind}`;
    const definition = await this.buildAgentDefinition(kind);
    const agent = await this.project.agents.createVersion(agentName, definition as any);

    return {
      name: agent.name,
      version: agent.version
    };
  }

  private async buildAgentDefinition(kind: AgentKind): Promise<Record<string, unknown>> {
    switch (kind) {
      case "filters":
        return {
          kind: "prompt",
          model: env.FOUNDRY_MODEL_DEPLOYMENT ?? env.AZURE_OPENAI_DEPLOYMENT,
          instructions: `${ONE_WARE_PROMPT_CONTEXT}\n\nYou are the Apollo Filter Strategy Agent. Follow any supplied main context strictly. Generate 4 to 6 Apollo company search filters focused on Germany first. Start unbiased by identifying which firm archetypes are most likely to contain service-led delivery companies for the requested categories. Focus strongest on software integrators, automation engineering firms, embedded/industrial software service providers, industrial customers with own engineering, and machine builders with plausible need. Avoid magazines, publishers, media brands, event businesses, associations, universities, research institutes, VCs, banks, insurers, broad consultancies, China, Saudi Arabia, and competing AI platform vendors. Avoid broad keywords like robotics or AI alone when they are likely to pull robot makers, product startups, hardware vendors, or editorial brands. Prefer service-intent keywords such as system integrator, implementation, engineering services, software services, machine vision integration, inspection integration, embedded development, automation projects, and solution provider. Return strict JSON: {"filters":[{"name":"...","persona":"...","industries":[...],"keywords":[...],"locations":[...],"employeeRanges":[...],"notes":"..."}]}. Keep industries and keywords practical for Apollo.`
        };
      case "qualification":
        return {
          kind: "prompt",
          model: env.FOUNDRY_MODEL_DEPLOYMENT ?? env.AZURE_OPENAI_DEPLOYMENT,
          instructions: `${ONE_WARE_PROMPT_CONTEXT}\n\nYou are the Pre-Qualification Agent. Follow any supplied main context and prequalification context strictly. Analyze completely unbiased before choosing any positive category. First determine the firm archetype: implementation-led integrator, industrial end customer, camera/imaging manufacturer, machine builder/OEM, software platform, or clearly irrelevant profile. Classify companies into exactly one category: integrator_vision_industrial_ai, integrator_general_ai, integrator_relevant_focus, industrial_end_customer_scaled, camera_manufacturer_partner, machine_builder_ai_enablement, software_platform_embedding, irrelevant, other. Do not infer delivery ownership or fit from the Apollo filter name, source filter, or a vague company name alone. If the supplied company description is missing, generic, or placeholder-like, return other or irrelevant unless there is strong explicit evidence for a positive category. Treat magazines, publishers, media portals, editorial brands, event businesses, associations, universities, research institutes, VCs, banks, insurers, recruiters, generic consultancies without implementation ownership, and direct AI-platform competitors as irrelevant. Do not classify robot manufacturers, product-led robotics brands, OEMs, or hardware vendors as integrators unless clear implementation services are visible. Focus on delivery ownership, geography fit, repeated project patterns, and whether the company sells services or internal delivery rather than a competing AI software stack. Return strict JSON with category, relevanceScore from 0 to 100, and rationale.`
        };
      case "research": {
        const tools = await this.buildResearchTools();
        return {
          kind: "prompt",
          model: env.FOUNDRY_MODEL_DEPLOYMENT ?? env.AZURE_OPENAI_DEPLOYMENT,
          instructions: `${ONE_WARE_PROMPT_CONTEXT}\n\nYou are the Deep Research Agent. Use web grounding to verify the company, identify its business model, target customers, recent signals, likely Vision-AI or process-automation relevance, and clear outreach hooks. Always adapt your reasoning to the supplied main context and category-specific execution context. Estimate whether likely target contacts are German-speaking. If yes, produce outreach in German, otherwise in English. Estimate rankings on a 0-10 scale for customer, serviceProvider, and partner. Estimate businessPotentialEUR as a euro value. Return targetIndustry and productsOffered. Use the provided segment template as the base. Personalize only if there is a clear factual hook. Do not rewrite the outreach from scratch. Make the output steerable by preserving the template direction while sharpening the most relevant business pain. Return strict JSON with: overview, qualificationSummary, qualifyingSignals (array of strings), riskFlags (array of strings), likelyGermanSpeaking, outreachLanguage, rankings { customer, serviceProvider, partner }, businessPotentialEUR, businessPotentialReasoning, targetIndustry, productsOffered, recommendedTemplateKey, personalizationRule, linkedInAngle, emailAngle, phoneAngle, linkedInMessage, emailSubject, emailBody, phoneScript, eventIdea.` ,
          tools
        };
      }
      default:
        throw new Error(`Unsupported agent kind: ${kind satisfies never}`);
    }
  }

  private async buildResearchTools(): Promise<Array<Record<string, unknown>>> {
    if (env.FOUNDRY_BING_CONNECTION_NAME) {
      const connection = await this.project.connections.get(env.FOUNDRY_BING_CONNECTION_NAME);

      return [
        {
          type: "bing_grounding",
          bing_grounding: {
            search_configurations: [
              {
                project_connection_id: connection.id
              }
            ]
          }
        }
      ];
    }

    return [
      {
        type: "web_search",
        user_location: {
          type: "approximate",
          country: "DE",
          city: "Osnabrueck",
          region: "Lower Saxony"
        },
        search_context_size: "high"
      }
    ];
  }

  private isValidApolloFilter(filter: ApolloOrganizationFilter | undefined): filter is ApolloOrganizationFilter {
    return Boolean(
      filter &&
        filter.name &&
        filter.persona &&
        Array.isArray(filter.industries) &&
        Array.isArray(filter.keywords) &&
        Array.isArray(filter.locations) &&
        Array.isArray(filter.employeeRanges) &&
        typeof filter.notes === "string"
    );
  }

  private get project(): AIProjectClient {
    if (!this.projectClient) {
      this.projectClient = new AIProjectClient(env.FOUNDRY_PROJECT_ENDPOINT as string, new DefaultAzureCredential());
    }

    return this.projectClient;
  }

  private get openAI(): {
    responses: {
      create: (body: Record<string, unknown>, options?: Record<string, unknown>) => Promise<AgentTextResponse>;
    };
  } {
    if (!this.openAIClient) {
      this.openAIClient = this.project.getOpenAIClient() as unknown as {
        responses: {
          create: (body: Record<string, unknown>, options?: Record<string, unknown>) => Promise<AgentTextResponse>;
        };
      };
    }

    return this.openAIClient;
  }
}