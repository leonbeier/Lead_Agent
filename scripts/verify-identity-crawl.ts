import { WebSearchAgent } from "../src/clients/web-search-agent";
import { AzureOpenAIClient } from "../src/clients/azure-openai";

async function main() {
  const domain = process.argv[2] ?? "develer.com";
  const name = process.argv[3] ?? "Develer";
  const agent = new WebSearchAgent();
  console.log(`=== crawlCompanyWebsite(${domain}) with identity enrichment ===`);
  const profile = await agent.crawlCompanyWebsite(domain, "open_crawler_search");
  if (!profile) {
    console.log("crawl returned null (site unreachable from this network)");
    return;
  }
  const summary = profile.summary;
  console.log(`summary length: ${summary.length}`);
  const countryHints = /(italy|italia|firenze|calenzano|germany|deutschland|jordan|amman|impressum|via |strasse|straße|street|gmbh|s\.r\.l|srl|\+\d{1,3})/gi;
  const hits = summary.match(countryHints) ?? [];
  console.log(`identity/country hints found: ${JSON.stringify([...new Set(hits.map((h) => h.toLowerCase()))])}`);

  console.log(`\n=== classifier over enriched crawl (domain path) ===`);
  const azure = new AzureOpenAIClient();
  const result = await azure.categorizeWebsiteCrawl(name, domain, "", false);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
