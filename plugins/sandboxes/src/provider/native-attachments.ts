/**
 * Native-path implementation of the thread-header machine panel's config
 * sections (credential set / tools / skills / agents). The legacy `attachments`
 * module resolves everything from the `SandboxRecord` store, which native BB 0.43
 * sandboxes do not have. This resolves the `(projectId, hostId, workspacePath)`
 * triple from the SDK environment and calls the same downstream plugin RPCs
 * (`project-environments`, `catalog`, `agent-profiles`), so behaviour matches the
 * legacy panel.
 *
 * Pre-authentication (the auth-bundle "GitHub CLI / subscription" toggles) is
 * store/auth-bundle coupled and deferred: `authIds` is reported as `null` and
 * `auth` changes are rejected for native hosts.
 */
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  type AttachmentChange,
  type AttachmentsView,
} from "../attachment-contract.js";
import { runHostCommand } from "../host-command.js";

const NATIVE_PROVIDER_PREFIX = "sandbox-";

const ok = z.object({ ok: z.literal(true) });
const workspaceSelectionSchema = z.object({
  credentialProfileId: z.string().nullable(),
  toolIds: z.array(z.string()).nullable(),
});
const jobStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("running") }),
  z.object({ state: z.literal("failed"), error: z.string() }),
  z.object({
    state: z.literal("complete"),
    result: z.object({ ready: z.boolean() }).passthrough(),
  }),
]);

interface NativeTarget {
  hostId: string;
  projectId: string;
  workspacePath: string;
}

/** Aggregated project options (reuses the server's launch-preview closure). */
interface LaunchPreview {
  tools: Array<{ id: string }>;
  skills: Array<{ id: string }>;
  agents: Array<{ id: string }>;
  availableTools: unknown[];
  availableSkills: unknown[];
  availableAgents: unknown[];
}

export interface NativeAttachmentsDeps {
  launchPreview(input: {
    projectId: string;
    credentialProfileId: string | null;
  }): Promise<LaunchPreview>;
  credentialProfiles(): Promise<unknown[]>;
}

