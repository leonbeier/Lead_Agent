/**
 * exa-planner-inspect.ts (no production code change)
 *
 * Runs the REAL Exa query planner (AzureOpenAIClient.planExaSearchQueries) against
 * live Azure for several target-category selections and prints the generated queries.
 * Used to verify the category-agnostic archetype framing produces V1-style, sensible
 * queries across ALL category combinations (service/delivery framing, no hardware-noun
 * drift), not just for one category.
 *
 * Requires AZURE_OPENAI_* in local .env. Does NOT call Exa (planner-only).
 */

import { AzureOpenAIClient } from "../src/clients/azure-openai";
import type { LeadCategory } from "../src/types";

function out(line: string): void {
  process.stdout.write(line + "\n");
}

interface Scenario {
  label: string;
  categories: LeadCategory[];
  keywords: string[];
  industries: string[];
  notes: string;
}

const SCENARIOS: Scenario[] = [
  {
    label: "integrator_relevant_focus (ALONE) — the problematic case",
    categories: ["integrator_relevant_focus"],
    keywords: ["machine vision", "industrial image processing", "system integration"],
    industries: ["Manufacturing", "Industrial Automation"],
    notes: "Find German solution/integration firms that deliver customer vision projects."
  },
  {
    label: "integrator_vision_industrial_ai (ALONE)",
    categories: ["integrator_vision_industrial_ai"],
    keywords: ["machine vision", "industrial image processing"],
    industries: ["Manufacturing"],
    notes: "Find machine-vision-focused industrial integrators in Germany."
  },
  {
    label: "camera_manufacturer_partner (ALONE) — product archetype, must NOT get delivery wording",
    categories: ["camera_manufacturer_partner"],
    keywords: ["industrial camera", "imaging sensor", "smart camera"],
    industries: ["Imaging Hardware"],
    notes: "Find German camera / imaging-sensor hardware manufacturers."
  },
  {
    label: "machine_builder_vision_ai (ALONE) — product archetype",
    categories: ["machine_builder_vision_ai"],
    keywords: ["inspection machine", "vision system", "special machinery"],
    industries: ["Machine Building"],
    notes: "Find German machine builders shipping vision-enabled machines."
  },
  {
    label: "industrial_end_customer_scaled (ALONE) — end customer archetype",
    categories: ["industrial_end_customer_scaled"],
    keywords: ["manufacturer", "production plant", "factory"],
    industries: ["Manufacturing"],
    notes: "Find German industrial producers operating their own factories at scale."
  },
  {
    label: "software_platform_embedding (ALONE) — software product archetype",
    categories: ["software_platform_embedding"],
    keywords: ["software platform", "workflow suite", "developer tools"],
    industries: ["Industrial Software"],
    notes: "Find German software-platform vendors."
  },
  {
    label: "MIXED integrator family (relevant_focus + vision_industrial + general)",
    categories: ["integrator_relevant_focus", "integrator_vision_industrial_ai", "integrator_general_ai"],
    keywords: ["machine vision", "industrial automation", "system integration"],
    industries: ["Manufacturing", "Industrial Automation"],
    notes: "Find German delivery-led integrators across the vision/AI integrator family."
  },
  {
    label: "MIXED integrator + camera (service + product together)",
    categories: ["integrator_vision_industrial_ai", "camera_manufacturer_partner"],
    keywords: ["machine vision", "industrial camera", "imaging"],
    industries: ["Manufacturing", "Imaging Hardware"],
    notes: "Find German vision integrators and camera makers."
  }
];

async function main(): Promise<void> {
  // Silence noisy client logs; keep our own output.
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  console.log = () => undefined;
  console.info = () => undefined;
  console.warn = () => undefined;

  const azure = new AzureOpenAIClient();

  // Capture the raw model output so we can inspect the generated queries even when the
  // strict locality validator rejects them (adjective "German" vs literal "Germany").
  const azAny = azure as unknown as { runChatWithTimeout: (...args: unknown[]) => Promise<string> };
  const originalRun = azAny.runChatWithTimeout.bind(azAny);
  let rawOutput = "";
  azAny.runChatWithTimeout = async (...args: unknown[]) => {
    const result = await originalRun(...args);
    rawOutput = result;
    return result;
  };

  const printQueriesFromRaw = (): void => {
    try {
      const parsed = JSON.parse(rawOutput) as { queries?: string[] };
      (parsed.queries ?? []).forEach((q, i) => out(`  Q${i + 1}: ${q}`));
      if (!parsed.queries || parsed.queries.length === 0) out("  (no queries in raw output)");
    } catch {
      out("  (could not parse raw output) " + rawOutput.slice(0, 300));
    }
  };

  let printedFraming = false;

  for (const scenario of SCENARIOS) {
    out("\n============================================================");
    out(scenario.label);
    out("categories: " + scenario.categories.join(", "));
    out("------------------------------------------------------------");

    let capturedSystem = "";
    rawOutput = "";
    let queries: string[] = [];
    try {
      queries = await azure.planExaSearchQueries(
        {
          name: "Inspect " + scenario.categories.join("+"),
          persona: "Decision makers",
          industries: scenario.industries,
          keywords: scenario.keywords,
          locations: ["Germany"],
          employeeRanges: ["11-50"],
          targetCategories: scenario.categories,
          notes: scenario.notes
        },
        [scenario.keywords[0] + " companies in Germany official websites"],
        undefined,
        false, // dryRun=false -> real Azure generation
        undefined,
        undefined,
        4,
        {
          requestedTargetCategories: scenario.categories,
          debugCapture: ({ promptMessages }) => {
            capturedSystem = promptMessages.find((m) => m.role === "system")?.content ?? "";
          }
        }
      );
    } catch (err) {
      out("  [locality validator rejected — showing RAW generated queries instead]");
      out("  (validator note: " + String(err).slice(0, 90) + "...)");
      printQueriesFromRaw();
      continue;
    }

    // Print the archetype framing block once (shared shape) for reference.
    if (!printedFraming && capturedSystem) {
      const start = capturedSystem.indexOf("Archetype-specific query framing:");
      if (start >= 0) {
        const endMarker = capturedSystem.indexOf("\n\n", start + 40);
        const snippet = endMarker > start ? capturedSystem.slice(start, endMarker) : capturedSystem.slice(start, start + 1400);
        out("[archetype framing block — shared across scenarios]");
        out(snippet);
        out("------------------------------------------------------------");
      }
      printedFraming = true;
    }

    queries.forEach((q, i) => out(`  Q${i + 1}: ${q}`));
    if (queries.length === 0) out("  (no queries returned)");
  }

  console.log = originalLog;
  console.info = originalInfo;
  console.warn = originalWarn;
}

main().catch((err) => {
  process.stdout.write("FATAL: " + String(err) + "\n");
  process.exit(1);
});
