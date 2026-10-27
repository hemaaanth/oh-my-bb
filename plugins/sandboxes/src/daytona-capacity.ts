import { z } from "zod";
import type { SandboxResourceRequest } from "./backend.js";

const GIB = 1024 ** 3;

export const daytonaSandboxClassValues = [
  "container",
  "linux-vm",
  "windows",
] as const;
export type DaytonaSandboxClass = (typeof daytonaSandboxClassValues)[number];

const regionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  regionType: z.string().min(1),
});

const quotaSchema = z.object({
  regionId: z.string().min(1),
  sandboxClass: z.enum(daytonaSandboxClassValues),
  totalCpuQuota: z.number().nonnegative(),
  currentCpuUsage: z.number().nonnegative(),
  totalMemoryQuota: z.number().nonnegative(),
  currentMemoryUsage: z.number().nonnegative(),
  totalDiskQuota: z.number().nonnegative(),
  currentDiskUsage: z.number().nonnegative(),
  maxCpuPerSandbox: z.number().positive().nullable().optional(),
  maxMemoryPerSandbox: z.number().positive().nullable().optional(),
  maxDiskPerSandbox: z.number().positive().nullable().optional(),
  maxSandboxLifespan: z.number().nonnegative().nullable().optional(),
});

const usageSchema = z.object({ regionUsage: z.array(quotaSchema) });
const sandboxListSchema = z.object({
  items: z.array(z.object({ organizationId: z.string().min(1) }).loose()),
});
const snapshotListSchema = z.object({
  items: z.array(z.object({ organizationId: z.string().min(1) }).loose()),
});

export interface DaytonaCapacityPool {
  regionId: string;
  regionName: string;
  regionType: string;
  sandboxClass: DaytonaSandboxClass;
  totalCpu: number;
  usedCpu: number;
  totalMemoryGiB: number;
  usedMemoryGiB: number;
  totalDiskGiB: number;
  usedDiskGiB: number;
  maxCpuPerSandbox: number | null;
  maxMemoryGiBPerSandbox: number | null;
  maxDiskGiBPerSandbox: number | null;
  maxLifespanMinutes: number | null;
}

export interface DaytonaCapacity {
  organizationId: string;
  pools: DaytonaCapacityPool[];
  refreshedAt: number;
}

export interface DaytonaPlacement {
  regionId: string;
  sandboxClass: DaytonaSandboxClass;
}


