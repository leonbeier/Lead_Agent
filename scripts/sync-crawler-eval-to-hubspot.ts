import fs from "node:fs/promises";
import path from "node:path";

import { LeadPipelineAgent } from "../src/agents/lead-pipeline";
import { AzureOpenAIClient } from "../src/clients/azure-openai";
import { HubSpotClient } from "../src/clients/hubspot";
import { readiness } from "../src/config";
import { ControlPlaneStore } from "../src/control-plane";
import { LeadCategory, PreCategorizedCompany, PublicContactCandidate, ResearchBrief } from "../src/types";

type EvalRow = {
  name: string;
  website: string;
  category: LeadCategory;
  strictRelevant: boolean;
  kept: boolean;
  score: number;
  matchedPositiveTerms: string[];
  matchedDeliveryTerms: string[];
  summary: string | null;
};

type EvalReport = {
  results: EvalRow[];
};

const DEFAULT_REPORT_PATH = path.join(
  process.cwd(),
  "data",
  "diffbot",
  "eu_ai_machine_vision_integrators_100_full_entity_v3.crawler-keyword-eval.json"
);

function normalizeDomain(website: string | undefined): string | undefined {
  const normalized = String(website ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");

  return normalized ? `https://${normalized}` : undefined;
}

function getCompanyKey(company: Pick<PreCategorizedCompany, "name" | "domain">): string {
  const normalizedDomain = company.domain
    ?.trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");

  return normalizedDomain || company.name.trim().toLowerCase();
}

function hasNonGenericReachableContact(contacts: PublicContactCandidate[]): boolean {
  return contacts.some((contact) => {
    const email = contact.email?.trim().toLowerCase() ?? "";
    const isGenericMailbox = /^((info|sales|office|kontakt|contact|hello|team|support|service|mail)@)/i.test(email)
      || contact.label === "public_generic_mailbox";

    return Boolean(contact.email || contact.phone) && !isGenericMailbox;
  });
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    for (;;) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, () => runWorker()));
  return results;
}

async function main() {
  if (!readiness.hubspotConfigured) {
    throw new Error("HUBSPOT_PRIVATE_APP_TOKEN is not configured.");
  }

  const reportPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_REPORT_PATH;
  const report = JSON.parse(await fs.readFile(reportPath, "utf8")) as EvalReport;
  const rows = report.results.filter((row) => row.kept && row.strictRelevant);

  const companies: PreCategorizedCompany[] = rows.map((row) => ({
    name: row.name,
    domain: normalizeDomain(row.website),
    shortDescription: row.summary ?? "",
    sourceFilter: "crawler-keyword-eval (optimized_vision_integrators)",
    category: row.category,
    relevanceScore: Math.max(60, Math.min(99, 70 + row.score)),
    rationale: `Optimized crawler eval kept this firm based on matched vision terms (${row.matchedPositiveTerms.join(", ") || "none"}) and delivery terms (${row.matchedDeliveryTerms.join(", ") || "none"}).`
  }));

  const store = new ControlPlaneStore();
  const settings = await store.getSettings();
  const learning = await store.getLearning();
  const pipeline = new LeadPipelineAgent() as unknown as {
    collectPublicContacts: (companies: PreCategorizedCompany[], dryRun: boolean) => Promise<Map<string, PublicContactCandidate[]>>;
    collectApolloContacts: (
      companies: PreCategorizedCompany[],
      researchBriefs: ResearchBrief[],
      dryRun: boolean,
      mainContext?: string
    ) => Promise<Map<string, PublicContactCandidate[]>>;
    mergeContactCandidates: (
      primaryContacts: Map<string, PublicContactCandidate[]>,
      fallbackContacts: Map<string, PublicContactCandidate[]>
    ) => Map<string, PublicContactCandidate[]>;
  };
  const azureClient = new AzureOpenAIClient();
  const hubspotClient = new HubSpotClient();

  const researchBriefs = await mapWithConcurrency(companies, 4, async (company) =>
    azureClient.buildResearchBrief(company, false, settings.mainContext, learning, { includeWebResearch: true })
  );

  const publicContactsByCompany = await pipeline.collectPublicContacts(companies, false);
  const companiesNeedingApolloContacts = companies.filter((company) => {
    const currentContacts = publicContactsByCompany.get(getCompanyKey(company)) ?? [];
    return !hasNonGenericReachableContact(currentContacts);
  });

  const apolloContactsByCompany = await pipeline.collectApolloContacts(
    companiesNeedingApolloContacts,
    researchBriefs,
    false,
    settings.mainContext
  );

  const contactCandidatesByCompany = pipeline.mergeContactCandidates(publicContactsByCompany, apolloContactsByCompany);
  const syncResult = await hubspotClient.syncQualifiedCompanies(companies, researchBriefs, contactCandidatesByCompany, false);

  process.stdout.write(`${JSON.stringify({
    reportPath,
    companiesSelected: companies.length,
    companiesNeedingApolloContacts: companiesNeedingApolloContacts.length,
    hubspotSync: syncResult,
    contactsByCompany: companies.map((company) => ({
      name: company.name,
      domain: company.domain,
      contactCount: (contactCandidatesByCompany.get(getCompanyKey(company)) ?? []).length
    }))
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});