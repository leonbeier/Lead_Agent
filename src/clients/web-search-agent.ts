import { ApolloOrganizationFilter, CompanySample, PreCategorizedCompany } from "../types";
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
    page = 1
  ): Promise<CompanySample[]> {
    return this.openAIWebSearchClient.discoverCompanies(filter, limit, page);
  }

  async buildResearchContext(company: PreCategorizedCompany): Promise<SearchEvidence | null> {
    return this.openAIWebSearchClient.buildResearchContext(company);
  }

  async summarizeCompany(company: CompanySample): Promise<Partial<CompanySample> | null> {
    return this.openAIWebSearchClient.summarizeCompany(company);
  }
}
