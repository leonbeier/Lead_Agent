import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonFileWithRecovery } from "../src/control-plane";

test("readJsonFileWithRecovery backs up corrupted JSON and restores defaults", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lead-agent-control-plane-"));
  const filePath = path.join(tempDir, "corrupted.json");
  const defaultValue = { records: [] };

  try {
    await fs.writeFile(filePath, '{"records":[{"domain":"broken"}', "utf8");

    const recovered = await readJsonFileWithRecovery(filePath, defaultValue);
    const repairedContent = await fs.readFile(filePath, "utf8");
    const files = await fs.readdir(tempDir);
    const backupFile = files.find((entry) => entry.startsWith("corrupted.json.corrupt-"));

    assert.deepEqual(recovered, defaultValue);
    assert.deepEqual(JSON.parse(repairedContent), defaultValue);
    assert.ok(backupFile);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});