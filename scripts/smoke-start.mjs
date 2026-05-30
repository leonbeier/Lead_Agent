import { spawn } from "node:child_process";

const port = Number(process.env.PORT || 3210);
const baseUrl = `http://127.0.0.1:${port}`;
const sharedKey = process.env.LEAD_AGENT_SHARED_KEY || "local-smoke-shared-key-1234567890";
const startupTimeoutMs = 20_000;
const requestIntervalMs = 500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(deadline) {
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(`Unexpected health status ${response.status}`);
      }

      if (payload?.status !== "ok") {
        throw new Error(`Unexpected health payload: ${JSON.stringify(payload)}`);
      }

      return payload;
    } catch (error) {
      lastError = error;
      await delay(requestIntervalMs);
    }
  }

  throw lastError || new Error("Timed out waiting for /health");
}

const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || "test",
    PORT: String(port),
    LEAD_AGENT_SHARED_KEY: sharedKey
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";

child.stdout.on("data", (chunk) => {
  stdout += String(chunk);
});

child.stderr.on("data", (chunk) => {
  stderr += String(chunk);
});

try {
  const payload = await waitForHealth(Date.now() + startupTimeoutMs);
  console.log(JSON.stringify({ baseUrl, payload }, null, 2));
} catch (error) {
  const details = [
    error instanceof Error ? error.message : String(error),
    stdout ? `stdout:\n${stdout.trim()}` : "",
    stderr ? `stderr:\n${stderr.trim()}` : ""
  ].filter(Boolean).join("\n\n");
  throw new Error(`Smoke test failed.\n\n${details}`);
} finally {
  child.kill();
}