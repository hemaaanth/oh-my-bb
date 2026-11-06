/**
 * This plugin's client for a self-hosted Executor v2 server (https://executor.sh).
 *
 * Executor owns the services. Apps hold the tools and skills, accounts hold the
 * credentials, and a scoped MCP connection decides which apps, accounts and
 * tools a caller reaches. This plugin keeps one OAuth grant per connection and
 * calls that connection's MCP URL. A grant works only at its own connection, so
 * Executor enforces the scope.
 *
 * A personal access token (PAT) reads organization context and inventory for
 * health checks. It never runs code: Executor refuses it at connection URLs.
 */
import { createHash, randomBytes } from "node:crypto";

export const MAX_EXECUTOR_OUTPUT_BYTES = 256 * 1024;
const PROTOCOL_VERSION = "2025-06-18";
const CALL_TIMEOUT_MS = 10 * 60_000;
export const OAUTH_SCOPE = "mcp offline_access";

export class ExecutorError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ExecutorError";
  }
}

/** Executor connection IDs: letters, digits, `_` and `-`, at most 64. */
export const connectionIdPattern = /^[A-Za-z0-9_-]{1,64}$/u;

export function normalizeExecutorUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Use an HTTPS Executor URL");
  }
  return url.origin;
}

/** The MCP URL of one scoped connection. */
export function connectionUrl(origin: string, connection: string): string {
  if (!connectionIdPattern.test(connection)) throw new Error(`Not an Executor connection ID: ${connection}`);
  return `${origin}/mcp?connection=${encodeURIComponent(connection)}`;
}

/** Reads `<origin>/mcp?connection=<id>`, or a bare ID with the configured origin. */
export function parseConnectionRef(value: string, origin: string | null): { origin: string; connection: string } {
  const trimmed = value.trim();
  if (connectionIdPattern.test(trimmed)) {
    if (!origin) throw new Error("Configure the Executor URL first, or pass the full connection URL.");
    return { origin, connection: trimmed };
  }
  const url = new URL(trimmed);
  const connection = url.searchParams.get("connection");
  if (!connection || !connectionIdPattern.test(connection)) throw new Error("Use a connection URL like https://executor.example/mcp?connection=<id>.");
  return { origin: normalizeExecutorUrl(url.origin), connection };
}

export function capped(text: string): string {
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

// ---------------------------------------------------------------------------
// Results

/** The call that waits for a person: what `execute` or `resume` returns when a tool asks first. */
export interface ApprovalRequired {
  requestId: string;
  /** `app.tool`, for example `slack.sendMessage`. */
  address: string;
  app: string;
  tool: string;
  input: unknown;
  account: string | null;
  message: string;
  expiresAt: string | null;
}

/**
 * What one MCP tool call produced. `approval` is set when Executor paused for
 * an approval; `input` when the paused tool asks for form fields, which BB
 * never fills in for the person.
 */
export interface ToolOutput {
  text: string;
  approval: ApprovalRequired | null;
  input: { requestId: string; address: string; message: string } | null;
}

interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }

/** An `input-required` form with no fields is an approval with another name. */
function hasFields(elicitation: Record<string, unknown>): boolean {
  return Object.keys(record(record(elicitation.requestedSchema).properties)).length > 0;
}

/** Reads Executor's model-mode outcome. Exported for tests. */
export function readOutcome(structured: Record<string, unknown> | undefined): Pick<ToolOutput, "approval" | "input"> {
  const value = structured ?? {};
  const elicitation = record(value.elicitation);
  if (value.status === "approval-required" && typeof value.requestId === "string") {
    const invocation = record(value.invocation);
    const accounts = record(invocation.accounts);
    const app = text(invocation.app);
    const tool = text(invocation.tool);
    return {
      approval: {
        requestId: value.requestId, address: `${app}.${tool}`, app, tool,
        input: invocation.input ?? null,
        account: text(accounts.user) || text(accounts.app) || null,
        message: text(elicitation.message), expiresAt: text(value.expiresAt) || null,
      },
      input: null,
    };
  }
  if (value.status === "input-required" && typeof value.requestId === "string") {
    const tool = record(value.tool);
    const address = `${text(tool.app)}.${text(tool.tool)}`;
    if (!hasFields(elicitation)) {
      const accounts = record(tool.accounts);
      return {
        approval: {
          requestId: value.requestId, address, app: text(tool.app), tool: text(tool.tool), input: null,
          account: text(accounts.user) || text(accounts.app) || null,
          message: text(elicitation.message), expiresAt: text(value.expiresAt) || null,
        },
        input: null,
      };
    }
    return { approval: null, input: { requestId: value.requestId, address, message: text(elicitation.message) } };
  }
  return { approval: null, input: null };
}

// ---------------------------------------------------------------------------
// MCP at one connection

/** Returns a current access token for a connection; `refresh` forces a new one. */
export type TokenProvider = (options: { refresh: boolean }) => Promise<string>;

