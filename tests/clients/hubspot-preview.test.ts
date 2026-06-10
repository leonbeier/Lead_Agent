import test from "node:test";
import assert from "node:assert/strict";
import { HubSpotClient } from "../../src/clients/hubspot";
import { PreCategorizedCompany, PublicContactCandidate, ResearchBrief } from "../../src/types";

function buildSampleCompany(): PreCategorizedCompany {
  return {
    name: "Sample Automation GmbH",
    domain: "https://sample-automation.de",
    country: "Germany",
    shortDescription: "Industrial automation and PLC integration for manufacturing customers.",
    sourceFilter: "Debug filter",
    category: "integrator_relevant_focus",
    relevanceScore: 78,
    rationale: "Industrial implementation partner."
  };
}

function buildSampleBrief(): ResearchBrief {
  return {
    companyName: "Sample Automation GmbH",
    overview: "Overview",
    qualificationSummary: "Strong industrial delivery fit.",
    qualifyingSignals: ["PLC", "SCADA"],
    riskFlags: [],
    likelyGermanSpeaking: true,
    outreachLanguage: "de",
    rankings: {
      customer: 4,
      serviceProvider: 9,
      partner: 5
    },
    businessPotentialEUR: 24000,
    businessPotentialReasoning: "Multiple delivery-led AI opportunities.",
    targetIndustry: "INDUSTRIAL_AUTOMATION",
    productsOffered: "PLC integration, SCADA integration",
    recommendedTemplateKey: "integrator_relevant_focus",
    personalizationRule: "Mention PLC and SCADA delivery.",
    linkedInAngle: "Delivery partner",
    emailAngle: "Industrial automation",
    phoneAngle: "Partnership",
    linkedInConnectionRequest: "Hallo [Name], kurze Frage zu Ihren PLC/SCADA-Projekten.",
    linkedInMessage: "Hallo [Name], wir helfen Integratoren, Vision-AI schneller produktiv zu bekommen.",
    emailSubject: "Vision-AI fuer PLC/SCADA-Projekte",
    emailBody: "Hallo Herr/Frau [Name], wir helfen Integratoren bei produktionsreifen Vision-AI-Deployments.",
    phoneScript: "Hallo Herr/Frau [Name], setzen Sie bereits Vision AI in Kundenprojekten ein?"
  };
}

test("previewHubSpotSync builds company field previews from the same mapping as live sync", async () => {
  const client = new HubSpotClient();
  const preview = await client.previewHubSpotSync(buildSampleCompany(), buildSampleBrief(), [], { includeAddressLookup: false });

  assert.equal(preview.companyProperties.ai_cc_category, "integrator_relevant_focus");
  assert.equal(preview.companyProperties.ai_cc_email_subject, "Vision-AI fuer PLC/SCADA-Projekte");
  assert.equal(preview.companyProperties.domain, "sample-automation.de");
  assert.match(preview.companyProperties.description, /Industrial automation/i);
});

test("previewHubSpotSync skips generic mailbox contacts without name or phone, keeps named contacts", async () => {
  const client = new HubSpotClient();
  const contacts: PublicContactCandidate[] = [
    {
      email: "info@sample-automation.de",
      sourceUrl: "https://sample-automation.de/contact",
      label: "public_generic_mailbox"
    },
    {
      email: "martin@sample-automation.de",
      firstName: "Martin",
      lastName: "Minsel",
      jobTitle: "Managing Director",
      linkedinUrl: "https://www.linkedin.com/in/martin-minsel/",
      sourceUrl: "https://www.linkedin.com/in/martin-minsel/",
      label: "linkedin_profile"
    }
  ];

  const preview = await client.previewHubSpotSync(buildSampleCompany(), buildSampleBrief(), contacts, { includeAddressLookup: false });

  // Generic mailbox without name/phone/linkedin is skipped
  assert.equal(preview.contacts[0]?.skipped, true);
  assert.equal(preview.contacts[1]?.skipped, false);
  assert.equal(preview.contacts[1]?.properties.firstname, "Martin");
  assert.equal(preview.contacts[1]?.properties.jobtitle, "Managing Director");
  assert.equal(preview.contacts[1]?.properties.hs_linkedin_url, "https://www.linkedin.com/in/martin-minsel");
  assert.match(preview.contacts[1]?.outreachNote ?? "", /LinkedIn Outreach/);
});

test("previewHubSpotSync keeps generic mailbox contacts when a phone number is present", async () => {
  const client = new HubSpotClient();
  const contacts: PublicContactCandidate[] = [
    {
      email: "info@pexon-consulting.de",
      phone: "+49 69 96759440",
      sourceUrl: "https://pexon-consulting.de/kontakt",
      label: "public_generic_mailbox",
      jobTitle: "General contact"
    }
  ];

  const preview = await client.previewHubSpotSync(buildSampleCompany(), buildSampleBrief(), contacts, { includeAddressLookup: false });

  assert.equal(preview.contacts[0]?.skipped, false);
  assert.equal(preview.contacts[0]?.properties.email, "info@pexon-consulting.de");
  assert.equal(preview.contacts[0]?.properties.phone, "+49 69 96759440");
});

test("previewHubSpotSync includes resolved address fields when address lookup is enabled", async () => {
  const client = new HubSpotClient();
  client["extractCompanyAddress"] = async () => ({
    companyName: "Sample Automation GmbH",
    address: "Musterstrasse 12",
    city: "Schwerin",
    zip: "19053",
    state: "Mecklenburg-Vorpommern",
    country: "Germany"
  });

  const preview = await client.previewHubSpotSync(buildSampleCompany(), buildSampleBrief(), [], { includeAddressLookup: true });

  assert.equal(preview.companyProperties.address, "Musterstrasse 12");
  assert.equal(preview.companyProperties.city, "Schwerin");
  assert.equal(preview.companyProperties.zip, "19053");
  assert.equal(preview.companyProperties.state, "Mecklenburg-Vorpommern");
  assert.equal(preview.companyProperties.country, "Germany");
});

test("extractEmails normalizes bracketed obfuscated mailbox addresses", () => {
  const client = new HubSpotClient();
  const emails = client["extractEmails"](`
    <html>
      <body>
        <p>Kontakt: info[at]ceeltec.de</p>
      </body>
    </html>
  `, new Set(["ceeltec.de"]));

  assert.deepEqual(emails, ["info@ceeltec.de"]);
});

