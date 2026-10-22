import type { SandboxSizeTier } from "./size-tiers.js";

export const sandboxProviderValues = [
  "daytona",
  "modal",
  "e2b",
  "box",
  "freestyle",
  "nirvana",
] as const;
export type SandboxProvider = (typeof sandboxProviderValues)[number];

export const sandboxBackendStatusValues = [
  "running",
  "stopped",
  "missing",
  "unknown",
] as const;
export type SandboxBackendStatus = (typeof sandboxBackendStatusValues)[number];

/**
 * A requested sandbox size. Every dimension is optional: an omitted dimension
 * keeps whatever the provider allocates on its own.
 */
export interface SandboxResourceRequest {
  cpuCores?: number;
  memoryBytes?: number;
  diskBytes?: number;
}

/** Provider-side diagnostics, so a backend can explain what it refused to do. */
export interface SandboxBackendLogger {
  warn(message: string): void;
}

export interface SandboxBackendCreateInput {
  env: Record<string, string>;
  name: string;
  sandboxId: string;
  /** Provider-native image/snapshot selected for this project. */
  image?: string;
  /** Size resolved by SandboxManager; absent means the provider default. */
  resources?: SandboxResourceRequest;
  /** The tier `resources` came from, for providers that size by machine class. */
  sizeTier?: SandboxSizeTier;
  /**
   * Where to place the machine, for providers with more than one region or
   * pool. Absent means the provider's configured default placement.
   */
  placement?: { regionId: string; sandboxClass: string };
  /** bb-app version the sandbox daemon should install when bootstrapping. */
  bbAppVersion?: string;
}

export interface SandboxBackendCreateResult {
  providerSandboxId: string;
  resources?: SandboxProvisionedResources;
}

export interface SandboxProvisionedResources {
  cpuCores: number | null;
  memoryBytes: number | null;
  diskBytes: number | null;
}

export const sandboxResizeCapabilityValues = [
  "unknown",
  "supported",
  "unsupported",
] as const;
export type SandboxResizeCapability =
  (typeof sandboxResizeCapabilityValues)[number];

/** A provider accepted a resize and reported the size now provisioned. */
export interface SandboxBackendResizeResult {
  provisioned: SandboxProvisionedResources;
  /** True when the provider had to stop and restart the existing machine. */
  restarted: boolean;
}

/** A provider/organization does not expose in-place resize for this sandbox. */
export class SandboxResizeUnsupportedError extends Error {
  readonly provider: SandboxProvider;

  constructor(provider: SandboxProvider, message: string) {
    super(message);
    this.name = "SandboxResizeUnsupportedError";
    this.provider = provider;
  }
}

export interface SandboxResourceSample extends SandboxProvisionedResources {
  sampledAt: number;
  cpuUsagePercent: number | null;
  memoryUsageBytes: number | null;
  diskUsageBytes: number | null;
  /** Host-wide, not cgroup-scoped: the kernel exposes no per-cgroup load average. */
  loadAverage1m: number | null;
  /** cgroup memory.events `oom`: the group ran out of memory, kill or not. */
  oomEvents: number | null;
  /** cgroup memory.events `oom_kill`: processes the kernel actually killed. */
  oomKills: number | null;
  memoryPeakBytes: number | null;
  /** anon vs file splits real heap growth from reclaimable page cache, which memory.current lumps together. */
  memoryAnonBytes: number | null;
  memoryFileBytes: number | null;
  memorySlabReclaimableBytes: number | null;
  cpuThrottledPeriods: number | null;
  cpuThrottledUsec: number | null;
  memoryPressureSomeAvg10: number | null;
  memoryPressureSomeAvg60: number | null;
  memoryPressureFullAvg10: number | null;
  memoryPressureFullAvg60: number | null;
  cpuPressureSomeAvg10: number | null;
  cpuPressureSomeAvg60: number | null;
  cpuPressureFullAvg10: number | null;
  cpuPressureFullAvg60: number | null;
}

export interface SandboxBackendLifecycleInput {
  providerSandboxId: string;
  sandboxId: string;
  name: string;
  checkpointId: string | null;
}

export interface SandboxBackendWakeResult {
  providerSandboxId: string;
}

export interface SandboxBackendCommandResult {
  exitCode: number;
  output: string;
}

/** Provider infrastructure only; bb lifecycle stays in SandboxManager. */
export interface SandboxBackend {
  readonly provider: SandboxProvider;
  /** Provider-enforced maximum runtime, exposed to the thread UI as an expiry. */
  readonly maxRuntimeMs?: number;
  create(input: SandboxBackendCreateInput): Promise<SandboxBackendCreateResult>;
  destroy(providerSandboxId: string): Promise<void>;
  status(providerSandboxId: string): Promise<SandboxBackendStatus>;
  /** Prepare durable state before a provider is stopped. */
  prepareSleep?(input: SandboxBackendLifecycleInput): Promise<string | null>;
  /** Stop/pause the provider after prepareSleep has been checkpointed. */
  sleep?(input: SandboxBackendLifecycleInput): Promise<void>;
  /** Resume or replace a sleeping provider while preserving its workspace. */
  wake?(input: SandboxBackendLifecycleInput): Promise<SandboxBackendWakeResult>;
  /** Run a repair command through the provider when the bb host is offline. */
  executeCommand?(
    input: SandboxBackendLifecycleInput,
    command: string,
    timeoutSeconds: number,
  ): Promise<SandboxBackendCommandResult>;
  /** Remove a provider-native checkpoint after wake or final cleanup. */
  discardCheckpoint?(checkpointId: string): Promise<void>;
  /** Extend a live provider lease without changing its lifecycle state. */
  keepAlive?(input: SandboxBackendLifecycleInput): Promise<void>;
  /**
   * Change the size of a provisioned sandbox. Undefined for providers that can
   * only be sized while creating.
   */
  resize?(
    input: SandboxBackendLifecycleInput,
    resources: SandboxResourceRequest,
  ): Promise<SandboxBackendResizeResult>;
  /** Observe guest resource pressure without relying on provider billing data. */
  sampleResources?(providerSandboxId: string): Promise<SandboxResourceSample>;
}