/**
 * One scoped connection's MCP endpoint, called as the grant BB holds for it.
 * Executor runs in model mode here: a gated call returns `approval-required`,
 * and only `resume` continues it. BB asks the person in the thread and calls
 * `resume` itself; agents never get the `resume` tool.
 */
export class McpConnectionClient {
  private session: Promise<string> | null = null;
  private nextId = 1;

  constructor(readonly url: string, private readonly token: TokenProvider, private readonly fetcher: typeof fetch = fetch) {}

  private async post(message: Record<string, unknown>, sessionId: string | null, signal?: AbortSignal, refresh = false) {
    const response = await this.fetcher(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.token({ refresh })}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]) : AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    return { response, body: await response.text() };
  }

  /** A 401 can mean the access token just expired, so refresh once and try again. */
  private async authorized(message: Record<string, unknown>, sessionId: string | null, signal?: AbortSignal) {
    const first = await this.post(message, sessionId, signal);
    if (first.response.status !== 401) return first;
    return this.post(message, sessionId, signal, true);
  }

  private open(signal?: AbortSignal): Promise<string> {
    if (this.session) return this.session;
    const opened = (async () => {
      const id = this.nextId++;
      const { response, body } = await this.authorized({
        id, method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "bb-catalog", version: "0.3.0" } },
      }, null, signal);
      if (!response.ok) throw new ExecutorError(`Executor refused the MCP session (HTTP ${response.status}): ${body.slice(0, 300)}`, response.status);
      const sessionId = response.headers.get("mcp-session-id");
      if (!sessionId) throw new ExecutorError("Executor did not return an MCP session ID");
      await this.post({ method: "notifications/initialized" }, sessionId, signal);
      return sessionId;
    })();
    this.session = opened;
    opened.catch(() => { if (this.session === opened) this.session = null; });
    return opened;
  }

  /** Calls one of the connection's MCP tools: `skills`, `search`, `describe`, `call`, `execute` or `resume`. */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutput & { structured: Record<string, unknown> | undefined }> {
    for (let attempt = 0; ; attempt += 1) {
      const sessionId = await this.open(signal);
      const id = this.nextId++;
      const { response, body } = await this.authorized({ id, method: "tools/call", params: { name, arguments: args } }, sessionId, signal);
      // A restarted Executor forgets its sessions; open a fresh one once.
      if ((response.status === 404 || response.status === 400) && attempt === 0) {
        this.session = null;
        continue;
      }
      if (!response.ok) throw new ExecutorError(`Executor returned HTTP ${response.status}: ${body.slice(0, 300)}`, response.status);
      const message = parseRpcResponse(body, response.headers.get("content-type") ?? "", id);
      if (message.error) throw new ExecutorError(message.error.message);
      const result = message.result as McpToolResult;
      const output = (result.content ?? []).map((part) => part.text ?? "").join("\n");
      if (result.isError) throw new ExecutorError(capped(output) || "Executor reported an error");
      return { text: capped(output), structured: result.structuredContent, ...readOutcome(result.structuredContent) };
    }
  }

  execute(code: string, signal?: AbortSignal) { return this.callTool("execute", { code }, signal); }

  /** Answers a paused request. An approval accept carries no content. */
  resume(requestId: string, action: "accept" | "decline", signal?: AbortSignal) {
    return this.callTool("resume", { requestId, response: { action } }, signal);
  }

  /** Lists the connection's skills, or one app's skills. */
  async listSkills(app?: string, signal?: AbortSignal): Promise<RemoteSkill[]> {
    const { structured } = await this.callTool("skills", app ? { app } : {}, signal);
    return (Array.isArray(structured?.skills) ? structured.skills : []).map(remoteSkill).filter((skill): skill is RemoteSkill => skill !== null);
  }

  /** One skill's file. Without `file`, Executor returns SKILL.md and the file list. */
  async readSkill(skill: Pick<RemoteSkill, "app" | "name" | "version" | "revision">, file?: string, signal?: AbortSignal): Promise<{ content: string; files: string[] }> {
    const { structured } = await this.callTool("skills", file
      ? { app: skill.app, name: skill.name, file, version: skill.version, revision: skill.revision }
      : { app: skill.app, name: skill.name }, signal);
    return {
      content: text(structured?.content),
      files: Array.isArray(structured?.files) ? structured.files.filter((value): value is string => typeof value === "string") : [],
    };
  }
}

/** A skill an app ships, as one connection sees it. */
export interface RemoteSkill { app: string; appName: string; name: string; description: string; version: string; revision: string }

function remoteSkill(value: unknown): RemoteSkill | null {
  const skill = record(value);
  const app = record(skill.app);
  if (typeof skill.name !== "string" || typeof app.slug !== "string") return null;
  return {
    app: app.slug, appName: text(app.name) || app.slug, name: skill.name, description: text(skill.description),
    version: text(skill.version), revision: text(skill.revision),
  };
}

// ---------------------------------------------------------------------------
// OAuth for one connection (Executor is the authorization server)

export interface OAuthClient { clientId: string; redirectUri: string }
export interface Tokens { accessToken: string; refreshToken: string | null; expiresAt: number }
export interface PendingAuthorization { url: string; verifier: string; state: string }

