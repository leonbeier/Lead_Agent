import fs from "node:fs/promises";
import path from "node:path";

import { OpenAIWebSearchClient } from "../src/clients/openai-web-search";
import { ApolloOrganizationFilter, CompanySample } from "../src/types";

const OUTPUT_PATH = path.join(process.cwd(), "data", "diffbot", "website_only_discovery_candidates.json");
const TARGET_LOCATIONS = ["Germany", "France", "Italy", "Netherlands", "Switzerland", "Sweden", "Austria", "Spain"];
const SEARCH_CLUSTERS: Array<{
  slug: string;
  persona: string;
  keywords: string[];
  notes: string;
}> = [
  {
    slug: "vision-integrators",
    persona: "Machine-vision and industrial inspection integrator with customer project delivery and official company website",
    keywords: [
      "machine vision integrator",
      "industrial image processing",
      "computer vision engineering services",
      "optical quality control",
      "automated optical inspection",
      "inline inspection",
      "machine vision integration",
      "industrial inspection"
    ],
    notes: "Primary website-only cluster for delivery-led machine-vision and inspection firms."
  },
  {
    slug: "automation-software",
    persona: "Industrial automation software and system integration firm with recurring implementation ownership and official company website",
    keywords: [
      "industrial automation integrator",
      "mes system integrator",
      "scada system integrator",
      "plc software integration",
      "ot integration",
      "industrial software services",
      "manufacturing software implementation",
      "automation software engineering"
    ],
    notes: "Broader software-and-automation cluster to catch integrators that do not lead with vision wording."
  },
  {
    slug: "embedded-vision",
    persona: "Embedded software and computer-vision engineering services company serving industrial customers through delivery work",
    keywords: [
      "embedded vision engineering",
      "embedded software services",
      "industrial imaging integration",
      "edge ai integration",
      "industrial software engineering",
      "image processing services",
      "computer vision consultant",
      "inspection ai consultant"
    ],
    notes: "Catches smaller specialists and consulting-heavy firms with hands-on implementation capability."
  },
  {
    slug: "smart-factory",
    persona: "Smart-factory and production-software engineering partner implementing systems for manufacturers with an official company website",
    keywords: [
      "smart factory software",
      "production data integration",
      "industrial digitalization",
      "manufacturing execution systems",
      "industrial engineering services",
      "production software services",
      "factory automation engineering",
      "control systems integrator"
    ],
    notes: "Adds adjacent factory-software partners where vision use cases are plausible even if not explicit in the homepage copy."
  }
];

function buildFilter(location: string, cluster: (typeof SEARCH_CLUSTERS)[number]): ApolloOrganizationFilter {
  return {
    name: `Website-only ${cluster.slug} ${location}`,
    persona: cluster.persona,
    industries: ["Industrial Automation", "System Integration", "Industrial Software", "Engineering Services"],
    keywords: cluster.keywords,
    locations: [location],
    employeeRanges: ["1,10", "11,50", "51,200", "201,500", "501,1000"],
    notes: `${cluster.notes} Return official company sites only and avoid directories, media, marketplaces, and profiles.`
  };
}

function dedupeCompanies(companies: CompanySample[]): CompanySample[] {
  const seen = new Set<string>();
  const deduped: CompanySample[] = [];

  for (const company of companies) {
    const key = `${company.name.trim().toLowerCase()}::${company.domain?.trim().toLowerCase() ?? ""}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(company);
  }

  return deduped;
}

async function main() {
  const webSearchClient = new OpenAIWebSearchClient();
  const discoveredByCluster = await Promise.all(
    TARGET_LOCATIONS.flatMap((location) =>
      SEARCH_CLUSTERS.map(async (cluster) => ({
        location,
        cluster: cluster.slug,
        companies: await webSearchClient.discoverCompanies(buildFilter(location, cluster), 20, 1)
      }))
    )
  );

  const discoveredByLocation = TARGET_LOCATIONS.map((location) => ({
    location,
    companies: dedupeCompanies(
      discoveredByCluster
        .filter((entry) => entry.location === location)
        .flatMap((entry) => entry.companies)
    )
  }));

  const discoveredByLocationAndCluster = TARGET_LOCATIONS.map((location) => ({
    location,
    clusters: SEARCH_CLUSTERS.map((cluster) => ({
      cluster: cluster.slug,
      companies: dedupeCompanies(
        discoveredByCluster
          .filter((entry) => entry.location === location && entry.cluster === cluster.slug)
          .flatMap((entry) => entry.companies)
      )
    }))
  }));

  const allCompanies = dedupeCompanies(discoveredByLocation.flatMap((entry) => entry.companies));
  const payload = {
    createdAt: new Date().toISOString(),
    mode: "website-only",
    targetLocations: TARGET_LOCATIONS,
    searchClusters: SEARCH_CLUSTERS.map((cluster) => ({
      slug: cluster.slug,
      persona: cluster.persona,
      keywords: cluster.keywords
    })),
    totalCompanies: allCompanies.length,
    byLocation: discoveredByLocation.map((entry) => ({
      location: entry.location,
      count: entry.companies.length,
      companies: entry.companies
    })),
    byLocationAndCluster: discoveredByLocationAndCluster.map((entry) => ({
      location: entry.location,
      clusters: entry.clusters.map((cluster) => ({
        cluster: cluster.cluster,
        count: cluster.companies.length,
        companies: cluster.companies
      }))
    })),
    companies: allCompanies
  };

  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    outputPath: OUTPUT_PATH,
    totalCompanies: allCompanies.length,
    byLocation: discoveredByLocation.map((entry) => ({ location: entry.location, count: entry.companies.length }))
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});