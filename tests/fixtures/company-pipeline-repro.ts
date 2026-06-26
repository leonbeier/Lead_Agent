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
  /**
   * Research-backed target (2026-06-25 web research): the city that is PUBLICLY published on the
   * company's own crawlable domain (impressum/contact/about). When set, the pipeline should
   * theoretically be able to resolve a city for this company — country-only here is an
   * under-extraction, not an honest "no public address". Left undefined where the crawlable domain
   * genuinely exposes no street address (e.g. minimal marketing stubs or foreign-language subdomains).
   */
  publicCity?: string;
  /**
   * Research-backed target: a named manager/executive publicly listed on the company's own site
   * (impressum "Geschäftsführung"/"Executive Director" or about page). Evidence that at least one
   * named human contact is theoretically discoverable without external enrichment.
   */
  publicManager?: string;
  /**
   * Acceptable substrings (lower-cased, any-of) for the resolved company name. The pipeline's
   * resolved name must contain at least one of these to count as a correct real-entity name.
   */
  expectedNameIncludes?: string[];
  /**
   * Whether the pipeline should yield at least one usable contact (defaults to true — every company
   * should at minimum surface a fallback channel such as a generic info@ mailbox).
   */
  expectsContact?: boolean;
  /**
   * Whether a personal /in/ LinkedIn contact is realistically discoverable (Google + LinkedIn
   * people filter) based on 2026-06 research (named execs on the imprint, a public team page, or a
   * funded/well-staffed company). When true, the pipeline should surface at least one /in/ contact.
   */
  expectsPersonalLinkedIn?: boolean;
}

export interface CompanyPipelineReproExpectations {
  /** Minimum number of companies that must yield at least one usable contact. */
  minCompaniesWithContacts: number;
  /** Minimum number of companies that must yield at least one personal /in/ LinkedIn contact. */
  minCompaniesWithPersonalLinkedIn: number;
  /**
   * Minimum number of companies (out of those with a research-backed `publicCity`) for which the
   * pipeline must resolve a city rather than country-only. Encodes the address-extraction target.
   */
  minCompaniesWithResolvedCity: number;
  /**
   * Minimum number of companies for which ALL expected info is present (correct real-entity name,
   * resolved city where a public city exists, a contact, and a personal /in/ LinkedIn where one is
   * realistically discoverable). The target is the full 20; this floor locks in no-regression while
   * the per-company `missingInfo` report shows the remaining gap toward 20/20.
   */
  minFullyComplete: number;
}

