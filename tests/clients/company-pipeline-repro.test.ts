import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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

// Resume checkpoint for the fail-fast iteration loop: stores the domains already verified fully
// complete so a re-run skips them (no wasted live re-crawl) and lands on the first remaining gap.
const FAILFAST_CHECKPOINT_PATH = path.resolve(
  process.cwd(),
  "data/lead-run-discovery-checkpoints/pipeline-repro-complete.json"
);

function loadCompletedDomains(): Set<string> {
  try {
    const raw = fs.readFileSync(FAILFAST_CHECKPOINT_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.map((d) => String(d)));
  } catch {
    // No checkpoint yet — start fresh.
  }
  return new Set();
}

function saveCompletedDomains(domains: Set<string>): void {
  try {
    fs.mkdirSync(path.dirname(FAILFAST_CHECKPOINT_PATH), { recursive: true });
    fs.writeFileSync(FAILFAST_CHECKPOINT_PATH, `${JSON.stringify([...domains], null, 2)}\n`);
  } catch {
    // Best-effort: a missing checkpoint just means the next run re-validates from the top.
  }
}

function clearCompletedCheckpoint(): void {
  try {
    fs.rmSync(FAILFAST_CHECKPOINT_PATH, { force: true });
  } catch {
    // ignore
  }
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
//
// Fail-fast iteration loop (fix one bug at a time):
//   $env:RUN_LIVE_PIPELINE_REPRO="1"; $env:PIPELINE_REPRO_FAILFAST="1"; npx tsx --test tests/clients/company-pipeline-repro.test.ts
//   -> runs every company in order, STOPS at the first one missing any expected info, and writes a
//      checkpoint of the ones already complete. Re-running after a fix skips the green companies and
//      resumes at the first remaining gap. Delete data/lead-run-discovery-checkpoints/
//      pipeline-repro-complete.json (or finish all 20) to force a fresh full validation.
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
    const failFast = process.env.PIPELINE_REPRO_FAILFAST === "1";
    const completedDomains = failFast ? loadCompletedDomains() : new Set<string>();
    // Match the production contact-discovery budget (lead-worker-run.ts passes
    // selectedContactsTimeoutMs: 370_000) so the test measures the real production capability.
    // A shorter budget (the previous 90 s) artificially cut off Foundry mid-discovery and made
    // large, well-staffed companies (e.g. Dr. Schenk) appear to have zero contacts even though
    // their personal LinkedIn profiles are reliably found once the agent is allowed to finish.
    const foundryTimeoutMs = process.env.PIPELINE_REPRO_FOUNDRY_TIMEOUT_MS
      ? Number(process.env.PIPELINE_REPRO_FOUNDRY_TIMEOUT_MS)
      : 370_000;

    const report: Array<{
      name: string;
      domain: string;
      resolvedName: string | null;
      address: string | null;
      expectedCity: string | null;
      resolvedCity: string | null;
      cityTargetMet: boolean | null;
      publicManager: string | null;
      contactCount: number;
      hasPersonalLinkedIn: boolean;
      fullyComplete: boolean;
      missingInfo: string[];
    }> = [];
    const nameViolations: string[] = [];
    let companiesWithContacts = 0;
    let companiesWithPersonalLinkedIn = 0;
    let companiesExpectedCity = 0;
    let companiesWithResolvedCity = 0;
    let companiesFullyComplete = 0;
    const cityTargetMisses: string[] = [];
    const incompleteCompanies: string[] = [];

    for (const fixture of companyPipelineReproCases) {
      // Fail-fast resume: skip companies already verified complete in a previous run so iteration
      // lands directly on the first remaining gap instead of re-crawling the green ones.
      if (failFast && completedDomains.has(fixture.domain)) {
        process.stdout.write(`SKIP (checkpoint complete): ${fixture.name}\n`);
        continue;
      }
      const company = buildCompany(fixture);

      const address = await client.resolveCompanyAddress(company).catch(() => null);
      const contacts: PublicContactCandidate[] = await client
        .discoverPublicContactsForExecution(company, { selectedContactsTimeoutMs: foundryTimeoutMs })
        .catch(() => [] as PublicContactCandidate[]);

      const resolvedName = address?.companyName ?? null;
      const hasPersonalLinkedIn = contacts.some((c) => isPersonalLinkedIn(c.linkedinUrl));
      if (contacts.length > 0) companiesWithContacts += 1;
      if (hasPersonalLinkedIn) companiesWithPersonalLinkedIn += 1;

      // Address-target tracking against the research-backed public city ground truth.
      const resolvedCity = address?.city?.trim() || null;
      let cityTargetMet: boolean | null = null;
      if (fixture.publicCity) {
        companiesExpectedCity += 1;
        cityTargetMet = Boolean(resolvedCity);
        if (cityTargetMet) companiesWithResolvedCity += 1;
        else cityTargetMisses.push(`${fixture.name}: public city "${fixture.publicCity}" is on the crawlable site but pipeline returned country-only`);
      }

      // Name-quality guards (deterministic, must hold for every company that resolved a name).
      const nameViolationsBefore = nameViolations.length;
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

      // Per-company completeness: collect every piece of expected info that is missing, so the
      // report shows exactly what would be needed to reach 20/20. Expectations are evidence-based
      // (see fixture comments): a correct real-entity name, a resolved city where the company
      // publishes one, at least one contact (info@ fallback counts), and a personal /in/ LinkedIn
      // where one is realistically discoverable via Google + LinkedIn people filter.
      const expectsContact = fixture.expectsContact !== false;
      const missingInfo: string[] = [];

      const nameKeywords = fixture.expectedNameIncludes ?? [];
      const normalizedName = (resolvedName ?? "").trim().toLowerCase();
      if (!resolvedName) {
        missingInfo.push("no resolved company name");
      } else if (nameKeywords.length > 0 && !nameKeywords.some((kw) => normalizedName.includes(kw.toLowerCase()))) {
        missingInfo.push(`resolved name "${resolvedName.trim()}" does not match the real entity (expected one of: ${nameKeywords.join(", ")})`);
      }

      if (fixture.publicCity && !resolvedCity) {
        missingInfo.push(`city "${fixture.publicCity}" not resolved (country-only)`);
      }

      if (expectsContact && contacts.length === 0) {
        missingInfo.push("no usable contact (not even a fallback mailbox)");
      }

      if (fixture.expectsPersonalLinkedIn && !hasPersonalLinkedIn) {
        missingInfo.push("no personal /in/ LinkedIn contact (one is realistically discoverable)");
      }

      const fullyComplete = missingInfo.length === 0;
      if (fullyComplete) companiesFullyComplete += 1;
      else incompleteCompanies.push(`${fixture.name}: ${missingInfo.join("; ")}`);

      const entry = {
        name: fixture.name,
        domain: fixture.domain,
        resolvedName,
        address: address
          ? [address.address, address.zip, address.city, address.state, address.country].filter(Boolean).join(", ") || null
          : null,
        expectedCity: fixture.publicCity ?? null,
        resolvedCity,
        cityTargetMet,
        publicManager: fixture.publicManager ?? null,
        contactCount: contacts.length,
        hasPersonalLinkedIn,
        fullyComplete,
        missingInfo
      };
      report.push(entry);

      // Fail-fast: stop at the first company missing any expected info (or with a name-quality
      // regression) so the bug can be fixed before burning time on the rest. Already-complete
      // companies are checkpointed so the next run resumes here.
      if (failFast) {
        const companyNameViolated = nameViolations.length > nameViolationsBefore;
        if (!fullyComplete || companyNameViolated) {
          process.stdout.write(`STOP at ${fixture.name}:\n${JSON.stringify(entry, null, 2)}\n`);
          assert.fail(
            `PIPELINE_REPRO_FAILFAST stopped at "${fixture.name}": ${(missingInfo.length ? missingInfo : ["name-quality regression"]).join("; ")}`
          );
        }
        completedDomains.add(fixture.domain);
        saveCompletedDomains(completedDomains);
        process.stdout.write(`OK (complete): ${fixture.name}\n`);
      }
    }

    process.stdout.write(`${JSON.stringify({
      total: companyPipelineReproCases.length,
      companiesWithContacts,
      companiesWithPersonalLinkedIn,
      companiesExpectedCity,
      companiesWithResolvedCity,
      companiesFullyComplete,
      cityTargetMisses,
      incompleteCompanies,
      nameViolations,
      report
    }, null, 2)}\n`);

    // In fail-fast mode, reaching this point means every company is complete (or was checkpointed),
    // so the per-company gate already passed. Clear the checkpoint so the next run re-validates the
    // full set fresh, and skip the aggregate thresholds (they would undercount the skipped ones).
    if (failFast) {
      clearCompletedCheckpoint();
      process.stdout.write("ALL COMPLETE — every reference company reached its realistic maximum.\n");
      return;
    }

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
    assert.ok(
      companiesWithResolvedCity >= companyPipelineReproExpectations.minCompaniesWithResolvedCity,
      `Expected >= ${companyPipelineReproExpectations.minCompaniesWithResolvedCity} of the ${companiesExpectedCity} companies with a public city to resolve a city, got ${companiesWithResolvedCity}. Misses:\n${cityTargetMisses.join("\n")}`
    );
    assert.ok(
      companiesFullyComplete >= companyPipelineReproExpectations.minFullyComplete,
      `Expected >= ${companyPipelineReproExpectations.minFullyComplete} of ${companyPipelineReproCases.length} companies to have ALL expected info present, got ${companiesFullyComplete}. Target is ${companyPipelineReproCases.length}/${companyPipelineReproCases.length}. Remaining gaps:\n${incompleteCompanies.join("\n")}`
    );
  }
);
