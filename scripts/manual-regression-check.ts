import { AzureOpenAIClient } from "../src/clients/azure-openai";
import { WebSearchAgent } from "../src/clients/web-search-agent";

const companies = [
  ["Elma Electronic GmbH", "https://www.elma.com"],
  ["SweepMe!", "https://sweep-me.net"],
  ["SCOPE Engineering", "https://www.scope-engineering.de"],
  ["Image Access GmbH", "https://www.imageaccess.de"],
  ["FUSE-AI GmbH", "https://www.fuse-ai.de"],
  ["Accenture", "https://www.accenture.com"],
  ["IronFlock GmbH", "https://www.ironflock.com"],
  ["zolitron", "https://www.zolitron.com"],
  ["WFF IT-Service GmbH", "https://www.wff-it.de"]
] as const;

async function main() {
  const searchAgent = new WebSearchAgent();
  const azureClient = new AzureOpenAIClient();
  const results = [] as Array<{
    name: string;
    category: string;
    relevanceScore: number;
    rationale: string;
    summaryLength: number;
    crawlSucceeded: boolean;
    relevantUrls: string[];
  }>;

  for (const [name, domain] of companies) {
    const websiteProfile = await searchAgent.crawlCompanyWebsite(domain);
    const summary = websiteProfile?.summary ?? `Website crawl returned no usable summary for ${name}.`;
    const categorization = await azureClient.categorizeWebsiteCrawl(name, domain, summary, false, "");

    results.push({
      name,
      category: categorization.category,
      relevanceScore: categorization.relevanceScore,
      rationale: categorization.rationale,
      summaryLength: summary.length,
      crawlSucceeded: Boolean(websiteProfile?.summary),
      relevantUrls: websiteProfile?.relevantUrls ?? []
    });
  }

  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
