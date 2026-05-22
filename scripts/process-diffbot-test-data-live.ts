import fs from "node:fs/promises";
import path from "node:path";

import { LeadPipelineAgent } from "../src/agents/lead-pipeline";
import { env } from "../src/config";
import { ControlPlaneStore } from "../src/control-plane";
import { AzureOpenAIClient } from "../src/clients/azure-openai";
import { HubSpotClient } from "../src/clients/hubspot";
import { WebSearchAgent } from "../src/clients/web-search-agent";
import { LeadCategory, PreCategorizedCompany, PublicContactCandidate, ResearchBrief } from "../src/types";

type DiffbotCsvRow = {
  name: string;
  website: string;
  description: string;
};

type ProcessingReport = {
  createdAt: string;
  inputCount: number;
  alreadyInHubSpotCount: number;
  notInHubSpotCount: number;
  crawledCount: number;
  crawlFailedCount: number;
  categorizedCount: number;
  integratorQualifiedCount: number;
  categoryBreakdown: Record<string, number>;
  qualifiedCategoryBreakdown: Record<string, number>;
  researchBriefCount: number;
  companiesNeedingApolloContactsCount: number;
  companySyncedCount: number;
  contactSyncedCount: number;
  syncedCount: number;
  hubspotErrors: string[];
  newlyCreatedCompanies: Array<{
    companyName: string;
    domain?: string;
    category: LeadCategory;
    relevanceScore: number;
    hubspotCompanyId?: string;
    hubspotRecordUrl?: string;
    publicContactEmails: string[];
  }>;
  crawlFailures: Array<{
    companyName: string;
    domain?: string;
  }>;
};

