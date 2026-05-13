import { ApolloOrganizationFilter, CompanySample, CrawledWebsiteProfile, PreCategorizedCompany } from "../types";
import { OpenAIWebSearchClient } from "./openai-web-search";

interface SearchEvidence {
  context: string;
  citations: string[];
}

export class WebSearchAgent {
  private readonly openAIWebSearchClient = new OpenAIWebSearchClient();

  async discoverCompaniesForFilter(
    filter: ApolloOrganizationFilter,
    limit: number,
    page = 1,
    shouldSkipDomain?: (domain: string) => boolean
  ): Promise<CompanySample[]> {
    return this.openAIWebSearchClient.discoverCompanies(filter, limit, page, shouldSkipDomain);
  }

  async buildResearchContext(company: PreCategorizedCompany): Promise<SearchEvidence | null> {
    return this.openAIWebSearchClient.buildResearchContext(company);
  }

  async summarizeCompany(company: CompanySample): Promise<Partial<CompanySample> | null> {
    return this.openAIWebSearchClient.summarizeCompany(company);
  }

  async crawlCompanyWebsite(domain: string | undefined): Promise<CrawledWebsiteProfile | null> {
    return this.openAIWebSearchClient.crawlCompanyWebsite(domain);
  }
}
