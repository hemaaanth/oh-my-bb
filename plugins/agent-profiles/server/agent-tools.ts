import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  agentDocumentReadParametersSchema,
  agentPersonaUpdateParametersSchema,
  delegateAgentProfileParametersSchema,
  DELEGATION_HEADER_END,
} from "./contract";
import type { Profiles } from "./profiles";
import { AGENTS_PROVIDER_ID } from "./provider-ids";

export function registerAgentTools(bb: BbPluginApi, profiles: Profiles) {
  bb.agents.registerTool({
    name: "delegate_agent_profile",
    description: "Start or continue a child BB thread as a saved agent, with its persona, model, and permissions. Runs are parallel; a full agent's DM learns what each run answered.",
    instructions: "Use this when an @agent mention asks you to delegate work. Continue prior work in the latest matching child, choose fresh for an independent task, and keep coordinating from the parent thread.",
    presentation: {
      label: {
        pending: "Delegating to agent profile",
        completed: "Delegated to agent profile",
      },
      icon: { glyph: "UserRoundPlus" },
    },
    parameters: delegateAgentProfileParametersSchema,
    async execute({ profileId, task, why, title, mode }, context) {
      const profile = profiles.getProfile(profileId);
      profiles.joinThread(context.threadId, profileId);
      if (mode !== "fresh") {
        const prior = profiles.latestDelegationThread(profileId, context.threadId);
        if (prior) {
          const thread = await bb.sdk.threads.get({ threadId: prior.threadId }).catch((error: unknown) => {
            if (mode === "continue") throw new Error(`Unable to continue the prior @${profile.slug} thread: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          });
          if (thread && thread.providerId !== AGENTS_PROVIDER_ID)
            throw new Error(`The prior @${profile.slug} thread is history-only. Use mode fresh to start a new child as this agent.`);
          if (thread && thread.deletedAt !== null)
            throw new Error(`The prior @${profile.slug} child was deleted. Use mode fresh to start a new child as this agent.`);
          if (thread) try {
            await bb.sdk.threads.send({
              threadId: prior.threadId,
              mode: "auto",
              input: [{ type: "text", text: task, mentions: [] }],
            });
            return JSON.stringify({
              status: "continued",
              threadId: prior.threadId,
              profile: `@${profile.slug}`,
              profileId,
              directive: `::agent-profile-delegation{threadId="${prior.threadId}"}`,
              instruction: "FINAL RESPONSE REQUIREMENT: Copy the directive into your response exactly once so the child result and follow-up composer render inline. Also copy any distinct BB page directives returned by the child.",
            });
          } catch (error) {
            if (mode === "continue") throw new Error(`Unable to continue the prior @${profile.slug} thread: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else if (mode === "continue") {
          throw new Error(`No prior @${profile.slug} delegation exists in this parent thread.`);
        }
      }
      const result = await profiles.spawnProfile({
        profileId,
        projectId: context.projectId,
        parentThreadId: context.threadId,
        visibility: "visible",
        environment: await profiles.delegationEnvironment(context.projectId, context.threadId),
        title: title ?? task.replace(/\s+/gu, " ").slice(0, 120),
        prompt: [
          `You are a delegated subagent working for a parent agent.`,
          `Delegation rationale: ${why}`,
          DELEGATION_HEADER_END,
          task,
        ].join("\n\n"),
      });
      return JSON.stringify({
        status: "spawned",
        threadId: result.threadId,
        profile: `@${profile.slug}`,
        profileId: result.profileId,
        revision: result.revision,
        environmentId: result.environmentId,
        directive: `::agent-profile-delegation{threadId="${result.threadId}"}`,
        instruction: "FINAL RESPONSE REQUIREMENT: Copy the directive into your response exactly once so the child result and follow-up composer render inline. Also copy any distinct BB page directives returned by the child.",
      });
    },
  });

  bb.agents.registerTool({
    name: "agent_document_read",
    description:
      "Read the current MISSION.md or PERSONA.md for the agent bound to this thread.",
    presentation: {
      label: {
        pending: "Reading agent document",
        completed: "Read agent document",
      },
      icon: { glyph: "FileText" },
    },
    parameters: agentDocumentReadParametersSchema,
    async execute({ file }, context) {
      const agent = profiles.resolveAgentForThread(context.threadId).profile;
      const value = await profiles.homes.agentDocument(agent, file);
      return JSON.stringify({ file, ...value });
    },
  });

  bb.agents.registerTool({
    name: "agent_persona_update",
    description:
      "Replace the persona of the agent bound to this thread: who it is and how it works. The change applies from the next turn.",
    instructions:
      "Read PERSONA.md first and pass its current version. Keep what still holds and add only lasting lessons about how you work, not task facts. After saving, tell the owner in one sentence what you changed.",
    presentation: {
      label: {
        pending: "Updating persona",
        completed: "Updated persona",
      },
      icon: { glyph: "Sparkles" },
    },
    parameters: agentPersonaUpdateParametersSchema,
    async execute({ text, version }, context) {
      const agent = profiles.resolveAgentForThread(context.threadId).profile;
      const saved = await profiles.homes.saveAgentDocument(
        agent,
        "PERSONA.md",
        text,
        version,
        `@${agent.slug}`,
      );
      bb.realtime.publish("agent-document-changed", {
        agentId: agent.id,
        file: "PERSONA.md",
      });
      return JSON.stringify({
        version: saved.version,
        note: "Saved. The owner can undo it from the agent's Persona history. Tell them what you changed.",
      });
    },
  });
}
