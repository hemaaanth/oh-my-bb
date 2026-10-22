/**
 * Resolves native BB 0.43 machine-provider hosts (`sandbox-<vendor>`) into the
 * same `SandboxThreadStatusView` shape the legacy launcher produces, so the
 * `status-sidebar` plugin renders the vendor logo tinted by connection state for
 * native-path sandboxes without any change on its side. Legacy statuses take
 * precedence; this only fills threads the legacy path did not resolve.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { sandboxProviderValues, type SandboxProvider } from "../backend.js";
import type {
  SandboxThreadRef,
  SandboxThreadStatus,
  SandboxThreadStatusView,
} from "../manager.js";

const NATIVE_PROVIDER_PREFIX = "sandbox-";

type NativeHost = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["get"]>>;

function nativeProviderOf(
  machineProviderId: string | null,
): SandboxProvider | null {
  if (
    machineProviderId === null ||
    !machineProviderId.startsWith(NATIVE_PROVIDER_PREFIX)
  ) {
    return null;
  }
  const vendor = machineProviderId.slice(NATIVE_PROVIDER_PREFIX.length);
  return (sandboxProviderValues as readonly string[]).includes(vendor)
    ? (vendor as SandboxProvider)
    : null;
}

/** Map a native host's lifecycle/connection into the sidebar's status colors. */
function hostThreadStatus(host: NativeHost): SandboxThreadStatus {
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

export async function resolveNativeThreadStatuses(
  bb: BbPluginApi,
  refs: readonly SandboxThreadRef[],
  covered: ReadonlySet<string>,
): Promise<SandboxThreadStatusView[]> {
  const statuses: SandboxThreadStatusView[] = [];
  const hostCache = new Map<string, NativeHost | null>();
  for (const ref of refs) {
    if (covered.has(ref.threadId)) continue;
    const hostId = ref.hostId;
    if (hostId === undefined || hostId === null) continue;

    let host = hostCache.get(hostId);
    if (host === undefined) {
      host = await bb.sdk.hosts.get({ hostId }).catch(() => null);
      hostCache.set(hostId, host);
    }
    if (host === null) continue;

    const provider = nativeProviderOf(host.machineProviderId);
    if (provider === null) continue;

    statuses.push({
      threadId: ref.threadId,
      sandboxId: host.id,
      provider,
      status: hostThreadStatus(host),
      label: host.name,
    });
  }
  return statuses;
}