function base64url(bytes: Buffer): string { return bytes.toString("base64url"); }

/** Registers BB as a public OAuth client. Executor allows this without a sign-in. */
export async function registerClient(origin: string, redirectUri: string, fetcher: typeof fetch = fetch): Promise<OAuthClient> {
  const response = await fetcher(`${origin}/api/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "BB", redirect_uris: [redirectUri], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  if (!response.ok) throw new ExecutorError(`Executor refused OAuth client registration (HTTP ${response.status}): ${body.slice(0, 300)}`, response.status);
  const clientId = text(record(JSON.parse(body)).client_id);
  if (!clientId) throw new ExecutorError("Executor did not return an OAuth client ID");
  return { clientId, redirectUri };
}

/** The consent URL for one connection, with a PKCE verifier and a random state. */
export function authorizationUrl(origin: string, client: OAuthClient, resource: string): PendingAuthorization {
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(24));
  const url = new URL(`${origin}/api/auth/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: "code", client_id: client.clientId, redirect_uri: client.redirectUri,
    code_challenge: base64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
    scope: OAUTH_SCOPE, resource, state,
  }).toString();
  return { url: url.href, verifier, state };
}

async function tokenRequest(origin: string, form: Record<string, string>, fetcher: typeof fetch): Promise<Tokens> {
  const response = await fetcher(`${origin}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  if (!response.ok) throw new ExecutorError(`Executor refused the token request (HTTP ${response.status}): ${body.slice(0, 300)}`, response.status);
  const value = record(JSON.parse(body));
  const accessToken = text(value.access_token);
  if (!accessToken) throw new ExecutorError("Executor did not return an access token");
  const expiresIn = typeof value.expires_in === "number" ? value.expires_in : 3_600;
  return { accessToken, refreshToken: text(value.refresh_token) || null, expiresAt: Date.now() + expiresIn * 1_000 };
}

export function exchangeCode(origin: string, client: OAuthClient, code: string, verifier: string, resource: string, fetcher: typeof fetch = fetch): Promise<Tokens> {
  return tokenRequest(origin, {
    grant_type: "authorization_code", client_id: client.clientId, code, code_verifier: verifier,
    redirect_uri: client.redirectUri, resource,
  }, fetcher);
}

/** Executor rotates the refresh token on every refresh; keep the new one. */
export function refreshTokens(origin: string, clientId: string, refreshToken: string, resource: string, fetcher: typeof fetch = fetch): Promise<Tokens> {
  return tokenRequest(origin, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken, resource }, fetcher);
}

// ---------------------------------------------------------------------------
// Organization reads with a PAT

/** One app's latest check of one account. Only `credentials_rejected` and `forbidden` need a person. */
export interface AccountProblem { account: string; label: string; app: string; appName: string; problem: string }

const BROKEN_CHECKS = new Set(["credentials_rejected", "forbidden"]);

export class ExecutorApi {
  private organization: Promise<string> | null = null;

  constructor(readonly url: string, private readonly pat: string, private readonly fetcher: typeof fetch = fetch) {}

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetcher(`${this.url}/api${path}`, {
      headers: { authorization: `Bearer ${this.pat}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    if (!response.ok) throw new ExecutorError(`Executor GET ${path} returned HTTP ${response.status}: ${body.slice(0, 300)}`, response.status);
    return JSON.parse(body) as T;
  }

  /** Reachability and token check without side effects. */
  async context(): Promise<{ organization: string; slug: string; role: string }> {
    const value = record(await this.get("/context"));
    const organization = text(value.organization);
    if (!organization) throw new ExecutorError("Executor did not report an organization for this token");
    return { organization, slug: text(value.slug), role: text(value.role) };
  }

  private org(): Promise<string> {
    this.organization ??= this.context().then((value) => value.organization);
    this.organization.catch(() => { this.organization = null; });
    return this.organization;
  }

  /** Apps and accounts whose latest check says the credentials no longer work. */
  async accountProblems(): Promise<AccountProblem[]> {
    const inventory = record(await this.get(`/organizations/${encodeURIComponent(await this.org())}/inventory`));
    const apps = new Map((Array.isArray(inventory.apps) ? inventory.apps : []).map((app) => [text(record(app).id), record(app)]));
    const problems: AccountProblem[] = [];
    for (const account of Array.isArray(inventory.accounts) ? inventory.accounts : []) {
      const value = record(account);
      for (const entry of Array.isArray(record(value.health).apps) ? record(value.health).apps as unknown[] : []) {
        const health = record(entry);
        const check = record(health.check);
        if (!BROKEN_CHECKS.has(text(check.status))) continue;
        const app = apps.get(text(health.app));
        problems.push({
          account: text(value.id), label: text(value.label) || text(value.id),
          app: text(app?.slug) || text(health.app), appName: text(app?.name) || text(app?.slug) || text(health.app),
          problem: text(check.message) ? `${text(check.status)}: ${text(check.message)}` : text(check.status),
        });
      }
    }
    return problems;
  }
}
