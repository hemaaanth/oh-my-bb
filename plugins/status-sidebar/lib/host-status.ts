/**
 * Projects native BB machine-provider hosts into the sidebar's sandbox status
 * shape, reading `bb.sdk.hosts` directly instead of hopping through the
 * Sandboxes plugin. This mirrors the projection the Sandboxes plugin exposed
 * via its `threadStatuses` RPC (see its `src/provider/sidebar-status.ts`), so
 * native-path sandboxes render the vendor logo tinted by connection state with
 * no change on the frontend.
 *
 * Pre-0.43 legacy sandboxes are manual hosts with no machine provider. They are
 * recognized by their "<Vendor> · <name>" host name instead.
 */
import {
  NATIVE_SANDBOX_PROVIDER_PREFIX,
  SANDBOX_PROVIDER_LABELS,
  sandboxProviderValues,
  type SandboxLifecycleStatus,
  type SandboxProvider,
  type SandboxThreadStatus,
} from "../shared";

/** The host fields this projection reads; a structural subset of the SDK `Host`. */
export interface HostStatusInput {
  id: string;
  name: string;
  status: string;
  machineProviderId: string | null;
  lifecycle: {
    phase: string;
    teardown: { status: string } | null;
  };
}

/** A sidebar row that wants a sandbox status, carrying the host it runs on. */
export interface HostStatusRef {
  threadId: string;
  hostId: string | null;
}

/** Recognize `sandbox-<vendor>` machine providers whose vendor the sidebar paints. */
export function nativeProviderOf(
  machineProviderId: string | null,
): SandboxProvider | null {
  if (
    machineProviderId === null ||
    !machineProviderId.startsWith(NATIVE_SANDBOX_PROVIDER_PREFIX)
  ) {
    return null;
  }
  const vendor = machineProviderId.slice(NATIVE_SANDBOX_PROVIDER_PREFIX.length);
  return (sandboxProviderValues as readonly string[]).includes(vendor)
    ? (vendor as SandboxProvider)
    : null;
}

/**
 * Recognize a legacy sandbox: a manual host the Sandboxes plugin named
 * "<Vendor> · <name>". Core reports its machine provider as "manual"; older
 * hosts may have none.
 */
export function legacyProviderOf(host: HostStatusInput): SandboxProvider | null {
  if (host.machineProviderId !== null && host.machineProviderId !== "manual") return null;
  for (const provider of sandboxProviderValues) {
    if (host.name.startsWith(`${SANDBOX_PROVIDER_LABELS[provider]} · `)) return provider;
  }
  return null;
}

/**
 * The Sandboxes plugin stops an idle legacy VM and starts it again for the next
 * waiting turn. Disconnected therefore reads as asleep, not lost.
 */
export function legacyHostThreadStatus(host: HostStatusInput): SandboxLifecycleStatus {
  return host.status === "connected" ? "live" : "idle";
}

/** Map a host's lifecycle/connection into the sidebar's status colors. */
export function hostThreadStatus(host: HostStatusInput): SandboxLifecycleStatus {
  const phase = host.lifecycle.phase;
  if (
    phase === "destroyed" ||
    phase === "removing" ||
    host.lifecycle.teardown?.status === "failed"
  ) {
    return "unrecoverable";
  }
  if (phase === "suspended" || phase === "suspending") return "idle";
  if (host.status === "connected") return "live";
  // Coming up (resuming/creating) but not yet connected reads as transitional.
  if (phase === "resuming" || phase === "creating") return "idle";
  return "unreachable";
}

/**
 * Resolve each ref against the known hosts, emitting one status row per thread
 * whose host is a recognized native or legacy sandbox. Threads with no host, an unknown
 * host, or a non-sandbox machine provider are skipped, exactly as before.
 */
export function resolveHostThreadStatuses(
  refs: readonly HostStatusRef[],
  hosts: readonly HostStatusInput[],
): SandboxThreadStatus[] {
  const hostsById = new Map(hosts.map((host) => [host.id, host]));
  const statuses: SandboxThreadStatus[] = [];
  for (const ref of refs) {
    if (ref.hostId === null) continue;
    const host = hostsById.get(ref.hostId);
    if (host === undefined) continue;
    const native = nativeProviderOf(host.machineProviderId);
    const provider = native ?? legacyProviderOf(host);
    if (provider === null) continue;
    statuses.push({
      threadId: ref.threadId,
      sandboxId: host.id,
      provider,
      status: native === null ? legacyHostThreadStatus(host) : hostThreadStatus(host),
      label: host.name,
    });
  }
  return statuses;
}
