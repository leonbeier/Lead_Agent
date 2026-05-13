import express from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { env, readiness } from "./config";
import { ControlPlaneStore } from "./control-plane";
import { defaultApolloFilters } from "./filters";
import { LeadPipelineAgent } from "./agents/lead-pipeline";
import { CATEGORY_EXECUTION_CONTEXT } from "./prompting/one-ware-playbook";
import { LeadRunProgress } from "./types";

const app = express();

type LeadRunStatus = LeadRunProgress & {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
};

const leadRunStatus: LeadRunStatus = {
  running: false,
  stage: "idle",
  stageLabel: "Bereit",
  progressValue: 0,
  progressMax: 100,
  progressDescription: "Noch kein aktiver Lead-Run.",
  updatedAt: new Date(0).toISOString()
};
const leadPipelineAgent = new LeadPipelineAgent();
const controlPlaneStore = new ControlPlaneStore();
const hubSpotConsolePath = path.join(process.cwd(), "public", "hubspot-ui", "index.html");
const publicRoutes = new Set(["/health", "/oauth-callback"]);
const selectableCategorySchema = z.enum([
  "integrator_vision_industrial_ai",
  "integrator_general_ai",
  "integrator_relevant_focus",
  "industrial_end_customer_scaled",
  "camera_manufacturer_partner",
  "machine_builder_ai_enablement",
  "software_platform_embedding"
]);

const prequalificationCategoryContextSchema = z.object({
  classificationRules: z.array(z.string().min(1)).max(12).optional(),
  disqualifiers: z.array(z.string().min(1)).max(12).optional(),
  addOnContext: z.string().max(3000).optional()
});

const executionCategoryContextSchema = z.object({
  researchPriorities: z.array(z.string().min(1)).max(12).optional(),
  outreachPriorities: z.array(z.string().min(1)).max(12).optional(),
  personalizationRules: z.array(z.string().min(1)).max(12).optional(),
  avoidSignals: z.array(z.string().min(1)).max(12).optional()
});

const prequalificationConfigSchema = z.object({
  mainContext: z.string().max(6000).optional(),
  categoryContexts: z.object({
    integrator_vision_industrial_ai: prequalificationCategoryContextSchema.optional(),
    integrator_general_ai: prequalificationCategoryContextSchema.optional(),
    integrator_relevant_focus: prequalificationCategoryContextSchema.optional(),
    industrial_end_customer_scaled: prequalificationCategoryContextSchema.optional(),
    camera_manufacturer_partner: prequalificationCategoryContextSchema.optional(),
    machine_builder_ai_enablement: prequalificationCategoryContextSchema.optional(),
    software_platform_embedding: prequalificationCategoryContextSchema.optional()
  }).optional()
});

const executionContextsSchema = z.object({
  integrator_vision_industrial_ai: executionCategoryContextSchema.optional(),
  integrator_general_ai: executionCategoryContextSchema.optional(),
  integrator_relevant_focus: executionCategoryContextSchema.optional(),
  industrial_end_customer_scaled: executionCategoryContextSchema.optional(),
  camera_manufacturer_partner: executionCategoryContextSchema.optional(),
  machine_builder_ai_enablement: executionCategoryContextSchema.optional(),
  software_platform_embedding: executionCategoryContextSchema.optional()
});

const leadJobSchema = z.object({
  targetLeadCount: z.coerce.number().int().positive().max(1000),
  market: z.string().optional(),
  mainContext: z.string().max(12000).optional(),
  searchStrategyContext: z.string().max(12000).optional(),
  companySearchMode: z.enum(["internet_research", "apollo_search"]).optional(),
  creditLessMode: z.boolean().optional(),
  prequalification: prequalificationConfigSchema.optional(),
  prequalificationContext: z.string().max(4000).optional(),
  executionContexts: executionContextsSchema.optional(),
  targetCategories: z.array(selectableCategorySchema).min(1).optional(),
  runDeepResearch: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  syncToHubSpot: z.boolean().optional(),
  disableHubSpotDeduplication: z.boolean().optional(),
  earlyStopEnabled: z.boolean().optional(),
  earlyStopReviewCount: z.coerce.number().int().min(5).max(15).optional(),
  earlyStopThreshold: z.coerce.number().min(0).max(1).optional()
});