async function responseJson(
  fetcher: typeof fetch,
  base: string,
  apiKey: string,
  path: string,
  organizationId?: string,
): Promise<unknown> {
  const response = await fetcher(`${base}${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(organizationId === undefined
        ? {}
        : { "X-Daytona-Organization-ID": organizationId }),
    },
  });
  if (!response.ok) {
    const body = (await response.text()).replace(/\s+/gu, " ").slice(0, 300);
    throw new Error(
      `Daytona API ${path} returned HTTP ${response.status}${body ? `: ${body}` : ""}`,
    );
  }
  return response.json();
}

async function resolveOrganizationId(
  fetcher: typeof fetch,
  base: string,
  apiKey: string,
): Promise<string> {
  const sandboxes = sandboxListSchema.parse(
    await responseJson(
      fetcher,
      base,
      apiKey,
      "/sandbox?limit=1&includeErroredDeleted=true",
    ),
  );
  const sandboxOrganizationId = sandboxes.items[0]?.organizationId;
  if (sandboxOrganizationId !== undefined) return sandboxOrganizationId;

  const snapshots = snapshotListSchema.parse(
    await responseJson(fetcher, base, apiKey, "/snapshots?page=1&limit=1"),
  );
  const snapshotOrganizationId = snapshots.items[0]?.organizationId;
  if (snapshotOrganizationId !== undefined) return snapshotOrganizationId;
  throw new Error(
    "Could not determine the Daytona organization from existing sandboxes or snapshots",
  );
}

export async function discoverDaytonaCapacity(input: {
  apiKey: string;
  apiUrl?: string;
  organizationId?: string;
  fetcher?: typeof fetch;
}): Promise<DaytonaCapacity> {
  const fetcher = input.fetcher ?? fetch;
  const base = (
    input.apiUrl?.trim() || "https://app.daytona.io/api"
  ).replace(/\/$/u, "");
  const organizationId =
    input.organizationId?.trim() ||
    (await resolveOrganizationId(fetcher, base, input.apiKey));
  const [regionsValue, usageValue] = await Promise.all([
    responseJson(fetcher, base, input.apiKey, "/regions", organizationId),
    responseJson(
      fetcher,
      base,
      input.apiKey,
      `/organizations/${encodeURIComponent(organizationId)}/usage`,
    ),
  ]);
  const regions = z.array(regionSchema).parse(regionsValue);
  const usage = usageSchema.parse(usageValue);
  const byId = new Map(regions.map((region) => [region.id, region]));
  return {
    organizationId,
    refreshedAt: Date.now(),
    pools: usage.regionUsage.map((quota) => {
      const region = byId.get(quota.regionId);
      return {
        regionId: quota.regionId,
        regionName: region?.name ?? quota.regionId,
        regionType: region?.regionType ?? "unknown",
        sandboxClass: quota.sandboxClass,
        totalCpu: quota.totalCpuQuota,
        usedCpu: quota.currentCpuUsage,
        totalMemoryGiB: quota.totalMemoryQuota,
        usedMemoryGiB: quota.currentMemoryUsage,
        totalDiskGiB: quota.totalDiskQuota,
        usedDiskGiB: quota.currentDiskUsage,
        maxCpuPerSandbox: quota.maxCpuPerSandbox ?? null,
        maxMemoryGiBPerSandbox: quota.maxMemoryPerSandbox ?? null,
        maxDiskGiBPerSandbox: quota.maxDiskPerSandbox ?? null,
        maxLifespanMinutes: quota.maxSandboxLifespan ?? null,
      };
    }),
  };
}

export function selectedDaytonaPool(
  capacity: DaytonaCapacity,
  placement: DaytonaPlacement,
): DaytonaCapacityPool | null {
  return (
    capacity.pools.find(
      (pool) =>
        pool.regionId === placement.regionId &&
        pool.sandboxClass === placement.sandboxClass,
    ) ?? null
  );
}

export function validateDaytonaResources(
  pool: DaytonaCapacityPool,
  resources: SandboxResourceRequest,
): void {
  const requested = {
    cpu: resources.cpuCores,
    memory:
      resources.memoryBytes === undefined
        ? undefined
        : Math.ceil(resources.memoryBytes / GIB),
    disk:
      resources.diskBytes === undefined
        ? undefined
        : Math.ceil(resources.diskBytes / GIB),
  };
  const violations = [
    requested.cpu !== undefined &&
    pool.maxCpuPerSandbox !== null &&
    requested.cpu > pool.maxCpuPerSandbox
      ? `CPU ${requested.cpu} exceeds the ${pool.maxCpuPerSandbox}-core sandbox maximum`
      : null,
    requested.memory !== undefined &&
    pool.maxMemoryGiBPerSandbox !== null &&
    requested.memory > pool.maxMemoryGiBPerSandbox
      ? `memory ${requested.memory} GiB exceeds the ${pool.maxMemoryGiBPerSandbox} GiB sandbox maximum`
      : null,
    requested.disk !== undefined &&
    pool.maxDiskGiBPerSandbox !== null &&
    requested.disk > pool.maxDiskGiBPerSandbox
      ? `disk ${requested.disk} GiB exceeds the ${pool.maxDiskGiBPerSandbox} GiB sandbox maximum`
      : null,
    requested.cpu !== undefined &&
    requested.cpu > pool.totalCpu - pool.usedCpu
      ? `CPU ${requested.cpu} exceeds the ${pool.totalCpu - pool.usedCpu} cores currently available`
      : null,
    requested.memory !== undefined &&
    requested.memory > pool.totalMemoryGiB - pool.usedMemoryGiB
      ? `memory ${requested.memory} GiB exceeds the ${pool.totalMemoryGiB - pool.usedMemoryGiB} GiB currently available`
      : null,
    requested.disk !== undefined &&
    requested.disk > pool.totalDiskGiB - pool.usedDiskGiB
      ? `disk ${requested.disk} GiB exceeds the ${pool.totalDiskGiB - pool.usedDiskGiB} GiB currently available`
      : null,
  ].filter((message): message is string => message !== null);
  if (violations.length > 0) {
    throw new Error(
      `${pool.regionName} ${pool.sandboxClass} cannot satisfy this size: ${violations.join("; ")}`,
    );
  }
}
