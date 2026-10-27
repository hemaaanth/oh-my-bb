/** A small in-memory Executor for tests: read-only toolkits over REST, one MCP tool server, and the approval API. */
export interface ExecutorCall { url: string; body: unknown; session: string | null }
export interface FakeApproval { address: string; message: string; args: unknown }

/** The result a browser-mode toolkit endpoint returns when a call waits for approval. */
export function pausedResult(executionId: string, mcpSessionId = "s1") {
  const approvalUrl = `/resume/${executionId}?mcp_session_id=${mcpSessionId}`;
  return {
    content: [{ type: "text", text: `Approve at ${approvalUrl} then call resume` }],
    structuredContent: { status: "user_approval_required", executionId, approvalUrl, resumePrompt: "Call resume" },
  };
}

export function fakeExecutor(options: {
  toolkits?: Record<string, string[]>;
  toolResult?: (name: string, args: unknown) => unknown;
  expireFirstSession?: boolean;
  /** Paused executions the approval API knows, by execution ID. */
  approvals?: Record<string, FakeApproval>;
  /** Rules per toolkit slug. */
  policies?: Record<string, Array<{ pattern: string; action: "approve" | "require_approval" | "block" }>>;
  tools?: Array<{ address: string; description?: string; requiresApproval?: boolean }>;
  integrations?: Record<string, string>;
  /** Account labels by connection address, such as `tools.slack.user.goldsky`. */
  accounts?: Record<string, string>;
  /** Health by connection address; read on every request, so a test can change it. */
  connectionState?: Record<string, { lastHealth?: { status: string; detail?: string } }>;
} = {}) {
  const calls: ExecutorCall[] = [];
  const decisions: Array<{ executionId: string; mcpSessionId: string; body: unknown }> = [];
  const toolkits = Object.entries(options.toolkits ?? {}).map(([slug, patterns], index) => ({ id: `tk_${index}`, slug, name: slug, patterns }));
  let sessions = 0;
  let expired = !options.expireFirstSession;
  const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), { ...init, headers: { "content-type": "application/json", ...init.headers } });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    const session = new Headers(init?.headers).get("mcp-session-id");
    calls.push({ url: url.pathname + url.search, body, session });
    if (url.pathname === "/api/toolkits") return json({ toolkits: toolkits.map(({ id, slug, name }) => ({ id, slug, name })) });
    const connections = /^\/api\/toolkits\/([^/]+)\/connections$/u.exec(url.pathname);
    if (connections) return json({ connections: toolkits.find((toolkit) => toolkit.id === connections[1])!.patterns.map((pattern) => ({ pattern })) });
    const policies = /^\/api\/toolkits\/([^/]+)\/policies$/u.exec(url.pathname);
    if (policies) return json({ policies: options.policies?.[toolkits.find((toolkit) => toolkit.id === policies[1])!.slug] ?? [] });
    if (url.pathname === "/api/connections") {
      return json(Object.entries(options.accounts ?? {}).map(([address, identityLabel]) => ({
        address, integration: address.split(".")[1], name: address.split(".")[3], identityLabel, ...options.connectionState?.[address],
      })));
    }
    if (url.pathname === "/api/integrations") return json(Object.entries(options.integrations ?? {}).map(([slug, name]) => ({ slug, name })));
    if (url.pathname === "/api/tools") {
      return json((options.tools ?? []).map(({ address, description, requiresApproval }) => {
        const [, integration, , connection, name] = address.split(".");
        return { address, integration, connection, name, description: description ?? null, requiresApproval: requiresApproval ?? false };
      }));
    }
    const approval = /^\/api\/mcp-sessions\/([^/]+)\/executions\/([^/]+)(\/resume)?$/u.exec(url.pathname);
    if (approval) {
      if (new Headers(init?.headers).get("x-api-key") !== "key") return new Response("unauthorized", { status: 401 });
      const [, mcpSessionId, executionId, resume] = approval as unknown as [string, string, string, string | undefined];
      const interaction = options.approvals?.[executionId];
      if (!interaction) return new Response("execution not found", { status: 404 });
      if (!resume) return json({ text: interaction.message, structured: { status: "waiting_for_interaction", executionId, interaction: { kind: "form", ...interaction, requestedSchema: {} } } });
      decisions.push({ executionId, mcpSessionId, body });
      delete options.approvals![executionId];
      return json({ status: "completed", text: "ok", structured: { status: (body as { action: string }).action === "accept" ? "accepted" : "denied" } });
    }
    if (url.pathname.startsWith("/mcp/toolkits/")) {
      if (body!.method === "initialize") {
        sessions += 1;
        return json({ jsonrpc: "2.0", id: body!.id, result: {} }, { headers: { "mcp-session-id": `s${sessions}` } });
      }
      if (body!.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (!expired && session === "s1") {
        expired = true;
        return new Response("session not found", { status: 404 });
      }
      const params = body!.params as { name: string; arguments: unknown };
      const result = options.toolResult?.(params.name, params.arguments) ?? { content: [{ type: "text", text: `ran ${params.name}` }] };
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body!.id, result })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetcher, calls, decisions };
}