export const companyPipelineReproCases: CompanyPipelineReproCase[] = [
  { name: "Virona GmbH", domain: "https://vinspect.app", country: "Germany", publicCity: "Munich", expectedNameIncludes: ["virona"], expectsPersonalLinkedIn: true },
  {
    name: "CASE Deutschland GmbH",
    domain: "https://www.case-digital.solutions",
    country: "Germany",
    // Impressum: Grüner Ring 126, 38108 Braunschweig — MD Dr. Mourad Chouikha.
    publicCity: "Braunschweig",
    publicManager: "Dr. Mourad Chouikha",
    expectedNameIncludes: ["case"],
    expectsPersonalLinkedIn: true
  },
  // Fixture domain is the Chinese subdomain (cn.drschenk.eu); the full imprint lives on drschenk.com
  // (Dr. Schenk GmbH Industriemesstechnik, Bussardstr. 2, 82166 Graefelfing; MDs Dr. Christoph Schenk,
  // Michael Dobler, Andreas Leiner; 300+ staff). Externally (Google + LinkedIn filter) this is one of
  // the richest companies to enrich, so a contact and a personal /in/ are expected despite the dead
  // source subdomain — country-only address from this domain is defensible (no publicCity asserted).
  { name: "Dr. Schenk GmbH", domain: "https://cn.drschenk.eu", country: "Germany", expectedNameIncludes: ["schenk"], expectsPersonalLinkedIn: true },
  { name: "More Control Ltd", domain: "https://www.2ww.more-control.com", country: "United Kingdom", publicCity: "Milton Keynes", expectedNameIncludes: ["more control"] },
  { name: "Psycle", domain: "https://psycle.fr", country: "France", publicCity: "Lacroix-Saint-Ouen", expectedNameIncludes: ["psycle"], expectsPersonalLinkedIn: true },
  {
    name: "ConnectedThinks",
    domain: "https://www.connectedthinks.com",
    country: "Germany",
    // About page: Locixx GmbH, Auenstraße 38, 85737 Ismaning. No individual named (only sales@).
    publicCity: "Ismaning",
    expectedNameIncludes: ["connectedthinks", "locixx"]
  },
  // Fixture domain is the Chinese site (viscom.cn); the German imprint (Carl-Buderus-Str. 9-15,
  // 30455 Hannover; board Carsten Salewski, Dr. Martin Heuser, Dirk Schwingel) is on viscom.com,
  // so country-only from the .cn domain is defensible — no publicCity target asserted here.
  { name: "Viscom SE", domain: "https://www.viscom.cn", country: "Germany", expectedNameIncludes: ["viscom"], expectsPersonalLinkedIn: true },
  { name: "Smart Industrial Systems", domain: "https://smart-industrial-solutions.nl", country: "Netherlands", publicCity: "Uden", expectedNameIncludes: ["smart industrial"] },
  { name: "Ifsvisionsolutions", domain: "https://ifsvisionsolutions.com", country: "Spain", publicCity: "Gurb", expectedNameIncludes: ["inox", "ifs vision"] },
  {
    name: "Baumerinspection",
    domain: "https://baumerinspection.com",
    country: "Germany",
    // Contact page: Baumer Inspection GmbH, Lohnerhofstraße 6, 78467 Konstanz.
    publicCity: "Konstanz",
    expectedNameIncludes: ["baumer"],
    expectsPersonalLinkedIn: true
  },
  // inbolt.com is a minimal Webflow marketing site with no street address or named team on the
  // crawlable pages (founders are findable only via external sources), so no publicCity target.
  { name: "Inbolt", domain: "https://www.inbolt.com", country: "France", expectedNameIncludes: ["inbolt"], expectsPersonalLinkedIn: true },
  { name: "VisionX", domain: "https://www.visionx.com.pl", country: "Poland", publicCity: "Gdańsk", expectedNameIncludes: ["visionx"], expectsPersonalLinkedIn: true },
  {
    name: "Smartray",
    domain: "https://www.smartray.com",
    country: "Germany",
    // Imprint: Bürgermeister-Finsterwalder-Ring 12, 82515 Wolfratshausen — Executive Director Mathias Reiter.
    publicCity: "Wolfratshausen",
    publicManager: "Mathias Reiter",
    expectedNameIncludes: ["smartray"],
    expectsPersonalLinkedIn: true
  },
  {
    name: "Qubbervision",
    domain: "https://qubbervision.com",
    country: "Greece",
    // Regression guard for the deterministic Azure-profiler defect where the bare domain
    // (with TLD, all caps) was returned as the company name instead of the brand.
    forbiddenResolvedNames: ["QUBBERVISION.COM", "qubbervision.com"],
    // Contact page: 106 Diminiou Str., 38500 Dimini, Volos — Executive Director Sotirios Bekos.
    publicCity: "Volos",
    publicManager: "Sotirios Bekos",
    expectedNameIncludes: ["qubber"]
  },
  { name: "Althera di Castelluccio Francesco", domain: "https://althera.it", country: "Italy", publicCity: "Lecco", expectedNameIncludes: ["althera"], expectsPersonalLinkedIn: true },
  // Aviso legal: VISIONA Control Industrial S.L., Calle A 63, Pol. Ind. Mutilva, 31192 Mutilva (Navarra).
  { name: "Visionasl", domain: "https://visionasl.com", country: "Spain", publicCity: "Mutilva", expectedNameIncludes: ["visiona"] },
  { name: "Vici & C. S.p.A.", domain: "https://vici.it", country: "Italy", publicCity: "Santarcangelo di Romagna", expectedNameIncludes: ["vici"] },
  { name: "CVL4", domain: "https://kestrel-vision.com", country: "France", publicCity: "Saint-Genis-Laval", expectedNameIncludes: ["cvl4", "kestrel"], expectsPersonalLinkedIn: true },
  { name: "Engilico Engineering Solutions NV", domain: "https://www.engilico.com", country: "Belgium", publicCity: "Rotselaar", expectedNameIncludes: ["engilico"] },
  { name: "ANTICIPATE GmbH", domain: "https://anticipate.webflow.io", country: "Germany", publicCity: "Aachen", expectedNameIncludes: ["anticipate"], expectsPersonalLinkedIn: true }
];

/**
 * Reproducible thresholds. Deliberately set below the observed 2026-06-24 run
 * (16/20 with contacts, 7/20 with personal /in/) to absorb transient crawl/anti-bot
 * variance while still failing loudly if contact discovery regresses meaningfully.
 */
export const companyPipelineReproExpectations: CompanyPipelineReproExpectations = {
  minCompaniesWithContacts: 12,
  minCompaniesWithPersonalLinkedIn: 5,
  // 17 companies have a research-verified public city on their own crawlable domain. The
  // 2026-06-24 run resolved a city for only 10 of them and returned country-only for CASE,
  // ConnectedThinks, Smartray, Qubbervision, Baumer, VisionX and Visionasl — a real address
  // under-extraction. Target: at least 11 must resolve a city. Raise toward 17 as extraction improves.
  minCompaniesWithResolvedCity: 11,
  // Per-company completeness floor. The 2026-06-24 run had ~9/20 fully complete; this floor locks in
  // no-regression while the target is 20/20. The per-company `missingInfo` report lists every gap.
  minFullyComplete: 8
};
