import { config as loadEnv } from "dotenv";

loadEnv();

const hubspotToken = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const hubspotBaseUrl = process.env.HUBSPOT_BASE_URL ?? "https://api-eu1.hubapi.com";

if (!hubspotToken) {
  throw new Error("Missing HUBSPOT_PRIVATE_APP_TOKEN");
}

// Run start ~2026-06-14T10:44 UTC. Use a slightly earlier cutoff to be safe.
const SINCE_ISO = process.argv[2] ?? "2026-06-14T10:40:00.000Z";
const sinceMs = new Date(SINCE_ISO).getTime();

const LEGAL_FORM_PATTERN =
  /(\bgmbh\b|\bag\b|\bkg\b|\bohg\b|\bug\b|\bse\b|\bs\.?a\.?\b|\bs\.?a\.?s\.?\b|\bs\.?r\.?l\.?\b|\bs\.?p\.?a\.?\b|\bb\.?v\.?\b|\bn\.?v\.?\b|\bltd\b|\blimited\b|\bplc\b|\bllc\b|\binc\b|\boy\b|\boyj\b|\bab\b|\ba\/s\b|\baps\b|\bas\b|\bz o\.?o\.?|\bsarl\b|\bkft\b|\bd\.?o\.?o\.?\b|\bee\b|\behf\b|\blda\b|\bbvba\b|\bsprl\b)/i;

async function fetchRecentCompanies(): Promise<Array<{ id: string; properties: Record<string, string> }>> {
  const all: Array<{ id: string; properties: Record<string, string> }> = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const body: Record<string, unknown> = {
      limit: 100,
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      properties: ["name", "domain", "address", "city", "zip", "state", "country", "createdate"],
      filterGroups: [
        { filters: [{ propertyName: "createdate", operator: "GTE", value: String(sinceMs) }] }
      ]
    };
    if (after) {
      body.after = after;
    }
    const response = await fetch(`${hubspotBaseUrl}/crm/v3/objects/companies/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${hubspotToken}` },
      body: JSON.stringify(body)
    });
    if (response.status === 429) {
      await new Promise((r) => setTimeout(r, 1500));
      page -= 1;
      continue;
    }
    if (!response.ok) {
      throw new Error(`company search: ${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as {
      results?: Array<{ id: string; properties: Record<string, string> }>;
      paging?: { next?: { after?: string } };
    };
    all.push(...(payload.results ?? []));
    after = payload.paging?.next?.after;
    if (!after) {
      break;
    }
  }
  return all;
}

function hasAddress(p: Record<string, string>): boolean {
  const addr = (p.address ?? "").trim();
  const city = (p.city ?? "").trim();
  const zip = (p.zip ?? "").trim();
  return Boolean(addr) || Boolean(city && zip);
}

async function main(): Promise<void> {
  const companies = await fetchRecentCompanies();
  const rows = companies.map((c) => {
    const p = c.properties ?? {};
    const name = p.name ?? "";
    return {
      name,
      domain: p.domain ?? "",
      hasLegalForm: LEGAL_FORM_PATTERN.test(name),
      hasAddress: hasAddress(p),
      address: `${p.address ?? ""} ${p.zip ?? ""} ${p.city ?? ""} ${p.country ?? ""}`.trim(),
      created: p.createdate
    };
  });

  const withLegal = rows.filter((r) => r.hasLegalForm);
  const withAddr = rows.filter((r) => r.hasAddress);

  console.log("=== RECENT-RUN ADDRESS / LEGAL-NAME QUALITY GATE ===");
  console.log(`cutoff (createdate >=):      ${SINCE_ISO}`);
  console.log(`companies created since:     ${rows.length}`);
  console.log(`with legal-form name:        ${withLegal.length} (${rows.length ? Math.round((withLegal.length / rows.length) * 100) : 0}%)`);
  console.log(`with non-empty address:      ${withAddr.length} (${rows.length ? Math.round((withAddr.length / rows.length) * 100) : 0}%)`);
  console.log("");
  console.log("--- brand-only names WITHOUT address (regression candidates) ---");
  for (const r of rows.filter((x) => !x.hasLegalForm && !x.hasAddress)) {
    console.log(`  [brand/no-addr] ${r.name}  (${r.domain})`);
  }
  console.log("");
  console.log("--- sample (first 40) ---");
  for (const r of rows.slice(0, 40)) {
    const legal = r.hasLegalForm ? "LEGAL" : "brand";
    const addr = r.hasAddress ? r.address : "<EMPTY>";
    console.log(`[${legal}] ${r.name}  (${r.domain})  addr=${addr}`);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
