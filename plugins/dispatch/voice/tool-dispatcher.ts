// Runs the voice tools for an in-app call (SPEC §11.6, CONTRACTS §2). Tools
// that act on this realm's screen run here, through the bindings. The rest go
// to the server with `toolInvoke`. Three tools do both: the server does the
// work and this realm then brings the thread on screen.
//
// Every result is a string. Errors start with "Error: ".

import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { DeviceProfile, Preferences, RpcContract, ToolContext } from "@/shared/contract.js";
import { FRONTEND_TOOLS, TOOL_ERROR_PREFIX } from "@/shared/tool-names.js";
import type { GhostTarget, PointerGhost } from "@/app/pointer-ghost/model.js";
import type { Bindings, PaneAction, ScreenContext, Split } from "./bindings.js";
import type { ToolOutcome, ToolWork, WorkStep } from "./call-store.js";
import { canNavigate } from "./device-profile.js";
import { appendComposerText, replaceComposerText } from "./draft.js";
import type { Disposition, DrawerView, DrawerViews } from "./drawer-views.js";

export interface FunctionCall {
  callId: string;
  name: string;
  /** JSON text from the model. */
  args: string;
}

export interface DispatcherDeps {
  rpc: Pick<PluginRpcClient<RpcContract>, "call">;
  bindings: () => Bindings | null;
  profile: DeviceProfile;
  /** Null when the ghost is off on this device. */
  ghost: () => PointerGhost | null;
  drawer: DrawerViews;
  prefs: () => Preferences;
  trace: (kind: string, payload?: Record<string, unknown>) => void;
  setWork: (work: ToolWork | null) => void;
  setOutcome: (outcome: ToolOutcome) => void;
  now?: () => number;
}

type Args = Record<string, unknown>;

const LATEST_OUTPUT_MAX = 1200;
const NOT_ON_SCREEN = "The thread was not brought on screen, so the call could stay on this screen.";
/** The server's own tool result has these names for a new thread's id. */
const THREAD_ID_KEYS = ["threadId", "thread_id", "id"] as const;

const error = (message: string) => `${TOOL_ERROR_PREFIX}${message}`;
const isError = (output: string) => output.startsWith(TOOL_ERROR_PREFIX);
const json = (value: unknown) => JSON.stringify(value);
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const messageOf = (cause: unknown) => (cause instanceof Error && cause.message ? cause.message : String(cause));
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

const SPLITS = new Set<Split>(["right", "left", "down", "top"]);
const PANE_ACTIONS = new Set<PaneAction>(["spotlight", "clear-spotlight", "maximize", "restore", "toggle"]);
const DISPOSITIONS = new Set<Disposition>(["auto", "reuse", "new"]);

function parseArgs(raw: string): Args | null {
  if (raw.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Args) : null;
  } catch {
    return null;
  }
}

function parseObject(output: string): Args | null {
  try {
    const value: unknown = JSON.parse(output);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Args) : null;
  } catch {
    return null;
  }
}

const isFrontendTool = (name: string) => (FRONTEND_TOOLS as readonly string[]).includes(name);

export class ToolDispatcher {
  private readonly now: () => number;

