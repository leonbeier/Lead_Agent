---
name: Prepare repository for Copilot Coding Agent
about: Prepare the repository for reliable GitHub Copilot Coding Agent work, validation, and Railway readiness.
title: "Prepare repository for GitHub Copilot Coding Agent, Railway deployment, and external API validation"
labels: [copilot, infrastructure, documentation]
assignees: []
---

# Prepare repository for GitHub Copilot Coding Agent, Railway deployment, and external API validation

We already have the application working locally. Prepare the repository so that future work can be done reliably through GitHub Copilot Coding Agent.

## Goal

Set up the project so Copilot can run, validate, debug, and prepare Railway deployment work from GitHub without relying on undocumented local setup.

## Tasks

1. Inspect the current repository structure and detect:

   - framework
   - package manager
   - build command
   - dev or start command
   - lint command
   - typecheck command
   - test command
   - Railway deployment requirements

2. Create or update `.env.example` with all required variables, but no real secrets.

3. Create or update `README.md` with:

   - local setup
   - required environment variables
   - GitHub Copilot Agent setup
   - Railway deployment setup
   - HubSpot, OpenAI, Azure, and Exa API notes
   - validation commands
   - troubleshooting section

4. Create or update `AGENTS.md` with strict instructions for Copilot Coding Agent.

5. Add or update project scripts if missing:

   - `lint`
   - `typecheck`
   - `test`
   - `build`
   - `start`

   Only add scripts that make sense for the detected framework. Do not invent fake commands that fail.

6. Add basic health or smoke validation if missing.

7. Ensure external API clients are server-side only.

8. Ensure API clients:

   - read secrets from environment variables
   - never expose secrets to frontend code
   - handle missing env vars clearly
   - handle `401`, `403`, `429`, `500`, timeout, and network errors safely
   - log sanitized metadata only

9. Railway preparation:

   - verify production build works
   - verify start command works
   - verify app uses `PORT` if required
   - document Railway variables in README
   - add `railway.json` only if useful for this project

10. Run validation:

   - install dependencies
   - lint if available
   - typecheck if available
   - tests if available
   - production build
   - smoke test if possible

## Pull request requirements

The PR must include:

- summary of all repository preparation changes
- detected framework and package manager
- exact commands run
- result of every command
- skipped checks with reason
- required GitHub Copilot secrets
- required Railway variables
- remaining manual setup steps

## Important

Do not use or commit real secrets.

Do not mark the task complete unless validation has passed or blockers are clearly documented.

If a command fails, debug it, fix the root cause, and rerun the command. Do not stop after the first failure.