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
      return JSON.stringify({
        queries: ["Germany machine vision system integrator official company websites"],
        constraintCheck: {
          requiredLocalities: ["Germany"],
          allQueriesPreserveLocality: true,
          forbiddenBroadeningTermsPresent: false,
          preservedLocalitiesByQuery: [
            {
              query: "Germany machine vision system integrator official company websites",
              preservedLocalities: ["Germany"]
            }
          ]
        }
      });
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
    assert.match(systemPrompt, /Do not repeat overused openings such as Germany official company websites of machine vision system integrators/i);
    assert.match(systemPrompt, /Output:/i);
    assert.match(systemPrompt, /Return only strict JSON with this exact shape:/i);
    assert.match(systemPrompt, /Hard constraints:/i);
    assert.match(systemPrompt, /Required localities: Germany/i);
    assert.match(systemPrompt, /Every query must contain at least one exact required locality term verbatim/i);
    assert.match(systemPrompt, /If the required locality is Germany, every query must literally contain Germany/i);
    assert.match(systemPrompt, /Failure output shape:/i);
    assert.match(systemPrompt, /locality_constraint_unsatisfied/i);
    assert.match(systemPrompt, /"constraintCheck"/i);
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
    assert.match(userPrompt, /Search only inside these required localities\. Do not broaden beyond them: Germany/i);
    assert.match(userPrompt, /Forbidden broadening terms for this run: europe, european, eu, emea, dach, global, worldwide, international/i);
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
    assert.match(userPrompt, /Search-surface saturation warning:/i);
    assert.match(userPrompt, /already excludes many root-domain families separately/i);
    assert.match(userPrompt, /too many results come back as the same companies on alternate subpages or deep links/i);
    assert.match(userPrompt, /queries visibly more different, more niche, and more specific/i);
    assert.match(userPrompt, /Prefer fresh official root domains or homepages from new site families/i);
    assert.doesNotMatch(userPrompt, /senswork\.com/i);
    assert.doesNotMatch(userPrompt, /ait\.de/i);
    assert.doesNotMatch(userPrompt, /fraunhofer\.de/i);
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
    assert.match(userPrompt, /If you cannot satisfy the locality constraints exactly, return the failure JSON with error=locality_constraint_unsatisfied/i);
    assert.match(userPrompt, /Baseline query angles to build on:/i);
    assert.match(userPrompt, /Angle 1: Germany companies that provide machine vision system integration for industrial automation/i);
    assert.match(userPrompt, /Return only:/i);
    assert.match(userPrompt, /"constraintCheck"/i);
  } finally {
    readiness.azureConfigured = previousAzureConfigured;
  }
});

test("Exa query planner fails loudly when Azure planning times out", async () => {
  const azureClient = new AzureOpenAIClient() as unknown as {
    planExaSearchQueries: typeof AzureOpenAIClient.prototype.planExaSearchQueries;
    runChat: () => Promise<string>;
  };
  const previousAzureConfigured = readiness.azureConfigured;

  readiness.azureConfigured = true;

  try {
    azureClient.runChat = async () => new Promise<string>(() => undefined);

    await assert.rejects(
      () => azureClient.planExaSearchQueries(
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
        ["baseline query", "second baseline query"],
        undefined,
        false,
        undefined,
        undefined,
        2,
        { plannerTimeoutMs: 1 }
      ),
      /timed out/i
    );
  } finally {
    readiness.azureConfigured = previousAzureConfigured;
  }
});

