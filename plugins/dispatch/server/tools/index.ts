// The server tool executor (SPEC §11.6, §10.5). The app's toolInvoke and P3's
// sideband loop both call executeServerTool. Every call gets a string output,
// and errors start with "Error: ". Owned by P1.
import { execFile } from "node:child_process";
import { TOOL_ERROR_PREFIX, TOOL_NAMES, type ToolName } from "../../shared/tool-names.js";
import type { ToolContext } from "../../shared/contract.js";
import type { ServerContext } from "../context.js";
import { checkInstructionsBody, writeRevision } from "../instructions.js";
import { appendTrace } from "../ledger.js";
import { recallCalls } from "../memory.js";
import { readPreferences } from "../preferences.js";
import { buildCatalog, inCatalog, runsOn, type CatalogFlags } from "./catalog.js";
import { listLiveThreads, threadTitle } from "./live.js";
import { exposedPlugins, listPlugins } from "./plugins.js";
import { describeTarget, providersFor, resolveMachine, resolveProvider, routingTarget } from "./resolve.js";
import { startThread } from "./start.js";
import {
  archiveThread,
  compact,
  getThreadError,
  listMachines,
  listProjects,
  listThreads,
  openOnDesktop,
  optionalString,
  readThread,
  renameThread,
  requireString,
  searchThreads,
  sendToThread,
  setThreadModel,
  showDiff,
  stopThread,
  type ToolArgs,
} from "./threads.js";

export type ToolResult = { output: string; status: "success" | "error" };
export type ToolCall = { callId: string; name: string; args: ToolArgs; context: ToolContext };

/** run_plugin_command stdout is clipped to this. */
export const PLUGIN_OUTPUT_MAX = 8000;
/** A plugin command that runs longer than this is stopped. */
export const PLUGIN_COMMAND_TIMEOUT_MS = 60_000;
/** list_providers lists at most this many models in total. */
export const PROVIDER_MODELS_MAX = 100;
/** get_context clips the thread's latest output to this. */
export const CONTEXT_OUTPUT_MAX = 1500;

export const PHONE_NOTE =
  "The user is on a phone call. There is no screen in front of them, so describe things in words. Threads you focus or start still open in the BB app window, in case they are at their desk.";

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isToolName = (name: string): name is ToolName => (TOOL_NAMES as readonly string[]).includes(name);

/** The catalog flags for a session: plugin access comes from preferences and the live plugin list. */
export async function catalogFlags(ctx: ServerContext, input: { mobile: boolean; canNavigate: boolean; channel: ToolContext["channel"] }): Promise<CatalogFlags> {
  const [preferences, plugins] = await Promise.all([readPreferences(ctx), listPlugins(ctx)]);
  return {
    mobile: input.channel === "phone" ? false : input.mobile,
    canNavigate: input.canNavigate,
    channel: input.channel,
    allowedPluginIds: exposedPlugins(plugins, preferences.pluginAccess).map((plugin) => plugin.id),
    callMemory: preferences.callMemory,
  };
}

/** The tool catalog for a session body. */
export async function toolCatalog(ctx: ServerContext, input: { mobile: boolean; canNavigate: boolean; channel: ToolContext["channel"] }) {
  return buildCatalog(await catalogFlags(ctx, input));
}

// ---------------------------------------------------------------------------
// Executors that need more than the thread module

