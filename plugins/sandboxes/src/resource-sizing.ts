import type {
  SandboxProvisionedResources,
  SandboxResourceSample,
} from "./backend.js";

export const sandboxSizingStateValues = [
  "collecting",
  "underprovisioned",
  "balanced",
  "overprovisioned",
] as const;
export type SandboxSizingState = (typeof sandboxSizingStateValues)[number];

export interface SandboxResourceAssessment {
  state: SandboxSizingState;
  sampleCount: number;
  observedMs: number;
  cpuP95Percent: number | null;
  memoryP95Percent: number | null;
  diskLatestPercent: number | null;
  /** cgroup memory.events `oom`: the group ran out of memory, kill or not. */
  oomEvents: number | null;
  /** cgroup memory.events `oom_kill`: processes the kernel actually killed. */
  oomKills: number | null;
  /** p95 of memory PSI `some avg60`: share of wall time stalled in reclaim. */
  memoryPressureP95: number | null;
  cpuThrottledPeriods: number | null;
  cpuThrottledMs: number | null;
  provisioned: SandboxProvisionedResources | null;
  reasons: string[];
}

/**
 * PSI `some avg60` is the share of the last minute at least one task spent
 * stalled on memory reclaim. Below roughly 10% that is ordinary page-cache
 * churn; at or above it the workload is paying for memory it does not have,
 * and unlike a usage percentage it climbs before the first kill.
 */
const MEMORY_STALL_PERCENT = 10;
/**
 * A handful of throttled periods is normal burst behaviour. Losing 1% or more
 * of the observed wall clock to the quota ceiling means the ceiling binds.
 */
const CPU_THROTTLE_WALL_CLOCK_SHARE = 0.01;

function percentile(values: Array<number | null>, fraction: number): number | null {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

function ratioPercent(used: number | null, total: number | null): number | null {
  return used === null || total === null || total <= 0 ? null : 100 * used / total;
}

/**
 * cgroup counters are monotonic within one container but reset when the
 * sandbox is recreated, so only the upward steps are real growth.
 */
function counterDelta(
  samples: SandboxResourceSample[],
  read: (sample: SandboxResourceSample) => number | null,
): number | null {
  let previous: number | null = null;
  let delta: number | null = null;
  for (const sample of samples) {
    const value = read(sample);
    if (value === null) continue;
    if (previous !== null && value > previous) delta = (delta ?? 0) + (value - previous);
    else if (delta === null) delta = 0;
    previous = value;
  }
  return delta;
}

export function assessSandboxResources(input: {
  provisioned: SandboxProvisionedResources | null;
  samples: SandboxResourceSample[];
}): SandboxResourceAssessment {
  const { provisioned, samples } = input;
  const observedMs = samples.length < 2 ? 0 : samples.at(-1)!.sampledAt - samples[0]!.sampledAt;
  const cpuP95Percent = percentile(samples.map((sample) => sample.cpuUsagePercent), 0.95);
  const memoryP95Percent = percentile(
    // The cgroup limit the sample was taken against comes first: a
    // provider-declared size only fills in when the guest could not read one.
    samples.map((sample) => ratioPercent(sample.memoryUsageBytes, sample.memoryBytes ?? provisioned?.memoryBytes ?? null)),
    0.95,
  );
  const memoryPressureP95 = percentile(samples.map((sample) => sample.memoryPressureSomeAvg60), 0.95);
  const latest = samples.at(-1) ?? null;
  const diskLatestPercent = latest === null
    ? null
    : ratioPercent(latest.diskUsageBytes, latest.diskBytes ?? provisioned?.diskBytes ?? null);
  const oomEvents = counterDelta(samples, (sample) => sample.oomEvents);
  const oomKills = counterDelta(samples, (sample) => sample.oomKills);
  const cpuThrottledPeriods = counterDelta(samples, (sample) => sample.cpuThrottledPeriods);
  const cpuThrottledUsec = counterDelta(samples, (sample) => sample.cpuThrottledUsec);
  const cpuThrottledMs = cpuThrottledUsec === null ? null : cpuThrottledUsec / 1_000;
  const throttlingIsSustained = (cpuThrottledPeriods ?? 0) > 0 &&
    cpuThrottledMs !== null && observedMs > 0 &&
    cpuThrottledMs >= observedMs * CPU_THROTTLE_WALL_CLOCK_SHARE;

  const reasons: string[] = [];
  if ((oomKills ?? 0) > 0) {
    reasons.push(`${oomKills} process${oomKills === 1 ? " was" : "es were"} killed by the OOM killer`);
  }
  if ((memoryPressureP95 ?? 0) >= MEMORY_STALL_PERCENT) {
    reasons.push(`memory stalls held at ${memoryPressureP95!.toFixed(0)}% of wall time (PSI some avg60)`);
  }
  if ((cpuP95Percent ?? 0) >= 85) reasons.push(`p95 CPU is ${cpuP95Percent!.toFixed(0)}%`);
  if ((memoryP95Percent ?? 0) >= 85) {
    reasons.push(`p95 memory is ${memoryP95Percent!.toFixed(0)}% of the cgroup limit`);
  }
  if (throttlingIsSustained) {
    reasons.push(`the CPU quota throttled ${cpuThrottledPeriods} periods for ${(cpuThrottledMs! / 1_000).toFixed(1)}s`);
  }
  if ((diskLatestPercent ?? 0) >= 85) reasons.push(`disk is ${diskLatestPercent!.toFixed(0)}% full`);

  let state: SandboxSizingState = "collecting";
  if (samples.length >= 12 && observedMs >= 20 * 60_000) {
    if (reasons.length > 0) {
      state = "underprovisioned";
    } else if (
      samples.length >= 24 && observedMs >= 60 * 60_000 &&
      (cpuP95Percent === null || cpuP95Percent < 35) &&
      (memoryP95Percent === null || memoryP95Percent < 50) &&
      (diskLatestPercent === null || diskLatestPercent < 60) &&
      // Any measurable reclaim stall disqualifies a shrink, however calm the averages look.
      (memoryPressureP95 === null || memoryPressureP95 < 1)
    ) {
      state = "overprovisioned";
      reasons.push("p95 CPU and memory stayed well below allocated capacity");
    } else {
      state = "balanced";
      reasons.push("observed pressure stayed within the target operating range");
    }
  } else {
    reasons.push("Collecting at least 12 samples across 20 active minutes before recommending a size");
  }
  // An `oom` without an `oom_kill` means reclaim recovered; worth showing, but
  // it is not the fatal signal the two counters used to be collapsed into.
  if ((oomKills ?? 0) === 0 && (oomEvents ?? 0) > 0) {
    reasons.push(`${oomEvents} out-of-memory condition${oomEvents === 1 ? "" : "s"} resolved without a kill`);
  }
  return {
    state,
    sampleCount: samples.length,
    observedMs,
    cpuP95Percent,
    memoryP95Percent,
    diskLatestPercent,
    oomEvents,
    oomKills,
    memoryPressureP95,
    cpuThrottledPeriods,
    cpuThrottledMs,
    provisioned,
    reasons,
  };
}
