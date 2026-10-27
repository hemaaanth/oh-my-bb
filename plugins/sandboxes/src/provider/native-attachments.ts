/** Read-only projection of exact legacy host/workspace selections during 3C handoff. */
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { AttachmentsView } from "../attachment-contract.js";

const NATIVE_PROVIDER_PREFIX = "sandbox-";

const workspaceSelectionSchema = z.object({
  credentialProfileId: z.string().nullable(),
  toolIds: z.array(z.string()).nullable(),
});

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


  return { view };
}
