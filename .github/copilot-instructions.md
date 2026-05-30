# Lead Agent – Copilot Instructions

## Safety Rules

- Never refactor code that is not directly required by the task.
- Never remove or weaken existing functionality, guards, or filters.
- Never change REST endpoint paths, request shapes, or response shapes.
- Never rename exported types, interfaces, or functions (e.g. `LeadJobRequest`, `ResearchBrief`, `GeneratedLeadRecord`).
- Prefer the smallest possible diff. One focused change per task.
- Never hardcode secrets, API keys, or tokens. Always read them from environment variables.
- Never send personal data (names, emails, phone numbers, LinkedIn URLs) to the OpenAI web-search path.

## Architecture

### Stack
- **Runtime**: Node.js + TypeScript (`tsx` for dev, `tsc` for production build)
- **Framework**: Express (REST API server in `src/server.ts`)
- **AI providers**: Azure OpenAI / Azure AI Foundry (primary), OpenAI web-search (company data only)
- **Data sources**: Apollo (contacts), Exa Search, Diffbot, open-crawler, HubSpot
- **Key files**:
  - `src/types.ts` – all shared types and DTOs; treat as the contract
  - `src/agents/` – pipeline orchestration (`lead-pipeline.ts`, `lead-worker-run.ts`)
  - `src/clients/` – one file per external service; server-side only
  - `src/server.ts` – Express routes (do not change route paths without explicit approval)
  - `src/config.ts` – environment variable loading and validation

### Data flow
```
LeadJobRequest → search (Exa / Apollo / crawler / Diffbot)
              → Azure AI prefilter (website scrape + classification)
              → outreach prep (Azure AI / Foundry)
              → HubSpot sync
              → LeadJobResult / LatestLeadRunRecord
```

### AI provider rules
- Azure AI / Foundry is the primary evaluation and reasoning layer.
- OpenAI web-search is **only** for company-level data retrieval (name, domain, description, country, category). Never for contact enrichment.
- Apollo is the sole allowed source for the final contact-discovery step.
- For Exa and Diffbot results, every candidate with a domain must go through website scraping + Azure AI classification before a qualification decision is trusted.

## Workflow

Before implementing any change:

1. Read the relevant source files to understand the current behaviour.
2. Describe the planned change (what will be added, modified, or removed).
3. If the change affects `src/types.ts`, REST routes, HubSpot sync logic, or AI provider routing, **wait for explicit confirmation** before proceeding.

## Testing & Validation

After every change:

1. Run `npm run typecheck` – must produce zero errors.
2. Run `npm run test` – must pass.
3. Run `npm run check` to execute both at once.
4. Confirm no exported type or interface was renamed or structurally changed.
5. Confirm no REST endpoint path or response shape was altered.
6. Confirm no secret or personal data flows to a disallowed destination.

## Environment Variables

All credentials must come from environment variables. Required variables are:

```
HUBSPOT_PRIVATE_APP_TOKEN
OPENAI_API_KEY
AZURE_OPENAI_ENDPOINT
AZURE_OPENAI_API_KEY
AZURE_OPENAI_DEPLOYMENT
EXA_API_KEY
RAILWAY_TOKEN
RAILWAY_PROJECT_ID
PORT
NODE_ENV
LEAD_AGENT_SHARED_KEY
LEAD_AGENT_PUBLIC_BASE_URL
```

Fail clearly (logged error, process exit or safe HTTP error) when a required variable is absent.

## Pull Request Checklist

Every PR must document:

- Summary of the change
- Files modified
- Commands run and their output
- Any env vars added or changed
- Manual test steps
- Known limitations or follow-up items
