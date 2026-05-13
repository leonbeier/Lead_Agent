import { WebSearchAgent } from "../src/clients/web-search-agent";
import { AzureOpenAIClient } from "../src/clients/azure-openai";
import { HubSpotClient } from "../src/clients/hubspot";
import { defaultApolloFilters } from "../src/filters";

async function main(): Promise<void> {
  const web = new WebSearchAgent();
  const azure = new AzureOpenAIClient();
  const hubspot = new HubSpotClient();
  const targetCategories = [
    "integrator_vision_industrial_ai",
    "integrator_general_ai",
    "integrator_relevant_focus"
  ] as const;

  const filters = defaultApolloFilters.filter((filter) =>
    targetCategories.some((category) => filter.targetCategories?.includes(category))
  );

  const byKey = new Map<string, { name: string; domain?: string; country?: string; shortDescription: string; sourceFilter: string }>();

  for (const filter of filters) {
    for (let page = 1; page <= 3; page += 1) {
      const companies = await web.discoverCompaniesForFilter(filter, 20, page);
      for (const company of companies) {
        const key = `${company.name.toLowerCase()}::${(company.domain ?? "").toLowerCase()}`;
        if (!byKey.has(key)) {
          byKey.set(key, company);
        }
      }
    }
  }

  const germanCompanies = Array.from(byKey.values()).filter(
    (company) => (company.country ?? "").toLowerCase() === "germany" || (company.domain ?? "").toLowerCase().includes(".de")
  );

  const evaluated: Array<{
    name: string;
    domain?: string;
    category: string;
    score: number;
    contactCount: number;
    contacts: unknown[];
    shortDescription: string;
  }> = [];

  for (const company of germanCompanies) {
    const categorization = await azure.categorizeCompany(
      company.name,
      company.shortDescription,
      false,
      undefined,
      undefined,
      [...targetCategories]
    );

    if (!targetCategories.includes(categorization.category as (typeof targetCategories)[number])) {
      continue;
    }

    const preCategorized = {
      ...company,
      ...categorization
    };

    const contacts = await hubspot.findPublicContactsForCompany(preCategorized);
    evaluated.push({
      name: preCategorized.name,
      domain: preCategorized.domain,
      category: preCategorized.category,
      score: preCategorized.relevanceScore,
      contactCount: contacts.length,
      contacts: contacts.slice(0, 3),
      shortDescription: preCategorized.shortDescription
    });
  }

  evaluated.sort((left, right) => right.contactCount - left.contactCount || right.score - left.score);

  console.log(
    JSON.stringify(
      {
        totalGermanCandidates: germanCompanies.length,
        qualified: evaluated.length,
        withContacts: evaluated.filter((item) => item.contactCount > 0).length,
        top: evaluated.slice(0, 50)
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
