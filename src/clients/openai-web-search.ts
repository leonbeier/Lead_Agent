import { env, readiness } from "../config";
import { ApolloOrganizationFilter, CompanySample, PreCategorizedCompany } from "../types";

interface SearchEvidence {
  context: string;
  citations: string[];
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

export class OpenAIWebSearchClient {
  async discoverCompanies(
    filter: ApolloOrganizationFilter,
    limit: number,
    page = 1
  ): Promise<CompanySample[]> {
    if (!readiness.openAIWebSearchConfigured) {
      return [];
    }

    const companies: CompanySample[] = [];
    const seenKeys = new Set<string>();

    for (let attempt = 0; attempt < 3 && companies.length < limit; attempt += 1) {
      const excludedDomains = companies
        .map((company) => company.domain)
        .filter((domain): domain is string => Boolean(domain));
      const prompt = [
        "Find public company websites for ONE WARE lead discovery.",
        "Use only organization-level information.",
        "Do not return employee names, emails, phone numbers, LinkedIn profiles, or any other personal data.",
        "Only return companies when public evidence suggests real software delivery, system integration, automation engineering, embedded development, industrial implementation, or customer project ownership.",
        "Exclude robot manufacturers, hardware vendors, OEM product brands, magazines, publishers, media portals, events, associations, universities, research institutes, investors, banks, insurers, recruiters, generic consultancies, and direct competing AI software vendors.",
        "Prefer official company websites over directories, news sites, glossaries, job boards, and social networks.",
        `Return up to ${limit} companies for page variant ${page}.${attempt + 1}.`,
        excludedDomains.length > 0 ? `Do not repeat these websites: ${excludedDomains.join(", ")}` : undefined,
        `Apollo-style filter JSON: ${JSON.stringify(filter)}`,
        "Return strict JSON with {\"companies\":[{\"name\":\"...\",\"domain\":\"https://...\",\"country\":\"...\",\"shortDescription\":\"...\",\"whyRelevant\":\"...\"}]}."
      ].filter(Boolean).join("\n\n");

      try {
        const response = await this.runWebSearch(prompt, 2200);
        const parsed = this.parseJson<{ companies?: Array<{
          name?: string;
          domain?: string;
          country?: string;
          shortDescription?: string;
          whyRelevant?: string;
        }> }>(response.text);

        for (const company of parsed.companies ?? []) {
          const normalizedCompany = this.normalizeCompany(company, filter);
          if (!normalizedCompany) {
            continue;
          }

          const companyKey = `${normalizedCompany.name.toLowerCase()}::${normalizedCompany.domain?.toLowerCase() ?? ""}`;
          if (seenKeys.has(companyKey)) {
            continue;
          }

          seenKeys.add(companyKey);
          companies.push(normalizedCompany);

          if (companies.length >= limit) {
            break;
          }
        }
      } catch {
        if (companies.length > 0) {
          break;
        }
      }
    }

    return companies.slice(0, limit);
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
      const response = await this.runWebSearch(prompt, 1800);
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
      return null;
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
      const response = await this.runWebSearch(prompt, 900);
      const parsed = this.parseJson<{ country?: string; shortDescription?: string }>(response.text);
      const shortDescription = parsed.shortDescription?.trim();

      if (!shortDescription) {
        return null;
      }

      return {
        country: parsed.country?.trim() || company.country,
        shortDescription
      };
    } catch {
      return null;
    }
  }

  private async runWebSearch(prompt: string, maxOutputTokens: number): Promise<{ text: string; citations: string[] }> {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: env.OPENAI_WEB_SEARCH_MODEL,
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
      "wlw.de",
      "werliefertwas.com"
    ];

    return blockedDomains.some((domain) => lowered.includes(domain));
  }
}
