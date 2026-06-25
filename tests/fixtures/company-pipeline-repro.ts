/**
 * Fixture for the full company-pipeline reproduction test
 * (tests/clients/company-pipeline-repro.test.ts).
 *
 * These are the 20 companies produced by the live Europe target=20 run on 2026-06-24.
 * The opt-in live test feeds each one through the SAME logic the worker uses
 * (resolveCompanyAddress + discoverPublicContactsForExecution) so name, address and
 * contact discovery can be re-checked on demand without launching a fresh search.
 */
export interface CompanyPipelineReproCase {
  name: string;
  domain: string;
  country: string;
  /** Substrings that must NEVER appear verbatim as the resolved company name (e.g. the bare domain). */
  forbiddenResolvedNames?: string[];
}

export interface CompanyPipelineReproExpectations {
  /** Minimum number of companies that must yield at least one usable contact. */
  minCompaniesWithContacts: number;
  /** Minimum number of companies that must yield at least one personal /in/ LinkedIn contact. */
  minCompaniesWithPersonalLinkedIn: number;
}

export const companyPipelineReproCases: CompanyPipelineReproCase[] = [
  { name: "Virona GmbH", domain: "https://vinspect.app", country: "Germany" },
  { name: "CASE Deutschland GmbH", domain: "https://www.case-digital.solutions", country: "Germany" },
  { name: "Dr. Schenk GmbH", domain: "https://cn.drschenk.eu", country: "Germany" },
  { name: "More Control Ltd", domain: "https://www.2ww.more-control.com", country: "United Kingdom" },
  { name: "Psycle", domain: "https://psycle.fr", country: "France" },
  { name: "ConnectedThinks", domain: "https://www.connectedthinks.com", country: "Germany" },
  { name: "Viscom SE", domain: "https://www.viscom.cn", country: "Germany" },
  { name: "Smart Industrial Systems", domain: "https://smart-industrial-solutions.nl", country: "Netherlands" },
  { name: "Ifsvisionsolutions", domain: "https://ifsvisionsolutions.com", country: "Spain" },
  { name: "Baumerinspection", domain: "https://baumerinspection.com", country: "Germany" },
  { name: "Inbolt", domain: "https://www.inbolt.com", country: "France" },
  { name: "VisionX", domain: "https://www.visionx.com.pl", country: "Poland" },
  { name: "Smartray", domain: "https://www.smartray.com", country: "Germany" },
  {
    name: "Qubbervision",
    domain: "https://qubbervision.com",
    country: "Greece",
    // Regression guard for the deterministic Azure-profiler defect where the bare domain
    // (with TLD, all caps) was returned as the company name instead of the brand.
    forbiddenResolvedNames: ["QUBBERVISION.COM", "qubbervision.com"]
  },
  { name: "Althera di Castelluccio Francesco", domain: "https://althera.it", country: "Italy" },
  { name: "Visionasl", domain: "https://visionasl.com", country: "Spain" },
  { name: "Vici & C. S.p.A.", domain: "https://vici.it", country: "Italy" },
  { name: "CVL4", domain: "https://kestrel-vision.com", country: "France" },
  { name: "Engilico Engineering Solutions NV", domain: "https://www.engilico.com", country: "Belgium" },
  { name: "ANTICIPATE GmbH", domain: "https://anticipate.webflow.io", country: "Germany" }
];

/**
 * Reproducible thresholds. Deliberately set below the observed 2026-06-24 run
 * (16/20 with contacts, 7/20 with personal /in/) to absorb transient crawl/anti-bot
 * variance while still failing loudly if contact discovery regresses meaningfully.
 */
export const companyPipelineReproExpectations: CompanyPipelineReproExpectations = {
  minCompaniesWithContacts: 12,
  minCompaniesWithPersonalLinkedIn: 5
};
