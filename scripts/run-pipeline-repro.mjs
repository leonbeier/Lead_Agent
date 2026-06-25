import { spawn } from "node:child_process";

/**
 * Button-press runner for the opt-in full company-pipeline reproduction test.
 *
 * Sets RUN_LIVE_PIPELINE_REPRO=1 (cross-platform, no cross-env dependency) and runs the live
 * regression that feeds the reference 20 companies through the real worker logic
 * (name + address resolution and public contact discovery incl. Foundry + LinkedIn enrichment).
 *
 * Usage:
 *   npm run test:pipeline-repro
 *   railway run npm run test:pipeline-repro      (with injected Azure/Foundry/HubSpot creds)
 *
 * Optional: PIPELINE_REPRO_FOUNDRY_TIMEOUT_MS to tune the per-company contact budget.
 */
const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", "tests/clients/company-pipeline-repro.test.ts"],
  {
    stdio: "inherit",
    env: { ...process.env, RUN_LIVE_PIPELINE_REPRO: "1" }
  }
);

child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
