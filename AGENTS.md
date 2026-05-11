# AGENTS

Repository rules for future agent runs:

- Use Apollo as the primary company database for organization discovery whenever Apollo credits are available.
- If company-level web search is needed for firm discovery or firm-only research context, use the OpenAI web search path, not DuckDuckGo, Bing scraping, or ad-hoc generic web search.
- Use `gpt-5.4-mini` for the OpenAI web-search path by default unless the operator explicitly overrides it.
- The OpenAI web search path may only receive organization-level inputs: company name, company website, country, short description, category, filter definitions, and similar firm data.
- Never send personal data to the OpenAI web search path. Do not send employee names, personal emails, personal phone numbers, LinkedIn profile URLs, or other person-level attributes.
- Do not use the OpenAI web search path for contact enrichment. Apollo remains the only allowed source in this codebase for the final contact-discovery step.
- General AI evaluation should prefer Azure AI / Foundry agents for search-strategy generation, prequalification, and deep research reasoning whenever Foundry is configured, using the low-cost GPT-5.4 mini deployment when available.
- OpenAI web search is a company-information retrieval layer, not the main evaluation agent.
