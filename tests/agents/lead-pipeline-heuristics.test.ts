import test from "node:test";
import assert from "node:assert/strict";
import { LeadPipelineAgent } from "../../src/agents/lead-pipeline";
import { CompanySample, PreCategorizedCompany } from "../../src/types";

function applyIndustrialFit(
  company: CompanySample,
  categorization: Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale">
) {
  const agent = new LeadPipelineAgent();
  return agent["enforceIndustrialFit"](company, categorization) as Pick<PreCategorizedCompany, "category" | "relevanceScore" | "rationale">;
}

test("industrial automation companies without explicit AI evidence are demoted from general_ai to relevant_focus", () => {
  const result = applyIndustrialFit(
    {
      name: "AZT",
      domain: "https://azt-a.ru",
      shortDescription: "delivery-led industrial automation and software integrator with real implementation ownership in PLC, SCADA and BMS",
      sourceFilter: "Germany filter"
    },
    {
      category: "integrator_general_ai",
      relevanceScore: 75,
      rationale: "Initial AI-heavy categorization"
    }
  );

  assert.equal(result.category, "integrator_relevant_focus");
  assert.match(result.rationale, /no explicit AI specialization/i);
});

test("vision only in the company name does not keep a generic software consultancy in an industrial vision bucket", () => {
  const result = applyIndustrialFit(
    {
      name: "Ivy Vision",
      domain: "https://ivyvision.com",
      shortDescription: "consulting services for application software developer, firmware developer, OS porting specialist, device driver and software architect support",
      sourceFilter: "Germany filter"
    },
    {
      category: "integrator_vision_industrial_ai",
      relevanceScore: 72,
      rationale: "Name contains vision"
    }
  );

  assert.equal(result.category, "other");
  assert.match(result.rationale, /broad software consulting|embedded engineering|lacks clear industrial|vision-delivery/i);
});

test("known camera manufacturers do not remain in integrator buckets", () => {
  const result = applyIndustrialFit(
    {
      name: "Basler",
      domain: "https://baslerweb.com",
      shortDescription: "Machine vision cameras, lenses and lighting portfolio for industrial imaging",
      sourceFilter: "Germany filter"
    },
    {
      category: "integrator_vision_industrial_ai",
      relevanceScore: 81,
      rationale: "Initial integrator guess"
    }
  );

  assert.equal(result.category, "camera_manufacturer_partner");
});

test("direct exa path prefers the machine-builder debug filter for machine_builder_ai_enablement", () => {
  const agent = new LeadPipelineAgent() as any;

  const filter = agent.buildDirectExaSearchFilter(["machine_builder_ai_enablement", "integrator_general_ai"], "DE");

  assert.ok(filter.targetCategories?.includes("machine_builder_ai_enablement"));
  assert.deepEqual(filter.locations, ["Germany"]);
  assert.match(filter.name, /Machine Builders For AI Options/i);
  assert.match(filter.name, /\[debug Germany\]$/);
});