  constructor(private readonly deps: DispatcherDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The tool context the server gets with this realm's screen and flags. */
  context(focus?: boolean): ToolContext {
    const screen: ScreenContext = this.deps.bindings()?.context() ?? { threadId: null, projectId: null, onNewThreadScreen: false };
    return {
      ...screen,
      mobile: this.deps.profile.mobile,
      canNavigate: canNavigate(this.deps.profile),
      channel: "app",
      ...(focus === undefined ? {} : { focus }),
    };
  }

  async run(call: FunctionCall): Promise<string> {
    this.work(call.name, "run");
    let output: string;
    const args = parseArgs(call.args);
    try {
      output = args === null ? error("the tool arguments were not valid JSON.") : await this.route(call, args);
    } catch (cause) {
      output = error(messageOf(cause));
    }
    this.deps.setWork(null);
    this.deps.setOutcome({ tool: call.name, ok: !isError(output), at: this.now() });
    return output;
  }

  private work(tool: string, step: WorkStep) {
    this.deps.setWork({ tool, step, since: this.now() });
  }

  private route(call: FunctionCall, args: Args): Promise<string> {
    switch (call.name) {
      case "send_to_thread":
        return this.sendToThread(call, args);
      case "start_thread":
        return this.startThread(call, args);
      case "show_diff":
        return this.showDiff(call, args);
    }
    if (!isFrontendTool(call.name)) return this.invoke(call, args, this.context());
    switch (call.name) {
      case "get_context":
        return this.getContext();
      case "focus_thread":
        return this.focusThread(args);
      case "focus_threads":
        return this.focusThreads(args);
      case "manage_views":
        return this.manageViews(args);
      case "set_view_behavior":
        return this.setViewBehavior(args);
      case "set_pane":
        return this.setPane(args);
      case "set_composer_text":
      case "append_composer_text":
        return this.composerText(call.name, args);
    }
    return Promise.resolve(error(`unknown tool ${call.name}.`));
  }

  private async invoke(call: FunctionCall, args: Args, context: ToolContext): Promise<string> {
    try {
      const result = await this.deps.rpc.call("toolInvoke", { callId: call.callId, name: call.name, args, context });
      if (result.status === "error" && !isError(result.output)) return error(result.output);
      return result.output;
    } catch (cause) {
      return error(messageOf(cause));
    }
  }

  // --- Screen and navigation -------------------------------------------------

  /** A mobile realm that cannot navigate keeps the call's screen (SPEC §4, §9.4). */
  private suppressesFocus() {
    return this.deps.profile.mobile && !canNavigate(this.deps.profile);
  }

  private async getContext(): Promise<string> {
    const bindings = this.deps.bindings();
    const screen = this.context();
    if (screen.onNewThreadScreen || !screen.threadId) {
      return json({
        screen: screen.onNewThreadScreen ? `New thread screen in project ${screen.projectId ?? "(none)"}` : "No thread is open",
        projectId: screen.projectId,
      });
    }
    const [thread, output] = bindings
      ? await Promise.all([bindings.nav.thread(screen.threadId), bindings.nav.latestOutput(screen.threadId)])
      : [null, null];
    return json({
      thread: {
        id: screen.threadId,
        title: thread?.title ?? null,
        status: thread?.status ?? null,
        latestOutput: output ? clip(output, LATEST_OUTPUT_MAX) : null,
      },
      projectId: thread?.projectId ?? screen.projectId,
    });
  }

  /** Titles for the drawer. An id the server does not know is reported, not shown. */
  private async resolveViews(threadIds: string[]): Promise<{ views: DrawerView[]; missing: string[] }> {
    try {
      return await this.deps.rpc.call("drawerResolveThreads", { threadIds });
    } catch {
      return { views: threadIds.map((id) => ({ id, title: "Thread", projectId: null })), missing: [] };
    }
  }

  private presentDrawer(bindings: Bindings) {
    if (!this.deps.drawer.isPresented()) bindings.nav.openDrawer();
  }

  /**
   * Bring one thread on screen per SPEC §9.4. Returns how it was shown, or an
   * error string. Shared by focus_thread and the focus step of server tools.
   */
  private async bringOnScreen(
    threadId: string,
    options: { split?: Split; disposition?: Disposition; beside?: boolean } = {},
  ): Promise<{ how: "navigate" | "split" | "drawer"; title: string | null } | string> {
    const bindings = this.deps.bindings();
    if (!bindings) return error("nothing on this screen can open threads.");
    const { profile } = this.deps;
    const drawer = profile.mobile && (!canNavigate(profile) || options.beside === true);
    if (drawer) {
      const { views, missing } = await this.resolveViews([threadId]);
      if (views.length === 0 || missing.includes(threadId)) return error(`no thread has the id ${threadId}.`);
      this.deps.drawer.open(views, options.disposition ?? "auto", this.deps.prefs().mobileDrawerBehavior);
      this.presentDrawer(bindings);
      this.deps.trace("thread.focus", { threadId, how: "drawer" });
      return { how: "drawer", title: views[0]!.title };
    }
    if (!profile.mobile && options.split) {
      const opened = await bindings.nav.openSplit(threadId, options.split);
      if (!opened) bindings.nav.toThread(threadId);
      this.deps.trace("thread.focus", { threadId, how: opened ? "split" : "navigate" });
      return { how: opened ? "split" : "navigate", title: null };
    }
    bindings.nav.toThread(threadId);
    this.deps.trace("thread.focus", { threadId, how: "navigate" });
    return { how: "navigate", title: null };
  }

  private async focusThread(args: Args): Promise<string> {
    const threadId = text(args.thread_id);
    if (!threadId) return error("thread_id is required.");
    const split = text(args.split) as Split | undefined;
    const disposition = text(args.disposition) as Disposition | undefined;
    await this.point({ kind: "thread", threadId }, "focus_thread", "switch");
    const shown = await this.bringOnScreen(threadId, {
      ...(split && SPLITS.has(split) ? { split } : {}),
      ...(disposition && DISPOSITIONS.has(disposition) ? { disposition } : {}),
      beside: args.beside === true,
    });
    if (typeof shown === "string") return shown;
    return json({ ok: true, threadId, title: shown.title, shown: shown.how });
  }

  private async focusThreads(args: Args): Promise<string> {
    const ids = Array.isArray(args.thread_ids) ? args.thread_ids.filter((id): id is string => typeof id === "string") : [];
    if (ids.length === 0) return error("thread_ids needs at least one id.");
    const bindings = this.deps.bindings();
    if (!bindings) return error("nothing on this screen can open threads.");
    const { views, missing } = await this.resolveViews([...new Set(ids)].slice(0, 100));
    if (views.length === 0) return error(`none of these threads exist: ${missing.join(", ")}.`);
    const state = this.deps.drawer.open(views, "new", this.deps.prefs().mobileDrawerBehavior);
    this.presentDrawer(bindings);
    for (const view of views) this.deps.trace("thread.focus", { threadId: view.id, how: "drawer" });
    return json({ ok: true, shown: views.length, active: state.activeId, missing });
  }

  private async manageViews(args: Args): Promise<string> {
    const { drawer } = this.deps;
    const viewId = text(args.view_id);
    switch (args.action) {
      case "list":
        return json({ views: drawer.state.views.map(({ id, title }) => ({ id, title })), active: drawer.state.activeId });
      case "select": {
        if (!viewId) return error("view_id is required to select a view.");
        if (!drawer.select(viewId)) return error(`no view has the id ${viewId}.`);
        const bindings = this.deps.bindings();
        if (bindings) this.presentDrawer(bindings);
        return json({ ok: true, active: viewId });
      }
      case "close":
        if (!drawer.close(viewId ?? drawer.state.activeId)) return error(viewId ? `no view has the id ${viewId}.` : "no view is open.");
        return json({ ok: true, active: drawer.state.activeId, left: drawer.state.views.length });
      case "clear":
        drawer.clear();
        return json({ ok: true, left: 0 });
    }
    return error("action must be list, select, close, or clear.");
  }

  private async setViewBehavior(args: Args): Promise<string> {
    const behavior = args.behavior;
    if (behavior !== "reuse" && behavior !== "new") return error("behavior must be reuse or new.");
    const saved = await this.deps.rpc.call("preferencesWrite", { mobileDrawerBehavior: behavior });
    return json({ ok: true, behavior: saved.mobileDrawerBehavior });
  }

  private async setPane(args: Args): Promise<string> {
    const threadId = text(args.thread_id);
    const action = text(args.action) as PaneAction | undefined;
    if (!threadId) return error("thread_id is required.");
    if (!action || !PANE_ACTIONS.has(action)) return error("action must be spotlight, clear-spotlight, maximize, restore, or toggle.");
    const bindings = this.deps.bindings();
    if (!bindings) return error("nothing on this screen has panes.");
    const delivered = await bindings.nav.paneAction(threadId, action);
    if (delivered === 0) return error("that thread is not open in a pane. Focus it first.");
    return json({ ok: true, threadId, action });
  }

  private async composerText(name: "set_composer_text" | "append_composer_text", args: Args): Promise<string> {
    const value = text(args.text);
    if (value === undefined) return error("text is required.");
    const composer = this.deps.bindings()?.composer;
    if (!composer) return error("no composer on this screen.");
    await this.point({ kind: "composer" }, name, "type");
    const draft = composer.draft();
    const next = name === "set_composer_text" ? replaceComposerText(draft, value) : appendComposerText(draft, value);
    composer.replace(next);
    composer.focus();
    const action = name === "set_composer_text" ? "set" : "append";
    this.deps.trace("composer", { action, length: next.text.length });
    return json({ ok: true, action, length: next.text.length });
  }

  // --- Server tools with a focus step -----------------------------------------

  /** Move the ghost and show the step on the pet. Ghost off: the step still shows. */
  private async point(target: GhostTarget, tool: string, step: WorkStep): Promise<boolean> {
    this.work(tool, step);
    return (await this.deps.ghost()?.point(target)) ?? false;
  }

  private async sendToThread(call: FunctionCall, args: Args): Promise<string> {
    const threadId = text(args.thread_id);
    if (!threadId) return error("thread_id is required.");
    const ghost = this.deps.ghost();
    const touchesBefore = ghost?.touches() ?? 0;
    if (ghost) {
      await this.point({ kind: "thread", threadId }, call.name, "switch");
      await this.point({ kind: "composer" }, call.name, "type");
      await this.point({ kind: "send" }, call.name, "send");
      await ghost.press();
      // The user's own touch wins over the agent's send (SPEC §8).
      if (ghost.touches() !== touchesBefore) {
        ghost.hide();
        return error("the send was cancelled because the user touched the screen. Ask before you try again.");
      }
    } else {
      this.work(call.name, "send");
    }
    const quiet = args.quiet === true;
    const focus = !quiet && !this.suppressesFocus();
    const output = await this.invoke(call, args, this.context(focus ? undefined : false));
    if (isError(output)) return output;
    this.deps.trace("send", { threadId });
    if (quiet) return output;
    if (!focus) return this.withNote(call.name, output);
    const shown = await this.bringOnScreen(threadId);
    return typeof shown === "string" ? this.withNote(call.name, output) : output;
  }

  private async startThread(call: FunctionCall, args: Args): Promise<string> {
    const suppress = this.suppressesFocus();
    const output = await this.invoke(call, args, this.context(suppress ? false : undefined));
    if (isError(output)) return output;
    const result = parseObject(output);
    const threadId = THREAD_ID_KEYS.map((key) => text(result?.[key])).find(Boolean);
    if (!threadId) {
      // No prompt: the user types the first message on the New thread screen (SPEC §11.8).
      if (text(args.prompt)?.trim()) return output;
      if (suppress) return this.withNote(call.name, output);
      const bindings = this.deps.bindings();
      const projectId = text(result?.projectId) ?? text(args.project_id) ?? this.context().projectId ?? undefined;
      const hostId = text(result?.hostId) ?? text(args.machine_id);
      bindings?.nav.toCompose({ ...(projectId ? { projectId } : {}), ...(hostId ? { hostId } : {}) });
      return output;
    }
    if (suppress) return this.withNote(call.name, output);
    const shown = await this.bringOnScreen(threadId);
    return typeof shown === "string" ? this.withNote(call.name, output) : output;
  }

  private async showDiff(call: FunctionCall, args: Args): Promise<string> {
    const suppress = this.suppressesFocus();
    const output = await this.invoke(call, args, this.context(suppress ? false : undefined));
    const threadId = text(args.thread_id);
    if (isError(output) || !threadId) return output;
    if (suppress) return this.withNote(call.name, output);
    const shown = await this.bringOnScreen(threadId);
    return typeof shown === "string" ? this.withNote(call.name, output) : output;
  }

  /** Tell the agent the thread stayed off screen, so it can say so. */
  private withNote(tool: string, output: string): string {
    this.deps.trace("nav.suppressed", { tool });
    const result = parseObject(output);
    if (result) return json({ ...result, note: NOT_ON_SCREEN });
    return `${output}\nNote: ${NOT_ON_SCREEN}`;
  }
}
