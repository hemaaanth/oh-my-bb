// Runs an endpoint's configured action. Targets (thread, project, environment,
// automation) come only from the saved endpoint config. The payload supplies
// field values for templates and nothing else.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ActionSpec, EnvironmentSpec } from "../contract.js";
import type { DeliveryResult } from "./store.js";
import { renderMessage, renderTitle, type TemplateContext } from "./template.js";

export const AUTOMATIONS_PLUGIN_ID = "automations";

/** automations_get and automations_list items. A `problem` marks an automation that cannot run. */
export const automationSummary = z.looseObject({ id: z.string(), name: z.string(), problem: z.string().optional() });

const automationRunOutput = z.object({
  run: z.looseObject({ id: z.string(), status: z.string(), threadId: z.string().nullable().optional() }),
});

export type ActionInput = {
  endpointId: string;
  action: ActionSpec;
  context: TemplateContext;
  /** Stable for one logical event, so an Automations retry is idempotent too. */
  dedupeHash: string;
};

export async function runAction(bb: BbPluginApi, input: ActionInput): Promise<DeliveryResult> {
  const { action, context } = input;
  switch (action.type) {
    case "send": {
      await bb.sdk.threads.send({
        threadId: action.threadId,
        // Starts a turn when the thread is idle; BB decides how to deliver while it is busy.
        mode: "auto",
        input: [{ type: "text", text: renderMessage(action.message, context), mentions: [] }],
      });
      return { threadId: action.threadId };
    }
    case "spawn": {
      const thread = await bb.sdk.threads.spawn({
        projectId: action.projectId,
        environment: spawnEnvironment(action.environment),
        prompt: renderMessage(action.message, context),
        ...(action.title ? { title: renderTitle(action.title, context) } : {}),
        pluginMetadata: { endpointId: input.endpointId, deliveryId: context.deliveryId },
      });
      return { threadId: thread.id };
    }
    case "automation": {
      // automations_run takes no payload. The automation runs its saved prompt.
      const { run } = await bb.sdk.plugins.callRpc({
        pluginId: AUTOMATIONS_PLUGIN_ID,
        method: "automations_run",
        input: { projectId: action.projectId, automationId: action.automationId, idempotencyKey: automationIdempotencyKey(input.endpointId, input.dedupeHash) },
        outputSchema: automationRunOutput,
      });
      return { automationRunId: run.id, automationRunStatus: run.status, ...(run.threadId ? { threadId: run.threadId } : {}) };
    }
  }
}

/** At most 200 characters, as automations_run requires. */
export const automationIdempotencyKey = (endpointId: string, dedupeHash: string) => `webhooks:${endpointId}:${dedupeHash}`;

type SpawnEnvironment = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]["environment"];

export function spawnEnvironment(environment: EnvironmentSpec): SpawnEnvironment {
  switch (environment.type) {
    case "project-default":
      return { type: "project-default" };
    case "reuse":
      return { type: "reuse", environmentId: environment.environmentId };
    case "worktree":
      return {
        type: "host",
        ...(environment.hostId ? { hostId: environment.hostId } : {}),
        workspace: {
          type: "managed-worktree",
          baseBranch: environment.baseBranch ? { kind: "named", name: environment.baseBranch } : { kind: "default" },
        },
      };
    case "provider":
      return { type: "provider", environmentProviderId: environment.environmentProviderId, inputs: environment.inputs };
  }
}

/**
 * Checks that the saved targets exist before an endpoint goes live.
 * Throws a TargetError with a short reason the owner can act on.
 */
export async function checkTargets(bb: BbPluginApi, action: ActionSpec): Promise<void> {
  let problem: string | null = null;
  try {
    switch (action.type) {
      case "send": {
        const thread = await bb.sdk.threads.get({ threadId: action.threadId });
        if (thread.archivedAt) problem = "the thread is archived";
        break;
      }
      case "spawn":
        await bb.sdk.projects.get({ projectId: action.projectId });
        return;
      case "automation": {
        const automation = await bb.sdk.plugins.callRpc({
          pluginId: AUTOMATIONS_PLUGIN_ID,
          method: "automations_get",
          input: { projectId: action.projectId, automationId: action.automationId },
          outputSchema: automationSummary,
        });
        problem = automation.problem ?? null;
        break;
      }
    }
  } catch (error) {
    throw new TargetError(targetProblem(action), { cause: error });
  }
  if (problem) throw new TargetError(`${targetLabel(action)} cannot be used: ${problem}.`);
}

export class TargetError extends Error {}

const targetLabel = (action: ActionSpec) =>
  action.type === "send" ? `Thread ${action.threadId}` : action.type === "spawn" ? `Project ${action.projectId}` : `Automation ${action.automationId}`;

function targetProblem(action: ActionSpec): string {
  switch (action.type) {
    case "send":
      return `Thread ${action.threadId} was not found or is not readable.`;
    case "spawn":
      return `Project ${action.projectId} was not found.`;
    case "automation":
      return `Automation ${action.automationId} was not found in project ${action.projectId}, or the Automations plugin is not installed and enabled.`;
  }
}
