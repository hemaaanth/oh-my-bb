/**
 * Adapts one {@link SandboxBackend} into a native BB 0.43 environment + machine
 * provider. Called once per enabled vendor so each shows up as a distinct option
 * ("Daytona", "Modal", …) in the native New Thread environment picker.
 *
 * The environment provider is *composed*: it carries no create/remove of its own
 * and points `environmentProviderId: "project-checkout"` at this vendor's machine
 * provider, so BB core clones the repo onto the machine after bootstrap.
 */
import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import type {
  PluginMachineProviderProgress,
  PluginMachineProviderResource,
} from "@get-bb/plugin-sdk/machine-provider";
import type { SandboxBackend } from "./sandbox-backend.js";

/** Environment provider id BB core owns for cloning a project checkout. */
const PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID = "project-checkout";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RegisterSandboxBackendOptions {
  now: () => number;
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

  const canSuspend =
    typeof backend.suspend === "function" &&
    typeof backend.resume === "function";

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
    availability() {
      return backend.availability();
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
            const resumed = await backend.resume!({
              ...context,
              resource: backend.parseResource(context.resource),
            });
            const startedAt = options.now();
            const key = backend.allocationKey(resumed.resource);
            await bb.experimental_machines.bootstrap({
              key,
              executor: resumed.executor,
              report: context.report,
              signal: context.signal,
            });
            context.report.log(
              `${definition.runtimeName} daemon connected in ${options.now() - startedAt} ms\n`,
            );
            await options.prepareMachine?.({
              key,
              hostId: context.hostId,
              executor: resumed.executor,
              report: context.report,
              signal: context.signal,
            });
            await options.onConnected(context.hostId);
            return { resource: resumed.resource };
          },
        }
      : {}),
    async create(context) {
      try {
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
        const startedAt = options.now();
        const { hostId } = await bb.experimental_machines.bootstrap({
          key: context.key,
          executor: created.executor,
          report: context.report,
          signal: context.signal,
        });
        context.report.log(
          `${definition.runtimeName} daemon connected in ${options.now() - startedAt} ms\n`,
        );
        context.signal.throwIfAborted();
        await options.prepareMachine?.({
          key: context.key,
          hostId,
          executor: created.executor,
          report: context.report,
          signal: context.signal,
        });
        await options.onConnected(hostId);
        return {
          status: "created",
          name: backend.displayName({ hostId, resource: created.resource }),
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
        return { status: "removed" };
      } catch (error) {
        context.signal.throwIfAborted();
        return { status: "failed", message: errorMessage(error) };
      }
    },
    async remove(context) {
      // Teardown must be able to make progress. If the persisted resource can't
      // be parsed (e.g. it predates the current schema), don't fail forever —
      // core would retry the removal indefinitely, leaving a zombie host stuck
      // in `removing`. Fall back to key-based cleanup so the vendor sandbox is
      // still reaped, then report removed.
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
        if (key !== null) {
          await backend
            .reconcileCleanup({ key, report: context.report, signal: context.signal })
            .catch((cleanupError) =>
              bb.log.warn(
                `${definition.id}: key-based cleanup failed for ${key}: ${errorMessage(cleanupError)}`,
              ),
            );
        }
        return { status: "removed" };
      }
      try {
        await backend.remove({ ...context, resource });
        return { status: "removed" };
      } catch (error) {
        context.signal.throwIfAborted();
        return { status: "failed", message: errorMessage(error) };
      }
    },
  });
}
