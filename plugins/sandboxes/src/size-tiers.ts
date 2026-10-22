import type {
  SandboxProvider,
  SandboxProvisionedResources,
  SandboxResourceRequest,
} from "./backend.js";
import type { DaytonaCapacityPool } from "./daytona-capacity.js";

const GIB = 1024 ** 3;

/**
 * Provider-agnostic sandbox sizes. A tier is the unit projects choose and the
 * unit images are registered at; every backend maps it onto whatever its API
 * accepts (resources at create, a machine class, or a snapshot registered at
 * this exact size).
 */
export const sandboxSizeTierValues = ["S", "M", "L", "XL"] as const;
export type SandboxSizeTier = (typeof sandboxSizeTierValues)[number];

export interface SandboxSizeTierSpec {
  tier: SandboxSizeTier;
  label: string;
  cpuCores: number;
  memoryBytes: number;
  diskBytes: number;
}

/**
 * M matches the size every snapshot was registered at before tiers existed,
 * so images that predate the tier column keep serving as M without a rebuild.
 */
export const DEFAULT_SANDBOX_SIZE_TIER: SandboxSizeTier = "M";

export const sandboxSizeTiers: Record<SandboxSizeTier, SandboxSizeTierSpec> = {
  S: { tier: "S", label: "Small", cpuCores: 2, memoryBytes: 4 * GIB, diskBytes: 10 * GIB },
  M: { tier: "M", label: "Medium", cpuCores: 4, memoryBytes: 12 * GIB, diskBytes: 20 * GIB },
  L: { tier: "L", label: "Large", cpuCores: 8, memoryBytes: 16 * GIB, diskBytes: 40 * GIB },
  XL: { tier: "XL", label: "Extra large", cpuCores: 16, memoryBytes: 32 * GIB, diskBytes: 100 * GIB },
};

export function isSandboxSizeTier(value: unknown): value is SandboxSizeTier {
  return (
    typeof value === "string" &&
    (sandboxSizeTierValues as readonly string[]).includes(value)
  );
}

/** `l`, `L`, `large`, and `Large` all name the same tier. */
export function parseSandboxSizeTier(value: string): SandboxSizeTier | null {
  const normalized = value.trim().toUpperCase();
  if (isSandboxSizeTier(normalized)) return normalized;
  const byLabel = sandboxSizeTierValues.find(
    (tier) => sandboxSizeTiers[tier].label.toUpperCase() === normalized,
  );
  return byLabel ?? null;
}

export function sizeTierResources(tier: SandboxSizeTier): Required<SandboxResourceRequest> {
  const spec = sandboxSizeTiers[tier];
  return {
    cpuCores: spec.cpuCores,
    memoryBytes: spec.memoryBytes,
    diskBytes: spec.diskBytes,
  };
}

/** Whole units the way provider APIs and humans want them. */
export function sizeTierUnits(tier: SandboxSizeTier): {
  cpu: number;
  memoryGiB: number;
  diskGiB: number;
} {
  const spec = sandboxSizeTiers[tier];
  return {
    cpu: spec.cpuCores,
    memoryGiB: Math.ceil(spec.memoryBytes / GIB),
    diskGiB: Math.ceil(spec.diskBytes / GIB),
  };
}

export function formatSizeTier(tier: SandboxSizeTier): string {
  const units = sizeTierUnits(tier);
  return `${tier} · ${units.cpu} cores · ${units.memoryGiB} GiB memory · ${units.diskGiB} GiB disk`;
}

/**
 * The tier whose resources equal these exactly, for labelling images and
 * profiles that were recorded as raw numbers.
 */
export function sizeTierMatching(
  resources: SandboxProvisionedResources | SandboxResourceRequest,
): SandboxSizeTier | null {
  return (
    sandboxSizeTierValues.find((tier) => {
      const spec = sandboxSizeTiers[tier];
      return (
        resources.cpuCores === spec.cpuCores &&
        resources.memoryBytes === spec.memoryBytes &&
        resources.diskBytes === spec.diskBytes
      );
    }) ?? null
  );
}

/**
 * The smallest tier that satisfies every requested dimension, for providers
 * whose only sizing lever is a pre-registered snapshot. Null when the request
 * exceeds the largest tier.
 */
export function smallestSizeTierCovering(
  resources: SandboxResourceRequest,
): SandboxSizeTier | null {
  return (
    sandboxSizeTierValues.find((tier) => {
      const spec = sandboxSizeTiers[tier];
      return (
        (resources.cpuCores === undefined || resources.cpuCores <= spec.cpuCores) &&
        (resources.memoryBytes === undefined || resources.memoryBytes <= spec.memoryBytes) &&
        (resources.diskBytes === undefined || resources.diskBytes <= spec.diskBytes)
      );
    }) ?? null
  );
}

/**
 * Which per-sandbox maximums of a Daytona pool a tier exceeds. Only maximums
 * count: momentary quota usage says nothing about whether the pool can ever
 * host the tier, which is what image registration and placement care about.
 */
export function sizeTierPoolViolations(
  pool: Pick<
    DaytonaCapacityPool,
    "maxCpuPerSandbox" | "maxMemoryGiBPerSandbox" | "maxDiskGiBPerSandbox"
  >,
  tier: SandboxSizeTier,
): string[] {
  const units = sizeTierUnits(tier);
  return [
    pool.maxCpuPerSandbox !== null && units.cpu > pool.maxCpuPerSandbox
      ? `${units.cpu} cores exceeds the ${pool.maxCpuPerSandbox}-core sandbox maximum`
      : null,
    pool.maxMemoryGiBPerSandbox !== null &&
    units.memoryGiB > pool.maxMemoryGiBPerSandbox
      ? `${units.memoryGiB} GiB memory exceeds the ${pool.maxMemoryGiBPerSandbox} GiB sandbox maximum`
      : null,
    pool.maxDiskGiBPerSandbox !== null && units.diskGiB > pool.maxDiskGiBPerSandbox
      ? `${units.diskGiB} GiB disk exceeds the ${pool.maxDiskGiBPerSandbox} GiB sandbox maximum`
      : null,
  ].filter((message): message is string => message !== null);
}

export function sizeTierFitsPool(
  pool: Pick<
    DaytonaCapacityPool,
    "maxCpuPerSandbox" | "maxMemoryGiBPerSandbox" | "maxDiskGiBPerSandbox"
  >,
  tier: SandboxSizeTier,
): boolean {
  return sizeTierPoolViolations(pool, tier).length === 0;
}

/**
 * Providers whose size is fixed by the registered image rather than chosen at
 * create time. They need one registered image per tier; every other provider
 * takes the tier's resources on the create call.
 */
export const sizeTierImageProviders: readonly SandboxProvider[] = ["daytona"];

export function providerSizesByImage(provider: SandboxProvider): boolean {
  return sizeTierImageProviders.includes(provider);
}

/** Daytona snapshot naming: the tier rides on the version so history stays readable. */
export function sizeTierImageSuffix(tier: SandboxSizeTier): string {
  return tier.toLowerCase();
}
