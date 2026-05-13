import { AzureOpenAIClient } from "../src/clients/azure-openai";
import { WebSearchAgent } from "../src/clients/web-search-agent";

const referenceCompanies = [
  { name: "GESTALT Automation", domain: "https://www.gestalt-automation.com" },
  { name: "Oxagile", domain: "https://www.oxagile.com" },
  { name: "Etteplan", domain: "https://www.etteplan.com" },
  { name: "Lemberg Solutions", domain: "https://lembergsolutions.de/" },
  { name: "statworx", domain: "https://www.statworx.com" },
  { name: "Vention", domain: "https://ventionteams.com" },
  { name: "Dataful Minds", domain: "https://www.dataful-minds.com" },
  { name: "Softeq", domain: "https://www.softeq.com" },
  { name: "Agiliway", domain: "https://www.agiliway.com" },
  { name: "msg systems ag", domain: "https://www.msg.group/de" },
  { name: "DataSolut", domain: "https://datasolut.com" },
  { name: "inovex", domain: "https://www.inovex.de" },
  { name: "VAISTO", domain: "https://vaisto.io" },
  { name: "Innowise", domain: "https://innowise.com" },
  { name: "Baitech Data", domain: "https://baitechdata.de" }
] as const;

const originalFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

  if (/api\.openai\.com/i.test(url)) {
    throw new Error(`OpenAI web search is blocked in crawler+Azure-only validation: ${url}`);
  }

  if (/api\.apollo\.io/i.test(url)) {
    throw new Error(`Apollo requests are blocked in crawler+Azure-only validation: ${url}`);
  }

  return originalFetch(input, init);
};

async function main() {
  const webSearchAgent = new WebSearchAgent();
  const azureClient = new AzureOpenAIClient();

  const results = [] as Array<{
    name: string;
    domain: string;
    category: string;
    relevanceScore: number;
    rationale: string;
    summary: string | null;
    relevantUrls: string[];
  }>;

  for (const company of referenceCompanies) {
    const websiteProfile = await webSearchAgent.crawlCompanyWebsite(company.domain);
    const categorization = websiteProfile
      ? await azureClient.categorizeWebsiteCrawl(
          company.name,
          company.domain,
          websiteProfile.summary,
          false,
          "",
          {
            mainContext:
              "Treat delivery-led software integrators, automation integrators, embedded engineering partners, and industrial AI implementation partners as positive. Do not reject a company only because it is broader than Vision AI when customer project delivery and software engineering ownership are visible."
          }
        )
      : {
          category: "other",
          relevanceScore: 0,
          rationale: "Website crawl did not return enough usable content for Azure preclassification."
        };

    results.push({
      name: company.name,
      domain: company.domain,
      category: categorization.category,
      relevanceScore: categorization.relevanceScore,
      rationale: categorization.rationale,
      summary: websiteProfile?.summary ?? null,
      relevantUrls: websiteProfile?.relevantUrls ?? []
    });
  }

  process.stdout.write(`${JSON.stringify({
    total: results.length,
    positive: results.filter((entry) => /integrator_|machine_builder_ai_enablement|camera_manufacturer_partner|software_platform_embedding|industrial_end_customer_scaled/.test(entry.category)).length,
    results
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});