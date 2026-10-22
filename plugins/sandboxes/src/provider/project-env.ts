/**
 * Per-thread sync for native BB 0.43 sandbox hosts:
 *  1. Renames the host from the default `bb-<threadId>` to a clean
 *     `<Vendor> · <project>` label, matching the legacy launcher.
 *  2. Restores project-scoped environment injection (e.g. 1Password Environments
 *     via the `project-environments` plugin) once the checkout is ready.
 *
 * The legacy launcher called `project-environments` `startPrepare` inline in
 * `manager.create()` after cloning the checkout. The native path hands thread
 * creation, machine bootstrap and the project checkout to BB core, so there is no
 * inline spot. Instead we react to thread lifecycle events. Preparation only
 * STAGES the `bb-project-env-run` wrapper + scoped token + metadata; `op run`
 * resolves values live per invocation, so 1Password changes propagate
 * automatically. The `bb.agents.configure` instruction that tells the agent to
 * run commands through `bb-project-env-run` is contributed globally by
 * `project-environments` and becomes effective once preparation has staged a
 * profile for this (project, host, checkout).
 */
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { type SandboxProvider, sandboxProviderValues } from "../backend.js";

const NATIVE_PROVIDER_PREFIX = "sandbox-";
const DEFAULT_HOST_NAME_PREFIX = "bb-";

interface ThreadLike {
  id: string;
  environmentId: string | null;
}

function vendorOf(machineProviderId: string | null): SandboxProvider | null {
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

const VENDOR_LABELS: Record<SandboxProvider, string> = {
  daytona: "Daytona",
  modal: "Modal",
  e2b: "E2B",
  box: "Box",
  freestyle: "Freestyle",
  nirvana: "Nirvana",
};

async function prepareProjectEnvironment(
  bb: BbPluginApi,
  input: { projectId: string; hostId: string; workspacePath: string },
): Promise<void> {
  const started = await bb.sdk.plugins.callRpc({
    pluginId: "project-environments",
    method: "startPrepare",
    input: { ...input, strict: false },
    outputSchema: z.object({ jobId: z.string().uuid() }),
  });
  const deadline = Date.now() + 45 * 60_000;
  while (Date.now() < deadline) {
    const status = await bb.sdk.plugins.callRpc({
      pluginId: "project-environments",
      method: "preparationStatus",
      input: { jobId: started.jobId },
      outputSchema: z.discriminatedUnion("state", [
        z.object({ state: z.literal("running") }),
        z.object({
          state: z.literal("complete"),
          result: z.object({ ready: z.boolean() }).passthrough(),
        }),
        z.object({ state: z.literal("failed"), error: z.string() }),
      ]),
    });
    if (status.state === "complete") return;
    if (status.state === "failed") throw new Error(status.error);
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Project environment preparation timed out after 45 minutes");
}

export function registerNativeProjectEnvironmentSync(
  bb: BbPluginApi,
  deps: { isPluginRunning: (pluginId: string) => Promise<boolean> },
): void {
  const prepared = new Set<string>(); // dedup by `${hostId}:${path}`
  const renamed = new Set<string>(); // dedup by hostId
  const inFlight = new Map<string, Promise<void>>();

  const syncThread = async (thread: ThreadLike): Promise<void> => {
    const environmentId = thread.environmentId;
    if (environmentId === null) return;

    let environment;
    try {
      environment = await bb.sdk.environments.get({ environmentId });
    } catch {
      return;
    }

    let host;
    try {
      host = await bb.sdk.hosts.get({ hostId: environment.hostId });
    } catch {
      return;
    }
    const vendor = vendorOf(host.machineProviderId);
    if (vendor === null) return; // not a native sandbox host

    // 1. Clean host name: `Daytona · <project>` instead of `bb-<threadId>`.
    if (!renamed.has(host.id) && host.name.startsWith(DEFAULT_HOST_NAME_PREFIX)) {
      renamed.add(host.id);
      try {
        const project = await bb.sdk.projects.get({
          projectId: environment.projectId,
        });
        await bb.sdk.hosts.update({
          hostId: host.id,
          name: `${VENDOR_LABELS[vendor]} · ${project.name}`,
        });
      } catch (error) {
        renamed.delete(host.id);
        bb.log.warn(
          `Could not rename sandbox host ${host.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // 2. Project env injection — only once the checkout is ready.
    if (environment.status !== "ready" || environment.path === null) return;
    const key = `${environment.hostId}:${environment.path}`;
    if (prepared.has(key)) return;

    let pending = inFlight.get(key);
    if (pending === undefined) {
      const projectId = environment.projectId;
      const hostId = environment.hostId;
      const workspacePath = environment.path;
      pending = (async () => {
        if (!(await deps.isPluginRunning("project-environments"))) {
          bb.log.info(
            `Skipping project env for ${hostId}: project-environments not running`,
          );
          return;
        }
        bb.log.info(
          `Preparing project environment for native sandbox host ${hostId} (project ${projectId}, ${workspacePath})`,
        );
        await prepareProjectEnvironment(bb, { projectId, hostId, workspacePath });
        prepared.add(key);
        bb.log.info(`Prepared project environment for ${hostId}`);
      })().finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    await pending.catch((error: unknown) => {
      bb.log.warn(
        `Could not prepare project environment for sandbox host ${environment.hostId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  };

  bb.events.on("thread.created", ({ thread }) => {
    void syncThread(thread);
  });
  bb.events.on("thread.active", ({ thread }) => {
    void syncThread(thread);
  });
}
