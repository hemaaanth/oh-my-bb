// Prompt assembly (SPEC §11.2). Each prompt is the built-in text, then the
// runtime context for this session, then "Your instructions". The preview and
// the session body both come from here, so they always match. Owned by P1.
import type { DeviceProfile, PromptParts, ToolContext } from "../../shared/contract.js";
import type { ServerContext } from "../context.js";
import { currentInstructions } from "../instructions.js";
import { readPreferences } from "../preferences.js";
import { threadTitle } from "../tools/live.js";
import { exposedPlugins, listPlugins, type CommandPlugin } from "../tools/plugins.js";
import { BACKEND_PROMPT, RUNTIME_HEADING, VOICE_PROMPT, YOURS_HEADING, fillName } from "./built-in.js";

export const PART_SEPARATOR = "\n\n";
export const NO_INSTRUCTIONS = "None yet. The user has not saved any standing instructions.";

/** The context a preview uses when the app sends none. */
export const PREVIEW_CONTEXT: ToolContext = {
  threadId: null,
  projectId: null,
  onNewThreadScreen: false,
  mobile: false,
  canNavigate: true,
  channel: "app",
};

export type RuntimeInput = {
  agentName: string;
  context: ToolContext;
  device?: DeviceProfile | null;
  plugins: readonly CommandPlugin[];
  /** The thread on screen, when there is one. */
  thread?: { title: string; status: string } | null;
  projectName?: string | null;
  now: Date;
};

function deviceLine(context: ToolContext, device: DeviceProfile | null | undefined): string {
  if (context.channel === "phone") return "- Device: a phone call. The user has no screen in front of them.";
  const label = device?.label ? `${device.label}, ` : "";
  const kind = context.mobile ? "a phone or tablet" : "a computer";
  const navigation = context.mobile
    ? context.canNavigate
      ? "You may switch the screen to show a thread, or show it in the drawer beside the call."
      : "Do not switch the screen. Show threads in the drawer."
    : "You may bring threads on screen and open split panes.";
  return `- Device: ${label}${kind} in the BB app. ${navigation}`;
}

function placeLine(input: RuntimeInput): string {
  const { context } = input;
  if (context.channel === "phone") return "- Screen: none. Threads you open appear in the BB app window.";
  const project = input.projectName ? ` in the project ${input.projectName}` : "";
  if (context.onNewThreadScreen) return `- Screen: the New thread screen${project}.`;
  if (context.threadId && input.thread) {
    return `- Screen: the thread "${input.thread.title}" (${input.thread.status})${project}. Its id is ${context.threadId}.`;
  }
  if (context.threadId) return `- Screen: a thread with id ${context.threadId}${project}.`;
  return `- Screen: no thread is open${project}.`;
}

function pluginLines(plugins: readonly CommandPlugin[]): string {
  if (plugins.length === 0) return "- Plugin commands: none are allowed on this call.";
  const lines = plugins.map((plugin) => `  - ${plugin.name} (${plugin.id}): bb ${plugin.command}${plugin.summary ? ` — ${plugin.summary}` : ""}`);
  return ["- Plugin commands you may run with run_plugin_command:", ...lines].join("\n");
}

function timeLine(now: Date): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const when = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `- Local date and time: ${when}${zone ? ` (${zone})` : ""}.`;
}

/** The runtime context section. Pure, so tests can pin every line. */
export function buildRuntimeContext(input: RuntimeInput): string {
  return [
    RUNTIME_HEADING,
    "",
    `- Your name: ${input.agentName}.`,
    deviceLine(input.context, input.device),
    placeLine(input),
    pluginLines(input.plugins),
    timeLine(input.now),
  ].join("\n");
}

export function yoursSection(body: string): string {
  const text = body.trim();
  return `${YOURS_HEADING}\n\n${text === "" ? NO_INSTRUCTIONS : text}`;
}

export function assembleParts(builtIn: string, runtime: string, yours: string): PromptParts {
  return { builtIn, runtime, yours, assembled: [builtIn, runtime, yours].join(PART_SEPARATOR) };
}

export type AssembledPrompts = { voice: PromptParts; backend: PromptParts };

/** Read what the runtime context needs. Lookups that fail leave a part out. */
async function screenFacts(ctx: ServerContext, context: ToolContext) {
  if (context.channel === "phone") return { thread: null, projectName: null };
  const sdk = ctx.bb.sdk;
  const thread = context.threadId ? await sdk.threads.get({ threadId: context.threadId }).catch(() => null) : null;
  const projectId = context.projectId ?? thread?.projectId ?? null;
  const projects = projectId ? await sdk.projects.list().catch(() => []) : [];
  const projectName = projects.find((project) => project.id === projectId)?.name ?? null;
  return {
    thread: thread ? { title: threadTitle(thread), status: thread.runtime.displayStatus } : null,
    projectName,
  };
}

/** Both prompts for a session, as the session body and the preview see them. */
export async function assemblePrompts(
  ctx: ServerContext,
  input: { context: ToolContext; device?: DeviceProfile | null; now?: Date },
): Promise<AssembledPrompts> {
  const [preferences, plugins, facts] = await Promise.all([readPreferences(ctx), listPlugins(ctx), screenFacts(ctx, input.context)]);
  const runtime = buildRuntimeContext({
    agentName: preferences.agentName,
    context: input.context,
    device: input.device ?? null,
    plugins: exposedPlugins(plugins, preferences.pluginAccess),
    thread: facts.thread,
    projectName: facts.projectName,
    now: input.now ?? new Date(),
  });
  const yours = yoursSection(currentInstructions(ctx));
  return {
    voice: assembleParts(fillName(VOICE_PROMPT, preferences.agentName), runtime, yours),
    backend: assembleParts(fillName(BACKEND_PROMPT, preferences.agentName), runtime, yours),
  };
}
