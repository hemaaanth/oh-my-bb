/**
 * This plugin's client for a self-hosted Executor server (https://executor.sh).
 *
 * Executor owns the tools: its connections hold the credentials, and its
 * toolkits decide which connections and policies go together. This plugin only
 * maps each project to the toolkits its agents may use and calls those
 * toolkits' MCP endpoints. An Executor API key reaches every toolkit, so the
 * scope is enforced here, by choosing the endpoint, and never by the agent.
 */

export const MAX_EXECUTOR_OUTPUT_BYTES = 256 * 1024;
const PROTOCOL_VERSION = "2025-06-18";

export interface ExecutorConfig { url: string; apiKey: string }
interface Toolkit { id: string; slug: string; name: string }
interface ToolkitConnection { pattern: string }
/** A toolkit rule. The most restrictive matching rule wins, in that toolkit only. */
export interface ToolkitPolicy { pattern: string; action: "approve" | "require_approval" | "block" }
/** One tool Executor knows, with its own default for approval. */
export interface ExecutorTool { address: string; integration: string; connection: string; name: string; description: string | null; requiresApproval: boolean }
export interface ExecutorConnection {
  address: string; integration: string; name: string; identityLabel?: string | null;
  lastHealth?: { status: string; detail?: string | null } | null;
}
export interface ToolkitDetail { slug: string; name: string; connections: string[]; policies: ToolkitPolicy[] }
interface McpToolResult { content?: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: { status?: string; executionId?: string; approvalUrl?: string } }

/** A call Executor paused until a person approves it. */
export interface PausedCall { executionId: string; mcpSessionId: string; approvalUrl: string }
export interface ToolOutput { text: string; paused: PausedCall | null }
/** What the paused call wants to do, as Executor's approval page shows it. */
export interface ApprovalRequest { message: string; address: string; args: unknown }

/** Executor patterns match tool addresses without `tools.`; `*` matches any run of characters. */
export function patternMatches(pattern: string, address: string): boolean {
  const target = address.replace(/^tools\./u, "");
  return new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "u").test(target);
}

/** Health states in which a connection still serves calls. Degraded means only its tool list failed to load. */
const SERVING_HEALTH = new Set(["healthy", "unknown", "degraded"]);

/**
 * Why a connection cannot serve calls, or null when it can. After a refused
 * refresh Executor stops trying for good and marks the connection expired, so
 * a connection that is broken now stays broken until someone reconnects it in
 * Executor. Token expiry alone says nothing: Executor refreshes on demand, so
 * an idle connection's token is often hours past its expiry and still fine.
 */
export function connectionProblem(connection: ExecutorConnection): string | null {
  const health = connection.lastHealth;
  if (!health || SERVING_HEALTH.has(health.status)) return null;
  return health.detail ? `${health.status}: ${health.detail}` : health.status;
}

export class ExecutorError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ExecutorError";
  }
}

/** Executor toolkit slugs are lowercase DNS-style labels. */
export const toolkitSlugPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export function normalizeExecutorUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Use an HTTPS Executor URL");
  }
  return url.origin;
}

