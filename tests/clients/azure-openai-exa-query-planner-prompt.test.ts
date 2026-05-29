import test from "node:test";
import assert from "node:assert/strict";
import { readiness } from "../../src/config";
import { AzureOpenAIClient } from "../../src/clients/azure-openai";

test("Exa query planner prompt uses the new ONE WARE system and structured user prompt", async () => {
  const azureClient = new AzureOpenAIClient() as unknown as {
    planExaSearchQueries: typeof AzureOpenAIClient.prototype.planExaSearchQueries;
    runChat: (messages: Array<{ role: string; content: string }>) => Promise<string>;
    buildLearningContextForSearchStrategy: (learning?: unknown) => string | undefined;
  };
  let capturedMessages: Array<{ role: string; content: string }> = [];
  const previousAzureConfigured = readiness.azureConfigured;

  readiness.azureConfigured = true;

  try {
    azureClient.buildLearningContextForSearchStrategy = () => "Learning summary";
    azureClient.runChat = async (messages) => {
      capturedMessages = messages;
      return JSON.stringify({ queries: ["Germany machine vision system integrator official company websites"] });
    };

    const queries = await azureClient.planExaSearchQueries(
      {
        name: "Vision Integrators Germany",
        persona: "Operations leaders",
        industries: ["Manufacturing"],
        keywords: ["machine vision", "industrial image processing"],
        locations: ["Germany"],
        employeeRanges: ["11-50"],
        targetCategories: ["integrator_vision_industrial_ai"],
        notes: "Find machine-vision-focused industrial integrators in Germany."
      },
      ["Germany companies that provide machine vision system integration for industrial automation"],
      {
        companyFeedback: [],
        filterPerformance: {},
        searchHistory: [],
        searchHistoryByMode: {
          exa_search: {
            searchHistory: [
              {
                filterName: "Vision Integrators Germany",
                targetCategory: "integrator_vision_industrial_ai",
                returnedCount: 20,
                relevantCount: 3,
                relevanceRatio: 0.15,
                companies: [],
                timestamp: new Date().toISOString(),
                discoveryQueries: ["industrial automation systems Germany"],
                queryStats: [
                  {
                    query: "industrial automation systems Germany",
                    rawFound: 20,
                    accepted: 1,
                    rejectedDifferentCategory: 12,
                    rejectedOther: 5,
                    duplicates: 2,
                    categoryBreakdown: {
                      integrator_vision_industrial_ai: 1,
                      integrator_general_ai: 6,
                      integrator_relevant_focus: 5,
                      industrial_end_customer_scaled: 1,
                      machine_builder_ai_enablement: 0,
                      software_platform_embedding: 0,
                      integrator_vision_ai_consulting: 0,
                      integrator_vision_ai_freelancer: 0,
                      camera_manufacturer_partner: 0,
                      irrelevant: 0,
                      other: 5
                    }
                  }
                ],
                categoryBreakdown: {
                  integrator_vision_industrial_ai: 1,
                  integrator_general_ai: 6,
                  integrator_relevant_focus: 5,
                  industrial_end_customer_scaled: 2,
                  machine_builder_ai_enablement: 1,
                  software_platform_embedding: 0,
                  integrator_vision_ai_consulting: 0,
                  integrator_vision_ai_freelancer: 0,
                  camera_manufacturer_partner: 0,
                  irrelevant: 0,
                  other: 5
                }
              }
            ]
          }
        }
      },
      false,
      "Main context",
      "Search strategy context",
      1,
      {
        recentQueryHistory: [
          {
            query: "Berlin Germany official company websites for machine vision system integrators delivering industrial image processing",
            foundCategoryBreakdown: {
              integrator_vision_industrial_ai: 0,
              integrator_general_ai: 0,
              integrator_relevant_focus: 0,
              industrial_end_customer_scaled: 0,
              machine_builder_ai_enablement: 0,
              software_platform_embedding: 0,
              integrator_vision_ai_consulting: 0,
              integrator_vision_ai_freelancer: 0,
              camera_manufacturer_partner: 0,
              irrelevant: 0,
              other: 3
            },
            returnedResults: 20,
            filteredByExcludedDomains: 8,
            rawFound: 12,
            duplicates: 3,
            accepted: 0,
            rejectedDifferentCategory: 0,
            rejectedOther: 3,
            note: "Berlin cluster underperformed"
          }
        ],
        excludedDomainExamples: [
          "senswork.com",
          "ait.de",
          "fraunhofer.de"
        ]
      }
    );

    const systemPrompt = capturedMessages.find((message) => message.role === "system")?.content ?? "";
    const userPrompt = capturedMessages.find((message) => message.role === "user")?.content ?? "";

    assert.deepEqual(queries, ["Germany machine vision system integrator official company websites"]);
    assert.doesNotMatch(systemPrompt, /Main context:/i);
    assert.doesNotMatch(systemPrompt, /Search strategy:/i);
    assert.match(systemPrompt, /You are the Exa Query Planner for ONE WARE/i);
    assert.match(systemPrompt, /ONE WARE context:[\s\S]*Main context/i);
    assert.match(systemPrompt, /Search strategy context:[\s\S]*Search strategy context/i);
    assert.match(systemPrompt, /These queries are for an AI\/semantic search system, not a traditional keyword search engine/i);
    assert.match(systemPrompt, /Task:/i);
    assert.match(systemPrompt, /Your job is to create exactly 1 Exa company-discovery queries for ONE WARE/i);
    assert.match(systemPrompt, /The queries you create are the first step in the pipeline/i);
    assert.match(systemPrompt, /Exa should already do as much preselection work as possible/i);
    assert.match(systemPrompt, /Always-not-wanted result types:/i);
    assert.match(systemPrompt, /Common wrong-company types:/i);
    assert.match(systemPrompt, /False-positive prevention:/i);
    assert.match(systemPrompt, /Official-website preference:/i);
    assert.match(systemPrompt, /Avoid broad keyword stuffing:/i);
    assert.match(systemPrompt, /Every query should make clear what kind of company should not be found/i);
    assert.match(systemPrompt, /Every query should explicitly ask for official company websites or official websites/i);
    assert.match(systemPrompt, /press pages, patents, academic pages, product brochures, trade-fair profiles, association member pages, investor pages/i);
    assert.match(systemPrompt, /Most important rule: do not repeat old queries/i);
    assert.match(systemPrompt, /Do not repeat overused openings such as Europe official company websites of machine vision system integrators/i);
    assert.match(systemPrompt, /Output:/i);
    assert.match(systemPrompt, /Return only strict JSON with this exact shape:/i);
    assert.match(systemPrompt, /\{"queries":\["query 1"\]\}/i);
    assert.match(systemPrompt, /Query style:/i);
    assert.match(systemPrompt, /Write natural-language Exa queries/i);
    assert.match(systemPrompt, /Do not use site:/i);
    assert.match(systemPrompt, /Critical query diversity requirement:/i);
    assert.match(systemPrompt, /Capability angle:/i);
    assert.match(systemPrompt, /Company self-description angle:/i);
    assert.match(systemPrompt, /Buyer, vertical, or use-case angle:/i);
    assert.match(systemPrompt, /Geography angle:/i);
    assert.match(systemPrompt, /Exclusion angle:/i);
    assert.match(systemPrompt, /The examples are not templates to copy exactly/i);
    assert.match(systemPrompt, /Old-query avoidance:/i);
    assert.match(systemPrompt, /Always avoid noisy result types unless explicitly requested otherwise/i);
    assert.match(userPrompt, /Target:/i);
    assert.match(userPrompt, /This section defines the exact kind of companies you are trying to find/i);
    assert.match(userPrompt, /Required locality terms to preserve in every query: Germany/i);
    assert.match(userPrompt, /Desired target categories for this run: integrator_vision_industrial_ai/i);
    assert.match(userPrompt, /Non-desired selectable categories for this run:/i);
    assert.match(userPrompt, /Also avoid drifting into: other, irrelevant/i);
    assert.match(userPrompt, /Find official company websites for the intended target profile/i);
    assert.match(userPrompt, /Search filter context:/i);
    assert.match(userPrompt, /Good Signals:/i);
    assert.match(userPrompt, /Use this section to understand what a good target looks like before the later AI check happens/i);
    assert.doesNotMatch(userPrompt, /After Exa retrieval, the websites are filtered again by Azure AI/i);
    assert.doesNotMatch(userPrompt, /Categories that should be found:/i);
    assert.match(userPrompt, /Category: integrator_vision_industrial_ai \(Integrators with explicit Vision\/Industrial AI focus\)/i);
    assert.match(userPrompt, /This is what a good match for this category looks like:/i);
    assert.match(userPrompt, /Good signal: Relevant when the website explicitly mentions Vision AI/i);
    assert.match(userPrompt, /Avoid:/i);
    assert.match(userPrompt, /Use this section to understand what should be filtered out already at the query-writing stage/i);
    assert.match(userPrompt, /If recent history shows wrong-category drift, name that wrong company type explicitly as something to avoid/i);
    assert.match(userPrompt, /If integrator_relevant_focus is not selected, explicitly say not surveillance, defence, medtech vision, robotics/i);
    assert.match(userPrompt, /If machine_builder_ai_enablement is not selected, explicitly say not OEMs, machine builders, scanner vendors, inspection stations, or hardware-centric inspection product companies/i);
    assert.match(userPrompt, /Target-category disqualifiers:/i);
    assert.match(userPrompt, /Non-target categories to avoid:/i);
    assert.match(userPrompt, /Known excluded websites already covered or already rejected:/i);
    assert.match(userPrompt, /Do not target them again/i);
    assert.match(userPrompt, /senswork\.com/i);
    assert.match(userPrompt, /ait\.de/i);
    assert.match(userPrompt, /fraunhofer\.de/i);
    assert.match(userPrompt, /Category to avoid drifting into: other \(Other \/ unclear\)/i);
    assert.match(userPrompt, /These are signals that the query is drifting toward the wrong company type:/i);
    assert.match(userPrompt, /Avoid signal: Pure product vendor without implementation ownership/i);
    assert.match(userPrompt, /Recent query history with outcomes:/i);
    assert.match(userPrompt, /These queries have already been tried/i);
    assert.match(userPrompt, /Use them as evidence for what worked, what failed, and what caused category drift/i);
    assert.match(userPrompt, /Berlin Germany official company websites for machine vision system integrators delivering industrial image processing/i);
    assert.match(userPrompt, /Observed counts: returned=20 excluded=8 duplicates=3 accepted=0 wrong_category=0 other=3 raw_found=12/i);
    assert.match(userPrompt, /Found company categories: other=3/i);
    assert.match(userPrompt, /Note: Berlin cluster underperformed/i);
    assert.match(userPrompt, /Recent Exa search history summary:/i);
    assert.match(userPrompt, /Vision Integrators Germany \| 3\/20 relevant \| 15%/i);
    assert.match(userPrompt, /Final task:/i);
    assert.match(userPrompt, /Create exactly 1 new Exa company-discovery queries/i);
    assert.match(userPrompt, /Baseline query angles to build on:/i);
    assert.match(userPrompt, /Angle 1: Germany companies that provide machine vision system integration for industrial automation/i);
    assert.match(userPrompt, /Return only:/i);
    assert.match(userPrompt, /\{"queries":\["\.\.\."\]\}/i);
  } finally {
    readiness.azureConfigured = previousAzureConfigured;
  }
});