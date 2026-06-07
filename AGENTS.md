# AGENTS.md

You are an autonomous coding agent working on this repository.

## Main rule

Do not stop after changing files. Always install, run, build, test, validate, debug, and rerun checks before opening or updating a pull request.

## Required workflow

Follow this order every time unless the user explicitly asks for a different process:

1. Reproduce the problem and identify the real root cause.
2. Fix the smallest root-cause slice. Do not look for workaround paths around the bug.
3. Validate locally as hard as possible before changing environments. Prefer focused tests first, then broader build/typecheck/test validation.
4. Keep changes minimal. Do not add heuristic or filter-based patches unless the user explicitly requests them. Prefer Azure AI / Foundry / agent-based automation over new manual heuristics when automation is the intended path.
5. Deploy the verified fix to Railway when the task requires live behavior.
6. Commit the verified fix to GitHub when the user asks for it.
7. Test the deployed behavior, inspect failures, and repeat the same loop until the live issue is actually resolved.

Do not skip directly to deployment or broad workaround changes before local reproduction, root-cause identification, and local validation are done.

## Agent-first rule

This repository is **agent first**.

When behavior depends on interpreting websites, contact pages, company descriptions, search queries, search-strategy reasoning, locality/scope preservation, category selection, or output formatting:

- Prefer agent prompts, structured agent outputs, and chained agent stages over handwritten parsing logic.
- Prefer prompt composition, schema design, and agent-to-agent handoff payloads over new regexes, keyword scoring, post-processing heuristics, or text-repair code.
- Treat AI outputs as contracts that must be improved at the prompt/schema level when they are wrong.
- If the AI output is unreliable, fix the prompt, schema, retry strategy, or explicit failure mode first.
- Do not silently repair, broaden, normalize, or reinterpret AI output with custom code unless the user explicitly approves that heuristic path.

## Heuristic approval rule

Do **not** add new heuristic parsing, text-repair, regex extraction, keyword rules, scoring rules, fallback queries, default-query substitution, post-processing guards, or silent output normalization for AI-driven flows unless all of the following are true:

1. You are confident an agent/prompt/schema solution is not viable or would be materially worse.
2. You explain that conclusion to the user.
3. The user explicitly approves the heuristic implementation.

If approval is missing, stop at the agent/prompt/schema design step and do not ship the heuristic workaround.

## Query-planning rule

For Exa query planning and search-strategy generation:

- Locality, market scope, and selected categories are hard constraints, not soft hints.
- Do not repair planner mistakes with fallback/default queries or silent locality guards unless the user explicitly approves that heuristic path.
- When the planner violates locality or scope, first strengthen the prompt, output schema, and explicit failure contract.
- Prefer structured planner outputs that self-report constraint satisfaction.

## Extraction rule

For company/address/contact extraction:

- Do not keep adding custom website text parsing logic just because page formats differ.
- Prefer agent prompts that consume raw page content and return normalized structured outputs.
- Prefer multi-step agent pipelines where one agent identifies relevant pages and another agent extracts the structured facts.
- If a non-AI parser is truly unavoidable, ask the user before adding it.

## Filter and deduplication rules

**Do not bypass or weaken filters.** The system is intentionally designed with:

- HubSpot deduplication (to avoid duplicate sync writes)
- Screening database cache (to remember prior rejections)
- Query history exclusion (to discover new companies each run, not repeat old ones)
- Exa excluded domains lists (to avoid known bad sources)

**Do not workaround these filters by:**
- Removing HubSpot domain dedup logic
- Allowing cached rejected companies back in
- Ignoring query history to re-use old searches
- Bypassing excluded domain lists

These are features, not bugs. If a run produces fewer than expected results, investigate the real root cause (timeouts, AI qualification rigor, contact discovery gaps) rather than disabling filters. Use Azure AI and data inspection to improve quality, not heuristic shortcuts.

