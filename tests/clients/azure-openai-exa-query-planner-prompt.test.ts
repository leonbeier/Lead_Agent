import test from "node:test";
import assert from "node:assert/strict";
import { readiness } from "../../src/config";
import { AzureOpenAIClient } from "../../src/clients/azure-openai";

test("Exa query planner prompt asks for natural-language Exa AI queries with explicit locality", async () => {
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
            note: "Berlin cluster underperformed"
          }
        ]
      }
    );

    const systemPrompt = capturedMessages.find((message) => message.role === "system")?.content ?? "";
    const userPrompt = capturedMessages.find((message) => message.role === "user")?.content ?? "";

    assert.deepEqual(queries, ["Germany machine vision system integrator official company websites"]);
    assert.doesNotMatch(systemPrompt, /Main context:/i);
    assert.doesNotMatch(systemPrompt, /Search strategy:/i);
    assert.match(systemPrompt, /You are the Exa Query Planner for ONE WARE/i);
    assert.match(systemPrompt, /ONE WARE context: Main context/i);
    assert.match(systemPrompt, /Search strategy context: Search strategy context/i);
    assert.match(systemPrompt, /AI\/semantic search system, not for a traditional web search engine/i);
    assert.match(systemPrompt, /Task:/i);
    assert.match(systemPrompt, /Your job is to create 1 Exa company-discovery queries for ONE WARE/i);
    assert.match(systemPrompt, /These queries are the first step in the pipeline/i);
    assert.match(systemPrompt, /Exa should already do as much of the preselection work as possible/i);
    assert.match(systemPrompt, /Look at the query history before writing new queries/i);
    assert.match(systemPrompt, /Use the search history as evidence\. Rotate intelligently across company categories, locations, and use-case keywords/i);
    assert.match(systemPrompt, /Output:/i);
    assert.match(systemPrompt, /Return the result as strict JSON with this shape:/i);
    assert.match(systemPrompt, /\{"queries":\["query 1", "query 2"\]\}/i);
    assert.match(systemPrompt, /Stil:/i);
    assert.match(systemPrompt, /Write natural-language Exa queries, as if you were briefing a researcher/i);
    assert.match(systemPrompt, /Do not use site:/i);
    assert.match(systemPrompt, /Keep the useful detail from strong baseline queries/i);
    assert.match(systemPrompt, /Preserve exclusion intent too, but express it in natural prose/i);
    assert.match(systemPrompt, /Do not stuff every synonym into every query/i);
    assert.match(systemPrompt, /Do not force one fixed query template or one fixed sentence structure/i);
    assert.match(systemPrompt, /vary wording and angle instead of producing near-duplicates/i);
    assert.match(userPrompt, /Target:/i);
    assert.match(userPrompt, /This section defines the exact kind of companies you are trying to find/i);
    assert.match(userPrompt, /Required locality terms to preserve in every query: Germany/i);
    assert.match(userPrompt, /Desired target categories for this run: integrator_vision_industrial_ai/i);
    assert.match(userPrompt, /Non-desired selectable categories for this run:/i);
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
    assert.match(userPrompt, /If the history shows repeated drift into a non-target category, write that wrong company type explicitly into the next query as something to avoid/i);
    assert.match(userPrompt, /If integrator_relevant_focus is not selected, explicitly say not surveillance, defence, medtech vision, robotics/i);
    assert.match(userPrompt, /If machine_builder_ai_enablement is not selected, explicitly say not OEMs, machine builders, scanner vendors, inspection stations, or hardware-centric inspection product companies/i);
    assert.match(userPrompt, /Target-category disqualifiers:/i);
    assert.match(userPrompt, /Non-target categories to avoid:/i);
    assert.match(userPrompt, /Category to avoid drifting into: other \(Other \/ unclear\)/i);
    assert.match(userPrompt, /These are signals that the query is drifting toward the wrong company type:/i);
    assert.match(userPrompt, /Avoid signal: Pure product vendor without implementation ownership/i);
    assert.match(userPrompt, /Output:/i);
    assert.match(userPrompt, /Return only the query output in JSON format/i);
    assert.match(userPrompt, /Stil:/i);
    assert.match(userPrompt, /Think of them as short, concrete work instructions for Exa/i);
    assert.match(userPrompt, /Review the recent query history and consciously vary synonym families across the new query set/i);
    assert.match(userPrompt, /computer vision, machine vision, industrial vision, visual inspection, automated optical inspection, AOI/i);
    assert.match(userPrompt, /put a short natural-language exclusion clause for those wrong company types into the main query sentence itself/i);
    assert.match(userPrompt, /Kontext:/i);
    assert.match(userPrompt, /This section gives you the baseline queries and recent performance context/i);
    assert.match(userPrompt, /Use this recent history to decide which synonym families, category angles, and regional variants have been overused or underused/i);
    assert.match(userPrompt, /Recent query history with outcomes \(last 1 queries, newest first\):/i);
    assert.match(userPrompt, /Berlin Germany official company websites for machine vision system integrators delivering industrial image processing/i);
    assert.match(userPrompt, /Found company categories: other=3/i);
    assert.match(userPrompt, /Note: Berlin cluster underperformed/i);
  } finally {
    readiness.azureConfigured = previousAzureConfigured;
  }
});