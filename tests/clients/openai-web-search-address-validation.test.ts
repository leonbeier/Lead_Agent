import test from "node:test";
import assert from "node:assert/strict";
import { readiness } from "../../src/config";
import { OpenAIWebSearchClient } from "../../src/clients/openai-web-search";

test("findCompanyAddress rejects uncertain AI address results", async (t) => {
  const previousConfigured = readiness.openAIWebSearchConfigured;
  readiness.openAIWebSearchConfigured = true;
  t.after(() => {
    readiness.openAIWebSearchConfigured = previousConfigured;
  });

  const client = new OpenAIWebSearchClient() as unknown as {
    runWebSearch: (prompt: string, maxTokens: number, mode: string) => Promise<{ text: string }>;
    findCompanyAddress: typeof OpenAIWebSearchClient.prototype.findCompanyAddress;
  };

  client.runWebSearch = async () => ({
    text: JSON.stringify({
      address: "Backed by 14+ years at Salt Technologies with a proven track record.",
      city: "Ahmedabad",
      zip: "380015",
      country: "India",
      verificationStatus: "uncertain",
      confidence: 0.24
    })
  });

  const result = await client.findCompanyAddress({
    name: "Salttechno",
    domain: "salttechno.com",
    country: "India"
  });

  assert.equal(result, null);
});

test("findCompanyAddress keeps verified high-confidence AI address results", async (t) => {
  const previousConfigured = readiness.openAIWebSearchConfigured;
  readiness.openAIWebSearchConfigured = true;
  t.after(() => {
    readiness.openAIWebSearchConfigured = previousConfigured;
  });

  const client = new OpenAIWebSearchClient() as unknown as {
    runWebSearch: (prompt: string, maxTokens: number, mode: string) => Promise<{ text: string }>;
    findCompanyAddress: typeof OpenAIWebSearchClient.prototype.findCompanyAddress;
  };
  let capturedPrompt = "";
  client.runWebSearch = async (prompt: string) => {
    capturedPrompt = prompt;
    return {
      text: JSON.stringify({
        address: "Musterstrasse 12",
        city: "Berlin",
        zip: "10115",
        country: "Germany",
        verificationStatus: "verified",
        confidence: 0.93
      })
    };
  };

  const result = await client.findCompanyAddress({
    name: "Sample Automation GmbH",
    domain: "sample-automation.de",
    country: "Germany"
  });

  assert.equal(result?.address, "Musterstrasse 12");
  assert.match(capturedPrompt, /verificationStatus/i);
  assert.match(capturedPrompt, /full street-level postal address/i);
});

test("findCompanyAddress keeps structured addresses even when the model marks them uncertain", async (t) => {
  const previousConfigured = readiness.openAIWebSearchConfigured;
  readiness.openAIWebSearchConfigured = true;
  t.after(() => {
    readiness.openAIWebSearchConfigured = previousConfigured;
  });

  const client = new OpenAIWebSearchClient() as unknown as {
    runWebSearch: (prompt: string, maxTokens: number, mode: string) => Promise<{ text: string }>;
    findCompanyAddress: typeof OpenAIWebSearchClient.prototype.findCompanyAddress;
  };

  client.runWebSearch = async () => ({
    text: JSON.stringify({
      address: "Musterstrasse 12",
      city: "Berlin",
      zip: "10115",
      country: "Germany",
      verificationStatus: "uncertain",
      confidence: 0.42
    })
  });

  const result = await client.findCompanyAddress({
    name: "Sample Automation GmbH",
    domain: "sample-automation.de",
    country: "Germany"
  });

  assert.equal(result?.address, "Musterstrasse 12");
  assert.equal(result?.city, "Berlin");
  assert.equal(result?.zip, "10115");
});