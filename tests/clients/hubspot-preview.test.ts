import test from "node:test";
import assert from "node:assert/strict";
import { HubSpotClient, isPlausibleCompanyName, looksLikeHexOrUuidSlug } from "../../src/clients/hubspot";
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
  // The company description must be AI-written (research brief), not a heuristic concatenation of
  // the parsed website shortDescription. When a non-fallback brief has an overview, the description
  // is the AI overview (+ qualification summary) verbatim.
  assert.match(preview.companyProperties.description, /Overview/);
  assert.match(preview.companyProperties.description, /Strong industrial delivery fit/);
  assert.doesNotMatch(preview.companyProperties.description, /Industrial automation and PLC integration/i);
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

test("previewHubSpotSync never writes a company LinkedIn URL to a contact, even when malformed/concatenated", async () => {
  const client = new HubSpotClient();
  const contacts: PublicContactCandidate[] = [
    {
      email: "info@4h-jena.de",
      firstName: "Michael",
      lastName: "Boer",
      jobTitle: "Managing Director",
      // Malformed value observed in production: a company URL concatenated onto a base host.
      linkedinUrl: "http://www.linkedin.com/https://www.linkedin.com/company/-4h--jena-engineering-gmbh",
      sourceUrl: "https://4h-jena.de/contact",
      label: "linkedin_profile"
    },
    {
      email: "info@example-automation.de",
      firstName: "Jana",
      lastName: "Klein",
      jobTitle: "CTO",
      linkedinUrl: "https://www.linkedin.com/company/example-automation",
      sourceUrl: "https://example-automation.de/team",
      label: "linkedin_profile"
    }
  ];

  const preview = await client.previewHubSpotSync(buildSampleCompany(), buildSampleBrief(), contacts, { includeAddressLookup: false });

  // The malformed/concatenated company URL must be dropped, not written as a personal LinkedIn URL.
  assert.equal(preview.contacts[0]?.properties.hs_linkedin_url, undefined);
  // A plain company LinkedIn URL must also be dropped.
  assert.equal(preview.contacts[1]?.properties.hs_linkedin_url, undefined);
});

