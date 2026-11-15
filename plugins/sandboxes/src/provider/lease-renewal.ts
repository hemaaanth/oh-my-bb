import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PluginMachineProviderResource } from "@get-bb/plugin-sdk/machine-provider";
import type { SandboxBackend } from "./sandbox-backend.js";

/** Provider deadlines are independent of BB idle sleep, including Always on. */
export function registerNativeLeaseRenewal(
  bb: BbPluginApi,
  backends: ReadonlyMap<string, Pick<SandboxBackend<unknown, PluginMachineProviderResource>, "parseResource" | "renewLease">>,
): void {
  if (backends.size === 0) return;
  const controller = new AbortController();
  let running = false;
  bb.onDispose(() => controller.abort());
  bb.background.schedule("sandbox-lease-renewal", "* * * * *", async () => {
    if (running || controller.signal.aborted) return;
    running = true;
    try {
      for (const host of await bb.sdk.hosts.list()) {
        if (controller.signal.aborted) break;
        const backend = host.machineProviderId ? backends.get(host.machineProviderId) : undefined;
        if (!backend?.renewLease || host.status !== "connected" || host.lifecycle.phase !== "active") continue;
        try {
          const resource = await bb.experimental_machines.getResource(host.id);
          if (resource === null) continue;
          await backend.renewLease({
            hostId: host.id, resource: backend.parseResource(resource), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
            report: { step: () => {}, log: () => {} },
          });
        } catch (error) {
          bb.log.warn(`Could not renew sandbox deadline for ${host.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      running = false;
    }
  });
}
