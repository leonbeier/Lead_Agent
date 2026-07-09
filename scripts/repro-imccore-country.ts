import { WebSearchAgent } from "../src/clients/web-search-agent";
import { AzureOpenAIClient } from "../src/clients/azure-openai";
import { HubSpotClient } from "../src/clients/hubspot";

// Reproduce the geography misclassification of imccore.com (IMC, Amman/Jordan) that was
// written to HubSpot as country="Germany", integrator_vision_industrial_ai, score 98.
// Prints: (1) what the open-crawler summary evidence actually contains, (2) what the Azure
// website classifier returns for category/score/country, (3) what the deep identity resolver
// (resolveCompanyAddress) returns for the country. This shows whether the failure is missing
// crawl evidence, a prompt-compliance hallucination, or a resolver gap.

async function main() {
  const domain = process.argv[2] ?? "imccore.com";
  const name = process.argv[3] ?? "Imccore";

  const agent = new WebSearchAgent();
  const azure = new AzureOpenAIClient();
  const hubspot = new HubSpotClient();

  console.log(`=== CRAWL (open_crawler_search) for ${domain} ===`);
  const profile = await agent.crawlCompanyWebsite(domain, "open_crawler_search");
  if (!profile) {
    console.log("crawlCompanyWebsite returned null (website could not be loaded)");
  } else {
    console.log("landingUrl:", profile.landingUrl);
    console.log("relevantUrls:", JSON.stringify(profile.relevantUrls));
    const summary = profile.summary ?? "";
    console.log("summary length:", summary.length);
    console.log("summary mentions 'Jordan':", /jordan/i.test(summary));
    console.log("summary mentions 'Amman':", /amman/i.test(summary));
    console.log("summary mentions '+962' / '962':", /\+?962/.test(summary));
    console.log("summary mentions 'Germany':", /german/i.test(summary));
    console.log("--- summary (first 2500 chars) ---");
    console.log(summary.slice(0, 2500));
    console.log("--- summary (last 1200 chars) ---");
    console.log(summary.slice(-1200));
  }

  console.log(`\n=== AZURE categorizeWebsiteCrawl (dryRun=false) ===`);
  try {
    const classified = await azure.categorizeWebsiteCrawl(
      name,
      domain,
      profile?.summary ?? "",
      false
    );
    console.log(JSON.stringify(classified, null, 2));
  } catch (error) {
    console.log("classify error:", error instanceof Error ? error.message : String(error));
  }

  console.log(`\n=== HubSpot resolveCompanyAddress (deep identity resolver) ===`);
  try {
    const resolved = await hubspot.resolveCompanyAddress({
      name,
      domain,
      category: "integrator_vision_industrial_ai",
      relevanceScore: 98,
      rationale: "repro",
      sourceFilter: "repro",
      shortDescription: "repro"
    } as never);
    console.log(JSON.stringify(resolved, null, 2));
  } catch (error) {
    console.log("resolve error:", error instanceof Error ? error.message : String(error));
  }

  // Direct classifier tests on FIXED summary text (domain=undefined skips the internal re-crawl,
  // so we feed the evidence verbatim). This isolates the classifier prompt from the crawler.
  const heroOnly = [
    "computer vision systems — ai-powered visual inspection | imc | imc",
    "end-to-end computer vision solutions for industrial quality control, safety monitoring, and production optimization — from machine vision inspection to real-time video analytics.",
    "machine vision inspection: computer vision uses smart cameras and ai algorithms to inspect products automatically. these systems detect defects with up to 99.9% accuracy at 10-50x human speed.",
    "a single production line inspection system starts from $5,000-$15,000, while complex multi-line systems range from $50,000-$200,000. we offer free consultations.",
    "computer vision systems are designed for seamless integration with existing production lines using modbus tcp and opc ua to connect with plcs. a typical project takes 4-8 weeks from design to delivery."
  ].join("\n");

  const withCountry = [
    heroOnly,
    "What does IMC do? IMC (Industrial Memory Core) is an Amman-based industrial engineering company founded in 2020. We design, fabricate, and commission electrical control systems, PLC and SCADA automation, computer-vision quality inspection, and industrial networking solutions for factories and production lines across Jordan and the wider region.",
    "Industries & plants we serve in Jordan. Based in Amman, we work nationwide. Contact: Amman, Jordan. Phone +962 79 8585215. info@imccore.com. We deploy Hikrobot vision systems for defect detection."
  ].join("\n");

  console.log(`\n=== CLASSIFY on HERO-ONLY summary (no country evidence; approximates prod summary) ===`);
  try {
    const a = await azure.categorizeWebsiteCrawl(name, undefined, heroOnly, false);
    console.log(JSON.stringify(a, null, 2));
  } catch (error) {
    console.log("classify error:", error instanceof Error ? error.message : String(error));
  }

  console.log(`\n=== CLASSIFY on FULL summary (contains Amman/Jordan/+962) ===`);
  try {
    const b = await azure.categorizeWebsiteCrawl(name, undefined, withCountry, false);
    console.log(JSON.stringify(b, null, 2));
  } catch (error) {
    console.log("classify error:", error instanceof Error ? error.message : String(error));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