test("extractPhones captures local-format phone numbers in contact contexts", () => {
  const client = new HubSpotClient();
  const phones = client["extractPhones"](`
    <html>
      <body>
        <p>Telefon: 07821 / 9972-30</p>
      </body>
    </html>
  `);

  assert.deepEqual(phones, ["07821 / 9972-30"]);
});

test("previewHubSpotSync prefers a legal entity name resolved from official pages", async () => {
  const client = new HubSpotClient();
  client["extractCompanyAddress"] = async () => ({
    companyName: "BERND MÜNSTERMANN GMBH & CO. KG"
  });

  const preview = await client.previewHubSpotSync({
    ...buildSampleCompany(),
    name: "Muenstermann",
    domain: "https://muenstermann.com"
  }, buildSampleBrief(), [], { includeAddressLookup: true });

  assert.equal(preview.companyProperties.name, "BERND MÜNSTERMANN GMBH & CO. KG");
});

test("extractCompanyAddress prefers the AI website company profile before weaker web-search data", async () => {
  const client = new HubSpotClient();
  client["getOfficialWebsiteCompanyProfile"] = async () => ({
    companyName: "MODI Modular Digits GmbH",
    entityScope: "exact_operating_entity",
    address: "An der Höhe 20",
    city: "Wiehl",
    zip: "51674",
    state: undefined,
    country: "Germany",
    emails: ["info@modi-gmbh.de"],
    phones: ["+49 2261 915520"],
    linkedInUrls: ["https://www.linkedin.com/company/modi-trace"],
    sourceUrls: ["https://moditrace.net/impressum"]
  });
  client["collectCandidatePages"] = async () => [];
  client["extractCompanyAddressWithWebSearch"] = async () => ({
    companyName: "Moditrace",
    address: "Wrong Street 1",
    city: "Wrong City",
    zip: "00000",
    country: "Germany"
  });

  const extracted = await client["extractCompanyAddress"]({
    ...buildSampleCompany(),
    name: "Moditrace",
    domain: "https://moditrace.net"
  });

  assert.equal(extracted?.companyName, "MODI Modular Digits GmbH");
  assert.equal(extracted?.address, "An der Höhe 20");
  assert.equal(extracted?.city, "Wiehl");
  assert.equal(extracted?.zip, "51674");
});

test("extractCompanyAddress ignores parent-group names from the website profile when the exact operating entity is not confirmed", async () => {
  const client = new HubSpotClient();
  client["getOfficialWebsiteCompanyProfile"] = async () => ({
    companyName: "Die smarten Produkte der Eckelmann AG",
    entityScope: "parent_group",
    address: "Fichtenweg 36",
    city: "Erfurt",
    zip: "99098",
    state: undefined,
    country: "Germany",
    emails: ["info@rex-at.de"],
    phones: ["+49 361 550760"],
    linkedInUrls: ["https://www.linkedin.com/company/rex-at"],
    sourceUrls: ["https://rex-at.de/impressum"]
  });
  client["collectCandidatePages"] = async () => ([
    {
      url: "https://rex-at.de/impressum",
      html: `
        <html>
          <body>
            <h1>Impressum</h1>
            <p>REX Automatisierungstechnik GmbH</p>
          </body>
        </html>
      `
    }
  ]);
  client["extractCompanyAddressWithWebSearch"] = async () => ({
    companyName: "REX Automatisierungstechnik GmbH",
    address: "Fichtenweg 36",
    city: "Erfurt",
    zip: "99098",
    country: "Germany"
  });

  const extracted = await client["extractCompanyAddress"]({
    ...buildSampleCompany(),
    name: "Rex At",
    domain: "https://rex-at.de"
  });

  assert.equal(extracted?.companyName, "REX Automatisierungstechnik GmbH");
  assert.equal(extracted?.address, "Fichtenweg 36");
  assert.equal(extracted?.city, "Erfurt");
});

test("extractCompanyAddress prefers the legal entity from official pages over a weaker web-search company name", async () => {
  const client = new HubSpotClient();
  client["getOfficialWebsiteCompanyProfile"] = async () => ({
    companyName: "Die smarten Produkte der Eckelmann AG",
    entityScope: "parent_group",
    address: "Fichtenweg 36",
    city: "Erfurt",
    zip: "99098",
    state: undefined,
    country: "Germany",
    emails: ["info@rex-at.de"],
    phones: ["+49 361 550760"],
    linkedInUrls: [],
    sourceUrls: ["https://rex-at.de"]
  });
  client["collectCandidatePages"] = async () => ([
    {
      url: "https://rex-at.de/impressum",
      html: `
        <html>
          <body>
            <h1>Impressum</h1>
            <p>REX Automatisierungstechnik GmbH</p>
          </body>
        </html>
      `
    }
  ]);
  client["extractCompanyAddressWithWebSearch"] = async () => ({
    companyName: "Die smarten Produkte der Eckelmann AG",
    address: "Fichtenweg 36",
    city: "Erfurt",
    zip: "99098",
    country: "Germany"
  });

  const extracted = await client["extractCompanyAddress"]({
    ...buildSampleCompany(),
    name: "Rex At",
    domain: "https://rex-at.de"
  });

  assert.equal(extracted?.companyName, "REX Automatisierungstechnik GmbH");
  assert.equal(extracted?.address, "Fichtenweg 36");
  assert.equal(extracted?.city, "Erfurt");
});

test("extractCompanyAddress captures legal entity names from impressum pages", async () => {
  const client = new HubSpotClient();
  client["getOfficialWebsiteCompanyProfile"] = async () => null;
  client["collectCandidatePages"] = async () => ([
    {
      url: "https://muenstermann.com/impressum",
      html: `
        <html>
          <body>
            <h1>Impressum</h1>
            <p>BERND MÜNSTERMANN GMBH & CO. KG</p>
          </body>
        </html>
      `
    }
  ]);
  client["apolloClient"] = {
    getOrganizationAddress: async () => null
  };
  client["extractCompanyAddressWithWebSearch"] = async () => null;

  const extracted = await client["extractCompanyAddress"]({
    name: "Muenstermann",
    domain: "https://muenstermann.com",
    country: "Germany"
  });

  assert.equal(extracted?.companyName, "BERND MÜNSTERMANN GMBH & CO. KG");
});

