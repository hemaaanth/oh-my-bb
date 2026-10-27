import { setImmediate as nextTurn } from "node:timers/promises";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./server.js";
import { fakeExecutor, pausedResult } from "./test-support/executor-fake.js";

afterEach(() => { vi.unstubAllGlobals(); });

const SDR = "11111111-1111-4111-8111-111111111111";

const pluginCaller = (pluginId: string) => ({ experimental_caller: { kind: "plugin" as const, pluginId } });

/** `agents` maps thread IDs to the Agents profile each one runs as. */
function catalogHost(agents: Record<string, string> = {}) {
  const projectContext = (projectId: string) => ({ projectId, credentialId: null, groupId: null, agentIds: [], bundleIds: [] });
  return createFakePluginHost({
    pluginId: "catalog",
    settings: { executorUrl: "https://executor.test", executorApiKey: "key" },
    sdk: {
      system: { config: async () => ({ primaryHostId: null, dataDir: "/tmp/bb-test" }) as never },
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

describe("Catalog Executor toolkits", () => {
  it("gives each project only the Executor toolkits mapped to it, plus the global ones", async () => {
    const executor = fakeExecutor({ toolkits: { gtm: ["argus.*", "goldtalk.*"], shared: ["pylon.*"] } });
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = catalogHost();
    await plugin(bb);
    const configure = harness.inspection.registrations.agentConfigurationProvider!;
    const execute = harness.inspection.registrations.agentTools.find((tool) => tool.name === "executor_execute")!;
    const call = (projectId: string, toolkit?: string) => execute.execute({ code: "return 1", ...(toolkit ? { toolkit } : {}) }, { threadId: "thr", projectId, signal: new AbortController().signal });
    const endpoints = () => executor.calls.filter((call) => (call.body as { method?: string } | undefined)?.method === "tools/call").map((call) => call.url.split("?")[0]);

    expect(configure(makePluginAgentConfigurationContext({ project: { id: "proj_gtm" } })).tools).toEqual(["catalog_search", "catalog_read"]);
    await expect(call("proj_gtm")).rejects.toThrow("No Executor toolkits are assigned to this project or agent.");

    expect((await harness.behavior.runCli(["executor", "use", "gtm", "--project", "gtm"])).stdout).toBe("gtm: gtm\n");
    expect((await harness.behavior.runCli(["executor", "use", "missing", "--project", "gtm"])).stderr).toMatch(/no toolkit named missing/u);
    expect((await harness.behavior.runCli(["executor", "use", "shared", "--global"])).stdout).toBe("every project: shared\n");

    const gtm = configure(makePluginAgentConfigurationContext({ project: { id: "proj_gtm" } }));
    expect(gtm.tools).toEqual(expect.arrayContaining(["executor_execute", "executor_docs", "executor_resume"]));
    expect(gtm.instructions).toContain("Executor toolkits for this thread: gtm (argus, goldtalk); shared (pylon). The default is gtm.");
    expect(configure(makePluginAgentConfigurationContext({ project: { id: "proj_other" } })).instructions).toContain("shared (pylon). The default is shared.");

    expect(await call("proj_gtm")).toBe("ran execute");
    expect(await call("proj_gtm", "shared")).toBe("ran execute");
    await expect(call("proj_other", "gtm")).rejects.toThrow("Toolkit gtm is not assigned to this project or agent. Use one of: shared.");
    expect(endpoints()).toEqual(["/mcp/toolkits/gtm", "/mcp/toolkits/shared"]);

    await harness.behavior.runCli(["executor", "use", "--clear", "--global"]);
    await expect(call("proj_other")).rejects.toThrow("No Executor toolkits are assigned to this project or agent.");
  });

  it("gives an agent's threads its toolkits first, in any project", async () => {
    const executor = fakeExecutor({ toolkits: { gtm: ["argus.*"], goldtalk: ["retool.*"] } });
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = catalogHost({ "thr-sdr": SDR });
    await plugin(bb);
    await harness.behavior.callRpc("updatePreferences", { agentsIntegration: true });
    const configure = harness.inspection.registrations.agentConfigurationProvider!;
    const execute = harness.inspection.registrations.agentTools.find((tool) => tool.name === "executor_execute")!;
    const call = (threadId: string, toolkit?: string) => execute.execute({ code: "return 1", ...(toolkit ? { toolkit } : {}) }, { threadId, projectId: "proj_other", signal: new AbortController().signal });

    expect((await harness.behavior.runCli(["executor", "use", "gtm", "--agent", "@sdr"])).stdout).toBe("agent @sdr: gtm\n");
    expect((await harness.behavior.runCli(["executor", "use", "gtm", "--agent", "@nobody"])).stderr).toBe("Unknown agent: @nobody\n");
    await harness.behavior.runCli(["executor", "use", "goldtalk", "--project", "other"]);
    expect((await harness.behavior.runCli(["executor", "status"])).stdout).toContain("toolkits\tagent @sdr\tgtm (argus)");

    expect(await call("thr-sdr")).toBe("ran execute");
    await expect(call("thr-plain", "gtm")).rejects.toThrow("Toolkit gtm is not assigned to this project or agent. Use one of: goldtalk.");
    expect(executor.calls.filter((entry) => (entry.body as { method?: string } | undefined)?.method === "tools/call").map((entry) => entry.url.split("?")[0])).toEqual(["/mcp/toolkits/gtm"]);

    // Calls above warmed the thread cache that configure reads.
    const sdrContext = makePluginAgentConfigurationContext({ project: { id: "proj_other" } });
    const sdr = configure({ ...sdrContext, thread: { ...sdrContext.thread, id: "thr-sdr" } });
    expect(sdr.instructions).toContain("Executor toolkits for this thread: gtm (argus); goldtalk (retool). The default is gtm.");
    const unknownContext = makePluginAgentConfigurationContext({ project: { id: "proj_gtm" } });
    const unknown = configure({ ...unknownContext, thread: { ...unknownContext.thread, id: "thr-new" } });
    expect(unknown.tools).toEqual(expect.arrayContaining(["executor_execute"]));
    expect(unknown.instructions).toContain("This thread's agent may have Executor toolkits.");
  });

  it("asks for approval in the thread and resumes the call with the answer", async () => {
    const approvals = {
      exec_ok: { address: "tools.hubspot.user.goldsky.submit_feedback", message: "Allow this call?", args: { note: "hi" } },
      exec_no: { address: "tools.slack.user.goldsky.post", message: "Allow this call?", args: null },
    };
    let next = "exec_ok";
    const executor = fakeExecutor({
      toolkits: { gtm: ["hubspot.*"] },
      approvals,
      toolResult: (name, args) => name === "execute"
        ? pausedResult(next)
        : name === "resume" ? { content: [{ type: "text", text: `resumed ${(args as { executionId: string }).executionId}` }] } : undefined,
    });
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = catalogHost();
    await plugin(bb);
    await harness.behavior.runCli(["executor", "use", "gtm", "--project", "gtm"]);
    const execute = harness.inspection.registrations.agentTools.find((tool) => tool.name === "executor_execute")!;
    const call = () => execute.execute({ code: "x" }, { threadId: "thr", projectId: "proj_gtm", signal: new AbortController().signal });
    const pending = async () => {
      await vi.waitFor(() => expect(harness.inspection.pendingInteractions).toHaveLength(1));
      return harness.inspection.pendingInteractions[0]!;
    };

    const approved = call();
    const ask = await pending();
    expect(ask).toMatchObject({
      threadId: "thr", rendererId: "executor-approval", title: "Approve hubspot.user.goldsky.submit_feedback",
      payload: { toolkit: "gtm", address: "tools.hubspot.user.goldsky.submit_feedback", message: "Allow this call?", args: JSON.stringify({ note: "hi" }, null, 2), approvalUrl: "https://executor.test/resume/exec_ok?mcp_session_id=s1" },
    });
    harness.behavior.submitInteraction(ask.id, { approved: true });
    expect(await approved).toBe("resumed exec_ok");

    next = "exec_no";
    const dismissed = call();
    harness.behavior.cancelInteraction((await pending()).id);
    expect(await dismissed).toBe("resumed exec_no");
    expect(executor.decisions.map(({ executionId, body }) => [executionId, body])).toEqual([
      ["exec_ok", { action: "accept", content: {} }],
      ["exec_no", { action: "decline" }],
    ]);

    // Executor no longer knows the execution, so the agent gets the link to hand over.
    next = "exec_gone";
    expect(await call()).toBe("Approve at https://executor.test/resume/exec_gone?mcp_session_id=s1 then call resume");
  });

  describe("approval cards", () => {
    const ARCHIVE = "tools.pandadoc_com.user.gm.documents_archive";
    const SEND = "tools.slack.user.goldsky.slack_send_message";
    const setup = async () => {
      const executor = fakeExecutor({
        toolkits: { gtm: ["pandadoc_com.user.gm.*", "slack.user.goldsky.*"] },
        policies: { gtm: [{ pattern: "slack.user.goldsky.slack_send_message", action: "require_approval" }] },
        tools: [{ address: ARCHIVE, description: "Archive a document by ID.", requiresApproval: true }, { address: SEND, description: "Send a Slack message." }],
        integrations: { pandadoc_com: "PandaDoc", slack: "Slack" },
        accounts: { "tools.pandadoc_com.user.gm": "gm@goldsky.com" },
        approvals: {
          exec_a: { address: ARCHIVE, message: "documents_archive Arguments: {\"id\":\"d1\"}", args: { id: "d1" } },
          exec_b: { address: SEND, message: "Allow?", args: { channel: "C1", text: "hi" } },
          exec_c: { address: SEND, message: "Allow?", args: { channel: "C1", text: "again" } },
          exec_d: { address: SEND, message: "Allow?", args: { channel: "C2", text: "other thread" } },
        },
        // The code names the execution it pauses on.
        toolResult: (name, args) => name === "execute"
          ? pausedResult((args as { code: string }).code)
          : name === "resume" ? { content: [{ type: "text", text: `resumed ${(args as { executionId: string }).executionId}` }] } : undefined,
      });
      vi.stubGlobal("fetch", executor.fetcher);
      const { bb, harness } = catalogHost();
      await plugin(bb);
      await harness.behavior.runCli(["executor", "use", "gtm", "--project", "gtm"]);
      const execute = harness.inspection.registrations.agentTools.find((tool) => tool.name === "executor_execute")!;
      const call = (code: string, threadId = "thr") => execute.execute({ code }, { threadId, projectId: "proj_gtm", signal: new AbortController().signal }) as Promise<string>;
      const queue = (threadId = "thr") => harness.behavior.callRpc("executorApprovals", { threadId }) as Promise<{ pending: Array<{ name: string; summary: string; open: boolean }> }>;
      return { executor, harness, call, queue };
    };

    it("explains the call and shows a burst one card at a time, answered together by Approve all", async () => {
      const { executor, harness, call, queue } = await setup();
      const archived = call("exec_a");
      await vi.waitFor(() => expect(harness.inspection.pendingInteractions).toHaveLength(1));
      expect(harness.inspection.pendingInteractions[0]!.payload).toMatchObject({
        integration: "PandaDoc", account: "gm@goldsky.com", tool: "documents_archive", description: "Archive a document by ID.",
        reason: "PandaDoc marks this tool as one that changes data, so Executor asks first.",
        // Executor's message only repeated the tool and its arguments.
        message: "",
      });

      const sent = [call("exec_b"), call("exec_c")];
      await vi.waitFor(async () => expect((await queue()).pending).toHaveLength(3));
      expect(harness.inspection.pendingInteractions).toHaveLength(1);
      expect((await queue()).pending).toEqual([
        { approvalId: expect.any(String), name: "pandadoc_com.user.gm.documents_archive", summary: "PandaDoc: Archive a document by ID.", open: true },
        { approvalId: expect.any(String), name: "slack.user.goldsky.slack_send_message", summary: "Slack: Send a Slack message.", open: false },
        { approvalId: expect.any(String), name: "slack.user.goldsky.slack_send_message", summary: "Slack: Send a Slack message.", open: false },
      ]);

      harness.behavior.submitInteraction(harness.inspection.pendingInteractions[0]!.id, { approved: true, scope: "all" });
      expect(await Promise.all([archived, ...sent])).toEqual(["resumed exec_a", "resumed exec_b", "resumed exec_c"]);
      expect(executor.decisions.map(({ executionId, body }) => `${executionId} ${(body as { action: string }).action}`).sort()).toEqual(["exec_a accept", "exec_b accept", "exec_c accept"]);
      expect(harness.inspection.pendingInteractions).toHaveLength(0);
      expect((await queue()).pending).toEqual([]);
    });

    it("approves a tool for the rest of its thread only", async () => {
      const { executor, harness, call } = await setup();
      const first = call("exec_b");
      await vi.waitFor(() => expect(harness.inspection.pendingInteractions).toHaveLength(1));
      expect(harness.inspection.pendingInteractions[0]!.payload).toMatchObject({ reason: "Toolkit gtm has a rule that asks before this tool.", message: "Allow?" });
      harness.behavior.submitInteraction(harness.inspection.pendingInteractions[0]!.id, { approved: true, scope: "thread" });
      expect(await first).toBe("resumed exec_b");

      expect(await call("exec_c")).toBe("resumed exec_c");
      expect(harness.inspection.pendingInteractions).toHaveLength(0);

      const elsewhere = call("exec_d", "thr-other");
      await vi.waitFor(() => expect(harness.inspection.pendingInteractions).toHaveLength(1));
      harness.behavior.cancelInteraction(harness.inspection.pendingInteractions[0]!.id);
      expect(await elsewhere).toBe("resumed exec_d");
      expect(executor.decisions.map(({ executionId, body }) => [executionId, (body as { action: string }).action])).toEqual([["exec_b", "accept"], ["exec_c", "accept"], ["exec_d", "decline"]]);
    });

    it("opens a queued call's own card when the one before it waits too long", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      try {
        const { harness, call, queue } = await setup();
        void call("exec_a");
        await vi.waitFor(() => expect(harness.inspection.pendingInteractions).toHaveLength(1));
        const queued = call("exec_b");
        await vi.waitFor(async () => expect((await queue()).pending).toHaveLength(2));
        expect(harness.inspection.pendingInteractions).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(30_000);
        await vi.waitFor(() => expect(harness.inspection.pendingInteractions).toHaveLength(2));
        const card = harness.inspection.pendingInteractions.find((pending) => (pending.payload as { tool: string }).tool === "slack_send_message")!;
        harness.behavior.submitInteraction(card.id, { approved: false });
        expect(await queued).toBe("resumed exec_b");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("reports toolkits nothing uses and toolkits that share a thread but disagree on a tool", async () => {
    const executor = fakeExecutor({
      toolkits: { gtm: ["slack.user.goldsky.*"], shared: ["slack.*"], unused: ["linear.*"] },
      policies: { gtm: [{ pattern: "slack.user.goldsky.slack_send_message", action: "require_approval" }] },
      tools: [{ address: "tools.slack.user.goldsky.slack_send_message" }, { address: "tools.slack.user.goldsky.slack_read_channel" }],
    });
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = catalogHost();
    await plugin(bb);
    await harness.behavior.runCli(["executor", "use", "gtm", "--project", "gtm"]);
    await harness.behavior.runCli(["executor", "use", "shared", "--global"]);

    const overview = await harness.behavior.callRpc("executorOverview", null);
    expect(overview).toMatchObject({
      configured: true, error: null,
      warnings: [
        "Toolkit unused is not assigned anywhere, so no thread can use it.",
        "gtm and shared share threads but treat 1 tool differently, so the looser one decides: slack.user.goldsky.slack_send_message (gtm asks first, shared runs it)",
      ],
      toolkits: [
        { slug: "gtm", integrations: ["slack"], assignedTo: ["gtm"], tools: 2, rules: { approve: 0, requireApproval: 1, block: 0 } },
        { slug: "shared", integrations: ["slack"], assignedTo: ["every project"], tools: 2, rules: { approve: 0, requireApproval: 0, block: 0 } },
        { slug: "unused", integrations: ["linear"], assignedTo: [], tools: 0 },
      ],
    });
    expect((await harness.behavior.runCli(["executor", "status"])).stdout).toContain("warning\tToolkit unused is not assigned anywhere");
  });

  it("records once when a connection breaks, and once when it recovers", async () => {
    const connectionState: Record<string, { lastHealth?: { status: string; detail?: string } }> = {
      "tools.argus.user.goldsky": { lastHealth: { status: "expired", detail: "OAuth token refresh was rejected (invalid_grant)" } },
      "tools.goldtalk.user.goldsky": { lastHealth: { status: "auth_failed", detail: "401 Unauthorized" } },
      "tools.grain.user.goldsky": { lastHealth: { status: "healthy" } },
      "tools.mercator.user.goldsky": { lastHealth: { status: "degraded", detail: "Tool sync failing: MCP discovery timed out after 15000ms" } },
    };
    const executor = fakeExecutor({
      toolkits: { gtm: ["argus.*"] },
      accounts: { "tools.argus.user.goldsky": "Goldsky", "tools.goldtalk.user.goldsky": "Goldsky", "tools.grain.user.goldsky": "Goldsky", "tools.mercator.user.goldsky": "Goldsky" },
      connectionState,
    });
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = catalogHost();
    await plugin(bb);
    await harness.behavior.runCli(["executor", "use", "gtm", "--project", "gtm"]);
    const signals = () => harness.inspection.realtimeSignals.filter((signal) => signal.channel === "executor-connections-changed");

    await harness.runSchedule("check-executor-connections");
    await harness.runSchedule("check-executor-connections");
    expect(signals()).toEqual([{ channel: "executor-connections-changed", payload: { recovered: [] } }]);
    const { broken } = await harness.behavior.callRpc("executorConnections", null) as { broken: { name: string; problem: string }[] };
    expect(broken).toEqual([
      expect.objectContaining({ name: "argus.user.goldsky (Goldsky)", problem: "expired: OAuth token refresh was rejected (invalid_grant)" }),
      expect.objectContaining({ name: "goldtalk.user.goldsky (Goldsky)", problem: "auth_failed: 401 Unauthorized" }),
    ]);
    const overview = await harness.behavior.callRpc("executorOverview", null) as { warnings: string[] };
    expect(overview.warnings.filter((warning) => warning.startsWith("Connection "))).toHaveLength(2);

    connectionState["tools.argus.user.goldsky"] = { lastHealth: { status: "healthy" } };
    await harness.runSchedule("check-executor-connections");
    expect(signals().slice(1)).toEqual([{ channel: "executor-connections-changed", payload: { recovered: [{ address: "tools.argus.user.goldsky", name: "argus.user.goldsky (Goldsky)", removed: false }] } }]);
    expect((await harness.behavior.callRpc("executorConnections", null) as { broken: unknown[] }).broken).toHaveLength(1);
  });

  it("runs a plugin backend's code only in toolkits mapped to that plugin", async () => {
    const executor = fakeExecutor({ toolkits: { "fixture-worker": ["slack.*", "grain.*"], gtm: ["argus.*"] } });
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = catalogHost();
    await plugin(bb);
    const call = (caller: string, toolkit: string) => harness.behavior.callRpc("executorCall", { caller, toolkit, code: "return 1", mode: "read", purpose: "sync" }, pluginCaller(caller));

    await expect(call("fixture-worker", "fixture-worker")).rejects.toBeInstanceOf(Error);
    await harness.behavior.runCli(["executor", "use", "gtm", "--global"]);
    expect((await harness.behavior.callRpc("executorConfiguration", null)).mappings).toContainEqual({ scope: "global", targetId: "*", toolkits: ["gtm"] });
    await expect(call("fixture-worker", "gtm")).rejects.toBeInstanceOf(Error);

    expect((await harness.behavior.runCli(["executor", "use", "fixture-worker", "--plugin", "fixture-worker"])).exitCode).toBe(0);
    expect((await harness.behavior.runCli(["executor", "use", "fixture-worker", "--plugin", "Not A Plugin"])).exitCode).toBe(1);
    await call("fixture-worker", "fixture-worker");
    await expect(call("fixture-worker", "gtm")).rejects.toBeInstanceOf(Error);
    await expect(call("pages", "fixture-worker")).rejects.toBeInstanceOf(Error);
    expect(await harness.behavior.callRpc("executorToolkits", { caller: "fixture-worker" }, pluginCaller("fixture-worker"))).toEqual({ configured: true, toolkits: [{ slug: "fixture-worker", integrations: ["grain", "slack"] }] });

    // Plugin scopes stay out of every thread's toolkits.
    const execute = harness.inspection.registrations.agentTools.find((tool) => tool.name === "executor_execute")!;
    await expect(execute.execute({ code: "return 1", toolkit: "fixture-worker" }, { threadId: "fixture-thread", projectId: "proj_gtm", signal: new AbortController().signal })).rejects.toBeInstanceOf(Error);

    const calls = (await harness.behavior.runCli(["executor", "calls", "--plugin", "fixture-worker", "--json"])).stdout;
    // Verified attempts are audited, refused toolkit requests included.
    expect(JSON.parse(calls).map((row: { toolkit: string; outcome: string }) => `${row.outcome} ${row.toolkit}`).sort()).toEqual(["error fixture-worker", "error gtm", "error gtm", "ok fixture-worker"]);
  });

  it("declines a plugin's read call that needs approval instead of waiting", async () => {
    const executor = fakeExecutor({
      toolkits: { inbox: ["slack.*"] },
      approvals: { exec_read: { address: "tools.slack.user.goldsky.slack_send_message_draft", message: "Allow?", args: { message: "hi" } } },
      toolResult: (name) => name === "execute" ? pausedResult("exec_read") : undefined,
    });
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = catalogHost();
    await plugin(bb);
    await harness.behavior.runCli(["executor", "use", "inbox", "--plugin", "inbox"]);

    await expect(harness.behavior.callRpc("executorCall", { caller: "inbox", toolkit: "inbox", code: "x", mode: "read", purpose: "sync slack" }, pluginCaller("inbox")))
      .rejects.toBeInstanceOf(Error);
    expect(executor.decisions.map(({ executionId, body }) => [executionId, body])).toEqual([["exec_read", { action: "decline" }]]);
    expect(harness.inspection.pendingInteractions).toHaveLength(0);
    expect((await harness.behavior.runCli(["executor", "calls"])).stdout).toMatch(/\tinbox\tinbox\tread\tdeclined\t.*\tsync slack\t/u);
  });

  it("returns a plugin's paused write for display and verified decline, not RPC approval", async () => {
    const next = "exec_draft";
    const executor = fakeExecutor({
      toolkits: { "fixture-policy": ["slack.*"] },
      approvals: {
        exec_draft: { address: "tools.slack.user.goldsky.slack_send_message_draft", message: "Allow?", args: { channel_id: "D1", message: "hi" } },
      },
      toolResult: (name, args) => name === "execute"
        ? pausedResult(next)
        : name === "resume" ? { content: [{ type: "text", text: `resumed ${(args as { executionId: string }).executionId}` }] } : undefined,
    });
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = catalogHost();
    await plugin(bb);
    await harness.behavior.runCli(["executor", "use", "fixture-policy", "--plugin", "worker"]);
    const write = () => harness.behavior.callRpc("executorCall", { caller: "worker", toolkit: "fixture-policy", code: "x", mode: "write", purpose: "slack draft" }, pluginCaller("worker"));

    const paused = await write();
    expect(paused).toEqual({
      text: "Approve at https://executor.test/resume/exec_draft?mcp_session_id=s1 then call resume",
      paused: {
        executionId: "exec_draft", approvalUrl: "https://executor.test/resume/exec_draft?mcp_session_id=s1",
        address: "slack.user.goldsky.slack_send_message_draft", message: "Allow?", args: JSON.stringify({ channel_id: "D1", message: "hi" }, null, 2),
      },
    });
    expect(executor.decisions).toEqual([]);
    expect(harness.inspection.pendingInteractions).toHaveLength(0);

    await expect(harness.behavior.callRpc("executorDecide", { caller: "pages", executionId: "exec_draft", action: "decline" }, pluginCaller("pages"))).rejects.toThrow("No paused Executor call with that ID is waiting for this plugin.");
    await expect(harness.behavior.callRpc("executorDecide", { caller: "worker", executionId: "exec_draft", action: "accept" })).rejects.toThrow(/native owner interaction/u);
    expect(await harness.behavior.callRpc("executorDecide", { caller: "worker", executionId: "exec_draft", action: "decline" }, pluginCaller("worker"))).toEqual({ text: "Declined.", paused: null });
    await expect(harness.behavior.callRpc("executorDecide", { caller: "worker", executionId: "exec_draft", action: "decline" }, pluginCaller("worker"))).rejects.toThrow(/No paused Executor call/u);
    expect(executor.decisions.map(({ executionId, body }) => [executionId, body])).toEqual([["exec_draft", { action: "decline" }]]);
  });

  describe("caller authority", () => {
    it.each(["inbox", "prospecting"])("lets synthetic %s call and decline only its own execution", async (caller) => {
      const executor = fakeExecutor({
        toolkits: { fixture: ["fixture.*"] },
        approvals: { exec_fixture: { address: "tools.fixture.test.account.write", message: "Allow?", args: {} } },
        toolResult: (name) => name === "execute" ? pausedResult("exec_fixture") : undefined,
      });
      vi.stubGlobal("fetch", executor.fetcher);
      const { bb, harness } = catalogHost();
      await plugin(bb);
      await harness.behavior.runCli(["executor", "use", "fixture", "--plugin", caller]);
      expect(await harness.behavior.callRpc("executorToolkits", { caller }, pluginCaller(caller))).toEqual({
        configured: true, toolkits: [{ slug: "fixture", integrations: ["fixture"] }],
      });
      expect(await harness.behavior.callRpc("executorCall", { caller, toolkit: "fixture", code: "fixture", mode: "write", purpose: "synthetic compatibility" }, pluginCaller(caller)))
        .toMatchObject({ paused: { executionId: "exec_fixture" } });
      expect(await harness.behavior.callRpc("executorDecide", { caller, executionId: "exec_fixture", action: "decline" }, pluginCaller(caller)))
        .toEqual({ text: "Declined.", paused: null });
      expect(executor.decisions.map(({ body }) => body)).toEqual([{ action: "decline" }]);
      await harness.lifecycle.dispose();
    });

    it.each(["spoofed", "client", "missing"] as const)("rejects %s identity before lookup, audit, rate slots or external work", async (identity) => {
      const executor = fakeExecutor({ toolkits: { fixture: ["fixture.*"] } });
      vi.stubGlobal("fetch", executor.fetcher);
      const { bb, harness } = catalogHost();
      const register = vi.spyOn(bb.rpc, "register");
      await plugin(bb);
      await harness.behavior.runCli(["executor", "use", "fixture", "--plugin", "worker"]);
      const requests = executor.calls.length;
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
      expect(executor.calls).toHaveLength(requests);
      expect(JSON.parse((await harness.behavior.runCli(["executor", "calls", "--json"])).stdout)).toEqual([]);
      for (let i = 0; i < 30; i++) {
        expect(await harness.behavior.callRpc("executorCall", input, pluginCaller("worker"))).toEqual({ text: "ran execute", paused: null });
      }
      await expect(harness.behavior.callRpc("executorCall", input, pluginCaller("worker"))).rejects.toThrow(/made 30 Executor calls/u);
      await harness.lifecycle.dispose();
    });

    it("does not queue a spoofed call behind a verified caller's pending call", async () => {
      const executor = fakeExecutor({ toolkits: { fixture: ["fixture.*"] } });
      const { bb, harness } = catalogHost();
      const started = Promise.withResolvers<void>();
      const blocked = Promise.withResolvers<void>();
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        if (body?.method === "tools/call") { started.resolve(); await blocked.promise; }
        return executor.fetcher(input, init);
      });
      await plugin(bb);
      await harness.behavior.runCli(["executor", "use", "fixture", "--plugin", "worker"]);
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
      let next = "exec_accept";
      const executor = fakeExecutor({
        toolkits: { fixture: ["fixture.*"] },
        approvals: Object.fromEntries(["exec_accept", "exec_decline"].map((id) => [id, { address: "tools.fixture.test.account.write", message: "Allow?", args: {} }])),
        toolResult: (name) => name === "execute" ? pausedResult(next) : undefined,
      });
      vi.stubGlobal("fetch", executor.fetcher);
      const { bb, harness } = catalogHost();
      const register = vi.spyOn(bb.rpc, "register");
      await plugin(bb);
      await harness.behavior.runCli(["executor", "use", "fixture", "--plugin", "worker"]);
      const writeInput = { caller: "worker", toolkit: "fixture", code: "fixture", mode: "write", purpose: "owner decision" };
      await harness.behavior.callRpc("executorCall", writeInput, pluginCaller("worker"));
      const input = { caller: "worker", executionId: next, action: "accept" };
      const before = executor.calls.length;
      await expect(harness.behavior.callRpc("executorDecide", input, pluginCaller("worker"))).rejects.toThrow(/native owner interaction/u);
      await expect(harness.behavior.callRpc("executorDecide", { ...input, action: "decline" }, pluginCaller("other-worker"))).rejects.toThrow(/verified plugin caller/u);
      await expect(harness.behavior.callRpc("executorDecide", { ...input, caller: "other-worker", action: "decline" }, pluginCaller("other-worker"))).rejects.toThrow(/No paused Executor call/u);
      await expect((async () => register.mock.calls[0]![1].executorDecide!(input, undefined as never))()).rejects.toThrow(/verified plugin caller/u);
      expect(executor.calls).toHaveLength(before);
      expect(executor.decisions).toEqual([]);
      expect(JSON.parse((await harness.behavior.runCli(["executor", "calls", "--json"])).stdout).map((row: { outcome: string }) => row.outcome)).toEqual(["paused"]);
      await expect(harness.behavior.callRpc("executorDecide", input)).rejects.toThrow(/native owner interaction/u);
      expect(await harness.behavior.callRpc("executorDecide", { ...input, action: "decline" }, pluginCaller("worker"))).toEqual({ text: "Declined.", paused: null });
      await expect(harness.behavior.callRpc("executorDecide", { ...input, action: "decline" })).rejects.toThrow(/No paused Executor call/u);
      next = "exec_decline";
      await harness.behavior.callRpc("executorCall", writeInput, pluginCaller("worker"));
      expect(await harness.behavior.callRpc("executorDecide", { caller: "worker", executionId: next, action: "decline" })).toEqual({ text: "Declined.", paused: null });
      expect(executor.decisions.map(({ executionId, body }) => [executionId, body])).toEqual([
        ["exec_accept", { action: "decline" }], ["exec_decline", { action: "decline" }],
      ]);
      expect(harness.inspection.pendingInteractions).toHaveLength(0);
      await harness.lifecycle.dispose();
    });
  });

  describe("owner provenance", () => {
    it("rejects generic client acceptance without consuming a plugin pause or audit slot", async () => {
      const executor = fakeExecutor({ toolkits: { fixture: ["fixture.*"] }, approvals: { exec_owner: { address: "tools.fixture.test.account.write", message: "Allow?", args: {} } },
        toolResult: (name) => name === "execute" ? pausedResult("exec_owner") : undefined });
      vi.stubGlobal("fetch", executor.fetcher);
      const { bb, harness } = catalogHost();
      await plugin(bb);
      await harness.behavior.runCli(["executor", "use", "fixture", "--plugin", "worker"]);
      await harness.behavior.callRpc("executorCall", { caller: "worker", toolkit: "fixture", code: "fixture", mode: "write", purpose: "approval provenance" }, pluginCaller("worker"));
      const before = executor.calls.length;
      await expect(harness.behavior.callRpc("executorDecide", { caller: "worker", executionId: "exec_owner", action: "accept" })).rejects.toThrow(/native owner interaction/u);
      expect(executor.calls).toHaveLength(before);
      expect(executor.decisions).toEqual([]);
      expect(JSON.parse((await harness.behavior.runCli(["executor", "calls", "--json"])).stdout).map((row: { outcome: string }) => row.outcome)).toEqual(["paused"]);
      expect(await harness.behavior.callRpc("executorDecide", { caller: "worker", executionId: "exec_owner", action: "decline" }, pluginCaller("worker"))).toEqual({ text: "Declined.", paused: null });
      await harness.lifecycle.dispose();
    });

    it("does not accept or retain a thread grant after toolkit access is revoked while a native card is open", async () => {
      const executor = fakeExecutor({ toolkits: { fixture: ["fixture.*"] }, approvals: {
        exec_revoked: { address: "tools.fixture.test.account.write", message: "Allow?", args: {} },
        exec_retry: { address: "tools.fixture.test.account.write", message: "Allow?", args: {} },
      }, toolResult: (name, args) => name === "execute" ? pausedResult((args as { code: string }).code) : undefined });
      vi.stubGlobal("fetch", executor.fetcher);
      const { bb, harness } = catalogHost();
      await plugin(bb);
      await harness.behavior.runCli(["executor", "use", "fixture", "--global"]);
      const execute = harness.inspection.registrations.agentTools.find((tool) => tool.name === "executor_execute")!;
      const context = { threadId: "fixture-thread", projectId: "fixture-project", signal: new AbortController().signal };
      const pending = execute.execute({ code: "exec_revoked" }, context);
      await vi.waitFor(() => expect(harness.inspection.pendingInteractions).toHaveLength(1));
      await harness.behavior.runCli(["executor", "use", "--clear", "--global"]);
      harness.behavior.submitInteraction(harness.inspection.pendingInteractions[0]!.id, { approved: true, scope: "thread" });
      await expect(pending).rejects.toThrow(/access changed/u);
      expect(executor.decisions).toEqual([]);
      await harness.behavior.runCli(["executor", "use", "fixture", "--global"]);
      const retry = execute.execute({ code: "exec_retry" }, context);
      await vi.waitFor(() => expect(harness.inspection.pendingInteractions).toHaveLength(1));
      harness.behavior.cancelInteraction(harness.inspection.pendingInteractions[0]!.id);
      expect(await retry).toBe("ran resume");
      expect(executor.decisions.map(({ body }) => body)).toEqual([{ action: "decline" }]);
      await harness.lifecycle.dispose();
    });

    it("does not persist approve-for-thread across a plugin restart", async () => {
      const executor = fakeExecutor({ toolkits: { fixture: ["fixture.*"] }, approvals: {
        exec_first: { address: "tools.fixture.test.account.write", message: "Allow?", args: {} },
        exec_after_restart: { address: "tools.fixture.test.account.write", message: "Allow?", args: {} },
      }, toolResult: (name, args) => name === "execute" ? pausedResult((args as { code: string }).code) : undefined });
      vi.stubGlobal("fetch", executor.fetcher);
      let host = catalogHost();
      await plugin(host.bb);
      await host.harness.behavior.runCli(["executor", "use", "fixture", "--global"]);
      const context = { threadId: "fixture-thread", projectId: "fixture-project" };
      const first = host.harness.behavior.callAgentTool("executor_execute", { code: "exec_first" }, context);
      await vi.waitFor(() => expect(host.harness.inspection.pendingInteractions).toHaveLength(1));
      host.harness.behavior.submitInteraction(host.harness.inspection.pendingInteractions[0]!.id, { approved: true, scope: "thread" });
      expect(await first).toBe("ran resume");
      host = await host.harness.lifecycle.reload(plugin);
      const restarted = host.harness.behavior.callAgentTool("executor_execute", { code: "exec_after_restart" }, context);
      await vi.waitFor(() => expect(host.harness.inspection.pendingInteractions).toHaveLength(1));
      host.harness.behavior.cancelInteraction(host.harness.inspection.pendingInteractions[0]!.id);
      expect(await restarted).toBe("ran resume");
      expect(executor.decisions.map(({ body }) => body)).toEqual([{ action: "accept", content: {} }, { action: "decline" }]);
      await host.harness.lifecycle.dispose();
    });

    it("leaves a timed-out or unknown native pause unapproved", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      const executor = fakeExecutor({ toolkits: { fixture: ["fixture.*"] }, approvals: {
        exec_timeout: { address: "tools.fixture.test.account.write", message: "Allow?", args: {} },
      }, toolResult: (name, args) => name === "execute" ? pausedResult("exec_timeout") : name === "resume" ? pausedResult((args as { executionId: string }).executionId) : undefined });
      vi.stubGlobal("fetch", executor.fetcher);
      const { bb, harness } = catalogHost();
      try {
        await plugin(bb);
        await harness.behavior.runCli(["executor", "use", "fixture", "--global"]);
        const context = { threadId: "fixture-thread", projectId: "fixture-project" };
        const pending = harness.behavior.callAgentTool("executor_execute", { code: "fixture" }, context);
        await vi.waitFor(() => expect(harness.inspection.pendingInteractions).toHaveLength(1));
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1);
        expect(await pending).toContain("/resume/exec_timeout");
        expect(await harness.behavior.callAgentTool("executor_resume", { executionId: "exec_unknown" }, context)).toContain("/resume/exec_unknown");
        expect(executor.decisions).toEqual([]);
        expect(harness.inspection.pendingInteractions).toHaveLength(0);
      } finally {
        await harness.lifecycle.dispose();
        vi.useRealTimers();
      }
    });
  });
});
