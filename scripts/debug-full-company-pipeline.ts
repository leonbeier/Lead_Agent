import { readFileSync } from "node:fs";
import { HubSpotClient } from "../src/clients/hubspot";
import type { PreCategorizedCompany, PublicContactCandidate } from "../src/types";

/**
 * Full per-company reproduction harness: runs the SAME live logic the worker uses for
 *   1. company NAME + ADDRESS  (resolveCompanyAddress)
 *   2. public CONTACT discovery (discoverPublicContactsForExecution — Foundry + LinkedIn enrichment)
 * for every company listed in a TSV (name<TAB>domain<TAB>country), printing a compact report.
 *
 * Usage: npx tsx scripts/debug-full-company-pipeline.ts <tsvPath> [foundryTimeoutMs]
 */
function classifyLinkedIn(url: string | undefined): string {
  if (!url) return "no-li";
  if (url.includes("/company/")) return "COMPANY-LI";
  if (url.includes("/in/")) return "PERSONAL-LI";
  return "other-li";
}

function describeContact(c: PublicContactCandidate): string {
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || "<no-name>";
  const li = classifyLinkedIn(c.linkedinUrl);
  return `${name} | ${c.email ?? "no-email"} | ${c.phone ?? "no-phone"} | ${li}`;
}

async function main() {
  const [tsvPath, foundryTimeoutRaw] = process.argv.slice(2);
  if (!tsvPath) {
    console.error("usage: tsx scripts/debug-full-company-pipeline.ts <tsvPath> [foundryTimeoutMs]");
    process.exit(1);
  }
  const foundryTimeoutMs = foundryTimeoutRaw ? Number(foundryTimeoutRaw) : 90_000;
  const rows = readFileSync(tsvPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("\t"));

  const client = new HubSpotClient();
  let companiesWithContacts = 0;
  let companiesWithPersonalLi = 0;

  for (const [name, domain, country] of rows) {
    const company = {
      name,
      domain,
      country: country || undefined,
      category: "machine_builder_vision_ai",
      rationale: "debug",
      relevanceScore: 90,
      sourceFilter: "debug"
    } as unknown as PreCategorizedCompany;

    const startedAt = Date.now();
    const address = await client.resolveCompanyAddress(company).catch((err) => {
      console.error(`  resolveCompanyAddress error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    const contacts = await client
      .discoverPublicContactsForExecution(company, { selectedContactsTimeoutMs: foundryTimeoutMs })
      .catch((err) => {
        console.error(`  discoverPublicContactsForExecution error: ${err instanceof Error ? err.message : String(err)}`);
        return [] as PublicContactCandidate[];
      });
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);

    const hasPersonalLi = contacts.some((c) => classifyLinkedIn(c.linkedinUrl) === "PERSONAL-LI");
    if (contacts.length > 0) companiesWithContacts += 1;
    if (hasPersonalLi) companiesWithPersonalLi += 1;

    console.log(`\n=== ${name} (${domain}) [${elapsed}s] ===`);
    console.log(`  resolvedName: ${address?.companyName ?? "<none>"}`);
    console.log(`  address: ${[address?.address, address?.zip, address?.city, address?.state, address?.country].filter(Boolean).join(", ") || "<none>"}`);
    console.log(`  contacts: ${contacts.length}${hasPersonalLi ? " (has personal /in/)" : ""}`);
    for (const c of contacts) {
      console.log(`    - ${describeContact(c)}`);
    }
  }

  const total = rows.length;
  console.log(`\n========== SUMMARY ==========`);
  console.log(`companies: ${total}`);
  console.log(`with >=1 contact: ${companiesWithContacts}/${total}`);
  console.log(`with personal /in/ LinkedIn: ${companiesWithPersonalLi}/${total}`);
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
