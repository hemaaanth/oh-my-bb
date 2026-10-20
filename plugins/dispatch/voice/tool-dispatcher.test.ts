import { describe, expect, it, vi } from "vitest";
import type { ComposerDraftSnapshot } from "@get-bb/plugin-sdk/app";
import type { DeviceProfile } from "@/shared/contract.js";
import { defaultPreferences } from "@/shared/constants.js";
import type { PointerGhost } from "@/app/pointer-ghost/model.js";
import type { Bindings, ComposerBindings, NavBindings } from "./bindings.js";
import { DrawerViews } from "./drawer-views.js";
import { ToolDispatcher, type DispatcherDeps } from "./tool-dispatcher.js";

const DESKTOP: DeviceProfile = { platform: "macOS", mobile: false, browser: "Chrome", displayMode: "browser", runtime: "browser", label: "desktop" };
const PHONE: DeviceProfile = { platform: "iOS", mobile: true, browser: "Safari", displayMode: "standalone", runtime: "pwa", label: "pwa" };
const WEBVIEW: DeviceProfile = { platform: "iOS", mobile: true, browser: "WebView", displayMode: "browser", runtime: "native-webview", label: "app" };

function nav(): NavBindings {
  return {
    toThread: vi.fn(),
    openSplit: vi.fn(async () => true),
    toCompose: vi.fn(),
    openDrawer: vi.fn(() => true),
    paneAction: vi.fn(async () => 1),
    thread: vi.fn(async (id: string) => ({ id, title: "Fix login", status: "idle", projectId: "p1" })),
    latestOutput: vi.fn(async () => "Done."),
  };
}

function composer(text = ""): ComposerBindings & { current: ComposerDraftSnapshot } {
  const box = {
    current: { text, mentions: [], attachments: [] } as ComposerDraftSnapshot,
    draft: () => box.current,
    replace: vi.fn((next: ComposerDraftSnapshot) => {
      box.current = next;
    }),
    submit: vi.fn(async () => undefined),
    focus: vi.fn(),
  };
  return box;
}

function ghost(): PointerGhost & { touch(): void } {
  let touches = 0;
  return {
    point: vi.fn(async () => true),
    press: vi.fn(async () => undefined),
    hide: vi.fn(),
    touches: () => touches,
    touch: () => {
      touches += 1;
    },
  };
}

type RpcHandler = (method: string, input: Record<string, unknown>) => unknown;

function setup(options: { profile?: DeviceProfile; composer?: ComposerBindings | null; rpc?: RpcHandler; ghost?: PointerGhost | null } = {}) {
  const navigation = nav();
  const bindings: Bindings = {
    kind: options.composer === null ? "fallback" : "composer",
    context: () => ({ threadId: "t-here", projectId: "p1", onNewThreadScreen: false }),
    nav: navigation,
    composer: options.composer === undefined ? composer() : options.composer,
  };
  const handler: RpcHandler =
    options.rpc ??
    ((method, input) => {
      if (method === "drawerResolveThreads") {
        const ids = input.threadIds as string[];
        return { views: ids.map((id) => ({ id, title: `Title ${id}`, projectId: "p1" })), missing: [] };
      }
      if (method === "toolInvoke") return { output: "{\"ok\":true}", status: "success" };
      if (method === "preferencesWrite") return { ...defaultPreferences(), ...input };
      throw new Error(`unexpected ${method}`);
    });
  const call = vi.fn(async (method: string, input: Record<string, unknown>) => handler(method, input));
  const drawer = new DrawerViews();
  const trace = vi.fn();
  const setWork = vi.fn();
  const setOutcome = vi.fn();
  const deps: DispatcherDeps = {
    rpc: { call } as unknown as DispatcherDeps["rpc"],
    bindings: () => bindings,
    profile: options.profile ?? DESKTOP,
    ghost: () => (options.ghost === undefined ? null : options.ghost),
    drawer,
    prefs: () => defaultPreferences(),
    trace,
    setWork,
    setOutcome,
    now: () => 1000,
  };
  return { dispatcher: new ToolDispatcher(deps), call, nav: navigation, drawer, trace, setWork, setOutcome, bindings };
}

const run = (dispatcher: ToolDispatcher, name: string, args: unknown = {}) =>
  dispatcher.run({ callId: "fc-1", name, args: typeof args === "string" ? args : JSON.stringify(args) });

