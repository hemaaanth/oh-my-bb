/**
 * Adapts one {@link SandboxBackend} into a native BB 0.43 environment + machine
 * provider. Called once per enabled vendor so each shows up as a distinct option
 * ("Daytona", "Modal", …) in the native New Thread environment picker.
 *
 * Composed providers use BB's project checkout or personal workspace lifecycle
 * on the same vendor machine, depending on whether a project is selected.
 */
import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import type {
  PluginMachineProviderProgress,
  PluginMachineProviderResource,
} from "@get-bb/plugin-sdk/machine-provider";
import { sandboxExecutor, sandboxName } from "./runtime.js";
import type { SandboxBackend } from "./sandbox-backend.js";

/** Environment provider id BB core owns for cloning a project checkout. */
const PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID = "project-checkout";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RegisterSandboxBackendOptions {
  now: () => number;
  /** Required managed-model runtime. Checked before allocation or wake. */
  requireRuntime?(): Promise<void>;
  /** Called after a machine's daemon connects, with its bb host id. */
  onConnected(hostId: string): Promise<void>;
  /**
   * Resolve project-scoped default inputs (e.g. a per-project size tier) from
   * the allocation key (the thread id for thread-scoped machines). Merged UNDER
   * the user's explicit picker inputs, so an explicit choice always wins. Lets a
   * project pinned to a larger size get it natively even though the inputs
   * control has no project context.
   */
  resolveDefaultInputs?(key: string): Promise<Record<string, unknown>>;
  /**
   * Configure the machine over its executor after the daemon connects, on
   * create and on resume. Runs before {@link onConnected}; errors prevent a
   * machine from becoming agent-ready. `key` is the allocation key (the thread
   * id for thread-scoped machines).
   */
  prepareMachine?(input: {
    key: string;
    hostId: string;
    executor: MachineExecutor;
    report: PluginMachineProviderProgress;
    signal: AbortSignal;
  }): Promise<void>;
}

export function registerSandboxBackend<
  Inputs,
  Resource extends PluginMachineProviderResource,
>(
  bb: BbPluginApi,
  backend: SandboxBackend<Inputs, Resource>,
  options: RegisterSandboxBackendOptions,
): void {
  const { definition } = backend;

  bb.experimental_environments.register({
    id: definition.id,
    displayName: definition.displayName,
    description: definition.environmentDescription,
    icon: definition.icon,
    machineProviderId: definition.id,
    environmentProviderId: PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
  });

  bb.experimental_environments.register({
    id: `${definition.id}-personal`,
    displayName: definition.displayName,
    description: `Create a personal workspace on ${definition.displayName} without a project.`,
    icon: definition.icon,
    machineProviderId: definition.id,
    environmentProviderId: "personal-workspace",
  });

  const canSuspend =
    typeof backend.suspend === "function" &&
    typeof backend.resume === "function";

  const connect = async ({ key, executor: transport, report, signal, hostId: existingHostId }: {
    key: string; executor: MachineExecutor; report: PluginMachineProviderProgress;
    signal: AbortSignal; hostId?: string;
  }) => {
    const executor = sandboxExecutor(transport);
    const startedAt = options.now();
    const connected = await bb.experimental_machines.bootstrap({ key, executor, report, signal });
    const hostId = existingHostId ?? connected.hostId;
    report.log(`${definition.runtimeName} daemon connected in ${options.now() - startedAt} ms\n`);
    signal.throwIfAborted();
    await options.prepareMachine?.({ key, hostId, executor, report, signal });
    await options.onConnected(hostId);
  };

  bb.experimental_machines.register({
    id: definition.id,
    displayName: definition.displayName,
    description: definition.description,
    icon: definition.icon,
    ephemeral: definition.ephemeral,
    inputs: definition.inputs,
    validate({ inputs }) {
      return backend.validate(backend.parseInputs(inputs));
    },
    async availability() {
      try {
        await options.requireRuntime?.();
        return await backend.availability();
      } catch (error) {
        return { status: "setup-required", message: errorMessage(error) };
      }
    },
    ...(canSuspend
      ? {
          async suspend(context) {
            return {
              resource: await backend.suspend!({
                ...context,
                resource: backend.parseResource(context.resource),
              }),
            };
          },
          async resume(context) {
            await options.requireRuntime?.();
            const resumed = await backend.resume!({
              ...context,
              resource: backend.parseResource(context.resource),
            });
            await connect({ ...context, key: backend.allocationKey(resumed.resource), executor: resumed.executor });
            return { resource: resumed.resource };
          },
        }
      : {}),
    async create(context) {
      try {
        await options.requireRuntime?.();
        // Project defaults (e.g. size tier) sit under the user's explicit picks.
        const defaults = options.resolveDefaultInputs
          ? await options.resolveDefaultInputs(context.key).catch(() => ({}))
          : {};
        const userInputs =
          context.inputs !== null && typeof context.inputs === "object"
            ? (context.inputs as Record<string, unknown>)
            : {};
        const mergedInputs = { ...defaults, ...userInputs };
        const created = await backend.create({
          ...context,
          inputs: backend.parseInputs(mergedInputs),
        });
        context.signal.throwIfAborted();
        await connect({ ...context, executor: created.executor });
        return {
          status: "created",
          name: await sandboxName(bb, definition.runtimeName, context.key),
          resource: created.resource,
        };
      } catch (error) {
        context.signal.throwIfAborted();
        return { status: "failed", message: errorMessage(error) };
      }
    },
    async reconcileCleanup(context) {
      try {
        await backend.reconcileCleanup(context);
        context.signal.throwIfAborted();
        return { status: "removed" };
      } catch (error) {
        context.signal.throwIfAborted();
        return { status: "failed", message: errorMessage(error) };
      }
    },
    async remove(context) {
      // Core must retain the checkpoint until the provider confirms removal.
      // An old resource schema may still carry its stable allocation key.
      let resource: Resource;
      try {
        resource = backend.parseResource(context.resource);
      } catch (error) {
        const key =
          context.resource !== null &&
          typeof context.resource === "object" &&
          !Array.isArray(context.resource) &&
          typeof (context.resource as { key?: unknown }).key === "string"
            ? (context.resource as { key: string }).key
            : null;
        bb.log.warn(
          `${definition.id}: unparseable resource on removal (${errorMessage(error)}); ${
            key === null ? "no key to reconcile" : `reconciling by key ${key}`
          }`,
        );
        if (key === null || key.trim().length === 0) {
          context.signal.throwIfAborted();
          return { status: "failed", message: `Cannot identify resource for cleanup: ${errorMessage(error)}` };
        }
        try {
          await backend.reconcileCleanup({ key, report: context.report, signal: context.signal });
          context.signal.throwIfAborted();
          return { status: "removed" };
        } catch (cleanupError) {
          context.signal.throwIfAborted();
          return { status: "failed", message: errorMessage(cleanupError) };
        }
      }
      try {
        await backend.remove({ ...context, resource });
        context.signal.throwIfAborted();
        return { status: "removed" };
      } catch (error) {
        context.signal.throwIfAborted();
        return { status: "failed", message: errorMessage(error) };
      }
    },
  });
}