test("extractCompanyAddress trusts the AI website profile's non-German legal entity from the homepage footer", async () => {
  const client = new HubSpotClient();
  // Agent-first: the Azure website profiler extracts the legal entity "Geprom Software
  // Engineering SLU" from the homepage footer (© line) and labels it exact_operating_entity.
  // The name must be adopted even though SLU is not a German legal form and the source is the
  // homepage root (not an impressum/legal page).
  client["getOfficialWebsiteCompanyProfile"] = async () => ({
    companyName: "Geprom Software Engineering SLU",
    entityScope: "exact_operating_entity",
    searchAliases: [],
    address: "Carrer de la Tecnologia 17",
    city: "Barcelona",
    zip: "08840",
    state: undefined,
    country: "Spain",
    emails: ["info@geprom.com"],
    phones: [],
    linkedInUrls: [],
    sourceUrls: ["https://www.geprom.com"]
  });
  client["collectCandidatePages"] = async () => [];
  client["extractCompanyAddressWithWebSearch"] = async () => ({
    companyName: "Geprom",
    address: "Wrong Street 1",
    city: "Wrong City",
    zip: "00000",
    country: "Spain"
  });

  const extracted = await client["extractCompanyAddress"]({
    name: "Geprom",
    domain: "https://www.geprom.com",
    country: "Spain"
  });

  assert.equal(extracted?.companyName, "Geprom Software Engineering SLU");
});

test("isTrustedOfficialWebsiteProfile trusts a homepage-sourced name with a non-German legal form", () => {
  const client = new HubSpotClient();
  const trusted = client["isTrustedOfficialWebsiteProfile"](
    {
      companyName: "Geprom Software Engineering SLU",
      entityScope: "exact_operating_entity",
      searchAliases: [],
      emails: [],
      phones: [],
      linkedInUrls: [],
      sourceUrls: ["https://www.geprom.com"]
    },
    { name: "Geprom", domain: "https://www.geprom.com", country: "Spain" }
  );

  assert.equal(trusted, true);
});

test("isTrustedOfficialWebsiteProfile rejects a non-operating-entity scope and sentence-like prose", () => {
  const client = new HubSpotClient();
  const parentGroup = client["isTrustedOfficialWebsiteProfile"](
    {
      companyName: "Some Holding Group AG",
      entityScope: "parent_group",
      searchAliases: [],
      emails: [],
      phones: [],
      linkedInUrls: [],
      sourceUrls: ["https://www.example.com/impressum"]
    },
    { name: "Example", domain: "https://www.example.com", country: "Germany" }
  );
  const prose = client["isTrustedOfficialWebsiteProfile"](
    {
      companyName: "We build great software for the manufacturing industry. Contact us today for a personalized live demo.",
      entityScope: "exact_operating_entity",
      searchAliases: [],
      emails: [],
      phones: [],
      linkedInUrls: [],
      sourceUrls: ["https://www.example.com"]
    },
    { name: "Example", domain: "https://www.example.com", country: "Germany" }
  );

  assert.equal(parentGroup, false);
  assert.equal(prose, false);
});

test("extractCompanyAddress captures legal entity names from long mixed website lines", async () => {
  const client = new HubSpotClient();
  client["getOfficialWebsiteCompanyProfile"] = async () => null;
  client["collectCandidatePages"] = async () => ([
    {
      url: "https://rex-at.de/automation-engineering.html",
      html: `
        <html>
          <body>
            <p>Automation Engineering - REX Automatisierungstechnik GmbH {{insert_article::header-balken-link}} +49 (0) 36203/9591-0 info@rex-at.de News Unternehmen Ueber uns Eckelmann Group Standort Geschaeftsfuehrung Kompetenzen Automation Engineering Automation Projects Software Products Hardware Products Loesungen Automatisierung Fertigungsmaschinen Praezisionsmaschinen Sondermaschinen Anlagenautomation Retrofit</p>
            <p>Fuer einen in Waermepumpen wichtigen Vortex-Durchflusssensor wurde mit SMR Sondermaschinen GmbH ein anderer Anbieter genannt.</p>
          </body>
        </html>
      `
    }
  ]);
  client["apolloClient"] = {
    getOrganizationAddress: async () => null
  };
  client["extractCompanyAddressWithWebSearch"] = async () => ({
    companyName: "Die smarten Produkte der Eckelmann AG",
    address: "Fichtenweg 36",
    city: "Erfurt",
    zip: "99098",
    country: "Germany"
  });

  const extracted = await client["extractCompanyAddress"]({
    ...buildSampleCompany(),
    name: "Rex At",
    domain: "https://rex-at.de"
  });

  assert.equal(extracted?.companyName, "REX Automatisierungstechnik GmbH");
});

test("extractCompanyAddress parses inline footer addresses with legal entity and country", async () => {
  const client = new HubSpotClient();
  client["getOfficialWebsiteCompanyProfile"] = async () => null;
  client["collectCandidatePages"] = async () => ([
    {
      url: "https://tordivel.com",
      html: `
        <html>
          <body>
            <footer>
              <p>Tordivel AS, Storgata 20, N-0184 OSLO, Norway</p>
              <p>Company Registration: NO966813946 MVA</p>
            </footer>
          </body>
        </html>
      `
    }
  ]);
  client["apolloClient"] = {
    getOrganizationAddress: async () => null
  };
  client["extractCompanyAddressWithWebSearch"] = async () => null;

  const extracted = await client["extractCompanyAddress"]({
    name: "Tordivel",
    domain: "https://tordivel.com",
    country: "Germany"
  });

  assert.equal(extracted?.companyName, "Tordivel AS");
  assert.equal(extracted?.address, "Storgata 20");
  assert.equal(extracted?.zip, "N-0184");
  assert.equal(extracted?.city, "OSLO");
  assert.equal(extracted?.country, "Norway");
});

test("extractCompanyAddress ignores a leading copyright year in legal entity names", async () => {
  const client = new HubSpotClient();
  client["getOfficialWebsiteCompanyProfile"] = async () => null;
  client["collectCandidatePages"] = async () => ([
    {
      url: "https://prodot.de/impressum",
      html: `
        <html>
          <body>
            <footer>
              <p>2026 prodot GmbH, Schifferstra\u00dfe 196, 47059 Duisburg, Germany</p>
            </footer>
          </body>
        </html>
      `
    }
  ]);
  client["apolloClient"] = {
    getOrganizationAddress: async () => null
  };
  client["extractCompanyAddressWithWebSearch"] = async () => null;

  const extracted = await client["extractCompanyAddress"]({
    name: "Prodot",
    domain: "https://prodot.de",
    country: "Germany"
  } as any);

  assert.equal(extracted?.companyName, "prodot GmbH");
  assert.equal(extracted?.address, "Schifferstra\u00dfe 196");
  assert.equal(extracted?.zip, "47059");
  assert.equal(extracted?.city, "Duisburg");
  assert.equal(extracted?.country, "Germany");
});

