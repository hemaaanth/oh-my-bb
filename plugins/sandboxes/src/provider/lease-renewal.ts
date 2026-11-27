import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PluginMachineProviderResource } from "@get-bb/plugin-sdk/machine-provider";
import type { SandboxBackend } from "./sandbox-backend.js";

const DISCONNECTED_RECOVERY_GRACE_MS = 2 * 60_000;
const RECOVERY_COOLDOWN_MS = 5 * 60_000;

/** Provider deadlines are independent of BB idle sleep, including Always on. */
export function registerNativeLeaseRenewal(
  bb: BbPluginApi,
  backends: ReadonlyMap<string, Pick<SandboxBackend<unknown, PluginMachineProviderResource>, "parseResource" | "renewLease">>,
): void {
  if (backends.size === 0) return;
  const controller = new AbortController();
  let running = false;
  const lastRecoveryAttempt = new Map<string, number>();
  bb.onDispose(() => controller.abort());
  bb.background.schedule("sandbox-lease-renewal", "* * * * *", async () => {
    if (running || controller.signal.aborted) return;
    running = true;
    try {
      const now = Date.now();
      for (const host of await bb.sdk.hosts.list()) {
        if (controller.signal.aborted) break;
        const backend = host.machineProviderId ? backends.get(host.machineProviderId) : undefined;
        if (!backend?.renewLease || host.lifecycle.phase !== "active") continue;
        // If a Boat/sandbox VM crash-reboots or is archived while BB still
        // thinks the host is "active", suspend+resume recovers Docker and the
        // daemon cleanly instead of leaving threads stuck in waiting-for-host.
        if (host.status === "disconnected") {
          const lastSeen = host.lastSeenAt ?? host.createdAt;
          const lastAttempt = lastRecoveryAttempt.get(host.id) ?? 0;
          if (now - lastSeen < DISCONNECTED_RECOVERY_GRACE_MS || now - lastAttempt < RECOVERY_COOLDOWN_MS) {
            continue;
          }
          lastRecoveryAttempt.set(host.id, now);
          try {
            bb.log.warn(`Recovering disconnected active sandbox ${host.id} (${host.machineProviderId})`);
            await bb.sdk.hosts.experimental_suspend({ hostId: host.id });
            const listed = await bb.sdk.threads.list({ hostId: host.id, includeArchived: false }) as unknown;
            const threads: Array<{ status?: string; queuedMessageCount?: number }> = Array.isArray(listed)
              ? listed
              : listed && typeof listed === "object"
                ? ((listed as { items?: Array<{ status?: string; queuedMessageCount?: number }>; threads?: Array<{ status?: string; queuedMessageCount?: number }> }).items
                  ?? (listed as { threads?: Array<{ status?: string; queuedMessageCount?: number }> }).threads
                  ?? [])
                : [];
            const hasWaitingWork = threads.some(
              (thread) => thread.status === "active" || (thread.queuedMessageCount ?? 0) > 0,
            );
            if (hasWaitingWork) {
              await bb.sdk.hosts.experimental_resume({ hostId: host.id });
            }
          } catch (error) {
            bb.log.warn(`Could not recover disconnected sandbox ${host.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
          continue;
        }
        if (host.status !== "connected") continue;
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
