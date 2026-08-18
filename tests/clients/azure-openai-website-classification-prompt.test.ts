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

test("website classification prompt always enforces the base-website fit gate and end-customer scale band", () => {
  const azureClient = new AzureOpenAIClient() as unknown as {
    buildWebsiteClassificationMessages: (
      name: string,
      domain: string | undefined,
      compactWebsiteSummary: string,
      mainContext?: string,
      prequalification?: unknown,
      learning?: unknown,
      compactMode?: boolean,
      targetCategoryRefinement?: string
    ) => Array<{ role: string; content: string }>;
  };

  const messages = azureClient.buildWebsiteClassificationMessages(
    "Vw Mms",
    "https://vw-mms.de/",
    "Landing page about media asset management services.",
    ""
  );

  const systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";

  // Base-website fit gate: a media/asset server or a query-matched subpage must not qualify.
  assert.match(systemPrompt, /fit decision MUST come from the base website/i);
  assert.match(systemPrompt, /media\/asset server|marketing microsite|deep subpage/i);
  // Scale band: reject tiny artisanal producers and global mega-conglomerates.
  assert.match(systemPrompt, /Industrial End-Customer Scale Band/i);
  assert.match(systemPrompt, /artisanal, manufaktur, farm-shop, or single-workshop/i);
  assert.match(systemPrompt, /globally diversified mega-conglomerate or holding group/i);
  // Scale must be judged from proxy evidence, never from a published revenue figure.
  assert.match(systemPrompt, /do NOT require a revenue number/i);
  assert.match(systemPrompt, /Never reject an in-scope industrial producer with the reasoning that it lacks machine-vision/i);
});

test("website classification prompt enforces the additional required focus as a HARD constraint when provided", () => {
  const azureClient = new AzureOpenAIClient() as unknown as {
    buildWebsiteClassificationMessages: (
      name: string,
      domain: string | undefined,
      compactWebsiteSummary: string,
      mainContext?: string,
      prequalification?: unknown,
      learning?: unknown,
      compactMode?: boolean,
      targetCategoryRefinement?: string
    ) => Array<{ role: string; content: string }>;
  };

  const withRefinement = azureClient.buildWebsiteClassificationMessages(
    "Some Producer",
    "https://example.de/",
    "Producer website.",
    "",
    undefined,
    undefined,
    false,
    "im Food Produktionssektor"
  );
  const systemPromptWithRefinement = withRefinement.find((message) => message.role === "system")?.content ?? "";
  assert.match(systemPromptWithRefinement, /Additional Required Focus \(HARD/i);
  assert.match(systemPromptWithRefinement, /im Food Produktionssektor/);
  assert.match(systemPromptWithRefinement, /OVERRIDES archetype fit/i);
  assert.match(systemPromptWithRefinement, /strong archetype in the WRONG sector/i);
  // The refinement defines the sector boundary the way an industry expert reads it: sibling
  // sub-sectors (e.g. beverages under a food-production focus) are INSIDE, and missing scale
  // evidence is a scale decision, never a focus mismatch.
  assert.match(systemPromptWithRefinement, /the way an industry expert of that sector would read it/i);
  assert.match(systemPromptWithRefinement, /beverages, breweries, dairies/i);
  assert.match(systemPromptWithRefinement, /Missing scale evidence is a scale decision, never a focus mismatch/i);

  const withoutRefinement = azureClient.buildWebsiteClassificationMessages(
    "Some Producer",
    "https://example.de/",
    "Producer website.",
    ""
  );
  const systemPromptWithoutRefinement = withoutRefinement.find((message) => message.role === "system")?.content ?? "";
  assert.doesNotMatch(systemPromptWithoutRefinement, /Additional Required Focus/i);
});

test("applyRequiredFocusGate forces irrelevant only on explicit focusMatch=false with a refinement set", () => {
  const client = new AzureOpenAIClient();
  const base = { category: "industrial_end_customer_scaled" as const, relevanceScore: 96, rationale: "Large automotive manufacturer; food not evidenced.", country: "Germany" };

  // Explicit mismatch with a refinement -> forced irrelevant (the VW/Trimet leak).
  const rejected = client.applyRequiredFocusGate(base, false, "im Food Produktionssektor");
  assert.equal(rejected.category, "irrelevant");
  assert.ok(rejected.relevanceScore <= 15);
  assert.match(rejected.rationale, /required focus/i);

  // Explicit match -> kept.
  assert.equal(client.applyRequiredFocusGate(base, true, "im Food Produktionssektor").category, "industrial_end_customer_scaled");

  // Missing focusMatch -> never over-reject a genuine match that omitted the field.
  assert.equal(client.applyRequiredFocusGate(base, undefined, "im Food Produktionssektor").category, "industrial_end_customer_scaled");

  // No refinement -> gate is inert.
  assert.equal(client.applyRequiredFocusGate(base, false, undefined).category, "industrial_end_customer_scaled");
  assert.equal(client.applyRequiredFocusGate(base, false, "   ").category, "industrial_end_customer_scaled");

  // Already irrelevant -> untouched.
  const alreadyIrrelevant = { category: "irrelevant" as const, relevanceScore: 0, rationale: "x" };
  assert.equal(client.applyRequiredFocusGate(alreadyIrrelevant, false, "im Food Produktionssektor").category, "irrelevant");
});