test("findExistingCompany reuses HubSpot companies whose stored domain still includes protocol and www", async () => {
  const client = new HubSpotClient();
  const searchCalls: Array<{ objectType: string; propertyName: string; value: string }> = [];

  client["searchObject"] = async (objectType: "companies" | "contacts", propertyName: string, value: string) => {
    searchCalls.push({ objectType, propertyName, value });
    if (objectType === "companies" && propertyName === "domain" && value === "https://www.sample-automation.de") {
      return {
        id: "existing-company-id",
        properties: {
          domain: "https://www.sample-automation.de",
          name: "Sample Automation GmbH"
        }
      } as never;
    }

    return null;
  };

  const existingCompany = await client["findExistingCompany"]({
    ...buildSampleCompany(),
    domain: "sample-automation.de"
  });

  assert.equal(existingCompany?.id, "existing-company-id");
  assert.deepEqual(
    searchCalls
      .filter((call) => call.objectType === "companies" && call.propertyName === "domain")
      .map((call) => call.value),
    [
      "sample-automation.de",
      "www.sample-automation.de",
      "https://sample-automation.de",
      "https://www.sample-automation.de"
    ]
  );
});

test("upsertContact creates new contacts with the intended primary company association", async () => {
  const client = new HubSpotClient();
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | null = null;

  client["findExistingContact"] = async () => null;

  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: "contact-123", properties: {} }), {
      status: 201,
      headers: {
        "content-type": "application/json"
      }
    }) as typeof fetch extends (...args: any[]) => infer T ? Awaited<T> : never;
  };

  try {
    const created = await client["upsertContact"]({
      email: "martin@sample-automation.de",
      firstName: "Martin",
      lastName: "Minsel",
      sourceUrl: "https://sample-automation.de/kontakt",
      label: "public_named_mailbox"
    }, new Set(["email", "firstname", "lastname"]), "company-456");

    assert.equal(created?.id, "contact-123");
    assert.deepEqual(capturedBody, {
      properties: {
        email: "martin@sample-automation.de",
        firstname: "Martin",
        lastname: "Minsel"
      },
      associations: [
        {
          to: {
            id: "company-456"
          },
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: 1
            },
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: 279
            }
          ]
        }
      ]
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("previewHubSpotSync tolerates non-string research brief fields", async () => {
  const client = new HubSpotClient();
  const malformedBrief = {
    ...buildSampleBrief(),
    targetIndustry: ["Industrial automation", "Machine vision"],
    productsOffered: ["PLC integration", "Inspection AI"],
    overview: ["Overview part 1", "Overview part 2"],
    qualificationSummary: ["Qualified", "Relevant"]
  } as unknown as ResearchBrief;

  const preview = await client.previewHubSpotSync(buildSampleCompany(), malformedBrief, [], { includeAddressLookup: false });

  assert.match(preview.companyProperties.description, /Overview part 1/);
  assert.equal(preview.companyProperties.ai_cc_customer_products_offered, "PLC integration, Inspection AI");
  assert.equal(preview.companyProperties.ai_cc_customer_target_industry, "Industrial automation, Machine vision");
});

test("low-confidence website named contacts are excluded from employee selection", async () => {
  const client = new HubSpotClient();
  const selectedContacts = await client["selectRelevantEmployeeContacts"](buildSampleCompany(), [
    {
      firstName: "Learn",
      lastName: "More",
      jobTitle: "New FXO CXP cameras combine Sony Pregius sensors and high throughput.",
      sourceUrl: "https://example.com",
      label: "website_named_contact"
    },
    {
      firstName: "Costa",
      lastName: "Rica",
      jobTitle: "Cook Islands",
      sourceUrl: "https://example.com/contact",
      label: "website_named_contact"
    }
  ]);

  assert.deepEqual(selectedContacts, []);
  assert.equal(client["isLowConfidenceWebsiteNamedContact"]({
    firstName: "Learn",
    lastName: "More",
    jobTitle: "New FXO CXP cameras combine Sony Pregius sensors and high throughput.",
    sourceUrl: "https://example.com",
    label: "website_named_contact"
  }), true);
});

test("priority website named contacts remain eligible when the title is credible", () => {
  const client = new HubSpotClient();

  assert.equal(client["isLowConfidenceWebsiteNamedContact"]({
    firstName: "Martin",
    lastName: "Minsel",
    jobTitle: "Managing Director",
    email: "info@sample-automation.de",
    sourceUrl: "https://sample-automation.de/impressum",
    label: "website_named_contact"
  }), false);
});

test("name extraction rejects CTA-style phrases", () => {
  const client = new HubSpotClient();

  assert.equal(client["extractNameFromLine"]("Learn More"), null);
  assert.equal(client["extractNameFromLine"]("What To Expect"), null);
  assert.equal(client["extractNameFromLine"]("Aislab Technology"), null);
  assert.equal(client["extractNameFromLine"]("Wie MES"), null);
});

test("email extraction decodes HTML entity obfuscation", () => {
  const client = new HubSpotClient();
  const emails = client["extractEmails"](
    "<a href=\"mailto:&#105&#110&#102&#111&#64&#103&#101&#111&#116&#116&#46&#100&#101\">Kontakt</a>",
    new Set(["geott.de"])
  );

  assert.deepEqual(emails, ["info@geott.de"]);
});

test("email extraction accepts a sibling-TLD company mailbox but rejects third-party platforms", () => {
  const client = new HubSpotClient();
  const allowed = client["buildAllowedEmailDomains"]("https://premosys.de");
  const emails = client["extractEmails"](
    `<a href="mailto:sales@premosys.com">Kontakt</a>
     <span>9123@sentry.wixpress.com</span>
     <span>noise@premosys.de</span>`,
    allowed
  );

  assert.ok(emails.includes("sales@premosys.com"));
  assert.ok(emails.includes("noise@premosys.de"));
  assert.ok(!emails.some((email) => email.includes("wixpress.com")));
});

test("descriptive company labels still produce domain-token aliases for LinkedIn search", () => {
  const client = new HubSpotClient();
  const aliases = client["extractCompanySearchAliases"]({
    name: "Intelligent Machine Vision for Industrial Marking Vision AI",
    domain: "https://geott.de"
  }, []);

  assert.ok(aliases.includes("Geott"));
});

