import { describe, expect, it } from "vitest";
import {
  ExecutorApi, McpConnectionClient, authorizationUrl, connectionUrl, exchangeCode, parseConnectionRef, parseRpcResponse,
  readOutcome, refreshTokens, registerClient,
} from "./executor.js";
import { fakeExecutor } from "./test-support/executor-fake.js";

const ORIGIN = "https://executor.test";
const REDIRECT = "https://bb.test/api/v1/plugins/catalog/http/oauth/callback";

/** Runs the OAuth flow against the fake and returns tokens for one connection. */
async function tokensFor(executor: ReturnType<typeof fakeExecutor>, connection: string) {
  const client = await registerClient(ORIGIN, REDIRECT, executor.fetcher);
  const resource = connectionUrl(ORIGIN, connection);
  const pending = authorizationUrl(ORIGIN, client, resource);
  const code = new URLSearchParams(executor.approve(pending.url).split("?")[1]).get("code")!;
  return { client, resource, tokens: await exchangeCode(ORIGIN, client, code, pending.verifier, resource, executor.fetcher) };
}

describe("Executor client", () => {
  it("finds the matching JSON-RPC response in an SSE stream", () => {
    const body = `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 7, result: { ok: true } })}\n\n`;
    expect(parseRpcResponse(body, "text/event-stream", 7)).toMatchObject({ result: { ok: true } });
  });

  it("reads connection URLs and bare connection IDs", () => {
    expect(connectionUrl(ORIGIN, "gtm")).toBe("https://executor.test/mcp?connection=gtm");
    expect(parseConnectionRef("gtm", ORIGIN)).toEqual({ origin: ORIGIN, connection: "gtm" });
    expect(parseConnectionRef("https://other.test/mcp?connection=ops", ORIGIN)).toEqual({ origin: "https://other.test", connection: "ops" });
    expect(() => parseConnectionRef("gtm", null)).toThrow(/Configure the Executor URL/u);
    expect(() => parseConnectionRef("https://other.test/mcp", ORIGIN)).toThrow(/connection URL/u);
    expect(() => connectionUrl(ORIGIN, "../x")).toThrow(/Not an Executor connection ID/u);
  });

  it("reads approvals, approvals without fields, and form requests", () => {
    expect(readOutcome({
      status: "approval-required", requestId: "r1", expiresAt: "2026-01-01",
      invocation: { app: "slack", tool: "sendMessage", input: { text: "hi" }, accounts: { user: "acct_1" } },
      elicitation: { message: "Send?" },
    })).toEqual({
      approval: { requestId: "r1", address: "slack.sendMessage", app: "slack", tool: "sendMessage", input: { text: "hi" }, account: "acct_1", message: "Send?", expiresAt: "2026-01-01" },
      input: null,
    });
    const form = (properties: Record<string, unknown>) => readOutcome({
      status: "input-required", requestId: "r2", tool: { app: "linear", tool: "create" }, elicitation: { message: "Fill", requestedSchema: { properties } },
    });
    expect(form({}).approval).toMatchObject({ requestId: "r2", address: "linear.create" });
    expect(form({ title: { type: "string" } })).toEqual({ approval: null, input: { requestId: "r2", address: "linear.create", message: "Fill" } });
    expect(readOutcome({ status: "completed" })).toEqual({ approval: null, input: null });
  });

  it("signs in with PKCE, rotates refresh tokens, and refuses a reused one", async () => {
    const executor = fakeExecutor({ connections: ["gtm"] });
    const { client, resource, tokens } = await tokensFor(executor, "gtm");
    expect(client.clientId).toBe("client_1");
    expect(tokens.refreshToken).toBeTruthy();
    const next = await refreshTokens(ORIGIN, client.clientId, tokens.refreshToken!, resource, executor.fetcher);
    expect(next.accessToken).not.toBe(tokens.accessToken);
    await expect(refreshTokens(ORIGIN, client.clientId, tokens.refreshToken!, resource, executor.fetcher)).rejects.toMatchObject({ status: 400 });
  });

  it("calls a connection's MCP tools and refreshes once when the token stops working", async () => {
    const executor = fakeExecutor({
      connections: ["gtm"],
      skills: { gtm: [{ app: "hstack", appName: "hstack", name: "build", description: "Build it" }] },
      approvals: { r1: { app: "slack", tool: "send" } },
      execute: (code) => code === "pause" ? { approval: "r1" } : `ran ${code}`,
    });
    const { client, resource, tokens } = await tokensFor(executor, "gtm");
    let current = tokens;
    const refreshes: boolean[] = [];
    const mcp = new McpConnectionClient(resource, async ({ refresh }) => {
      refreshes.push(refresh);
      if (refresh) current = await refreshTokens(ORIGIN, client.clientId, current.refreshToken!, resource, executor.fetcher);
      return current.accessToken;
    }, executor.fetcher);

    expect((await mcp.execute("x")).text).toBe("ran x");
    expect(await mcp.listSkills()).toEqual([{ app: "hstack", appName: "hstack", name: "build", description: "Build it", version: "1", revision: "r1" }]);
    expect(await mcp.readSkill({ app: "hstack", name: "build", version: "1", revision: "r1" })).toEqual({ content: "# build\n", files: ["SKILL.md"] });

    executor.expireAccess();
    const paused = await mcp.execute("pause");
    expect(paused.approval).toMatchObject({ requestId: "r1", address: "slack.send" });
    expect((await mcp.resume("r1", "accept")).text).toBe("resumed r1");
    expect(executor.decisions).toEqual([{ requestId: "r1", action: "accept", connection: "gtm" }]);
    expect(refreshes.filter(Boolean)).toHaveLength(1);
    await expect(mcp.resume("r1", "accept")).rejects.toThrow("No request r1");
  });

  it("reads organization context and broken account checks with a PAT", async () => {
    const executor = fakeExecutor({
      inventory: {
        apps: [{ id: "app_1", slug: "slack", name: "Slack" }, { id: "app_2", slug: "linear", name: "Linear" }],
        accounts: [{ id: "acct_1", label: "Goldsky", health: { apps: [
          { app: "app_1", check: { status: "credentials_rejected", message: "invalid_grant" } },
          { app: "app_2", check: { status: "ok" } },
        ] } }],
      },
    });
    const api = new ExecutorApi(ORIGIN, executor.pat, executor.fetcher);
    expect(await api.context()).toEqual({ organization: "org_1", slug: "hex", role: "owner" });
    expect(await api.accountProblems()).toEqual([{ account: "acct_1", label: "Goldsky", app: "slack", appName: "Slack", problem: "credentials_rejected: invalid_grant" }]);
    await expect(new ExecutorApi(ORIGIN, "wrong", executor.fetcher).context()).rejects.toMatchObject({ status: 401 });
  });
});