export function createNativeAttachments(
  bb: BbPluginApi,
  deps: NativeAttachmentsDeps,
) {
  const resolveTarget = async (
    threadId: string,
  ): Promise<NativeTarget | null> => {
    const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
    const environmentId = thread?.environmentId ?? null;
    if (environmentId === null) return null;
    const environment = await bb.sdk.environments
      .get({ environmentId })
      .catch(() => null);
    if (
      environment === null ||
      environment.status !== "ready" ||
      environment.path === null
    ) {
      return null;
    }
    const host = await bb.sdk.hosts
      .get({ hostId: environment.hostId })
      .catch(() => null);
    if (host?.machineProviderId?.startsWith(NATIVE_PROVIDER_PREFIX) !== true) {
      return null;
    }
    return {
      hostId: environment.hostId,
      projectId: environment.projectId,
      workspacePath: environment.path,
    };
  };

  // Resolve the host's real $HOME so catalog skills project into the right roots
  // (`$HOME/.bb`, `.agents`, `.claude`). This must match how the daemon's home is
  // set — it is NOT always /root (e.g. non-Daytona providers). Prefer asking the
  // host, then derive from the native checkout path (<home>/.bb-machines/...),
  // then fall back to /root.
  const resolveHome = async (
    hostId: string,
    workspacePath: string,
  ): Promise<string> => {
    try {
      const result = await runHostCommand(bb, {
        hostId,
        cwd: workspacePath,
        command: `printf %s "$HOME"`,
        title: "Resolve home directory",
        timeoutMs: 30_000,
      });
      const home = result.output.trim();
      if (result.exitCode === 0 && home.startsWith("/")) return home;
    } catch {
      // fall through to path derivation
    }
    const marker = "/.bb-machines/";
    const index = workspacePath.indexOf(marker);
    return index > 0 ? workspacePath.slice(0, index) : "/root";
  };

  const workspaceSelection = (target: NativeTarget) =>
    bb.sdk.plugins.callRpc({
      pluginId: "project-environments",
      method: "workspaceSelection",
      input: {
        projectId: target.projectId,
        hostId: target.hostId,
        workspacePath: target.workspacePath,
      },
      outputSchema: workspaceSelectionSchema,
    });

  const waitJob = async (
    pluginId: string,
    method: string,
    input: Record<string, string | null>,
    statusMethod: string,
  ): Promise<void> => {
    const job = await bb.sdk.plugins.callRpc({
      pluginId,
      method,
      input,
      outputSchema: z.object({ jobId: z.string() }),
    });
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const status = await bb.sdk.plugins.callRpc({
        pluginId,
        method: statusMethod,
        input: job,
        outputSchema: jobStatusSchema,
      });
      if (status.state === "failed") throw new Error(status.error);
      if (status.state === "complete") {
        if (!status.result.ready) {
          throw new Error("Some attachments could not be prepared. Retry.");
        }
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error("The attachment update timed out.");
  };

  /** Returns null when the thread is not on a native sandbox host. */
  async function view(threadId: string): Promise<AttachmentsView | null> {
    const target = await resolveTarget(threadId);
    if (target === null) return null;
    const workspace = await workspaceSelection(target);
    const [preview, credentials, skills, agents] = await Promise.all([
      deps.launchPreview({
        projectId: target.projectId,
        credentialProfileId: workspace.credentialProfileId,
      }),
      deps.credentialProfiles(),
      bb.sdk.plugins.callRpc({
        pluginId: "catalog",
        method: "getSandboxSkills",
        input: { hostId: target.hostId },
        outputSchema: z.object({ skillIds: z.array(z.string()).nullable() }),
      }),
      bb.sdk.plugins.callRpc({
        pluginId: "agent-profiles",
        method: "getSandboxAgents",
        input: { hostId: target.hostId },
        outputSchema: z.object({ agentIds: z.array(z.string()).nullable() }),
      }),
    ]);
    return {
      sandboxId: target.hostId,
      credentialProfileId: workspace.credentialProfileId,
      authIds: null, // pre-auth deferred for native hosts
      toolIds: workspace.toolIds ?? preview.tools.map((tool) => tool.id),
      skillIds: skills.skillIds ?? preview.skills.map((skill) => skill.id),
      agentIds: agents.agentIds ?? preview.agents.map((agent) => agent.id),
      credentials: credentials as AttachmentsView["credentials"],
      tools: preview.availableTools as AttachmentsView["tools"],
      skills: preview.availableSkills as AttachmentsView["skills"],
      agents: preview.availableAgents as AttachmentsView["agents"],
      operation: null,
    };
  }

  /** Returns false when the thread is not a native sandbox (caller falls back). */
  async function update(
    threadId: string,
    change: AttachmentChange,
  ): Promise<boolean> {
    const target = await resolveTarget(threadId);
    if (target === null) return false;

    if (change.kind === "auth") {
      throw new Error("Pre-authentication isn’t configurable for this sandbox yet.");
    }
    if (change.kind === "agents") {
      await bb.sdk.plugins.callRpc({
        pluginId: "agent-profiles",
        method: "setSandboxAgents",
        input: { hostId: target.hostId, agentIds: change.ids },
        outputSchema: ok,
      });
      return true;
    }
    if (change.kind === "skills") {
      await bb.sdk.plugins.callRpc({
        pluginId: "catalog",
        method: "setSandboxSkills",
        input: { hostId: target.hostId, skillIds: change.ids },
        outputSchema: ok,
      });
      await waitJob(
        "catalog",
        "startMaterialize",
        {
          hostId: target.hostId,
          homePath: await resolveHome(target.hostId, target.workspacePath),
          projectId: target.projectId,
          workspacePath: target.workspacePath,
        },
        "materializationStatus",
      );
      return true;
    }
    // tools | credentials → project-environments prepare
    const current = await workspaceSelection(target);
    if (change.kind === "tools" && !current.credentialProfileId && change.ids.length) {
      throw new Error("Attach a credential set before selecting project tools.");
    }
    const credentialProfileId =
      change.kind === "credentials" ? change.id : current.credentialProfileId;
    await bb.sdk.plugins.callRpc({
      pluginId: "project-environments",
      method: "prepare",
      input: {
        projectId: target.projectId,
        hostId: target.hostId,
        workspacePath: target.workspacePath,
        credentialProfileId,
        ...(change.kind === "tools" ? { toolIds: change.ids } : {}),
        skipWorkspaceSetup: true,
        strict: credentialProfileId !== null,
      },
      outputSchema: z.object({}).passthrough(),
    });
    return true;
  }

  return { view, update };
}