const settingsUpdateSchema = z.object({
  targetLeadCount: z.coerce.number().int().positive().max(1000).optional(),
  market: z.string().min(1).optional(),
  mainContext: z.string().max(12000).optional(),
  searchStrategyContext: z.string().max(12000).optional(),
  companySearchMode: z.enum(["internet_research", "apollo_search"]).optional(),
  creditLessMode: z.boolean().optional(),
  prequalification: prequalificationConfigSchema.optional(),
  prequalificationContext: z.string().max(4000).optional(),
  executionContexts: executionContextsSchema.optional(),
  targetCategories: z.array(selectableCategorySchema).min(1).optional(),
  runDeepResearch: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  earlyStopEnabled: z.boolean().optional(),
  earlyStopReviewCount: z.coerce.number().int().min(5).max(15).optional(),
  earlyStopThreshold: z.coerce.number().min(0).max(1).optional()
});

const templateUpdateSchema = z.object({
  audience: z.string().min(1).optional(),
  goal: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  emailBody: z.string().min(1).optional(),
  linkedInMessage: z.string().min(1).optional(),
  phoneScript: z.string().min(1).optional()
});

const learningFeedbackSchema = z.object({
  companyName: z.string().min(1),
  domain: z.string().optional(),
  verdict: z.enum(["accept", "reject"]),
  reason: z.string().min(1)
});

app.use(express.json());

app.use((request, response, next) => {
  if (publicRoutes.has(request.path)) {
    next();
    return;
  }

  const forwardedFor = request.headers["x-forwarded-for"];
  const forwardedIp = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor?.split(",")[0]?.trim();
  const requestIp = forwardedIp ?? request.ip ?? "";
  const isLocalRequest = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(requestIp);

  if (isLocalRequest) {
    next();
    return;
  }

  const headerKey = request.get("x-lead-agent-key") ?? request.get("authorization")?.replace(/^Bearer\s+/i, "");
  const queryKey = typeof request.query.key === "string" ? request.query.key : undefined;
  const providedKey = headerKey ?? queryKey;

  if (providedKey !== env.LEAD_AGENT_SHARED_KEY) {
    response.status(401).json({
      error: "Unauthorized"
    });
    return;
  }

  next();
});

async function buildLeadJobPayload(body: Record<string, unknown>) {
  const settings = await controlPlaneStore.getSettings();
  const legacyPrequalificationContext = typeof body.prequalificationContext === "string"
    ? body.prequalificationContext
    : settings.prequalificationContext;
  const companySearchMode = body.companySearchMode === "internet_research" || body.companySearchMode === "apollo_search"
    ? body.companySearchMode
    : typeof body.creditLessMode === "boolean"
      ? (body.creditLessMode ? "internet_research" : "apollo_search")
      : settings.companySearchMode;
  const prequalification = (body.prequalification ?? settings.prequalification) ??
    (legacyPrequalificationContext ? { mainContext: legacyPrequalificationContext } : undefined);

  return leadJobSchema.parse({
    targetLeadCount: body.targetLeadCount ?? settings.targetLeadCount ?? env.DEFAULT_TARGET_LEADS,
    market: body.market ?? settings.market ?? env.DEFAULT_MARKET,
    mainContext: body.mainContext ?? settings.mainContext,
    searchStrategyContext: body.searchStrategyContext ?? settings.searchStrategyContext,
    companySearchMode,
    creditLessMode: companySearchMode === "internet_research",
    prequalification,
    prequalificationContext: legacyPrequalificationContext,
    executionContexts: body.executionContexts ?? settings.executionContexts,
    targetCategories: body.targetCategories ?? settings.targetCategories,
    runDeepResearch: body.runDeepResearch ?? settings.runDeepResearch,
    dryRun: body.dryRun ?? settings.dryRun,
    syncToHubSpot: body.syncToHubSpot,
    disableHubSpotDeduplication: body.disableHubSpotDeduplication,
    earlyStopEnabled: body.earlyStopEnabled ?? settings.earlyStopEnabled,
    earlyStopReviewCount: body.earlyStopReviewCount ?? settings.earlyStopReviewCount,
    earlyStopThreshold: body.earlyStopThreshold ?? settings.earlyStopThreshold
  });
}

