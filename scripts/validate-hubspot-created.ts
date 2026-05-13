import { config as loadEnv } from "dotenv";

loadEnv();

const sharedKey = process.env.LEAD_AGENT_SHARED_KEY;
const hubspotToken = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const hubspotBaseUrl = process.env.HUBSPOT_BASE_URL ?? "https://api.hubapi.com";
const leadAgentBaseUrl = process.env.LEAD_AGENT_PUBLIC_BASE_URL ?? "https://leadagent-production-4555.up.railway.app";

if (!sharedKey) {
  throw new Error("Missing LEAD_AGENT_SHARED_KEY");
}

if (!hubspotToken) {
  throw new Error("Missing HUBSPOT_PRIVATE_APP_TOKEN");
}

async function hubspotSearch(objectType: "companies" | "contacts", propertyName: string, value: string) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(`${hubspotBaseUrl}/crm/v3/objects/${objectType}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${hubspotToken}`
      },
      body: JSON.stringify({
        limit: 1,
        filterGroups: [
          {
            filters: [
              {
                propertyName,
                operator: "EQ",
                value
              }
            ]
          }
        ]
      })
    });

    if (response.status === 429 && attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
      continue;
    }

    if (!response.ok) {
      throw new Error(`HubSpot search failed for ${objectType}.${propertyName}=${value}: ${response.status} ${await response.text()}`);
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

  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");
}

async function main(): Promise<void> {
  const latestResponse = await fetch(`${leadAgentBaseUrl}/api/control/latest-lead-run`, {
    headers: {
      "x-lead-agent-key": sharedKey
    }
  });

  if (!latestResponse.ok) {
    throw new Error(`Failed to fetch latest lead run: ${latestResponse.status} ${await latestResponse.text()}`);
  }

  const latestPayload = (await latestResponse.json()) as {
    latestLeadRun?: {
      contacts?: Array<{
        companyName: string;
        domain?: string;
        publicContactEmails?: string[];
      }>;
    };
  };

  const contacts = latestPayload.latestLeadRun?.contacts ?? [];
  const companyResults = [] as Array<{ companyName: string; domain?: string; foundCompany: boolean; hubspotCompanyId?: string; foundContacts: string[] }>;

  for (const contact of contacts) {
    const normalizedDomain = normalizeDomain(contact.domain);
    const companyByDomain = normalizedDomain ? await hubspotSearch("companies", "domain", normalizedDomain) : null;
    const companyByName = companyByDomain ? null : await hubspotSearch("companies", "name", contact.companyName);
    const foundCompany = companyByDomain ?? companyByName;
    const foundContacts: string[] = [];

    for (const email of contact.publicContactEmails ?? []) {
      const contactRecord = await hubspotSearch("contacts", "email", email);
      if (contactRecord) {
        foundContacts.push(email);
      }
    }

    companyResults.push({
      companyName: contact.companyName,
      domain: normalizedDomain,
      foundCompany: Boolean(foundCompany),
      hubspotCompanyId: foundCompany?.id,
      foundContacts
    });
  }

  console.log(JSON.stringify({
    totalCompaniesInRun: contacts.length,
    companiesFoundInHubSpot: companyResults.filter((item) => item.foundCompany).length,
    companiesWithAtLeastOneFoundContact: companyResults.filter((item) => item.foundContacts.length > 0).length,
    companyResults
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
