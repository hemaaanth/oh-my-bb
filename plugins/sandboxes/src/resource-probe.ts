import { z } from "zod";
import type {
  SandboxProvisionedResources,
  SandboxResourceSample,
} from "./backend.js";

const guestProbeSchema = z.object({
  cpuCores: z.number().positive(),
  cpuLimitFromCgroup: z.boolean(),
  cpuUsagePercent: z.number().min(0).max(100).nullable(),
  memoryBytes: z.number().nonnegative(),
  memoryLimitFromCgroup: z.boolean(),
  memoryUsageBytes: z.number().nonnegative(),
  memoryPeakBytes: z.number().nonnegative().nullable(),
  memoryAnonBytes: z.number().nonnegative().nullable(),
  memoryFileBytes: z.number().nonnegative().nullable(),
  memorySlabReclaimableBytes: z.number().nonnegative().nullable(),
  diskBytes: z.number().nonnegative(),
  diskUsageBytes: z.number().nonnegative(),
  loadAverage1m: z.number().nonnegative().nullable(),
  oomEvents: z.number().int().nonnegative().nullable(),
  oomKills: z.number().int().nonnegative().nullable(),
  cpuThrottledPeriods: z.number().int().nonnegative().nullable(),
  cpuThrottledUsec: z.number().nonnegative().nullable(),
  memoryPressureSomeAvg10: z.number().nonnegative().nullable(),
  memoryPressureSomeAvg60: z.number().nonnegative().nullable(),
  memoryPressureFullAvg10: z.number().nonnegative().nullable(),
  memoryPressureFullAvg60: z.number().nonnegative().nullable(),
  cpuPressureSomeAvg10: z.number().nonnegative().nullable(),
  cpuPressureSomeAvg60: z.number().nonnegative().nullable(),
  cpuPressureFullAvg10: z.number().nonnegative().nullable(),
  cpuPressureFullAvg60: z.number().nonnegative().nullable(),
});

/**
 * Reads the cgroup the sandbox actually lives in. `os.totalmem()`/`os.cpus()`
 * report the host node from inside a container, which made an 8 GiB / 4-core
 * sandbox look like a 405 GB / 48-core machine that never used its memory.
 */
