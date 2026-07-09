import fs from "node:fs";
import os from "node:os";

// The lead agent runs browser navigation (Chromium) and synchronous multi-MB HTML parsing on the
// SAME small container it shares with the Node event loop. Under a live run those compete for CPU,
// and page.goto uses a WALL-CLOCK timer: when the container has only a fraction of the cores the
// pipeline THINKS it has, the browser's completion callback is starved past its timeout even though
// Chromium already rendered the DOM — the measured production-only "zero pages → empty
// address/contacts" defect that a 22-core dev box structurally cannot reproduce.
//
// os.cpus()/os.availableParallelism() report the HOST core count inside a shared-vCPU container
// (Railway), so a 2-vCPU container looks like a 32-core box and the pipeline over-schedules. The
// cgroup CPU quota is the only signal that reflects the ENFORCED allowance, so we read it directly
// and derive every heavy-fan-out ceiling from it. This is infrastructure resource management, not
// an AI-output heuristic.

export interface RuntimeResourceProfile {
  /** Real CPU allowance: cgroup quota when present, otherwise the host core count. */
  effectiveCpuCount: number;
  /** Host core count as reported by the OS (may over-report inside a container). */
  hostCpuCount: number;
  /** cgroup CPU quota in whole-core units, or null when unlimited/unavailable. */
  cgroupCpuLimit: number | null;
  /** Memory limit enforced by the cgroup in GB, or null when unlimited/unavailable. */
  memoryLimitGb: number | null;
  /** Total host memory in GB. */
  hostMemoryGb: number;
  /** Which cgroup version the CPU limit was read from, for diagnostics. */
  cgroupSource: "v2" | "v1" | "none";
}

