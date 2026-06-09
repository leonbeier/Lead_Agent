import test from "node:test";
import assert from "node:assert/strict";
import { readiness } from "../../src/config";
import { AzureOpenAIClient } from "../../src/clients/azure-openai";
import { HubSpotClient } from "../../src/clients/hubspot";
import { PreCategorizedCompany, PublicContactCandidate } from "../../src/types";

function buildSampleCompany(): PreCategorizedCompany {
  return {
    name: "Perito Consulting",
    domain: "https://perito.consulting",
    country: "Finland",
    shortDescription: "Industrial and machine vision consulting.",
    sourceFilter: "Debug filter",
    category: "integrator_vision_ai_consulting",
    relevanceScore: 78,
    rationale: "Industrial implementation partner."
  };
}

test("Azure choosePublicContacts can explicitly reject all weak candidates", async (t) => {
  const previousAzureConfigured = readiness.azureConfigured;
  readiness.azureConfigured = true;
  t.after(() => {
    readiness.azureConfigured = previousAzureConfigured;
  });

  const client = new AzureOpenAIClient() as unknown as {
    runChat: (messages: Array<{ role: string; content: string }>, options?: { maxTokens?: number }) => Promise<string>;
    choosePublicContacts: typeof AzureOpenAIClient.prototype.choosePublicContacts;
  };

  client.runChat = async () => JSON.stringify({ selectedContactIds: [], reason: "All candidates are weak or unrelated." });

  const selected = await client.choosePublicContacts(
    buildSampleCompany(),
    [
      {
        firstName: "Represented",
        lastName: "By",
        sourceUrl: "https://directory.example.com/perito",
        label: "web_search_contact"
      },
      {
        firstName: "Our",
        lastName: "Customers",
        sourceUrl: "https://directory.example.com/perito-customers",
        label: "web_search_contact"
      }
    ],
    false
  );

  assert.deepEqual(selected, []);
});

test("HubSpot employee selection falls back to heuristic company contacts when Azure rejects all", async (t) => {
  const previousAzureConfigured = readiness.azureConfigured;
  readiness.azureConfigured = true;
  t.after(() => {
    readiness.azureConfigured = previousAzureConfigured;
  });

  const client = new HubSpotClient() as unknown as {
    azureOpenAIClient: { choosePublicContacts: (company: PreCategorizedCompany, candidates: PublicContactCandidate[], dryRun: boolean) => Promise<PublicContactCandidate[]> };
    selectRelevantEmployeeContacts: typeof HubSpotClient.prototype["selectRelevantEmployeeContacts"];
  };

  client.azureOpenAIClient.choosePublicContacts = async () => [];

  const selected = await client.selectRelevantEmployeeContacts(
    buildSampleCompany(),
    [
      {
        firstName: "Represented",
        lastName: "By",
        jobTitle: "Operations",
        sourceUrl: "https://directory.example.com/perito",
        label: "web_search_contact"
      },
      {
        firstName: "Petteri",
        lastName: "Laesvuori",
        linkedinUrl: "https://www.linkedin.com/in/petteri-laesvuori/",
        sourceUrl: "https://roimaint.com/team/petteri-laesvuori",
        label: "linkedin_profile"
      }
    ]
  );

  assert.equal(selected.length, 2);
  assert.equal(selected.some((contact) => contact.linkedinUrl === "https://www.linkedin.com/in/petteri-laesvuori/"), true);
  assert.equal(selected.some((contact) => `${contact.firstName} ${contact.lastName}`.trim() === "Represented By"), true);
});

test("extractPublicContactsFromEvidence dedup merges the same person across a LinkedIn profile and a named website contact", async () => {
  const client = new AzureOpenAIClient() as unknown as {
    dedupePublicContacts: (contacts: PublicContactCandidate[]) => PublicContactCandidate[];
  };

  const deduped = client.dedupePublicContacts([
    {
      firstName: "Björn",
      lastName: "Groenewold",
      linkedinUrl: "https://www.linkedin.com/in/bgroenewold",
      label: "linkedin_profile"
    },
    {
      firstName: "Thorsten",
      lastName: "Frieling",
      email: "thorsten.frieling@groenewold-it.solutions",
      label: "public_named_mailbox"
    },
    {
      firstName: "Björn",
      lastName: "Groenewold",
      email: "info@groenewold-it.solutions",
      label: "public_generic_mailbox"
    }
  ]);

  assert.equal(deduped.length, 2);
  const bjoern = deduped.find((contact) => contact.lastName === "Groenewold");
  assert.equal(bjoern?.linkedinUrl, "https://www.linkedin.com/in/bgroenewold");
  // The richest channel survives the merge: the personal LinkedIn URL plus a reachable email.
  assert.equal(typeof bjoern?.email, "string");
});

test("extractPublicContactsFromEvidence dedup matches names across precomposed and decomposed umlauts", async () => {
  const client = new AzureOpenAIClient() as unknown as {
    dedupePublicContacts: (contacts: PublicContactCandidate[]) => PublicContactCandidate[];
  };

  const deduped = client.dedupePublicContacts([
    {
      firstName: "Bj\u00f6rn", // precomposed ö
      lastName: "Groenewold",
      linkedinUrl: "https://www.linkedin.com/in/bgroenewold"
    },
    {
      firstName: "Bjo\u0308rn", // decomposed o + combining diaeresis
      lastName: "Groenewold",
      email: "bjoern@groenewold-it.solutions"
    }
  ]);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].linkedinUrl, "https://www.linkedin.com/in/bgroenewold");
});

test("extractPublicContactsFromEvidence dedup keeps two distinct people and distinct generic mailboxes", async () => {
  const client = new AzureOpenAIClient() as unknown as {
    dedupePublicContacts: (contacts: PublicContactCandidate[]) => PublicContactCandidate[];
  };

  const deduped = client.dedupePublicContacts([
    { firstName: "Max", lastName: "Mustermann", email: "max@x.de" },
    { firstName: "Erika", lastName: "Musterfrau", email: "erika@x.de" },
    { email: "info@x.de", label: "public_generic_mailbox" },
    { email: "kontakt@x.de", label: "public_generic_mailbox" }
  ]);

  assert.equal(deduped.length, 4);
});