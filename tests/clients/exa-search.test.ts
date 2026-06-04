import test from "node:test";
import assert from "node:assert/strict";
import { ExaSearchClient } from "../../src/clients/exa-search";
import { buildDebugSearchFilter } from "../../src/debug/test-console";

test("buildQueries includes localized Germany variants and official-website discovery angles", () => {
  const client = new ExaSearchClient();
  const queries = client["buildQueries"]({
    name: "Germany Vision Integrators",
    persona: "machine vision integrator",
    locations: ["Germany"],
    keywords: ["industrielle bildverarbeitung", "bildverarbeitungssysteme", "machine vision"],
    notes: "Find integrators with customer projects.",
    targetCategories: ["integrator_vision_industrial_ai"]
  }, 1) as string[];

  assert.ok(queries.some((query) => query.includes("Germany")));
  assert.ok(queries.some((query) => query.includes("Deutschland")));
  assert.ok(queries.some((query) => query.includes("Berlin Germany")));
  assert.ok(queries.some((query) => query.includes("Ruhr area Germany")));
  assert.ok(queries.some((query) => /official company websites/i.test(query)));
  assert.ok(queries.some((query) => /exclude directories, marketplaces, job boards/i.test(query)));
});

test("buildQueries switches industrial end customers away from integrator wording", () => {
  const client = new ExaSearchClient();
  const queries = client["buildQueries"]({
    name: "DACH Scaled Industrial End Customers",
    persona: "Industrial end customer with own production scale and likely QC/process-automation upside",
    industries: ["Food Production", "Consumer Goods", "Pharma Manufacturing"],
    locations: ["Germany"],
    keywords: ["quality control", "visual inspection", "process automation", "production line", "machine vision"],
    employeeRanges: ["201,500"],
    notes: "Prefer companies with visible production engineering ownership and enough scale for high-value projects. Target factory operators and manufacturers that buy and run production equipment, not machine builders, OEMs, or automation vendors.",
    targetCategories: ["industrial_end_customer_scaled"]
  }, 1) as string[];

  assert.ok(queries.some((query) => /industrial end customers|plant operators|producers|processors/i.test(query)));
  assert.ok(queries.some((query) => /buy and run production equipment|purchase machinery|buy and operate machinery/i.test(query)));
  assert.ok(queries.some((query) => /Exclude system integrators.*machine builders.*OEMs/i.test(query)));
  assert.ok(queries.every((query) => !/Prefer official company websites of system integrators or solution providers/i.test(query)));
  assert.ok(queries.every((query) => !/machinery manufacturers/i.test(query)));
  assert.ok(queries.every((query) => !/Prefer official company websites of manufacturers/i.test(query)));
});

test("buildQueries appends the target-category refinement to baseline Exa queries", () => {
  const client = new ExaSearchClient();
  const queries = client["buildQueries"]({
    name: "Relevant Industry Integrators",
    persona: "industrial software and automation integrator",
    industries: ["Food Production"],
    locations: ["Germany"],
    keywords: ["mes", "scada", "quality control"],
    notes: "Find integrators with customer projects.",
    targetCategories: ["integrator_relevant_focus"]
  }, 1, {
    targetCategoryRefinement: "Nur Firmen die Lebensmittel produzieren"
  }) as string[];

  assert.ok(queries.length > 0);
  assert.ok(queries.every((query) => /Within the selected target categories, narrow results to: Nur Firmen die Lebensmittel produzieren\./i.test(query)));
});

test("buildDebugSearchFilter picks the dedicated Europe automation filter for integrator_relevant_focus", () => {
  const filter = buildDebugSearchFilter("integrator_relevant_focus", "Europe");

  assert.equal(filter.name, "Europe Industrial Automation Integration Partners [debug Europe]");
  assert.deepEqual(filter.targetCategories, ["integrator_relevant_focus"]);
});

test("buildQueries uses machine-builder specific language for machine_builder_ai_enablement", () => {
  const client = new ExaSearchClient();
  const queries = client["buildQueries"]({
    name: "DACH Machine Builders For AI Options",
    persona: "Machine builder or OEM that can offer AI options, fixtures, or AI-ready integrations to customers",
    industries: ["Machinery", "Industrial Automation", "Electrical Manufacturing"],
    locations: ["Europe"],
    keywords: ["special machinery", "oem", "inspection systems", "automation equipment", "production machines"],
    employeeRanges: ["51,200"],
    notes: "Prefer builders with modular products and clear customer integration pathways.",
    targetCategories: ["machine_builder_ai_enablement"]
  }, 1) as string[];

  assert.ok(queries.some((query) => /machine builders|OEMs|automation equipment suppliers/i.test(query)));
  assert.ok(queries.some((query) => /customer machines|production machines|special machinery builders/i.test(query)));
  assert.ok(queries.every((query) => !/turnkey vision inspection solutions/i.test(query)));
});

