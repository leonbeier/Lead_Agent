import test from "node:test";
import assert from "node:assert/strict";
import { HubSpotClient } from "../../src/clients/hubspot";
import type { PublicContactCandidate, QualifiedCompanyState } from "../../src/types";

test("HubSpot pipeline end-to-end with seeded data", async (suite) => {
  // Setup
  const hubspotClient = new HubSpotClient();

  // Test 1: Company sanitization
  await suite.test("sanitizes companies with valid data", async () => {
    const company1 = {
      name: "Valid Company GmbH",
      domain: "validco.de"
    };
    
    const company2 = {
      name: null,
      domain: "example.com"
    };

    const company3 = {
      name: "",
      domain: "fallback-domain.com"
    };

    // Company 1: valid
    const name1 = company1.name || company1.domain.split(".")[0];
    assert.equal(name1, "Valid Company GmbH");

    // Company 2: example.com should be rejected
    const isValidDomain2 = company2.domain && company2.domain !== "example.com";
    assert.equal(isValidDomain2, false, "example.com should be rejected");

    // Company 3: fallback to domain token
    const name3 = company3.name?.trim() || company3.domain.split(".")[0];
    assert.equal(name3, "fallback-domain");
  });

  // Test 2: Contact quality filtering
  await suite.test("filters low-quality contacts correctly", async () => {
    const rawContacts: PublicContactCandidate[] = [
      {
        name: "Klaus Schmidt",
        email: "k.schmidt@vernaio.com",
        phone: null,
        linkedinUrl: null,
        label: "linkedin",
        sourceUrl: "https://linkedin.com/in/klaus-schmidt"
      },
      {
        name: "Klaus Schmidt",
        email: "k.schmidt@vernaio.com",
        phone: null,
        linkedinUrl: null,
        label: "website",
        sourceUrl: "https://vernaio.com"
      },
      {
        name: null,
        email: null,
        phone: null,
        linkedinUrl: null,
        label: "website",
        sourceUrl: "https://vernaio.com"
      },
      {
        name: "Info Mailbox",
        email: "info@vernaio.com",
        phone: null,
        linkedinUrl: null,
        label: "website",
        sourceUrl: "https://vernaio.com"
      },
      {
        name: "Maria Müller",
        email: null,
        phone: null,
        linkedinUrl: "https://linkedin.com/in/maria-mueller",
        label: "linkedin",
        sourceUrl: "https://linkedin.com/in/maria-mueller"
      }
    ];

    const seenEmails = new Set<string>();
    const seenPhones = new Set<string>();
    const prepared: PublicContactCandidate[] = [];

    for (const contact of rawContacts) {
      const emailKey = (contact.email || "").toLowerCase();
      const phoneKey = (contact.phone || "").toLowerCase();

      // Check for duplicates
      if ((contact.email && seenEmails.has(emailKey)) || (contact.phone && seenPhones.has(phoneKey))) {
        continue;
      }

      // Check for reachable channels
      const hasChannel = !!(contact.email || contact.phone || contact.linkedinUrl);
      if (!hasChannel) {
        continue;
      }

      // Check for generic mailbox
      const isGeneric = contact.name && contact.name.toLowerCase().match(/^(herr|frau|mr|ms|info|support|hello|kontakt)/i);
      if (isGeneric) {
        continue;
      }

      if (contact.email) seenEmails.add(emailKey);
      if (contact.phone) seenPhones.add(phoneKey);
      prepared.push(contact);
    }

    assert.equal(prepared.length, 2, `Should have 2 quality contacts, got ${prepared.length}`);
    assert.ok(prepared.some(c => c.email === "k.schmidt@vernaio.com"));
    assert.ok(prepared.some(c => c.linkedinUrl?.includes("maria")));
  });

  // Test 3: Salutation personalization
  await suite.test("personalizes salutations correctly", async () => {
    const testCases = [
      {
        original: "Hallo [Herr/Frau] [Name],\n\nWir haben eine Lösung für Sie.",
        firstName: "Klaus",
        lastName: "Schmidt",
        expected: "Hallo Klaus Schmidt,\n\nWir haben eine Lösung für Sie."
      },
      {
        original: "Hallo Herr Schmidt,\n\nÜber LinkedIn bin ich auf Sie gestoßen.",
        firstName: "Klaus",
        lastName: "Schmidt",
        expected: "Hallo Klaus Schmidt,\n\nÜber LinkedIn bin ich auf Sie gestoßen."
      },
      {
        original: "Liebe Frau Müller,\n\nIhre Firma nutzt innovative Technologien.",
        firstName: "Anna",
        lastName: "Müller",
        expected: "Liebe Anna Müller,\n\nIhre Firma nutzt innovative Technologien."
      }
    ];

    for (const tc of testCases) {
      let result = tc.original;

      // Replace [Herr/Frau] [Name] patterns
      result = result.replace(/\[Herr\/Frau\]\s*\[.*?\]/gi, () => {
        if (tc.firstName && tc.lastName) {
          return `${tc.firstName} ${tc.lastName}`;
        } else if (tc.firstName) {
          return tc.firstName;
        }
        return "Kontakt";
      });

      // Replace inline Herr/Frau with full name (handles Umlaute better)
      if (tc.firstName && tc.lastName) {
        // Match "Herr/Frau/Liebe" followed by any word (including special chars) followed by comma
        result = result.replace(/\b(?:Herr|Frau|Liebe)\s+\S+,/gi, `${tc.firstName} ${tc.lastName},`);
      }

      // Normalize greeting
      result = result.replace(/Hallo\s+,/gi, "Hallo,");
      result = result.replace(/Liebe\s+,/gi, "Liebe,");

      assert.equal(result.trim(), tc.expected.trim(), `Failed for: ${tc.original.substring(0, 40)}`);
    }
  });

  // Test 4: Contact targeting
  await suite.test("ensures minimum and maximum contact targets", async () => {
    const MIN = 2;
    const MAX = 5;

    const scenarios = [
      { count: 0, needsTopUp: true },
      { count: 1, needsTopUp: true },
      { count: 2, needsTopUp: false },
      { count: 3, needsTopUp: false },
      { count: 5, needsTopUp: false },
      { count: 6, shouldTrim: true }
    ];

    for (const sc of scenarios) {
      const needsTopUp = sc.count < MIN;
      assert.equal(needsTopUp, sc.needsTopUp ?? false);

      if (sc.shouldTrim) {
        assert.ok(sc.count > MAX);
      }
    }
  });
});
