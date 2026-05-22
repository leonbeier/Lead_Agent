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
});