test("Exa query planner rejects broadened Europe queries for Germany filters", async () => {
  const azureClient = new AzureOpenAIClient() as unknown as {
    planExaSearchQueries: typeof AzureOpenAIClient.prototype.planExaSearchQueries;
    runChat: () => Promise<string>;
  };
  const previousAzureConfigured = readiness.azureConfigured;

  readiness.azureConfigured = true;

  try {
    azureClient.runChat = async () => JSON.stringify({
      queries: [
        "Europe companies that provide industrial automation integration and project engineering services.",
        "Europe system integrators for industrial automation software and MES implementation."
      ],
      constraintCheck: {
        requiredLocalities: ["Germany"],
        allQueriesPreserveLocality: false,
        forbiddenBroadeningTermsPresent: true,
        preservedLocalitiesByQuery: []
      }
    });

    await assert.rejects(
      () => azureClient.planExaSearchQueries(
        {
          name: "Germany Automation Software Integrators",
          persona: "German automation software integrator delivering MES, SCADA, PLC, and industrial software projects",
          industries: ["Industrial Automation", "Industrial Software"],
          keywords: ["industrial automation integrator", "mes system integrator"],
          locations: ["Germany"],
          employeeRanges: ["11,50"],
          targetCategories: ["integrator_general_ai"],
          notes: "Prefer German industrial software and automation implementation partners."
        },
        [
          "Germany companies that provide industrial automation integration, PLC or SCADA implementation, MES connectivity, production software delivery, and project-based engineering services.",
          "Germany system integrators and solution providers that deliver industrial automation integration, PLC or SCADA implementation, MES connectivity, production software delivery, and project-based engineering services for customer projects."
        ],
        undefined,
        false,
        undefined,
        undefined,
        2
      ),
      /locality|broadened/i
    );
  } finally {
    readiness.azureConfigured = previousAzureConfigured;
  }
});

test("Exa query planner prompt switches locality constraints from Germany to Europe when Europe is requested", async () => {
  const azureClient = new AzureOpenAIClient() as unknown as {
    planExaSearchQueries: typeof AzureOpenAIClient.prototype.planExaSearchQueries;
    runChat: (messages: Array<{ role: string; content: string }>) => Promise<string>;
  };
  let capturedMessages: Array<{ role: string; content: string }> = [];
  const previousAzureConfigured = readiness.azureConfigured;

  readiness.azureConfigured = true;

  try {
    azureClient.runChat = async (messages) => {
      capturedMessages = messages;
      return JSON.stringify({
        queries: ["Europe official company websites for machine vision system integrators"],
        constraintCheck: {
          requiredLocalities: ["Europe"],
          allQueriesPreserveLocality: true,
          forbiddenBroadeningTermsPresent: false,
          preservedLocalitiesByQuery: [
            {
              query: "Europe official company websites for machine vision system integrators",
              preservedLocalities: ["Europe"]
            }
          ]
        }
      });
    };

    const queries = await azureClient.planExaSearchQueries(
      {
        name: "Vision Integrators Europe",
        persona: "Operations leaders",
        industries: ["Manufacturing"],
        keywords: ["machine vision", "industrial image processing"],
        locations: ["Europe"],
        employeeRanges: ["11-50"],
        targetCategories: ["integrator_vision_industrial_ai"],
        notes: "Find machine-vision-focused industrial integrators in Europe."
      },
      ["Europe companies that provide machine vision system integration for industrial automation"],
      undefined,
      false,
      undefined,
      undefined,
      1
    );

    assert.deepEqual(queries, ["Europe official company websites for machine vision system integrators"]);

    const systemPrompt = capturedMessages.find((message) => message.role === "system")?.content ?? "";
    const userPrompt = capturedMessages.find((message) => message.role === "user")?.content ?? "";

    assert.match(systemPrompt, /Required localities: Europe/i);
    assert.doesNotMatch(systemPrompt, /If the required locality is Germany, every query must literally contain Germany/i);
    assert.match(userPrompt, /Required locality terms to preserve in every query: Europe/i);
    assert.match(userPrompt, /Search only inside these required localities\. Do not broaden beyond them: Europe/i);
  } finally {
    readiness.azureConfigured = previousAzureConfigured;
  }
});

