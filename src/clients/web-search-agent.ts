import { SafeSearchType, search } from "duck-duck-scrape";
import { env } from "../config";
import { PreCategorizedCompany } from "../types";

interface SearchEvidence {
  context: string;
  citations: string[];
}

interface SearchHit {
  query: string;
  title: string;
  description: string;
  url: string;
  hostname: string;
  excerpt?: string;
}

const PAGE_FETCH_TIMEOUT_MS = 6000;
const MAX_FETCHED_PAGES = 3;
const MAX_PAGE_TEXT_LENGTH = 1800;

export class WebSearchAgent {
  async buildResearchContext(company: PreCategorizedCompany): Promise<SearchEvidence | null> {
    if (!env.WEB_SEARCH_AGENT_ENABLED) {
      return null;
    }

    const queries = this.buildQueries(company);
    const hits = await this.collectHits(queries);

    if (hits.length === 0) {
      return null;
    }

    const enrichedHits = await this.enrichHits(hits);
    const citations = Array.from(new Set(enrichedHits.map((hit) => hit.url)));

    return {
      context: this.formatContext(company, queries, enrichedHits),
      citations
    };
  }

  private buildQueries(company: PreCategorizedCompany): string[] {
    const normalizedDomain = company.domain?.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const categoryHint = company.category.replace(/_/g, " ");

    return [
      [company.name, normalizedDomain].filter(Boolean).join(" "),
      [company.name, company.country, categoryHint].filter(Boolean).join(" "),
      normalizedDomain ? `site:${normalizedDomain} ${company.name}` : undefined
    ].filter((query): query is string => Boolean(query));
  }

  private async collectHits(queries: string[]): Promise<SearchHit[]> {
    const hits: SearchHit[] = [];
    const seenUrls = new Set<string>();

    for (const query of queries) {
      try {
        const response = await search(query, {
          safeSearch: SafeSearchType.MODERATE,
          region: "wt-wt",
          locale: "en-us"
        });

        for (const result of response.results) {
          if (hits.length >= env.WEB_SEARCH_AGENT_MAX_RESULTS) {
            return hits;
          }

          if (!result.url.startsWith("http://") && !result.url.startsWith("https://")) {
            continue;
          }

          if (seenUrls.has(result.url)) {
            continue;
          }

          seenUrls.add(result.url);
          hits.push({
            query,
            title: this.cleanText(result.title),
            description: this.cleanText(result.description),
            url: result.url,
            hostname: result.hostname
          });
        }
      } catch {
        continue;
      }
    }

    return hits;
  }

  private async enrichHits(hits: SearchHit[]): Promise<SearchHit[]> {
    const enriched = await Promise.all(
      hits.map(async (hit, index) => {
        if (index >= MAX_FETCHED_PAGES) {
          return hit;
        }

        const excerpt = await this.fetchExcerpt(hit.url);
        return excerpt ? { ...hit, excerpt } : hit;
      })
    );

    return enriched;
  }

  private async fetchExcerpt(url: string): Promise<string | null> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; LeadAgentBot/1.0; +https://leadagent-production-4555.up.railway.app)",
          accept: "text/html,application/xhtml+xml"
        },
        signal: controller.signal,
        redirect: "follow"
      });

      if (!response.ok) {
        return null;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html")) {
        return null;
      }

      const html = await response.text();
      const text = this.extractReadableText(html);

      return text.length >= 200 ? text.slice(0, MAX_PAGE_TEXT_LENGTH) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private extractReadableText(html: string): string {
    return this.cleanText(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/gi, '"')
    );
  }

  private formatContext(company: PreCategorizedCompany, queries: string[], hits: SearchHit[]): string {
    const blocks = hits.map((hit, index) => {
      const lines = [
        `Result ${index + 1}`,
        `Query: ${hit.query}`,
        `Title: ${hit.title}`,
        `URL: ${hit.url}`,
        `Snippet: ${hit.description}`
      ];

      if (hit.excerpt) {
        lines.push(`Page excerpt: ${hit.excerpt}`);
      }

      return lines.join("\n");
    });

    return [
      "External web research evidence:",
      `Company: ${company.name}`,
      `Search queries: ${queries.join(" | ")}`,
      ...blocks
    ].join("\n\n");
  }

  private cleanText(value: string): string {
    return value
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
}