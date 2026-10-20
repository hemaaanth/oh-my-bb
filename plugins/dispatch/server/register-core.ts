// Owned by P1: server core (readiness, preferences, instructions, prompts,
// tools, live session, ledger, notices).
import { CHANNELS, INSTRUCTIONS_LIMIT } from "../shared/constants.js";
import type { ToolContext } from "../shared/contract.js";
import type { CoreHandlers, ServerContext } from "./context.js";
import { latestRevision, restoreRevision, revisionHistory, writeFromSettings } from "./instructions.js";
import { appendTrace, callTrace, callsPage, liveStatus, usageReport } from "./ledger.js";
import { endCallsEverywhere, openCall } from "./live-session.js";
import { registerNotices } from "./notices.js";
import { readPreferences, resetPreferences, writePreferences } from "./preferences.js";
import { PREVIEW_CONTEXT, assemblePrompts } from "./prompts/index.js";
import { readSetupStatus, registerReadiness } from "./readiness.js";
import { executeServerTool } from "./tools/index.js";
import { threadTitle } from "./tools/live.js";
import { commandPlugins, listPlugins } from "./tools/plugins.js";

const OK = { ok: true } as const;

/**
 * Runs once at load, before RPC and CLI registration: readiness (first
 * `setup-updated`, the settings listener, the self-reload) and thread notices.
 */
export function registerCore(ctx: ServerContext): void {
  registerReadiness(ctx);
  registerNotices(ctx);
}

/** Every RPC method except `phoneDial`, `importHandsfree`, and `webhooks_receive`. */
export function coreRpcHandlers(ctx: ServerContext): CoreHandlers {
  const publish = ctx.bb.realtime.publish.bind(ctx.bb.realtime);
  return {
    // §3.1 Calls
    openCall: (input) => openCall(ctx, input),
    endCallsEverywhere: (input) => endCallsEverywhere(ctx, input),
    announcePresence: (input) => {
      publish(CHANNELS.presence, input);
      return OK;
    },
    pollPresence: () => {
      publish(CHANNELS.presencePing, {});
      return OK;
    },
    relayCommand: (input) => {
      publish(CHANNELS.agentCommand, { command: input.command, nonce: input.nonce ?? null });
      return OK;
    },

    // §3.2 Tools
    toolInvoke: (input) => executeServerTool(ctx, input),

    // §3.3 Trace and ledger
    traceAppend: (input) => {
      appendTrace(ctx, input.callId, input.events);
      return OK;
    },
    callsPage: (input) => callsPage(ctx, input),
    callTrace: (input) => callTrace(ctx, input),
    usageReport: (input) => usageReport(ctx, input.days),
    liveStatus: () => liveStatus(ctx),

    // §3.4 Settings and setup
    preferencesRead: () => readPreferences(ctx),
    preferencesWrite: (input) => writePreferences(ctx, input),
    preferencesReset: () => resetPreferences(ctx),
    setupStatus: () => readSetupStatus(ctx),
    pluginsWithCommands: async () => ({ plugins: commandPlugins(await listPlugins(ctx)) }),

    // §3.5 Instructions and prompt
    instructionsRead: () => ({ current: latestRevision(ctx), limit: INSTRUCTIONS_LIMIT }),
    instructionsWrite: (input) => writeFromSettings(ctx, input.body, input.note),
    instructionsHistory: (input) => ({ revisions: revisionHistory(ctx, input.limit) }),
    instructionsRestore: (input) => restoreRevision(ctx, input.id),
    promptPreview: (input) => {
      const context: ToolContext = { ...PREVIEW_CONTEXT, ...input.context };
      return assemblePrompts(ctx, { context });
    },

    // §3.6 Threads
    drawerResolveThreads: async (input) => {
      const found = await Promise.all(
        input.threadIds.map((threadId) => ctx.bb.sdk.threads.get({ threadId }).catch(() => null)),
      );
      const views: { id: string; title: string; projectId: string | null }[] = [];
      const missing: string[] = [];
      found.forEach((thread, index) => {
        if (thread && thread.visibility !== "hidden") views.push({ id: thread.id, title: threadTitle(thread), projectId: thread.projectId });
        else missing.push(input.threadIds[index]!);
      });
      return { views, missing };
    },
  };
}
