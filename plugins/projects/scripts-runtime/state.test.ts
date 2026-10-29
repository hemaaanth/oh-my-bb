import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { parseWorkspaceManifest, type InspectResult } from "./server";

type TerminalView = {
  id: string;
  status: "starting" | "running" | "disconnected" | "exited";
  exitCode: number | null;
  closeReason: string | null;
};

async function workspace(files: Record<string, string>) {
  const terminals = new Map<string, TerminalView>();
  const control = {
    lookupError: null as Error | null,
    closeError: null as Error | null,
    probeError: null as Error | null,
    portState: "listening" as "listening" | "closed" | "unknown",
    createBarrier: null as Promise<void> | null,
  };
  const create = vi.fn(async () => {
    const terminal: TerminalView = { id: `term_${create.mock.calls.length}`, status: "running", exitCode: null, closeReason: null };
    if (control.createBarrier) await control.createBarrier;
    terminals.set(terminal.id, terminal);
    return terminal as never;
  });
  const hostRpc = vi.fn(async ({ method }: { method: string }) => {
    if (method === "allocate_port") return { port: 4321 };
    if (control.probeError) throw control.probeError;
    return { state: control.portState };
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "workspace-scripts",
    experimental_callHostRpc: hostRpc,
    sdk: {
      threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "proj_1", environmentId: "env_1" }) },
      environments: { get: async () => ({ id: "env_1", hostId: "host_1", path: "/repo", status: "ready", branchName: "feature" }) as never },
      files: { read: async ({ path }) => {
        const content = files[path.split("/").at(-1)!];
        if (content === undefined) throw new Error("ENOENT");
        return { content, contentEncoding: "utf8" } as never;
      } },
      terminals: {
        create,
        get: async ({ terminalId }) => {
          if (control.lookupError) throw control.lookupError;
          const terminal = terminals.get(terminalId);
          if (!terminal) throw new Error("Terminal not found");
          return terminal as never;
        },
        close: async ({ terminalId }) => {
          if (control.closeError) throw control.closeError;
          const terminal = terminals.get(terminalId);
          if (!terminal) throw new Error("Terminal not found");
          Object.assign(terminal, { status: "exited", closeReason: "user-close" });
          return terminal as never;
        },
      },
    },
  });
  await plugin(bb);
  const inspect = async (threadId = "th_1") =>
    await harness.behavior.callRpc("inspect", { threadId }) as Extract<InspectResult, { available: true }>;
  return { bb, harness, terminals, control, create, hostRpc, inspect };
}

const service = { scripts: { web: { command: "node server.js", type: "service", port: 3000 } } };
const runWeb = { threadId: "th_1", actionId: "script:web" };
const serviceKey = "service:env_1:script%3Aweb";

describe("workspace manifest precedence", () => {
  it("uses bb.json as a whole, including an empty manifest, without merging legacy scripts", async () => {
    const files = {
      "bb.json": JSON.stringify({ scripts: { native: { command: "printf bb" } } }),
      "paseo.json": JSON.stringify({ scripts: { legacy: { command: "printf legacy" } } }),
    };
    const f = await workspace(files);
    expect((await f.inspect()).actions.map(action => action.id)).toEqual(["script:native"]);
    files["bb.json"] = "{}";
    expect((await f.inspect()).actions).toEqual([]);
    delete (files as Record<string, string>)["bb.json"];
    expect(await f.inspect()).toMatchObject({ manifestFile: "paseo.json", actions: [{ id: "script:legacy" }] });
  });

  it("fails on invalid bb.json instead of running legacy commands and ignores invalid legacy files when BB is valid", async () => {
    const files = { "bb.json": "{", "paseo.json": JSON.stringify(service) };
    const f = await workspace(files);
    await expect(f.harness.behavior.callRpc("run", runWeb)).rejects.toThrow(/bb\.json is not valid JSON/);
    expect(f.create).not.toHaveBeenCalled();
    files["bb.json"] = JSON.stringify(service);
    files["paseo.json"] = "{";
    expect((await f.inspect()).manifestFile).toBe("bb.json");
  });

  it("accepts repository setup status without changing script discovery", async () => {
    const manifest = {
      repositorySetup: { configuredAt: "2026-10-28", verified: true, verifiedAt: "2026-10-29" },
      scripts: { check: { command: "npm test" } },
    };
    expect(parseWorkspaceManifest(JSON.stringify(manifest), "bb.json").repositorySetup).toEqual(manifest.repositorySetup);
    const f = await workspace({ "bb.json": JSON.stringify(manifest) });
    expect((await f.inspect()).actions.map((action) => action.id)).toEqual(["script:check"]);
    expect(() => parseWorkspaceManifest(JSON.stringify({ repositorySetup: { verified: true } }), "bb.json"))
      .toThrow(/verified repository setup requires verifiedAt/);
  });

  it("keeps native hooks ahead of JSON fallbacks and never reruns them on thread.active", async () => {
    const f = await workspace({
      "bb.json": JSON.stringify({ worktree: { setup: ["printf first", "printf second"], teardown: "printf fallback" } }),
      ".bb-env-setup.sh": "printf native",
      ".bb-env-teardown.sh": "printf native teardown",
    });
    expect(await f.inspect()).toMatchObject({ setup: { source: "native" }, teardown: { source: "native" } });
    const event = await f.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "th_1", projectId: "proj_1", environmentId: "env_1" }),
    });
    expect(event.errors).toEqual([]);
    expect(f.create).not.toHaveBeenCalled();
    await f.harness.behavior.callRpc("runHook", { threadId: "th_1", phase: "setup" });
    expect(f.harness.inspection.sdk.callsTo("terminals.create")[0]).toEqual([
      expect.objectContaining({ start: { mode: "command", command: expect.stringContaining("env bash '/repo/.bb-env-setup.sh'") } }),
    ]);
  });

  it("validates BB service port boundaries while leaving legacy compatibility fields alone", async () => {
    for (const port of [0, 65536, 1.5]) {
      expect(() => parseWorkspaceManifest(JSON.stringify({ scripts: { web: { type: "service", command: "serve", port } } }), "bb.json")).toThrow(/bb\.json is invalid/);
    }
    expect(() => parseWorkspaceManifest(JSON.stringify({ scripts: { check: { command: "check", port: 3000 } } }), "bb.json")).toThrow(/only supported for services/);
    expect(parseWorkspaceManifest(JSON.stringify({ worktree: { terminals: [{ name: "Web", command: "serve", port: 65535 }] } }), "bb.json").worktree?.terminals?.[0]?.port).toBe(65535);
    const f = await workspace({ "paseo.json": JSON.stringify(service) });
    expect((await f.inspect()).actions[0]?.port).toBeNull();
  });
});

