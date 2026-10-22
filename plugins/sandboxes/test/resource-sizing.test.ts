import { describe, expect, it } from "vitest";
import type { SandboxResourceSample } from "../src/backend.js";
import { assessSandboxResources } from "../src/resource-sizing.js";

const provisioned = {
  cpuCores: 4,
  memoryBytes: 8 * 1024 ** 3,
  diskBytes: 20 * 1024 ** 3,
};

function samples(input: {
  count: number;
  cpu: number;
  memoryPercent: number;
  diskPercent: number;
  oomEvents?: number;
  oomKills?: number;
  memoryStallPercent?: number;
}): SandboxResourceSample[] {
  return Array.from({ length: input.count }, (_, index) => ({
    ...provisioned,
    sampledAt: index * 5 * 60_000,
    cpuUsagePercent: input.cpu,
    memoryUsageBytes: provisioned.memoryBytes * input.memoryPercent / 100,
    diskUsageBytes: provisioned.diskBytes * input.diskPercent / 100,
    loadAverage1m: 1,
    oomEvents: input.oomEvents ?? 0,
    oomKills: input.oomKills ?? 0,
    memoryPeakBytes: provisioned.memoryBytes * input.memoryPercent / 100,
    memoryAnonBytes: provisioned.memoryBytes * input.memoryPercent / 200,
    memoryFileBytes: provisioned.memoryBytes * input.memoryPercent / 200,
    memorySlabReclaimableBytes: 16 * 1024 ** 2,
    cpuThrottledPeriods: 0,
    cpuThrottledUsec: 0,
    memoryPressureSomeAvg10: input.memoryStallPercent ?? 0,
    memoryPressureSomeAvg60: input.memoryStallPercent ?? 0,
    memoryPressureFullAvg10: 0,
    memoryPressureFullAvg60: 0,
    cpuPressureSomeAvg10: 0,
    cpuPressureSomeAvg60: 0,
    cpuPressureFullAvg10: 0,
    cpuPressureFullAvg60: 0,
  }));
}

describe("assessSandboxResources", () => {
  it("waits for representative active time before making a recommendation", () => {
    expect(assessSandboxResources({ provisioned, samples: samples({ count: 4, cpu: 10, memoryPercent: 20, diskPercent: 10 }) }).state).toBe("collecting");
  });

  it("calls out sustained memory pressure and OOMs as underprovisioned", () => {
    const observed = samples({ count: 24, cpu: 40, memoryPercent: 91, diskPercent: 30 });
    observed.at(-1)!.oomKills = 1;
    const result = assessSandboxResources({ provisioned, samples: observed });
    expect(result.state).toBe("underprovisioned");
    expect(result.reasons.join(" ")).toMatch(/out-of-memory|memory|OOM/iu);
  });

  it("flags OOM kills even when the usage percentages look calm", () => {
    const observed = samples({ count: 24, cpu: 12, memoryPercent: 22, diskPercent: 20 });
    for (const sample of observed.slice(12)) sample.oomKills = 2;
    const result = assessSandboxResources({ provisioned, samples: observed });
    expect(result.state).toBe("underprovisioned");
    expect(result.oomKills).toBe(2);
    expect(result.memoryP95Percent).toBeCloseTo(22, 5);
    expect(result.reasons.join(" ")).toMatch(/2 processes were killed by the OOM killer/u);
  });

  it("separates oom conditions that resolved without a kill from fatal ones", () => {
    const observed = samples({ count: 24, cpu: 12, memoryPercent: 22, diskPercent: 20 });
    for (const sample of observed.slice(6)) sample.oomEvents = 25;
    const result = assessSandboxResources({ provisioned, samples: observed });
    expect(result.oomEvents).toBe(25);
    expect(result.oomKills).toBe(0);
    expect(result.state).not.toBe("underprovisioned");
    expect(result.reasons.join(" ")).toMatch(/25 out-of-memory conditions resolved without a kill/u);
  });

  it("treats sustained memory stalls as pressure before any kill happens", () => {
    const result = assessSandboxResources({
      provisioned,
      samples: samples({ count: 24, cpu: 20, memoryPercent: 40, diskPercent: 20, memoryStallPercent: 14 }),
    });
    expect(result.state).toBe("underprovisioned");
    expect(result.memoryPressureP95).toBe(14);
    expect(result.reasons.join(" ")).toMatch(/memory stalls held at 14%/u);
  });

  it("measures memory against the cgroup limit the samples were taken under", () => {
    const observed = samples({ count: 24, cpu: 20, memoryPercent: 45, diskPercent: 20 });
    // The provider bills a 405 GB node; the kernel enforces 8 GiB.
    for (const sample of observed) sample.memoryBytes = 2 * 1024 ** 3;
    const result = assessSandboxResources({
      provisioned: { ...provisioned, memoryBytes: 405 * 1000 ** 3 },
      samples: observed,
    });
    expect(result.memoryP95Percent).toBeCloseTo(180, 5);
    expect(result.state).toBe("underprovisioned");
  });

  it("reports a quota that keeps binding, and ignores incidental throttling", () => {
    const throttled = samples({ count: 24, cpu: 30, memoryPercent: 30, diskPercent: 20 });
    throttled.forEach((sample, index) => {
      sample.cpuThrottledPeriods = index * 40;
      sample.cpuThrottledUsec = index * 900_000_000;
    });
    const result = assessSandboxResources({ provisioned, samples: throttled });
    expect(result.state).toBe("underprovisioned");
    expect(result.cpuThrottledPeriods).toBe(920);
    expect(result.reasons.join(" ")).toMatch(/CPU quota throttled 920 periods/u);

    const incidental = samples({ count: 24, cpu: 30, memoryPercent: 30, diskPercent: 20 });
    incidental.at(-1)!.cpuThrottledPeriods = 3;
    incidental.at(-1)!.cpuThrottledUsec = 4_000;
    expect(assessSandboxResources({ provisioned, samples: incidental }).state).not.toBe("underprovisioned");
  });

  it("requires a longer quiet observation before calling a machine overprovisioned", () => {
    const result = assessSandboxResources({
      provisioned,
      samples: samples({ count: 25, cpu: 12, memoryPercent: 25, diskPercent: 20 }),
    });
    expect(result.state).toBe("overprovisioned");
  });

  it("keeps a stalling machine off the shrink list even when averages look idle", () => {
    const result = assessSandboxResources({
      provisioned,
      samples: samples({ count: 25, cpu: 12, memoryPercent: 25, diskPercent: 20, memoryStallPercent: 4 }),
    });
    expect(result.state).toBe("balanced");
  });
});