Do not look for side doors around the actual problem. That includes trying to bypass HubSpot duplicate checks, re-allow previously screened-out companies, ignore current search history, or skip Exa excluded websites just to force more output. Each run is supposed to generate fresh queries and respect excluded websites so the result set stays new and non-duplicative.

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
- Contact discovery defaults to the web scraper (crawling public company pages) and browser search with LinkedIn filter.
- General AI evaluation should prefer Azure AI / Foundry agents for search-strategy generation, prequalification, and deep research reasoning whenever Foundry is configured, using the low-cost GPT-5.4 mini deployment when available.
- OpenAI web search is a company-information retrieval layer, not the main evaluation agent.
- For non-dry-run company qualification, do not bypass Azure AI classification with manual heuristics or cached categorizations when a company domain is available. The required path is: website scraping or crawl first, then Azure AI or Foundry evaluation on the website evidence.
- For Exa Search and Diffbot Search results specifically, every candidate company with a domain must go through the website-scraping plus Azure AI check path before qualification decisions are trusted.
- Only companies whose post-AI category matches one of the currently selected target categories may be created or synced in HubSpot. Non-matching companies must stay in the rejected/screening list and must not enter the outreach, contact, or HubSpot write path.
- When live Exa quality is poor, tune the Exa query-generation step and feed prior Exa query or history outcomes into the AI query planner; do not relax or retune the downstream AI screening or category logic just to improve hit rates.
- Do not solve bad company/contact data quality by adding blanket suppression filters as a first response. Investigate root cause first (crawl gaps, extraction quality, timeouts, AI selection quality, write-path errors) and prefer preserving valid records while improving extraction and selection quality.
- Treat these as bad hits that must not be accepted as successful outreach records:
	- Company names that are generic/noise labels (for example `Ai`, `Company`, `Web Development Company in Germany`) instead of a plausible legal or brand entity name.
	- Contacts with no usable channel after normalization (no email, no phone, no personal LinkedIn profile).
	- Company-LinkedIn-only placeholders (`linkedin.com/company/...`) being treated as person contacts.
	- Mailbox-only contacts that have neither a person name nor a role signal and are not needed as explicit fallback evidence.
	- Runs reported as successful without writing at least one high-quality contact path for the batch (personal LinkedIn or clearly named reachable contact).
- When running `hs project upload` in this repo and the CLI shows the profile picker with `leon [146645418]` preselected, press Enter immediately to accept the default profile.

## Mandatory HubSpot quality check after every live run

**Before marking any task as complete, always run this check using the HubSpot API** (`api-eu1.hubapi.com`, token from `HUBSPOT_PRIVATE_APP_TOKEN` env variable):

### Step 1 — Minimum company count
Query the last 5 created companies. If fewer than 5 were written in the most recent run, investigate and fix before stopping.

```js
// Node.js snippet
const https = require('https');
const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
// POST /crm/v3/objects/companies/search with sort=-createdate, limit=5
// properties: name, domain, city, country, description, phone
```

### Step 2 — Company data quality (for each of the 5 companies)
Check ALL of these. If any fail, fix the root cause:
- **Name is a real legal identity** (e.g. `MSM Markier-Sensor-Systeme GmbH`, not `Msm Technik` or generic labels)
- **domain is set** (not empty)
- **country is set**
- **description is a real company description**, not `"Manual debug website input."`
- **city is set** (missing city means address extraction failed — investigate)
- **phone is set** (missing phone means contact page crawl missed it — investigate)

### Step 3 — Contact quality (for each company, fetch associated contacts)
For each company, query `/crm/v3/objects/companies/{id}/associations/contacts` then fetch each contact with properties: `firstname, lastname, email, jobtitle, hs_linkedin_url, phone`.

Check ALL of these. If any fail, fix the root cause:
- **Every company has at least 1 contact** (even a generic info@ is acceptable as fallback)
- **Majority of companies have a LinkedIn contact** — a contact where `hs_linkedin_url` contains `/in/` (personal profile, NOT `/company/`)
- **Contacts with a personal name** (firstname + lastname are real person names, NOT email addresses like `info@...` or `Mailinfo`)
- **No company LinkedIn URLs stored as contact `hs_linkedin_url`** — `linkedin.com/company/...` must never appear in this field
- **Generic mailboxes (info@, kontakt@, etc.) must NOT have firstname set to the email address** — they should either be skipped or stored with empty firstname/lastname

### Step 4 — Verdict
Only stop when:
1. ≥5 companies written in last run
2. All 5 have real legal names, domain, country
3. Majority have a LinkedIn contact with personal `/in/` URL
4. No generic mailbox stored with email-as-firstname
5. No company LinkedIn URL in contact field