test("buildQueries uses consulting-specific language for consulting-led vision AI filters", () => {
  const client = new ExaSearchClient();
  const queries = client["buildQueries"]({
    name: "Germany Vision AI Consulting Specialists",
    persona: "Consulting-led machine vision and industrial AI specialist delivering implementation work for customers",
    industries: ["Industrial Automation", "Machine Vision"],
    locations: ["Germany"],
    keywords: ["machine vision consulting", "industrial AI consulting", "inspection implementation", "embedded vision"],
    employeeRanges: ["11,50"],
    notes: "Prefer specialist boutiques and consulting-led delivery teams with hands-on implementation ownership.",
    targetCategories: ["integrator_vision_ai_consulting"]
  }, 1) as string[];

  assert.ok(queries.some((query) => /consulting firms|specialist boutiques|implementation consultancies/i.test(query)));
  assert.ok(queries.some((query) => /machine vision.*consultants|industrial AI.*consultants|embedded vision consultants/i.test(query)));
  assert.ok(queries.every((query) => !/official company websites of system integrators or solution providers/i.test(query)));
});

test("buildQueries uses freelancer-specific language for solo vision AI specialists", () => {
  const client = new ExaSearchClient();
  const queries = client["buildQueries"]({
    name: "Germany Vision AI Freelancers",
    persona: "Solo machine vision and industrial AI freelancer delivering customer implementation work",
    industries: ["Industrial Automation"],
    locations: ["Germany"],
    keywords: ["computer vision freelancer", "inspection consultant", "machine vision consultant"],
    employeeRanges: ["1,10"],
    notes: "Prefer independent specialists and solo consultants, not agencies or staffing marketplaces.",
    targetCategories: ["integrator_vision_ai_freelancer"]
  }, 1) as string[];

  assert.ok(queries.some((query) => /independent consultants, freelancers, and solo specialists/i.test(query)));
  assert.ok(queries.some((query) => /personal business websites of independent specialists/i.test(query)));
  assert.ok(queries.every((query) => !/official company websites of system integrators or solution providers/i.test(query)));
});

test("discoverCompanies requests 20 Exa results per query regardless of lead limit", async () => {
  const client = new ExaSearchClient();
  client.setApiKey("test-key");

  const requestedCounts: number[] = [];
  client["runSearch"] = async (_apiKey: string, query: string, numResults: number) => {
    requestedCounts.push(numResults);
    return {
      results: [
        {
          title: `Example Integrator ${query.length}`,
          url: `https://example-${query.length}.de/`,
          summary: "Industrial automation integrator"
        }
      ]
    };
  };

  const companies = await client.discoverCompanies({
    name: "Germany Vision Integrators",
    persona: "machine vision integrator",
    locations: ["Germany"],
    keywords: ["industrielle bildverarbeitung", "bildverarbeitungssysteme", "machine vision"],
    notes: "Find integrators with customer projects.",
    targetCategories: ["integrator_vision_industrial_ai"]
  }, 1, 1);

  assert.ok(companies.length >= 1);
  assert.ok(requestedCounts.length >= 1);
  assert.ok(requestedCounts.every((count) => count === 20));
});

test("buildSearchPayload omits category company by default", () => {
  const client = new ExaSearchClient();
  const payload = client["buildSearchPayload"]("test query", 20, ["example.com"]);

  assert.equal(payload.category, undefined);
  assert.deepEqual(payload.excludeDomains, ["example.com"]);
  assert.equal(payload.contents.summary, true);
  assert.equal(payload.contents.highlights, true);
});

test("buildSearchPayload can enable category company and disable excludeDomains", () => {
  const client = new ExaSearchClient();
  client.setSearchPayloadOptions({
    includeCompanyCategoryFilter: true,
    includeExcludeDomains: false
  });

  const payload = client["buildSearchPayload"]("test query", 20, ["example.com"]);

  assert.equal(payload.category, "company");
  assert.equal(payload.excludeDomains, undefined);
});

test("discoverCompanies keeps duplicate valid Exa company URLs for downstream Azure review", async () => {
  const client = new ExaSearchClient();
  client.setApiKey("test-key");
  let callCount = 0;
  client["runSearch"] = async () => {
    callCount += 1;
    return {
      results: callCount === 1
        ? [
            {
              title: "Example Integrator GmbH",
              url: "https://example-integrator.de/",
              summary: "Industrial integrator"
            },
            {
              title: "Example Integrator GmbH LinkedIn",
              url: "https://example-integrator.de/",
              summary: "Same company duplicate"
            }
          ]
        : []
    };
  };

  const companies = await client.discoverCompanies({
    name: "Germany Vision Integrators",
    persona: "machine vision integrator",
    locations: ["Germany"],
    keywords: ["industrielle bildverarbeitung", "bildverarbeitungssysteme", "machine vision"],
    notes: "Find integrators with customer projects.",
    targetCategories: ["integrator_vision_industrial_ai"]
  }, 1, 1);

  assert.equal(companies.length, 2);
  assert.equal(companies[0]?.domain, "https://example-integrator.de");
  assert.equal(companies[1]?.domain, "https://example-integrator.de");
});

