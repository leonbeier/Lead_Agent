import test from "node:test";
import assert from "node:assert/strict";
import { readiness } from "../../src/config";
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

test("syncQualifiedCompanies reports missing required company properties before live sync", async () => {
  const client = new HubSpotClient();
  const previousHubSpotConfigured = readiness.hubspotConfigured;
  readiness.hubspotConfigured = true;

  try {
    client["requestJson"] = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/crm/v3/properties/companies") && !init?.method) {
        return {
          results: [
            { name: "ai_cc_cold_call_email" },
            { name: "ai_cc_cold_call_linkedin" },
            { name: "ai_cc_category" }
          ]
        };
      }

      if (url.endsWith("/crm/v3/properties/contacts") && !init?.method) {
        return {
          results: [
            { name: "email" },
            { name: "firstname" },
            { name: "lastname" }
          ]
        };
      }

      if (url.includes("/associations/contacts") && init?.method === "GET") {
        return { results: [] };
      }

      if (url.endsWith("/crm/v3/objects/contacts/batch/read") && init?.method === "POST") {
        return { results: [] };
      }

      throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
    };

    client["upsertCompany"] = async () => ({ id: "company-1", properties: {} });

    const result = await client.syncQualifiedCompanies(
      [buildSampleCompany()],
      [buildSampleBrief()],
      new Map(),
      false
    );

    assert.equal(result.companySyncedCount, 1);
    assert.match(result.errors[0] ?? "", /Missing required HubSpot company properties/i);
    assert.match(result.errors[0] ?? "", /ai_cc_email_subject/i);
  } finally {
    readiness.hubspotConfigured = previousHubSpotConfigured;
  }
});

test("syncQualifiedCompanies still creates a company when address lookup fails", async () => {
  const client = new HubSpotClient();
  const previousHubSpotConfigured = readiness.hubspotConfigured;
  readiness.hubspotConfigured = true;

  try {
    client["extractCompanyAddress"] = async () => {
      throw new TypeError("fetch failed");
    };

    client["requestJson"] = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/crm/v3/properties/companies") && !init?.method) {
        return {
          results: [
            { name: "name" },
            { name: "domain" },
            { name: "description" },
            { name: "ai_cc_category" }
          ]
        };
      }

      if (url.endsWith("/crm/v3/properties/contacts") && !init?.method) {
        return { results: [] };
      }

      if (url.endsWith("/crm/v3/objects/companies") && init?.method === "POST") {
        return { id: "company-1", properties: {} };
      }

      if (url.includes("/associations/contacts") && init?.method === "GET") {
        return { results: [] };
      }

      if (url.endsWith("/crm/v3/objects/contacts/batch/read") && init?.method === "POST") {
        return { results: [] };
      }

      throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
    };

    client["searchObject"] = async () => null;

    const result = await client.syncQualifiedCompanies(
      [buildSampleCompany()],
      [buildSampleBrief()],
      new Map(),
      false
    );

    assert.equal(result.companySyncedCount, 1);
    assert.deepEqual(result.failedCompanyKeys, []);
  } finally {
    readiness.hubspotConfigured = previousHubSpotConfigured;
  }
});

test("previewHubSpotSync keeps generic company mailboxes when the email is usable", async () => {
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

  assert.equal(preview.contacts[0]?.skipped, false);
  assert.equal(preview.contacts[0]?.properties.email, "info@sample-automation.de");
  assert.equal(preview.contacts[0]?.properties.firstname, undefined);
  assert.equal(preview.contacts[1]?.properties.firstname, "Martin");
  assert.equal(preview.contacts[1]?.properties.jobtitle, "Managing Director");
  assert.equal(preview.contacts[1]?.properties.hs_linkedin_url, "https://www.linkedin.com/in/martin-minsel");
  assert.match(preview.contacts[1]?.outreachNote ?? "", /LinkedIn Outreach/);
});

test("previewHubSpotSync prefers legal-entity evidence over descriptive page-title company labels", async () => {
  const client = new HubSpotClient();

  const preview = await client.previewHubSpotSync(
    {
      ...buildSampleCompany(),
      name: "Web Development Company in Germany",
      domain: "https://softment.com",
      shortDescription: "Delivery-led software and AI implementation partner.",
      rationale: "Legal entity evidence is Softment GmbH from the supplied research brief."
    },
    {
      ...buildSampleBrief(),
      companyName: "Softment GmbH",
      overview: "Softment GmbH is a Germany-based delivery-led software and AI implementation partner.",
      qualificationSummary: "Softment GmbH executes client delivery projects."
    },
    [],
    { includeAddressLookup: false }
  );

  assert.equal(preview.companyProperties.name, "Softment GmbH");
  assert.equal(preview.companyProperties.domain, "softment.com");
});