async function exchangeHubSpotOAuthCode(code: string, redirectUri: string) {
  if (!env.HUBSPOT_CLIENT_ID || !env.HUBSPOT_CLIENT_SECRET) {
    throw new Error("HubSpot OAuth is not configured. Set HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET.");
  }

  const response = await fetch(`${env.HUBSPOT_BASE_URL}/oauth/v1/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.HUBSPOT_CLIENT_ID,
      client_secret: env.HUBSPOT_CLIENT_SECRET,
      redirect_uri: redirectUri,
      code
    })
  });

  const payload = await response.json() as {
    hub_id?: number;
    access_token?: string;
    refresh_token?: string;
    message?: string;
    status?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !payload.access_token || !payload.refresh_token) {
    throw new Error(
      payload.error_description ||
      payload.message ||
      payload.error ||
      payload.status ||
      "HubSpot OAuth token exchange failed."
    );
  }

  return payload;
}

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "lead-agent",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/config/readiness", (_request, response) => {
  response.json({
    port: env.PORT,
    readiness
  });
});

app.get("/hubspot", (_request, response) => {
  response.redirect("/hubspot/ui");
});

app.get("/hubspot/ui", (request, response) => {
  const html = readFileSync(hubSpotConsolePath, "utf8");
  const sharedKey = typeof request.query.key === "string" ? request.query.key : "";

  response.type("html").send(
    html
      .replace(/__LEAD_AGENT_SHARED_KEY__/g, sharedKey)
      .replace(/__LEAD_AGENT_PUBLIC_BASE_URL__/g, env.LEAD_AGENT_PUBLIC_BASE_URL ?? "")
  );
});

app.get("/oauth-callback", async (request, response) => {
  const code = typeof request.query.code === "string" ? request.query.code : "";

  if (!code) {
    response.status(400).send("Missing HubSpot OAuth code.");
    return;
  }

  try {
    const publicBaseUrl = env.LEAD_AGENT_PUBLIC_BASE_URL ?? `${request.protocol}://${request.get("host")}`;
    const redirectUri = new URL("/oauth-callback", publicBaseUrl).toString();
    const oauthPayload = await exchangeHubSpotOAuthCode(code, redirectUri);

    console.log("HubSpot UI app connected", {
      hubId: oauthPayload.hub_id ?? "unknown"
    });

    response.status(200).send("ONE WARE Lead Agent UI was connected successfully. You can close this window and return to HubSpot.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "HubSpot OAuth callback failed.";
    response.status(500).send(message);
  }
});

