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
   * Number of companies for which ALL realistically achievable info must be present (correct
   * real-entity name, resolved city where the company publishes one, a contact, and a personal /in/
   * LinkedIn where one is realistically discoverable). This is the goal, not a floor: it equals the
   * full set, so the opt-in live test stays RED until the pipeline reaches every company's
   * research-backed maximum. The per-company `missingInfo` report lists each remaining gap.
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
  { name: "More Control Ltd", domain: "https://www.more-control.com", country: "United Kingdom", publicCity: "Milton Keynes", expectedNameIncludes: ["more control"], expectsPersonalLinkedIn: true },
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
    expectedNameIncludes: ["qubber"],
    expectsPersonalLinkedIn: true
  },
  { name: "Althera di Castelluccio Francesco", domain: "https://althera.it", country: "Italy", publicCity: "Lecco", expectedNameIncludes: ["althera"], expectsPersonalLinkedIn: true },
  // Aviso legal: VISIONA Control Industrial S.L., Calle A 63, Pol. Ind. Mutilva, 31192 Mutilva (Navarra).
  { name: "Visionasl", domain: "https://visionasl.com", country: "Spain", publicCity: "Mutilva", expectedNameIncludes: ["visiona"] },
  { name: "Vici & C. S.p.A.", domain: "https://vici.it", country: "Italy", publicCity: "Santarcangelo di Romagna", expectedNameIncludes: ["vici"], expectsPersonalLinkedIn: true },
  { name: "CVL4", domain: "https://kestrel-vision.com", country: "France", publicCity: "Saint-Genis-Laval", expectedNameIncludes: ["cvl4", "kestrel"], expectsPersonalLinkedIn: true },
  { name: "Engilico Engineering Solutions NV", domain: "https://www.engilico.com", country: "Belgium", publicCity: "Rotselaar", expectedNameIncludes: ["engilico"], expectsPersonalLinkedIn: true },
  { name: "ANTICIPATE GmbH", domain: "https://anticipate.webflow.io", country: "Germany", publicCity: "Aachen", expectedNameIncludes: ["anticipate"], expectsPersonalLinkedIn: true }
];

/**
 * Targets = the research-backed realistic maximum per dimension, not a regression floor.
 * The opt-in live test is intentionally RED until the pipeline reaches every company's achievable
 * ceiling; the per-company `missingInfo` report shows exactly what is still missing each run.
 *  - contacts: all 20 (every company should surface at least a fallback mailbox).
 *  - personal /in/ LinkedIn: 16 (companies with a named executive or multi-person staffing; the 4
 *    micro firms ConnectedThinks, Smart Industrial, Ifsvision and Visionasl stay contact-only,
 *    because there a generic mailbox is the honest ceiling — "don't chase what isn't there").
 *  - resolved city: 17 (the companies that publish a street address on their crawlable domain;
 *    Viscom/.cn, Dr. Schenk/cn-subdomain and the Inbolt Webflow stub are legitimately exempt).
 *  - fully complete: all 20 reaching their own per-company achievable bar.
 */
export const companyPipelineReproExpectations: CompanyPipelineReproExpectations = {
  minCompaniesWithContacts: 20,
  minCompaniesWithPersonalLinkedIn: 16,
  minCompaniesWithResolvedCity: 17,
  minFullyComplete: 20
};