test("Exa query planner prompt localizes geography examples and opening warnings to the requested locality", async () => {
  const azureClient = new AzureOpenAIClient() as unknown as {
    planExaSearchQueries: typeof AzureOpenAIClient.prototype.planExaSearchQueries;
    runChat: (messages: Array<{ role: string; content: string }>) => Promise<string>;
  };
  const capturedCalls: Array<Array<{ role: string; content: string }>> = [];
  const previousAzureConfigured = readiness.azureConfigured;

  readiness.azureConfigured = true;

  try {
    let callCount = 0;
    azureClient.runChat = async (messages) => {
      capturedCalls.push(messages);
      callCount += 1;
      if (callCount === 1) {
        return JSON.stringify({
          queries: [
            "France companies that provide machine vision system integration for industrial automation",
            "France system integrators and solution providers that deliver machine vision projects for industrial inspection",
            "France industrial image processing specialists for AOI and defect detection"
          ],
          constraintCheck: {
            requiredLocalities: ["France"],
            allQueriesPreserveLocality: true,
            forbiddenBroadeningTermsPresent: false,
            preservedLocalitiesByQuery: [
              {
                query: "France companies that provide machine vision system integration for industrial automation",
                preservedLocalities: ["France"]
              },
              {
                query: "France system integrators and solution providers that deliver machine vision projects for industrial inspection",
                preservedLocalities: ["France"]
              },
              {
                query: "France industrial image processing specialists for AOI and defect detection",
                preservedLocalities: ["France"]
              }
            ]
          }
        });
      }

      return JSON.stringify({
        queries: [
          "France official company websites of automation integrators delivering machine vision projects for quality control",
          "France official company websites of industrial image processing specialists handling defect detection deployments",
          "France official company websites of AI engineering boutiques shipping embedded vision systems"
        ],
        constraintCheck: {
          requiredLocalities: ["France"],
          allQueriesPreserveLocality: true,
          forbiddenBroadeningTermsPresent: false,
          preservedLocalitiesByQuery: [
            {
              query: "France official company websites of automation integrators delivering machine vision projects for quality control",
              preservedLocalities: ["France"]
            },
            {
              query: "France official company websites of industrial image processing specialists handling defect detection deployments",
              preservedLocalities: ["France"]
            },
            {
              query: "France official company websites of AI engineering boutiques shipping embedded vision systems",
              preservedLocalities: ["France"]
            }
          ]
        }
      });
    };

    const queries = await azureClient.planExaSearchQueries(
      {
        name: "Vision Integrators France",
        persona: "Operations leaders",
        industries: ["Manufacturing"],
        keywords: ["machine vision", "industrial image processing"],
        locations: ["France"],
        employeeRanges: ["11-50"],
        targetCategories: ["integrator_vision_industrial_ai"],
        notes: "Find machine-vision-focused industrial integrators in France."
      },
      [
        "France companies that provide machine vision system integration for industrial automation",
        "France system integrators and solution providers that deliver machine vision projects for industrial inspection",
        "France industrial image processing specialists for AOI and defect detection"
      ],
      undefined,
      false,
      undefined,
      undefined,
      3
    );

    assert.deepEqual(queries, [
      "France official company websites of automation integrators delivering machine vision projects for quality control",
      "France official company websites of industrial image processing specialists handling defect detection deployments",
      "France official company websites of AI engineering boutiques shipping embedded vision systems"
    ]);
    assert.equal(capturedCalls.length, 2);

    const systemPrompt = capturedCalls[0]?.find((message) => message.role === "system")?.content ?? "";
    const rewritePrompt = capturedCalls[1]?.find((message) => message.role === "user")?.content ?? "";

    assert.match(systemPrompt, /Geography angle:\n\* France nationwide/i);
    assert.match(systemPrompt, /Example of too-similar queries:\n\* France machine vision system integrators/i);
    assert.match(systemPrompt, /Do not begin every query with France official company websites of\./i);
    assert.match(rewritePrompt, /At least half of the queries must avoid opening with France official company websites of\./i);
    assert.doesNotMatch(rewritePrompt, /At least half of the queries must avoid opening with Europe official company websites of\./i);
  } finally {
    readiness.azureConfigured = previousAzureConfigured;
  }
});