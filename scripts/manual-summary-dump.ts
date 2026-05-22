import { WebSearchAgent } from "../src/clients/web-search-agent";

const companies = [
  ["IronFlock GmbH", "https://www.ironflock.com"],
  ["FUSE-AI GmbH", "https://www.fuse-ai.de"],
  ["Image Access GmbH", "https://www.imageaccess.de"],
  ["WFF IT-Service GmbH", "https://www.wff-it.de"],
  ["zolitron", "https://www.zolitron.com"]
] as const;

async function main() {
  const searchAgent = new WebSearchAgent();

  for (const [name, domain] of companies) {
    const profile = await searchAgent.crawlCompanyWebsite(domain);
    process.stdout.write(`--- ${name} ---\n`);
    process.stdout.write(`${profile?.summary ?? "<no-summary>"}\n\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
