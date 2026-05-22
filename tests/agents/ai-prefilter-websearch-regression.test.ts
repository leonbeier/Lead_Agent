import test from "node:test";
import assert from "node:assert/strict";
import { readiness } from "../../src/config";
import { AzureOpenAIClient } from "../../src/clients/azure-openai";
import { WebSearchAgent } from "../../src/clients/web-search-agent";
import { LeadCategory } from "../../src/types";
import { aiPrefilterWebsearchRegressionCases } from "../fixtures/ai-prefilter-websearch-regression";

test(
  "AI prefilter stays aligned for known companies via Azure AI check plus web search",
  {
    skip: !readiness.azureConfigured || !readiness.openAIWebSearchConfigured || process.env.RUN_LIVE_WEBSEARCH_REGRESSION !== "1",
    timeout: 600000
  },
  async () => {
    const webSearchAgent = new WebSearchAgent();
    const azureClient = new AzureOpenAIClient();
    const mismatches: Array<{
      companyName: string;
      websiteUrl: string;
      expectedCategory: LeadCategory;
      acceptedCategories: LeadCategory[];
      actualCategory: LeadCategory | "crawl_failed" | "classification_failed";
      rationale: string;
    }> = [];

    for (const fixture of aiPrefilterWebsearchRegressionCases) {
      const acceptedCategories = fixture.acceptedCategories ?? [fixture.expectedCategory];

      try {
        const websiteProfile = await webSearchAgent.crawlCompanyWebsite(fixture.websiteUrl);
        if (!websiteProfile?.summary) {
          mismatches.push({
            companyName: fixture.companyName,
            websiteUrl: fixture.websiteUrl,
            expectedCategory: fixture.expectedCategory,
            acceptedCategories,
            actualCategory: "crawl_failed",
            rationale: "Website crawl returned no usable summary."
          });
          continue;
        }

        const categorization = await azureClient.categorizeWebsiteCrawl(
          fixture.companyName,
          fixture.websiteUrl,
          websiteProfile.summary,
          false,
          ""
        );

        if (!acceptedCategories.includes(categorization.category)) {
          mismatches.push({
            companyName: fixture.companyName,
            websiteUrl: fixture.websiteUrl,
            expectedCategory: fixture.expectedCategory,
            acceptedCategories,
            actualCategory: categorization.category,
            rationale: categorization.rationale
          });
        }
      } catch (error) {
        mismatches.push({
          companyName: fixture.companyName,
          websiteUrl: fixture.websiteUrl,
          expectedCategory: fixture.expectedCategory,
          acceptedCategories,
          actualCategory: "classification_failed",
          rationale: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const correctCount = aiPrefilterWebsearchRegressionCases.length - mismatches.length;
    process.stdout.write(`${JSON.stringify({
      total: aiPrefilterWebsearchRegressionCases.length,
      correctCount,
      mismatches
    }, null, 2)}\n`);

    assert.equal(
      correctCount,
      aiPrefilterWebsearchRegressionCases.length,
      `Expected all ${aiPrefilterWebsearchRegressionCases.length} companies to classify correctly, but ${mismatches.length} mismatches remained.`
    );
  }
);