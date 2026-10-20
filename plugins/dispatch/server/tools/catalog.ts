// The voice tool catalog (CONTRACTS §2, SPEC §11.6). Descriptions are what
// the reasoning model reads, so they say when to use each tool. Owned by P1.
import { LIST_THREADS } from "../../shared/constants.js";
import type { CallChannel, ToolSpec } from "../../shared/contract.js";
import {
  APP_ONLY_TOOLS,
  FRONTEND_TOOLS,
  MOBILE_APP_TOOLS,
  SERVER_THEN_FOCUS_TOOLS,
  TOOL_NAMES,
  type ToolName,
} from "../../shared/tool-names.js";

export type CatalogFlags = { mobile: boolean; canNavigate: boolean; channel: CallChannel; allowedPluginIds: readonly string[] };

type JsonSchema = Record<string, unknown>;
type Properties = Record<string, JsonSchema>;

const str = (description: string): JsonSchema => ({ type: "string", description });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });
const oneOf = (values: readonly string[], description: string): JsonSchema => ({ type: "string", enum: [...values], description });

function object(properties: Properties = {}, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const THREAD_ID = str("The thread id, from a list, search, or get_context result.");

const DESCRIPTIONS: Record<ToolName, string> = {
  run_plugin_command:
    "Run a command from another installed BB plugin and return its output. When you are not sure how the command works, run it with --help first.",
  get_context:
    "Where the user is right now: the thread on screen (with its status and latest output) and its project, or the New thread screen, or a phone call. Call it first when the user says this thread or here, or names no thread.",
  list_projects: "List the user's projects with their ids, and say which one is the personal project.",
  list_machines:
    "List the machines connected to BB, with their status. With a project, also say which machines hold that project and which one is its default.",
  list_providers:
    "List the agent providers and their models that can run a new thread. Scope it with a project, a machine, or one provider.",
  list_live_threads:
    "List threads that are working now, plus threads that finished in the last 30 minutes. Use it for questions like what is running or what just finished.",
  list_threads: "List open threads, newest activity first. Filter by project, or set archived to list archived threads instead.",
  search_threads: "Search threads by their text and titles. Use it when the user names a thread by topic.",
  read_thread:
    "Read one thread: status, title, project, machine, and the latest agent output. When there is no output, it says how the last turn ended.",
  get_thread_error: "Explain the latest error or interruption in a thread, or say there is none.",
  focus_thread: "Bring a thread on screen for the user.",
  focus_threads: "Add several threads to the drawer on the phone or tablet, one view each. The last one is shown.",
  manage_views: "List, select, close, or clear the thread views in the drawer on the phone or tablet.",
  set_view_behavior:
    "Choose whether showing a thread in the drawer replaces the current view (reuse) or adds a new one (new). It is saved for later calls.",
  set_pane: "Change how a thread's pane is laid out: spotlight it, clear the spotlight, maximize, restore, or toggle.",
  send_to_thread:
    "Send a message to a thread as the user. Write it in the first person, as the user would type it. Never use it to change a thread's model, provider, or machine.",
  set_thread_model: "Change the model of a thread, by model name. The thread keeps its provider.",
  start_thread:
    "Start a new thread. Pass the user's own words as the prompt and a short title you make up. Without a prompt, the New thread screen opens so the user can type.",
  stop_thread: "Stop a thread that is working. Ask the user for a clear yes first.",
  archive_thread: "Archive a thread and its child threads. Ask the user for a clear yes first.",
  rename_thread: "Give a thread a new title.",
  show_diff: "Sum up the files a thread changed, with added and removed lines, and bring the thread on screen.",
  update_instructions:
    "Save the user's standing instructions for future calls. Use it only when the user asks you to remember something for later. Pass the complete new text of the instructions, not only the change.",
  set_composer_text: "Replace the text in the message box of the thread on screen. Nothing is sent.",
  append_composer_text: "Add text to the end of the message box of the thread on screen. Nothing is sent.",
};

function parametersFor(name: ToolName, flags: CatalogFlags): JsonSchema {
  const phone = flags.channel === "phone";
  switch (name) {
    case "run_plugin_command":
      return object(
        {
          plugin_id: oneOf(flags.allowedPluginIds, "The plugin whose command to run."),
          argv: { type: "array", items: { type: "string" }, description: "Arguments after the command name, for example [\"--help\"]." },
        },
        ["plugin_id"],
      );
    case "get_context":
    case "list_projects":
    case "list_live_threads":
      return object();
    case "list_machines":
      return object({ project_id: str("Show which machines hold this project. Defaults to the current project.") });
    case "list_providers":
      return object({
        project_id: str("The project the thread would run in."),
        machine_id: str("A machine id or name."),
        provider_id: str("Only this provider, by id or name."),
      });
    case "list_threads":
      return object({
        project_id: str("Only threads in this project."),
        limit: { type: "integer", minimum: 1, maximum: LIST_THREADS.max, default: LIST_THREADS.default, description: "How many threads to list." },
        archived: bool("List archived threads instead of open ones."),
      });
    case "search_threads":
      return object({ query: str("Words to look for.") }, ["query"]);
    case "read_thread":
    case "get_thread_error":
    case "stop_thread":
    case "archive_thread":
    case "show_diff":
      return object({ thread_id: THREAD_ID }, ["thread_id"]);
    case "focus_thread": {
      const properties: Properties = { thread_id: THREAD_ID };
      if (!phone && flags.mobile) {
        properties.disposition = oneOf(
          ["auto", "reuse", "new"],
          "Replace the current drawer view (reuse), add a view (new), or follow the saved setting (auto).",
        );
        if (flags.canNavigate) properties.beside = bool("Show it in the drawer beside the call instead of switching the screen.");
      } else if (!phone) {
        properties.split = oneOf(["right", "left", "down", "top"], "Open it in a split pane on this side instead of replacing the view.");
      }
      return object(properties, ["thread_id"]);
    }
    case "focus_threads":
      return object(
        { thread_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100, description: "Thread ids to add, in order." } },
        ["thread_ids"],
      );
    case "manage_views":
      return object(
        { action: oneOf(["list", "select", "close", "clear"], "What to do with the drawer views."), view_id: str("The view to select or close.") },
        ["action"],
      );
    case "set_view_behavior":
      return object({ behavior: oneOf(["reuse", "new"], "reuse replaces the current view; new adds one.") }, ["behavior"]);
    case "set_pane":
      return object(
        { thread_id: THREAD_ID, action: oneOf(["spotlight", "clear-spotlight", "maximize", "restore", "toggle"], "The pane action.") },
        ["thread_id", "action"],
      );
    case "send_to_thread": {
      const properties: Properties = { thread_id: THREAD_ID, message: str("The message, in the user's voice.") };
      if (!phone && flags.canNavigate) properties.quiet = bool("Send without bringing the thread on screen.");
      return object(properties, ["thread_id", "message"]);
    }
    case "set_thread_model":
      return object({ thread_id: THREAD_ID, model: str("The model name, as the user said it.") }, ["thread_id", "model"]);
    case "start_thread":
      return object({
        project_id: str("The project. Defaults to the current project, then the personal project."),
        prompt: str("What the thread should do, in the user's own words. Leave it out to open the New thread screen."),
        title: str("A short title you make up from the request."),
        machine_id: str("A machine id or name. Defaults to the project's default machine."),
        provider_id: str("A provider id or name."),
        model: str("A model name."),
      });
    case "rename_thread":
      return object({ thread_id: THREAD_ID, title: str("The new title.") }, ["thread_id", "title"]);
    case "update_instructions":
      return object(
        {
          instructions: str("The complete new text of the user's standing instructions."),
          reason: str("A few words on what changed, for the history."),
        },
        ["instructions", "reason"],
      );
    case "set_composer_text":
    case "append_composer_text":
      return object({ text: str("The text.") }, ["text"]);
  }
}

