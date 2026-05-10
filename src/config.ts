import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const booleanFlag = () =>
  z
    .string()
    .transform((value) => value.toLowerCase() === "true");

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DEFAULT_MARKET: z.string().default("DE"),
  DEFAULT_TARGET_LEADS: z.coerce.number().int().positive().default(50),
  LEAD_AGENT_SHARED_KEY: z.string().min(24),
  LEAD_AGENT_PUBLIC_BASE_URL: z.string().url().optional(),
  APOLLO_API_KEY: z.string().optional(),
  APOLLO_BASE_URL: z.string().url().default("https://api.apollo.io/api/v1"),
  HUBSPOT_PRIVATE_APP_TOKEN: z.string().optional(),
  HUBSPOT_BASE_URL: z.string().url().default("https://api.hubapi.com"),
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
  AZURE_OPENAI_DEPLOYMENT: z.string().default("gpt-4.1-mini"),
  AZURE_OPENAI_API_VERSION: z.string().default("2024-10-21"),
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

export const readiness = {
  sharedKeyConfigured: Boolean(env.LEAD_AGENT_SHARED_KEY),
  apolloConfigured: Boolean(env.APOLLO_API_KEY),
  hubspotConfigured: Boolean(env.HUBSPOT_PRIVATE_APP_TOKEN),
  azureConfigured: Boolean(env.AZURE_OPENAI_API_KEY && env.AZURE_OPENAI_ENDPOINT),
  researchConfigured: Boolean(env.AZURE_RESEARCH_ENABLED && env.AZURE_RESEARCH_ENDPOINT),
  foundryConfigured: Boolean(env.FOUNDRY_PROJECT_ENDPOINT),
  foundryBingConfigured: Boolean(env.FOUNDRY_PROJECT_ENDPOINT && env.FOUNDRY_BING_CONNECTION_NAME)
};