describe("tracked workspace runs", () => {
  it("keeps latest command results thread-scoped and shares one service inspection across threads", async () => {
    const f = await workspace({ "bb.json": JSON.stringify({ ...service, scripts: { ...service.scripts, check: { command: "exit 7" } } }) });
    await f.harness.behavior.callRpc("run", { threadId: "th_1", actionId: "script:check" });
    Object.assign(f.terminals.get("term_1")!, { status: "exited", exitCode: 7, closeReason: "process-exit" });
    expect((await f.inspect("th_2")).actions.find(action => action.id === "script:check")).toMatchObject({ status: "not-run", terminalId: null });
    await f.harness.behavior.callRpc("run", { threadId: "th_2", actionId: "script:check" });
    Object.assign(f.terminals.get("term_2")!, { status: "exited", exitCode: 0, closeReason: "process-exit" });
    await f.harness.behavior.callRpc("run", runWeb);
    const readCount = f.harness.inspection.sdk.callsTo("files.read").length;
    const hostCalls = f.hostRpc.mock.calls.length;
    const batch = await f.harness.behavior.callRpc("inspectMany", { threadIds: ["th_1", "th_2", "th_1"] }) as Record<string, Extract<InspectResult, { available: true }>>;
    expect(batch.th_1.actions.find(action => action.id === "script:check")).toMatchObject({ status: "exited", exitCode: 7, terminalId: "term_1" });
    expect(batch.th_2.actions.find(action => action.id === "script:check")).toMatchObject({ status: "exited", exitCode: 0, terminalId: "term_2" });
    for (const thread of ["th_1", "th_2"]) expect(batch[thread].actions.find(action => action.id === "script:web")).toMatchObject({ status: "running", terminalId: "term_3", port: 3000 });
    expect(f.harness.inspection.sdk.callsTo("files.read").length - readCount).toBe(3);
    expect(f.hostRpc.mock.calls.length - hostCalls).toBe(1);
  });

  it("single-flights concurrent service starts in the same environment", async () => {
    const f = await workspace({ "bb.json": JSON.stringify(service) });
    const gate = Promise.withResolvers<void>();
    f.control.createBarrier = gate.promise;
    const first = f.harness.behavior.callRpc("run", runWeb);
    const second = f.harness.behavior.callRpc("run", { ...runWeb, threadId: "th_2" });
    await vi.waitFor(() => expect(f.create).toHaveBeenCalled());
    gate.resolve();
    const results = await Promise.all([first, second]);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ terminalId: "term_1", reused: false }),
      expect.objectContaining({ terminalId: "term_1", reused: true }),
    ]));
    expect(f.create).toHaveBeenCalledOnce();
  });

  it("preserves legacy service records when a repository migrates to bb.json", async () => {
    const files: Record<string, string> = { "paseo.json": JSON.stringify(service) };
    const f = await workspace(files);
    await f.harness.behavior.callRpc("run", runWeb);
    const record = await f.bb.storage.kv.get(serviceKey);
    files["bb.json"] = JSON.stringify(service);
    expect(await f.harness.behavior.callRpc("run", { ...runWeb, threadId: "th_2" })).toMatchObject({ terminalId: "term_1", reused: true });
    expect(await f.bb.storage.kv.get(serviceKey)).toEqual(record);
    expect(f.create).toHaveBeenCalledOnce();
  });

  it("keeps records through transient lookup failures and disconnects without starting duplicates", async () => {
    const f = await workspace({ "bb.json": JSON.stringify(service) });
    await f.harness.behavior.callRpc("run", runWeb);
    const saved = await f.bb.storage.kv.get(serviceKey);
    f.control.lookupError = new Error("Host not found");
    expect((await f.inspect()).actions[0]).toMatchObject({ status: "unknown", terminalId: "term_1" });
    await expect(f.harness.behavior.callRpc("run", runWeb)).rejects.toThrow(/Reconnect/);
    f.control.lookupError = null;
    f.terminals.get("term_1")!.status = "disconnected";
    expect((await f.inspect()).actions[0]).toMatchObject({ status: "disconnected", portState: "unknown" });
    await expect(f.harness.behavior.callRpc("run", runWeb)).rejects.toThrow(/Reconnect/);
    f.terminals.get("term_1")!.status = "running";
    expect(await f.harness.behavior.callRpc("run", runWeb)).toMatchObject({ terminalId: "term_1", reused: true });
    expect(await f.bb.storage.kv.get(serviceKey)).toEqual(saved);
    expect(f.create).toHaveBeenCalledOnce();
  });

  it("allows a new service only after a positively missing terminal", async () => {
    const f = await workspace({ "bb.json": JSON.stringify(service) });
    await f.harness.behavior.callRpc("run", runWeb);
    f.terminals.delete("term_1");
    expect((await f.inspect()).actions[0]).toMatchObject({ status: "exited", exitCode: null });
    expect(await f.harness.behavior.callRpc("run", runWeb)).toMatchObject({ terminalId: "term_2", reused: false });
  });

  it("does not report a failed Stop as successful or proceed with teardown", async () => {
    const f = await workspace({ "bb.json": JSON.stringify({ ...service, worktree: { teardown: "printf teardown" } }) });
    await f.harness.behavior.callRpc("run", runWeb);
    const saved = await f.bb.storage.kv.get(serviceKey);
    f.control.closeError = new Error("Host disconnected");
    await expect(f.harness.behavior.callRpc("stopService", runWeb)).rejects.toThrow(/Host disconnected/);
    await expect(f.harness.behavior.callRpc("runHook", { threadId: "th_1", phase: "teardown" })).rejects.toThrow(/Host disconnected/);
    expect(await f.bb.storage.kv.get(serviceKey)).toEqual(saved);
    expect(f.create).toHaveBeenCalledOnce();
    f.control.closeError = null;
    expect(await f.harness.behavior.callRpc("stopService", runWeb)).toEqual({ stopped: true });
    expect((await f.inspect()).actions[0]).toMatchObject({ status: "exited", closeReason: "user-close" });
    expect(await f.harness.behavior.callRpc("stopService", runWeb)).toEqual({ stopped: false });
  });

  it("distinguishes listener state from terminal state and treats failed probes as unknown", async () => {
    const f = await workspace({ "bb.json": JSON.stringify(service) });
    await f.harness.behavior.callRpc("run", runWeb);
    for (const state of ["listening", "closed", "unknown"] as const) {
      f.control.portState = state;
      expect((await f.inspect()).actions[0]).toMatchObject({ status: "running", port: 3000, portState: state });
    }
    f.control.probeError = new Error("Connection timed out");
    expect((await f.inspect()).actions[0]).toMatchObject({ status: "running", portState: "unknown" });
  });

  it("allocates referenced BB ports, leaves untracked ports unknown, and does not match variable prefixes", async () => {
    const f = await workspace({ "bb.json": JSON.stringify({ scripts: {
      allocated: { type: "service", command: "serve --port ${BB_PORT}" },
      opaque: { type: "service", command: "serve --port 6000" },
      prefix: { type: "service", command: "printf $BB_PORT_SUFFIX" },
    } }) });
    for (const name of ["allocated", "opaque", "prefix"]) await f.harness.behavior.callRpc("run", { threadId: "th_1", actionId: `script:${name}` });
    expect((await f.inspect()).actions).toMatchObject([
      { name: "allocated", port: 4321, portState: "listening" },
      { name: "opaque", port: null, portState: null },
      { name: "prefix", port: null, portState: null },
    ]);
    expect(f.hostRpc.mock.calls.filter(([call]) => call.method === "allocate_port")).toHaveLength(1);
    expect(f.hostRpc.mock.calls.filter(([call]) => call.method === "probe_port")).toHaveLength(1);
  });
});