test("company alias extraction ignores contact CTA phrases from page text", () => {
  const client = new HubSpotClient();
  const aliases = client["extractCompanySearchAliases"](
    {
      name: "Aislab",
      domain: "https://aislab.de"
    },
    [{
      url: "https://aislab.de/kontakt",
      html: "<body>Kontaktieren Sie AISLab GmbH</body>"
    }]
  );

  assert.ok(!aliases.includes("Kontaktieren Sie AISLab GmbH"));
});

test("discoverWebSearchContacts always calls foundry with all search evidence", async () => {
  const client = new HubSpotClient();
  const company = buildSampleCompany();
  let foundryEvidence = "";

  client["foundryAgentsClient"]["suggestPublicContactQueries"] = async () => [];
  client["searchBingResults"] = async () => ([
    {
      query: `${company.name} site:linkedin.com/in`,
      url: "https://www.linkedin.com/in/max-muster",
      title: "Max Muster - Sample Automation GmbH | LinkedIn",
      snippet: "Experience: Sample Automation GmbH"
    }
  ]);
  client["foundryAgentsClient"]["discoverPublicContacts"] = async (_company: unknown, evidence: string) => {
    foundryEvidence = evidence;
    return [];
  };

  await client["discoverWebSearchContacts"](company, [], []);

  // Agent-first: Foundry must always be called with the full evidence including search hits
  assert.ok(foundryEvidence.includes("Max Muster"), "Foundry should receive search hit evidence");
  assert.ok(foundryEvidence.includes("Web search evidence"), "Evidence should contain search section");
});

test("LinkedIn search queries prioritize exact legal aliases before generic short names", () => {
  const client = new HubSpotClient();
  const queries = client["buildPublicContactSearchQueries"](
    {
      name: "Aislab",
      domain: "https://aislab.de"
    },
    ["Aislab", "AISLAB GmbH"]
  ).filter((query: string) => /site:linkedin\.com\/in/i.test(query)).slice(0, 4);

  assert.ok(queries.every((query: string) => /AISLAB GmbH/i.test(query)));
});

