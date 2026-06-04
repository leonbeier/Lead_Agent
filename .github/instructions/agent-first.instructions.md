---
description: "Use when designing, changing, or debugging AI-driven extraction, website interpretation, search-query planning, prompt composition, company/contact parsing, or any workflow that could drift into handwritten heuristics. Enforces the repository's agent-first policy."
name: "Agent First Workflow"
applyTo: "src/**,tests/**,scripts/**"
---
# Agent First Workflow

- This repository is agent first. Prefer prompt design, schema design, and agent chaining over handwritten parsing logic.
- If a workflow reads websites, builds search queries, interprets company data, normalizes text, or selects contacts, first ask how an agent should do that job.
- Do not solve AI-quality failures by adding regexes, string rewrites, keyword lists, score boosts, fallback queries, default substitutions, or post-processing guards.
- Fix the prompt, output schema, retry policy, or explicit failure mode first.
- If you believe a heuristic is truly unavoidable, stop and ask the user before implementing it.

## Required decision order

1. Can the task be solved by a better prompt?
2. Can the task be solved by structured JSON output with stricter fields?
3. Can the task be solved by splitting the work across multiple agent stages?
4. Can the task be solved by surfacing a loud planner/extraction error instead of silently repairing output?
5. Only after all of the above, ask the user whether a heuristic fallback is acceptable.

## Forbidden without explicit user approval

- Regex-heavy website parsing for AI-driven extraction paths
- Silent query fallback to default or baseline queries
- Post-processing AI output to reinsert locality, category, or scope constraints
- Heuristic text cleanups that change AI meaning rather than validating shape
- New keyword/rule engines for contact, address, or company classification when an agent stage could do the same work