/**
 * Internal backend contract for the BB 0.43 machine/environment provider model.
 *
 * This is the shape each vendor backend (daytona, modal, e2b, box, freestyle,
 * freestyle) implements so that {@link registerSandboxBackend} can expose it as a
 * native environment + machine provider. It is deliberately close to BB's own
 * `environment-modal-sandbox` reference plugin: the backend owns vendor
 * allocation, storage semantics, cleanup, and conversion to a `MachineExecutor`,
 * while BB core owns thread creation, host enrollment, daemon bootstrap, the
 * project checkout clone, retries, cancellation, and retirement.
 *
 * Unlike the legacy `SandboxBackend` in `../backend.ts`, `create()` here does NOT
 * receive a pre-baked enrollment env: core injects `{serverUrl, headers,
 * credential}` into the machine over the returned executor during
 * `bb.experimental_machines.bootstrap(...)`.
 */
import type {
  MachineExecutor,
  PluginMachineValidateDecision,
  StandardSchemaV1,
} from "@get-bb/plugin-sdk";
import type {
  PluginMachineProviderAvailability,
  PluginMachineProviderProgress,
  PluginMachineProviderResource,
} from "@get-bb/plugin-sdk/machine-provider";

/** Attempt-scoped progress; surfaces into the thread's provisioning section. */
export interface SandboxOperationContext {
  report: PluginMachineProviderProgress;
  signal: AbortSignal;
}

/** Operations that may durably persist their allocation before returning. */
export interface SandboxCheckpointContext<
  Resource extends PluginMachineProviderResource,
> extends SandboxOperationContext {
  /** Persist the provider resource; core stores it before the call returns. */
  checkpoint(resource: Resource): Promise<void>;
}

export interface SandboxCreateContext<
  Inputs,
  Resource extends PluginMachineProviderResource,
> extends SandboxCheckpointContext<Resource> {
  /** Stable idempotency key for this allocation (retries reuse it). */
  key: string;
  attempt: number;
  inputs: Inputs;
}

export interface SandboxLifecycleContext<
  Resource extends PluginMachineProviderResource,
> extends SandboxCheckpointContext<Resource> {
  hostId: string;
  resource: Resource;
}

export interface SandboxResourceContext<
  Resource extends PluginMachineProviderResource,
> extends SandboxOperationContext {
  hostId: string;
  resource: Resource;
}

/** Static description surfaced in the native environment/machine pickers. */
export interface SandboxBackendDefinition<Inputs> {
  /** Provider id, e.g. `sandbox-daytona`. Also the environment provider id. */
  id: string;
  displayName: string;
  /** One line shown wherever a machine/environment is added. */
  description: string;
  /** Short explanation shown in environment choices. */
  environmentDescription: string;
  /** Human name used in progress logs, e.g. "Daytona". */
  runtimeName: string;
  /** Provider glyph, declared icon, or plugin-relative icon path. */
  icon: string;
  /** Sandboxes are ephemeral: retired after their last live thread archives. */
  ephemeral: boolean;
  /** Non-secret inputs (size/preset + image) rendered in the native composer. */
  inputs: StandardSchemaV1<unknown, Inputs>;
}

/**
 * Vendor infrastructure only. BB core owns durable launches, retries and
 * retirement; see {@link registerSandboxBackend}.
 */
export interface SandboxBackend<
  Inputs,
  Resource extends PluginMachineProviderResource,
> {
  definition: SandboxBackendDefinition<Inputs>;
  parseInputs(value: unknown): Inputs;
  parseResource(value: PluginMachineProviderResource): Resource;
  /** Durable allocation key derived from a persisted resource. */
  allocationKey(resource: Resource): string;
  availability(): Promise<PluginMachineProviderAvailability>;
  validate(inputs: Inputs): Promise<PluginMachineValidateDecision>;
  /** Allocate the VM and return an executor core bootstraps the daemon over. */
  create(
    context: SandboxCreateContext<Inputs, Resource>,
  ): Promise<{ resource: Resource; executor: MachineExecutor }>;
  /** Reconcile/remove an uncertain allocation by key without bootstrapping. */
  reconcileCleanup(
    context: SandboxOperationContext & { key: string },
  ): Promise<void>;
  /**
   * Snapshot + stop compute, returning the updated resource. Omit (together with
   * {@link resume}) for vendors that cannot pause — the provider is then
   * registered as non-suspendable and idle suspend skips it.
   */
  suspend?(context: SandboxLifecycleContext<Resource>): Promise<Resource>;
  /** Restore compute and return a fresh executor for re-bootstrap. */
  resume?(
    context: SandboxLifecycleContext<Resource>,
  ): Promise<{ resource: Resource; executor: MachineExecutor }>;
  /** Terminate the VM and delete its durable artifacts. */
  remove(context: SandboxResourceContext<Resource>): Promise<void>;
  /**
   * Remove a provider allocation created by the pre-0.43 launcher, whose
   * resource was stored in the plugin database rather than BB core.
   */
  removeLegacy(providerSandboxId: string): Promise<void>;
  /** Delete a legacy provider checkpoint when that provider created one. */
  removeLegacyCheckpoint?(checkpointId: string): Promise<void>;
  /**
   * Start a legacy VM when it is stopped and run a shell script on it.
   * `started` says whether this call started it. Backends whose legacy
   * machines cannot be healed in place omit it.
   */
  execLegacy?(
    providerSandboxId: string,
    script: string,
    timeoutMs: number,
  ): Promise<{ exitCode: number; output: string; started: boolean }>;
  /** Stop a legacy VM that {@link execLegacy} started. */
  stopLegacy?(providerSandboxId: string): Promise<void>;
}