function relativeApprovalUrls(text: string, origin: string): string {
  return text.replace(/(^|[\s("'`])(\/resume\/[A-Za-z0-9_%.-]+)/gu, (_match, lead: string, path: string) => `${lead}${origin}${path}`);
}

function pausedCall(result: McpToolResult, origin: string): PausedCall | null {
  const { status, executionId, approvalUrl } = result.structuredContent ?? {};
  if (status !== "user_approval_required" || !executionId || !approvalUrl) return null;
  const url = new URL(approvalUrl, origin);
  const mcpSessionId = url.searchParams.get("mcp_session_id");
  return mcpSessionId ? { executionId, mcpSessionId, approvalUrl: url.href } : null;
}

function capped(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_EXECUTOR_OUTPUT_BYTES) return text;
  throw new ExecutorError(`Executor returned ${bytes} bytes, above the ${MAX_EXECUTOR_OUTPUT_BYTES}-byte limit. Return a narrower result from your code.`);
}

/** Parses a JSON-RPC response that arrived as plain JSON or as an SSE stream. */
export function parseRpcResponse(body: string, contentType: string, id: number): { result?: unknown; error?: { message: string } } {
  if (!contentType.includes("text/event-stream")) return JSON.parse(body) as { result?: unknown };
  for (const event of body.split(/\r?\n\r?\n/u)) {
    const data = event.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    const message = JSON.parse(data) as { id?: number; result?: unknown; error?: { message: string } };
    if (message.id === id) return message;
  }
  throw new ExecutorError("Executor closed the stream without a response");
}

export class ExecutorClient {
  private readonly sessions = new Map<string, Promise<string>>();
  private nextId = 1;

  constructor(private readonly config: ExecutorConfig, private readonly fetcher: typeof fetch = fetch) {}

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetcher(`${this.config.url}/api${path}`, {
      headers: { authorization: `Bearer ${this.config.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) throw new ExecutorError(`Executor GET ${path} returned HTTP ${response.status}: ${text.slice(0, 300)}`, response.status);
    return JSON.parse(text) as T;
  }

  /** Reachability and key check without side effects. */
  async listToolkits(): Promise<Toolkit[]> {
    return (await this.get<{ toolkits: Toolkit[] }>("/toolkits")).toolkits;
  }

  /** The integrations each named toolkit reaches, read from its connection patterns. Unknown slugs are omitted. */
  async toolkitIntegrations(slugs: readonly string[]): Promise<Map<string, string[]>> {
    const toolkits = (await this.listToolkits()).filter((toolkit) => slugs.includes(toolkit.slug));
    const entries = await Promise.all(toolkits.map(async (toolkit) => {
      const { connections } = await this.get<{ connections: ToolkitConnection[] }>(`/toolkits/${toolkit.id}/connections`);
      return [toolkit.slug, [...new Set(connections.map((connection) => connection.pattern.split(".")[0]!))].sort()] as const;
    }));
    return new Map(entries);
  }

  async listConnections(): Promise<ExecutorConnection[]> {
    return this.get("/connections");
  }

  async listTools(): Promise<ExecutorTool[]> {
    return this.get("/tools");
  }

  async listIntegrations(): Promise<Array<{ slug: string; name: string }>> {
    return this.get("/integrations");
  }

  /** One toolkit's rules, in Executor's order. */
  async toolkitPolicies(slug: string): Promise<ToolkitPolicy[]> {
    const toolkit = (await this.listToolkits()).find((candidate) => candidate.slug === slug);
    if (!toolkit) throw new ExecutorError(`Executor has no toolkit named ${slug}`);
    return (await this.get<{ policies: ToolkitPolicy[] }>(`/toolkits/${toolkit.id}/policies`)).policies;
  }

  /** Each toolkit's connection patterns and rules, in Executor's order. */
  async toolkitDetails(): Promise<ToolkitDetail[]> {
    return Promise.all((await this.listToolkits()).map(async (toolkit) => {
      const [{ connections }, { policies }] = await Promise.all([
        this.get<{ connections: ToolkitConnection[] }>(`/toolkits/${toolkit.id}/connections`),
        this.get<{ policies: ToolkitPolicy[] }>(`/toolkits/${toolkit.id}/policies`),
      ]);
      return { slug: toolkit.slug, name: toolkit.name, connections: connections.map((connection) => connection.pattern), policies: policies.map(({ pattern, action }) => ({ pattern, action })) };
    }));
  }

  private endpoint(slug: string): string {
    // Browser elicitation keeps approvals with a person: a gated call returns
    // an approval link, and `resume` only waits for that decision. This plugin
    // asks in the thread and records the answer through the same approval API
    // the link's page uses. The default `model` mode would let the agent
    // approve its own call, and `native` cannot work here: self-hosted
    // Executor answers MCP POSTs as plain JSON, so it has no stream to send
    // an elicitation request on in the middle of a call.
    return `${this.config.url}/mcp/toolkits/${encodeURIComponent(slug)}?elicitation_mode=browser&artifacts=false`;
  }

  private async post(slug: string, message: Record<string, unknown>, sessionId: string | null, signal?: AbortSignal) {
    const response = await this.fetcher(this.endpoint(slug), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL_VERSION } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]) : AbortSignal.timeout(10 * 60_000),
    });
    return { response, body: await response.text() };
  }

  private session(slug: string, signal?: AbortSignal): Promise<string> {
    const cached = this.sessions.get(slug);
    if (cached) return cached;
    const opened = (async () => {
      const id = this.nextId++;
      const { response, body } = await this.post(slug, {
        id, method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "bb-catalog", version: "0.1.0" } },
      }, null, signal);
      if (!response.ok) throw new ExecutorError(`Executor rejected the MCP session (HTTP ${response.status}): ${body.slice(0, 300)}`, response.status);
      const sessionId = response.headers.get("mcp-session-id");
      if (!sessionId) throw new ExecutorError("Executor did not return an MCP session ID");
      await this.post(slug, { method: "notifications/initialized" }, sessionId, signal);
      return sessionId;
    })();
    this.sessions.set(slug, opened);
    opened.catch(() => this.sessions.delete(slug));
    return opened;
  }

  /** Reads a paused call. The approval API takes the key as `x-api-key`, not as a Bearer token. */
  async approvalRequest(paused: PausedCall): Promise<ApprovalRequest> {
    const body = await this.approvalApi(paused, "GET") as { structured?: { interaction?: Partial<ApprovalRequest> } };
    const interaction = body.structured?.interaction;
    if (typeof interaction?.address !== "string") throw new ExecutorError(`Execution ${paused.executionId} is not waiting for approval`);
    return { message: interaction.message ?? "", address: interaction.address, args: interaction.args ?? null };
  }

  /** Records the person's decision, the same way Executor's approval page does. */
  async decide(paused: PausedCall, action: "accept" | "decline"): Promise<void> {
    await this.approvalApi(paused, "POST", action === "accept" ? { action, content: {} } : { action });
  }

  private async approvalApi(paused: PausedCall, method: "GET" | "POST", body?: unknown): Promise<unknown> {
    const path = `/mcp-sessions/${encodeURIComponent(paused.mcpSessionId)}/executions/${encodeURIComponent(paused.executionId)}${method === "POST" ? "/resume" : ""}`;
    const response = await this.fetcher(`${this.config.url}/api${path}`, {
      method,
      headers: { "x-api-key": this.config.apiKey, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) throw new ExecutorError(`Executor ${method} ${path} returned HTTP ${response.status}: ${text.slice(0, 300)}`, response.status);
    return JSON.parse(text);
  }

  /** Calls one of the toolkit endpoint's own tools and returns its text, plus the approval it waits for, if any. */
  async callTool(slug: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutput> {
    for (let attempt = 0; ; attempt += 1) {
      const sessionId = await this.session(slug, signal);
      const id = this.nextId++;
      const { response, body } = await this.post(slug, { id, method: "tools/call", params: { name, arguments: args } }, sessionId, signal);
      // A restarted Executor forgets its sessions; open a fresh one once.
      if ((response.status === 404 || response.status === 400) && attempt === 0) {
        this.sessions.delete(slug);
        continue;
      }
      if (!response.ok) throw new ExecutorError(`Executor returned HTTP ${response.status}: ${body.slice(0, 300)}`, response.status);
      const message = parseRpcResponse(body, response.headers.get("content-type") ?? "", id);
      if (message.error) throw new ExecutorError(message.error.message);
      const result = message.result as McpToolResult;
      const text = relativeApprovalUrls((result.content ?? []).map((part) => part.text ?? "").join("\n"), this.config.url);
      if (result.isError) throw new ExecutorError(capped(text) || "Executor reported an error");
      return { text: capped(text), paused: pausedCall(result, this.config.url) };
    }
  }
}