test("previewHubSpotSync prefers the per-person personalized outreach message in the contact note", async () => {
  const client = new HubSpotClient();
  const contacts: PublicContactCandidate[] = [
    {
      email: "martin@sample-automation.de",
      firstName: "Martin",
      lastName: "Minsel",
      jobTitle: "Managing Director",
      linkedinUrl: "https://www.linkedin.com/in/martin-minsel/",
      sourceUrl: "https://www.linkedin.com/in/martin-minsel/",
      label: "linkedin_profile",
      personalizedOutreach: {
        message: "Hallo Martin, ich habe gesehen dass ihr PLC-integrierte Vision-Systeme baut. Das hat mich an einen Kunden erinnert, bei dem ein Modell genau auf die Anwendung angepasst wurde.",
        language: "de",
        confidence: "high"
      }
    }
  ];

  const preview = await client.previewHubSpotSync(buildSampleCompany(), buildSampleBrief(), contacts, { includeAddressLookup: false });
  const note = preview.contacts[0]?.outreachNote ?? "";

  // The individual per-person message must be used in the contact note.
  assert.match(note, /Hallo Martin, ich habe gesehen dass ihr PLC-integrierte Vision-Systeme baut/);
  // The generic brief LinkedIn/email body must NOT be used when a personalized message is present.
  assert.doesNotMatch(note, /wir helfen Integratoren, Vision-AI schneller produktiv/);
  assert.doesNotMatch(note, /produktionsreifen Vision-AI-Deployments/);
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

test("extractEmails does not glue adjacent page text onto an address split by markup", () => {
  const client = new HubSpotClient();
  const emails = client["extractEmails"](`
    <html>
      <body>
        <a href="#">info@specim.com</a><h3>Press</h3>
        <div>Geschäftsführer: <b>Takayuki Mukai</b> CEO <span>takayuki.mukai@specim.com</span></div>
        <p>orders@specim.com</p>
      </body>
    </html>
  `, new Set(["specim.com"]));

  // Tags are stripped with a space so the TLD match stops at the address boundary instead of
  // absorbing trailing words ("info@specim.compress…") or leading words ("…mukaiceotakayuki…").
  assert.ok(emails.includes("info@specim.com"));
  assert.ok(emails.includes("takayuki.mukai@specim.com"));
  assert.ok(emails.includes("orders@specim.com"));
  assert.ok(
    emails.every((email) => /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(email)),
    `corrupted email present: ${emails.join(", ")}`
  );
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

test("previewHubSpotSync falls back to the domain-derived name when extraction fails and the source name is a generic web label", async () => {
  const client = new HubSpotClient();
  // Simulate website extraction failing under load (no company name resolved).
  client["extractCompanyAddress"] = async () => null;

  const preview = await client.previewHubSpotSync({
    ...buildSampleCompany(),
    name: "Mail",
    domain: "https://interelectronic.com"
  }, buildSampleBrief(), [], { includeAddressLookup: true });

  // "Mail" is a generic navigation/UI label, never a real operating-entity name, so it must not
  // be written as the record name; the readable domain-derived name is used instead.
  assert.equal(preview.companyProperties.name, "Interelectronic");
});

test("previewHubSpotSync falls back to the domain-derived name when the source name is a template placeholder like 'OUR COMPANY'", async () => {
  const client = new HubSpotClient();
  client["extractCompanyAddress"] = async () => null;

  const preview = await client.previewHubSpotSync({
    ...buildSampleCompany(),
    name: "OUR COMPANY",
    domain: "https://abcvision.info"
  }, buildSampleBrief(), [], { includeAddressLookup: true });

  // "OUR COMPANY" is a CMS template placeholder, never a real operating-entity name.
  assert.equal(preview.companyProperties.name, "Abcvision");
});

test("previewHubSpotSync falls back to the domain-derived name when the source name is a bare fragment like 'De'", async () => {
  const client = new HubSpotClient();
  client["extractCompanyAddress"] = async () => null;

  const preview = await client.previewHubSpotSync({
    ...buildSampleCompany(),
    name: "De",
    domain: "https://writepcb.com"
  }, buildSampleBrief(), [], { includeAddressLookup: true });

  // "De" is a bare language/country fragment captured from a subdomain, not a company name.
  assert.equal(preview.companyProperties.name, "Writepcb");
});

test("looksLikeHexOrUuidSlug flags machine slugs but keeps real brand names", () => {
  // Wix asset-id subdomain turned into a "name" — the exact junk record we must reject.
  assert.equal(looksLikeHexOrUuidSlug("489f595f 6891 49a9 b5fc 6a83ba5b0317"), true);
  assert.equal(looksLikeHexOrUuidSlug("489f595f-6891-49a9-b5fc-6a83ba5b0317"), true);
  assert.equal(looksLikeHexOrUuidSlug("deadbeef1234"), true);

  // Real names contain a non-hex token or no digits and must stay usable.
  assert.equal(looksLikeHexOrUuidSlug("Sample Automation GmbH"), false);
  assert.equal(looksLikeHexOrUuidSlug("3D Systems"), false);
  assert.equal(looksLikeHexOrUuidSlug("C3 AI"), false);
  assert.equal(looksLikeHexOrUuidSlug("Facade"), false);
  assert.equal(looksLikeHexOrUuidSlug(undefined), false);
});

test("isPlausibleCompanyName rejects hex/UUID slugs", () => {
  assert.equal(isPlausibleCompanyName("489f595f 6891 49a9 b5fc 6a83ba5b0317"), false);
  assert.equal(isPlausibleCompanyName("Sample Automation GmbH"), true);
});

test("previewHubSpotSync never adopts a UUID host slug as the company name", async () => {
  const client = new HubSpotClient();
  client["extractCompanyAddress"] = async () => null;

  const preview = await client.previewHubSpotSync({
    ...buildSampleCompany(),
    name: "Mail",
    domain: "https://489f595f-6891-49a9-b5fc-6a83ba5b0317.filesusr.com"
  }, buildSampleBrief(), [], { includeAddressLookup: true });

  // The UUID domain label (a Wix asset id) must never be turned into a "company name" via the
  // domain-derived fallback.
  assert.equal(looksLikeHexOrUuidSlug(preview.companyProperties.name), false);
});

test("previewHubSpotSync falls back to the domain-derived name when extraction returns anti-bot block text", async () => {
  const client = new HubSpotClient();
  // A blocked crawl returns the access-challenge page text instead of a real company name.
  client["extractCompanyAddress"] = async () => ({
    companyName: "sorry, but your current behavior is detected as"
  });

  const preview = await client.previewHubSpotSync({
    ...buildSampleCompany(),
    // Worker overwrote the sourcing name with the same anti-bot text before the HubSpot write.
    name: "sorry, but your current behavior is detected as",
    domain: "https://mt.com"
  }, buildSampleBrief(), [], { includeAddressLookup: true });

  // Anti-bot block-page text must never be written as a company name; fall back to the domain.
  assert.equal(preview.companyProperties.name, "Mt");
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

test("upsertContact drops a generic-only mailbox by default but keeps it as sole-contact fallback", async () => {
  const client = new HubSpotClient();
  const originalFetch = globalThis.fetch;
  client["findExistingContact"] = async () => null;

  let posted = false;
  globalThis.fetch = async () => {
    posted = true;
    return new Response(JSON.stringify({ id: "contact-generic", properties: {} }), {
      status: 201,
      headers: { "content-type": "application/json" }
    }) as typeof fetch extends (...args: any[]) => infer T ? Awaited<T> : never;
  };

  try {
    const generic = { email: "info@core-systems.cz", label: "public_generic_mailbox" };
    const props = new Set(["email", "firstname", "lastname"]);

    // Default: a nameless generic mailbox is dropped when richer contacts exist elsewhere.
    const dropped = await client["upsertContact"](generic, props, "company-1");
    assert.equal(dropped, null);
    assert.equal(posted, false);

    // Fallback: when it is the company's ONLY reachable contact it must still be written.
    const kept = await client["upsertContact"](generic, props, "company-1", true);
    assert.equal(kept?.id, "contact-generic");
    assert.equal(posted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("companyExistsInHubSpot matches a www-stored domain that bare-domain intake missed", async () => {
  const client = new HubSpotClient();
  const queried: Array<{ property: string; value: string }> = [];
  // Simulate a HubSpot record stored as "www.satvision.es": only that exact variant matches.
  client["searchObject"] = (async (_objectType: string, propertyName: string, value: string) => {
    queried.push({ property: propertyName, value });
    return propertyName === "domain" && value === "www.satvision.es"
      ? ({ id: "company-existing", properties: {} } as any)
      : null;
  }) as any;

  const exists = await client.companyExistsInHubSpot({ name: "Satvision", domain: "satvision.es" });
  assert.equal(exists, true);
  // It must have probed beyond the bare domain form (the gap that let duplicates through).
  assert.ok(queried.some((q) => q.value === "www.satvision.es"));
});

test("companyExistsInHubSpot matches a subsidiary to its parent brand by name", async () => {
  const client = new HubSpotClient();
  const queried: string[] = [];
  // No domain match (keyence.fr != keyence.com); only the brand-root name "KEYENCE" exists.
  client["searchObject"] = (async (_objectType: string, propertyName: string, value: string) => {
    queried.push(`${propertyName}:${value}`);
    return propertyName === "name" && value === "KEYENCE"
      ? ({ id: "company-keyence", properties: {} } as any)
      : null;
  }) as any;

  const exists = await client.companyExistsInHubSpot({ name: "KEYENCE FRANCE SAS", domain: "keyence.fr" });
  assert.equal(exists, true);
  assert.ok(queried.includes("name:KEYENCE"), `expected brand-root name search, got ${queried.join(", ")}`);
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

test("TLS handshake detection gates the http:// fallback to real cipher rejections only", () => {
  const client = new HubSpotClient();
  const isTls = (error: unknown) => client["isTlsHandshakeError"](error);

  // Real handshake rejections (the only case where retrying over http:// can succeed).
  const cipherError = new TypeError("fetch failed");
  (cipherError as { cause?: unknown }).cause = Object.assign(new Error("write EPROTO ... ssl3_read_bytes"), {
    code: "EPROTO"
  });
  assert.equal(isTls(cipherError), true);
  assert.equal(isTls(new Error("ERR_SSL_VERSION_OR_CIPHER_MISMATCH")), true);
  assert.equal(isTls(new Error("ERR_CERT_AUTHORITY_INVALID")), true);

  // Ordinary failures (404/DNS/timeout) must NOT trigger the http:// retry, otherwise every dead
  // follow-up URL would double the fetch cost and saturate the run over the two browser lanes.
  assert.equal(isTls(new Error("HTTP 404 Not Found")), false);
  assert.equal(isTls(Object.assign(new Error("getaddrinfo ENOTFOUND example.com"), { code: "ENOTFOUND" })), false);
  assert.equal(isTls(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })), false);
  assert.equal(isTls(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })), false);
});

test("role-adjacent snippet extraction stays linear on long punctuation-sparse pages", () => {
  const client = new HubSpotClient();
  const extract = (text: string) => client["extractRoleAdjacentSnippets"](text) as string[];

  // A pathological page: a very long run of non-sentence-punctuation characters that previously
  // forced the `[^.!?]{0,120}(?:role)[^.!?]{0,120}` matchAll to backtrack at every start position,
  // pinning the event loop for minutes. It must now complete near-instantly. The role keyword sits
  // near the front so it is within the bounded scan window.
  const filler = "geschaeftsfuehrung kontakt team ".repeat(4000); // ~128k chars, no .!?
  const pathological = `Managing Director Jane Doe leads us. ${filler}`;
  const start = Date.now();
  const snippets = extract(pathological);
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 1000, `role-adjacent scan took ${elapsedMs}ms (expected < 1000ms)`);
  assert.ok(snippets.length >= 1);
  assert.ok(snippets.some((snippet) => /Managing Director/i.test(snippet)));

  // Normal page: still returns readable role context windows.
  const normal = "We are a robotics firm. Our Geschäftsführer Max Mustermann leads the team. Contact us today.";
  const normalSnippets = extract(normal);
  assert.ok(normalSnippets.some((snippet) => /Gesch\u00e4ftsf\u00fchrer Max Mustermann/.test(snippet)));
});

test("boundHtmlForProcessing caps oversized pages while keeping head and footer evidence", () => {
  const client = new HubSpotClient();
  const bound = (html: string) => client["boundHtmlForProcessing"](html) as string;

  // A small page passes through unchanged.
  const small = "<html><body><main>Impressum: Beispiel Technik GmbH</main><footer>© 2026 Beispiel Technik GmbH</footer></body></html>";
  assert.equal(bound(small), small);

  // A multi-megabyte page (e.g. minified site with huge inline CSS/JS) is capped to a bounded
  // working set so every downstream synchronous full-HTML pass stays O(cap). The head (main
  // content / impressum) and the tail (footer / © legal-entity line) must both survive so the
  // agent never loses the legal entity. This is the core "page always reachable under load" guard:
  // an unbounded page previously let a single synchronous map over crawled pages pin the event loop.
  const headMarker = "<main>Impressum: Beispiel Technik GmbH, Musterstraße 1, 12345 Musterstadt</main>";
  const footerMarker = "<footer>© 2026 Beispiel Technik GmbH</footer>";
  const filler = "<div class=\"x-very-long-class-name-without-keyword-aaaaaaaaaaaaaaaaaaaa\"><span>n</span></div>".repeat(40000);
  const huge = `<html><body>${headMarker}${filler}${footerMarker}</body></html>`;
  assert.ok(huge.length > 2_000_000, "fixture should be multi-MB");

  const start = Date.now();
  const bounded = bound(huge);
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 500, `bounding took ${elapsedMs}ms (expected < 500ms)`);
  assert.ok(bounded.length < 260_000, `bounded length ${bounded.length} should be well under the raw size`);
  assert.ok(bounded.includes("Impressum: Beispiel Technik GmbH"), "head/impressum evidence must survive");
  assert.ok(bounded.includes(footerMarker), "footer / legal-entity line must survive");

  // Building the evidence snippet on the bounded page must stay fast regardless of raw page size.
  const snippetStart = Date.now();
  const snippet = client["buildWebsiteEvidenceSnippet"]("https://example.com/impressum", bounded) as string;
  const snippetMs = Date.now() - snippetStart;
  assert.ok(snippetMs < 1000, `snippet build took ${snippetMs}ms (expected < 1000ms)`);
  assert.ok(snippet.includes("Beispiel Technik GmbH"), "snippet must still expose the legal entity");
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

test("discoverWebSearchContacts recovers a /in/ profile when foundry returns named contacts without LinkedIn", async () => {
  const client = new HubSpotClient();
  const company = buildSampleCompany();

  client["foundryAgentsClient"]["suggestPublicContactQueries"] = async () => [];
  // The supplementary people-search surfaced a real personal /in/ profile...
  client["searchBingResults"] = async () => ([
    {
      query: `${company.name} site:linkedin.com/in`,
      url: "https://www.linkedin.com/in/jane-doe-automation",
      title: "Jane Doe - Head of Engineering at Sample Automation GmbH | LinkedIn",
      snippet: "Sample Automation GmbH - Head of Engineering"
    }
  ]);
  // ...but Foundry returned only a website-named person WITHOUT any /in/ LinkedIn URL (the exact
  // live failure mode: "foundry returned N contacts, 0 with /in/ LinkedIn").
  client["foundryAgentsClient"]["discoverPublicContacts"] = async () => ([
    {
      firstName: "Tom",
      lastName: "Webmaster",
      jobTitle: "Contact",
      sourceUrl: "https://sample-automation.de/team",
      label: "website_named_contact"
    }
  ]);
  // The Azure evidence extractor, run on the SAME already-collected evidence, recovers the /in/ profile.
  client["azureOpenAIClient"]["extractPublicContactsFromEvidence"] = async () => ([
    {
      firstName: "Jane",
      lastName: "Doe",
      jobTitle: "Head of Engineering",
      linkedinUrl: "https://www.linkedin.com/in/jane-doe-automation",
      sourceUrl: "https://www.linkedin.com/in/jane-doe-automation",
      label: "linkedin_profile"
    }
  ]);

  const contacts = await client["discoverWebSearchContacts"](company, [], []);

  // The personal /in/ LinkedIn profile that existed in the search evidence must survive instead of
  // being discarded just because Foundry returned a non-empty (but LinkedIn-less) contact list.
  assert.ok(
    contacts.some((contact) => /\/in\//i.test(contact.linkedinUrl ?? "")),
    "A personal /in/ LinkedIn profile present in the evidence must be recovered"
  );
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

test("plain-only fetch does not retry a hard-blocked guessed path in the serialized browser", async () => {
  const client = new HubSpotClient();
  const originalFetch = globalThis.fetch;
  let browserFallbackCalls = 0;

  // A guessed contact path that hard-blocks plain fetch (403). With allowBrowserRetry=false the
  // expensive serialized-browser retry must be skipped so a blocked site cannot saturate the
  // single Chromium lane for the whole run.
  globalThis.fetch = async () => new Response("403 - Forbidden", {
    status: 403,
    headers: {
      "content-type": "text/html"
    }
  }) as typeof fetch extends (...args: any[]) => infer T ? Awaited<T> : never;
  client["fetchHtmlWithBrowser"] = async () => {
    browserFallbackCalls += 1;
    return "<html><body>unexpected browser fallback</body></html>";
  };

  try {
    const html = await client["fetchHtml"]("https://pexon-consulting.de/impressum/", false);
    assert.equal(html, null);
    assert.equal(browserFallbackCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("plain-only fetch still returns a usable page when the guessed path is not blocked", async () => {
  const client = new HubSpotClient();
  const originalFetch = globalThis.fetch;
  let browserFallbackCalls = 0;

  globalThis.fetch = async () => new Response(
    "<html><body><a href=\"mailto:info@pexon-consulting.de\">info@pexon-consulting.de</a></body></html>",
    { status: 200, headers: { "content-type": "text/html" } }
  ) as typeof fetch extends (...args: any[]) => infer T ? Awaited<T> : never;
  client["fetchHtmlWithBrowser"] = async () => {
    browserFallbackCalls += 1;
    return "<html><body>unexpected browser fallback</body></html>";
  };

  try {
    const html = await client["fetchHtml"]("https://pexon-consulting.de/impressum/", false);
    assert.match(html ?? "", /info@pexon-consulting\.de/i);
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

test("normalizeContactForHubSpot drops a company-LinkedIn-only placeholder with no usable channel", () => {
  const client = new HubSpotClient();

  // Company LinkedIn page emitted as a "fallback" person: the company name is split into
  // first/last name, the only LinkedIn evidence is a /company/ page (stripped during
  // normalization), and there is no email or phone. This must be rejected, never written as a
  // person contact (AGENTS.md: no company-LinkedIn-only placeholders, no channel-less contacts).
  const companyLinkedInPlaceholder: PublicContactCandidate = {
    firstName: "Krones",
    lastName: "Ag",
    linkedinUrl: "https://www.linkedin.com/company/krones",
    sourceUrl: "https://www.linkedin.com/company/krones",
    label: "linkedin_profile",
    jobTitle: "Company LinkedIn Page"
  };
  assert.equal(client["normalizeContactForHubSpot"](companyLinkedInPlaceholder), null);

  // A name-only contact with no reachable channel is likewise dropped.
  const nameOnly: PublicContactCandidate = {
    firstName: "Jane",
    lastName: "Doe",
    sourceUrl: "https://example.com/team",
    label: "website_named_contact"
  };
  assert.equal(client["normalizeContactForHubSpot"](nameOnly), null);

  // Contacts that carry a usable channel (email, phone, or personal /in/ LinkedIn) are kept.
  const withEmail: PublicContactCandidate = {
    email: "info@example.com",
    sourceUrl: "https://example.com/kontakt",
    label: "public_generic_mailbox"
  };
  assert.ok(client["normalizeContactForHubSpot"](withEmail));

  const withPhoneOnly: PublicContactCandidate = {
    firstName: "Max",
    lastName: "Mustermann",
    phone: "+49 30 123456",
    sourceUrl: "https://example.com/impressum",
    label: "website_named_contact"
  };
  assert.ok(client["normalizeContactForHubSpot"](withPhoneOnly));

  const withPersonalLinkedIn: PublicContactCandidate = {
    firstName: "Erika",
    lastName: "Beispiel",
    linkedinUrl: "https://www.linkedin.com/in/erika-beispiel",
    sourceUrl: "https://www.linkedin.com/in/erika-beispiel",
    label: "linkedin_profile"
  };
  assert.ok(client["normalizeContactForHubSpot"](withPersonalLinkedIn));
});

test("normalizeContactForHubSpot infers a missing person name from a structured personal email", () => {
  const client = new HubSpotClient();

  // Live failure mode (2026-06-23): the Foundry/Azure discovery agent returned a structured
  // personal mailbox (first.last@company) but left firstName/lastName empty, so the contact was
  // written to HubSpot with an empty name (gate badNames). When the email itself encodes a clear
  // two-token person name, derive it at the write boundary instead of storing a nameless contact.
  const namelessPersonalEmail: PublicContactCandidate = {
    email: "gabor.ozsvath@elas.hu",
    sourceUrl: "https://elas.hu/kontakt",
    label: "public_named_mailbox"
  };
  const normalized = client["normalizeContactForHubSpot"](namelessPersonalEmail);
  assert.ok(normalized);
  assert.equal(normalized?.firstName, "Gabor");
  assert.equal(normalized?.lastName, "Ozsvath");

  // A generic role mailbox must NOT receive an inferred person name.
  const genericMailbox: PublicContactCandidate = {
    email: "info@elas.hu",
    sourceUrl: "https://elas.hu/kontakt",
    label: "public_generic_mailbox"
  };
  const normalizedGeneric = client["normalizeContactForHubSpot"](genericMailbox);
  assert.ok(normalizedGeneric);
  assert.equal(normalizedGeneric?.firstName, undefined);
  assert.equal(normalizedGeneric?.lastName, undefined);

  // A single-token mailbox (no reliable first/last split) stays nameless rather than guessing.
  const singleTokenMailbox: PublicContactCandidate = {
    email: "elas@elas.hu",
    sourceUrl: "https://elas.hu/kontakt",
    label: "public_named_mailbox"
  };
  const normalizedSingle = client["normalizeContactForHubSpot"](singleTokenMailbox);
  assert.ok(normalizedSingle);
  assert.equal(normalizedSingle?.firstName, undefined);
  assert.equal(normalizedSingle?.lastName, undefined);

  // An agent-supplied explicit name is never overwritten by email inference.
  const explicitName: PublicContactCandidate = {
    firstName: "Stephan",
    lastName: "Eirich",
    email: "gabor.ozsvath@elas.hu",
    sourceUrl: "https://elas.hu/kontakt",
    label: "public_named_mailbox"
  };
  const normalizedExplicit = client["normalizeContactForHubSpot"](explicitName);
  assert.ok(normalizedExplicit);
  assert.equal(normalizedExplicit?.firstName, "Stephan");
  assert.equal(normalizedExplicit?.lastName, "Eirich");
});

test("isLowValueMailbox filters privacy/data-protection role inboxes", () => {
  const client = new HubSpotClient();

  // Privacy/data-protection inboxes are role mailboxes, never an outreach person. "datenschutz"
  // (German) and "privacy" were already filtered; the French/abbreviated equivalents leaked through
  // and were written as nameless contacts (live 2026-06-24: rgpd@kestrel-vision.com).
  for (const email of [
    "rgpd@kestrel-vision.com",
    "gdpr@example.com",
    "dsgvo@example.de",
    "dpo@example.com",
    "privacy@example.com",
    "datenschutz@example.de"
  ]) {
    assert.equal(client["isLowValueMailbox"](email), true, `${email} should be low-value`);
  }

  // Real outreach mailboxes must not be filtered as low-value.
  for (const email of ["info@example.com", "max.mustermann@example.com", "sales@example.com"]) {
    assert.equal(client["isLowValueMailbox"](email), false, `${email} should not be low-value`);
  }
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

test("enrichSelectedContactsWithLinkedIn fills a missing personal LinkedIn URL for a named contact via web search", async () => {
  const client = new HubSpotClient();
  const company = buildSampleCompany();

  // Stub the (free Bing/DDG) search path so the test is deterministic and offline.
  client["searchBingResults"] = async (query: string) => {
    if (/adam tabor/i.test(query)) {
      return [{ url: "https://www.linkedin.com/in/adam-tabor", title: "Adam Tabor", snippet: "CEO", query }];
    }
    return [];
  };

  const contacts: PublicContactCandidate[] = [
    {
      firstName: "Adam",
      lastName: "Tabor",
      jobTitle: "CEO",
      sourceUrl: "https://sample-automation.de",
      label: "website_named_contact"
    }
  ];

  const enriched = await client["enrichSelectedContactsWithLinkedIn"](company, contacts);

  assert.equal(enriched.length, 1);
  assert.equal(enriched[0]?.linkedinUrl, "https://www.linkedin.com/in/adam-tabor");
});

test("enrichSelectedContactsWithLinkedIn leaves contacts unchanged when no LinkedIn profile is found", async () => {
  const client = new HubSpotClient();
  const company = buildSampleCompany();

  client["searchBingResults"] = async () => [];

  const contacts: PublicContactCandidate[] = [
    {
      firstName: "Yaniv",
      lastName: "Ben-Yosef",
      jobTitle: "VP",
      sourceUrl: "https://sample-automation.de",
      label: "website_named_contact"
    }
  ];

  const enriched = await client["enrichSelectedContactsWithLinkedIn"](company, contacts);

  assert.equal(enriched.length, 1);
  assert.equal(enriched[0]?.linkedinUrl, undefined);
});

test("enrichSelectedContactsWithLinkedIn does not re-search a contact that already has a personal LinkedIn URL", async () => {
  const client = new HubSpotClient();
  const company = buildSampleCompany();

  let searchCalls = 0;
  client["searchBingResults"] = async () => {
    searchCalls += 1;
    return [];
  };

  const contacts: PublicContactCandidate[] = [
    {
      firstName: "Martin",
      lastName: "Minsel",
      jobTitle: "Managing Director",
      linkedinUrl: "https://www.linkedin.com/in/martin-minsel",
      sourceUrl: "https://www.linkedin.com/in/martin-minsel",
      label: "linkedin_profile"
    }
  ];

  const enriched = await client["enrichSelectedContactsWithLinkedIn"](company, contacts);

  assert.equal(searchCalls, 0);
  assert.equal(enriched[0]?.linkedinUrl, "https://www.linkedin.com/in/martin-minsel");
});

test("extractLegalEntityNameFromLine rejects German/French disclaimer prose that ends in a lowercase word colliding with a Nordic legal form (ab/as/se)", () => {
  const client = new HubSpotClient();

  // Real imprint disclaimer sentences observed in live runs (Solabcon, Esoes, Cira Vision). The
  // lowercase German word "ab" (=from) must NOT be treated as the Swedish legal form "AB", so the
  // whole sentence must NOT be extracted as a company name.
  assert.equal(
    client["extractLegalEntityNameFromLine"](
      "Schadensersatzansprüche bleiben hiervon unberührt. Eine diesbezügliche Haftung ist jedoch erst ab"
    ),
    null
  );
  assert.equal(
    client["extractLegalEntityNameFromLine"](
      "Der Preis hängt vom Umfang und der Komplexität des Projekts ab"
    ),
    null
  );
  assert.equal(
    client["extractLegalEntityNameFromLine"]("Nous proposons les solutions les plus ab"),
    null
  );
});

test("extractLegalEntityNameFromLine still captures real legal entity names, including lowercase particles and brands", () => {
  const client = new HubSpotClient();

  // Page-title form with an "Impressum der" prefix collapses to the bare legal entity.
  assert.equal(client["extractLegalEntityNameFromLine"]("Impressum der Solabcon GmbH"), "Solabcon GmbH");
  assert.equal(client["extractLegalEntityNameFromLine"]("Solabcon GmbH"), "Solabcon GmbH");
  assert.equal(
    client["extractLegalEntityNameFromLine"]("ESOES GmbH & Co. KG"),
    "ESOES GmbH & Co. KG"
  );
  // Lowercase German particles ("für", "und") inside a real name must be preserved.
  assert.equal(
    client["extractLegalEntityNameFromLine"]("Gesellschaft für moderne Fertigung und Technik mbH"),
    "Gesellschaft für moderne Fertigung und Technik mbH"
  );
  // Lowercase brand name with a canonical-case legal form is a valid entity.
  assert.equal(client["extractLegalEntityNameFromLine"]("adidas AG"), "adidas AG");
});

test("extractCompanyAddress resolves the real GmbH from an impressum even when a disclaimer sentence ending in 'ab' is present", async () => {
  const client = new HubSpotClient();
  client["getOfficialWebsiteCompanyProfile"] = async () => null;
  client["collectCandidatePages"] = async () => ([
    {
      url: "https://solabcon.de/impressum",
      html: `
        <html>
          <body>
            <h1>Impressum der Solabcon GmbH</h1>
            <p>Solabcon GmbH</p>
            <p>
              Die gesetzlichen Schadensersatzansprüche bleiben hiervon unberührt. Eine
              diesbezügliche Haftung ist jedoch erst ab dem Zeitpunkt der Kenntnis einer
              konkreten Rechtsverletzung möglich.
            </p>
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
    name: "Solabcon",
    domain: "https://solabcon.de",
    country: "Germany"
  });

  // The disclaimer prose ("… erst ab") must not win over the real legal entity.
  assert.equal(extracted?.companyName, "Solabcon GmbH");
});

test("extractCompanyAddress prefers the impressum legal entity (with legal form) over the bare AI brand name for the same company", async () => {
  const client = new HubSpotClient();
  // Reproduces the live Solabcon defect: the Azure website profiler returns the bare brand
  // "Solabcon" (trusted exact_operating_entity), but the impressum carries the registered legal
  // form "Solabcon GmbH". The authoritative legal name with the legal form must be adopted.
  client["getOfficialWebsiteCompanyProfile"] = async () => ({
    companyName: "Solabcon",
    entityScope: "exact_operating_entity",
    searchAliases: [],
    address: "Musterstrasse 1",
    city: "Bruchsal",
    zip: "76646",
    state: undefined,
    country: "Germany",
    emails: ["info@solabcon.de"],
    phones: [],
    linkedInUrls: [],
    sourceUrls: ["https://solabcon.de"]
  });
  client["collectCandidatePages"] = async () => ([
    {
      url: "https://solabcon.de/impressum",
      html: "<html><body><h1>Impressum der Solabcon GmbH</h1><p>Solabcon GmbH</p></body></html>"
    }
  ]);
  client["apolloClient"] = {
    getOrganizationAddress: async () => null
  };
  client["extractCompanyAddressWithWebSearch"] = async () => null;

  const extracted = await client["extractCompanyAddress"]({
    name: "Solabcon",
    domain: "https://solabcon.de",
    country: "Germany"
  });

  assert.equal(extracted?.companyName, "Solabcon GmbH");
});

test("extractCompanyAddress keeps the trusted AI name when the impressum legal entity is a different company", async () => {
  const client = new HubSpotClient();
  // Guard: the legal-form preference must NOT override the trusted AI name when the impressum
  // entity is a different root (e.g. a landlord / unrelated GmbH on a shared legal page).
  client["getOfficialWebsiteCompanyProfile"] = async () => ({
    companyName: "Acme Vision",
    entityScope: "exact_operating_entity",
    searchAliases: [],
    address: "Musterstrasse 1",
    city: "Berlin",
    zip: "10115",
    state: undefined,
    country: "Germany",
    emails: ["info@acme-vision.de"],
    phones: [],
    linkedInUrls: [],
    sourceUrls: ["https://acme-vision.de"]
  });
  client["collectCandidatePages"] = async () => ([
    {
      url: "https://acme-vision.de/impressum",
      html: "<html><body><h1>Impressum</h1><p>Hausverwaltung Schmidt GmbH</p></body></html>"
    }
  ]);
  client["apolloClient"] = {
    getOrganizationAddress: async () => null
  };
  client["extractCompanyAddressWithWebSearch"] = async () => null;

  const extracted = await client["extractCompanyAddress"]({
    name: "Acme Vision",
    domain: "https://acme-vision.de",
    country: "Germany"
  });

  assert.equal(extracted?.companyName, "Acme Vision");
});