test("discoverCompanies canonicalizes Exa results to the root company domain", async () => {
  const client = new ExaSearchClient();
  client.setApiKey("test-key");
  client["runSearch"] = async () => ({
    results: [
      {
        title: "Example Integrator Team",
        url: "https://example-integrator.de/team/",
        summary: "Team page"
      },
      {
        title: "Example Integrator Contact",
        url: "https://example-integrator.de/contact/",
        summary: "Contact page"
      }
    ]
  });

  const companies = await client.discoverCompanies({
    name: "Germany Vision Integrators",
    persona: "machine vision integrator",
    locations: ["Germany"],
    keywords: ["industrielle bildverarbeitung", "bildverarbeitungssysteme", "machine vision"],
    notes: "Find integrators with customer projects.",
    targetCategories: ["integrator_vision_industrial_ai"]
  }, 2, 1);

  assert.equal(companies[0]?.domain, "https://example-integrator.de");
  assert.equal(companies[1]?.domain, "https://example-integrator.de");
});

test("normalizeUrl collapses Exa result urls to the root company domain", () => {
  const client = new ExaSearchClient();
  const normalizeUrl = client["normalizeUrl"].bind(client) as (url?: string) => string | undefined;

  assert.equal(normalizeUrl("http://www.example-integrator.de/team/?a=1#people"), "https://www.example-integrator.de");
  assert.equal(normalizeUrl("https://example-integrator.de/contact"), "https://example-integrator.de");
});

test("buildSearchPayload normalizes excluded websites to basis domains", () => {
  const client = new ExaSearchClient();
  client.setAdditionalExcludedDomains([
    "https://jobs.example-integrator.co.uk/team",
    "https://www.example-integrator.de/contact"
  ]);

  const payload = client["buildSearchPayload"]("test query", 20, ["https://foo.example-integrator.co.uk/about"]);

  assert.deepEqual(payload.excludeDomains, ["example-integrator.co.uk", "example-integrator.de"]);
});

test("deriveCompanyName falls back to the domain when Exa returns a marketing headline", () => {
  const client = new ExaSearchClient();
  const deriveCompanyName = client["deriveCompanyName"].bind(client) as (domain: string, title?: string) => string;

  assert.equal(
    deriveCompanyName("https://geott.de", "Intelligent Machine Vision for Industrial Marking ▶️ Vision / AI"),
    "Geott"
  );
});

test("inferCountryFromDomain does not inherit Germany from the filter for foreign evidence", () => {
  const client = new ExaSearchClient();
  const inferCountryFromDomain = client["inferCountryFromDomain"].bind(client) as (
    domain: string,
    result: { title?: string; highlights?: string[]; summary?: string; text?: string },
    fallbackLocation?: string
  ) => string | undefined;

  const country = inferCountryFromDomain(
    "https://virocha.com",
    {
      title: "Virocha Technologies",
      highlights: ["Chennai, India industrial IoT solutions"],
      summary: "Industry 4.0 and smart buildings solutions",
      text: "Chennai India"
    },
    "Germany"
  );

  assert.equal(country, undefined);
});

test("inferCountryFromDomain keeps Germany only when there is domain or snippet evidence", () => {
  const client = new ExaSearchClient();
  const inferCountryFromDomain = client["inferCountryFromDomain"].bind(client) as (
    domain: string,
    result: { title?: string; highlights?: string[]; summary?: string; text?: string },
    fallbackLocation?: string
  ) => string | undefined;

  assert.equal(
    inferCountryFromDomain(
      "https://aislab.de",
      {
        title: "AISLab GmbH",
        summary: "Industrial AI systems",
        text: "No extra country evidence"
      },
      "Germany"
    ),
    "Germany"
  );

  assert.equal(
    inferCountryFromDomain(
      "https://example.com",
      {
        title: "Example Integrator",
        summary: "Based in Berlin, Germany",
        text: "Berlin Germany"
      },
      "Germany"
    ),
    "Germany"
  );

  assert.equal(
    inferCountryFromDomain(
      "https://example.com",
      {
        title: "Example Integrator",
        summary: "PLC and SCADA integration only",
        text: "No country mentioned"
      },
      "Germany"
    ),
    undefined
  );
});

test("inferCountryFromDomain recognizes additional European country TLDs", () => {
  const client = new ExaSearchClient();
  const inferCountryFromDomain = client["inferCountryFromDomain"].bind(client) as (
    domain: string,
    result: { title?: string; highlights?: string[]; summary?: string; text?: string },
    fallbackLocation?: string
  ) => string | undefined;

  assert.equal(
    inferCountryFromDomain(
      "https://nexusautomation.it",
      {
        title: "Nexus Automation",
        summary: "Industrial automation systems in Vicenza, Italy",
        text: "Vicenza Italy"
      },
      "Belgium"
    ),
    "Italy"
  );

  assert.equal(
    inferCountryFromDomain(
      "https://profigram.hu",
      {
        title: "Profigram",
        summary: "Automation engineering in Budapest, Hungary",
        text: "Budapest Hungary"
      },
      "Belgium"
    ),
    "Hungary"
  );
});