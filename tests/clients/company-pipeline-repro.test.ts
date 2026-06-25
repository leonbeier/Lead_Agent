import test from "node:test";
import assert from "node:assert/strict";
import { readiness } from "../../src/config";
import { HubSpotClient } from "../../src/clients/hubspot";
import type { PreCategorizedCompany, PublicContactCandidate } from "../../src/types";
import {
  companyPipelineReproCases,
  companyPipelineReproExpectations,
  type CompanyPipelineReproCase
} from "../fixtures/company-pipeline-repro";

function isPersonalLinkedIn(url: string | undefined): boolean {
  return Boolean(url && url.includes("/in/"));
}

function buildCompany(fixture: CompanyPipelineReproCase): PreCategorizedCompany {
  return {
    name: fixture.name,
    domain: fixture.domain,
    country: fixture.country,
    category: "machine_builder_vision_ai",
    rationale: "pipeline-repro",
    relevanceScore: 90,
    sourceFilter: "pipeline-repro"
  } as unknown as PreCategorizedCompany;
}

// Opt-in live regression: feeds the 20 companies of the 2026-06-24 run through the SAME logic
// the worker uses (company name + address resolution and public contact discovery, including the
// Foundry agent and LinkedIn enrichment). It is skipped in the normal deterministic suite and is
// only executed on demand with RUN_LIVE_PIPELINE_REPRO=1, so it never slows or flakes CI.
//
// Run on demand:
//   $env:RUN_LIVE_PIPELINE_REPRO="1"; npx tsx --test tests/clients/company-pipeline-repro.test.ts
// or, with Railway-injected credentials:
//   railway run powershell -Command "$env:RUN_LIVE_PIPELINE_REPRO='1'; npx tsx --test tests/clients/company-pipeline-repro.test.ts"
test(
  "full company pipeline still resolves names, addresses and contacts for the reference 20",
  {
    skip: !readiness.azureConfigured || process.env.RUN_LIVE_PIPELINE_REPRO !== "1",
    // The 20 companies run sequentially through the full live logic (crawl + Foundry + LinkedIn),
    // which observed ~34 min end-to-end; allow generous headroom so a slow crawl never times the
    // assertion out before the thresholds are evaluated.
    timeout: 3_600_000
  },
  async () => {
    const client = new HubSpotClient();
    const foundryTimeoutMs = process.env.PIPELINE_REPRO_FOUNDRY_TIMEOUT_MS
      ? Number(process.env.PIPELINE_REPRO_FOUNDRY_TIMEOUT_MS)
      : 90_000;

    const report: Array<{
      name: string;
      domain: string;
      resolvedName: string | null;
      address: string | null;
      contactCount: number;
      hasPersonalLinkedIn: boolean;
    }> = [];
    const nameViolations: string[] = [];
    let companiesWithContacts = 0;
    let companiesWithPersonalLinkedIn = 0;

    for (const fixture of companyPipelineReproCases) {
      const company = buildCompany(fixture);

      const address = await client.resolveCompanyAddress(company).catch(() => null);
      const contacts: PublicContactCandidate[] = await client
        .discoverPublicContactsForExecution(company, { selectedContactsTimeoutMs: foundryTimeoutMs })
        .catch(() => [] as PublicContactCandidate[]);

      const resolvedName = address?.companyName ?? null;
      const hasPersonalLinkedIn = contacts.some((c) => isPersonalLinkedIn(c.linkedinUrl));
      if (contacts.length > 0) companiesWithContacts += 1;
      if (hasPersonalLinkedIn) companiesWithPersonalLinkedIn += 1;

      // Name-quality guards (deterministic, must hold for every company that resolved a name).
      if (resolvedName) {
        const trimmed = resolvedName.trim();
        // No bare-domain / all-caps-domain name (e.g. "QUBBERVISION.COM").
        for (const forbidden of fixture.forbiddenResolvedNames ?? []) {
          if (trimmed.toLowerCase() === forbidden.toLowerCase()) {
            nameViolations.push(`${fixture.name}: resolved name "${trimmed}" is a forbidden bare-domain value`);
          }
        }
        // Generic guard: a name that is exactly the domain host (with a dot + TLD) is never a real entity.
        const host = fixture.domain.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
        if (trimmed.toLowerCase() === host.toLowerCase()) {
          nameViolations.push(`${fixture.name}: resolved name "${trimmed}" equals the bare domain host`);
        }
        // No impressum-boilerplate fragment that starts lowercase.
        if (/^[a-z]/.test(trimmed)) {
          nameViolations.push(`${fixture.name}: resolved name "${trimmed}" starts lowercase`);
        }
      }

      report.push({
        name: fixture.name,
        domain: fixture.domain,
        resolvedName,
        address: address
          ? [address.address, address.zip, address.city, address.state, address.country].filter(Boolean).join(", ") || null
          : null,
        contactCount: contacts.length,
        hasPersonalLinkedIn
      });
    }

    process.stdout.write(`${JSON.stringify({
      total: companyPipelineReproCases.length,
      companiesWithContacts,
      companiesWithPersonalLinkedIn,
      nameViolations,
      report
    }, null, 2)}\n`);

    assert.equal(
      nameViolations.length,
      0,
      `Company-name quality regressions detected:\n${nameViolations.join("\n")}`
    );
    assert.ok(
      companiesWithContacts >= companyPipelineReproExpectations.minCompaniesWithContacts,
      `Expected >= ${companyPipelineReproExpectations.minCompaniesWithContacts} companies with contacts, got ${companiesWithContacts}/${companyPipelineReproCases.length}.`
    );
    assert.ok(
      companiesWithPersonalLinkedIn >= companyPipelineReproExpectations.minCompaniesWithPersonalLinkedIn,
      `Expected >= ${companyPipelineReproExpectations.minCompaniesWithPersonalLinkedIn} companies with a personal /in/ LinkedIn contact, got ${companiesWithPersonalLinkedIn}/${companyPipelineReproCases.length}.`
    );
  }
);