describe("tool dispatcher", () => {
  it("rejects arguments that are not JSON and records a failed outcome", async () => {
    const { dispatcher, setOutcome, setWork } = setup();
    expect(await run(dispatcher, "focus_thread", "{oops")).toMatch(/^Error: /);
    expect(setOutcome).toHaveBeenCalledWith({ tool: "focus_thread", ok: false, at: 1000 });
    expect(setWork).toHaveBeenLastCalledWith(null);
  });

  it("sends server tools to toolInvoke with the screen context", async () => {
    const { dispatcher, call, setOutcome } = setup({ profile: PHONE });
    expect(await run(dispatcher, "list_threads", { limit: 5 })).toBe("{\"ok\":true}");
    expect(call).toHaveBeenCalledWith("toolInvoke", {
      callId: "fc-1",
      name: "list_threads",
      args: { limit: 5 },
      context: { threadId: "t-here", projectId: "p1", onNewThreadScreen: false, mobile: true, canNavigate: true, channel: "app" },
    });
    expect(setOutcome).toHaveBeenCalledWith({ tool: "list_threads", ok: true, at: 1000 });
  });

  it("turns a failed toolInvoke into an error string", async () => {
    const { dispatcher } = setup({
      rpc: () => {
        throw new Error("server down");
      },
    });
    expect(await run(dispatcher, "list_threads")).toBe("Error: server down");
  });

  it("navigates on desktop and opens a split when asked", async () => {
    const { dispatcher, nav: navigation, trace } = setup();
    expect(JSON.parse(await run(dispatcher, "focus_thread", { thread_id: "t2" }))).toMatchObject({ ok: true, shown: "navigate" });
    expect(navigation.toThread).toHaveBeenCalledWith("t2");
    expect(JSON.parse(await run(dispatcher, "focus_thread", { thread_id: "t3", split: "right" }))).toMatchObject({ shown: "split" });
    expect(navigation.openSplit).toHaveBeenCalledWith("t3", "right");
    expect(trace).toHaveBeenCalledWith("thread.focus", { threadId: "t3", how: "split" });
  });

  it("navigates on a mobile browser, and uses the drawer when beside is set", async () => {
    const { dispatcher, nav: navigation, drawer } = setup({ profile: PHONE });
    await run(dispatcher, "focus_thread", { thread_id: "t2" });
    expect(navigation.toThread).toHaveBeenCalledWith("t2");
    expect(drawer.state.views).toEqual([]);
    expect(JSON.parse(await run(dispatcher, "focus_thread", { thread_id: "t3", beside: true }))).toMatchObject({ shown: "drawer", title: "Title t3" });
    expect(drawer.state.activeId).toBe("t3");
    expect(navigation.openDrawer).toHaveBeenCalledTimes(1);
  });

  it("always uses the drawer in a native webview", async () => {
    const { dispatcher, nav: navigation, drawer } = setup({ profile: WEBVIEW });
    await run(dispatcher, "focus_thread", { thread_id: "t2" });
    expect(navigation.toThread).not.toHaveBeenCalled();
    expect(drawer.state.views.map((view) => view.id)).toEqual(["t2"]);
  });

  it("does not open the drawer again when one is on screen", async () => {
    const { dispatcher, nav: navigation, drawer } = setup({ profile: WEBVIEW });
    drawer.registerPresenter({ visible: () => true });
    await run(dispatcher, "focus_thread", { thread_id: "t2" });
    expect(navigation.openDrawer).not.toHaveBeenCalled();
  });

  it("reports an unknown thread instead of showing it", async () => {
    const { dispatcher, drawer } = setup({
      profile: WEBVIEW,
      rpc: () => ({ views: [], missing: ["nope"] }),
    });
    expect(await run(dispatcher, "focus_thread", { thread_id: "nope" })).toMatch(/^Error: /);
    expect(drawer.state.views).toEqual([]);
  });

  it("manages drawer views", async () => {
    const { dispatcher, drawer } = setup({ profile: WEBVIEW });
    await run(dispatcher, "focus_threads", { thread_ids: ["a", "b", "c"] });
    expect(drawer.state.views.map((view) => view.id)).toEqual(["a", "b", "c"]);
    expect(JSON.parse(await run(dispatcher, "manage_views", { action: "list" }))).toEqual({
      views: [
        { id: "a", title: "Title a" },
        { id: "b", title: "Title b" },
        { id: "c", title: "Title c" },
      ],
      active: "c",
    });
    await run(dispatcher, "manage_views", { action: "select", view_id: "a" });
    expect(drawer.state.activeId).toBe("a");
    await run(dispatcher, "manage_views", { action: "close" });
    expect(drawer.state.views.map((view) => view.id)).toEqual(["b", "c"]);
    expect(await run(dispatcher, "manage_views", { action: "select", view_id: "zzz" })).toMatch(/^Error: /);
    await run(dispatcher, "manage_views", { action: "clear" });
    expect(drawer.state.views).toEqual([]);
  });

  it("saves the view behavior", async () => {
    const { dispatcher, call } = setup({ profile: WEBVIEW });
    expect(JSON.parse(await run(dispatcher, "set_view_behavior", { behavior: "new" }))).toEqual({ ok: true, behavior: "new" });
    expect(call).toHaveBeenCalledWith("preferencesWrite", { mobileDrawerBehavior: "new" });
  });

  it("reports a pane action that no window applied", async () => {
    const { dispatcher, nav: navigation } = setup();
    vi.mocked(navigation.paneAction).mockResolvedValueOnce(0);
    expect(await run(dispatcher, "set_pane", { thread_id: "t1", action: "maximize" })).toMatch(/^Error: /);
  });

  it("writes the composer and says when there is none", async () => {
    const box = composer("Hello");
    const { dispatcher, trace } = setup({ composer: box });
    await run(dispatcher, "append_composer_text", { text: "world" });
    expect(box.current.text).toBe("Hello world");
    await run(dispatcher, "set_composer_text", { text: "Fresh" });
    expect(box.current.text).toBe("Fresh");
    expect(trace).toHaveBeenCalledWith("composer", { action: "set", length: 5 });

    const bare = setup({ composer: null });
    expect(await run(bare.dispatcher, "set_composer_text", { text: "x" })).toBe("Error: no composer on this screen.");
  });

  it("describes the current thread locally", async () => {
    const { dispatcher, call } = setup();
    expect(JSON.parse(await run(dispatcher, "get_context"))).toEqual({
      thread: { id: "t-here", title: "Fix login", status: "idle", latestOutput: "Done." },
      projectId: "p1",
    });
    expect(call).not.toHaveBeenCalled();
  });

  it("walks the ghost through a send and focuses the thread", async () => {
    const pointer = ghost();
    const { dispatcher, nav: navigation, setWork, trace } = setup({ ghost: pointer });
    expect(await run(dispatcher, "send_to_thread", { thread_id: "t2", message: "Go" })).toBe("{\"ok\":true}");
    expect(vi.mocked(pointer.point).mock.calls.map(([target]) => target.kind)).toEqual(["thread", "composer", "send"]);
    expect(pointer.press).toHaveBeenCalled();
    expect(setWork.mock.calls.map(([work]) => work?.step ?? null)).toEqual(["run", "switch", "type", "send", null]);
    expect(trace).toHaveBeenCalledWith("send", { threadId: "t2" });
    expect(navigation.toThread).toHaveBeenCalledWith("t2");
  });

  it("cancels a send when the user touches the screen", async () => {
    const pointer = ghost();
    vi.mocked(pointer.press).mockImplementation(async () => pointer.touch());
    const { dispatcher, call } = setup({ ghost: pointer });
    expect(await run(dispatcher, "send_to_thread", { thread_id: "t2", message: "Go" })).toMatch(/^Error: the send was cancelled/);
    expect(call).not.toHaveBeenCalled();
    expect(pointer.hide).toHaveBeenCalled();
  });

  it("keeps a quiet send off screen", async () => {
    const { dispatcher, call, nav: navigation } = setup();
    await run(dispatcher, "send_to_thread", { thread_id: "t2", message: "Go", quiet: true });
    expect(call.mock.calls[0]![1]).toMatchObject({ context: { focus: false } });
    expect(navigation.toThread).not.toHaveBeenCalled();
  });

  it("runs focus tools with focus:false on mobile that cannot navigate, and adds a note", async () => {
    const { dispatcher, call, nav: navigation, trace } = setup({
      profile: WEBVIEW,
      rpc: () => ({ output: "{\"threadId\":\"t9\"}", status: "success" }),
    });
    for (const name of ["start_thread", "show_diff", "send_to_thread"]) {
      const output = JSON.parse(await run(dispatcher, name, { thread_id: "t9", prompt: "Hi", message: "Hi" }));
      expect(output.note).toMatch(/not brought on screen/);
    }
    for (const [, input] of call.mock.calls) expect(input).toMatchObject({ context: { focus: false, canNavigate: false } });
    expect(navigation.toThread).not.toHaveBeenCalled();
    expect(trace).toHaveBeenCalledWith("nav.suppressed", { tool: "start_thread" });
  });

  it("focuses a new thread and opens the composer when there was no prompt", async () => {
    const started = setup({ rpc: () => ({ output: "{\"threadId\":\"t9\"}", status: "success" }) });
    await run(started.dispatcher, "start_thread", { prompt: "Fix it" });
    expect(started.call.mock.calls[0]![1]).toMatchObject({ context: { canNavigate: true } });
    expect(started.call.mock.calls[0]![1]).not.toHaveProperty("context.focus");
    expect(started.nav.toThread).toHaveBeenCalledWith("t9");

    const blank = setup({ rpc: () => ({ output: "{\"ok\":true,\"projectId\":\"p2\"}", status: "success" }) });
    await run(blank.dispatcher, "start_thread", { machine_id: "m1" });
    expect(blank.nav.toCompose).toHaveBeenCalledWith({ projectId: "p2", hostId: "m1" });
  });
});
