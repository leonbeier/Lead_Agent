import { HubSpotClient } from "../src/clients/hubspot";
import type { PreCategorizedCompany } from "../src/types";

/**
 * Local reproduction harness for the company NAME + ADDRESS extraction path.
 * Usage: npx tsx scripts/debug-company-identity.ts <domain> [country] [name]
 */
async function main() {
  const [domain, country, name] = process.argv.slice(2);
  if (!domain) {
    console.error("usage: tsx scripts/debug-company-identity.ts <domain> [country] [name]");
    process.exit(1);
  }
  const company = {
    name: name ?? domain.split(".")[0],
    domain,
    country: country ?? undefined,
    category: "machine_builder_vision_ai",
    rationale: "debug",
    relevanceScore: 90,
    sourceFilter: "debug"
  } as unknown as PreCategorizedCompany;

  const client = new HubSpotClient();
  console.log(`=== ${domain} (input name='${company.name}', country='${company.country}') ===`);

  const identity = await client.debugResolveCompanyIdentity(company).catch((error) => {
    console.error("debugResolveCompanyIdentity error", error);
    return null;
  });
  if (identity) {
    console.log("officialWebsiteProfile:", JSON.stringify(identity.officialWebsiteProfile, null, 2));
    console.log("legalEntityCandidates:", identity.legalEntityCandidates);
    console.log("isTrustedOfficialWebsiteProfile:", identity.isTrustedOfficialWebsiteProfile);
  }

  const resolved = await client.resolveCompanyAddress(company).catch((error) => {
    console.error("resolveCompanyAddress error", error);
    return null;
  });
  console.log("resolveCompanyAddress =>", JSON.stringify(resolved, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
