import { setTimeout as delay } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Provider create/resume callbacks run before core activates the host. Queue
 * terminal/host RPC follow-ups until that transition has actually completed. */
export function connectedHostSetup(bb: BbPluginApi, prepare: (hostId: string) => Promise<void>) {
  const pending = new Map<string, number>();
  bb.background.service("connected-host-setup", {
    async start(signal) {
      while (!signal.aborted) {
        for (const [hostId, queuedAt] of pending) {
          if (signal.aborted) return;
          try {
            const host = await bb.sdk.hosts.get({ hostId });
            if (host.lifecycle.phase === "active" && host.status === "connected") {
              pending.delete(hostId);
              await prepare(hostId);
            } else if (Date.now() - queuedAt > 5 * 60_000) {
              pending.delete(hostId);
              bb.log.warn(`Post-connect setup deferred for ${hostId}: machine did not become active`);
            }
          } catch (error) {
            pending.delete(hostId);
            bb.log.warn(`Post-connect setup failed for ${hostId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        await delay(1000, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
      }
    },
  });
  return (hostId: string) => { pending.set(hostId, Date.now()); };
}
