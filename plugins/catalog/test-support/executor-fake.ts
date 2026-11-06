import { createHash } from "node:crypto";

/**
 * A small in-memory Executor v2 for tests: OAuth (register, token), one MCP
 * endpoint per connection, and the organization inventory a PAT reads.
 */
export interface FakeApproval { app: string; tool: string; input?: unknown; account?: string; message?: string }
export interface FakeSkill { app: string; appName?: string; name: string; description?: string; version?: string; revision?: string; files?: Record<string, string> }
export interface McpCall { connection: string; tool: string; args: Record<string, unknown>; token: string }
/** What `execute` returns: plain text, a pause for approval, or a form request. */
export type ExecuteResult = string | { approval: string } | { input: string; fields?: boolean };

const PAT = "exp_test";

export function fakeExecutor(options: {
  /** Connections Executor knows. A token for another resource is refused. */
  connections?: string[];
  skills?: Record<string, FakeSkill[]>;
  /** Paused requests by request ID; a request answered once is gone. */
  approvals?: Record<string, FakeApproval>;
  execute?: (code: string, connection: string) => ExecuteResult;
  /** What a resumed request returns. The default is `resumed <requestId>`. */
  afterResume?: (requestId: string, action: string) => ExecuteResult;
  /** Accounts and their app checks; read on every request, so a test can change it. */
  inventory?: { apps: Array<{ id: string; slug: string; name: string }>; accounts: Array<{ id: string; label: string; health: { apps: Array<{ app: string; check: { status: string; message?: string } }> } }> };
  accessTtlSeconds?: number;
} = {}) {
  const known = new Set(options.connections ?? []);
  const approvals = options.approvals ?? {};
  const calls: McpCall[] = [];
  const decisions: Array<{ requestId: string; action: string; connection: string }> = [];
  const requests: string[] = [];
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; resource: string }>();
  const access = new Map<string, string>();
  const refresh = new Map<string, string>();
  let clients = 0;
  let issued = 0;
  let sessions = 0;
  const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), { ...init, headers: { "content-type": "application/json", ...init.headers } });
  const issue = (resource: string) => {
    issued += 1;
    const accessToken = `at_${issued}`;
    const refreshToken = `rt_${issued}`;
    access.set(accessToken, resource);
    refresh.set(refreshToken, resource);
    return json({ access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: options.accessTtlSeconds ?? 3_600 });
  };
  const outcome = (result: ExecuteResult) => {
    if (typeof result === "string") return { content: [{ type: "text", text: result }] };
    if ("approval" in result) {
      const pending = approvals[result.approval]!;
      return {
        content: [{ type: "text", text: `Approval required for ${pending.app}.${pending.tool}` }],
        structuredContent: {
          status: "approval-required", requestId: result.approval,
          invocation: { app: pending.app, tool: pending.tool, input: pending.input ?? null, accounts: pending.account ? { user: pending.account } : {} },
          elicitation: { message: pending.message ?? "" },
        },
      };
    }
    return {
      content: [{ type: "text", text: "Input required" }],
      structuredContent: {
        status: "input-required", requestId: result.input, tool: { app: "forms", tool: "ask" },
        elicitation: { message: "Fill this in", requestedSchema: { properties: result.fields === false ? {} : { name: { type: "string" } } } },
      },
    };
  };
  const tool = (connection: string, name: string, args: Record<string, unknown>) => {
    if (name === "execute") return outcome(options.execute?.(String(args.code), connection) ?? "ran execute");
    if (name === "resume") {
      const requestId = String(args.requestId);
      const action = String((args.response as { action?: string } | undefined)?.action);
      if (!(requestId in approvals) && !requestId.startsWith("form_")) return { isError: true, content: [{ type: "text", text: `No request ${requestId}` }] };
      delete approvals[requestId];
      decisions.push({ requestId, action, connection });
      return outcome(options.afterResume?.(requestId, action) ?? `resumed ${requestId}`);
    }
    if (name === "skills") {
      const skills = options.skills?.[connection] ?? [];
      if (args.name) {
        const skill = skills.find((entry) => entry.app === args.app && entry.name === args.name);
        if (!skill) return { isError: true, content: [{ type: "text", text: `No skill ${String(args.app)}/${String(args.name)}` }] };
        const files = skill.files ?? { "SKILL.md": `# ${skill.name}\n` };
        const file = typeof args.file === "string" ? args.file : "SKILL.md";
        return { content: [{ type: "text", text: files[file] ?? "" }], structuredContent: { content: files[file] ?? "", files: Object.keys(files) } };
      }
      const listed = skills.filter((entry) => !args.app || entry.app === args.app).map((entry) => ({
        name: entry.name, description: entry.description ?? "", version: entry.version ?? "1", revision: entry.revision ?? "r1",
        app: { slug: entry.app, name: entry.appName ?? entry.app },
      }));
      return { content: [{ type: "text", text: listed.map((entry) => entry.name).join("\n") }], structuredContent: { skills: listed } };
    }
    return { content: [{ type: "text", text: `ran ${name}` }] };
  };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/auth/oauth2/register") {
      const body = JSON.parse(String(init!.body)) as { token_endpoint_auth_method: string };
      if (body.token_endpoint_auth_method !== "none") return json({ error: "invalid_client_metadata" }, { status: 400 });
      clients += 1;
      return json({ client_id: `client_${clients}` }, { status: 201 });
    }
    if (url.pathname === "/api/auth/oauth2/token") {
      const form = new URLSearchParams(String(init!.body));
      if (form.get("grant_type") === "authorization_code") {
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (!code || code.challenge !== challenge || code.resource !== form.get("resource") || code.redirectUri !== form.get("redirect_uri")) return json({ error: "invalid_grant" }, { status: 400 });
        return issue(code.resource);
      }
      const resource = refresh.get(form.get("refresh_token") ?? "");
      // Executor rotates refresh tokens: each one works once.
      refresh.delete(form.get("refresh_token") ?? "");
      if (!resource || resource !== form.get("resource")) return json({ error: "invalid_grant" }, { status: 400 });
      return issue(resource);
    }
    const inventory = /^\/api\/organizations\/([^/]+)\/inventory$/u.exec(url.pathname);
    if (url.pathname === "/api/context" || inventory) {
      if (headers.get("authorization") !== `Bearer ${PAT}`) return json({ error: "unauthorized" }, { status: 401 });
      if (!inventory) return json({ organization: "org_1", slug: "hex", role: "owner" });
      return json(options.inventory ?? { apps: [], accounts: [] });
    }
    if (url.pathname === "/mcp") {
      const connection = url.searchParams.get("connection") ?? "";
      const token = (headers.get("authorization") ?? "").replace(/^Bearer /u, "");
      if (!known.has(connection) || access.get(token) !== url.href) return json({ error: "invalid_token" }, { status: 401 });
      const body = JSON.parse(String(init!.body)) as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown> } };
      if (body.method === "initialize") {
        sessions += 1;
        return json({ jsonrpc: "2.0", id: body.id, result: {} }, { headers: { "mcp-session-id": `s${sessions}` } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      calls.push({ connection, tool: body.params!.name, args: body.params!.arguments, token });
      const result = tool(connection, body.params!.name, body.params!.arguments);
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  /**
   * Plays the browser: approves the consent URL and returns the callback
   * path and query BB's route receives.
   */
  function approve(consentUrl: string): string {
    const url = new URL(consentUrl);
    const params = url.searchParams;
    if (params.get("code_challenge_method") !== "S256" || params.get("scope") !== "mcp offline_access") throw new Error("bad consent URL");
    const code = `code_${codes.size + issued + 1}`;
    codes.set(code, { clientId: params.get("client_id")!, redirectUri: params.get("redirect_uri")!, challenge: params.get("code_challenge")!, resource: params.get("resource")! });
    const redirect = new URL(params.get("redirect_uri")!);
    return `${redirect.pathname.replace("/api/v1/plugins/catalog/http", "")}?code=${code}&state=${params.get("state")}`;
  }
  /** Makes every access token stop working, as an expiry would. */
  function expireAccess() { access.clear(); }
  return { fetcher, calls, decisions, requests, approve, expireAccess, pat: PAT };
}

/** Signs a test plugin in to each connection through the CLI and the callback route. */
export async function signIn(
  harness: { behavior: { runCli(argv: string[]): Promise<{ exitCode: number; stdout?: string; stderr?: string }>; fetchHttp(method: string, path: string): Promise<Response> } },
  executor: ReturnType<typeof fakeExecutor>,
  ...connections: string[]
) {
  for (const connection of connections) {
    const started = await harness.behavior.runCli(["executor", "connect", connection, "--redirect-origin", "https://bb.test"]);
    if (started.exitCode !== 0) throw new Error(started.stderr);
    const consent = /https:\/\/executor\.test\/api\/auth\/oauth2\/authorize\S+/u.exec(started.stdout ?? "")![0];
    const response = await harness.behavior.fetchHttp("GET", executor.approve(consent));
    if (response.status !== 200) throw new Error(await response.text());
  }
}
