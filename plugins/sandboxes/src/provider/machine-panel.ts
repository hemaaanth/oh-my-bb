/**
 * Native-path data for the thread-header machine panel (`SandboxResourceIndicator`).
 *
 * The legacy panel resolves everything from the `SandboxRecord` store, which does
 * not exist for machines created through BB 0.43's native machine-provider flow.
 * This module rebuilds the `SandboxThreadResourcesView` for a native `sandbox-*`
 * host by resolving the host through the SDK and sampling its cgroup resources
 * over a host command — no store record required. Resize is reported as
 * unsupported for now (deferred), which hides the resize control in the UI.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { SandboxResourceSample } from "../backend.js";
import { sandboxProviderValues, type SandboxProvider } from "../backend.js";
import { runHostCommand } from "../host-command.js";
import type {
  SandboxThreadRef,
  SandboxThreadResourcesView,
} from "../manager.js";
import {
  parseSandboxResourceProbe,
  sandboxResourceProbeCommand,
} from "../resource-probe.js";
import type { SandboxRuntimeState } from "../store.js";

const NATIVE_PROVIDER_PREFIX = "sandbox-";
const SAMPLE_TTL_MS = 30_000;

type NativeHost = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["get"]>>;

/**
 * Last resource sample per native host. Lets the header panel render its icon and
 * cached meters immediately on thread switch, while a fresh sample is probed in
 * the background — the slow cgroup probe never blocks the view.
 */
const sampleCache = new Map<string, { sample: SandboxResourceSample; at: number }>();
const probing = new Set<string>();

function probeInBackground(bb: BbPluginApi, hostId: string): void {
  if (probing.has(hostId)) return;
  probing.add(hostId);
  void (async () => {
    try {
      const result = await runHostCommand(bb, {
        hostId,
        cwd: null,
        command: sandboxResourceProbeCommand,
        title: "Sandbox resource probe",
        timeoutMs: 30_000,
      });
      if (result.exitCode === 0) {
        sampleCache.set(hostId, {
          sample: parseSandboxResourceProbe(result.output),
          at: Date.now(),
        });
        // Nudge open panels to re-fetch and pick up the fresh sample.
        bb.realtime.publish("sandboxes", { type: "resources", hostId });
      }
    } catch {
      // Probe failures are non-fatal; the panel keeps the last cached sample.
    } finally {
      probing.delete(hostId);
    }
  })();
}

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

function runtimeStateOf(host: NativeHost): SandboxRuntimeState {
  const phase = host.lifecycle.phase;
  if (phase === "destroyed" || phase === "removing") return "destroyed";
  if (phase === "suspended" || phase === "suspending") return "sleeping";
  if (phase === "resuming" || phase === "creating") return "waking";
  if (host.status === "connected") return "live";
  return "unavailable";
}

async function resolveHostId(
  bb: BbPluginApi,
  ref: SandboxThreadRef,
): Promise<string | null> {
  if (ref.hostId !== undefined && ref.hostId !== null) return ref.hostId;
  let environmentId = ref.environmentId ?? null;
  if (environmentId === null) {
    const thread = await bb.sdk.threads
      .get({ threadId: ref.threadId })
      .catch(() => null);
    environmentId = thread?.environmentId ?? null;
  }
  if (environmentId === null) return null;
  const environment = await bb.sdk.environments
    .get({ environmentId })
    .catch(() => null);
  return environment?.hostId ?? null;
}

/**
 * Build the resource view for a native sandbox thread, or `null` when the thread
 * is not on a native sandbox host (caller falls back to the legacy view).
 */
export async function nativeThreadResources(
  bb: BbPluginApi,
  ref: SandboxThreadRef,
  refresh: boolean,
): Promise<SandboxThreadResourcesView | null> {
  const hostId = await resolveHostId(bb, ref);
  if (hostId === null) return null;

  const host = await bb.sdk.hosts.get({ hostId }).catch(() => null);
  if (host === null) return null;
  const provider = nativeProviderOf(host.machineProviderId);
  if (provider === null) return null;

  const state = runtimeStateOf(host);

  // Return immediately with any cached sample; refresh in the background so the
  // icon and meters never wait on the multi-second cgroup probe.
  const cached = sampleCache.get(host.id) ?? null;
  const fresh = cached !== null && Date.now() - cached.at < SAMPLE_TTL_MS;
  if (refresh && host.status === "connected" && state === "live" && !fresh) {
    probeInBackground(bb, host.id);
  }

  const latest = cached?.sample ?? null;
  const provisioned =
    latest === null
      ? null
      : {
          cpuCores: latest.cpuCores,
          memoryBytes: latest.memoryBytes,
          diskBytes: latest.diskBytes,
        };

  return {
    managed: true,
    sandboxId: host.id,
    provider,
    state,
    capability: "unsupported",
    capabilityReason: "Resizing native sandboxes isn’t available yet.",
    latest,
    provisioned,
    target: null,
    assessment: null,
    stale: latest !== null && latest.sampledAt < Date.now() - 2 * 60_000,
    sampleError: null,
  };
}