/** Where a tool runs on this channel. On the phone the server runs everything. */
export function runsOn(name: ToolName, channel: CallChannel): ToolSpec["runsOn"] {
  if (channel === "phone") return "server";
  if ((SERVER_THEN_FOCUS_TOOLS as readonly string[]).includes(name)) return "both";
  if ((FRONTEND_TOOLS as readonly string[]).includes(name)) return "app";
  return "server";
}

/** True when the tool belongs in a session with these flags. */
export function inCatalog(name: ToolName, flags: CatalogFlags): boolean {
  if (name === "run_plugin_command") return flags.allowedPluginIds.length > 0;
  if ((APP_ONLY_TOOLS as readonly string[]).includes(name)) return flags.channel === "app";
  if ((MOBILE_APP_TOOLS as readonly string[]).includes(name)) return flags.channel === "app" && flags.mobile;
  return true;
}

/** The catalog in TOOL_NAMES order. */
export function buildCatalog(flags: CatalogFlags): ToolSpec[] {
  return TOOL_NAMES.filter((name) => inCatalog(name, flags)).map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    parameters: parametersFor(name, flags),
    runsOn: runsOn(name, flags.channel),
  }));
}

/** The function tool shape the session body's delegation expects. */
export function toFunctionTools(tools: readonly ToolSpec[]): Array<{ type: "function"; name: string; description: string; parameters: JsonSchema }> {
  return tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters }));
}
