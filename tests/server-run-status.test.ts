import test from "node:test";
import assert from "node:assert/strict";
import { shouldUseCachedLiveSearchDebug } from "../src/server";

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