async function getContext(ctx: ServerContext, context: ToolContext): Promise<string> {
  switch (context.channel) {
    case "phone": {
      const live = await listLiveThreads(ctx);
      return compact({
        channel: "phone",
        note: PHONE_NOTE,
        liveThreads: live.map((thread) => ({
          id: thread.id,
          title: thread.title,
          status: thread.status,
          project: thread.projectName,
          machine: thread.machineName,
          ago: thread.ago,
        })),
      });
    }
    case "app": {
      // The app answers get_context itself. This branch serves a caller that
      // asks the server anyway, from the context the app sent.
      const sdk = ctx.bb.sdk;
      const projects = await sdk.projects.list();
      const project = context.projectId ? projects.find((entry) => entry.id === context.projectId) : undefined;
      const projectPart = project ? { project: { id: project.id, name: project.name } } : {};
      if (context.onNewThreadScreen) {
        return compact({ channel: "app", screen: "new-thread", ...projectPart, note: `The New thread screen is open${project ? ` in ${project.name}` : ""}.` });
      }
      if (!context.threadId) return compact({ channel: "app", screen: "other", ...projectPart, note: "No thread is on screen." });
      const thread = await sdk.threads.get({ threadId: context.threadId }).catch(() => null);
      if (!thread) return compact({ channel: "app", screen: "other", ...projectPart, note: "The thread on screen could not be read." });
      const { output } = await sdk.threads.output({ threadId: thread.id }).catch(() => ({ output: null }));
      return compact({
        channel: "app",
        screen: "thread",
        thread: {
          id: thread.id,
          title: threadTitle(thread),
          status: thread.runtime.displayStatus,
          ...(output && output.trim() ? { latestOutput: clip(output.trim(), CONTEXT_OUTPUT_MAX) } : {}),
        },
        ...projectPart,
      });
    }
  }
}

async function listProviders(ctx: ServerContext, args: ToolArgs, context: ToolContext): Promise<string> {
  const sdk = ctx.bb.sdk;
  const machineQuery = optionalString(args, "machine_id");
  const projectId = optionalString(args, "project_id") ?? context.projectId ?? undefined;
  const [projects, hosts] = await Promise.all([sdk.projects.list(), machineQuery ? sdk.hosts.list() : Promise.resolve([])]);
  const project = projectId ? (projects.find((entry) => entry.id === projectId) ?? null) : null;
  const host = machineQuery ? resolveMachine(machineQuery, hosts) : null;
  const target = routingTarget({ hostId: host?.id ?? null, project });
  let providers = await providersFor(ctx, target);
  const providerQuery = optionalString(args, "provider_id");
  if (providerQuery) providers = [resolveProvider(providerQuery, providers)];

  let budget = PROVIDER_MODELS_MAX;
  let truncated = false;
  const listed = providers.map((provider) => {
    const models = provider.models.slice(0, Math.max(0, budget));
    budget -= models.length;
    if (models.length < provider.models.length) truncated = true;
    return {
      id: provider.id,
      name: provider.displayName,
      models: models.map((model) => ({ id: model.id, label: model.displayName, ...(model.isDefault ? { default: true } : {}) })),
      ...(provider.modelError ? { modelError: provider.modelError } : {}),
    };
  });
  return compact({ scope: describeTarget(target), providers: listed, truncated });
}

async function focusOnPhone(ctx: ServerContext, args: ToolArgs, context: ToolContext): Promise<string> {
  const threadId = requireString(args, "thread_id");
  const thread = await ctx.bb.sdk.threads.get({ threadId }).catch(() => null);
  if (!thread) throw new Error(`There is no thread with id ${threadId}. Look it up with list_threads or search_threads.`);
  await openOnDesktop(ctx, threadId, context);
  return compact({ threadId, title: threadTitle(thread), note: "It is open in the BB app window." });
}

function updateInstructions(ctx: ServerContext, args: ToolArgs): string {
  const body = typeof args.instructions === "string" ? args.instructions : "";
  const reason = requireString(args, "reason");
  checkInstructionsBody(body);
  const revision = writeRevision(ctx, { body: body.trim(), author: "agent", note: reason });
  return compact({ saved: true, revision: revision.id, note: "Saved. The new instructions apply from the next call." });
}

function runBbCli(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.env.BB_CLI || "bb",
      [...argv],
      { timeout: PLUGIN_COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        const why = error && typeof error.code !== "number" ? error.message : "";
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || why });
      },
    );
  });
}

