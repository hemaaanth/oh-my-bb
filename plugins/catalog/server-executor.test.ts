import { setImmediate as nextTurn } from "node:timers/promises";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./server.js";
import { fakeExecutor, signIn, type FakeApproval } from "./test-support/executor-fake.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const SDR = "11111111-1111-4111-8111-111111111111";

const pluginCaller = (pluginId: string) => ({ experimental_caller: { kind: "plugin" as const, pluginId } });
const write: FakeApproval = { app: "fixture", tool: "write" };

/** `agents` maps thread IDs to the Agents profile each one runs as. */
function catalogHost(agents: Record<string, string> = {}) {
  const projectContext = (projectId: string) => ({ projectId, credentialId: null, groupId: null, agentIds: [], bundleIds: [] });
  return createFakePluginHost({
    pluginId: "catalog",
    settings: { executorUrl: "https://executor.test", executorApiKey: "exp_test" },
    sdk: {
      system: { config: async () => ({ primaryHostId: null, dataDir: "/tmp/bb-test", serverUrl: "http://127.0.0.1:38886", serverAccess: { effectiveUrl: null } }) as never },
      hosts: { list: async () => [] },
      threads: { list: async () => [] },
      projects: {
        list: async () => ["gtm", "other"].map((name) => ({ id: `proj_${name}`, kind: "standard" as const, name, gitRemoteUrl: null, createdAt: 1, updatedAt: 1, sources: [] })),
      },
      plugins: {
        callRpc: async ({ method, input }: { method: string; input: unknown }) => {
          if (method === "bundleAssignmentSnapshot") return { globalBundleIds: [], projects: [] };
          if (method === "globalContext") return { agentIds: [], bundleIds: [] };
          if (method === "projectContext") return projectContext((input as { projectId: string }).projectId);
          if (method === "projectContexts") return { projects: (input as { projectIds: string[] }).projectIds.map(projectContext) };
          if (method === "listProfiles") return [{ id: SDR, slug: "sdr" }];
          if (method === "catalogContextForThread") {
            const profileId = agents[(input as { threadId: string }).threadId] ?? null;
            return { profileId, bound: profileId !== null };
          }
          throw new Error(`Unexpected Projects RPC: ${method}`);
        },
      },
    },
  });
}

type Host = ReturnType<typeof catalogHost>;
const executeTool = (harness: Host["harness"]) => harness.inspection.registrations.agentTools.find((tool) => tool.name === "executor_execute")!;
const executeCalls = (executor: ReturnType<typeof fakeExecutor>) => executor.calls.filter((call) => call.tool === "execute").map((call) => call.connection);
const pendingCard = async (harness: Host["harness"]) => {
  await vi.waitFor(() => expect(harness.inspection.pendingInteractions).toHaveLength(1));
  return harness.inspection.pendingInteractions[0]!;
};

