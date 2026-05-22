import { AzureOpenAIClient } from "../src/clients/azure-openai";
import { WebSearchAgent } from "../src/clients/web-search-agent";

const positiveReferenceCompanies = [
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

const negativeReferenceCompanies = [
  { name: "innoge", domain: "https://innoge.de/en" },
  { name: "integralvision", domain: "https://integralvision.eu/en" },
  { name: "Eficode", domain: "https://www.eficode.com/de/" },
  { name: "Vision Domes", domain: "https://www.vision-domes.de/" },
  { name: "t3n", domain: "https://t3n.de/" },
  { name: "CODESYS", domain: "https://de.codesys.com/" },
  { name: "Imago Technologies", domain: "https://imago-technologies.com/" },
  { name: "SemsoTec", domain: "https://semsotec.de/" },
  { name: "exantas", domain: "https://exantas-automotive.de/" },
  { name: "Luma Vision", domain: "https://lumavision.com/innovations/" },
  { name: "Blockbrain", domain: "https://blockbrain.ai" },
  { name: "SP Vision", domain: "http://spvision.net" },
  { name: "FreemiumPlay", domain: "https://www.freemiumplay.com" },
  { name: "Sound of Vision", domain: "http://soundofvision.tv" },
  { name: "VisionGroup", domain: "https://visiongroup.io" },
  { name: "Mutual Vision", domain: "https://mutualvision.co.uk" },
  { name: "Azalea Vision", domain: "https://azaleavision.com" },
  { name: "FocusVision Media", domain: "http://focusvisionmedia.com" }
] as const;

const acceptedTargetCategories = new Set([
  "integrator_vision_industrial_ai",
  "integrator_vision_ai_consulting_freelancer",
  "integrator_general_ai",
  "integrator_relevant_focus"
]);

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
    expectation: "positive" | "negative";
    name: string;
    domain: string;
    category: string;
    relevanceScore: number;
    rationale: string;
    summary: string | null;
    relevantUrls: string[];
    passed: boolean;
  }>;

  const allCompanies = [
    ...positiveReferenceCompanies.map((company) => ({ ...company, expectation: "positive" as const })),
    ...negativeReferenceCompanies.map((company) => ({ ...company, expectation: "negative" as const }))
  ];

  for (const company of allCompanies) {
    const websiteProfile = await webSearchAgent.crawlCompanyWebsite(company.domain);
    const categorization = await azureClient.categorizeWebsiteCrawl(
      company.name,
      company.domain,
      websiteProfile?.summary ?? `Website crawl returned no usable summary for ${company.domain}.`,
      false,
      "",
      {
        mainContext:
          "Treat delivery-led software integrators, automation integrators, embedded engineering partners, and industrial AI implementation partners as positive. Do not reject a company only because it is broader than Vision AI when customer project delivery and software engineering ownership are visible."
      }
    );

    const passed = company.expectation === "positive"
      ? acceptedTargetCategories.has(categorization.category)
      : !acceptedTargetCategories.has(categorization.category);

    results.push({
      expectation: company.expectation,
      name: company.name,
      domain: company.domain,
      category: categorization.category,
      relevanceScore: categorization.relevanceScore,
      rationale: categorization.rationale,
      summary: websiteProfile?.summary ?? null,
      relevantUrls: websiteProfile?.relevantUrls ?? [],
      passed
    });
  }

  const positiveResults = results.filter((entry) => entry.expectation === "positive");
  const negativeResults = results.filter((entry) => entry.expectation === "negative");
  const mismatches = results.filter((entry) => !entry.passed);

  process.stdout.write(`${JSON.stringify({
    total: results.length,
    positives: {
      total: positiveResults.length,
      passed: positiveResults.filter((entry) => entry.passed).length
    },
    negatives: {
      total: negativeResults.length,
      passed: negativeResults.filter((entry) => entry.passed).length
    },
    mismatches,
    results
  }, null, 2)}\n`);

  if (mismatches.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});