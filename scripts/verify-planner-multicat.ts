import { AzureOpenAIClient } from "../src/clients/azure-openai";
import { resolveSearchFilterBase } from "../src/debug/test-console";
import type { LeadCategory, SelectableLeadCategory } from "../src/types";

// Tests the REAL planner across MULTIPLE categories (not just integrator_relevant_focus) with each
// category's real base filter for market=Europe, to confirm the new geography guidance produces
// per-country / sub-national queries AND that other archetypes still make sense. Azure-only.
const CATEGORIES: SelectableLeadCategory[] = [
  "integrator_relevant_focus",
  "integrator_vision_industrial_ai",
  "camera_manufacturer_partner",
  "machine_builder_ai_enablement",
  "software_platform_embedding",
  "industrial_end_customer_scaled"
];

const BASELINE = [
  "industrial automation and production software integration partners",
  "delivery-led OT and manufacturing software implementation companies",
  "system integration automation project delivery firms",
  "customer-specific automation and digitalization projects",
  "industrial software engineering service providers",
  "production line automation integrator companies"
];

async function main() {
  const azure = new AzureOpenAIClient();
  for (const category of CATEGORIES) {
    process.stdout.write("\n============================================================\n");
    process.stdout.write(`CATEGORY: ${category}\n`);
    let baseFilter;
    try {
      ({ baseFilter } = resolveSearchFilterBase(category, "Europe"));
    } catch (error) {
      process.stdout.write(`  (no filter) ${error instanceof Error ? error.message : String(error)}\n`);
      continue;
    }
    process.stdout.write(`filter.name = ${baseFilter.name}\n`);
    process.stdout.write(`locations = ${JSON.stringify(baseFilter.locations)}\n`);
    process.stdout.write("------------------------------------------------------------\n");
    const queries = await azure
      .planExaSearchQueries(baseFilter, BASELINE, undefined, false, "", "", 6, {
        requestedTargetCategories: [category as LeadCategory]
      })
      .catch((error: unknown) => {
        process.stdout.write(`  planner error: ${error instanceof Error ? error.message : String(error)}\n`);
        return [] as string[];
      });
    queries.forEach((q, i) => process.stdout.write(`  Q${i + 1}: ${q}\n`));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