async function runPluginCommand(ctx: ServerContext, args: ToolArgs): Promise<string> {
  const pluginId = requireString(args, "plugin_id");
  const argv = Array.isArray(args.argv) ? args.argv.filter((value): value is string => typeof value === "string") : [];
  const [preferences, plugins] = await Promise.all([readPreferences(ctx), listPlugins(ctx)]);
  const plugin = exposedPlugins(plugins, preferences.pluginAccess).find((entry) => entry.id === pluginId);
  if (!plugin) throw new Error(`The plugin ${pluginId} is not available to run. The user can allow it in Dispatch settings, Tools.`);
  const result = await runBbCli([plugin.command, ...argv]);
  if (result.code !== 0) throw new Error(`exit code ${result.code}: ${clip(result.stderr.trim() || result.stdout.trim(), PLUGIN_OUTPUT_MAX)}`);
  return clip(result.stdout.trim(), PLUGIN_OUTPUT_MAX) || "The command finished with no output.";
}

// ---------------------------------------------------------------------------

async function run(ctx: ServerContext, name: ToolName, args: ToolArgs, context: ToolContext): Promise<string> {
  switch (name) {
    case "run_plugin_command":
      return runPluginCommand(ctx, args);
    case "get_context":
      return getContext(ctx, context);
    case "list_projects":
      return listProjects(ctx);
    case "list_machines":
      return listMachines(ctx, args, context);
    case "list_providers":
      return listProviders(ctx, args, context);
    case "list_live_threads":
      return compact(await listLiveThreads(ctx));
    case "list_threads":
      return listThreads(ctx, args);
    case "search_threads":
      return searchThreads(ctx, args);
    case "read_thread":
      return readThread(ctx, args);
    case "get_thread_error":
      return getThreadError(ctx, args);
    case "focus_thread":
      return focusOnPhone(ctx, args, context);
    case "send_to_thread":
      return sendToThread(ctx, args, context);
    case "set_thread_model":
      return setThreadModel(ctx, args);
    case "start_thread":
      return startThread(ctx, args, context);
    case "stop_thread":
      return stopThread(ctx, args);
    case "archive_thread":
      return archiveThread(ctx, args);
    case "rename_thread":
      return renameThread(ctx, args);
    case "show_diff":
      return showDiff(ctx, args, context);
    case "update_instructions":
      return updateInstructions(ctx, args);
    case "recall_calls": {
      const day = optionalString(args, "day");
      const query = optionalString(args, "query");
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      return compact(await recallCalls(ctx, { ...(day ? { day } : {}), ...(query ? { query } : {}), ...(limit ? { limit } : {}) }));
    }
    default:
      throw new Error(`${name} runs in the app, not on the server.`);
  }
}

/** Why the server will not run this tool here, or null when it will. */
function refusal(name: string, context: ToolContext): string | null {
  if (!isToolName(name)) return `There is no tool named ${name}.`;
  const flags: CatalogFlags = { mobile: context.mobile, canNavigate: context.canNavigate, channel: context.channel, allowedPluginIds: ["*"] };
  if (!inCatalog(name, flags)) return `${name} is not available on this call.`;
  // get_context is read-only, so the server answers it on either channel.
  if (name !== "get_context" && runsOn(name, context.channel) === "app") return `${name} runs in the app, not on the server.`;
  return null;
}

/**
 * Run one tool on the server and trace it. Never throws: a failure becomes an
 * "Error: …" output, because the model cannot continue without an output.
 */
export async function executeServerTool(ctx: ServerContext, call: ToolCall): Promise<ToolResult> {
  const started = Date.now();
  appendTrace(ctx, call.callId, [{ kind: "tool.call", at: started, payload: { name: call.name, args: call.args } }]);
  let result: ToolResult;
  const refused = refusal(call.name, call.context);
  if (refused) {
    result = { output: `${TOOL_ERROR_PREFIX}${refused}`, status: "error" };
  } else {
    try {
      result = { output: await run(ctx, call.name as ToolName, call.args, call.context), status: "success" };
    } catch (error) {
      result = { output: `${TOOL_ERROR_PREFIX}${messageOf(error)}`, status: "error" };
    }
  }
  appendTrace(ctx, call.callId, [
    { kind: "tool.result", at: Date.now(), payload: { name: call.name, status: result.status, output: result.output, ms: Date.now() - started } },
  ]);
  return result;
}
