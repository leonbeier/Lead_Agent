import test from "node:test";
import assert from "node:assert/strict";
import { readiness } from "../../src/config";
import { AzureOpenAIClient } from "../../src/clients/azure-openai";
import { HubSpotClient } from "../../src/clients/hubspot";
import { PreCategorizedCompany, ResearchBrief } from "../../src/types";

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

function buildResearchBriefPayload(outreachLanguage: string): Omit<ResearchBrief, "companyName" | "outreachLanguage"> & { outreachLanguage: string } {
  return {
    overview: "Overview",
    qualificationSummary: "Strong industrial delivery fit.",
    qualifyingSignals: ["PLC", "SCADA"],
    riskFlags: [],
    likelyGermanSpeaking: true,
    outreachLanguage,
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
    phoneScript: "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE."
  };
}

test("Azure buildResearchBrief normalizes German to de", async (t) => {
  const previousAzureConfigured = readiness.azureConfigured;
  readiness.azureConfigured = true;
  t.after(() => {
    readiness.azureConfigured = previousAzureConfigured;
  });

  const client = new AzureOpenAIClient() as unknown as {
    foundryAgentsClient: { buildResearchBrief: (company: PreCategorizedCompany, mainContext: string | undefined, dryRun: boolean) => Promise<ResearchBrief | null> };
    webSearchAgent: {
      crawlCompanyWebsite: (domain: string, mode: string) => Promise<{ summary: string; landingUrl: string; relevantUrls: string[] }>;
      buildResearchContext: (company: PreCategorizedCompany) => Promise<{ context: string; citations: string[] } | undefined>;
    };
    runChat: (messages: Array<{ role: string; content: string }>) => Promise<string>;
    buildResearchBrief: typeof AzureOpenAIClient.prototype.buildResearchBrief;
  };

  client.foundryAgentsClient.buildResearchBrief = async () => null;
  client.webSearchAgent.crawlCompanyWebsite = async () => ({
    summary: "Industrial automation integrator with PLC and SCADA delivery experience.",
    landingUrl: "https://sample-automation.de",
    relevantUrls: ["https://sample-automation.de/contact"]
  });
  client.webSearchAgent.buildResearchContext = async () => undefined;
  client.runChat = async () => JSON.stringify(buildResearchBriefPayload("German"));

  const brief = await client.buildResearchBrief(buildSampleCompany(), false);

  assert.equal(brief.outreachLanguage, "de");
});

test("HubSpot outreach personalization normalizes German language labels", () => {
  const client = new HubSpotClient() as unknown as {
    personalizeOutreachMessage: typeof HubSpotClient.prototype["personalizeOutreachMessage"];
  };

  const personalized = client.personalizeOutreachMessage(
    "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE.",
    {
      firstName: "Martin",
      lastName: "Minsel",
      sourceUrl: "https://sample-automation.de/contact",
      label: "linkedin_profile"
    },
    "German" as ResearchBrief["outreachLanguage"]
  );

  assert.equal(personalized, "Hallo Herr/Frau Minsel, hier ist ONE WARE.");
});