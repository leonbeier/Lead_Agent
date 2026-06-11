import test from "node:test";
import assert from "node:assert/strict";
import { shouldUseCachedLiveSearchDebug, toLeanRunStatusPayload } from "../src/server";

test("cached live search debug is used when it is newer than the current run status", () => {
  assert.equal(
    shouldUseCachedLiveSearchDebug("2026-06-04T09:00:00.000Z", "2026-06-04T09:05:00.000Z"),
    true
  );
});

test("cached live search debug is ignored when the current run status is newer", () => {
  assert.equal(
    shouldUseCachedLiveSearchDebug("2026-06-04T10:00:00.000Z", "2026-06-04T09:05:00.000Z"),
    false
  );
});

test("cached live search debug is ignored when the cache timestamp is invalid", () => {
  assert.equal(
    shouldUseCachedLiveSearchDebug("2026-06-04T10:00:00.000Z", undefined),
    false
  );
});

test("cached live search debug is used when the current run status has no valid timestamp", () => {
  assert.equal(
    shouldUseCachedLiveSearchDebug(undefined, "2026-06-04T09:05:00.000Z"),
    true
  );
});

test("lean run-status payload strips the heavy planner prompt messages but keeps the poll fields", () => {
  const runStatus = {
    running: true,
    stage: "running" as const,
    stageLabel: "Suche läuft",
    progressValue: 50,
    progressMax: 100,
    progressDescription: "läuft",
    updatedAt: "2026-06-11T18:00:00.000Z",
    liveSearchDebug: {
      filterName: "Europe Vision System Integrators",
      lastExecutedQuery: "vision integrators",
      currentBatchQueryStats: [{ query: "vision integrators", returnedResults: 10 }],
      promptMessages: [
        { role: "system", content: "x".repeat(40_000) },
        { role: "user", content: "y".repeat(40_000) }
      ]
    }
  } as unknown as Parameters<typeof toLeanRunStatusPayload>[0];

  const lean = toLeanRunStatusPayload(runStatus);

  assert.equal(lean.liveSearchDebug?.promptMessages, undefined);
  assert.equal(lean.liveSearchDebug?.filterName, "Europe Vision System Integrators");
  assert.deepEqual(lean.liveSearchDebug?.currentBatchQueryStats, [
    { query: "vision integrators", returnedResults: 10 }
  ]);
  // The original status object must not be mutated (it is the live run state).
  assert.equal(runStatus.liveSearchDebug?.promptMessages?.length, 2);
  // The serialized lean payload must be small enough to flush in a single response under load.
  assert.ok(JSON.stringify(lean).length < 2_000);
});

test("lean run-status payload is a no-op when there are no planner prompt messages", () => {
  const runStatus = {
    running: false,
    stage: "idle" as const,
    stageLabel: "Bereit",
    progressValue: 0,
    progressMax: 100,
    progressDescription: "Noch kein aktiver Lead-Run.",
    updatedAt: "2026-06-11T18:00:00.000Z"
  } as unknown as Parameters<typeof toLeanRunStatusPayload>[0];

  assert.equal(toLeanRunStatusPayload(runStatus), runStatus);
});