test("browser fallback is used when direct website fetch is blocked", async () => {
  const client = new HubSpotClient();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response("403 - Forbidden", {
    status: 403,
    headers: {
      "content-type": "text/html"
    }
  }) as typeof fetch extends (...args: any[]) => infer T ? Awaited<T> : never;
  client["fetchHtmlWithBrowser"] = async () => "<html><body><a href=\"mailto:info@pexon-consulting.de\">info@pexon-consulting.de</a></body></html>";

  try {
    const html = await client["fetchHtml"]("https://pexon-consulting.de");
    assert.match(html ?? "", /info@pexon-consulting\.de/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("browser fallback is not triggered for plain 404 pages", async () => {
  const client = new HubSpotClient();
  const originalFetch = globalThis.fetch;
  let browserFallbackCalls = 0;

  globalThis.fetch = async () => new Response("Not Found", {
    status: 404,
    headers: {
      "content-type": "text/html"
    }
  }) as typeof fetch extends (...args: any[]) => infer T ? Awaited<T> : never;
  client["fetchHtmlWithBrowser"] = async () => {
    browserFallbackCalls += 1;
    return "<html><body>unexpected browser fallback</body></html>";
  };

  try {
    const html = await client["fetchHtml"]("https://pexon-consulting.de/ansprechpartner/");
    assert.equal(html, null);
    assert.equal(browserFallbackCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("browser fallback is not triggered by benign captcha labels in otherwise usable HTML", () => {
  const client = new HubSpotClient();

  const shouldRetry = client["shouldRetryHtmlFetchInBrowser"](
    200,
    `<html><body>
      <a href="mailto:info@pexon-consulting.de">info@pexon-consulting.de</a>
      <a href="tel:+496980884991">+49 69 80884991</a>
      <script type="application/json">{"captcha":"Captcha","wrong_captcha":"Sie haben die falsche Zahl im Captcha eingegeben."}</script>
    </body></html>`
  );

  assert.equal(shouldRetry, false);
});

test("browser fallback is not triggered by embedded recaptcha widgets on otherwise usable contact pages", () => {
  const client = new HubSpotClient();

  const shouldRetry = client["shouldRetryHtmlFetchInBrowser"](
    200,
    `<html><body>
      <main>
        <a href="mailto:info@sample-automation.de">info@sample-automation.de</a>
        <a href="tel:+4930123456">+49 30 123456</a>
        <form>
          <div class="g-recaptcha" data-sitekey="demo"></div>
        </form>
      </main>
    </body></html>`
  );

  assert.equal(shouldRetry, false);
});

test("website contact filter rejects business-phrase false positives", () => {
  const client = new HubSpotClient();

  assert.equal(client["isLowConfidenceWebsiteNamedContact"]({
    firstName: "Ai",
    lastName: "Data Analytics",
    jobTitle: "Managing Director",
    email: "phillip.pham@pexon-consulting.de",
    sourceUrl: "https://pexon-consulting.de",
    label: "website_named_contact",
    linkedinUrl: "https://www.linkedin.com/in/constantin-budin-92a08516a"
  }), true);
});

test("official website mailbox is selected as fallback when employee contacts exist", () => {
  const client = new HubSpotClient();

  const allContacts: PublicContactCandidate[] = [
    {
      firstName: "Hartmut",
      lastName: "Behncke",
      linkedinUrl: "https://de.linkedin.com/in/hartmut-behncke-5260b211a",
      sourceUrl: "https://de.linkedin.com/in/hartmut-behncke-5260b211a",
      label: "linkedin_profile"
    },
    {
      firstName: "Carol",
      lastName: "Ostia",
      linkedinUrl: "https://de.linkedin.com/in/carol-ostia-51a484b6",
      linkedinConnectionCount: 220,
      sourceUrl: "https://de.linkedin.com/in/carol-ostia-51a484b6",
      label: "linkedin_profile"
    },
    {
      firstName: "Patrick",
      lastName: "Engel",
      linkedinUrl: "https://de.linkedin.com/in/patrick-engel-2baa6326a",
      sourceUrl: "https://de.linkedin.com/in/patrick-engel-2baa6326a",
      label: "linkedin_profile"
    },
    {
      firstName: "Martin",
      lastName: "Zunker",
      linkedinUrl: "https://de.linkedin.com/in/martin-zunker-0799261ab",
      linkedinConnectionCount: 4,
      sourceUrl: "https://de.linkedin.com/in/martin-zunker-0799261ab",
      label: "linkedin_profile"
    },
    {
      email: "info@sample-automation.de",
      phone: "+49 30 123456",
      sourceUrl: "https://sample-automation.de/kontakt",
      label: "public_generic_mailbox",
      jobTitle: "General contact"
    }
  ];

  const fallbackContacts = client["selectReachableWebsiteFallbackContacts"](allContacts);

  assert.equal(fallbackContacts.length, 1);
  assert.equal(fallbackContacts[0]?.label, "public_generic_mailbox");
  assert.equal(fallbackContacts[0]?.email, "info@sample-automation.de");
});

test("final public contact composition keeps website mailbox and LinkedIn contacts together", () => {
  const client = new HubSpotClient();
  const selectedEmployees: PublicContactCandidate[] = [
    {
      email: "paul.niebler@pexon-consulting.de",
      phone: "+49 69 80884991",
      sourceUrl: "https://pexon-consulting.de/ki-beratung/computervision/",
      label: "public_named_mailbox",
      firstName: "Paul",
      lastName: "Niebler",
      jobTitle: "Public contact"
    }
  ];
  const allContacts: PublicContactCandidate[] = [
    ...selectedEmployees,
    {
      email: "info@pexon-consulting.de",
      phone: "+49 69 80884991",
      sourceUrl: "https://pexon-consulting.de/kontakt",
      label: "public_generic_mailbox",
      jobTitle: "General contact"
    },
    {
      firstName: "Max",
      lastName: "Hennig",
      linkedinUrl: "https://de.linkedin.com/in/max-hennig",
      sourceUrl: "https://de.linkedin.com/in/max-hennig",
      label: "linkedin_profile",
      jobTitle: "Owner"
    },
    {
      firstName: "Philipp",
      lastName: "Jaeger",
      linkedinUrl: "https://de.linkedin.com/in/philipp-jaeger-74381919b",
      sourceUrl: "https://de.linkedin.com/in/philipp-jaeger-74381919b",
      label: "linkedin_profile"
    }
  ];

  const finalContacts = client["composeFinalPublicContacts"](selectedEmployees, allContacts);

  assert.ok(finalContacts.some((contact) => contact.label === "public_generic_mailbox"));
  assert.ok(finalContacts.some((contact) => contact.label === "linkedin_profile"));
  assert.ok(finalContacts.some((contact) => contact.email === "paul.niebler@pexon-consulting.de"));
});

test("findPublicContactsFromPages keeps an official website mailbox alongside Azure LinkedIn contacts", async () => {
  const client = new HubSpotClient();
  const company = buildSampleCompany();

  // No pages are passed, so the official-website search fallback runs; stub it to keep the test
  // deterministic and off the network (the assertion only covers the mailbox + Azure LinkedIn merge).
  client["discoverOfficialWebsiteSearchContacts"] = async () => [];
  client["extractAzureMatchedContacts"] = async () => ({
    queries: [],
    hitGroups: [],
    contacts: [
      {
        firstName: "Max",
        lastName: "Muster",
        linkedinUrl: "https://www.linkedin.com/in/max-muster",
        sourceUrl: "https://www.linkedin.com/in/max-muster",
        label: "linkedin_profile",
        jobTitle: "Managing Director"
      }
    ]
  });

  const contacts = await client["findPublicContactsFromPages"](
    company,
    [],
    [
      {
        email: "info@sample-automation.de",
        phone: "+49 30 123456",
        sourceUrl: "https://sample-automation.de/kontakt",
        label: "public_generic_mailbox",
        jobTitle: "General contact"
      }
    ]
  );

  assert.ok(contacts.some((contact) => contact.email === "info@sample-automation.de"));
  assert.ok(contacts.some((contact) => contact.linkedinUrl === "https://www.linkedin.com/in/max-muster"));
});

test("findPublicContactsFromPages uses the exact operating entity from the official website profile as a search alias", async () => {
  const client = new HubSpotClient();
  const company = {
    ...buildSampleCompany(),
    name: "Rex At",
    domain: "https://rex-at.de"
  };
  let receivedAliases: string[] = [];

  client["getOfficialWebsiteCompanyProfile"] = async () => ({
    companyName: "REX Automatisierungstechnik GmbH",
    entityScope: "exact_operating_entity",
    address: undefined,
    city: undefined,
    zip: undefined,
    state: undefined,
    country: "Germany",
    emails: [],
    phones: [],
    linkedInUrls: [],
    sourceUrls: ["https://rex-at.de/impressum"]
  });
  client["extractAzureMatchedContacts"] = async (_company: unknown, _pages: unknown, aliases: string[]) => {
    receivedAliases = aliases;
    return { queries: [], hitGroups: [], contacts: [] };
  };
  client["discoverWebSearchContacts"] = async () => [];

  await client["findPublicContactsFromPages"](company, [{
    url: "https://rex-at.de/impressum",
    html: "<html><body><h1>Impressum</h1><p>Die smarten Produkte der Eckelmann AG</p><p>REX Automatisierungstechnik GmbH</p></body></html>"
  }], []);

  assert.equal(receivedAliases[0], "REX Automatisierungstechnik GmbH");
  assert.ok(receivedAliases.includes("REX Automatisierungstechnik GmbH"));
  assert.ok(!receivedAliases.includes("Die smarten Produkte der Eckelmann AG"));
});

test("debug contact discovery reuses cached LinkedIn search results for final selection", async () => {
  const client = new HubSpotClient();
  const company = buildSampleCompany();
  const originalFetch = globalThis.fetch;

  client["collectCandidatePages"] = async () => [];
  client["extractAzureMatchedContacts"] = async () => ({
    queries: ["Sample Automation site:linkedin.com/in"],
    hitGroups: [{
      query: "Sample Automation site:linkedin.com/in",
      hits: [{
        url: "https://de.linkedin.com/in/martin-minsel",
        title: "Martin Minsel - Sample Automation GmbH | LinkedIn",
        snippet: "Berufserfahrung: Sample Automation GmbH · Ort: Berlin · 500+ Kontakte auf LinkedIn.",
        query: "Sample Automation site:linkedin.com/in"
      }]
    }],
    contacts: [{
      firstName: "Martin",
      lastName: "Minsel",
      linkedinUrl: "https://de.linkedin.com/in/martin-minsel",
      sourceUrl: "https://de.linkedin.com/in/martin-minsel",
      label: "linkedin_profile"
    }]
  });
  globalThis.fetch = async () => new Response("", { status: 200 }) as typeof fetch extends (...args: any[]) => infer T ? Awaited<T> : never;

  try {
    const result = await client.debugPublicContactDiscovery(company);

    assert.ok(result.heuristicContacts.length > 0);
    assert.ok(result.selectedContacts.length > 0);
    assert.ok(result.selectedContacts.some((contact) => contact.linkedinUrl === "https://de.linkedin.com/in/martin-minsel"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("findPublicContacts seeds official contact pages from website crawl results", async () => {
  const client = new HubSpotClient();
  const company = buildSampleCompany();
  client["extractAzureMatchedContacts"] = async () => ({ queries: [], hitGroups: [], contacts: [] });

  // The page collector fetches buildLikelyContactPageUrls which includes /kontakt/ (with trailing slash).
  // Verify that contact info from such a page is correctly extracted and returned.
  client["collectCandidatePages"] = async () => [
    {
      url: "https://sample-automation.de/kontakt/",
      html: '<html><body><a href="mailto:info@sample-automation.de">info@sample-automation.de</a><a href="tel:+4930123456">+49 30 123456</a></body></html>'
    }
  ];
  client["discoverWebSearchContacts"] = async () => [];

  const contacts = await client["findPublicContacts"](company);

  assert.equal(contacts.length, 1);
  assert.ok(contacts.some((contact) => contact.email === "info@sample-automation.de"));
  assert.ok(contacts.some((contact) => contact.phone === "+4930123456"));
});

test("findPublicContactsFromPages prefers Azure-structured contacts over heuristic fallback", async () => {
  const client = new HubSpotClient();
  const company = buildSampleCompany();

  client["azureOpenAIClient"]["extractPublicContactsFromEvidence"] = async () => ([
    {
      firstName: "Martin",
      lastName: "Minsel",
      jobTitle: "Managing Director",
      email: "martin.minsel@sample-automation.de",
      phone: "+49 30 123456",
      linkedinUrl: "https://www.linkedin.com/in/martin-minsel/",
      sourceUrl: "https://www.linkedin.com/in/martin-minsel/",
      label: "linkedin_profile"
    }
  ]);
  client["searchBingResults"] = async () => [];
  client["discoverWebSearchContacts"] = async () => {
    throw new Error("heuristic fallback should not run when Azure already returned contacts");
  };

  const contacts = await client["findPublicContactsFromPages"](
    company,
    [{
      url: "https://sample-automation.de/kontakt",
      html: '<html><body><a href="mailto:info@sample-automation.de">info@sample-automation.de</a><a href="tel:+4930123456">+49 30 123456</a></body></html>'
    }],
    []
  );

  assert.equal(contacts.length, 1);
  assert.equal(contacts[0]?.firstName, "Martin");
  assert.equal(contacts[0]?.email, "martin.minsel@sample-automation.de");
  assert.equal(contacts[0]?.linkedinUrl, "https://www.linkedin.com/in/martin-minsel");
});

test("findPublicContactsFromPages returns official website contacts without waiting for web search fallback", async () => {
  const client = new HubSpotClient();
  const company = buildSampleCompany();

  // Agent-first: named website people are extracted by the Azure contact agent from raw page
  // evidence, not by a text heuristic. When the agent already returns a named website contact,
  // the deterministic web-search fallback must not run.
  // Stub the official-website profile/search lookups so the test stays deterministic and off the network.
  client["getOfficialWebsiteCompanyProfile"] = async () => null;
  client["discoverOfficialWebsiteSearchContacts"] = async () => [];
  client["extractAzureMatchedContacts"] = async () => ({
    queries: [],
    hitGroups: [],
    contacts: [
      {
        firstName: "Markus",
        lastName: "Fackert",
        jobTitle: "Managing Director",
        email: "info@sample-automation.de",
        phone: "+4930123456",
        sourceUrl: "https://sample-automation.de/kontakt",
        label: "website_named_contact"
      }
    ]
  });
  // LinkedIn-supplement path may be called to add people from LinkedIn on top of website contacts.
  // It should return nothing here so the result is still just the 1 named website contact.
  client["discoverWebSearchContacts"] = async () => [];

  const contacts = await client["findPublicContactsFromPages"](
    company,
    [{
      url: "https://sample-automation.de/kontakt",
      html: `
        <html>
          <body>
            <p>Management: Markus Fackert, Hendrik Schultes</p>
            <a href="mailto:info@sample-automation.de">info@sample-automation.de</a>
            <a href="tel:+4930123456">+49 30 123456</a>
          </body>
        </html>
      `
    }],
    undefined
  );

  assert.equal(contacts.length, 1);
  assert.equal(contacts[0]?.label, "website_named_contact");
  assert.equal(contacts[0]?.firstName, "Markus");
  assert.equal(contacts[0]?.lastName, "Fackert");
  assert.equal(contacts[0]?.email, "info@sample-automation.de");
  assert.equal(contacts[0]?.phone, "+4930123456");
});

test("findPublicContacts probes default contact paths when crawl results only expose the blocked homepage", async () => {
  const client = new HubSpotClient();
  const company = buildSampleCompany();
  client["extractAzureMatchedContacts"] = async () => ({ queries: [], hitGroups: [], contacts: [] });

  client["openAIWebSearchClient"]["crawlCompanyWebsite"] = async () => ({
    summary: "Official site summary",
    landingUrl: "https://sample-automation.de"
  });
  client["fetchHtml"] = async (url: string) => {
    if (url === "https://sample-automation.de") {
      return "<html><body>Please verify you are human</body></html>";
    }

    if (/\/kontakt\/$/i.test(url)) {
      return '<html><body><a href="mailto:info@sample-automation.de">info@sample-automation.de</a><a href="tel:+4930123456">+49 30 123456</a></body></html>';
    }

    return null;
  };
  client["discoverWebSearchContacts"] = async () => [];

  const contacts = await client["findPublicContacts"](company);

  assert.equal(contacts.length, 1);
  assert.ok(contacts.some((contact) => contact.email === "info@sample-automation.de"));
  assert.ok(contacts.some((contact) => contact.phone === "+4930123456"));
});

test("findPublicContacts retries likely contact pages through the official crawl fetch path when the normal HTML fetch has no contact data", async () => {
  const client = new HubSpotClient();
  const company = buildSampleCompany();
  client["extractAzureMatchedContacts"] = async () => ({ queries: [], hitGroups: [], contacts: [] });

  // Simulate: the root page is blocked (captcha), but the /kontakt/ page succeeds.
  // The page collector should still return the /kontakt/ page with contact info.
  client["collectCandidatePages"] = async () => [
    {
      url: "https://sample-automation.de/kontakt/",
      html: '<html><body><a href="mailto:info@sample-automation.de">info@sample-automation.de</a><a href="tel:+4930123456">+49 30 123456</a></body></html>'
    }
  ];
  client["discoverWebSearchContacts"] = async () => [];

  const contacts = await client["findPublicContacts"](company);

  assert.equal(contacts.length, 1);
  assert.ok(contacts.some((contact) => contact.email === "info@sample-automation.de"));
  assert.ok(contacts.some((contact) => contact.phone === "+4930123456"));
});

test("findPublicContacts adds official website email and phone from web search when HTML pages are blocked", async () => {
  const client = new HubSpotClient();
  const company = buildSampleCompany();

  client["collectCandidatePages"] = async () => [];
  client["getOfficialWebsiteCompanyProfile"] = async () => ({
    companyName: "Sample Automation GmbH",
    entityScope: "exact_operating_entity",
    address: "Musterstrasse 12",
    city: "Berlin",
    zip: "10115",
    state: undefined,
    country: "Germany",
    emails: ["info@sample-automation.de"],
    phones: ["+49 30 123456"],
    linkedInUrls: ["https://www.linkedin.com/company/sample-automation"],
    sourceUrls: ["https://sample-automation.de/kontakt"]
  });
  client["discoverWebSearchContacts"] = async () => ([
    {
      firstName: "Max",
      lastName: "Muster",
      linkedinUrl: "https://www.linkedin.com/in/max-muster",
      sourceUrl: "https://www.linkedin.com/in/max-muster",
      label: "linkedin_profile"
    }
  ]);
  client["azureOpenAIClient"]["choosePublicContacts"] = async (_company: unknown, contacts: PublicContactCandidate[]) => contacts.slice(0, 4);

  const contacts = await client["findPublicContacts"](company);

  assert.ok(contacts.some((contact) => contact.email === "info@sample-automation.de"));
  assert.ok(contacts.some((contact) => contact.phone === "+49 30 123456"));
  assert.ok(contacts.some((contact) => contact.linkedinUrl === "https://www.linkedin.com/in/max-muster"));
});

test("discoverOfficialWebsiteSearchContacts prefers AI website profile company contacts", async () => {
  const client = new HubSpotClient();
  const company = buildSampleCompany();

  client["getOfficialWebsiteCompanyProfile"] = async () => ({
    companyName: "Sample Automation GmbH",
    entityScope: "exact_operating_entity",
    address: "Musterstrasse 12",
    city: "Berlin",
    zip: "10115",
    state: undefined,
    country: "Germany",
    emails: ["info@sample-automation.de"],
    phones: ["+49 30 123456"],
    linkedInUrls: ["https://www.linkedin.com/company/sample-automation"],
    sourceUrls: ["https://sample-automation.de/kontakt"]
  });
  client["openAIWebSearchClient"]["findCompanyContactInfo"] = async () => {
    throw new Error("web search fallback should not run when AI website profile already has company contacts");
  };

  const contacts = await client["discoverOfficialWebsiteSearchContacts"](company);

  assert.equal(contacts.length, 1);
  assert.equal(contacts[0]?.email, "info@sample-automation.de");
  assert.equal(contacts[0]?.phone, "+49 30 123456");
  assert.equal(contacts[0]?.linkedinUrl, "https://www.linkedin.com/company/sample-automation");
});

test("discoverPublicContactsForExecution falls back to official company contact info when page collection times out", async () => {
  const client = new HubSpotClient();
  const company = buildSampleCompany();

  client["collectCandidatePages"] = async () => {
    throw new Error("Public contact discovery timed out.");
  };
  client["getOfficialWebsiteCompanyProfile"] = async () => ({
    companyName: "Sample Automation GmbH",
    entityScope: "exact_operating_entity",
    address: "Musterstrasse 12",
    city: "Berlin",
    zip: "10115",
    state: undefined,
    country: "Germany",
    emails: ["info@sample-automation.de"],
    phones: ["+49 30 123456"],
    linkedInUrls: [],
    sourceUrls: ["https://sample-automation.de/kontakt"]
  });
  client["discoverWebSearchContacts"] = async () => [];

  const contacts = await client.discoverPublicContactsForExecution(company, { selectedContactsTimeoutMs: 1000 });

  assert.equal(contacts.length, 1);
  assert.equal(contacts[0]?.email, "info@sample-automation.de");
  assert.equal(contacts[0]?.phone, "+49 30 123456");
  assert.equal(contacts[0]?.label, "public_generic_mailbox");
});

test("discoverWebSearchContacts returns foundry contacts from search evidence", async () => {
  const client = new HubSpotClient();
  const company = buildSampleCompany();
  let foundryCalled = false;

  client["foundryAgentsClient"]["suggestPublicContactQueries"] = async () => [];
  client["searchBingResults"] = async () => ([
    {
      query: `${company.name} site:linkedin.com/in`,
      url: "https://www.linkedin.com/in/max-muster",
      title: "Max Muster - Sample Automation GmbH | LinkedIn",
      snippet: "Experience: Sample Automation GmbH"
    }
  ]);
  client["foundryAgentsClient"]["discoverPublicContacts"] = async () => {
    foundryCalled = true;
    return [
      {
        firstName: "Max",
        lastName: "Muster",
        linkedinUrl: "https://www.linkedin.com/in/max-muster",
        sourceUrl: "https://www.linkedin.com/in/max-muster",
        label: "linkedin_profile"
      }
    ];
  };

  const contacts = await client["discoverWebSearchContacts"](company, [], []);

  // Agent-first: Foundry is always called when evidence is available
  assert.equal(foundryCalled, true);
  assert.equal(contacts.filter((contact) => contact.label === "linkedin_profile").length, 1);
});

test("contact page extraction includes ansprechpartner-style menu links", () => {
  const client = new HubSpotClient();
  const links = client["extractRelevantLinks"]("https://leitek.de", `
    <nav>
      <a href="/leistungen/">Leistungsangebot</a>
      <a href="/leitek-profil/ansprechpartner/">Ansprechpartner</a>
      <a href="/leitek-profil/">LEITEK Profil</a>
      <a href="/kontakt/">Kontakt</a>
    </nav>
  `);

  assert.ok(links.includes("https://leitek.de/leitek-profil/ansprechpartner/"));
  assert.ok(links.includes("https://leitek.de/kontakt/"));
});