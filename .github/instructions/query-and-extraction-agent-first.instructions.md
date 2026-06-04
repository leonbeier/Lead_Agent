---
description: "Use when editing Exa query planning, Azure prompt generation, website extraction, HubSpot preview/sync extraction, or search strategy logic. Requires hard AI constraints, structured outputs, and no heuristic repairs without approval."
name: "Query And Extraction Agent First"
applyTo: "src/clients/azure-openai.ts,src/clients/hubspot.ts,src/agents/**,tests/clients/**,tests/agents/**"
---
# Query And Extraction Agent First

## Query planning

- Treat locality, market scope, and selected categories as hard constraints.
- Put those constraints explicitly in the prompt under a hard-constraints section.
- Require the model to return structured constraint checks alongside queries.
- If the planner cannot satisfy the constraints, return a structured planner error instead of silently broadening or substituting queries.
- Do not add code that repairs, broadens, or silently replaces planner output.

## Website and contact extraction

- Prefer agent extraction from raw page content over handcrafted parsing rules.
- Prefer multi-stage agent workflows: page selection agent, extraction agent, normalization/selection agent.
- Require agents to emit structured JSON that names evidence sources.
- Do not keep adding custom text heuristics because websites vary in format.

## Approval rule

- If you think a heuristic parser, regex, fallback query, or post-processing rule is required, do not implement it directly.
- Explain why the agent/prompt/schema path is insufficient.
- Ask the user for permission before writing that heuristic code.