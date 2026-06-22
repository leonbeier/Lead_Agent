import { config as loadEnv } from "dotenv";

loadEnv();

const sharedKey = process.env.LEAD_AGENT_SHARED_KEY;
const hubspotToken = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const hubspotBaseUrl = process.env.HUBSPOT_BASE_URL ?? "https://api-eu1.hubapi.com";
const leadAgentBaseUrl = process.env.LEAD_AGENT_PUBLIC_BASE_URL ?? "https://leadagent-production-4555.up.railway.app";

if (!sharedKey) {
  throw new Error("Missing LEAD_AGENT_SHARED_KEY");
}
if (!hubspotToken) {
  throw new Error("Missing HUBSPOT_PRIVATE_APP_TOKEN");
}

const LEGAL_FORM_PATTERN =
  /\b(gmbh| gmbh & co\.? kg|ag|kg|ohg|ug|se|s\.?a\.?|s\.?a\.?s\.?|s\.?r\.?l\.?|s\.?p\.?a\.?|b\.?v\.?|n\.?v\.?|ltd|limited|plc|llc|inc|oy|oyj|ab|a\/s|aps|as|sp\.? z o\.?o\.?|sarl|spa|srl|kft|d\.?o\.?o\.?|ee|ehf|lda|bvba|sprl)\b/i;

async function hubspotSearchCompany(propertyName: string, value: string) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(`${hubspotBaseUrl}/crm/v3/objects/companies/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${hubspotToken}`
      },
      body: JSON.stringify({
        limit: 1,
        properties: ["name", "domain", "address", "city", "zip", "state", "country"],
        filterGroups: [{ filters: [{ propertyName, operator: "EQ", value }] }]
      })
    });

    if (response.status === 429 && attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
      continue;
    }
    if (!response.ok) {
      throw new Error(`HubSpot company search ${propertyName}=${value}: ${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as { results?: Array<{ id: string; properties?: Record<string, string> }> };
    return payload.results?.[0] ?? null;
  }
  return null;
}

function normalizeDomain(domain: string | undefined): string | undefined {
  if (!domain) {
    return undefined;
  }
  return domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
}

async function main(): Promise<void> {
  const latestResponse = await fetch(`${leadAgentBaseUrl}/api/control/latest-lead-run`, {
    headers: { "x-lead-agent-key": sharedKey! }
  });
  if (!latestResponse.ok) {
    throw new Error(`Failed to fetch latest lead run: ${latestResponse.status} ${await latestResponse.text()}`);
  }
  const latestPayload = (await latestResponse.json()) as {
    latestLeadRun?: { contacts?: Array<{ companyName: string; domain?: string }> };
  };
  const contacts = latestPayload.latestLeadRun?.contacts ?? [];

  const rows: Array<{
    runName: string;
    domain?: string;
    found: boolean;
    hsName?: string;
    hasLegalForm: boolean;
    address?: string;
    city?: string;
    zip?: string;
    country?: string;
    hasAddress: boolean;
  }> = [];

  for (const contact of contacts) {
    const domain = normalizeDomain(contact.domain);
    const company = domain ? await hubspotSearchCompany("domain", domain) : null;
    const p = company?.properties ?? {};
    const hsName = p.name;
    const address = p.address;
    const city = p.city;
    const zip = p.zip;
    const country = p.country;
    rows.push({
      runName: contact.companyName,
      domain,
      found: Boolean(company),
      hsName,
      hasLegalForm: Boolean(hsName && LEGAL_FORM_PATTERN.test(hsName)),
      address,
      city,
      zip,
      country,
      hasAddress: Boolean(address && address.trim()) || Boolean(city && city.trim() && zip && zip.trim())
    });
  }

  const found = rows.filter((r) => r.found);
  const withLegalForm = found.filter((r) => r.hasLegalForm);
  const withAddress = found.filter((r) => r.hasAddress);

  console.log("=== ADDRESS / LEGAL-NAME QUALITY GATE ===");
  console.log(`companies in run:            ${rows.length}`);
  console.log(`found in HubSpot:            ${found.length}`);
  console.log(`with legal-form name:        ${withLegalForm.length} (${found.length ? Math.round((withLegalForm.length / found.length) * 100) : 0}%)`);
  console.log(`with non-empty address:      ${withAddress.length} (${found.length ? Math.round((withAddress.length / found.length) * 100) : 0}%)`);
  console.log("");
  console.log("--- per company ---");
  for (const r of found) {
    const legal = r.hasLegalForm ? "LEGAL" : "brand";
    const addr = r.hasAddress ? `${r.address ?? ""} ${r.zip ?? ""} ${r.city ?? ""} ${r.country ?? ""}`.trim() : "<EMPTY>";
    console.log(`[${legal}] ${r.hsName ?? "?"}  (${r.domain})  addr=${addr}`);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