test("extractMultipleNamesFromManagementLine ignores management sentence fragments", () => {
  const client = new HubSpotClient();

  assert.deepEqual(
    client["extractMultipleNamesFromManagementLine"]("Management ist verantwortlich langfristigen Unternehmensziele durchzusetzen"),
    []
  );
  assert.deepEqual(
    client["extractMultipleNamesFromManagementLine"]("Geschäftsführung: Max Mustermann"),
    [{ firstName: "Max", lastName: "Mustermann", jobTitle: "Managing Director" }]
  );
});

test("previewHubSpotSync still skips low-value noreply mailboxes without person identity", async () => {
  const client = new HubSpotClient();
  const preview = await client.previewHubSpotSync(
    buildSampleCompany(),
    buildSampleBrief(),
    [
      {
        email: "noreply@sample-automation.de",
        sourceUrl: "https://sample-automation.de/contact",
        label: "public_generic_mailbox"
      }
    ],
    { includeAddressLookup: false }
  );

  assert.equal(preview.contacts[0]?.skipped, true);
  assert.match(preview.contacts[0]?.skipReason ?? "", /Low-value mailbox/i);
});

test("previewHubSpotSync strips company LinkedIn URLs from contact properties", async () => {
  const client = new HubSpotClient();
  const preview = await client.previewHubSpotSync(
    buildSampleCompany(),
    buildSampleBrief(),
    [
      {
        email: "martin@sample-automation.de",
        firstName: "Martin",
        lastName: "Minsel",
        linkedinUrl: "https://www.linkedin.com/company/sample-automation/",
        sourceUrl: "https://sample-automation.de/team",
        label: "website_named_contact"
      }
    ],
    { includeAddressLookup: false }
  );

  assert.equal(preview.contacts[0]?.skipped, false);
  assert.equal(preview.contacts[0]?.properties.hs_linkedin_url, undefined);
  assert.equal(preview.contacts[0]?.properties.email, "martin@sample-automation.de");
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

test("previewHubSpotSync clears false names on generic mailbox contacts without personal LinkedIn", async () => {
  const client = new HubSpotClient();
  const preview = await client.previewHubSpotSync(
    buildSampleCompany(),
    buildSampleBrief(),
    [
      {
        firstName: "Dublin",
        lastName: "Core",
        email: "info@sample-automation.de",
        phone: "+49 89 1234",
        jobTitle: "Managing Director",
        sourceUrl: "https://sample-automation.de/kontakt",
        label: "website_named_contact"
      }
    ],
    { includeAddressLookup: false }
  );

  assert.equal(preview.contacts[0]?.skipped, false);
  assert.equal(preview.contacts[0]?.properties.firstname, undefined);
  assert.equal(preview.contacts[0]?.properties.lastname, undefined);
  assert.equal(preview.contacts[0]?.properties.jobtitle, undefined);
  assert.equal(preview.contacts[0]?.properties.email, "info@sample-automation.de");
  assert.equal(preview.contacts[0]?.properties.phone, "+49 89 1234");
});

test("previewHubSpotSync clears mailbox names that only mirror the company domain", async () => {
  const client = new HubSpotClient();
  const preview = await client.previewHubSpotSync(
    buildSampleCompany(),
    buildSampleBrief(),
    [
      {
        email: "framaval@framaval.com",
        firstName: "Framaval",
        phone: "+34 968 23 29 43",
        jobTitle: "Public contact",
        sourceUrl: "https://framaval.com/contact",
        label: "public_named_mailbox"
      }
    ],
    { includeAddressLookup: false }
  );

  assert.equal(preview.contacts[0]?.skipped, false);
  assert.equal(preview.contacts[0]?.properties.email, "framaval@framaval.com");
  assert.equal(preview.contacts[0]?.properties.firstname, "framaval@framaval.com");
  assert.equal(preview.contacts[0]?.properties.lastname, undefined);
});

test("previewHubSpotSync strips generic CTA job titles from personal contacts", async () => {
  const client = new HubSpotClient();
  const preview = await client.previewHubSpotSync(
    buildSampleCompany(),
    buildSampleBrief(),
    [
      {
        firstName: "Christian",
        lastName: "Hanbauer",
        phone: "+43 3182 490130",
        linkedinUrl: "https://www.linkedin.com/in/christian-hanbauer",
        jobTitle: "Ihre Ansprechpartner",
        sourceUrl: "https://www.linkedin.com/in/christian-hanbauer",
        label: "linkedin_profile"
      }
    ],
    { includeAddressLookup: false }
  );

  assert.equal(preview.contacts[0]?.skipped, false);
  assert.equal(preview.contacts[0]?.properties.firstname, "Christian");
  assert.equal(preview.contacts[0]?.properties.lastname, "Hanbauer");
  assert.equal(preview.contacts[0]?.properties.jobtitle, undefined);
  assert.equal(preview.contacts[0]?.properties.hs_linkedin_url, "https://www.linkedin.com/in/christian-hanbauer");
});

test("previewHubSpotSync skips name-only contacts without a reachable channel", async () => {
  const client = new HubSpotClient();
  const preview = await client.previewHubSpotSync(
    buildSampleCompany(),
    buildSampleBrief(),
    [
      {
        firstName: "Martin",
        lastName: "Peres",
        sourceUrl: "https://octum.de/team",
        label: "website_named_contact"
      }
    ],
    { includeAddressLookup: false }
  );

  assert.equal(preview.contacts[0]?.skipped, true);
  assert.match(preview.contacts[0]?.skipReason ?? "", /no reachable identity/i);
});

test("previewHubSpotSync includes resolved address fields when address lookup is enabled", async () => {
  const client = new HubSpotClient();
  client["extractCompanyAddress"] = async () => ({
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

test("extractPostalAddress rejects sentence-like false positives", () => {
  const client = new HubSpotClient() as unknown as {
    extractPostalAddress: typeof HubSpotClient.prototype["extractPostalAddress"];
  };

  const extracted = client.extractPostalAddress(
    "<div>2015 wurde das Unternehmen mit dem Managementqualitaetszertifikat ISO 9001: 2008,</div><div>12000 Menschen</div>",
    "Germany"
  );

  assert.equal(extracted, null);
});

test("extractCompanyAddressWithWebSearch rejects descriptive non-address results", async () => {
  const client = new HubSpotClient();
  client["openAIWebSearchClient"]["findCompanyAddress"] = async () => ({
    address: "Backed by 14+ years at Salt Technologies with a proven track record in digital transformation.",
    city: "Ahmedabad",
    zip: "380015",
    country: "India"
  });

  const extracted = await client["extractCompanyAddressWithWebSearch"](buildSampleCompany());

  assert.equal(extracted, null);
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
  assert.equal(client["extractNameFromLine"]("Mailen Sie Uns"), null);
});

test("previewHubSpotSync derives personal LinkedIn urls from sourceUrl when linkedinUrl is missing", async () => {
  const client = new HubSpotClient();
  const company = buildSampleCompany();

  const preview = await client.previewHubSpotSync(company, undefined, [
    {
      firstName: "Luca",
      lastName: "Keresztesi",
      sourceUrl: "https://hu.linkedin.com/in/keresztesiluca",
      label: "linkedin_profile"
    }
  ]);

  assert.equal(preview.contacts[0]?.skipped, false);
  assert.equal(preview.contacts[0]?.properties.hs_linkedin_url, "https://hu.linkedin.com/in/keresztesiluca");
});

test("email extraction decodes HTML entity obfuscation", () => {
  const client = new HubSpotClient();
  const emails = client["extractEmails"](
    "<a href=\"mailto:&#105&#110&#102&#111&#64&#103&#101&#111&#116&#116&#46&#100&#101\">Kontakt</a>",
    new Set(["geott.de"])
  );

  assert.deepEqual(emails, ["info@geott.de"]);
});

test("email extraction resolves textual at-dot obfuscation", () => {
  const client = new HubSpotClient();
  const emails = client["extractEmails"](
    "by email: info at giovannigualdi dot com",
    new Set(["giovannigualdi.com"])
  );

  assert.deepEqual(emails, ["info@giovannigualdi.com"]);
});

test("email extraction ignores anti-scrape remove-this placeholders", () => {
  const client = new HubSpotClient();
  const emails = client["extractEmails"](
    "Kontakt: info@remove-this.rottendorf.com | real: info@rottendorf.com",
    new Set(["rottendorf.com"])
  );

  assert.deepEqual(emails, ["info@rottendorf.com"]);
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

test("mergeDiscoveredContacts does not merge unrelated contacts only because they share a source url", () => {
  const client = new HubSpotClient();
  const merged = client["mergeDiscoveredContacts"](
    [{
      firstName: "David",
      lastName: "Fehrenbach",
      email: "contact@preml.io",
      sourceUrl: "https://preml.io/team",
      label: "public_generic_mailbox"
    }],
    [{
      firstName: "Jonas",
      lastName: "Fehrenbach",
      linkedinUrl: "https://www.linkedin.com/in/jonas-fehrenbach-7063641ba",
      sourceUrl: "https://preml.io/team",
      label: "linkedin_profile"
    }]
  );

  assert.equal(merged.length, 2);
  assert.equal(merged.some((contact: PublicContactCandidate) => contact.email === "contact@preml.io" && !contact.linkedinUrl), true);
  assert.equal(merged.some((contact: PublicContactCandidate) => contact.linkedinUrl === "https://www.linkedin.com/in/jonas-fehrenbach-7063641ba" && !contact.email), true);
});

test("name extraction rejects tax and legal fragments as person names", () => {
  const client = new HubSpotClient();

  assert.equal(client["extractNameFromLine"]("UStIdNr. DE 812345678"), null);
  assert.equal(client["extractNameFromLine"]("VAT DE123456789"), null);
});

test("existing generic mailbox contacts clear non-person names during cleanup", () => {
  const client = new HubSpotClient();
  const cleanup = client["buildExistingContactCleanupProperties"]({
    id: "contact-1",
    properties: {
      email: "info@platiscan.com",
      firstname: "Ustidnr",
      lastname: "De"
    }
  }, new Set(["firstname", "lastname", "hs_linkedin_url"]));

  assert.deepEqual(cleanup, {
    firstname: "info@platiscan.com",
    lastname: ""
  });
});

test("existing generic mailbox contacts clear mismatched LinkedIn urls during cleanup", () => {
  const client = new HubSpotClient();
  const cleanup = client["buildExistingContactCleanupProperties"]({
    id: "contact-2",
    properties: {
      email: "contact@preml.io",
      firstname: "David",
      lastname: "Fehrenbach",
      hs_linkedin_url: "https://www.linkedin.com/in/jonas-fehrenbach-7063641ba"
    }
  }, new Set(["firstname", "lastname", "hs_linkedin_url"]));

  assert.deepEqual(cleanup, {
    hs_linkedin_url: ""
  });
});

test("existing generic mailbox contacts clear company LinkedIn urls during cleanup", () => {
  const client = new HubSpotClient();
  const cleanup = client["buildExistingContactCleanupProperties"]({
    id: "contact-2b",
    properties: {
      email: "contact@aidolsgroup.com",
      hs_linkedin_url: "https://www.linkedin.com/company/aidols"
    }
  }, new Set(["firstname", "lastname", "hs_linkedin_url"]));

  assert.deepEqual(cleanup, {
    firstname: "contact@aidolsgroup.com",
    hs_linkedin_url: ""
  });
});

test("existing contacts clear mailbox names derived from the company domain and generic CTA titles during cleanup", () => {
  const client = new HubSpotClient();
  const cleanup = client["buildExistingContactCleanupProperties"]({
    id: "contact-3",
    properties: {
      email: "framaval@framaval.com",
      firstname: "Framaval",
      lastname: "",
      jobtitle: "Ihre Ansprechpartner"
    }
  }, new Set(["firstname", "lastname", "jobtitle"]));

  assert.deepEqual(cleanup, {
    firstname: "framaval@framaval.com",
    lastname: "",
    jobtitle: ""
  });
});

test("existing generic mailbox contacts clear stale person job titles during cleanup", () => {
  const client = new HubSpotClient();
  const cleanup = client["buildExistingContactCleanupProperties"]({
    id: "contact-4",
    properties: {
      email: "info@lanz.ai",
      firstname: "",
      lastname: "",
      jobtitle: "Managing Director"
    }
  }, new Set(["jobtitle"]));

  assert.deepEqual(cleanup, {
    jobtitle: ""
  });
});

test("existing contacts clear placeholder unknown job titles during cleanup", () => {
  const client = new HubSpotClient();
  const cleanup = client["buildExistingContactCleanupProperties"]({
    id: "contact-4b",
    properties: {
      firstname: "Jennifer",
      lastname: "Heinz",
      jobtitle: "Unknown"
    }
  }, new Set(["jobtitle"]));

  assert.deepEqual(cleanup, {
    jobtitle: ""
  });
});

test("descriptive company labels reject LinkedIn hits that do not mention the domain token", () => {
  const client = new HubSpotClient();
  const relevant = client["isRelevantCompanyHit"](
    {
      name: "Intelligent Machine Vision for Industrial Marking Vision AI",
      domain: "https://geott.de"
    },
    ["Geott"],
    "Nicolas March | LinkedIn | AI4Robotics machine vision founder"
  );

  const domainMatched = client["isRelevantCompanyHit"](
    {
      name: "Intelligent Machine Vision for Industrial Marking Vision AI",
      domain: "https://geott.de"
    },
    ["Geott"],
    "Marcus Lessmann | LinkedIn | GEOTT Deutschland machine vision"
  );

  assert.equal(relevant, false);
  assert.equal(domainMatched, true);
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

test("browser fallback ignores HTTPS errors for certificate-broken contact pages", async () => {
  const client = new HubSpotClient();
  let receivedNewPageOptions: Record<string, unknown> | null = null;

  client["launchBrowserForWebTasks"] = async () => ({
    newPage: async (options: Record<string, unknown>) => {
      receivedNewPageOptions = options;
      return {
        goto: async () => undefined,
        waitForLoadState: async () => undefined,
        content: async () => "<html><body><a href=\"mailto:info@sample-automation.de\">info@sample-automation.de</a></body></html>"
      };
    },
    close: async () => undefined
  });

  const html = await client["fetchHtmlWithBrowser"]("https://expired.example.com/kontakt");

  assert.match(html ?? "", /info@sample-automation\.de/i);
  assert.equal(receivedNewPageOptions?.ignoreHTTPSErrors, true);
});

test("fetchHtml retries TLS failures with a certificate-tolerant dispatcher before browser fallback", async () => {
  const client = new HubSpotClient();
  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;
  let browserFallbackCalled = false;

  client["fetchHtmlWithBrowser"] = async () => {
    browserFallbackCalled = true;
    return "<html><body>browser fallback</body></html>";
  };

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit & { dispatcher?: unknown }) => {
    fetchCallCount += 1;
    if (fetchCallCount === 1) {
      const error = new TypeError("fetch failed");
      (error as TypeError & { cause?: { code?: string } }).cause = { code: "ERR_TLS_CERT_ALTNAME_INVALID" };
      throw error;
    }

    assert.ok(init?.dispatcher);
    return new Response("<html><body><a href=\"mailto:tls@sample-automation.de\">tls@sample-automation.de</a></body></html>", {
      status: 200,
      headers: {
        "content-type": "text/html"
      }
    }) as typeof fetch extends (...args: any[]) => infer T ? Awaited<T> : never;
  }) as typeof fetch;

  try {
    const html = await client["fetchHtml"]("https://tls-broken.example.com");

    assert.match(html ?? "", /tls@sample-automation\.de/i);
    assert.equal(browserFallbackCalled, false);
    assert.equal(fetchCallCount, 2);
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

test("requestJson retries transient fetch failures before succeeding", async () => {
  const client = new HubSpotClient();
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = async () => {
    attempts += 1;

    if (attempts < 3) {
      throw new TypeError("fetch failed");
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    }) as typeof fetch extends (...args: any[]) => infer T ? Awaited<T> : never;
  };

  try {
    const response = await client["requestJson"]<{ ok: boolean }>("https://api.hubapi.com/test");

    assert.deepEqual(response, { ok: true });
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("website contact filter rejects management sentence-fragment names", () => {
  const client = new HubSpotClient();

  assert.equal(client["isLowConfidenceWebsiteNamedContact"]({
    firstName: "Ist",
    lastName: "Verantwortlich",
    phone: "+4949434059620",
    jobTitle: "Managing Director",
    sourceUrl: "http://atlantique-gmbh.de/ueber-uns/",
    label: "website_named_contact"
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

  client["openAIWebSearchClient"]["crawlCompanyWebsite"] = async () => ({
    summary: "Official site summary",
    landingUrl: "https://sample-automation.de",
    relevantUrls: ["https://sample-automation.de/kontakt"]
  });
  client["fetchHtml"] = async (url: string) => {
    if (/\/kontakt$/i.test(url)) {
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
    }]
  );

  assert.equal(contacts.length, 1);
  assert.equal(contacts[0]?.firstName, "Martin");
  assert.equal(contacts[0]?.email, "martin.minsel@sample-automation.de");
  assert.equal(contacts[0]?.linkedinUrl, "https://www.linkedin.com/in/martin-minsel");
});

test("debugPublicContactDiscovery falls back to website contacts when Azure contact extraction fails", async () => {
  const client = new HubSpotClient();
  const company = buildSampleCompany();

  client["collectCandidatePages"] = async () => ([{
    url: "https://sample-automation.de/kontakt",
    html: '<html><body><a href="mailto:info@sample-automation.de">info@sample-automation.de</a><a href="tel:+4930123456">+49 30 123456</a></body></html>'
  }]);
  client["extractAzureMatchedContacts"] = async () => {
    throw new Error("Azure public-contact extraction failed");
  };
  client["discoverWebSearchContacts"] = async () => {
    throw new Error("web search failed");
  };

  const result = await client.debugPublicContactDiscovery(company, { selectedContactsTimeoutMs: 1000 });

  assert.equal(result.heuristicContacts.length, 0);
  assert.ok(result.selectedContacts.some((contact) => contact.email === "info@sample-automation.de"));
  assert.ok(result.selectedContacts.some((contact) => contact.phone === "+4930123456"));
});

test("findPublicContactsFromPages falls back to website contacts when heuristic web search fails", async () => {
  const client = new HubSpotClient();
  const company = buildSampleCompany();

  client["extractAzureMatchedContacts"] = async () => ({ queries: [], hitGroups: [], contacts: [] });
  client["discoverWebSearchContacts"] = async () => {
    throw new Error("bing failed");
  };

  const contacts = await client["findPublicContactsFromPages"](
    company,
    [{
      url: "https://sample-automation.de/kontakt",
      html: '<html><body><a href="mailto:info@sample-automation.de">info@sample-automation.de</a><a href="tel:+4930123456">+49 30 123456</a></body></html>'
    }]
  );

  assert.ok(contacts.some((contact) => contact.email === "info@sample-automation.de"));
  assert.ok(contacts.some((contact) => contact.phone === "+4930123456"));
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

  client["openAIWebSearchClient"]["crawlCompanyWebsite"] = async () => ({
    summary: "Official site summary",
    landingUrl: "https://sample-automation.de",
    relevantUrls: ["https://sample-automation.de/kontakt/"]
  });
  client["fetchHtml"] = async (url: string) => {
    if (/\/kontakt\/$/i.test(url)) {
      return "<html><body>Please verify you are human</body></html>";
    }

    return null;
  };
  client["openAIWebSearchClient"]["fetchOfficialWebsitePageHtml"] = async (url: string) => {
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

test("findPublicContacts adds official website email and phone from web search when HTML pages are blocked", async () => {
  const client = new HubSpotClient();
  const company = buildSampleCompany();

  client["collectCandidatePages"] = async () => [];
  client["extractAzureMatchedContacts"] = async () => ({ queries: [], hitGroups: [], contacts: [] });
  client["openAIWebSearchClient"]["findCompanyContactInfo"] = async () => ({
    emails: ["info@sample-automation.de"],
    phones: ["+49 30 123456"],
    urls: ["https://sample-automation.de/kontakt"]
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

test("discoverWebSearchContacts skips foundry when LinkedIn heuristics already provide enough contacts", async () => {
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
    },
    {
      query: `${company.name} site:linkedin.com/in`,
      url: "https://www.linkedin.com/in/anna-muster",
      title: "Anna Muster - Sample Automation GmbH | LinkedIn",
      snippet: "Experience: Sample Automation GmbH"
    },
    {
      query: `${company.name} site:linkedin.com/in`,
      url: "https://www.linkedin.com/in/paul-muster",
      title: "Paul Muster - Sample Automation GmbH | LinkedIn",
      snippet: "Experience: Sample Automation GmbH"
    },
    {
      query: `${company.name} site:linkedin.com/in`,
      url: "https://www.linkedin.com/in/lisa-muster",
      title: "Lisa Muster - Sample Automation GmbH | LinkedIn",
      snippet: "Experience: Sample Automation GmbH"
    }
  ]);
  client["foundryAgentsClient"]["discoverPublicContacts"] = async () => {
    foundryCalled = true;
    return [
    {
      email: "info@sample-automation.de",
      phone: "+49 30 123456",
      sourceUrl: "https://sample-automation.de/kontakt",
      label: "public_generic_mailbox"
    }
    ];
  };

  const contacts = await client["discoverWebSearchContacts"](company, [], []);

  assert.equal(foundryCalled, false);
  assert.equal(contacts.filter((contact) => contact.label === "linkedin_profile").length, 4);
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