const DEFAULT_INPUT_PATH = path.join(process.cwd(), "data", "diffbot", "eu_ai_machine_vision_integrators_100.csv");
const HUBSPOT_PORTAL_ID = 146645418;
const HUBSPOT_SEARCH_MAX_RETRIES = 8;
const HUBSPOT_SEARCH_CONCURRENCY = 4;
const TARGET_CATEGORIES: LeadCategory[] = [
  "integrator_vision_industrial_ai",
  "integrator_vision_ai_consulting",
  "integrator_general_ai",
  "integrator_relevant_focus",
  "industrial_end_customer_scaled",
  "machine_builder_ai_enablement"
];

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const nextCharacter = content[index + 1];

    if (character === '"') {
      if (inQuotes && nextCharacter === '"') {
        current += '"';
        index += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (character === "," && !inQuotes) {
      currentRow.push(current);
      current = "";
      continue;
    }

    if ((character === "\n" || character === "\r") && !inQuotes) {
      if (character === "\r" && nextCharacter === "\n") {
        index += 1;
      }

      currentRow.push(current);
      current = "";
      if (currentRow.some((value) => value.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      continue;
    }

    current += character;
  }

  currentRow.push(current);
  if (currentRow.some((value) => value.length > 0)) {
    rows.push(currentRow);
  }

  return rows;
}

async function readRows(): Promise<DiffbotCsvRow[]> {
  const content = await fs.readFile(inputPath, "utf8");
  const rows = parseCsv(content);
  const [, ...dataRows] = rows;

  return dataRows.map((row) => {
    const [name = "", website = "", description = ""] = row;
    return {
      name: name.trim(),
      website: website.trim(),
      description: description.trim()
    };
  });
}

const inputPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_INPUT_PATH;
const outputPath = path.join(
  path.dirname(inputPath),
  `${path.basename(inputPath, path.extname(inputPath))}.live-processing-report.json`
);

function normalizeDomain(domain: string | undefined): string | undefined {
  if (!domain) {
    return undefined;
  }

  try {
    return new URL(domain.startsWith("http") ? domain : `https://${domain}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return domain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/$/, "");
  }
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

async function hubspotSearch(
  objectType: "companies" | "contacts",
  propertyName: string,
  value: string
): Promise<{ id: string; properties?: Record<string, string> } | null> {
  if (!env.HUBSPOT_PRIVATE_APP_TOKEN) {
    throw new Error("Missing HUBSPOT_PRIVATE_APP_TOKEN");
  }

  for (let attempt = 0; attempt <= HUBSPOT_SEARCH_MAX_RETRIES; attempt += 1) {
    const response = await fetch(`${env.HUBSPOT_BASE_URL}/crm/v3/objects/${objectType}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.HUBSPOT_PRIVATE_APP_TOKEN}`
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

    if (response.status === 429 && attempt < HUBSPOT_SEARCH_MAX_RETRIES) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
      const delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : 1500 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
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

async function findExistingHubSpotCompany(company: { name: string; domain?: string }) {
  const normalizedDomain = normalizeDomain(company.domain);
  if (normalizedDomain) {
    const byDomain = await hubspotSearch("companies", "domain", normalizedDomain);
    if (byDomain) {
      return byDomain;
    }
  }

  return hubspotSearch("companies", "name", company.name);
}

function countByCategory(companies: PreCategorizedCompany[]): Record<string, number> {
  return companies.reduce<Record<string, number>>((accumulator, company) => {
    accumulator[company.category] = (accumulator[company.category] ?? 0) + 1;
    return accumulator;
  }, {});
}

function getCompanyKey(company: Pick<PreCategorizedCompany, "name" | "domain">): string {
  return normalizeDomain(company.domain) || company.name.trim().toLowerCase();
}

function hasNonGenericReachableContact(contacts: PublicContactCandidate[]): boolean {
  return contacts.some((contact) => {
    const email = contact.email?.trim().toLowerCase() ?? "";
    const isGenericMailbox = /^((info|sales|office|kontakt|contact|hello|team|support|service|mail)@)/i.test(email)
      || contact.label === "public_generic_mailbox";
    return Boolean(contact.email || contact.phone) && !isGenericMailbox;
  });
}

async function main() {
  const rows = await readRows();
  process.stderr.write(`[diffbot-live] loaded ${rows.length} rows from ${inputPath}\n`);
  const store = new ControlPlaneStore();
  const settings = await store.getSettings();
  const learning = await store.getLearning();
  const pipeline = new LeadPipelineAgent() as unknown as {
    categorizeCompanies: (
      companies: Array<{ name: string; domain?: string; shortDescription: string; sourceFilter: string }>,
      dryRun: boolean,
      mainContext?: string,
      prequalification?: typeof settings.prequalification,
      targetCategories?: LeadCategory[],
      learning?: typeof learning
    ) => Promise<PreCategorizedCompany[]>;
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
    hasReachableContact: (contacts: PublicContactCandidate[]) => boolean;
  };
  const azureClient = new AzureOpenAIClient();
  const hubspotClient = new HubSpotClient();
  const webSearchAgent = new WebSearchAgent();

  const existingBeforeResults = await mapWithConcurrency(rows, HUBSPOT_SEARCH_CONCURRENCY, async (row) => {
    const domain = row.website ? `https://${row.website.replace(/^https?:\/\//i, "")}` : undefined;
    const existingCompany = await findExistingHubSpotCompany({ name: row.name, domain });
    return {
      row,
      domain,
      existingCompany
    };
  });
  process.stderr.write(`[diffbot-live] hubspot checked ${existingBeforeResults.length} rows\n`);

  const rowsNotInHubSpot = existingBeforeResults.filter((entry) => !entry.existingCompany);
  const rowsForProcessing = rowsNotInHubSpot;
  process.stderr.write(`[diffbot-live] processing ${rowsForProcessing.length} new rows\n`);
  const crawledRows = await mapWithConcurrency(rowsForProcessing, 6, async (entry) => {
    const websiteProfile = await webSearchAgent.crawlCompanyWebsite(entry.domain);
    return {
      ...entry,
      websiteProfile
    };
  });

  const crawlSuccesses = crawledRows.filter((entry) => entry.websiteProfile?.summary);
  const crawlFailures = crawledRows
    .filter((entry) => !entry.websiteProfile?.summary)
    .map((entry) => ({
      companyName: entry.row.name,
      domain: entry.domain
    }));
  process.stderr.write(`[diffbot-live] crawled ${crawlSuccesses.length} rows, ${crawlFailures.length} failed\n`);

  const categorized = await pipeline.categorizeCompanies(
    crawlSuccesses.map((entry) => ({
      name: entry.row.name,
      domain: entry.domain,
      shortDescription: entry.websiteProfile?.summary ?? entry.row.description,
      sourceFilter: "diffbot-test-data (source-scrape: direct-website-crawl)"
    })),
    false,
    settings.mainContext,
    settings.prequalification,
    TARGET_CATEGORIES,
    learning
  );
  process.stderr.write(`[diffbot-live] categorized ${categorized.length} rows\n`);

  const integratorQualified = categorized
    .filter((company) => TARGET_CATEGORIES.includes(company.category))
    .sort((left, right) => right.relevanceScore - left.relevanceScore);
  process.stderr.write(`[diffbot-live] qualified ${integratorQualified.length} rows\n`);

  const researchBriefs = await mapWithConcurrency(integratorQualified, 4, async (company) =>
    azureClient.buildResearchBrief(company, false, settings.mainContext, learning, { includeWebResearch: true })
  );
  process.stderr.write(`[diffbot-live] built ${researchBriefs.length} research briefs\n`);

  const publicContactCandidatesByCompany = await pipeline.collectPublicContacts(integratorQualified, false);
  const companiesNeedingApolloContacts = integratorQualified.filter((company) => {
    const existingContacts = publicContactCandidatesByCompany.get(getCompanyKey(company)) ?? [];
    return !hasNonGenericReachableContact(existingContacts);
  });
  const apolloContactCandidatesByCompany = await pipeline.collectApolloContacts(
    companiesNeedingApolloContacts,
    researchBriefs,
    false,
    settings.mainContext
  );
  process.stderr.write(`[diffbot-live] public contact maps=${publicContactCandidatesByCompany.size}, apollo contact maps=${apolloContactCandidatesByCompany.size}\n`);
  const contactCandidatesByCompany = pipeline.mergeContactCandidates(
    publicContactCandidatesByCompany,
    apolloContactCandidatesByCompany
  );

  const syncResult = await hubspotClient.syncQualifiedCompanies(
    integratorQualified,
    researchBriefs,
    contactCandidatesByCompany,
    false
  );
  process.stderr.write(`[diffbot-live] synced companies=${syncResult.companySyncedCount}, contacts=${syncResult.contactSyncedCount}\n`);

  const postSyncResults = await mapWithConcurrency(integratorQualified, HUBSPOT_SEARCH_CONCURRENCY, async (company) => {
    const existingBefore = existingBeforeResults.find((entry) => entry.row.name === company.name)?.existingCompany;
    const hubspotCompany = await findExistingHubSpotCompany(company);
    const contacts = contactCandidatesByCompany.get(getCompanyKey(company)) ?? [];

    return {
      companyName: company.name,
      domain: company.domain,
      category: company.category,
      relevanceScore: company.relevanceScore,
      existingBefore: Boolean(existingBefore),
      hubspotCompanyId: hubspotCompany?.id,
      hubspotRecordUrl: hubspotCompany
        ? `https://app-eu1.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-2/${hubspotCompany.id}`
        : undefined,
      publicContactEmails: contacts.map((contact) => contact.email).filter((email): email is string => Boolean(email))
    };
  });

  const report: ProcessingReport = {
    createdAt: new Date().toISOString(),
    inputCount: rows.length,
    alreadyInHubSpotCount: existingBeforeResults.length - rowsNotInHubSpot.length,
    notInHubSpotCount: rowsNotInHubSpot.length,
    crawledCount: crawlSuccesses.length,
    crawlFailedCount: crawlFailures.length,
    categorizedCount: categorized.length,
    integratorQualifiedCount: integratorQualified.length,
    categoryBreakdown: countByCategory(categorized),
    qualifiedCategoryBreakdown: countByCategory(integratorQualified),
    researchBriefCount: researchBriefs.length,
    companiesNeedingApolloContactsCount: companiesNeedingApolloContacts.length,
    companySyncedCount: syncResult.companySyncedCount,
    contactSyncedCount: syncResult.contactSyncedCount,
    syncedCount: syncResult.syncedCount,
    hubspotErrors: syncResult.errors,
    newlyCreatedCompanies: postSyncResults.filter((entry) => !entry.existingBefore && Boolean(entry.hubspotCompanyId)),
    crawlFailures
  };

  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    outputPath: outputPath,
    inputCount: report.inputCount,
    alreadyInHubSpotCount: report.alreadyInHubSpotCount,
    notInHubSpotCount: report.notInHubSpotCount,
    crawledCount: report.crawledCount,
    crawlFailedCount: report.crawlFailedCount,
    categorizedCount: report.categorizedCount,
    integratorQualifiedCount: report.integratorQualifiedCount,
    qualifiedCategoryBreakdown: report.qualifiedCategoryBreakdown,
    researchBriefCount: report.researchBriefCount,
    companiesNeedingApolloContactsCount: report.companiesNeedingApolloContactsCount,
    companySyncedCount: report.companySyncedCount,
    contactSyncedCount: report.contactSyncedCount,
    syncedCount: report.syncedCount,
    newlyCreatedCompanies: report.newlyCreatedCompanies.map((company) => ({
      companyName: company.companyName,
      category: company.category,
      hubspotRecordUrl: company.hubspotRecordUrl,
      publicContactEmails: company.publicContactEmails
    })),
    hubspotErrors: report.hubspotErrors
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});