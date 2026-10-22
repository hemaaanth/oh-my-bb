/**
 * Core-managed idle suspend for native-path sandboxes.
 *
 * BB core does not auto-suspend idle machines — that is plugin-driven. We must
 * route idle suspension through `bb.sdk.hosts.experimental_suspend`, which calls
 * our machine provider's `suspend()` (a graceful Daytona stop) and puts the host
 * into core's `suspended` lifecycle. Core then resumes it on the next turn,
 * re-bootstrapping the daemon via our `resume()`. This is what makes idle
 * recoverable — in contrast to a provider stopping the VM out-of-band, which core
 * reads as an unrecoverable "connection to host lost".
 *
 * A per-host timer starts when a thread goes idle and is cancelled when it becomes
 * active again. Suspension is skipped entirely when idle-sleep is disabled
 * (`idleMs()` returns null).
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const NATIVE_PROVIDER_PREFIX = "sandbox-";

interface ThreadLike {
  id: string;
  environmentId: string | null;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Keeps named hosts awake while plugin maintenance runs on them. */
export interface NativeIdleSuspendHolds {
  hold(hostId: string, owner?: string): void;
  release(hostId: string, owner?: string): void;
}

export function registerNativeIdleSuspend(
  bb: BbPluginApi,
  deps: { idleMs: () => number | null; alwaysOn?: (hostId: string) => boolean },
): NativeIdleSuspendHolds {
  const timers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; deadline: number }
  >();
  // A host resumed outside a thread turn (`bb machine resume`, maintenance)
  // still has only idle threads whose updatedAt is long past. Without this the
  // next reconcile suspends it again within a minute. Track the last observed
  // phase so a suspended -> active transition restarts the idle clock.
  const observed = new Map<string, { active: boolean; since: number }>();
  const held = new Map<string, Set<string>>();

  const cancel = (hostId: string): void => {
    const timer = timers.get(hostId);
    if (timer !== undefined) {
      clearTimeout(timer.timer);
      timers.delete(hostId);
    }
  };

  // Which native providers actually support suspend (Modal, for example, does
  // not). Cached briefly so we don't hit the providers endpoint on every event.
  let suspendable: { ids: Set<string>; at: number } | null = null;
  const suspendableProviderIds = async (): Promise<Set<string>> => {
    if (suspendable !== null && Date.now() - suspendable.at < 60_000) {
      return suspendable.ids;
    }
    const providers = await bb.sdk.hosts.experimental_listProviders();
    const ids = new Set(
      providers.filter((p) => p.supportsSuspend).map((p) => p.id),
    );
    suspendable = { ids, at: Date.now() };
    return ids;
  };

  const nativeHostIdFor = async (
    thread: ThreadLike,
  ): Promise<string | null> => {
    const environmentId = thread.environmentId;
    if (environmentId === null) return null;
    try {
      const environment = await bb.sdk.environments.get({ environmentId });
      const host = await bb.sdk.hosts.get({ hostId: environment.hostId });
      const providerId = host.machineProviderId;
      if (providerId?.startsWith(NATIVE_PROVIDER_PREFIX) !== true) return null;
      return (await suspendableProviderIds()).has(providerId) ? host.id : null;
    } catch {
      return null;
    }
  };

  const allThreadsIdle = async (hostId: string): Promise<boolean> => {
    const limit = 100;
    let found = false;
    for (let offset = 0; ; offset += limit) {
      const threads = await bb.sdk.threads.list({
        archived: false,
        includeHidden: true,
        limit,
        offset,
      });
      for (const thread of threads) {
        if (thread.environmentHostId !== hostId) continue;
        found = true;
        if (thread.status !== "idle" && thread.status !== "error") return false;
      }
      if (threads.length < limit) return found;
    }
  };

  const scheduleSuspend = (hostId: string, idleSince = Date.now()): void => {
    const idle = deps.idleMs();
    if (idle === null || deps.alwaysOn?.(hostId)) return; // Keep this host awake.
    const deadline = idleSince + idle;
    const current = timers.get(hostId);
    // Reconciliation runs repeatedly. Do not push an existing deadline into
    // the future every time it rediscovers the same idle thread.
    if (current !== undefined && current.deadline <= deadline) return;
    cancel(hostId);
    const timer = setTimeout(() => {
      timers.delete(hostId);
      void (async () => {
        try {
          if (held.has(hostId) || deps.alwaysOn?.(hostId)) return;
          if (!(await allThreadsIdle(hostId))) return;
          const host = await bb.sdk.hosts.get({ hostId });
          // Only suspend a live, connected host that is still idle.
          if (host.status !== "connected" || host.lifecycle.phase !== "active") {
            return;
          }
          await bb.sdk.hosts.experimental_suspend({ hostId });
        } catch (error) {
          bb.log.warn(
            `Could not suspend idle sandbox host ${hostId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      })();
    }, Math.max(0, deadline - Date.now()));
    timers.set(hostId, { timer, deadline });
  };

  const reconcile = async (): Promise<void> => {
    const idle = deps.idleMs();
    if (idle === null) {
      for (const hostId of timers.keys()) cancel(hostId);
      return;
    }
    const idleHosts = new Map<string, number>();
    const activeHosts = new Set<string>();
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const threads = await bb.sdk.threads.list({
        archived: false,
        includeHidden: true,
        limit,
        offset,
      });
      for (const thread of threads) {
        if (thread.environmentHostId === null) continue;
        const hostId = thread.environmentHostId;
        if (thread.status !== "idle" && thread.status !== "error") {
          activeHosts.add(hostId);
          idleHosts.delete(hostId);
          continue;
        }
        if (!activeHosts.has(hostId)) {
          idleHosts.set(
            hostId,
            Math.max(idleHosts.get(hostId) ?? 0, thread.updatedAt),
          );
        }
      }
      if (threads.length < limit) break;
    }
    for (const hostId of activeHosts) cancel(hostId);
    for (const [hostId, idleSince] of idleHosts) {
      if (deps.alwaysOn?.(hostId)) {
        cancel(hostId);
        continue;
      }
      try {
        const host = await bb.sdk.hosts.get({ hostId });
        const active =
          host.status === "connected" && host.lifecycle.phase === "active";
        const previous = observed.get(hostId);
        let activeSince = 0;
        if (active && previous?.active === false) {
          activeSince = Date.now();
          cancel(hostId);
        } else if (active && previous !== undefined) {
          activeSince = previous.since;
        }
        observed.set(hostId, { active, since: activeSince });
        if (
          host.machineProviderId?.startsWith(NATIVE_PROVIDER_PREFIX) === true &&
          (await suspendableProviderIds()).has(host.machineProviderId)
        ) {
          scheduleSuspend(hostId, Math.max(idleSince, activeSince));
        }
      } catch {
        cancel(hostId);
      }
    }
  };

  bb.events.on("thread.idle", ({ thread }) => {
    void nativeHostIdFor(thread).then((hostId) => {
      if (hostId !== null) scheduleSuspend(hostId);
    });
  });
  bb.events.on("thread.active", ({ thread }) => {
    void nativeHostIdFor(thread).then((hostId) => {
      if (hostId !== null) cancel(hostId);
    });
  });
  bb.background.service("native-idle-suspend-reconcile", {
    async start(signal) {
      while (!signal.aborted) {
        await reconcile().catch((error) =>
          bb.log.warn(
            `Could not reconcile idle sandbox hosts: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
        await wait(60_000, signal);
      }
    },
  });
  bb.onDispose(() => {
    for (const hostId of timers.keys()) cancel(hostId);
  });
  return {
    hold(hostId, owner = "default") {
      const owners = held.get(hostId) ?? new Set<string>();
      owners.add(owner);
      held.set(hostId, owners);
    },
    release(hostId, owner = "default") {
      const owners = held.get(hostId);
      owners?.delete(owner);
      if (!owners?.size) held.delete(hostId);
      // Count idle time from now: the host just did work.
      observed.set(hostId, { active: true, since: Date.now() });
      cancel(hostId);
    },
  };
}
