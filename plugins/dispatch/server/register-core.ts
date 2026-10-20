// Owned by P1: server core (readiness, preferences, instructions, prompts,
// tools, live session, ledger, notices). P0 left placeholders only.
import type { CoreHandlers, ServerContext } from "./context.js";
import { notImplemented } from "./context.js";

/**
 * Runs once at load, before RPC and CLI registration. P1 adds the settings
 * `onChange` listener, the first `setup-updated` publish, and the
 * `thread.idle` / `thread.failed` listeners here.
 */
export function registerCore(_ctx: ServerContext): void {}

/** Every RPC method except `phoneDial`, `importHandsfree`, and `webhooks_receive`. */
export function coreRpcHandlers(_ctx: ServerContext): CoreHandlers {
  return notImplemented([
    "openCall",
    "endCallsEverywhere",
    "announcePresence",
    "pollPresence",
    "relayCommand",
    "toolCatalog",
    "toolInvoke",
    "traceAppend",
    "callsPage",
    "callTrace",
    "usageReport",
    "liveStatus",
    "preferencesRead",
    "preferencesWrite",
    "preferencesReset",
    "setupStatus",
    "pluginsWithCommands",
    "instructionsRead",
    "instructionsWrite",
    "instructionsHistory",
    "instructionsRestore",
    "promptPreview",
    "drawerResolveThreads",
  ]);
}
