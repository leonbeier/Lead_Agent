import test from "node:test";
import assert from "node:assert/strict";
import { LeadPipelineAgent } from "../../src/agents/lead-pipeline";
import { CompanySample, PreCategorizedCompany } from "../../src/types";
import { latestHubSpotCompanyResearch } from "../fixtures/latest-hubspot-company-research";

function applyIndustrialFit(
  company: CompanySample,
  categorization: Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale">
) {
  const agent = new LeadPipelineAgent();
  return agent["enforceIndustrialFit"](company, categorization) as Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale">;
}

test("recent HubSpot companies stay aligned with researched company archetypes", async (t) => {
  for (const fixture of latestHubSpotCompanyResearch) {
    await t.test(fixture.companyName, () => {
      const result = applyIndustrialFit(
        {
          name: fixture.companyName,
          domain: fixture.websiteUrl,
          shortDescription: fixture.evidence,
          sourceFilter: "Latest HubSpot company research"
        },
        {
          category: fixture.initialCategory,
          relevanceScore: 76,
          rationale: "Initial optimistic categorization"
        }
      );

      assert.equal(result.category, fixture.expectedCategory);
    });
  }
});