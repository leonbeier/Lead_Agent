import dns from "node:dns";
import { config as loadEnv } from "dotenv";
import { HubSpotClient } from "../src/clients/hubspot";
import { GeneratedLeadRecord, PreCategorizedCompany, PublicContactCandidate, ResearchBrief } from "../src/types";

dns.setDefaultResultOrder("ipv4first");
loadEnv();

const baseUrl = process.env.LEAD_AGENT_PUBLIC_BASE_URL?.trim();
const sharedKey = process.env.LEAD_AGENT_SHARED_KEY?.trim();

if (!baseUrl || !sharedKey) {
  throw new Error("LEAD_AGENT_PUBLIC_BASE_URL and LEAD_AGENT_SHARED_KEY are required.");
}

function toCompany(record: GeneratedLeadRecord): PreCategorizedCompany {
  return {
    name: record.companyName,
    domain: record.domain,
    country: record.country,
    shortDescription: record.qualificationSummary ?? record.overview ?? record.rationale,
    sourceFilter: record.sourceFilter,
    category: record.category,
    relevanceScore: record.relevanceScore,
    rationale: record.rationale
  };
}

function toBrief(record: GeneratedLeadRecord): ResearchBrief | undefined {
  if (!record.overview || !record.qualificationSummary || !record.emailBody || !record.linkedInMessage || !record.phoneScript) {
    return undefined;
  }

  return {
    companyName: record.companyName,
    website: record.domain,
    citations: [],
    overview: record.overview,
    qualificationSummary: record.qualificationSummary,
    qualifyingSignals: [],
    riskFlags: record.riskFlags ?? [],
    likelyGermanSpeaking: record.likelyGermanSpeaking ?? record.outreachLanguage === "de",
    outreachLanguage: record.outreachLanguage === "de" ? "de" : "en",
    rankings: record.rankings ?? {
      customer: 0,
      serviceProvider: 0,
      partner: 0
    },
    businessPotentialEUR: record.businessPotentialEUR ?? 0,
    businessPotentialReasoning: record.businessPotentialReasoning ?? "",
    targetIndustry: record.targetIndustry ?? "",
    productsOffered: typeof record.productsOffered === "string" ? record.productsOffered : "",
    recommendedTemplateKey: "backfill-latest-run",
    personalizationRule: "Use the stored generated outreach assets from the completed lead run.",
    linkedInAngle: record.linkedInMessage,
    emailAngle: record.emailSubject ?? record.qualificationSummary,
    phoneAngle: record.phoneScript,
    linkedInMessage: record.linkedInMessage,
    emailSubject: record.emailSubject ?? `ONE WARE x ${record.companyName}`,
    emailBody: record.emailBody,
    phoneScript: record.phoneScript,
    isFallback: false,
    stillQualified: record.stillQualified ?? true,
    qualificationDecisionReason: record.qualificationDecisionReason
  };
}

function buildContactsMap(records: GeneratedLeadRecord[]): Map<string, PublicContactCandidate[]> {
  const entries = records.map((record) => {
    const contacts = (record.publicContactEmails ?? [])
      .map((email, index) => ({
        email,
        phone: record.publicContactPhones?.[index],
        sourceUrl: record.publicContactSources?.[index] ?? record.domain ?? "https://unknown.invalid",
        label: "Stored website contact"
      }))
      .filter((contact) => Boolean(contact.email));

    const companyKey = normalizeCompanyKey(record.companyName, record.domain);
    return [companyKey, contacts] as const;
  });

  return new Map(entries);
}

function normalizeCompanyKey(companyName: string, domain?: string): string {
  if (!domain) {
    return companyName.trim().toLowerCase();
  }

  try {
    return new URL(domain.startsWith("http") ? domain : `https://${domain}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
  }
}

async function main() {
  const response = await fetch(`${baseUrl}/api/control-plane/bootstrap?key=${encodeURIComponent(sharedKey)}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch bootstrap payload: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json() as {
    latestLeadRun?: {
      contacts?: GeneratedLeadRecord[];
    };
  };

  const records = payload.latestLeadRun?.contacts ?? [];
  if (records.length === 0) {
    throw new Error("No stored latest-run contacts found to backfill.");
  }

  const companies = records.map(toCompany);
  const briefs = records.map(toBrief).filter((brief): brief is ResearchBrief => Boolean(brief));
  const contactsByCompany = buildContactsMap(records);
  const hubspotClient = new HubSpotClient();
  const result = await hubspotClient.syncQualifiedCompanies(companies, briefs, contactsByCompany, false);

  console.log(JSON.stringify({
    candidateCount: result.candidateCount,
    companySyncedCount: result.companySyncedCount,
    contactSyncedCount: result.contactSyncedCount,
    syncedCount: result.syncedCount,
    errors: result.errors
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
