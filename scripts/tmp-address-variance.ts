import { HubSpotClient } from "../src/clients/hubspot";

// Reproduce the parallel worker load: ONE shared HubSpotClient resolving many companies' addresses
// concurrently (like a real batch), to see whether the plain-only /impressum fetch degrades under
// contention and drops the address. Logs per-domain: final address completeness + elapsed ms.
// Also directly probes the plain fetch byte length of the key impressum page for mak-cet.de.
const DOMAINS = [
  "mak-cet.de",
  "acerosrl.com",
  "winspect.info",
  "fmvision.it",
  "scorpionvision.com",
  "sygvision.com",
  "blickfeld.com",
  "athenais.tech",
  "maxiluxsystems.com",
  "ateq.com"
];

async function main() {
  const client = new HubSpotClient() as unknown as {
    resolveCompanyAddress: (c: unknown) => Promise<{ companyName?: string; address?: string; city?: string; zip?: string; country?: string } | null>;
    fetchHtml: (url: string, allowBrowser?: boolean) => Promise<string | null>;
  };

  // First, isolate the plain-fetch behavior of the mak-cet.de impressum a few times.
  console.log("--- plain-fetch /impressum byte lengths (mak-cet.de), 3x sequential ---");
  for (let i = 0; i < 3; i++) {
    const html = await client.fetchHtml("https://mak-cet.de/impressum", false);
    console.log(`  attempt ${i + 1}: plainLen=${html ? html.length : "null"}`);
  }

  console.log("\n--- resolveCompanyAddress for all domains IN PARALLEL (batch load) ---");
  const started = Date.now();
  const results = await Promise.all(
    DOMAINS.map(async (domain) => {
      const t0 = Date.now();
      const company = { name: domain, domain, country: "Germany", shortDescription: "", sourceFilter: "diag", category: "integrator_vision_industrial_ai" as const, relevanceScore: 8, rationale: "diag" };
      const addr = await client.resolveCompanyAddress(company).catch((e) => ({ err: String(e) } as Record<string, unknown>));
      return { domain, ms: Date.now() - t0, addr };
    })
  );
  console.log(`total wall ms: ${Date.now() - started}\n`);
  for (const r of results) {
    const a = r.addr as { address?: string; city?: string; zip?: string; companyName?: string } | null;
    const hasStreet = Boolean(a && a.address);
    console.log(`${r.domain} | ${r.ms}ms | street=${hasStreet ? "YES" : "EMPTY"} | name=${a?.companyName ?? "-"} | ${a?.address ?? ""} ${a?.zip ?? ""} ${a?.city ?? ""}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