export const sandboxResourceProbeCommand = String.raw`node - <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
// Test seam: the suite points these at fixture trees; a guest always has the real mounts.
const CGROUP = process.env.BB_PROBE_CGROUP_ROOT || '/sys/fs/cgroup';
const PROC = process.env.BB_PROBE_PROC_ROOT || '/proc';
const read = (path) => { try { return fs.readFileSync(path, 'utf8'); } catch { return null; } };
const readNumber = (path) => {
  const text = read(path);
  if (text === null) return null;
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : null;
};
const readKeyed = (path) => {
  const values = {};
  const text = read(path);
  if (text === null) return values;
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const value = Number(parts[1]);
    if (Number.isFinite(value)) values[parts[0]] = value;
  }
  return values;
};
const pick = (values, ...keys) => {
  for (const key of keys) if (values[key] !== undefined) return values[key];
  return null;
};
const readPressure = (path) => {
  const result = { someAvg10: null, someAvg60: null, fullAvg10: null, fullAvg60: null };
  const text = read(path);
  if (text === null) return result;
  for (const line of text.split('\n')) {
    const scope = line.startsWith('some ') ? 'some' : line.startsWith('full ') ? 'full' : null;
    if (scope === null) continue;
    for (const window of ['10', '60']) {
      const match = line.match(new RegExp('avg' + window + '=([0-9.]+)'));
      if (match) result[scope + 'Avg' + window] = Number(match[1]);
    }
  }
  return result;
};
const memTotalBytes = () => {
  const match = (read(PROC + '/meminfo') || '').match(/MemTotal:\s+(\d+)\s+kB/);
  return match ? Number(match[1]) * 1024 : os.totalmem();
};
// cgroup v1 stores a page-count sentinel near 2^63 when no limit is set.
const V1_UNLIMITED = 2 ** 53;
const memoryLimit = () => {
  const v2 = read(CGROUP + '/memory.max');
  if (v2 !== null) {
    const text = v2.trim();
    const value = Number(text);
    if (text !== 'max' && Number.isFinite(value) && value > 0) return { bytes: value, fromCgroup: true };
    if (text === 'max') return { bytes: memTotalBytes(), fromCgroup: false };
  }
  const v1 = readNumber(CGROUP + '/memory/memory.limit_in_bytes');
  if (v1 !== null && v1 > 0 && v1 < V1_UNLIMITED) return { bytes: v1, fromCgroup: true };
  return { bytes: memTotalBytes(), fromCgroup: false };
};
const cpuLimit = () => {
  const v2 = read(CGROUP + '/cpu.max');
  if (v2 !== null) {
    const parts = v2.trim().split(/\s+/);
    const quota = Number(parts[0]);
    const period = Number(parts[1] === undefined ? '100000' : parts[1]);
    if (parts[0] !== 'max' && Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0) {
      return { cores: quota / period, fromCgroup: true };
    }
    if (parts[0] === 'max') return { cores: os.cpus().length, fromCgroup: false };
  }
  const quota = readNumber(CGROUP + '/cpu/cpu.cfs_quota_us');
  const period = readNumber(CGROUP + '/cpu/cpu.cfs_period_us');
  if (quota !== null && quota > 0 && period !== null && period > 0) {
    return { cores: quota / period, fromCgroup: true };
  }
  return { cores: os.cpus().length, fromCgroup: false };
};
const cgroupCpuUsec = () => {
  const v2 = pick(readKeyed(CGROUP + '/cpu.stat'), 'usage_usec');
  if (v2 !== null) return v2;
  const v1 = readNumber(CGROUP + '/cpuacct/cpuacct.usage');
  return v1 === null ? null : v1 / 1000;
};
const hostCpu = () => os.cpus().reduce((sum, item) => {
  const total = Object.values(item.times).reduce((value, next) => value + next, 0);
  return { idle: sum.idle + item.times.idle, total: sum.total + total };
}, { idle: 0, total: 0 });
(async () => {
  const cpu = cpuLimit();
  const memory = memoryLimit();
  const beforeUsec = cgroupCpuUsec();
  const beforeHost = hostCpu();
  const startedAt = Date.now();
  // A short burst made ordinary build work look like sustained saturation.
  // Two seconds still keeps the probe cheap while smoothing scheduler noise.
  await sleep(2000);
  const afterUsec = cgroupCpuUsec();
  const afterHost = hostCpu();
  const elapsedUsec = Math.max(1, (Date.now() - startedAt) * 1000);
  let cpuUsagePercent = null;
  if (beforeUsec !== null && afterUsec !== null) {
    // Container-relative: the cgroup's own CPU time over the window, against the
    // cores its quota grants, not against every core on the host node.
    cpuUsagePercent = Math.max(0, Math.min(100, 100 * (afterUsec - beforeUsec) / (elapsedUsec * cpu.cores)));
  } else {
    const deltaTotal = afterHost.total - beforeHost.total;
    cpuUsagePercent = deltaTotal > 0
      ? Math.max(0, Math.min(100, 100 * (1 - (afterHost.idle - beforeHost.idle) / deltaTotal)))
      : null;
  }
  const memoryUsageBytes = readNumber(CGROUP + '/memory.current')
    ?? readNumber(CGROUP + '/memory/memory.usage_in_bytes')
    ?? Math.max(0, os.totalmem() - os.freemem());
  const memoryStat = Object.assign(
    readKeyed(CGROUP + '/memory/memory.stat'),
    readKeyed(CGROUP + '/memory.stat'),
  );
  const memoryEvents = readKeyed(CGROUP + '/memory.events');
  const oomControl = readKeyed(CGROUP + '/memory/memory.oom_control');
  const cpuStat = Object.assign(
    readKeyed(CGROUP + '/cpu/cpu.stat'),
    readKeyed(CGROUP + '/cpu.stat'),
  );
  const throttledTimeNs = pick(cpuStat, 'throttled_time');
  const memoryPressure = readPressure(CGROUP + '/memory.pressure');
  const cpuPressure = readPressure(CGROUP + '/cpu.pressure');
  const fields = execFileSync('df', ['-B1', '--output=size,used', '/'], { encoding: 'utf8' })
    .trim().split(/\s+/).slice(-2).map(Number);
  process.stdout.write(JSON.stringify({
    cpuCores: cpu.cores,
    cpuLimitFromCgroup: cpu.fromCgroup,
    cpuUsagePercent,
    memoryBytes: memory.bytes,
    memoryLimitFromCgroup: memory.fromCgroup,
    memoryUsageBytes,
    memoryPeakBytes: readNumber(CGROUP + '/memory.peak')
      ?? readNumber(CGROUP + '/memory/memory.max_usage_in_bytes'),
    memoryAnonBytes: pick(memoryStat, 'anon', 'total_rss', 'rss'),
    memoryFileBytes: pick(memoryStat, 'file', 'total_cache', 'cache'),
    memorySlabReclaimableBytes: pick(memoryStat, 'slab_reclaimable', 'total_slab_reclaimable'),
    diskBytes: fields[0] || 0,
    diskUsageBytes: fields[1] || 0,
    loadAverage1m: Number.isFinite(os.loadavg()[0]) ? os.loadavg()[0] : null,
    oomEvents: pick(memoryEvents, 'oom'),
    oomKills: pick(memoryEvents, 'oom_kill') ?? pick(oomControl, 'oom_kill'),
    cpuThrottledPeriods: pick(cpuStat, 'nr_throttled'),
    cpuThrottledUsec: pick(cpuStat, 'throttled_usec')
      ?? (throttledTimeNs === null ? null : throttledTimeNs / 1000),
    memoryPressureSomeAvg10: memoryPressure.someAvg10,
    memoryPressureSomeAvg60: memoryPressure.someAvg60,
    memoryPressureFullAvg10: memoryPressure.fullAvg10,
    memoryPressureFullAvg60: memoryPressure.fullAvg60,
    cpuPressureSomeAvg10: cpuPressure.someAvg10,
    cpuPressureSomeAvg60: cpuPressure.someAvg60,
    cpuPressureFullAvg10: cpuPressure.fullAvg10,
    cpuPressureFullAvg60: cpuPressure.fullAvg60,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
NODE`;

