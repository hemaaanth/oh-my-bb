import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  parseSandboxResourceProbe,
  sandboxResourceProbeCommand,
} from "../src/resource-probe.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Lays out a fake cgroupfs plus /proc and runs the real shipped probe against it. */
function probe(files: Record<string, string>, provisioned?: {
  cpuCores: number | null;
  memoryBytes: number | null;
  diskBytes: number | null;
}) {
  const root = mkdtempSync(join(tmpdir(), "bb-probe-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
  const output = execFileSync("bash", ["-c", sandboxResourceProbeCommand], {
    encoding: "utf8",
    env: {
      ...process.env,
      BB_PROBE_CGROUP_ROOT: join(root, "cgroup"),
      BB_PROBE_PROC_ROOT: join(root, "proc"),
    },
  });
  return parseSandboxResourceProbe(output, provisioned);
}

const meminfo = "MemTotal:       16384000 kB\nMemFree:         1000000 kB\n";

const cgroupV2 = {
  "proc/meminfo": meminfo,
  "cgroup/memory.max": "8589934592\n",
  "cgroup/memory.current": "3221225472\n",
  "cgroup/memory.peak": "8589934592\n",
  "cgroup/memory.stat":
    "anon 2147483648\nfile 1000341504\nkernel_stack 1310720\nslab_reclaimable 33554432\nslab_unreclaimable 8388608\n",
  "cgroup/memory.events": "low 0\nhigh 0\nmax 7378\noom 27\noom_kill 2\noom_group_kill 0\n",
  "cgroup/memory.pressure":
    "some avg10=12.34 avg60=9.87 avg300=4.00 total=123456789\nfull avg10=6.00 avg60=3.25 avg300=1.00 total=1234567\n",
  "cgroup/cpu.max": "400000 100000\n",
  "cgroup/cpu.stat":
    "usage_usec 987654321\nuser_usec 700000000\nsystem_usec 287654321\nnr_periods 24001\nnr_throttled 796\nthrottled_usec 723441470\n",
  "cgroup/cpu.pressure":
    "some avg10=2.50 avg60=1.75 avg300=0.90 total=5555\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
};

describe("sandboxResourceProbeCommand", () => {
  it("reports the cgroup v2 limits and counters, not the host node", () => {
    const sample = probe(cgroupV2, {
      cpuCores: 48,
      memoryBytes: 405 * 1000 ** 3,
      diskBytes: null,
    });
    expect(sample.cpuCores).toBe(4);
    expect(sample.memoryBytes).toBe(8589934592);
    expect(sample.memoryUsageBytes).toBe(3221225472);
    expect(sample.memoryPeakBytes).toBe(8589934592);
    expect(sample.memoryAnonBytes).toBe(2147483648);
    expect(sample.memoryFileBytes).toBe(1000341504);
    expect(sample.memorySlabReclaimableBytes).toBe(33554432);
    expect(sample.cpuThrottledPeriods).toBe(796);
    expect(sample.cpuThrottledUsec).toBe(723441470);
    expect(sample.memoryPressureSomeAvg10).toBe(12.34);
    expect(sample.memoryPressureSomeAvg60).toBe(9.87);
    expect(sample.memoryPressureFullAvg10).toBe(6);
    expect(sample.memoryPressureFullAvg60).toBe(3.25);
    expect(sample.cpuPressureSomeAvg10).toBe(2.5);
    expect(sample.cpuPressureSomeAvg60).toBe(1.75);
    expect(sample.cpuPressureFullAvg60).toBe(0);
    expect(sample.diskBytes).toBeGreaterThan(0);
  });

  it("keeps oom conditions and oom kills as separate counters", () => {
    const sample = probe(cgroupV2);
    expect(sample.oomEvents).toBe(27);
    expect(sample.oomKills).toBe(2);
  });

  it("falls back to MemTotal when memory.max is unlimited, and defers to the provider", () => {
    const unlimited = probe({ ...cgroupV2, "cgroup/memory.max": "max\n" });
    expect(unlimited.memoryBytes).toBe(16384000 * 1024);

    const declared = probe({ ...cgroupV2, "cgroup/memory.max": "max\n" }, {
      cpuCores: null,
      memoryBytes: 2 * 1024 ** 3,
      diskBytes: null,
    });
    expect(declared.memoryBytes).toBe(2 * 1024 ** 3);
    // The quota is still enforced, so the provider claim never overrides it.
    expect(declared.cpuCores).toBe(4);
  });

  it("reads cgroup v1 hierarchies, including its unlimited sentinel", () => {
    const sample = probe({
      "proc/meminfo": meminfo,
      "cgroup/memory/memory.limit_in_bytes": "2147483648\n",
      "cgroup/memory/memory.usage_in_bytes": "1073741824\n",
      "cgroup/memory/memory.max_usage_in_bytes": "1500000000\n",
      "cgroup/memory/memory.stat": "cache 500000000\nrss 400000000\nslab_reclaimable 12345678\n",
      "cgroup/memory/memory.oom_control": "oom_kill_disable 0\nunder_oom 0\noom_kill 3\n",
      "cgroup/cpu/cpu.cfs_quota_us": "150000\n",
      "cgroup/cpu/cpu.cfs_period_us": "100000\n",
      "cgroup/cpu/cpu.stat": "nr_periods 100\nnr_throttled 12\nthrottled_time 5000000\n",
      "cgroup/cpuacct/cpuacct.usage": "9000000000\n",
    });
    expect(sample.cpuCores).toBe(1.5);
    expect(sample.memoryBytes).toBe(2147483648);
    expect(sample.memoryUsageBytes).toBe(1073741824);
    expect(sample.memoryPeakBytes).toBe(1500000000);
    expect(sample.memoryAnonBytes).toBe(400000000);
    expect(sample.memoryFileBytes).toBe(500000000);
    expect(sample.oomKills).toBe(3);
    expect(sample.oomEvents).toBeNull();
    expect(sample.cpuThrottledPeriods).toBe(12);
    expect(sample.cpuThrottledUsec).toBe(5000);
    expect(sample.memoryPressureSomeAvg60).toBeNull();

    const unlimited = probe({
      "proc/meminfo": meminfo,
      "cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n",
    });
    expect(unlimited.memoryBytes).toBe(16384000 * 1024);
  });
});
