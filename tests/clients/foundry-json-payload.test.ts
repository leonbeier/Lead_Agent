import test from "node:test";
import assert from "node:assert/strict";
import { extractJsonPayload } from "../../src/clients/foundry-agents";

// The grounded gpt-4o contact-discovery agent intermittently wraps its strict JSON in prose
// ("From the information...", "Here are results...", "Here's a contact list:"), which made
// JSON.parse throw and silently dropped every discovered contact (observed live 2026-06-20).
// extractJsonPayload must recover the embedded JSON so the contacts still parse.

test("extractJsonPayload returns bare JSON object unchanged", () => {
  const payload = '{"contacts":[{"firstName":"Anna","lastName":"Muster"}]}';
  assert.equal(extractJsonPayload(payload), payload);
});

test("extractJsonPayload strips markdown code fences", () => {
  const fenced = "```json\n{\"contacts\":[]}\n```";
  assert.deepEqual(JSON.parse(extractJsonPayload(fenced)), { contacts: [] });
});

test("extractJsonPayload extracts JSON after a prose preamble", () => {
  const prose = "From the information available, here is the contact data:\n\n"
    + '{"contacts":[{"firstName":"Jan","lastName":"Fröschl","linkedinUrl":"https://linkedin.com/in/jan"}]}';
  const parsed = JSON.parse(extractJsonPayload(prose)) as { contacts: Array<{ linkedinUrl: string }> };
  assert.equal(parsed.contacts.length, 1);
  assert.equal(parsed.contacts[0].linkedinUrl, "https://linkedin.com/in/jan");
});

test("extractJsonPayload extracts fenced JSON after a prose preamble", () => {
  const prose = "Here are results I found:\n\n```json\n{\"contacts\":[{\"firstName\":\"Eva\"}]}\n```";
  const parsed = JSON.parse(extractJsonPayload(prose)) as { contacts: Array<{ firstName: string }> };
  assert.equal(parsed.contacts[0].firstName, "Eva");
});

test("extractJsonPayload handles braces inside string values", () => {
  const prose = 'Here is a contact list: {"contacts":[{"jobTitle":"Lead {AI} Engineer","firstName":"Max"}]}';
  const parsed = JSON.parse(extractJsonPayload(prose)) as { contacts: Array<{ jobTitle: string }> };
  assert.equal(parsed.contacts[0].jobTitle, "Lead {AI} Engineer");
});

test("extractJsonPayload extracts a top-level JSON array after prose", () => {
  const prose = "The queries are:\n[\"site:linkedin.com/in example\",\"max linkedin example\"]";
  const parsed = JSON.parse(extractJsonPayload(prose)) as string[];
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0], "site:linkedin.com/in example");
});

test("extractJsonPayload returns prose unchanged when no JSON is present", () => {
  const prose = "I couldn't find any contacts for this company.";
  assert.equal(extractJsonPayload(prose), prose);
  assert.throws(() => JSON.parse(extractJsonPayload(prose)));
});
