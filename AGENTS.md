# AGENTS.md

You are an autonomous coding agent working on this repository.

## Main rule

Do not stop after changing files. Always install, run, build, test, validate, debug, and rerun checks before opening or updating a pull request.

## Local reproduction

Before making changes:

1. Inspect the repository.
2. Detect the framework and package manager.
3. Read README, package/config files, env examples, and deployment config.
4. Identify install, lint, typecheck, test, build, and start commands.
5. Run existing checks before changing code when practical.

## Validation loop

After every meaningful change:

1. Run the strongest available checks.
2. If something fails, inspect the error.
3. Fix the smallest root cause.
4. Rerun the failed command.
5. Repeat until it passes or an external blocker is proven.

Never claim success without validation output.

## External APIs

This app uses:

- HubSpot
- OpenAI
- Azure OpenAI
- Exa Search
- Railway

Use only development or sandbox credentials unless the issue explicitly allows production access.

Never hardcode secrets. Never print secrets. Never expose tokens to client-side code.

## Required environment variables

Document and validate these where applicable:

```env
HUBSPOT_ACCESS_TOKEN=
HUBSPOT_PRIVATE_APP_TOKEN=
OPENAI_API_KEY=
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_DEPLOYMENT=
EXA_API_KEY=
RAILWAY_TOKEN=
RAILWAY_PROJECT_ID=
PORT=
NODE_ENV=
LEAD_AGENT_SHARED_KEY=
LEAD_AGENT_PUBLIC_BASE_URL=
```

`HUBSPOT_PRIVATE_APP_TOKEN` is the actual runtime variable in this repository. `HUBSPOT_ACCESS_TOKEN` may appear in issue text for platform-neutral setup notes, but should not replace the runtime variable without a code change.

## API rules

External API clients must:

1. Run server-side only.
2. Read credentials from environment variables.
3. Fail clearly when required env vars are missing.
4. Handle auth errors, rate limits, invalid responses, timeouts, and network failures.
5. Return safe frontend errors.
6. Log sanitized metadata only.

## Railway rules

For Railway-related changes:

1. Confirm production build works.
2. Confirm start command works.
3. Confirm `PORT` is respected if required.
4. Document all Railway variables.
5. Do not modify production variables unless explicitly instructed.
6. Prefer dev Railway project validation.

## Pull request checklist

Every PR must include:

- Summary
- Files changed
- Commands run
- Command results
- Failed/skipped checks with reasons
- Required environment variables
- Manual test steps
- Known limitations

## Definition of done

A task is done only when:

1. The change is implemented.
2. Build passes.
3. Lint/typecheck/tests pass where available.
4. External APIs are mocked or safely tested.
5. Railway deployment requirements are documented.
6. The PR explains exactly how validation was done.

## Repository-specific rules

- Use `gpt-5.4-mini` for the OpenAI web-search path by default unless the operator explicitly overrides it.
- The OpenAI web search path may only receive organization-level inputs: company name, company website, country, short description, category, filter definitions, and similar firm data.
- Never send personal data to the OpenAI web search path. Do not send employee names, personal emails, personal phone numbers, LinkedIn profile URLs, or other person-level attributes.
- Do not use the OpenAI web search path for contact enrichment. Apollo remains the only allowed source in this codebase for the final contact-discovery step.
- General AI evaluation should prefer Azure AI / Foundry agents for search-strategy generation, prequalification, and deep research reasoning whenever Foundry is configured, using the low-cost GPT-5.4 mini deployment when available.
- OpenAI web search is a company-information retrieval layer, not the main evaluation agent.
- For non-dry-run company qualification, do not bypass Azure AI classification with manual heuristics or cached categorizations when a company domain is available. The required path is: website scraping or crawl first, then Azure AI or Foundry evaluation on the website evidence.
- For Exa Search and Diffbot Search results specifically, every candidate company with a domain must go through the website-scraping plus Azure AI check path before qualification decisions are trusted.
- When live Exa quality is poor, tune the Exa query-generation step and feed prior Exa query or history outcomes into the AI query planner; do not relax or retune the downstream AI screening or category logic just to improve hit rates.
- When running `hs project upload` in this repo and the CLI shows the profile picker with `leon [146645418]` preselected, press Enter immediately to accept the default profile.
