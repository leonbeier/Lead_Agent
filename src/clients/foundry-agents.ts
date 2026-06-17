import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";
import { env, readiness } from "../config";
import { OrganizationFilter, LeadCategory, LeadLearningData, normalizeOutreachLanguage, PreCategorizedCompany, PrequalificationConfig, PublicContactCandidate, ResearchBrief, StoredFilterSnapshot } from "../types";
import {
  ONE_WARE_PROMPT_CONTEXT,
  TARGET_REGIONS,
  buildExecutionContextBlock,
  buildPrequalificationContextBlock,
  buildSearchStrategyContextBlock,
  getTemplateForCategory
} from "../prompting/one-ware-playbook";

type AgentKind = "filters" | "qualification" | "research" | "contacts" | "contact_queries";

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

  // Diagnostic: exercise the full Foundry auth + agent + responses path and surface the raw error
  // instead of silently returning []. Used by the contact-discovery probe endpoint to prove whether
  // Foundry (DefaultAzureCredential) actually authenticates in the deployed environment.
  async probeConnectivity(): Promise<{ ok: boolean; error?: string; queries?: string[] }> {
    if (!readiness.foundryConfigured) {
      return { ok: false, error: "foundryConfigured=false (FOUNDRY_PROJECT_ENDPOINT not set)" };
    }

    try {
      const content = await this.runAgent(
        "contact_queries",
        [
          "Company: Foundry Connectivity Probe",
          "Website: example.com",
          "Country: Germany",
          "Target roles: CEO.",
          "Return strict JSON: {\"queries\":[\"site:linkedin.com/in example\"]}"
        ].join("\n\n")
      );
      const parsed = JSON.parse(content) as { queries?: string[] };
      return { ok: true, queries: (parsed.queries ?? []).slice(0, 3) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    }
  }

  async generateSuggestedFilters(
    market: string | undefined,
    customGoal: string | undefined,
    agentContext: string | undefined,
    searchStrategyContext: string | undefined,
    targetCategories: LeadCategory[] | undefined,
    baseFilters: OrganizationFilter[],
    dryRun: boolean,
    learning?: LeadLearningData
  ): Promise<OrganizationFilter[]> {
    if (dryRun || !readiness.foundryConfigured || !env.FOUNDRY_USE_AGENT_FILTERS) {
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

      const parsed = JSON.parse(content) as { filters?: OrganizationFilter[] };
      const filters = (parsed.filters ?? []).filter((filter) => this.isValidOrganizationFilter(filter));

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
        entry.fetchedSampleCount !== undefined
          ? `Prefilter: fetched ${entry.fetchedSampleCount}, eligible ${entry.eligibleSampleCount ?? entry.returnedCount}, rejected feedback ${entry.dropOffSummary?.filteredByPriorFeedback ?? 0}, cache ${entry.dropOffSummary?.filteredByCache ?? 0}, hubspot ${entry.dropOffSummary?.filteredByHubSpot ?? 0}`
          : undefined,
        entry.discoveryQueries && entry.discoveryQueries.length > 0
          ? `Queries: ${entry.discoveryQueries.join(" || ")}`
          : undefined,
        entry.decisionSamples && entry.decisionSamples.length > 0
          ? `Decisions: ${entry.decisionSamples.slice(0, 3).map((sample) => `${sample.companyName} => ${sample.category} (${sample.relevanceScore}) because ${sample.rationale}`).join(" || ")}`
          : undefined,
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
    _targetCategories: LeadCategory[] | undefined,
    dryRun: boolean
  ): Promise<Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale"> | null> {
    if (dryRun || !readiness.foundryConfigured || !env.FOUNDRY_USE_AGENT_QUALIFICATION) {
      return null;
    }

    try {
      const content = await this.runAgent(
        "qualification",
        [
          `Company: ${name}`,
          `Description: ${description}`,
          `Target regions: ${TARGET_REGIONS.join(", ")}`,
          buildPrequalificationContextBlock(prequalification, undefined, mainContext)
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
    if (dryRun || !readiness.foundryConfigured || !env.FOUNDRY_USE_AGENT_RESEARCH) {
      return null;
    }

    const template = getTemplateForCategory(company.category);
    const targetOutreachLanguage = this.inferTargetOutreachLanguage(company);
    const targetOutreachLanguageLabel = targetOutreachLanguage === "de" ? "German" : "English";
    const templateLanguageInstruction = targetOutreachLanguage === "de"
      ? "Use the supplied template text directly as the base direction and keep the final outreach in German."
      : "The supplied template text may be German. Translate its meaning into natural English first and use that translated English version as the base direction. Never copy German phrases into English outreach.";

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
          `Target outreach language: ${targetOutreachLanguageLabel} (${targetOutreachLanguage})`,
          templateLanguageInstruction,
          `Template key: ${template.key}`,
          `Template subject: ${template.subject}`,
          `Template email body:\n${template.emailBody}`,
          `Template LinkedIn connection request:\n${template.linkedInConnectionRequest}`,
          `Template LinkedIn message:\n${template.linkedInMessage}`,
          `Template phone script:\n${template.phoneScript}`
        ].join("\n\n")
      );

      const parsed = JSON.parse(response.text) as Omit<ResearchBrief, "companyName" | "outreachLanguage"> & { outreachLanguage?: string };

      return {
        companyName: company.name,
        appliedAgentContext: mainContext,
        citations: response.citations,
        ...parsed,
        outreachLanguage: normalizeOutreachLanguage(parsed.outreachLanguage, parsed.likelyGermanSpeaking ? "de" : "en")
      };
    } catch {
      return null;
    }
  }

  private inferTargetOutreachLanguage(company: Pick<PreCategorizedCompany, "country" | "domain" | "name">): "de" | "en" {
    const normalizedCountry = company.country?.trim().toLowerCase();
    if (["germany", "austria", "switzerland", "de", "at", "ch", "deutschland", "oesterreich", "österreich", "schweiz"].includes(normalizedCountry ?? "")) {
      return "de";
    }

    const normalizedDomain = company.domain?.trim().toLowerCase();
    if (normalizedDomain?.endsWith(".de") || normalizedDomain?.endsWith(".at")) {
      return "de";
    }

    if (/(gmbh|ag|kg|ug)\b/i.test(company.name)) {
      return "de";
    }

    return "en";
  }

  async discoverPublicContacts(
    company: Pick<PreCategorizedCompany, "name" | "domain" | "country">,
    evidence: string,
    dryRun: boolean
  ): Promise<PublicContactCandidate[]> {
    if (dryRun || !readiness.foundryConfigured) {
      return [];
    }

    try {
      const content = await this.runAgent(
        "contacts",
        [
          `Company: ${company.name}`,
          company.domain ? `Website: ${company.domain}` : "Website: unknown",
          company.country ? `Country: ${company.country}` : "Country: unknown",
          "Target contact roles: CEO, CTO, COO, Geschäftsführer, Inhaber, Managing Director, Innovation Manager, Partner Manager, Technology Manager, Operations Manager.",
          evidence
        ].join("\n\n")
      );

      const parsed = JSON.parse(content) as {
        contacts?: Array<{
          firstName?: string;
          lastName?: string;
          fullName?: string;
          jobTitle?: string;
          email?: string;
          phone?: string;
          linkedinUrl?: string;
          sourceUrl?: string;
          label?: string;
        }>;
      };

      return (parsed.contacts ?? [])
        .map<PublicContactCandidate | null>((contact) => {
          const fullName = contact.fullName?.trim();
          const fallbackNameParts = fullName?.split(/\s+/).filter(Boolean) ?? [];
          const firstName = contact.firstName?.trim() || fallbackNameParts[0];
          const lastName = contact.lastName?.trim() || (fallbackNameParts.length > 1 ? fallbackNameParts.slice(1).join(" ") : undefined);
          const linkedinUrl = contact.linkedinUrl?.trim();
          const sourceUrl = contact.sourceUrl?.trim() || linkedinUrl;

          if (!sourceUrl) {
            return null;
          }

          if (!firstName && !lastName && !contact.email?.trim() && !linkedinUrl) {
            return null;
          }

          return {
            firstName,
            lastName,
            email: contact.email?.trim().toLowerCase() || undefined,
            phone: contact.phone?.trim() || undefined,
            jobTitle: contact.jobTitle?.trim() || undefined,
            linkedinUrl,
            sourceUrl,
            label: contact.label?.trim() || "foundry_web_contact"
          } satisfies PublicContactCandidate;
        })
        .filter((contact): contact is PublicContactCandidate => contact !== null);
    } catch (err) {
      console.error(`[FoundryAgents.discoverPublicContacts] error for ${company.name}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async suggestPublicContactQueries(
    company: Pick<PreCategorizedCompany, "name" | "domain" | "country">,
    evidence: string,
    dryRun: boolean
  ): Promise<string[]> {
    if (dryRun || !readiness.foundryConfigured) {
      return [];
    }

    try {
      const content = await this.runAgent(
        "contact_queries",
        [
          `Company: ${company.name}`,
          company.domain ? `Website: ${company.domain}` : "Website: unknown",
          company.country ? `Country: ${company.country}` : "Country: unknown",
          "Target roles: CEO, CTO, COO, Geschäftsführer, Inhaber, Managing Director, Innovation Manager, Partner Manager, Technology Manager, Operations Manager.",
          evidence
        ].join("\n\n")
      );

      const parsed = JSON.parse(content) as { queries?: string[] };
      return (parsed.queries ?? []).map((query) => query.trim()).filter(Boolean).slice(0, 10);
    } catch {
      return [];
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
    const response = await this.createAgentResponseWithRetry(kind, agent, input);

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

  // The Azure AI Foundry responses endpoint (and its bing_grounding tool) intermittently
  // returns transient gateway failures such as "upstream error", 429/5xx, or dropped
  // connections. These are not content problems, so a bounded retry recovers the agent
  // call instead of silently returning no contacts/research. Permanent errors (auth,
  // bad request) are not retried.
  private async createAgentResponseWithRetry(
    kind: AgentKind,
    agent: CachedAgentReference,
    input: string
  ): Promise<AgentTextResponse> {
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.openAI.responses.create(
          {
            input
          },
          {
            body: {
              agent_reference: { name: agent.name, type: "agent_reference" },
              tool_choice: kind === "research" ? "auto" : undefined
            }
          }
        );
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts || !this.isTransientFoundryError(error)) {
          throw error;
        }

        const backoffMs = 1000 * attempt;
        console.warn(
          `[FoundryAgents.${kind}] transient error on attempt ${attempt}/${maxAttempts}, retrying in ${backoffMs}ms: ${error instanceof Error ? error.message : String(error)}`
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private isTransientFoundryError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    const status = (error as { status?: number; statusCode?: number } | undefined)?.status
      ?? (error as { statusCode?: number } | undefined)?.statusCode;

    if (typeof status === "number" && (status === 408 || status === 429 || status >= 500)) {
      return true;
    }

    return /upstream error/.test(message)
      || /\b(429|500|502|503|504)\b/.test(message)
      || /rate limit|throttl/.test(message)
      || /timed out|timeout/.test(message)
      || /temporarily unavailable|service unavailable|bad gateway|gateway timeout/.test(message)
      || /econnreset|econnrefused|etimedout|socket hang up|fetch failed|network/.test(message);
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
    // Azure agent names must be alphanumeric with hyphens only (no underscores) and <=63 chars.
    // Agent kinds like "contact_queries" contain underscores, so normalize them to hyphens.
    const agentName = `lead-agent-${kind.replace(/_/g, "-")}`;
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
          instructions: `${ONE_WARE_PROMPT_CONTEXT}\n\nYou are the Apollo Filter Strategy Agent. Follow any supplied main context strictly. Generate 4 to 6 Apollo company search filters focused on Germany first. Start unbiased by identifying which firm archetypes are most likely to contain service-led delivery companies for the requested categories. Focus strongest on software integrators, automation engineering firms, embedded/industrial software service providers, industrial customers with own engineering, and machine builders with plausible need. Keep wording concrete and close to the strongest service-led archetypes because Apollo is highly sensitive to small wording changes. Treat exclusions as equally important as inclusion terms. Avoid magazines, publishers, media brands, event businesses, associations, universities, research institutes, VCs, banks, insurers, broad consultancies, China, Saudi Arabia, and competing AI platform vendors. Explicitly avoid hardware vendors, OEMs, publishers, media brands, and pure consultancies unless operator context says otherwise. Avoid broad keywords like robotics or AI alone when they are likely to pull robot makers, product startups, hardware vendors, or editorial brands. Do not broaden with AI solutions, manufacturing alone, generic software labels, or looser employee ranges when those changes risk generic AI or software-company results. Prefer service-intent keywords such as project-based software integrator, system integrator, implementation, engineering services, software services, machine vision, industrial inspection, image processing, embedded development, automation projects, and solution provider. High-signal keyword families include AOI, automated optical inspection, inline inspection, optical quality control, industrial image processing, embedded computer vision, feasibility study, camera calibration, lighting optimization, MES integration, SCADA integration, PLC software integration, OT integration, smart factory software, and industrial software engineering. Split broad themes into neighboring variants instead of one generic umbrella filter. Return strict JSON: {"filters":[{"name":"...","persona":"...","industries":[...],"keywords":[...],"locations":[...],"employeeRanges":[...],"notes":"..."}]}. Keep industries and keywords practical for Apollo.`
        };
      case "qualification":
        return {
          kind: "prompt",
          model: env.FOUNDRY_MODEL_DEPLOYMENT ?? env.AZURE_OPENAI_DEPLOYMENT,
          instructions: `${ONE_WARE_PROMPT_CONTEXT}\n\nYou are the Pre-Qualification Agent. Follow any supplied main context and prequalification context strictly. Analyze completely unbiased before choosing any positive category. First determine the firm archetype: implementation-led integrator, industrial end customer, camera/imaging manufacturer, machine builder/OEM, software platform, consulting firm, freelancer, or clearly irrelevant profile. Classify companies into exactly one category: integrator_vision_industrial_ai, integrator_vision_ai_consulting, integrator_vision_ai_freelancer, integrator_general_ai, integrator_relevant_focus, industrial_end_customer_scaled, camera_manufacturer_partner, machine_builder_ai_enablement, machine_builder_vision_ai, software_platform_embedding, irrelevant, other. Do not infer delivery ownership or fit from the Apollo filter name, source filter, or a vague company name alone. Read supplied website evidence as aggregate business-model context that may come from homepage, about, products, services, documentation, integrations, use cases, references, or application pages. Positive archetypes are project-led, implementation-heavy, industrially grounded, close to customer operations, or expose a real embeddable workflow product surface. Consulting firms are only positive when hands-on machine vision, AOI, embedded vision, or industrial AI implementation for clients is explicit. Freelancer profiles are only positive when the website clearly describes an individual or solo specialist offering the same hands-on implementation work. High-signal phrases include AOI, automated optical inspection, inline inspection, optical quality control, industrial image processing, machine vision integration, embedded computer vision, feasibility study, camera calibration, lighting optimization, MES integration, SCADA integration, PLC software integration, OT integration, smart factory software, and industrial software engineering. Companies that build their own quality-control systems, inspection machines, AOI systems, inspection stations, or special-purpose industrial inspection equipment should usually be machine_builder_ai_enablement rather than an integrator unless customer-specific implementation services clearly dominate. If the company mainly develops, manufactures, or sells its own scanners, scan bars, cameras, devices, machines, or branded industrial systems, prefer machine_builder_ai_enablement or camera_manufacturer_partner over any integrator category. Productized Vision-AI software vendors can also fit machine_builder_ai_enablement when they ship their own computer-vision or clinical-imaging application into customer workflows and could benefit from better model quality or deployment results. Require a real own product and explicit vision, image-analysis, diagnostic, inspection, or embedded-workflow relevance, not generic software. If the main fit is that ONE WARE would be embedded into the company's own shipped software product or diagnostic application, prefer machine_builder_ai_enablement over any integrator category. Use machine_builder_vision_ai instead when Vision AI, machine vision, optical inspection, or computer vision is the PRIMARY purpose of the machines the company ships, for example AOI machines, inline optical inspection systems, or automated visual quality-control equipment sold specifically for visual AI. Do not use machine_builder_vision_ai when Vision AI is only a minor or optional feature on a machine whose main purpose is something else. Do not mark medical-imaging, radiology, or clinical workflow AI products as irrelevant just because they are in healthcare; if they ship a concrete diagnostic application or plugin integrated into existing systems, they are valid positives. Do not mistake investor-relations, awards, news, or magazine navigation on a product site for the core business model; prioritize product, workflow, integration, and customer-value statements. If the company mainly sells a route-planning, telematics, logistics, or municipal operations platform, do not force it into integrator_general_ai just because AI or integration is mentioned. Municipal operations software for waste collection, winter service, street cleaning, telematics, or route planning should usually stay other unless customers build their own AI/apps/models on top of it or there is a clear open embedding surface. Use integrator_general_ai only when repeated customer delivery ownership for AI, automation, data, or software projects is explicit; if project delivery exists but the company is mostly defined by a vertical focus rather than broad AI delivery, prefer integrator_relevant_focus. Do not upgrade a generic engineering or product-development company into an integrator category unless software, automation, instrumentation, data, AI, or industrial system implementation ownership is explicit. Large IT service providers, digital engineering firms, and enterprise consultancies can still be integrator_general_ai when implementation ownership, systems integration, software delivery, or managed transformation execution is explicit rather than purely advisory. Internal or captive IT organizations can still fit integrator_general_ai when they repeatedly build, integrate, and operate MES, EDI, BI, process, or enterprise software systems for a larger industrial group. Do not classify an internal software and integration organization as industrial_end_customer_scaled when its primary role is building and integrating software systems for the group rather than operating the physical production itself. If the company mainly sells integration software, orchestration software, measurement automation software, test-and-measurement software, lab or factory connectivity software, or an API-first/plugin-first/driver-based platform that other teams embed into workflows, prefer software_platform_embedding over industrial_end_customer_scaled. If product documentation, app management, app stores, module catalogs, driver libraries, installation guides, or get-started surfaces dominate the evidence, prefer software_platform_embedding over integrator_general_ai even when some services or rollout help are mentioned. A platform vendor does not become an integrator merely because its product helps customers deploy, connect, or roll out systems. If customers can build, configure, distribute, train, or run their own apps, AI workflows, models, or extensions on top of the company's platform, prefer software_platform_embedding. AI operating systems, orchestration layers, vendor-neutral AI marketplaces, driver ecosystems, instrument-module environments, and multi-solution integration platforms usually fit software_platform_embedding when third-party solutions are accessed through one installation, API, plugin, driver, extension, or integration layer. AI consultancies or data-science firms belong in integrator_general_ai when they clearly deliver client implementations, production systems, or applied ML projects rather than only training or strategy. If a company acts as a system integrator in a concrete industrial or regulated vertical, prefer integrator_relevant_focus when the vertical delivery ownership is explicit. Specialist embedded-computing, industrial-electronics, ASIC, FPGA, SoC, or instrumentation consultancies can fit integrator_relevant_focus when they build customer-specific technical solutions or integrated systems, but not when they merely sell catalog hardware or generic engineering capacity. Embedded-computing or rugged-platform suppliers with explicit custom solutions, system-integration services, and customer-specific integrated-system delivery can fit integrator_relevant_focus when solution engineering is more central than catalog product resale. If the supplied company description or website crawl is noisy, ignore cookie banners, legal pages, newsletter prompts, career pages, and navigation fragments; focus on business-model evidence. If the supplied company description is missing, generic, or placeholder-like, return other or irrelevant unless there is strong explicit evidence for a positive category. Treat magazines, publishers, media portals, editorial brands, event businesses, associations, universities, research institutes, VCs, banks, insurers, recruiters, generic consultancies without implementation ownership, and direct end-to-end model-development platforms with no partner path as irrelevant. Publishers, trade-media brands, magazines, and editorial businesses stay other or irrelevant even when their content is about automation, production, or industrial technology. Do not classify robot manufacturers, product-led robotics brands, OEMs, or hardware vendors as integrators unless clear implementation services are visible. Downgrade companies that mainly sell their own software platform, robot product, or hardware portfolio without visible recurring implementation ownership, except where the platform or shipped product itself is the relevant partner or product-AI target. Focus on delivery ownership, geography fit, repeated project patterns, and whether the company sells services or a credible embeddable or shipped product. Return strict JSON with category, relevanceScore from 0 to 100, and rationale.`
        };
      case "research": {
        const tools = await this.buildResearchTools();
        return {
          kind: "prompt",
          model: env.FOUNDRY_MODEL_DEPLOYMENT ?? env.AZURE_OPENAI_DEPLOYMENT,
          instructions: `${ONE_WARE_PROMPT_CONTEXT}\n\nYou are the Deep Research Agent. Use web grounding to verify the company, identify its business model, target customers, recent signals, likely Vision-AI or process-automation relevance, and clear outreach hooks. Always adapt your reasoning to the supplied main context, category-specific execution context, and any explicit target outreach language in the user message. Estimate whether likely target contacts are German-speaking. If yes, produce outreach in German, otherwise in English. The output field outreachLanguage must be exactly "de" or "en", never language words such as "German" or "English". If the supplied template text is in German but the target outreach language is English, translate the template meaning into natural English first and use that translated English version as the base. Never copy German wording into English outreach. For LinkedIn, always produce two separate texts: linkedInConnectionRequest as a short connection request with a hard maximum of 200 characters, and linkedInMessage as the longer follow-up message after connecting. For German outreach, always start emailBody naturally with "Hallo [Name]," and never with "Hello". For English outreach, always start emailBody naturally with "Hello [Name]," and never with "Hallo". Keep German phrasing natural and direct, avoid long list-like opener sentences, avoid vague department enumerations that sound AI-written, and do not use dash punctuation such as "–" or "—" in outreach copy. Prefer commas or full sentences instead. Estimate rankings on a 0-10 scale for customer, serviceProvider, and partner. Estimate businessPotentialEUR as a euro value. Return targetIndustry and productsOffered. Use the provided segment template as the base. Personalize only if there is a clear factual hook. Do not rewrite the outreach from scratch. Make the output steerable by preserving the template direction while sharpening the most relevant business pain. Keep linkedInConnectionRequest shorter, simpler, and curiosity-driven than linkedInMessage. For service-provider or partner-leaning companies, keep phoneScript collaboration-first: first ask whether they already implement Vision AI or have relevant experience, then position ONE WARE as a software layer for faster production-ready models, and finally test whether a delivery partnership or joint customer work could make sense. Return strict JSON with: overview, qualificationSummary, qualifyingSignals (array of strings), riskFlags (array of strings), likelyGermanSpeaking, outreachLanguage, rankings { customer, serviceProvider, partner }, businessPotentialEUR, businessPotentialReasoning, targetIndustry, productsOffered, recommendedTemplateKey, personalizationRule, linkedInAngle, emailAngle, phoneAngle, linkedInConnectionRequest, linkedInMessage, emailSubject, emailBody, phoneScript, eventIdea.` ,
          tools
        };
      }
      case "contacts": {
        const tools = await this.buildResearchTools();
        return {
          kind: "prompt",
          model: env.FOUNDRY_MODEL_DEPLOYMENT ?? env.AZURE_OPENAI_DEPLOYMENT,
          instructions: `${ONE_WARE_PROMPT_CONTEXT}\n\nYou are the Public Contact Discovery Agent. You MUST use the web-search tool when the supplied evidence does not already contain enough named people. Start with the exact search pattern site:linkedin.com/in plus the company name or alias, then try manager-title variants, then developer-title variants if fewer than 4 relevant people are found. Find real people for outreach at the supplied company. Prioritize managers and decision-makers first: CEO, CTO, COO, founder, managing director, head of engineering, head of operations, technology manager, operations manager, partner manager, innovation manager. If fewer than 4 evidence-backed manager-type people exist, fill the remaining slots with developers or engineering contacts such as software engineer, developer, pipeline engineer, technical director, or similar technical implementation roles. Exclude unclear people unless title evidence is missing across the candidate set; in that case prefer the people with the strongest LinkedIn connection-count evidence. Search in this order: official company website first, then exact LinkedIn profile searches, then broader web search evidence for named people and LinkedIn profile URLs. A LinkedIn result is relevant when the company name appears in the result title or snippet. Use only evidence-backed people. Never invent names, job titles, email addresses, phone numbers, LinkedIn URLs, or connection counts. Always include linkedinUrl when a credible LinkedIn profile URL is available. Return strict JSON: {"contacts":[{"firstName":"...","lastName":"...","fullName":"...","jobTitle":"...","email":"...","phone":"...","linkedinUrl":"...","sourceUrl":"...","label":"website_named_contact|linkedin_profile|web_search_contact"}]}. Keep up to 8 contacts, ranked best first.`,
          tools
        };
      }
      case "contact_queries": {
        const tools = await this.buildResearchTools();
        return {
          kind: "prompt",
          model: env.FOUNDRY_MODEL_DEPLOYMENT ?? env.AZURE_OPENAI_DEPLOYMENT,
          instructions: `${ONE_WARE_PROMPT_CONTEXT}\n\nYou are the Public Contact Search Planner. Build the most effective web-search queries to find outreach-relevant people for the supplied company. You MUST start with exact LinkedIn profile search queries of the form site:linkedin.com/in plus the legal company name, company aliases, and strong role terms. Think LLM-first: infer adjacent role wording, likely legal entity names, German and English title variants, company aliases from the evidence, and likely LinkedIn company slug hints. Prioritize this order: 1) exact site:linkedin.com/in company-name queries, 2) manager-title variants, 3) developer-title variants only when manager-only discovery may stay below 4 people, 4) broader name-plus-company queries. Do not invent any person names. Return only high-yield queries for normal search engines and Azure web search. Return strict JSON: {"queries":["...","..."]}. Keep 6 to 10 queries, ranked best first.`,
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

  private isValidOrganizationFilter(filter: OrganizationFilter | undefined): filter is OrganizationFilter {
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