import { ApolloClient } from "../src/clients/apollo";
import { HubSpotClient } from "../src/clients/hubspot";

async function main() {
  const base = "https://leadagent-production-4555.up.railway.app";
  const key = "1UlS6EGO2RJPWacNdtQsYh94X3ejLuixmzMkrA5FBbqKyZTC";
  const bootstrap = await fetch(`${base}/api/control-plane/bootstrap?key=${encodeURIComponent(key)}`).then((response) => response.json()) as {
    latestLeadRun: {
      contacts: Array<Record<string, unknown>>;
    };
  };

  const record = bootstrap.latestLeadRun.contacts.find((entry) => entry.companyName === "MachineSight") as Record<string, unknown> | undefined;
  if (!record) {
    throw new Error("MachineSight not found in latestLeadRun.");
  }

  const company = {
    name: String(record.companyName),
    domain: typeof record.domain === "string" ? record.domain : undefined,
    country: typeof record.country === "string" ? record.country : undefined,
    shortDescription: typeof record.qualificationSummary === "string"
      ? record.qualificationSummary
      : typeof record.overview === "string"
        ? record.overview
        : String(record.rationale ?? ""),
    sourceFilter: String(record.sourceFilter ?? "manual-sync"),
    category: record.category as never,
    relevanceScore: Number(record.relevanceScore ?? 0),
    rationale: String(record.rationale ?? "")
  };

  const brief = {
    companyName: String(record.companyName),
    website: typeof record.domain === "string" ? record.domain : undefined,
    citations: [],
    overview: String(record.overview ?? ""),
    qualificationSummary: String(record.qualificationSummary ?? ""),
    qualifyingSignals: [],
    riskFlags: Array.isArray(record.riskFlags) ? record.riskFlags.map(String) : [],
    likelyGermanSpeaking: Boolean(record.likelyGermanSpeaking ?? (record.outreachLanguage === "de")),
    outreachLanguage: record.outreachLanguage === "de" ? "de" : "en",
    rankings: typeof record.rankings === "object" && record.rankings
      ? {
          customer: Number((record.rankings as Record<string, unknown>).customer ?? 0),
          serviceProvider: Number((record.rankings as Record<string, unknown>).serviceProvider ?? 0),
          partner: Number((record.rankings as Record<string, unknown>).partner ?? 0)
        }
      : { customer: 0, serviceProvider: 0, partner: 0 },
    businessPotentialEUR: Number(record.businessPotentialEUR ?? 0),
    businessPotentialReasoning: String(record.businessPotentialReasoning ?? ""),
    targetIndustry: String(record.targetIndustry ?? ""),
    productsOffered: typeof record.productsOffered === "string" ? record.productsOffered : "",
    recommendedTemplateKey: "manual-apollo-sync",
    personalizationRule: "Manual Apollo sync for verified company match.",
    linkedInAngle: String(record.linkedInMessage ?? ""),
    emailAngle: String(record.emailSubject ?? ""),
    phoneAngle: String(record.phoneScript ?? ""),
    linkedInMessage: String(record.linkedInMessage ?? ""),
    emailSubject: typeof record.emailSubject === "string" ? record.emailSubject : `ONE WARE x ${String(record.companyName)}`,
    emailBody: String(record.emailBody ?? ""),
    phoneScript: String(record.phoneScript ?? ""),
    isFallback: false,
    stillQualified: Boolean(record.stillQualified ?? true),
    qualificationDecisionReason: typeof record.qualificationDecisionReason === "string" ? record.qualificationDecisionReason : undefined
  };

  const apollo = new ApolloClient();
  const candidates = await apollo.searchContactsForCompany(company, 10);
  const enrichedContacts = [];

  for (const candidate of candidates.slice(0, 3)) {
    const enriched = await apollo.enrichContactEmail(candidate, company);
    if (enriched && !enrichedContacts.some((existing) => existing.email === enriched.email)) {
      enrichedContacts.push(enriched);
    }
  }

  if (!company.domain) {
    throw new Error("MachineSight domain missing.");
  }

  const companyKey = new URL(company.domain).hostname.toLowerCase().replace(/^www\./, "");
  const hubspot = new HubSpotClient();
  const result = await hubspot.syncQualifiedCompanies([company], [brief], new Map([[companyKey, enrichedContacts]]), false);

  console.log(JSON.stringify({ candidates, enrichedContacts, result }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
