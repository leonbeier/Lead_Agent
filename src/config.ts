import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const booleanFlag = () =>
  z
    .string()
    .transform((value) => value.toLowerCase() === "true");

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DEFAULT_MARKET: z.string().default("Europe"),
  DEFAULT_TARGET_LEADS: z.coerce.number().int().positive().default(50),
  LEAD_AGENT_SHARED_KEY: z.string().min(24),
  LEAD_AGENT_PUBLIC_BASE_URL: z.string().url().optional(),
  APOLLO_API_KEY: z.string().optional(),
  APOLLO_BASE_URL: z.string().url().default("https://api.apollo.io/api/v1"),
  HUBSPOT_PRIVATE_APP_TOKEN: z.string().optional(),
  HUBSPOT_CLIENT_ID: z.string().optional(),
  HUBSPOT_CLIENT_SECRET: z.string().optional(),
  HUBSPOT_BASE_URL: z.string().url().default("https://api.hubapi.com"),
  OPENAI_API_KEY: z.string().optional(),
  EXA_API_KEY: z.string().optional(),
  EXA_MAX_BUDGET_USD: z.coerce.number().nonnegative().default(20),
  DIFFBOT_TOKEN: z.string().optional(),
  OPENAI_WEB_SEARCH_MODEL: z.string().default("gpt-5.4-mini"),
  OPENAI_PRE_RESEARCH_MODEL: z.string().optional(),
  OPENAI_DEEP_RESEARCH_MODEL: z.string().optional(),
  OPENAI_WEB_SEARCH_ENABLED: booleanFlag().default("true"),
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
  AZURE_OPENAI_DEPLOYMENT: z.string().default("gpt-5.4-mini"),
  AZURE_OPENAI_CLASSIFIER_DEPLOYMENT: z.string().optional(),
  AZURE_AI_CLASSIFICATION_CONCURRENCY: z.coerce.number().int().positive().default(10),
  CONTACT_DISCOVERY_CONCURRENCY: z.coerce.number().int().positive().default(6),
  HUBSPOT_SYNC_CONCURRENCY: z.coerce.number().int().positive().default(3),
  AZURE_OPENAI_API_VERSION: z.string().default("2024-10-21"),
  AZURE_OPENAI_INPUT_COST_PER_1K_TOKENS: z.coerce.number().nonnegative().default(0),
  AZURE_OPENAI_OUTPUT_COST_PER_1K_TOKENS: z.coerce.number().nonnegative().default(0),
  AZURE_OPENAI_MAX_COST_USD: z.coerce.number().nonnegative().default(5),
  AI_COST_INPUT_EUR_PER_MILLION: z.coerce.number().nonnegative().optional(),
  AI_COST_INPUT_EUR_PER_MILLION_TOKENS: z.coerce.number().nonnegative().optional(),
  AI_COST_OUTPUT_EUR_PER_MILLION: z.coerce.number().nonnegative().optional(),
  AI_COST_OUTPUT_EUR_PER_MILLION_TOKENS: z.coerce.number().nonnegative().optional(),
  AI_DAILY_BUDGET_EUR: z.coerce.number().nonnegative().optional(),
  FOUNDRY_PROJECT_ENDPOINT: z.string().url().optional(),
  FOUNDRY_MODEL_DEPLOYMENT: z.string().optional(),
  FOUNDRY_BING_CONNECTION_NAME: z.string().optional(),
  FOUNDRY_USE_AGENT_FILTERS: booleanFlag().default("false"),
  FOUNDRY_USE_AGENT_QUALIFICATION: booleanFlag().default("false"),
  FOUNDRY_USE_AGENT_RESEARCH: booleanFlag().default("false"),
  AZURE_RESEARCH_ENABLED: z
    .string()
    .transform((value) => value.toLowerCase() === "true")
    .default("false"),
  AZURE_RESEARCH_ENDPOINT: z.string().optional()
});

export const env = envSchema.parse(process.env);

export const openAIWebSearchModels = {
  preResearch: env.OPENAI_PRE_RESEARCH_MODEL ?? env.OPENAI_WEB_SEARCH_MODEL,
  deepResearch: env.OPENAI_DEEP_RESEARCH_MODEL ?? env.OPENAI_WEB_SEARCH_MODEL
};

const inputCostPer1kTokens =
  env.AI_COST_INPUT_EUR_PER_MILLION_TOKENS !== undefined
    ? env.AI_COST_INPUT_EUR_PER_MILLION_TOKENS / 1000
    : env.AI_COST_INPUT_EUR_PER_MILLION !== undefined
      ? env.AI_COST_INPUT_EUR_PER_MILLION / 1000
      : env.AZURE_OPENAI_INPUT_COST_PER_1K_TOKENS;

const outputCostPer1kTokens =
  env.AI_COST_OUTPUT_EUR_PER_MILLION_TOKENS !== undefined
    ? env.AI_COST_OUTPUT_EUR_PER_MILLION_TOKENS / 1000
    : env.AI_COST_OUTPUT_EUR_PER_MILLION !== undefined
      ? env.AI_COST_OUTPUT_EUR_PER_MILLION / 1000
      : env.AZURE_OPENAI_OUTPUT_COST_PER_1K_TOKENS;

const maxCostBudget = env.AI_DAILY_BUDGET_EUR ?? env.AZURE_OPENAI_MAX_COST_USD;

export const azureOpenAICostConfig = {
  inputCostPer1kTokens,
  outputCostPer1kTokens,
  maxCostUsd: maxCostBudget
};

export const readiness = {
  sharedKeyConfigured: Boolean(env.LEAD_AGENT_SHARED_KEY),
  apolloConfigured: Boolean(env.APOLLO_API_KEY),
  hubspotConfigured: Boolean(env.HUBSPOT_PRIVATE_APP_TOKEN),
  hubspotOAuthConfigured: Boolean(env.HUBSPOT_CLIENT_ID && env.HUBSPOT_CLIENT_SECRET),
  openAIWebSearchConfigured: Boolean(env.OPENAI_WEB_SEARCH_ENABLED && env.OPENAI_API_KEY),
  azureConfigured: Boolean(env.AZURE_OPENAI_API_KEY && env.AZURE_OPENAI_ENDPOINT),
  researchConfigured: Boolean(env.AZURE_RESEARCH_ENABLED && env.AZURE_RESEARCH_ENDPOINT),
  foundryConfigured: Boolean(env.FOUNDRY_PROJECT_ENDPOINT),
  foundryBingConfigured: Boolean(env.FOUNDRY_PROJECT_ENDPOINT && env.FOUNDRY_BING_CONNECTION_NAME),
  webSearchConfigured: Boolean(env.OPENAI_WEB_SEARCH_ENABLED && env.OPENAI_API_KEY),
  exaConfigured: Boolean(env.EXA_API_KEY),
  diffbotConfigured: Boolean(env.DIFFBOT_TOKEN)
};