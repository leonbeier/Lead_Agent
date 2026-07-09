import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";

import {
  getRuntimeResourceProfile,
  resolveResourceAwareConcurrency,
  resolveBrowserLaneCount,
  resetRuntimeResourceProfileCacheForTests,
  describeRuntimeResourceProfile
} from "../src/runtime-resources";

test("getRuntimeResourceProfile reports a positive effective core count and is cached", () => {
  resetRuntimeResourceProfileCacheForTests();
  const first = getRuntimeResourceProfile();
  assert.ok(first.effectiveCpuCount >= 1, "effectiveCpuCount must be at least 1");
  assert.ok(first.hostCpuCount >= 1, "hostCpuCount must be at least 1");
  // Effective allowance can never exceed the host cores.
  assert.ok(first.effectiveCpuCount <= first.hostCpuCount, "effective cores cannot exceed host cores");
  // Second call returns the identical cached object.
  const second = getRuntimeResourceProfile();
  assert.equal(first, second);
});

test("resolveResourceAwareConcurrency never exceeds the requested max or drops below 1", () => {
  resetRuntimeResourceProfileCacheForTests();
  const requested = 12;
  const resolved = resolveResourceAwareConcurrency(requested);
  assert.ok(resolved >= 1, "must be at least 1");
  assert.ok(resolved <= requested, "must not exceed the requested max");
  // On any real host with >= `requested` cores the requested value passes through unchanged.
  if (os.cpus().length >= requested) {
    assert.equal(resolved, requested);
  }
});

test("resolveResourceAwareConcurrency respects perCoreFactor without exceeding the requested max", () => {
  resetRuntimeResourceProfileCacheForTests();
  const withFactor = resolveResourceAwareConcurrency(8, 2);
  const withoutFactor = resolveResourceAwareConcurrency(8, 1);
  assert.ok(withFactor >= withoutFactor, "a higher perCoreFactor must not reduce the ceiling");
  assert.ok(withFactor <= 8, "must still respect the requested max");
});

test("describeRuntimeResourceProfile returns a non-empty human-readable summary", () => {
  resetRuntimeResourceProfileCacheForTests();
  const summary = describeRuntimeResourceProfile();
  assert.match(summary, /runtime resources: cpu=/);
  assert.match(summary, /mem=/);
});

test("resolveBrowserLaneCount stays within the memory-safe ceiling and honours an override", () => {
  const original = process.env.WEBSITE_BROWSER_CONCURRENCY;
  try {
    resetRuntimeResourceProfileCacheForTests();
    delete process.env.WEBSITE_BROWSER_CONCURRENCY;
    const lanes = resolveBrowserLaneCount();
    assert.ok(lanes >= 1, "must schedule at least one lane");
    assert.ok(lanes <= 4, "must never exceed the memory-safe ceiling of 4 lanes");

    // An explicit override is honoured, still bounded by the ceiling.
    process.env.WEBSITE_BROWSER_CONCURRENCY = "3";
    assert.equal(resolveBrowserLaneCount(), 3);
    process.env.WEBSITE_BROWSER_CONCURRENCY = "99";
    assert.equal(resolveBrowserLaneCount(), 4);
  } finally {
    if (original === undefined) {
      delete process.env.WEBSITE_BROWSER_CONCURRENCY;
    } else {
      process.env.WEBSITE_BROWSER_CONCURRENCY = original;
    }
  }
});
