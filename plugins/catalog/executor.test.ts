import { describe, expect, it } from "vitest";
import { ExecutorClient, parseRpcResponse, patternMatches } from "./executor.js";
import { fakeExecutor, pausedResult } from "./test-support/executor-fake.js";

describe("Executor client", () => {
  it("matches Executor patterns against tool addresses", () => {
    expect(patternMatches("slack.*", "tools.slack.user.goldsky.post")).toBe(true);
    expect(patternMatches("slack.user.goldsky.post", "tools.slack.user.goldsky.post")).toBe(true);
    expect(patternMatches("slack.user.goldsky.post", "tools.slack.user.goldsky.post_draft")).toBe(false);
    expect(patternMatches("slack.*", "tools.slackbot.user.goldsky.post")).toBe(false);
    expect(patternMatches("pandadoc_com.user.gm(x).*", "tools.pandadoc_com.user.gm(x).a")).toBe(true);
  });

  it("finds the matching JSON-RPC response in an SSE stream", () => {
    const body = `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 7, result: { ok: true } })}\n\n`;
    expect(parseRpcResponse(body, "text/event-stream", 7)).toMatchObject({ result: { ok: true } });
  });

  it("reads which integrations each named toolkit reaches", async () => {
    const executor = fakeExecutor({ toolkits: { gtm: ["goldtalk.user.goldsky.*", "argus.*", "argus.user.other.*"], other: ["pylon.*"] } });
    const client = new ExecutorClient({ url: "https://executor.test", apiKey: "key" }, executor.fetcher);
    expect(Object.fromEntries(await client.toolkitIntegrations(["gtm", "missing"]))).toEqual({ gtm: ["argus", "goldtalk"] });
  });

  it("calls the toolkit endpoint in browser-approval mode and reopens an expired session once", async () => {
    const executor = fakeExecutor({ expireFirstSession: true });
    const client = new ExecutorClient({ url: "https://executor.test", apiKey: "key" }, executor.fetcher);

    expect(await client.callTool("gtm", "execute", { code: "return 1" })).toEqual({ text: "ran execute", paused: null });
    const toolCalls = executor.calls.filter((call) => (call.body as { method?: string } | undefined)?.method === "tools/call");
    expect(toolCalls.map((call) => call.session)).toEqual(["s1", "s2"]);
    expect(toolCalls[0]!.url).toBe("/mcp/toolkits/gtm?elicitation_mode=browser&artifacts=false");
  });

  it("makes approval links absolute and surfaces tool errors", async () => {
    const executor = fakeExecutor({
      toolResult: (name) => name === "execute"
        ? { content: [{ type: "text", text: "Approve at /resume/exec_1 then call resume" }] }
        : { content: [{ type: "text", text: "Tool blocked by policy" }], isError: true },
    });
    const client = new ExecutorClient({ url: "https://executor.test", apiKey: "key" }, executor.fetcher);

    expect((await client.callTool("gtm", "execute", { code: "x" })).text).toBe("Approve at https://executor.test/resume/exec_1 then call resume");
    await expect(client.callTool("gtm", "resume", { executionId: "exec_1" })).rejects.toThrow("Tool blocked by policy");
  });

  it("reads a paused call and records the decision through the approval API", async () => {
    const executor = fakeExecutor({
      toolResult: () => pausedResult("exec_2", "s9"),
      approvals: { exec_2: { address: "tools.hubspot.user.goldsky.submit_feedback", message: "Allow this call?", args: { note: "hi" } } },
    });
    const client = new ExecutorClient({ url: "https://executor.test", apiKey: "key" }, executor.fetcher);

    const { paused } = await client.callTool("gtm", "execute", { code: "x" });
    expect(paused).toEqual({ executionId: "exec_2", mcpSessionId: "s9", approvalUrl: "https://executor.test/resume/exec_2?mcp_session_id=s9" });
    expect(await client.approvalRequest(paused!)).toEqual({ address: "tools.hubspot.user.goldsky.submit_feedback", message: "Allow this call?", args: { note: "hi" } });
    await client.decide(paused!, "accept");
    expect(executor.decisions).toEqual([{ executionId: "exec_2", mcpSessionId: "s9", body: { action: "accept", content: {} } }]);
    await expect(client.approvalRequest(paused!)).rejects.toThrow("HTTP 404");
  });
});
