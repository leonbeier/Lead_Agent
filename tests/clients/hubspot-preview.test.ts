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

test("previewHubSpotSync skips generic mailbox contacts without person identity", async () => {
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

  assert.equal(preview.contacts[0]?.skipped, true);
  assert.match(preview.contacts[0]?.skipReason ?? "", /Generic mailbox/i);
  assert.equal(preview.contacts[1]?.properties.firstname, "Martin");
  assert.equal(preview.contacts[1]?.properties.jobtitle, "Managing Director");
  assert.equal(preview.contacts[1]?.properties.hs_linkedin_url, "https://www.linkedin.com/in/martin-minsel");
  assert.match(preview.contacts[1]?.outreachNote ?? "", /LinkedIn Outreach/);
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
});

test("named LinkedIn contacts remain preferred over a generic mailbox fallback", async () => {
  const client = new HubSpotClient();
  const company = buildSampleCompany();

  const selectedContacts = await client["selectRelevantEmployeeContacts"](company, [
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
  ]);

  assert.equal(selectedContacts.length, 4);
  assert.ok(selectedContacts.every((contact) => contact.label === "linkedin_profile"));
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