app.get("/api/control-plane/bootstrap", async (_request, response, next) => {
  try {
    response.json(await controlPlaneStore.getBootstrap());
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/settings", async (_request, response, next) => {
  try {
    response.json({
      settings: await controlPlaneStore.getSettings()
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/control/settings", async (request, response, next) => {
  try {
    response.json({
      settings: await controlPlaneStore.updateSettings(settingsUpdateSchema.parse(request.body))
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/apollo/filter-presets", (_request, response) => {
  response.json({
    filters: defaultApolloFilters
  });
});

app.get("/api/outreach/templates", async (_request, response, next) => {
  try {
    response.json({
      templates: Object.values(await controlPlaneStore.getTemplates())
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/outreach/contexts", (_request, response) => {
  response.json({
    categoryContexts: Object.values(CATEGORY_EXECUTION_CONTEXT)
  });
});

app.get("/api/control/learning", async (_request, response, next) => {
  try {
    response.json({
      learning: await controlPlaneStore.getLearning()
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/latest-lead-run", async (_request, response, next) => {
  try {
    response.json({
      latestLeadRun: await controlPlaneStore.getLatestLeadRun()
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/run-status", (_request, response) => {
  response.json({
    runStatus: leadRunStatus
  });
});

app.post("/api/control/learning/feedback", async (request, response, next) => {
  try {
    response.json({
      learning: await controlPlaneStore.recordCompanyFeedback(learningFeedbackSchema.parse(request.body))
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/outreach/templates/:key", async (request, response, next) => {
  try {
    response.json({
      template: await controlPlaneStore.updateTemplate(request.params.key, templateUpdateSchema.parse(request.body))
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/lead-jobs/preview", async (request, response, next) => {
  try {
    const payload = await buildLeadJobPayload(request.body as Record<string, unknown>);

    response.json(await leadPipelineAgent.preview(payload));
  } catch (error) {
    next(error);
  }
});

app.post("/api/lead-jobs/run", async (request, response, next) => {
  try {
    const payload = await buildLeadJobPayload(request.body as Record<string, unknown>);

    const result = await leadPipelineAgent.run(payload);
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/hubspot/workflow-trigger", async (request, response, next) => {
  try {
    if (leadRunStatus.running) {
      response.status(409).json({
        trigger: "hubspot-ui",
        accepted: false,
        runStatus: leadRunStatus,
        error: "A lead run is already in progress."
      });
      return;
    }

    const payload = await buildLeadJobPayload(request.body as Record<string, unknown>);

    leadRunStatus.running = true;
    leadRunStatus.startedAt = new Date().toISOString();
    leadRunStatus.finishedAt = undefined;
    leadRunStatus.lastError = undefined;
    leadRunStatus.stage = "starting";
    leadRunStatus.stageLabel = "Lead-Run startet";
    leadRunStatus.progressValue = 2;
    leadRunStatus.progressMax = 100;
    leadRunStatus.progressDescription = "Der Lead Agent initialisiert die Suche.";
    leadRunStatus.detail = "Die Zielparameter wurden uebernommen und der Lauf wird vorbereitet.";
    leadRunStatus.processedFilters = 0;
    leadRunStatus.totalFilters = undefined;
    leadRunStatus.foundCandidates = 0;
    leadRunStatus.targetLeadCount = payload.targetLeadCount;
    leadRunStatus.updatedAt = new Date().toISOString();

    void leadPipelineAgent.run(payload, {
      onProgress: (progress) => {
        leadRunStatus.stage = progress.stage;
        leadRunStatus.stageLabel = progress.stageLabel;
        leadRunStatus.progressValue = progress.progressValue;
        leadRunStatus.progressMax = progress.progressMax;
        leadRunStatus.progressDescription = progress.progressDescription;
        leadRunStatus.detail = progress.detail;
        leadRunStatus.processedFilters = progress.processedFilters;
        leadRunStatus.totalFilters = progress.totalFilters;
        leadRunStatus.foundCandidates = progress.foundCandidates;
        leadRunStatus.targetLeadCount = progress.targetLeadCount;
        leadRunStatus.updatedAt = progress.updatedAt;
      }
    })
      .then((result) => {
        leadRunStatus.running = false;
        leadRunStatus.stage = "completed";
        leadRunStatus.stageLabel = "Abgeschlossen";
        leadRunStatus.progressValue = 100;
        leadRunStatus.progressMax = 100;
        leadRunStatus.progressDescription = `${result.shortlistedCompanies.length} qualifizierte Firmen abgeschlossen`;
        leadRunStatus.detail = result.hubspotSync.mode === "live"
          ? `${result.hubspotSync.companySyncedCount} Firmen nach HubSpot synchronisiert.`
          : "Dry-Run abgeschlossen. Es wurde nichts nach HubSpot geschrieben.";
        leadRunStatus.processedFilters = result.evaluations.length;
        leadRunStatus.totalFilters = result.suggestedFilters.length;
        leadRunStatus.foundCandidates = result.shortlistedCompanies.length;
        leadRunStatus.targetLeadCount = payload.targetLeadCount;
        leadRunStatus.updatedAt = new Date().toISOString();
        leadRunStatus.finishedAt = new Date().toISOString();
      })
      .catch((error) => {
        leadRunStatus.running = false;
        leadRunStatus.stage = "failed";
        leadRunStatus.stageLabel = "Fehlgeschlagen";
        leadRunStatus.progressDescription = "Der Lead-Run ist mit einem Fehler abgebrochen.";
        leadRunStatus.detail = error instanceof Error ? error.message : "Unknown error";
        leadRunStatus.updatedAt = new Date().toISOString();
        leadRunStatus.finishedAt = new Date().toISOString();
        leadRunStatus.lastError = error instanceof Error ? error.message : "Unknown error";
        console.error("Lead run failed", error);
      });

    response.status(202).json({
      trigger: "hubspot-ui",
      accepted: true,
      runStatus: leadRunStatus
    });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  response.status(500).json({
    error: message
  });
});

export function startServer(): void {
  app.listen(env.PORT, () => {
    console.log(`Lead Agent listening on port ${env.PORT}`);
  });
}