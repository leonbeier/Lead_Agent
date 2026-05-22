# AGENTS

Repository rules for future agent runs:

- Use `gpt-5.4-mini` for the OpenAI web-search path by default unless the operator explicitly overrides it.
- The OpenAI web search path may only receive organization-level inputs: company name, company website, country, short description, category, filter definitions, and similar firm data.
- Never send personal data to the OpenAI web search path. Do not send employee names, personal emails, personal phone numbers, LinkedIn profile URLs, or other person-level attributes.
- Do not use the OpenAI web search path for contact enrichment. Apollo remains the only allowed source in this codebase for the final contact-discovery step.
- General AI evaluation should prefer Azure AI / Foundry agents for search-strategy generation, prequalification, and deep research reasoning whenever Foundry is configured, using the low-cost GPT-5.4 mini deployment when available.
- OpenAI web search is a company-information retrieval layer, not the main evaluation agent.
- For non-dry-run company qualification, do not bypass Azure AI classification with manual heuristics or cached categorizations when a company domain is available. The required path is: website scraping/crawl first, then Azure AI / Foundry evaluation on the website evidence.
- For Exa Search and Diffbot Search results specifically, every candidate company with a domain must go through the website-scraping + Azure AI check path before qualification decisions are trusted.
- When running `hs project upload` in this repo and the CLI shows the profile picker with `leon [146645418]` preselected, do not wait at the interactive prompt; press Enter immediately to accept the default profile.