describe("Catalog Executor connections", () => {
  it("gives each project only the connections mapped to it, plus the global ones", async () => {
    const executor = fakeExecutor({ connections: ["gtm", "shared"] });
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = catalogHost();
    await plugin(bb);
    const configure = harness.inspection.registrations.agentConfigurationProvider!;
    const call = (projectId: string, toolkit?: string) => executeTool(harness).execute({ code: "return 1", ...(toolkit ? { toolkit } : {}) }, { threadId: "thr", projectId, signal: new AbortController().signal });

    expect(configure(makePluginAgentConfigurationContext({ project: { id: "proj_gtm" } })).tools).toEqual(["catalog_search", "catalog_read"]);
    await expect(call("proj_gtm")).rejects.toThrow("No Executor connections are assigned to this project or agent.");

    expect((await harness.behavior.runCli(["executor", "use", "gtm", "--project", "gtm"])).stdout).toBe("gtm: gtm\nNot signed in yet: gtm. Run: bb catalog executor connect <connection>\n");
    expect((await harness.behavior.runCli(["executor", "use", "bad/id", "--project", "gtm"])).stderr).toMatch(/Not an Executor connection ID: bad\/id/u);
    expect((await harness.behavior.runCli(["executor", "use", "shared", "--global"])).exitCode).toBe(0);

    const unsigned = configure(makePluginAgentConfigurationContext({ project: { id: "proj_gtm" } }));
    expect(unsigned.tools).toEqual(expect.arrayContaining(["executor_execute", "executor_docs", "executor_resume"]));
    expect(unsigned.instructions).toContain("Executor connections for this thread: gtm (not signed in), shared (not signed in). The default is gtm.");
    await expect(call("proj_gtm")).rejects.toThrow("BB is not signed in to Executor connection gtm. Run: bb catalog executor connect gtm");

    await signIn(harness, executor, "gtm", "shared");
    expect(configure(makePluginAgentConfigurationContext({ project: { id: "proj_gtm" } })).instructions).toContain("Executor connections for this thread: gtm, shared. The default is gtm.");
    expect(configure(makePluginAgentConfigurationContext({ project: { id: "proj_other" } })).instructions).toContain("Executor connections for this thread: shared. The default is shared.");

    expect(await call("proj_gtm")).toBe("ran execute");
    expect(await call("proj_gtm", "shared")).toBe("ran execute");
    await expect(call("proj_other", "gtm")).rejects.toThrow("Connection gtm is not assigned to this project or agent. Use one of: shared.");
    expect(executeCalls(executor)).toEqual(["gtm", "shared"]);

    await harness.behavior.runCli(["executor", "use", "--clear", "--global"]);
    await expect(call("proj_other")).rejects.toThrow("No Executor connections are assigned to this project or agent.");
  });

  it("gives an agent's threads its connections first, in any project", async () => {
    const executor = fakeExecutor({ connections: ["gtm", "goldtalk"] });
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = catalogHost({ "thr-sdr": SDR });
    await plugin(bb);
    await signIn(harness, executor, "gtm", "goldtalk");
    await harness.behavior.callRpc("updatePreferences", { agentsIntegration: true });
    const configure = harness.inspection.registrations.agentConfigurationProvider!;
    const call = (threadId: string, toolkit?: string) => executeTool(harness).execute({ code: "return 1", ...(toolkit ? { toolkit } : {}) }, { threadId, projectId: "proj_other", signal: new AbortController().signal });

    expect((await harness.behavior.runCli(["executor", "use", "gtm", "--agent", "@sdr"])).stdout).toBe("agent @sdr: gtm\n");
    expect((await harness.behavior.runCli(["executor", "use", "gtm", "--agent", "@nobody"])).stderr).toBe("Unknown agent: @nobody\n");
    await harness.behavior.runCli(["executor", "use", "goldtalk", "--project", "other"]);
    expect((await harness.behavior.runCli(["executor", "status"])).stdout).toContain("connection\tgtm\tsigned in\tagent @sdr");

    expect(await call("thr-sdr")).toBe("ran execute");
    await expect(call("thr-plain", "gtm")).rejects.toThrow("Connection gtm is not assigned to this project or agent. Use one of: goldtalk.");
    expect(executeCalls(executor)).toEqual(["gtm"]);

    // Calls above warmed the thread cache that configure reads.
    const sdrContext = makePluginAgentConfigurationContext({ project: { id: "proj_other" } });
    expect(configure({ ...sdrContext, thread: { ...sdrContext.thread, id: "thr-sdr" } }).instructions).toContain("Executor connections for this thread: gtm, goldtalk. The default is gtm.");
    const unknownContext = makePluginAgentConfigurationContext({ project: { id: "proj_gtm" } });
    const unknown = configure({ ...unknownContext, thread: { ...unknownContext.thread, id: "thr-new" } });
    expect(unknown.tools).toEqual(expect.arrayContaining(["executor_execute"]));
    expect(unknown.instructions).toContain("This thread's agent may have Executor connections.");
  });

  describe("sign-in", () => {
    it("stores one grant per connection from the callback, and the link works once", async () => {
      const executor = fakeExecutor({ connections: ["gtm"] });
      vi.stubGlobal("fetch", executor.fetcher);
      const { bb, harness } = catalogHost();
      await plugin(bb);
      await harness.behavior.runCli(["executor", "use", "gtm", "--global"]);

      const started = await harness.behavior.runCli(["executor", "connect", "gtm", "--redirect-origin", "https://bb.test"]);
      expect(started.stdout).toContain("Executor then sends the browser to https://bb.test/api/v1/plugins/catalog/http/oauth/callback");
      const callback = executor.approve(/https:\/\/executor\.test\/\S+/u.exec(started.stdout!)![0]);
      const done = await harness.behavior.fetchHttp("GET", callback);
      expect(done.status).toBe(200);
      expect(await done.text()).toContain("BB can now use Executor connection gtm.");
      expect((await harness.behavior.fetchHttp("GET", callback)).status).toBe(400);
      expect((await harness.behavior.fetchHttp("GET", "/oauth/callback?state=nope&code=x")).status).toBe(400);
      expect(harness.inspection.realtimeSignals.some((signal) => signal.channel === "catalog-changed")).toBe(true);

      const overview = await harness.behavior.callRpc("executorOverview", null, { experimental_caller: { kind: "client" } });
      expect(overview.connections).toEqual([{ id: "gtm", url: "https://executor.test/mcp?connection=gtm", connected: true, assignedTo: ["every project"] }]);
      await expect(harness.behavior.callRpc("connectStart", { connection: "gtm", redirectOrigin: "https://bb.test" }, pluginCaller("inbox"))).rejects.toThrow(/BB client/u);
      expect((await harness.behavior.callRpc("connectStart", { connection: "gtm", redirectOrigin: "https://bb.test" }, { experimental_caller: { kind: "client" } })).url)
        .toMatch(/^https:\/\/executor\.test\/api\/auth\/oauth2\/authorize\?/u);
      // The OAuth client is registered once per Executor and callback.
      expect(executor.requests.filter((request) => request.endsWith("/oauth2/register"))).toHaveLength(1);

      expect((await harness.behavior.runCli(["executor", "disconnect", "gtm"])).exitCode).toBe(0);
      expect((await harness.behavior.callRpc("executorOverview", null, { experimental_caller: { kind: "client" } })).connections[0]!.connected).toBe(false);
    });

    it("keeps the grant across a restart, refreshes it, and asks for a new sign-in when Executor refuses", async () => {
      const executor = fakeExecutor({ connections: ["gtm"] });
      vi.stubGlobal("fetch", executor.fetcher);
      let host = catalogHost();
      await plugin(host.bb);
      await host.harness.behavior.runCli(["executor", "use", "gtm", "--global"]);
      await signIn(host.harness, executor, "gtm");
      host = await host.harness.lifecycle.reload(plugin);
      const context = { threadId: "thr", projectId: "proj_gtm" };

      expect(await host.harness.behavior.callAgentTool("executor_execute", { code: "x" }, context)).toBe("ran execute");
      executor.expireAccess();
      expect(await host.harness.behavior.callAgentTool("executor_execute", { code: "x" }, context)).toBe("ran execute");
      expect(executor.requests.filter((request) => request.endsWith("/oauth2/token"))).toHaveLength(2);

      // A refresh token works once; losing the rotated one means signing in again.
      executor.expireAccess();
      vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => String(input).endsWith("/oauth2/token")
        ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
        : executor.fetcher(input, init)) as typeof fetch);
      host = await host.harness.lifecycle.reload(plugin);
      await expect(host.harness.behavior.callAgentTool("executor_execute", { code: "x" }, context)).rejects.toThrow("Run: bb catalog executor connect gtm");
      await host.harness.lifecycle.dispose();
    });
  });

  it("asks for approval in the thread and resumes the call with the answer", async () => {
    let next = "r_ok";
    const executor = fakeExecutor({
      connections: ["gtm"],
      approvals: {
        r_ok: { app: "hubspot", tool: "submitFeedback", input: { note: "hi" }, account: "acct_1", message: "Allow this call?" },
        r_no: { app: "slack", tool: "post", message: "Allow this call?" },
        r_form: { app: "forms", tool: "ask" },
      },
      execute: (code) => code === "form" ? { input: "form_1" } : { approval: next },
    });
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = catalogHost();
    await plugin(bb);
    await harness.behavior.runCli(["executor", "use", "gtm", "--project", "gtm"]);
    await signIn(harness, executor, "gtm");
    const call = (code = "x") => executeTool(harness).execute({ code }, { threadId: "thr", projectId: "proj_gtm", signal: new AbortController().signal });

    const approved = call();
    const ask = await pendingCard(harness);
    expect(ask).toMatchObject({
      threadId: "thr", rendererId: "executor-approval", title: "Approve hubspot.submitFeedback",
      payload: { toolkit: "gtm", address: "hubspot.submitFeedback", integration: "hubspot", tool: "submitFeedback", account: "acct_1", message: "Allow this call?", args: JSON.stringify({ note: "hi" }, null, 2), approvalUrl: "" },
    });
    harness.behavior.submitInteraction(ask.id, { approved: true });
    expect(await approved).toBe("resumed r_ok");

    next = "r_no";
    const dismissed = call();
    harness.behavior.cancelInteraction((await pendingCard(harness)).id);
    expect(await dismissed).toBe("resumed r_no");
    expect(executor.decisions.map(({ requestId, action }) => [requestId, action])).toEqual([["r_ok", "accept"], ["r_no", "decline"]]);

    // BB never fills in a form for the user; it declines it.
    expect(await call("form")).toContain("forms.ask asked for form input (Fill this in). BB does not fill in forms");
    expect(executor.decisions.at(-1)).toEqual({ requestId: "form_1", action: "decline", connection: "gtm" });
  });

  describe("approval cards", () => {
    const setup = async () => {
      const executor = fakeExecutor({
        connections: ["gtm"],
        approvals: {
          r_a: { app: "pandadoc", tool: "archive", input: { id: "d1" }, account: "gm@goldsky.com" },
          r_b: { app: "slack", tool: "send", input: { text: "hi" }, message: "Allow?" },
          r_c: { app: "slack", tool: "send", input: { text: "again" }, message: "Allow?" },
          r_d: { app: "slack", tool: "send", input: { text: "other thread" }, message: "Allow?" },
        },
        // The code names the request it pauses on.
        execute: (code) => ({ approval: code }),
      });
      vi.stubGlobal("fetch", executor.fetcher);
      const { bb, harness } = catalogHost();
      await plugin(bb);
      await harness.behavior.runCli(["executor", "use", "gtm", "--project", "gtm"]);
      await signIn(harness, executor, "gtm");
      const call = (code: string, threadId = "thr") => executeTool(harness).execute({ code }, { threadId, projectId: "proj_gtm", signal: new AbortController().signal }) as Promise<string>;
      const queue = (threadId = "thr") => harness.behavior.callRpc("executorApprovals", { threadId }) as Promise<{ pending: Array<{ name: string; summary: string; open: boolean }> }>;
      return { executor, harness, call, queue };
    };

    it("shows a burst one card at a time, answered together by Approve all", async () => {
      const { executor, harness, call, queue } = await setup();
      const archived = call("r_a");
      expect((await pendingCard(harness)).payload).toMatchObject({ integration: "pandadoc", account: "gm@goldsky.com", tool: "archive", reason: "Executor asks before this call." });

      const sent = [call("r_b"), call("r_c")];
      await vi.waitFor(async () => expect((await queue()).pending).toHaveLength(3));
      expect(harness.inspection.pendingInteractions).toHaveLength(1);
      expect((await queue()).pending).toEqual([
        { approvalId: expect.any(String), name: "pandadoc.archive", summary: "pandadoc: archive", open: true },
        { approvalId: expect.any(String), name: "slack.send", summary: "slack: send", open: false },
        { approvalId: expect.any(String), name: "slack.send", summary: "slack: send", open: false },
      ]);

      harness.behavior.submitInteraction(harness.inspection.pendingInteractions[0]!.id, { approved: true, scope: "all" });
      expect(await Promise.all([archived, ...sent])).toEqual(["resumed r_a", "resumed r_b", "resumed r_c"]);
      expect(executor.decisions.map(({ requestId, action }) => `${requestId} ${action}`).sort()).toEqual(["r_a accept", "r_b accept", "r_c accept"]);
      expect(harness.inspection.pendingInteractions).toHaveLength(0);
      expect((await queue()).pending).toEqual([]);
    });

    it("approves a tool for the rest of its thread only", async () => {
      const { executor, harness, call } = await setup();
      const first = call("r_b");
      harness.behavior.submitInteraction((await pendingCard(harness)).id, { approved: true, scope: "thread" });
      expect(await first).toBe("resumed r_b");

      expect(await call("r_c")).toBe("resumed r_c");
      expect(harness.inspection.pendingInteractions).toHaveLength(0);

      const elsewhere = call("r_d", "thr-other");
      harness.behavior.cancelInteraction((await pendingCard(harness)).id);
      expect(await elsewhere).toBe("resumed r_d");
      expect(executor.decisions.map(({ requestId, action }) => [requestId, action])).toEqual([["r_b", "accept"], ["r_c", "accept"], ["r_d", "decline"]]);
    });

    it("opens a queued call's own card when the one before it waits too long", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      const { harness, call, queue } = await setup();
      void call("r_a");
      await pendingCard(harness);
      const queued = call("r_b");
      await vi.waitFor(async () => expect((await queue()).pending).toHaveLength(2));
      expect(harness.inspection.pendingInteractions).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(harness.inspection.pendingInteractions).toHaveLength(2));
      const card = harness.inspection.pendingInteractions.find((pending) => (pending.payload as { tool: string }).tool === "send")!;
      harness.behavior.submitInteraction(card.id, { approved: false });
      expect(await queued).toBe("resumed r_b");
    });
  });

  it("records once when an account breaks, and once when it recovers", async () => {
    const inventory = {
      apps: [{ id: "app_argus", slug: "argus", name: "Argus" }, { id: "app_grain", slug: "grain", name: "Grain" }],
      accounts: [{ id: "acct_1", label: "Goldsky", health: { apps: [
        { app: "app_argus", check: { status: "credentials_rejected", message: "invalid_grant" } },
        { app: "app_grain", check: { status: "forbidden" } },
      ] } }],
    };
    const executor = fakeExecutor({ connections: ["gtm"], inventory });
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = catalogHost();
    await plugin(bb);
    const signals = () => harness.inspection.realtimeSignals.filter((signal) => signal.channel === "executor-connections-changed");

    await harness.runSchedule("check-executor-connections");
    await harness.runSchedule("check-executor-connections");
    expect(signals()).toEqual([{ channel: "executor-connections-changed", payload: { recovered: [] } }]);
    expect((await harness.behavior.callRpc("executorConnections", null)).broken).toEqual([
      expect.objectContaining({ address: "acct_1:argus", name: "Argus (Goldsky)", problem: "credentials_rejected: invalid_grant" }),
      expect.objectContaining({ address: "acct_1:grain", name: "Grain (Goldsky)", problem: "forbidden" }),
    ]);
    expect((await harness.behavior.runCli(["executor", "status"])).stdout).toContain("warning\tArgus (Goldsky): credentials_rejected: invalid_grant");

    inventory.accounts[0]!.health.apps[0]!.check = { status: "ok" } as never;
    await harness.runSchedule("check-executor-connections");
    expect(signals().slice(1)).toEqual([{ channel: "executor-connections-changed", payload: { recovered: [{ address: "acct_1:argus", name: "Argus (Goldsky)", removed: false }] } }]);
    expect((await harness.behavior.callRpc("executorConnections", null)).broken).toHaveLength(1);
  });

  it("runs a plugin backend's code only in connections mapped to that plugin", async () => {
    const executor = fakeExecutor({ connections: ["fixture-worker", "gtm"] });
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = catalogHost();
    await plugin(bb);
    await signIn(harness, executor, "fixture-worker", "gtm");
    const call = (caller: string, toolkit: string) => harness.behavior.callRpc("executorCall", { caller, toolkit, code: "return 1", mode: "read", purpose: "sync" }, pluginCaller(caller));

    await expect(call("fixture-worker", "fixture-worker")).rejects.toThrow(/No Executor connection is mapped to plugin fixture-worker/u);
    await harness.behavior.runCli(["executor", "use", "gtm", "--global"]);
    expect((await harness.behavior.callRpc("executorConfiguration", null)).mappings).toContainEqual({ scope: "global", targetId: "*", toolkits: ["gtm"] });
    await expect(call("fixture-worker", "gtm")).rejects.toBeInstanceOf(Error);

    expect((await harness.behavior.runCli(["executor", "use", "fixture-worker", "--plugin", "fixture-worker"])).exitCode).toBe(0);
    expect((await harness.behavior.runCli(["executor", "use", "fixture-worker", "--plugin", "Not A Plugin"])).exitCode).toBe(1);
    expect(await call("fixture-worker", "fixture-worker")).toEqual({ text: "ran execute", paused: null });
    await expect(call("fixture-worker", "gtm")).rejects.toThrow("Connection gtm is not mapped to plugin fixture-worker. Use one of: fixture-worker.");
    await expect(call("pages", "fixture-worker")).rejects.toBeInstanceOf(Error);
    expect(await harness.behavior.callRpc("executorToolkits", { caller: "fixture-worker" }, pluginCaller("fixture-worker"))).toEqual({ configured: true, toolkits: [{ slug: "fixture-worker", integrations: [] }] });

    // Plugin scopes stay out of every thread's connections.
    await expect(executeTool(harness).execute({ code: "return 1", toolkit: "fixture-worker" }, { threadId: "fixture-thread", projectId: "proj_gtm", signal: new AbortController().signal })).rejects.toBeInstanceOf(Error);

    const calls = (await harness.behavior.runCli(["executor", "calls", "--plugin", "fixture-worker", "--json"])).stdout!;
    // Verified attempts are audited, refused connection requests included.
    expect(JSON.parse(calls).map((row: { toolkit: string; outcome: string }) => `${row.outcome} ${row.toolkit}`).sort()).toEqual(["error fixture-worker", "error gtm", "error gtm", "ok fixture-worker"]);
  });

  it("declines a plugin's read call that needs approval instead of waiting", async () => {
    const executor = fakeExecutor({ connections: ["inbox"], approvals: { r_read: { app: "slack", tool: "sendDraft" } }, execute: () => ({ approval: "r_read" }) });
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = catalogHost();
    await plugin(bb);
    await signIn(harness, executor, "inbox");
    await harness.behavior.runCli(["executor", "use", "inbox", "--plugin", "inbox"]);

    await expect(harness.behavior.callRpc("executorCall", { caller: "inbox", toolkit: "inbox", code: "x", mode: "read", purpose: "sync slack" }, pluginCaller("inbox")))
      .rejects.toThrow("slack.sendDraft needs approval, and read calls never wait for one");
    expect(executor.decisions.map(({ requestId, action }) => [requestId, action])).toEqual([["r_read", "decline"]]);
    expect(harness.inspection.pendingInteractions).toHaveLength(0);
    expect((await harness.behavior.runCli(["executor", "calls"])).stdout).toMatch(/\tinbox\tinbox\tread\tdeclined\t.*\tsync slack\t/u);
  });

  it("returns a plugin's paused write for display and verified decline, not RPC approval", async () => {
    const executor = fakeExecutor({
      connections: ["fixture-policy"],
      approvals: { r_draft: { app: "slack", tool: "sendDraft", input: { channel_id: "D1", message: "hi" }, message: "Allow?" } },
      execute: () => ({ approval: "r_draft" }),
    });
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = catalogHost();
    await plugin(bb);
    await signIn(harness, executor, "fixture-policy");
    await harness.behavior.runCli(["executor", "use", "fixture-policy", "--plugin", "worker"]);

    expect(await harness.behavior.callRpc("executorCall", { caller: "worker", toolkit: "fixture-policy", code: "x", mode: "write", purpose: "slack draft" }, pluginCaller("worker"))).toEqual({
      text: "Approval required for slack.sendDraft",
      paused: { executionId: "r_draft", approvalUrl: "", address: "slack.sendDraft", message: "Allow?", args: JSON.stringify({ channel_id: "D1", message: "hi" }, null, 2) },
    });
    expect(executor.decisions).toEqual([]);
    expect(harness.inspection.pendingInteractions).toHaveLength(0);

    await expect(harness.behavior.callRpc("executorDecide", { caller: "pages", executionId: "r_draft", action: "decline" }, pluginCaller("pages"))).rejects.toThrow("No paused Executor call with that ID is waiting for this plugin.");
    await expect(harness.behavior.callRpc("executorDecide", { caller: "worker", executionId: "r_draft", action: "accept" })).rejects.toThrow(/native owner interaction/u);
    expect(await harness.behavior.callRpc("executorDecide", { caller: "worker", executionId: "r_draft", action: "decline" }, pluginCaller("worker"))).toEqual({ text: "Declined.", paused: null });
    await expect(harness.behavior.callRpc("executorDecide", { caller: "worker", executionId: "r_draft", action: "decline" }, pluginCaller("worker"))).rejects.toThrow(/No paused Executor call/u);
    expect(executor.decisions.map(({ requestId, action }) => [requestId, action])).toEqual([["r_draft", "decline"]]);
  });

  describe("caller authority", () => {
    it.each(["inbox", "prospecting"])("lets synthetic %s call and decline only its own execution", async (caller) => {
      const executor = fakeExecutor({ connections: ["fixture"], approvals: { r_fixture: write }, execute: () => ({ approval: "r_fixture" }) });
      vi.stubGlobal("fetch", executor.fetcher);
      const { bb, harness } = catalogHost();
      await plugin(bb);
      await signIn(harness, executor, "fixture");
      await harness.behavior.runCli(["executor", "use", "fixture", "--plugin", caller]);
      expect(await harness.behavior.callRpc("executorToolkits", { caller }, pluginCaller(caller))).toEqual({ configured: true, toolkits: [{ slug: "fixture", integrations: [] }] });
      expect(await harness.behavior.callRpc("executorCall", { caller, toolkit: "fixture", code: "fixture", mode: "write", purpose: "synthetic compatibility" }, pluginCaller(caller)))
        .toMatchObject({ paused: { executionId: "r_fixture" } });
      expect(await harness.behavior.callRpc("executorDecide", { caller, executionId: "r_fixture", action: "decline" }, pluginCaller(caller))).toEqual({ text: "Declined.", paused: null });
      expect(executor.decisions.map(({ action }) => action)).toEqual(["decline"]);
      await harness.lifecycle.dispose();
    });

    it.each(["spoofed", "client", "missing"] as const)("rejects %s identity before lookup, audit, rate slots or external work", async (identity) => {
      const executor = fakeExecutor({ connections: ["fixture"] });
      vi.stubGlobal("fetch", executor.fetcher);
      const { bb, harness } = catalogHost();
      const register = vi.spyOn(bb.rpc, "register");
      await plugin(bb);
      await signIn(harness, executor, "fixture");
      await harness.behavior.runCli(["executor", "use", "fixture", "--plugin", "worker"]);
      const requests = executor.requests.length;
      const input = { caller: "worker", toolkit: "fixture", code: "fixture", mode: "read", purpose: "identity boundary" };
      const handlers = register.mock.calls[0]![1];
      const call = async (method: "executorCall" | "executorToolkits" | "executorDecide", value: unknown) => identity === "missing"
        ? handlers[method]!(value, undefined as never)
        : harness.behavior.callRpc(method, value, identity === "spoofed" ? pluginCaller("other-worker") : {});
      for (let i = 0; i < 30; i++) await expect(call("executorCall", input)).rejects.toThrow(/verified plugin caller/u);
      await expect(call("executorCall", { ...input, caller: "unmapped", toolkit: "absent" })).rejects.toThrow(/verified plugin caller/u);
      await expect(call("executorToolkits", { caller: "worker" })).rejects.toThrow(/verified plugin caller/u);
      await expect(call("executorDecide", { caller: "worker", executionId: "not-started", action: "decline" }))
        .rejects.toThrow(identity === "client" ? /No paused Executor call/u : /verified plugin caller/u);
      expect(executor.requests).toHaveLength(requests);
      expect(JSON.parse((await harness.behavior.runCli(["executor", "calls", "--json"])).stdout!)).toEqual([]);
      for (let i = 0; i < 30; i++) {
        expect(await harness.behavior.callRpc("executorCall", input, pluginCaller("worker"))).toEqual({ text: "ran execute", paused: null });
      }
      await expect(harness.behavior.callRpc("executorCall", input, pluginCaller("worker"))).rejects.toThrow(/made 30 Executor calls/u);
      await harness.lifecycle.dispose();
    });

    it("does not queue a spoofed call behind a verified caller's pending call", async () => {
      const executor = fakeExecutor({ connections: ["fixture"] });
      const { bb, harness } = catalogHost();
      const started = Promise.withResolvers<void>();
      const blocked = Promise.withResolvers<void>();
      let gate = false;
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const body = init?.body && String(input).includes("/mcp") ? JSON.parse(String(init.body)) : null;
        if (gate && body?.method === "tools/call") { started.resolve(); await blocked.promise; }
        return executor.fetcher(input, init);
      });
      await plugin(bb);
      await signIn(harness, executor, "fixture");
      await harness.behavior.runCli(["executor", "use", "fixture", "--plugin", "worker"]);
      gate = true;
      const input = { caller: "worker", toolkit: "fixture", code: "fixture", mode: "read", purpose: "queue boundary" };
      const genuine = harness.behavior.callRpc("executorCall", input, pluginCaller("worker"));
      await started.promise;
      const spoof = harness.behavior.callRpc("executorCall", input, pluginCaller("other-worker"));
      // A queued request is still pending after this event-loop turn.
      const result = await Promise.race([spoof.then(() => "accepted", () => "rejected"), nextTurn("queued")]);
      blocked.resolve();
      await genuine;
      await spoof.catch(() => undefined);
      expect(result).toBe("rejected");
      await harness.lifecycle.dispose();
    });

    it("keeps rejected acceptance and cross-caller decline from consuming a pause while supported declines still work", async () => {
      let next = "r_accept";
      const executor = fakeExecutor({ connections: ["fixture"], approvals: { r_accept: write, r_decline: write }, execute: () => ({ approval: next }) });
      vi.stubGlobal("fetch", executor.fetcher);
      const { bb, harness } = catalogHost();
      const register = vi.spyOn(bb.rpc, "register");
      await plugin(bb);
      await signIn(harness, executor, "fixture");
      await harness.behavior.runCli(["executor", "use", "fixture", "--plugin", "worker"]);
      const writeInput = { caller: "worker", toolkit: "fixture", code: "fixture", mode: "write", purpose: "owner decision" };
      await harness.behavior.callRpc("executorCall", writeInput, pluginCaller("worker"));
      const input = { caller: "worker", executionId: next, action: "accept" };
      const before = executor.requests.length;
      await expect(harness.behavior.callRpc("executorDecide", input, pluginCaller("worker"))).rejects.toThrow(/native owner interaction/u);
      await expect(harness.behavior.callRpc("executorDecide", { ...input, action: "decline" }, pluginCaller("other-worker"))).rejects.toThrow(/verified plugin caller/u);
      await expect(harness.behavior.callRpc("executorDecide", { ...input, caller: "other-worker", action: "decline" }, pluginCaller("other-worker"))).rejects.toThrow(/No paused Executor call/u);
      await expect((async () => register.mock.calls[0]![1].executorDecide!(input, undefined as never))()).rejects.toThrow(/verified plugin caller/u);
      expect(executor.requests).toHaveLength(before);
      expect(executor.decisions).toEqual([]);
      expect(JSON.parse((await harness.behavior.runCli(["executor", "calls", "--json"])).stdout!).map((row: { outcome: string }) => row.outcome)).toEqual(["paused"]);
      await expect(harness.behavior.callRpc("executorDecide", input)).rejects.toThrow(/native owner interaction/u);
      expect(await harness.behavior.callRpc("executorDecide", { ...input, action: "decline" }, pluginCaller("worker"))).toEqual({ text: "Declined.", paused: null });
      await expect(harness.behavior.callRpc("executorDecide", { ...input, action: "decline" })).rejects.toThrow(/No paused Executor call/u);
      next = "r_decline";
      await harness.behavior.callRpc("executorCall", writeInput, pluginCaller("worker"));
      expect(await harness.behavior.callRpc("executorDecide", { caller: "worker", executionId: next, action: "decline" })).toEqual({ text: "Declined.", paused: null });
      expect(executor.decisions.map(({ requestId, action }) => [requestId, action])).toEqual([["r_accept", "decline"], ["r_decline", "decline"]]);
      expect(harness.inspection.pendingInteractions).toHaveLength(0);
      await harness.lifecycle.dispose();
    });
  });

  describe("owner provenance", () => {
    it("does not accept or retain a thread grant after connection access is revoked while a card is open", async () => {
      const executor = fakeExecutor({ connections: ["fixture"], approvals: { r_revoked: write, r_retry: write }, execute: (code) => ({ approval: code }) });
      vi.stubGlobal("fetch", executor.fetcher);
      const { bb, harness } = catalogHost();
      await plugin(bb);
      await signIn(harness, executor, "fixture");
      await harness.behavior.runCli(["executor", "use", "fixture", "--global"]);
      const context = { threadId: "fixture-thread", projectId: "fixture-project", signal: new AbortController().signal };
      const pending = executeTool(harness).execute({ code: "r_revoked" }, context);
      const card = await pendingCard(harness);
      await harness.behavior.runCli(["executor", "use", "--clear", "--global"]);
      harness.behavior.submitInteraction(card.id, { approved: true, scope: "thread" });
      await expect(pending).rejects.toThrow(/access changed/u);
      expect(executor.decisions).toEqual([]);
      await harness.behavior.runCli(["executor", "use", "fixture", "--global"]);
      const retry = executeTool(harness).execute({ code: "r_retry" }, context);
      harness.behavior.cancelInteraction((await pendingCard(harness)).id);
      expect(await retry).toBe("resumed r_retry");
      expect(executor.decisions.map(({ action }) => action)).toEqual(["decline"]);
      await harness.lifecycle.dispose();
    });

    it("does not persist approve-for-thread across a plugin restart", async () => {
      const executor = fakeExecutor({ connections: ["fixture"], approvals: { r_first: write, r_after: write }, execute: (code) => ({ approval: code }) });
      vi.stubGlobal("fetch", executor.fetcher);
      let host = catalogHost();
      await plugin(host.bb);
      await signIn(host.harness, executor, "fixture");
      await host.harness.behavior.runCli(["executor", "use", "fixture", "--global"]);
      const context = { threadId: "fixture-thread", projectId: "fixture-project" };
      const first = host.harness.behavior.callAgentTool("executor_execute", { code: "r_first" }, context);
      host.harness.behavior.submitInteraction((await pendingCard(host.harness)).id, { approved: true, scope: "thread" });
      expect(await first).toBe("resumed r_first");
      host = await host.harness.lifecycle.reload(plugin);
      const restarted = host.harness.behavior.callAgentTool("executor_execute", { code: "r_after" }, context);
      host.harness.behavior.cancelInteraction((await pendingCard(host.harness)).id);
      expect(await restarted).toBe("resumed r_after");
      expect(executor.decisions.map(({ action }) => action)).toEqual(["accept", "decline"]);
      await host.harness.lifecycle.dispose();
    });

    it("leaves a timed-out or unknown pause unapproved, and asks again on executor_resume", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      const executor = fakeExecutor({ connections: ["fixture"], approvals: { r_timeout: write }, execute: () => ({ approval: "r_timeout" }) });
      vi.stubGlobal("fetch", executor.fetcher);
      const { bb, harness } = catalogHost();
      try {
        await plugin(bb);
        await signIn(harness, executor, "fixture");
        await harness.behavior.runCli(["executor", "use", "fixture", "--global"]);
        const context = { threadId: "fixture-thread", projectId: "fixture-project" };
        const pending = harness.behavior.callAgentTool("executor_execute", { code: "fixture" }, context);
        await pendingCard(harness);
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1);
        expect(await pending).toContain("Call executor_resume with executionId \"r_timeout\"");
        await expect(harness.behavior.callAgentTool("executor_resume", { executionId: "r_unknown" }, context)).rejects.toThrow(/No Executor approval with that ID/u);
        await expect(harness.behavior.callAgentTool("executor_resume", { executionId: "r_timeout" }, { ...context, threadId: "other" })).rejects.toThrow(/No Executor approval with that ID/u);
        expect(executor.decisions).toEqual([]);

        const resumed = harness.behavior.callAgentTool("executor_resume", { executionId: "r_timeout" }, context);
        harness.behavior.submitInteraction((await pendingCard(harness)).id, { approved: true });
        expect(await resumed).toBe("resumed r_timeout");
        expect(executor.decisions.map(({ requestId, action }) => [requestId, action])).toEqual([["r_timeout", "accept"]]);
      } finally {
        await harness.lifecycle.dispose();
      }
    });
  });
});