export function parseSandboxResourceProbe(
  output: string,
  provisioned?: SandboxProvisionedResources,
): SandboxResourceSample {
  const measured = guestProbeSchema.parse(JSON.parse(output.trim()));
  return {
    sampledAt: Date.now(),
    // A provider-declared size is a billing claim; the cgroup is what the kernel
    // enforces, so it wins whenever the guest could actually read it.
    cpuCores: measured.cpuLimitFromCgroup
      ? measured.cpuCores
      : provisioned?.cpuCores ?? measured.cpuCores,
    memoryBytes: measured.memoryLimitFromCgroup
      ? measured.memoryBytes
      : provisioned?.memoryBytes ?? measured.memoryBytes,
    diskBytes: provisioned?.diskBytes ?? measured.diskBytes,
    cpuUsagePercent: measured.cpuUsagePercent,
    memoryUsageBytes: measured.memoryUsageBytes,
    diskUsageBytes: measured.diskUsageBytes,
    loadAverage1m: measured.loadAverage1m,
    oomEvents: measured.oomEvents,
    oomKills: measured.oomKills,
    memoryPeakBytes: measured.memoryPeakBytes,
    memoryAnonBytes: measured.memoryAnonBytes,
    memoryFileBytes: measured.memoryFileBytes,
    memorySlabReclaimableBytes: measured.memorySlabReclaimableBytes,
    cpuThrottledPeriods: measured.cpuThrottledPeriods,
    cpuThrottledUsec: measured.cpuThrottledUsec,
    memoryPressureSomeAvg10: measured.memoryPressureSomeAvg10,
    memoryPressureSomeAvg60: measured.memoryPressureSomeAvg60,
    memoryPressureFullAvg10: measured.memoryPressureFullAvg10,
    memoryPressureFullAvg60: measured.memoryPressureFullAvg60,
    cpuPressureSomeAvg10: measured.cpuPressureSomeAvg10,
    cpuPressureSomeAvg60: measured.cpuPressureSomeAvg60,
    cpuPressureFullAvg10: measured.cpuPressureFullAvg10,
    cpuPressureFullAvg60: measured.cpuPressureFullAvg60,
  };
}
