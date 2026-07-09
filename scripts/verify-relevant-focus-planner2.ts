import { AzureOpenAIClient } from "../src/clients/azure-openai";
import { defaultFilters } from "../src/filters";

// Verifies the integrator_relevant_focus base filter now carries a concrete-country locality set
// and the REAL planner produces per-country queries (not generic "Europe"). Azure-only; does not
// touch the live run or Exa.
async function main() {
  const filter = defaultFilters.find(
    (f) => f.targetCategories?.length === 1 && f.targetCategories[0] === "integrator_relevant_focus"
  );
  if (!filter) {
    process.stdout.write("integrator_relevant_focus base filter not found\n");
    return;
  }
  process.stdout.write(`filter.name = ${filter.name}\n`);
  process.stdout.write(`filter.locations = ${JSON.stringify(filter.locations)}\n\n`);

  const azure = new AzureOpenAIClient();
  const baseline = [
    "industrial automation and production software integration partners",
    "delivery-led OT and manufacturing software implementation companies",
    "system integration automation project delivery firms",
    "customer-specific automation and digitalization projects",
    "industrial software engineering service providers",
    "production line automation integrator companies"
  ];
  const queries = await azure
    .planExaSearchQueries(filter, baseline, undefined, false, "", "", 6, {
      requestedTargetCategories: ["integrator_relevant_focus"]
    })
    .catch((error: unknown) => {
      process.stdout.write(`planner error: ${error instanceof Error ? error.message : String(error)}\n`);
      return [] as string[];
    });

  process.stdout.write("Generated queries:\n");
  queries.forEach((q, i) => process.stdout.write(`  Q${i + 1}: ${q}\n`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