function readCgroupCpuLimit(): { limit: number | null; source: "v2" | "v1" | "none" } {
  // cgroup v2: "/sys/fs/cgroup/cpu.max" contains "<quota> <period>" or "max <period>".
  try {
    const raw = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim();
    const [quotaRaw, periodRaw] = raw.split(/\s+/);
    if (quotaRaw && quotaRaw !== "max") {
      const quota = Number(quotaRaw);
      const period = Number(periodRaw) || 100_000;
      if (quota > 0 && period > 0) {
        return { limit: quota / period, source: "v2" };
      }
    }
    // A present cpu.max with "max" means unlimited under v2.
    if (quotaRaw === "max") {
      return { limit: null, source: "v2" };
    }
  } catch {
    // Not on cgroup v2 (or no permission); fall through to v1.
  }

  // cgroup v1: separate quota/period files. quota == -1 means unlimited.
  try {
    const quota = Number(fs.readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf8").trim());
    const period = Number(fs.readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf8").trim());
    if (quota > 0 && period > 0) {
      return { limit: quota / period, source: "v1" };
    }
    if (quota === -1) {
      return { limit: null, source: "v1" };
    }
  } catch {
    // No cgroup CPU controller available.
  }

  return { limit: null, source: "none" };
}

function readCgroupMemoryLimitBytes(): number | null {
  // cgroup v2
  try {
    const raw = fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
    if (raw && raw !== "max") {
      const value = Number(raw);
      // A "no limit" configuration is reported as a huge sentinel (~2^63); ignore anything that
      // exceeds the host memory, which cannot be a real per-container limit.
      if (value > 0 && value < os.totalmem() * 4) {
        return value;
      }
    }
  } catch {
    // fall through to v1
  }
  try {
    const value = Number(fs.readFileSync("/sys/fs/cgroup/memory/memory.limit_in_bytes", "utf8").trim());
    if (value > 0 && value < os.totalmem() * 4) {
      return value;
    }
  } catch {
    // no cgroup memory controller
  }
  return null;
}

let cachedProfile: RuntimeResourceProfile | null = null;

/**
 * Detects the real CPU/memory allowance of the current process. Cached after the first call because
 * the container's cgroup limits do not change during a process lifetime.
 */
export function getRuntimeResourceProfile(): RuntimeResourceProfile {
  if (cachedProfile) {
    return cachedProfile;
  }

  const hostCpuCount = Math.max(1, os.cpus()?.length || 1);
  const { limit: cgroupCpuLimit, source: cgroupSource } = readCgroupCpuLimit();
  // Use the cgroup allowance when it is BELOW the host core count (i.e. the container is genuinely
  // constrained). Never let a rounding artefact push the effective count above the host cores.
  const effectiveCpuCount = cgroupCpuLimit && cgroupCpuLimit < hostCpuCount
    ? Math.max(1, cgroupCpuLimit)
    : hostCpuCount;

  const memoryLimitBytes = readCgroupMemoryLimitBytes();

  cachedProfile = {
    effectiveCpuCount,
    hostCpuCount,
    cgroupCpuLimit,
    memoryLimitGb: memoryLimitBytes ? memoryLimitBytes / 1024 ** 3 : null,
    hostMemoryGb: os.totalmem() / 1024 ** 3,
    cgroupSource
  };
  return cachedProfile;
}

/**
 * Clamps a requested heavy-fan-out concurrency to what the container can actually run in parallel.
 *
 * `perCoreFactor` lets a stage that is NOT purely CPU-bound (HTTP/Azure-bound AI prefilter) exceed
 * the raw core count a little, while a browser/parse-bound stage uses factor 1 so it never schedules
 * more heavy work than there are cores to run it — the contention that fires page.goto's wall-clock
 * timeout in production. On an unconstrained dev box the effective core count is large, so the
 * requested maximum is returned unchanged and local behaviour is unaffected.
 */
export function resolveResourceAwareConcurrency(requestedMax: number, perCoreFactor = 1): number {
  const { effectiveCpuCount } = getRuntimeResourceProfile();
  const ceiling = Math.max(1, Math.floor(effectiveCpuCount * perCoreFactor));
  return Math.max(1, Math.min(requestedMax, ceiling));
}

// Absolute ceiling on concurrent Chromium lanes regardless of how large the container is: each lane
// holds an open page (~100-200 MB) and the /dev/shm-disabled Chromium writes to /tmp, so this bounds
// peak browser memory well within a small container.
const MAX_BROWSER_LANES = 4;

/**
 * Resolves how many Chromium lanes may run in parallel, scaled to the container's real CPU + memory.
 *
 * Too FEW lanes is the measured production defect: a company's page-collection burst (~11 browser
 * fetches) queued behind only 2 lanes drains slower than the 45s collection budget, so slow
 * companies are written with ZERO contacts. The benchmark on the live 8-core/7.45 GB container
 * showed a 22-deep browser queue finishes in ~33s with 4 lanes (well under budget) at zero
 * infrastructure failures, while 2 lanes push the same burst onto the 45s edge. Draining faster on a
 * well-resourced box is therefore the SAFER choice — it removes the queue starvation that strands
 * companies. On a genuinely constrained container the count drops to 1 so the single core is never
 * contended by two browser navigations (which is what fires page.goto's wall-clock timeout). An
 * explicit WEBSITE_BROWSER_CONCURRENCY override always wins, still bounded by MAX_BROWSER_LANES.
 */
export function resolveBrowserLaneCount(): number {
  const override = Number.parseInt(process.env.WEBSITE_BROWSER_CONCURRENCY ?? "", 10);
  if (Number.isFinite(override) && override >= 1) {
    return Math.min(MAX_BROWSER_LANES, override);
  }

  const { effectiveCpuCount, memoryLimitGb, hostMemoryGb } = getRuntimeResourceProfile();
  const memoryGb = memoryLimitGb ?? hostMemoryGb;

  if (effectiveCpuCount < 2 || memoryGb < 2) {
    return 1;
  }
  if (effectiveCpuCount >= 6 && memoryGb >= 6) {
    return MAX_BROWSER_LANES;
  }
  if (effectiveCpuCount >= 4 && memoryGb >= 4) {
    return 3;
  }
  return 2;
}

/** Resets the cached profile. Test-only. */
export function resetRuntimeResourceProfileCacheForTests(): void {
  cachedProfile = null;
}

/** One-line summary for startup logging so the enforced allowance is visible in the container logs. */
export function describeRuntimeResourceProfile(): string {
  const profile = getRuntimeResourceProfile();
  const cpu = profile.cgroupCpuLimit
    ? `${profile.effectiveCpuCount.toFixed(2)} cores (cgroup ${profile.cgroupSource} quota; host reports ${profile.hostCpuCount})`
    : `${profile.effectiveCpuCount} cores (no cgroup quota; host)`;
  const mem = profile.memoryLimitGb
    ? `${profile.memoryLimitGb.toFixed(2)} GB (cgroup)`
    : `${profile.hostMemoryGb.toFixed(2)} GB (host)`;
  return `runtime resources: cpu=${cpu}, mem=${mem}`;
}
