import test from "node:test";
import assert from "node:assert/strict";
import { AzureOpenAIClient } from "../../src/clients/azure-openai";

test("website classification prompt includes all vision integrator categories", () => {
  const azureClient = new AzureOpenAIClient() as unknown as {
    buildWebsiteClassificationMessages: (
      name: string,
      domain: string | undefined,
      compactWebsiteSummary: string,
      mainContext?: string,
      prequalification?: unknown,
      learning?: unknown,
      compactMode?: boolean
    ) => Array<{ role: string; content: string }>;
  };

  const messages = azureClient.buildWebsiteClassificationMessages(
    "MSTVision GmbH",
    "https://mstvision.de/",
    "MSTVision develops industrial image-processing solutions, custom automation, and photometric stereo line-scan inspection systems for customers.",
    ""
  );

  const systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";

  assert.match(systemPrompt, /integrator_vision_industrial_ai:/);
  assert.match(systemPrompt, /integrator_vision_ai_consulting:/);
  assert.match(systemPrompt, /integrator_vision_ai_freelancer:/);
  assert.match(systemPrompt, /machine vision|computer vision|industrial inspection AI/i);
  assert.match(systemPrompt, /Fraunhofer-style institutes|research institutes|universities|labs/i);
  assert.match(systemPrompt, /publicly funded competence centers are not integrators or customer delivery partners/i);
  assert.match(systemPrompt, /Fraunhofer-style institute, university lab, or research center/i);
});

test("website classification prompt rejects directory, news, and file-sharing pages as non-company", () => {
  const azureClient = new AzureOpenAIClient() as unknown as {
    buildWebsiteClassificationMessages: (
      name: string,
      domain: string | undefined,
      compactWebsiteSummary: string,
      mainContext?: string,
      prequalification?: unknown,
      learning?: unknown,
      compactMode?: boolean
    ) => Array<{ role: string; content: string }>;
  };

  const messages = azureClient.buildWebsiteClassificationMessages(
    "Bayern Firmenübersicht",
    "https://example-directory.de/",
    "Overview portal listing many industrial companies in Bavaria with profiles and news articles.",
    ""
  );

  const systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";

  // Page-type gate must be present in BOTH the quick-qualification context and the website reminders.
  assert.match(systemPrompt, /company directory|business listing|company register|overview page/i);
  assert.match(systemPrompt, /news, press, magazine, blog portal/i);
  assert.match(systemPrompt, /file-sharing|file-hosting|cloud-storage|asset-CDN/i);
  assert.match(systemPrompt, /ONE single operating company/i);
  assert.match(systemPrompt, /irrelevant/i);
});