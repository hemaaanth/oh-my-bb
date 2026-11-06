import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { BbPluginApi, ExperimentalPluginRpcHandlerContext, PluginCliResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  ExecutorApi, ExecutorError, McpConnectionClient, authorizationUrl, connectionIdPattern, connectionUrl, exchangeCode,
  normalizeExecutorUrl, parseConnectionRef, refreshTokens, registerClient,
  type ApprovalRequired, type OAuthClient, type RemoteSkill, type ToolOutput,
} from "./executor.js";
import { harnessCatalog, materializeSkills } from "./materialize.js";
import { pluginCallerSchema, preferencesSchema, rpcContract, type NativeCapabilityInput } from "./contract.js";
import { CatalogStore, migrations, type ApprovedSkill, type Grant, type PluginExecutorCall, type StoredFile } from "./store.js";

const okSchema = z.object({ ok: z.literal(true) });
/** One checkout on one machine: a project source or a bb worktree. */
interface Workspace { hostId: string; path: string; projectId: string }
interface ThreadContext { threadId: string; projectId: string; signal: AbortSignal }
/** A skill as one connection sees it. */
interface FoundSkill { connection: string; remote: RemoteSkill }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function skillId(skill: Pick<RemoteSkill, "app" | "name">): string {
  return `${skill.app}/${skill.name}`;
}

function nativeCapabilityDto(capability: NativeCapabilityInput) {
  return {
    kind: "native" as const,
    id: `native:${capability.id}`,
    name: capability.name,
    description: capability.description,
    pluginId: capability.pluginId,
    toolIds: capability.toolIds,
    skillIds: capability.skillIds,
    setup: capability.setup,
  };
}

function resultError(error: unknown): PluginCliResult {
  return { exitCode: 1, stderr: `${message(error)}\n` };
}

function cliOption(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

/** Reads one variable from a dotenv handoff file without echoing the others. */
function dotenvValue(source: string, name: string): string | undefined {
  for (const line of source.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (match?.[1] !== name) continue;
    const raw = match[2]!.trim();
    return /^(["']).*\1$/u.test(raw) ? raw.slice(1, -1) : raw;
  }
  return undefined;
}

function requirePluginCaller(caller: string, context: ExperimentalPluginRpcHandlerContext) {
  if (context?.experimental_caller?.kind !== "plugin" || context.experimental_caller.pluginId !== caller) {
    throw new Error("Executor requires a verified plugin caller matching caller.");
  }
}

function requireCatalogClient(context: ExperimentalPluginRpcHandlerContext) {
  if (context?.experimental_caller?.kind !== "client") throw new Error("Use the BB client for Executor settings and connection configuration.");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
}

function callbackPage(status: number, title: string, body: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head>`
    + `<body style="font-family:system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;line-height:1.5">`
    + `<h1 style="font-size:20px">${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

/**
 * Scope → Executor connection IDs. The `*` key holds connections every project
 * gets, and `agent:<profile-id>` keys hold connections for every thread an
 * Agents profile runs. `plugin:<plugin-id>` keys hold connections another
 * plugin's backend reaches through `executorCall`; `*` does not apply to them.
 * The key keeps its old name: connection IDs equal the old toolkit slugs.
 */
const toolkitMapSchema = z.record(z.string(), z.array(z.string().regex(connectionIdPattern)));
const TOOLKIT_MAP_KEY = "executor-toolkits";
const connectionAlertsSchema = z.record(z.string(), z.object({ name: z.string().optional(), problem: z.string(), since: z.number() }));
const CONNECTION_ALERTS_KEY = "executor-connection-alerts";
const SKILLS_DIGEST_KEY = "executor-skills-digest";
const oauthClientSchema = z.object({ clientId: z.string(), redirectUri: z.string() });
/** Must match CONNECTIONS_CHANGED in app.tsx. */
const CONNECTIONS_CHANGED = "executor-connections-changed";
const GLOBAL_TOOLKITS = "*";
const AGENT_TOOLKITS = "agent:";
const PLUGIN_TOOLKITS = "plugin:";
const MAX_PLUGIN_CALLS_PER_MINUTE = 30;
const PLUGIN_CALL_TIMEOUT_MS = 3 * 60_000;
/** How long a plugin's paused write can wait for a person's answer. */
const PLUGIN_PAUSE_TTL_MS = 60 * 60_000;
const threadAgentSchema = z.object({ profileId: z.string().uuid().nullable(), bound: z.boolean() });
const agentProfilesSchema = z.array(z.object({ id: z.string().uuid(), slug: z.string() }));
const bundleProjectionSchema = z.object({
  globalBundleIds: z.array(z.string()),
  projects: z.array(z.object({ projectId: z.string(), bundleIds: z.array(z.string()) })),
});
type ThreadAgent = z.infer<typeof threadAgentSchema>;
type BundleProjection = z.infer<typeof bundleProjectionSchema>;
/** Must match APPROVAL_RENDERER_ID in app.tsx. */
const APPROVAL_RENDERER_ID = "executor-approval";
/** One Executor call can pause more than once, e.g. code that makes two gated calls. */
const MAX_APPROVALS_PER_CALL = 10;
const MAX_APPROVAL_ARGS_CHARS = 8_000;
/** Codex gives up on a tool after about 60 s, so a queued approval opens its own card well before. */
const APPROVAL_QUEUE_WAIT_MS = 30_000;
const APPROVALS_CHANGED = "executor-approvals-changed";
const MAX_ALLOWED_THREADS = 1_000;
/** Executor keeps a paused program until it restarts or the request expires. */
const PENDING_RESUME_TTL_MS = 60 * 60_000;
const SIGN_IN_TTL_MS = 15 * 60_000;
const MAX_PENDING_SIGN_INS = 100;
/** Refresh an access token when less than this is left. */
const TOKEN_MARGIN_MS = 60_000;
const SKILLS_TTL_MS = 10 * 60_000;
const MAX_SKILL_FILES = 200;
const MAX_CACHED_SKILLS = 500;
const CALLBACK_ROUTE = "/oauth/callback";
const CALLBACK_PATH = `/api/v1/plugins/catalog/http${CALLBACK_ROUTE}`;
/** The Executor app's own skills are docs for executor_docs, not skills to project. */
const EXECUTOR_APP = "executor";

interface QueuedApproval { id: string; address: string; name: string; summary: string; open: boolean; decision: "accept" | "decline" | null; stop: AbortController }
interface ApprovalQueue { entries: QueuedApproval[]; changed: Promise<void>; wake: () => void }

/** The card submits `{ approved, scope }`; `scope` widens an approval to this tool in the thread, or to every waiting call. */
function approvalAnswer(value: unknown): { approved: boolean; scope: "once" | "thread" | "all" } {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as { approved?: unknown; scope?: unknown } : {};
  const scope = record.scope === "thread" || record.scope === "all" ? record.scope : "once";
  return { approved: record.approved === true, scope };
}

function safeSkillPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error("Use a path inside the skill package");
  return normalized;
}

function shownArgs(value: unknown): string {
  const shown = value == null ? "" : JSON.stringify(value, null, 2) ?? "";
  return shown.length > MAX_APPROVAL_ARGS_CHARS ? `${shown.slice(0, MAX_APPROVAL_ARGS_CHARS)}\n… (truncated)` : shown;
}

/** `fetch` read at call time, so tests can replace the global. */
const globalFetch: typeof fetch = (input, init) => fetch(input, init);

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  db.pragma("foreign_keys = ON");
  const store = new CatalogStore(db);
  const bundleCache = new Map<string, string[]>();
  const sandboxSkills = new Map(await Promise.all((await bb.storage.kv.list("sandbox-skills:")).map(async (key) => [key.slice("sandbox-skills:".length), z.array(z.string()).parse(await bb.storage.kv.get(key))] as const)));
  async function threadHost(threadId?: string) {
    if (!threadId || sandboxSkills.size === 0) return undefined;
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return undefined;
    return (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId;
  }
  function nativeCapabilitiesForBundleIds(bundleIds: readonly string[]) {
    const wanted = new Set(bundleIds);
    return store.listBundles()
      .filter((bundle) => wanted.has(bundle.id) && bundle.nativeCapability)
      .map((bundle) => bundle.nativeCapability!);
  }

  // Executor owns apps, accounts, tools, approval rules and skills. This plugin
  // records which connection each scope uses, holds one OAuth grant per
  // connection, and carries calls from the BB server so sandboxes never hold a token.
  const executorSettings = bb.settings.define({
    executorUrl: {
      type: "string",
      label: "Executor URL",
      description: "Your Executor server, for example https://executor.example. Sign in to each connection from Settings or with bb catalog executor connect.",
      default: "",
    },
    executorApiKey: {
      type: "string",
      label: "Executor personal access token",
      description: "Optional. Reads account health for connection alerts. It never runs code.",
      secret: true,
    },
  });
  let executor: { url: string; api: ExecutorApi | null } | null = null;
  let toolkitMap = toolkitMapSchema.parse(await bb.storage.kv.get(TOOLKIT_MAP_KEY) ?? {});
  let preferences = preferencesSchema.parse(await bb.storage.kv.get("preferences") ?? {
    agentsIntegration: Object.keys(toolkitMap).some((key) => key.startsWith(AGENT_TOOLKITS)),
  });
  let preferenceWrites: Promise<unknown> = Promise.resolve();
  let toolkitWrites: Promise<unknown> = Promise.resolve();

  /** A thread's connections: its agent's, then its project's, then the global ones. The first is the default. */
  function threadToolkits(projectId: string, profileId: string | null): string[] {
    const agent = preferences.agentsIntegration && profileId ? toolkitMap[AGENT_TOOLKITS + profileId] ?? [] : [];
    return [...new Set([...agent, ...(toolkitMap[projectId] ?? []), ...(toolkitMap[GLOBAL_TOOLKITS] ?? [])])];
  }
  /** Every connection a thread can reach in some scope. Plugin scopes are separate. */
  function threadConnections(): string[] {
    return [...new Set(Object.entries(toolkitMap).filter(([key]) => !key.startsWith(PLUGIN_TOOLKITS)).flatMap(([, ids]) => ids))];
  }
  /** Which Agents profile each thread runs as. Only `configure` reads this cache, because it cannot wait. */
  const threadAgents = new Map<string, ThreadAgent>();
  async function threadAgent(threadId: string): Promise<ThreadAgent> {
    if (!preferences.agentsIntegration) return { profileId: null, bound: false };
    const agent = await bb.sdk.plugins.callRpc({
      pluginId: "agent-profiles", method: "catalogContextForThread", input: { threadId }, outputSchema: threadAgentSchema,
    }).catch(() => ({ profileId: null, bound: false }));
    threadAgents.delete(threadId);
    threadAgents.set(threadId, agent);
    if (threadAgents.size > 5_000) threadAgents.delete(threadAgents.keys().next().value!);
    return agent;
  }
  /** Agents binds a spawned thread just after bb creates it, so give the binding a moment to land. */
  async function warmThreadAgent(thread: { id: string; originPluginId: string | null }) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if ((await threadAgent(thread.id)).bound || thread.originPluginId !== "agent-profiles") return;
      await delay(200);
    }
  }
  async function agentProfiles() {
    if (!preferences.agentsIntegration) return [];
    return bb.sdk.plugins.callRpc({ pluginId: "agent-profiles", method: "listProfiles", input: null, outputSchema: agentProfilesSchema });
  }
  // Queue target lookups too: an earlier slow lookup must not outlive a later clear.
  function queueToolkitWrite<T>(write: () => Promise<T>) {
    const save = toolkitWrites.then(write);
    toolkitWrites = save.catch(() => undefined);
    return save;
  }
  async function saveExecutorToolkits(key: string, ids: string[], expected?: string[]) {
    if (ids.length && expected && JSON.stringify(toolkitMap[key] ?? []) !== JSON.stringify(expected)) throw new Error("This connection mapping changed. Reopen it and review the current choices before saving.");
    const bad = ids.find((id) => !connectionIdPattern.test(id));
    if (bad) throw new Error(`Not an Executor connection ID: ${bad}`);
    const next = { ...toolkitMap };
    if (ids.length) next[key] = [...new Set(ids)];
    else delete next[key];
    await bb.storage.kv.set(TOOLKIT_MAP_KEY, next);
    toolkitMap = next;
    publish("toolkits-changed");
  }
  function executorConfiguration() {
    return { configured: executor !== null, url: executor?.url ?? null,
      mappings: Object.entries(toolkitMap).map(([key, toolkits]) => ({
        scope: key === GLOBAL_TOOLKITS ? "global" as const : key.startsWith(AGENT_TOOLKITS) ? "agent" as const : key.startsWith(PLUGIN_TOOLKITS) ? "plugin" as const : "project" as const,
        targetId: key.startsWith(AGENT_TOOLKITS) ? key.slice(AGENT_TOOLKITS.length) : key.startsWith(PLUGIN_TOOLKITS) ? key.slice(PLUGIN_TOOLKITS.length) : key,
        toolkits,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Grants: one OAuth grant per connection, refreshed by BB.

  const grants = new Map(store.grants().map((grant) => [grant.connection, grant]));
  const refreshing = new Map<string, Promise<Grant>>();
  const clients = new Map<string, McpConnectionClient>();

  function signInAgain(connection: string, reason?: string) {
    return new Error(`BB is not signed in to Executor connection ${connection}${reason ? ` (${reason})` : ""}. Run: bb catalog executor connect ${connection}`);
  }
  /** The grant for a connection at the configured Executor. A grant for another server does not count. */
  function currentGrant(connection: string): Grant | null {
    const grant = grants.get(connection);
    return grant && executor && grant.origin === executor.url ? grant : null;
  }
  function saveGrant(grant: Grant) {
    store.saveGrant(grant);
    grants.set(grant.connection, grant);
  }
  function forgetGrant(connection: string) {
    store.deleteGrant(connection);
    grants.delete(connection);
    clients.delete(connection);
    skillIndexes.delete(connection);
  }
  /** One refresh at a time per connection: Executor rotates the refresh token on each one. */
  function refreshGrant(connection: string, stale: Grant): Promise<Grant> {
    const running = refreshing.get(connection);
    if (running) return running;
    const next = (async () => {
      const latest = grants.get(connection) ?? stale;
      if (latest.accessToken !== stale.accessToken && latest.expiresAt - Date.now() > TOKEN_MARGIN_MS) return latest;
      if (!latest.refreshToken) throw signInAgain(connection, "the grant has no refresh token");
      try {
        const tokens = await refreshTokens(latest.origin, latest.clientId, latest.refreshToken, connectionUrl(latest.origin, connection), globalFetch);
        const refreshed = { ...latest, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? latest.refreshToken, expiresAt: tokens.expiresAt };
        saveGrant(refreshed);
        return refreshed;
      } catch (error) {
        if (error instanceof ExecutorError && error.status !== undefined && error.status >= 400 && error.status < 500) {
          bb.log.warn(`Executor refused to refresh the grant for connection ${connection}.`);
          throw signInAgain(connection, "Executor refused the refresh");
        }
        throw error;
      }
    })().finally(() => refreshing.delete(connection));
    refreshing.set(connection, next);
    return next;
  }
  function clientFor(connection: string): McpConnectionClient {
    if (!executor) throw new Error("Executor is not configured. Run: bb catalog executor configure --url <url>");
    const cached = clients.get(connection);
    if (cached) return cached;
    const client = new McpConnectionClient(connectionUrl(executor.url, connection), async ({ refresh }) => {
      const grant = currentGrant(connection);
      if (!grant) throw signInAgain(connection);
      if (!refresh && grant.expiresAt - Date.now() > TOKEN_MARGIN_MS) return grant.accessToken;
      return (await refreshGrant(connection, grant)).accessToken;
    }, globalFetch);
    clients.set(connection, client);
    return client;
  }

  // Sign-ins. Executor is the authorization server; BB is a public client.
  const pendingSignIns = new Map<string, { origin: string; connection: string; client: OAuthClient; verifier: string; expires: number }>();
  async function oauthClient(origin: string, redirectUri: string): Promise<OAuthClient> {
    const key = `oauth-client:${origin} ${redirectUri}`;
    const saved = oauthClientSchema.safeParse(await bb.storage.kv.get(key));
    if (saved.success) return saved.data;
    const client = await registerClient(origin, redirectUri, globalFetch);
    await bb.storage.kv.set(key, client);
    return client;
  }
  async function connectStart(ref: string, redirectOrigin: string): Promise<{ url: string; connection: string; redirectUri: string }> {
    if (!executor) throw new Error("Configure the Executor URL first.");
    const { origin, connection } = parseConnectionRef(ref, executor.url);
    if (origin !== executor.url) throw new Error(`That connection belongs to ${origin}, but Executor is configured at ${executor.url}.`);
    const redirect = new URL(redirectOrigin);
    if (redirect.protocol !== "https:" && redirect.protocol !== "http:") throw new Error("Use an http or https BB address for the sign-in callback.");
    const redirectUri = `${redirect.origin}${CALLBACK_PATH}`;
    const client = await oauthClient(origin, redirectUri);
    const pending = authorizationUrl(origin, client, connectionUrl(origin, connection));
    const now = Date.now();
    for (const [state, entry] of pendingSignIns) if (entry.expires < now) pendingSignIns.delete(state);
    while (pendingSignIns.size >= MAX_PENDING_SIGN_INS) pendingSignIns.delete(pendingSignIns.keys().next().value!);
    pendingSignIns.set(pending.state, { origin, connection, client, verifier: pending.verifier, expires: now + SIGN_IN_TTL_MS });
    return { url: pending.url, connection, redirectUri };
  }
  // A remote BB is reached through its public address, so "local" auth would
  // refuse the browser. The single-use state from connectStart is the check.
  bb.http.route("GET", CALLBACK_ROUTE, async (c) => {
    const params = new URL(c.req.url).searchParams;
    const state = params.get("state") ?? "";
    const pending = pendingSignIns.get(state);
    if (!pending || pending.expires < Date.now()) {
      return callbackPage(400, "Sign-in link expired", "This sign-in link expired or was already used. Start the sign-in again from BB.");
    }
    pendingSignIns.delete(state);
    const denied = params.get("error");
    if (denied) return callbackPage(400, "Executor did not grant access", `${denied}${params.get("error_description") ? `: ${params.get("error_description")}` : ""}`);
    const code = params.get("code");
    if (!code) return callbackPage(400, "Sign-in failed", "Executor returned no authorization code. Start the sign-in again from BB.");
    try {
      const tokens = await exchangeCode(pending.origin, pending.client, code, pending.verifier, connectionUrl(pending.origin, pending.connection), globalFetch);
      saveGrant({
        connection: pending.connection, origin: pending.origin, clientId: pending.client.clientId, redirectUri: pending.client.redirectUri,
        accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt,
      });
      clients.delete(pending.connection);
      skillIndexes.delete(pending.connection);
      bb.log.info(`Signed in to Executor connection ${pending.connection}.`);
      publish("connection-signed-in");
      return callbackPage(200, "Connected", `BB can now use Executor connection ${pending.connection}. You can close this tab.`);
    } catch (error) {
      bb.log.warn(`Could not finish the Executor sign-in for ${pending.connection}: ${message(error)}`);
      return callbackPage(502, "Sign-in failed", `Could not finish the sign-in: ${message(error)}`);
    }
  }, { auth: "none" });

  // ---------------------------------------------------------------------------
  // Account health

  /**
   * Accounts whose credentials stopped working, keyed `<account>:<app>`.
   * The PAT reads Executor's inventory every ten minutes. Each change goes out
   * on CONNECTIONS_CHANGED, and the app shows it as a pop-up.
   */
  const connectionAlerts = connectionAlertsSchema.parse(await bb.storage.kv.get(CONNECTION_ALERTS_KEY) ?? {});
  /** One check at a time, so two runs never record the same change twice. */
  let checking: Promise<void> | null = null;
  /** The last scheduled account check's failure. Settings show it without calling Executor. */
  let checkError: string | null = null;
  function checkConnections(): Promise<void> {
    checking ??= runConnectionCheck()
      .then(() => { checkError = null; }, (error: unknown) => { checkError = `Could not read account health: ${message(error)}`; throw error; })
      .finally(() => { checking = null; });
    return checking;
  }
  async function runConnectionCheck() {
    if (!executor?.api) return;
    const now = Date.now();
    const problems = await executor.api.accountProblems();
    const current = new Map(problems.map((problem) => [`${problem.account}:${problem.app}`, problem]));
    let changed = false;
    const recovered: { address: string; name: string; removed: boolean }[] = [];
    for (const [key, problem] of current) {
      const known = connectionAlerts[key];
      if (known?.problem === problem.problem) continue;
      const name = `${problem.appName} (${problem.label})`;
      connectionAlerts[key] = { name, problem: problem.problem, since: known?.since ?? now };
      bb.log.warn(`Executor account ${name} needs attention: ${problem.problem}`);
      changed = true;
    }
    for (const [key, entry] of Object.entries(connectionAlerts)) {
      if (current.has(key)) continue;
      const name = entry.name ?? key;
      recovered.push({ address: key, name, removed: false });
      bb.log.info(`Executor account ${name} works again.`);
      delete connectionAlerts[key];
      changed = true;
    }
    if (!changed) return;
    await bb.storage.kv.set(CONNECTION_ALERTS_KEY, connectionAlerts);
    bb.realtime.publish(CONNECTIONS_CHANGED, { recovered });
  }
  /** Broken accounts for the app's pop-ups. Reads the last check, so it is cheap on every app load. */
  function executorConnections() {
    return {
      url: executor?.url ?? null,
      broken: executor ? Object.entries(connectionAlerts).map(([address, entry]) => ({ address, name: entry.name ?? address, problem: entry.problem, since: entry.since })) : [],
    };
  }
  async function loadExecutor() {
    const values = await executorSettings.get();
    const url = values.executorUrl.trim() ? normalizeExecutorUrl(values.executorUrl) : "";
    const pat = (values.executorApiKey ?? "").trim();
    executor = url ? { url, api: pat ? new ExecutorApi(url, pat, globalFetch) : null } : null;
    clients.clear();
    skillIndexes.clear();
  }
  executorSettings.onChange(() => {
    void loadExecutor().catch((error) => bb.log.warn(`Invalid Executor settings: ${message(error)}`));
  });

  // ---------------------------------------------------------------------------
  // Skills. Executor apps ship them; BB projects them into skill roots.

  const skillIndexes = new Map<string, { at: number; skills: RemoteSkill[] }>();
  const skillFiles = new Map<string, ApprovedSkill>();
  await loadExecutor().catch((error) => bb.log.warn(`Invalid Executor settings: ${message(error)}`));

  /** One connection's skills, cached for ten minutes. A failed read keeps the last good list. */
  async function connectionSkills(connection: string, force = false): Promise<RemoteSkill[]> {
    const cached = skillIndexes.get(connection);
    if (!force && cached && Date.now() - cached.at < SKILLS_TTL_MS) return cached.skills;
    try {
      const skills = (await clientFor(connection).listSkills()).filter((skill) => skill.app !== EXECUTOR_APP);
      skillIndexes.set(connection, { at: Date.now(), skills });
      return skills;
    } catch (error) {
      if (!cached) throw error;
      bb.log.warn(`Could not refresh skills for Executor connection ${connection}; using the last list: ${message(error)}`);
      skillIndexes.set(connection, { ...cached, at: Date.now() });
      return cached.skills;
    }
  }
  /**
   * The skills of some connections, first connection first. `strict` throws
   * when any connection cannot be read, so a projection never removes skills
   * because Executor was briefly down. Only a mapping change removes them.
   */
  async function skillsOf(connections: readonly string[], strict: boolean): Promise<{ skills: FoundSkill[]; errors: string[] }> {
    const found = new Map<string, FoundSkill>();
    const errors: string[] = [];
    for (const connection of connections) {
      try {
        for (const remote of await connectionSkills(connection)) {
          if (!found.has(skillId(remote))) found.set(skillId(remote), { connection, remote });
        }
      } catch (error) {
        if (strict) throw new Error(`Could not read skills for Executor connection ${connection}: ${message(error)}`);
        errors.push(`${connection}: ${message(error)}`);
      }
    }
    return { skills: [...found.values()], errors };
  }
  /** Skill IDs from the cache only, for `configure`, which cannot wait. */
  function cachedSkillIds(connections: readonly string[]): Set<string> {
    return new Set(connections.flatMap((connection) => (skillIndexes.get(connection)?.skills ?? []).map(skillId)));
  }
  /** A skill with all its files. Files are cached per revision. */
  async function fullSkill({ connection, remote }: FoundSkill): Promise<ApprovedSkill> {
    const key = `${skillId(remote)}@${remote.revision}`;
    const cached = skillFiles.get(key);
    if (cached) return cached;
    const client = clientFor(connection);
    const main = await client.readSkill(remote);
    const files: StoredFile[] = [{ path: "SKILL.md", content: main.content, contentEncoding: "utf8" }];
    const extra = main.files.map(safeSkillPath).filter((path) => path !== "SKILL.md");
    if (extra.length + 1 > MAX_SKILL_FILES) throw new Error(`Skill ${skillId(remote)} has more than ${MAX_SKILL_FILES} files.`);
    for (const path of extra) files.push({ path, content: (await client.readSkill(remote, path)).content, contentEncoding: "utf8" });
    const id = skillId(remote);
    const skill: ApprovedSkill = {
      id, skillId: id, sourceId: remote.app, sourceName: remote.appName, name: remote.name, description: remote.description,
      relativePath: id, revision: remote.revision,
      digest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
      enabled: true, files,
    };
    skillFiles.set(key, skill);
    if (skillFiles.size > MAX_CACHED_SKILLS) skillFiles.delete(skillFiles.keys().next().value!);
    return skill;
  }
  async function fullSkills(found: readonly FoundSkill[]): Promise<ApprovedSkill[]> {
    const skills: ApprovedSkill[] = [];
    for (const entry of found) skills.push(await fullSkill(entry));
    return skills;
  }
  function skillDto({ remote }: FoundSkill) {
    const id = skillId(remote);
    return {
      id, sourceId: remote.app, sourceName: remote.appName, name: remote.name, description: remote.description,
      relativePath: id, revision: remote.revision, fileCount: skillFiles.get(`${id}@${remote.revision}`)?.files.length ?? 0,
      digest: remote.revision, enabled: true,
    };
  }
  /** A sandbox's chosen skills, or undefined when it follows its connections. */
  async function selectedSkills(hostId: string): Promise<FoundSkill[] | undefined> {
    const ids = sandboxSkills.get(hostId);
    if (ids === undefined) return undefined;
    const wanted = new Set(ids);
    return (await skillsOf(threadConnections(), true)).skills.filter((entry) => wanted.has(skillId(entry.remote)));
  }
  /**
   * Rereads every connection's skills. When a revision changed since the last
   * run, even across restarts, it projects again.
   */
  async function refreshSkills(reason: string) {
    const connections = threadConnections().filter((connection) => currentGrant(connection));
    for (const connection of connections) await connectionSkills(connection, true).catch((error) => bb.log.warn(`Could not read skills for Executor connection ${connection}: ${message(error)}`));
    const digest = createHash("sha256").update(JSON.stringify(connections.map((connection) =>
      [connection, (skillIndexes.get(connection)?.skills ?? []).map((skill) => `${skillId(skill)}@${skill.revision}`).sort()]))).digest("hex");
    if (digest === await bb.storage.kv.get(SKILLS_DIGEST_KEY)) return;
    await bb.storage.kv.set(SKILLS_DIGEST_KEY, digest);
    publish(reason);
  }

  // ---------------------------------------------------------------------------
  // Calls and approvals

  /**
   * Approvals wait in one queue per thread so a burst of calls shows one card
   * at a time. A queued call opens its own card when the one before it is
   * answered, or after APPROVAL_QUEUE_WAIT_MS so a harness that gives up on
   * slow tools still gets an answer. "Approve for this thread" and "Approve
   * all" answer queued calls too, and close any of their cards still open.
   */
  const approvalQueues = new Map<string, ApprovalQueue>();
  const threadAllowed = new Map<string, Set<string>>();
  function approvalQueue(threadId: string): ApprovalQueue {
    let queue = approvalQueues.get(threadId);
    if (!queue) {
      const created: ApprovalQueue = { entries: [], changed: Promise.resolve(), wake: () => {} };
      created.changed = new Promise<void>((resolve) => { created.wake = resolve; });
      approvalQueues.set(threadId, queue = created);
    }
    return queue;
  }
  function approvalsChanged(threadId: string) {
    const queue = approvalQueues.get(threadId);
    if (queue) {
      const wake = queue.wake;
      const next = queue;
      next.changed = new Promise<void>((resolve) => { next.wake = resolve; });
      wake();
      if (!queue.entries.length) approvalQueues.delete(threadId);
    }
    bb.realtime.publish(APPROVALS_CHANGED, { threadId });
  }
  /** Gives queued calls an answer and closes their cards. */
  function answerQueued(threadId: string, entries: readonly QueuedApproval[]) {
    for (const entry of entries) {
      if (entry.decision) continue;
      entry.decision = "accept";
      if (entry.open) entry.stop.abort();
    }
    approvalsChanged(threadId);
  }
  function allowInThread(threadId: string, address: string) {
    const allowed = threadAllowed.get(threadId) ?? new Set<string>();
    threadAllowed.delete(threadId);
    threadAllowed.set(threadId, allowed.add(address));
    if (threadAllowed.size > MAX_ALLOWED_THREADS) threadAllowed.delete(threadAllowed.keys().next().value!);
  }
  /** Waits until no other card in the thread is open, then claims the slot. */
  async function waitForTurn(queue: ApprovalQueue, entry: QueuedApproval, signal: AbortSignal) {
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(); }, APPROVAL_QUEUE_WAIT_MS); });
    const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    try {
      while (!entry.decision && !signal.aborted && !timedOut && queue.entries.some((other) => other.open)) {
        await Promise.race([queue.changed, timeout, aborted]);
      }
      // Claim the slot before yielding, so only one waiting call opens next.
      entry.open = !entry.decision && !signal.aborted;
    } finally {
      clearTimeout(timer);
    }
  }

  /** An accept must still go to the same Executor, as a connection this thread may use. */
  function requireApprovalAccess(client: McpConnectionClient, context: ThreadContext, connection: string) {
    context.signal.throwIfAborted();
    if (clients.get(connection) !== client || !threadToolkits(context.projectId, threadAgents.get(context.threadId)?.profileId ?? null).includes(connection)) {
      throw new Error("Executor connection access changed while approval was pending. Run it again.");
    }
  }

  /**
   * Asks the user in the thread. Only the user can answer the form, so the
   * agent cannot approve its own call. Null when no answer came (timeout,
   * restart, or a busy queue).
   */
  async function askInThread(client: McpConnectionClient, context: ThreadContext, connection: string, approval: ApprovalRequired): Promise<"accept" | "decline" | null> {
    if (threadAllowed.get(context.threadId)?.has(approval.address)) {
      requireApprovalAccess(client, context, connection);
      return "accept";
    }
    const name = approval.address;
    const queue = approvalQueue(context.threadId);
    const entry: QueuedApproval = {
      id: randomUUID(), address: approval.address, name, summary: `${approval.app}: ${approval.tool}`,
      open: false, decision: null, stop: new AbortController(),
    };
    queue.entries.push(entry);
    approvalsChanged(context.threadId);
    try {
      await waitForTurn(queue, entry, context.signal);
      if (!entry.decision) {
        if (!entry.open) return null;
        const result = await bb.ui.requestInput({
          threadId: context.threadId,
          rendererId: APPROVAL_RENDERER_ID,
          title: `Approve ${name}`.slice(0, 200),
          payload: {
            approvalId: entry.id, toolkit: connection, address: approval.address, integration: approval.app, account: approval.account,
            tool: approval.tool, description: null, reason: "Executor asks before this call.", message: approval.message,
            args: shownArgs(approval.input), approvalUrl: "",
          },
          timeoutMs: 60 * 60 * 1000,
          presentation: { label: { pending: "Waiting for your approval", completed: "Answered Executor approval" }, icon: { glyph: "Workflow" } },
          describeSubmission: (value) => {
            const answer = approvalAnswer(value);
            const verb = answer.approved ? "Approved" : "Declined";
            const scope = answer.scope === "thread" ? " for this thread" : answer.scope === "all" ? " and every waiting call" : "";
            return { title: `${verb} ${name}${scope}`.slice(0, 200) };
          },
        }, { signal: AbortSignal.any([context.signal, entry.stop.signal]) });
        if (result.outcome === "submitted") {
          const answer = approvalAnswer(result.value);
          if (answer.approved) requireApprovalAccess(client, context, connection);
          entry.decision = answer.approved ? "accept" : "decline";
          const others = queue.entries.filter((other) => other !== entry);
          if (answer.approved && answer.scope === "thread") {
            allowInThread(context.threadId, approval.address);
            answerQueued(context.threadId, others.filter((other) => other.address === approval.address));
          }
          if (answer.approved && answer.scope === "all") answerQueued(context.threadId, others);
        } else if (!entry.decision) {
          // Dismissing the form is a decline; any other cancellation is no answer at all.
          if (result.reason !== "user") return null;
          entry.decision = "decline";
        }
      }
      if (entry.decision === "accept") requireApprovalAccess(client, context, connection);
      return entry.decision;
    } finally {
      entry.open = false;
      queue.entries.splice(queue.entries.indexOf(entry), 1);
      approvalsChanged(context.threadId);
    }
  }

  /** Paused agent calls the user has not answered yet, by Executor request ID. */
  const pendingResumes = new Map<string, { threadId: string; connection: string; approval: ApprovalRequired; expires: number }>();
  function rememberPending(threadId: string, connection: string, approval: ApprovalRequired) {
    const now = Date.now();
    for (const [id, entry] of pendingResumes) if (entry.expires < now) pendingResumes.delete(id);
    pendingResumes.set(approval.requestId, { threadId, connection, approval, expires: now + PENDING_RESUME_TTL_MS });
  }
  function waitingText(approval: ApprovalRequired) {
    return `Executor is waiting for approval of ${approval.address}, and no answer came in this thread. Call executor_resume with executionId "${approval.requestId}" to ask the user again.`;
  }

  /** Asks for every approval the call needs, then returns its final output. */
  async function finishCall(client: McpConnectionClient, context: ThreadContext, connection: string, first: ToolOutput): Promise<string> {
    let output = first;
    for (let approvals = 0; output.approval && approvals < MAX_APPROVALS_PER_CALL; approvals += 1) {
      const approval = output.approval;
      rememberPending(context.threadId, connection, approval);
      const decision = await askInThread(client, context, connection, approval);
      if (!decision) return waitingText(approval);
      pendingResumes.delete(approval.requestId);
      output = await client.resume(approval.requestId, decision, context.signal);
    }
    if (output.approval) {
      rememberPending(context.threadId, connection, output.approval);
      return waitingText(output.approval);
    }
    if (output.input) {
      await client.resume(output.input.requestId, "decline", context.signal).catch(() => undefined);
      return `${output.input.address} asked for form input (${output.input.message || "no message"}). BB does not fill in forms for the user, so it declined the request. Pass the values as tool arguments instead.`;
    }
    return output.text;
  }

  async function threadClient(context: ThreadContext, toolkit: string | undefined) {
    if (!executor) throw new Error("Executor is not configured. Run: bb catalog executor configure --url <url>");
    const allowed = threadToolkits(context.projectId, (await threadAgent(context.threadId)).profileId);
    if (!allowed.length) throw new Error("No Executor connections are assigned to this project or agent.");
    const connection = toolkit ?? allowed[0]!;
    if (!allowed.includes(connection)) throw new Error(`Connection ${connection} is not assigned to this project or agent. Use one of: ${allowed.join(", ")}.`);
    return { client: clientFor(connection), connection };
  }

  async function callExecutor(context: ThreadContext, toolkit: string | undefined, run: (client: McpConnectionClient) => Promise<ToolOutput>) {
    const { client, connection } = await threadClient(context, toolkit);
    return finishCall(client, context, connection, await run(client));
  }

  async function resumeInThread(context: ThreadContext, executionId: string) {
    const pending = pendingResumes.get(executionId);
    if (!pending || pending.threadId !== context.threadId || pending.expires < Date.now()) {
      throw new Error("No Executor approval with that ID is waiting in this thread. It may have expired or Executor restarted; run the call again.");
    }
    const { client, connection } = await threadClient(context, pending.connection);
    const decision = await askInThread(client, context, connection, pending.approval);
    if (!decision) return waitingText(pending.approval);
    pendingResumes.delete(executionId);
    return finishCall(client, context, connection, await client.resume(executionId, decision, context.signal));
  }

  // Plugin connection scopes are bound to the SDK's verified caller. Background
  // reads decline at once; paused writes can be displayed and declined.
  // Acceptance is only through the native owner interaction, never this RPC.
  const pluginPaused = new Map<string, { caller: string; toolkit: string; purpose: string; expires: number }>();
  const pluginQueues = new Map<string, Promise<unknown>>();
  const pluginCallTimes = new Map<string, number[]>();
  function pluginClient(caller: string, toolkit: string): McpConnectionClient {
    if (!executor) throw new Error("Executor is not configured. Run: bb catalog executor configure --url <url>");
    const allowed = toolkitMap[PLUGIN_TOOLKITS + caller] ?? [];
    if (!allowed.length) throw new Error(`No Executor connection is mapped to plugin ${caller}. Run: bb catalog executor use <connection> --plugin ${caller}`);
    if (!allowed.includes(toolkit)) throw new Error(`Connection ${toolkit} is not mapped to plugin ${caller}. Use one of: ${allowed.join(", ")}.`);
    return clientFor(toolkit);
  }
  /** One call at a time per plugin, so a slow sync cannot fan out against Executor. */
  function serialized<T>(caller: string, run: () => Promise<T>): Promise<T> {
    const next = (pluginQueues.get(caller) ?? Promise.resolve()).catch(() => undefined).then(run);
    pluginQueues.set(caller, next);
    void next.catch(() => undefined).finally(() => { if (pluginQueues.get(caller) === next) pluginQueues.delete(caller); });
    return next;
  }
  function takeCallSlot(caller: string) {
    const at = Date.now();
    const recent = (pluginCallTimes.get(caller) ?? []).filter((time) => at - time < 60_000);
    if (recent.length >= MAX_PLUGIN_CALLS_PER_MINUTE) throw new Error(`Plugin ${caller} made ${MAX_PLUGIN_CALLS_PER_MINUTE} Executor calls in the last minute. Try again shortly.`);
    recent.push(at);
    pluginCallTimes.set(caller, recent);
  }
  /** Runs one plugin request and writes its audit row, whatever happens. */
  async function auditedPluginCall<T extends { text: string }>(call: Pick<PluginExecutorCall, "caller" | "toolkit" | "mode" | "purpose">, run: (outcome: (value: PluginExecutorCall["outcome"]) => void) => Promise<T>): Promise<T> {
    const started = Date.now();
    let outcome: PluginExecutorCall["outcome"] = "ok";
    let bytesOut = 0;
    let error: string | null = null;
    try {
      const result = await run((value) => { outcome = value; });
      bytesOut = Buffer.byteLength(result.text, "utf8");
      return result;
    } catch (caught) {
      if (outcome === "ok") outcome = "error";
      error = message(caught).slice(0, 500);
      throw caught;
    } finally {
      try { store.recordPluginCall({ ...call, bytesOut, durationMs: Date.now() - started, outcome, error }); }
      catch (caught) { bb.log.warn(`Could not record Executor call from plugin ${call.caller}: ${message(caught)}`); }
    }
  }
  function pluginExecutorCall(input: { caller: string; toolkit: string; code: string; mode: "read" | "write"; purpose: string }, context: ExperimentalPluginRpcHandlerContext) {
    const { caller, toolkit, code, mode, purpose } = input;
    requirePluginCaller(caller, context);
    return serialized(caller, () => auditedPluginCall({ caller, toolkit, mode, purpose }, async (outcome) => {
      const client = pluginClient(caller, toolkit);
      takeCallSlot(caller);
      const output = await client.execute(code, AbortSignal.timeout(PLUGIN_CALL_TIMEOUT_MS));
      if (output.input) {
        outcome("declined");
        await client.resume(output.input.requestId, "decline", AbortSignal.timeout(PLUGIN_CALL_TIMEOUT_MS)).catch(() => undefined);
        throw new Error(`${output.input.address} asked for form input, which plugin calls cannot give, so this plugin declined it.`);
      }
      const approval = output.approval;
      if (!approval) return { text: output.text, paused: null };
      if (mode === "read") {
        outcome("declined");
        await client.resume(approval.requestId, "decline", AbortSignal.timeout(PLUGIN_CALL_TIMEOUT_MS))
          .catch((error: unknown) => bb.log.warn(`Could not decline Executor call ${approval.requestId} for plugin ${caller}: ${message(error)}`));
        throw new Error(`${approval.address} needs approval, and read calls never wait for one, so this plugin declined it. Make writes in mode "write".`);
      }
      outcome("paused");
      const now = Date.now();
      for (const [id, pending] of pluginPaused) if (pending.expires < now) pluginPaused.delete(id);
      pluginPaused.set(approval.requestId, { caller, toolkit, purpose, expires: now + PLUGIN_PAUSE_TTL_MS });
      return {
        text: output.text,
        paused: { executionId: approval.requestId, approvalUrl: "", address: approval.address, message: approval.message, args: shownArgs(approval.input) },
      };
    }));
  }
  function pluginExecutorDecide(input: { caller: string; executionId: string; action: "accept" | "decline" }, context: ExperimentalPluginRpcHandlerContext) {
    const { caller, executionId, action } = input;
    if (context?.experimental_caller?.kind !== "client") requirePluginCaller(caller, context);
    if (action === "accept") throw new Error("Executor acceptance requires a native owner interaction; executorDecide only supports decline.");
    const pending = pluginPaused.get(executionId);
    if (!pending || pending.caller !== caller || pending.expires < Date.now()) {
      return Promise.reject(new Error("No paused Executor call with that ID is waiting for this plugin. It may have expired; run it again."));
    }
    pluginPaused.delete(executionId);
    return serialized(caller, () => auditedPluginCall({ caller, toolkit: pending.toolkit, mode: "write", purpose: `${action}: ${pending.purpose}`.slice(0, 200) }, async (outcome) => {
      const client = pluginClient(caller, pending.toolkit);
      await client.resume(executionId, "decline", AbortSignal.timeout(PLUGIN_CALL_TIMEOUT_MS));
      outcome("declined");
      return { text: "Declined.", paused: null };
    }));
  }

  // ---------------------------------------------------------------------------
  // Native capabilities. Projects owns where they are available; it is optional.

  let lastAssignments: BundleProjection | null = null;
  async function readAssignments(): Promise<BundleProjection> {
    try {
      lastAssignments = await bb.sdk.plugins.callRpc({ pluginId: "projects", method: "bundleAssignmentSnapshot", input: null, outputSchema: bundleProjectionSchema });
    } catch (error) {
      bb.log.warn(`Could not read native capability assignments from Projects: ${message(error)}`);
    }
    return lastAssignments ?? { globalBundleIds: [], projects: [] };
  }
  function bundleIdsFor(projection: BundleProjection, projectId: string) {
    return [...new Set([...projection.globalBundleIds, ...(projection.projects.find((project) => project.projectId === projectId)?.bundleIds ?? [])])];
  }
  async function projectBundleIds(projectId: string): Promise<string[]> {
    const ids = bundleIdsFor(await readAssignments(), projectId);
    bundleCache.set(projectId, ids);
    return ids;
  }
  async function warmBundleCache(projectId?: string | null) {
    if (projectId) {
      await projectBundleIds(projectId);
      return;
    }
    const projection = await readAssignments();
    bundleCache.clear();
    for (const target of await targets()) bundleCache.set(target.id, bundleIdsFor(projection, target.id));
  }
  async function targets() {
    return bb.sdk.projects.list().then((projects) => projects
      .filter((project) => project.kind === "standard")
      .map((project) => ({ kind: "project" as const, id: project.id, name: project.name, detail: project.gitRemoteUrl })));
  }
  async function setCanonicalAssignment(bundleId: string, kind: "global" | "project", targetId: string, enabled: boolean) {
    const write = (method: string, input: Record<string, string | boolean>) => bb.sdk.plugins.callRpc({ pluginId: "projects", method, input, outputSchema: okSchema.strict() })
      .catch((error: unknown) => { throw new Error(`Projects stores native capability assignments, and it refused this change: ${message(error)}`); });
    if (kind === "global") {
      if (targetId !== "*") throw new Error("Global assignments use the * target");
      await write("setGlobalBundle", { targetId: bundleId, enabled });
      await warmBundleCache();
    } else {
      await write("setProjectBundle", { projectId: targetId, targetId: bundleId, enabled });
      await warmBundleCache(targetId);
    }
    const capability = store.nativeCapability(bundleId);
    if (capability?.assignmentChangedRpc) {
      await bb.sdk.plugins.callRpc({ pluginId: capability.pluginId, method: capability.assignmentChangedRpc, input: { bundleId }, outputSchema: okSchema })
        .catch((error) => bb.log.warn(`Could not refresh ${capability.name} assignment state: ${message(error)}`));
    }
    publish("assignment-changed");
  }

  /** Settings read this. It never calls Projects; only the availability dialog needs assignments. */
  async function overview() {
    const [catalog, projectTargets] = await Promise.all([skillsOf(threadConnections(), false), targets()]);
    return {
      skills: catalog.skills.map(skillDto),
      bundles: store.listBundles(),
      targets: projectTargets,
      harnesses: harnessCatalog(),
      skillsError: catalog.errors.length ? catalog.errors.join("; ") : null,
    };
  }

  async function snapshot() {
    const [canonical, data] = await Promise.all([readAssignments(), overview()]);
    return {
      ...data,
      assignments: [
        ...canonical.globalBundleIds.map((bundleId) => ({ bundleId, kind: "global" as const, targetId: "*" })),
        ...canonical.projects.flatMap((project) => project.bundleIds.map((bundleId) => ({ bundleId, kind: "project" as const, targetId: project.projectId }))),
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Projection into skill roots

  /**
   * Shared agent and Claude roots carry the global connections' skills. BB
   * receives the same skills through this plugin's tools, so publishing
   * another copy into its own root would advertise every skill twice to Codex.
   */
  async function projectMachine(hostId: string, homePath: string | null) {
    const config = await bb.sdk.system.config();
    const primary = hostId === config.primaryHostId;
    const home = primary ? homedir() : homePath;
    if (!home) throw new Error("Could not resolve a home directory for that machine");
    const base = primary ? config.dataDir : `${home}/.bb`;
    const found = await selectedSkills(hostId) ?? (await skillsOf(toolkitMap[GLOBAL_TOOLKITS] ?? [], true)).skills;
    return materializeSkills({
      bb, hostId, skills: await fullSkills(found),
      roots: [
        { path: `${base}/skills`, rootPath: base, publish: false },
        { path: `${home}/.agents/skills`, rootPath: home },
        { path: `${home}/.claude/skills`, rootPath: home },
      ],
      manifestRoot: base,
      manifestPath: `${base}/catalog/materializations/${hostId}.json`,
    });
  }

  /**
   * A workspace carries its project connections' skills, minus the global
   * ones the machine roots already hold. A sandbox with chosen skills gets
   * them in its machine roots only.
   */
  async function projectWorkspace(workspace: Workspace) {
    let found: FoundSkill[] = [];
    if (!sandboxSkills.has(workspace.hostId)) {
      const global = cachedSkillIds([]);
      for (const entry of (await skillsOf(toolkitMap[GLOBAL_TOOLKITS] ?? [], true)).skills) global.add(skillId(entry.remote));
      found = (await skillsOf(toolkitMap[workspace.projectId] ?? [], true)).skills.filter((entry) => !global.has(skillId(entry.remote)));
    }
    return materializeSkills({
      bb, hostId: workspace.hostId, keepOutOfGit: true,
      skills: await fullSkills(found),
      roots: [
        { path: `${workspace.path}/.bb/skills`, rootPath: workspace.path, publish: false },
        { path: `${workspace.path}/.agents/skills`, rootPath: workspace.path },
        { path: `${workspace.path}/.claude/skills`, rootPath: workspace.path },
      ],
      manifestRoot: workspace.path,
      manifestPath: `${workspace.path}/.bb/skills/catalog-manifest.json`,
    });
  }

  /**
   * Project checkouts plus every ready worktree bb knows about, on machines that
   * are reachable right now. A sleeping sandbox is projected when it comes back
   * and prepares its environment.
   */
  async function workspaces(): Promise<Workspace[]> {
    const connected = new Set((await bb.sdk.hosts.list()).filter((host) => host.status === "connected").map((host) => host.id));
    const found = new Map<string, Workspace>();
    for (const project of await bb.sdk.projects.list()) {
      if (project.kind !== "standard") continue;
      for (const source of project.sources) {
        if (connected.has(source.hostId)) found.set(`${source.hostId}:${source.path}`, { hostId: source.hostId, path: source.path, projectId: project.id });
      }
    }
    const threads = await bb.sdk.threads.list({ limit: 500 });
    for (const environmentId of new Set(threads.map((thread) => thread.environmentId).filter((id): id is string => id !== null))) {
      const workspace = await readyWorkspace(environmentId);
      if (workspace && connected.has(workspace.hostId)) {
        const key = `${workspace.hostId}:${workspace.path}`;
        // A legacy or manually selected environment can point at a checkout
        // registered to another project. Keep the project source authoritative
        // for that path so an old thread cannot replace its skills.
        if (!found.has(key)) found.set(key, workspace);
      }
    }
    return [...found.values()];
  }

  /** A provisioning worktree has no directory yet, so wait briefly for one. */
  async function readyWorkspace(environmentId: string, attempts = 1): Promise<Workspace | null> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const environment = await bb.sdk.environments.get({ environmentId }).catch(() => null);
      if (environment?.path && environment.status === "ready") {
        return { hostId: environment.hostId, path: environment.path, projectId: environment.projectId };
      }
      if (environment && environment.status !== "provisioning") return null;
      if (attempt + 1 < attempts) await delay(1_000);
    }
    return null;
  }

  interface ProjectionReport {
    machine: { skillCount: number; roots: string[] };
    workspaces: Array<{ path: string; skillCount: number; error: string | null }>;
  }

  /** An unreachable machine or a retired worktree is reported, never fatal. */
  async function projectEverything(reason: string): Promise<ProjectionReport> {
    const config = await bb.sdk.system.config();
    const machine = config.primaryHostId ? await projectMachine(config.primaryHostId, null) : null;
    const report: ProjectionReport = { machine: { skillCount: machine?.skillCount ?? 0, roots: machine?.roots ?? [] }, workspaces: [] };
    for (const workspace of await workspaces()) {
      try {
        const outcome = await projectWorkspace(workspace);
        report.workspaces.push({ path: workspace.path, skillCount: outcome.skillCount, error: null });
      } catch (error) {
        report.workspaces.push({ path: workspace.path, skillCount: 0, error: message(error) });
        bb.log.warn(`Could not project Executor skills into ${workspace.path}: ${message(error)}`);
      }
    }
    const reached = report.workspaces.filter((workspace) => workspace.error === null).length;
    bb.log.info(`projected ${report.machine.skillCount} global skills and ${reached} of ${report.workspaces.length} workspaces (${reason})`);
    return report;
  }

  /** Projections are serialized so overlapping changes cannot interleave writes. */
  let projecting: Promise<unknown> = Promise.resolve();
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = projecting.then(work, work);
    projecting = next.catch(() => undefined);
    return next;
  }
  function queueProjection(reason: string, work: () => Promise<unknown>) {
    void serialize(work).catch((error) => bb.log.warn(`Could not project Executor skills (${reason}): ${message(error)}`));
  }
  function publish(reason: string) {
    bb.realtime.publish("catalog-changed", { reason });
    queueProjection(reason, () => projectEverything(reason));
  }

  async function skillsForTool(context: { projectId: string; threadId: string }): Promise<FoundSkill[]> {
    const hostId = await threadHost(context.threadId);
    if (hostId && sandboxSkills.has(hostId)) return (await selectedSkills(hostId))!;
    const connections = threadToolkits(context.projectId, (await threadAgent(context.threadId)).profileId);
    return (await skillsOf(connections, false)).skills;
  }

  const materialize = (input: { hostId: string; homePath: string; projectId: string | null; workspacePath: string | null }) => serialize(async () => {
    const machine = await projectMachine(input.hostId, input.homePath);
    const workspace = input.projectId && input.workspacePath
      ? await projectWorkspace({ hostId: input.hostId, path: input.workspacePath, projectId: input.projectId })
      : null;
    return {
      ready: machine.ready && (workspace?.ready ?? true),
      digest: machine.digest,
      skillCount: machine.skillCount + (workspace?.skillCount ?? 0),
      roots: [...machine.roots, ...(workspace?.roots ?? [])],
      detail: workspace ? `${machine.detail} ${workspace.detail}` : machine.detail,
    };
  });
  type MaterializationResult = Awaited<ReturnType<typeof materialize>>;
  type MaterializationJob =
    | { state: "running" }
    | { state: "complete"; result: MaterializationResult }
    | { state: "failed"; error: string };
  const materializationJobs = new Map<string, MaterializationJob>();
  const startMaterialize = (input: Parameters<typeof materialize>[0]) => {
    const jobId = randomUUID();
    materializationJobs.set(jobId, { state: "running" });
    void materialize(input).then(
      (result) => materializationJobs.set(jobId, { state: "complete", result }),
      (error) => materializationJobs.set(jobId, { state: "failed", error: message(error) }),
    ).finally(() => {
      const expiry = setTimeout(() => materializationJobs.delete(jobId), 60 * 60_000);
      expiry.unref();
    });
    return { jobId };
  };

  /** Names a connection-map key for people: a project, an agent, a plugin, or every project. Null when its target is gone. */
  async function scopeNamer() {
    const [projects, agents] = await Promise.all([bb.sdk.projects.list(), agentProfiles().catch(() => [])]);
    return (key: string): string | null => {
      if (key === GLOBAL_TOOLKITS) return "every project";
      if (key.startsWith(PLUGIN_TOOLKITS)) return `plugin ${key.slice(PLUGIN_TOOLKITS.length)}`;
      if (key.startsWith(AGENT_TOOLKITS)) {
        const slug = agents.find((agent) => AGENT_TOOLKITS + agent.id === key)?.slug;
        return slug ? `agent @${slug}` : null;
      }
      return projects.find((project) => project.id === key)?.name ?? null;
    };
  }

  /** Every mapped or signed-in connection, whether BB holds a grant, and where it is used. */
  async function executorOverview() {
    if (!executor) return { configured: false, url: null, error: null, connections: [] };
    const url = executor.url;
    const error = checkError;
    const scopeName = await scopeNamer();
    const ids = [...new Set([...Object.values(toolkitMap).flat(), ...[...grants.keys()].filter((id) => currentGrant(id))])].sort();
    return {
      configured: true, url, error,
      connections: ids.map((id) => ({
        id, url: connectionUrl(url, id), connected: currentGrant(id) !== null,
        assignedTo: Object.entries(toolkitMap).filter(([, mapped]) => mapped.includes(id)).map(([key]) => scopeName(key) ?? key),
      })),
    };
  }

  bb.rpc.register(rpcContract, {
    catalogOverview: async (_input, context) => { requireCatalogClient(context); return overview(); },
    preferences: (_input, context) => { requireCatalogClient(context); return preferences; },
    updatePreferences: (input, context) => {
      requireCatalogClient(context);
      const save = preferenceWrites.then(async () => {
        const saved = preferencesSchema.parse({ ...preferences, ...input });
        await bb.storage.kv.set("preferences", saved);
        preferences = saved;
        threadAgents.clear();
        bb.realtime.publish("catalog-changed", { reason: "preferences-changed" });
        return preferences;
      });
      preferenceWrites = save.catch(() => undefined);
      return save;
    },
    executorConfiguration: (_input, context) => { requireCatalogClient(context); return executorConfiguration(); },
    setExecutorToolkits: ({ scope, targetId, toolkits, expectedToolkits }, context) => {
      requireCatalogClient(context);
      return queueToolkitWrite(async () => {
        if (scope === "global" && targetId !== "*") throw new Error("Global connections use the * target.");
        if (toolkits.length && scope === "project" && !(await targets()).some((project) => project.id === targetId)) throw new Error("Choose an existing project.");
        if (scope === "plugin") pluginCallerSchema.parse(targetId);
        if (toolkits.length && scope === "agent" && (!preferences.agentsIntegration || !(await agentProfiles()).some((agent) => agent.id === targetId))) throw new Error("Enable Agents in Executor settings → Oh My BB and choose an existing profile ID.");
        const key = scope === "global" ? GLOBAL_TOOLKITS : scope === "agent" ? AGENT_TOOLKITS + targetId : scope === "plugin" ? PLUGIN_TOOLKITS + targetId : targetId;
        await saveExecutorToolkits(key, toolkits, expectedToolkits);
        return { ok: true as const };
      });
    },
    assignmentStatus: () => ({ state: "uninitialized" as const, transfer: null, destinationRevision: null, conflicts: 0 as const }),
    getSandboxSkills: ({ hostId }) => ({ skillIds: sandboxSkills.get(hostId) ?? null }),
    setSandboxSkills: async ({ hostId, skillIds }) => {
      const available = new Set((await skillsOf(threadConnections(), true)).skills.map((entry) => skillId(entry.remote)));
      if (skillIds.some((id) => !available.has(id))) throw new Error("An unavailable skill was selected.");
      const selected = [...new Set(skillIds)];
      await bb.storage.kv.set(`sandbox-skills:${hostId}`, selected);
      sandboxSkills.set(hostId, selected);
      return { ok: true as const };
    },
    snapshot: async () => {
      const { skillsError: _skillsError, ...data } = await snapshot();
      return data;
    },
    listBundles: () => ({ bundles: store.listBundles() }),
    legacyAssignments: () => ({ assignments: [] }),
    registerNativeCapability: (input) => {
      const { bundle, changed } = store.saveNativeCapability(input);
      if (changed) publish("native-capability-registered");
      return bundle;
    },
    setAssignment: async ({ bundleId, kind, targetId, enabled }) => {
      store.requireBundle(bundleId);
      if (kind !== "global" && kind !== "project") throw new Error("Native capabilities are assigned globally or to projects.");
      await setCanonicalAssignment(bundleId, kind, targetId, enabled);
      return { ok: true as const };
    },
    materialize,
    startMaterialize,
    materializationStatus: ({ jobId }) => materializationJobs.get(jobId) ?? { state: "failed" as const, error: "Materialization job is no longer available" },
    refreshAvailability: async ({ projectId }) => {
      await warmBundleCache(projectId);
      publish("project-availability-changed");
      return { ok: true as const };
    },
    executorToolkits: ({ caller }, context) => {
      requirePluginCaller(caller, context);
      return { configured: executor !== null, toolkits: (toolkitMap[PLUGIN_TOOLKITS + caller] ?? []).map((slug) => ({ slug, integrations: [] })) };
    },
    executorCall: pluginExecutorCall,
    executorDecide: pluginExecutorDecide,
    executorApprovals: ({ threadId }) => ({
      pending: (approvalQueues.get(threadId)?.entries ?? []).filter((entry) => !entry.decision).map(({ id, name, summary, open }) => ({ approvalId: id, name, summary, open })),
    }),
    executorOverview: (_input, context) => { requireCatalogClient(context); return executorOverview(); },
    executorConnections,
    connectStart: async ({ connection, redirectOrigin }, context) => {
      requireCatalogClient(context);
      const { url } = await connectStart(connection, redirectOrigin);
      return { url };
    },
    disconnect: ({ connection }, context) => {
      requireCatalogClient(context);
      forgetGrant(connection);
      publish("connection-signed-out");
      return { ok: true as const };
    },
  });

  bb.agents.registerTool({
    name: "catalog_search",
    description: "Search the skills and native capabilities available in this thread before reading one in full.",
    instructions: "Search returns capability IDs and provenance. Pass an exact returned ID to catalog_read.",
    presentation: { label: { pending: "Searching Executor skills", completed: "Searched Executor skills" }, icon: { glyph: "Search" } },
    parameters: z.object({ query: z.string().trim().max(500).default(""), limit: z.number().int().min(1).max(50).default(20) }).strict(),
    async execute({ query, limit }, context) {
      const needle = query.toLowerCase();
      const skills = (await skillsForTool(context)).map((entry) => ({ kind: "skill" as const, ...skillDto(entry) }));
      const native = nativeCapabilitiesForBundleIds(await projectBundleIds(context.projectId)).map(nativeCapabilityDto);
      const matches = [...native, ...skills].filter((capability) => JSON.stringify(capability).toLowerCase().includes(needle)).slice(0, limit);
      return JSON.stringify({ count: matches.length, capabilities: matches });
    },
  });

  bb.agents.registerTool({
    name: "catalog_read",
    description: "Read a file from one Executor skill available in this thread.",
    presentation: { label: { pending: "Reading Executor skill", completed: "Read Executor skill" }, icon: { glyph: "Explore" } },
    parameters: z.object({ skillId: z.string().min(1), path: z.string().default("SKILL.md") }).strict(),
    async execute({ skillId: wanted, path }, context) {
      if (wanted.startsWith("native:")) {
        const bundleId = wanted.slice("native:".length);
        const capability = nativeCapabilitiesForBundleIds(await projectBundleIds(context.projectId)).find((candidate) => candidate.id === bundleId);
        if (!capability) throw new Error("That native capability is not available in this project");
        return JSON.stringify({ capability: nativeCapabilityDto(capability), provenance: { pluginId: capability.pluginId, managedBy: "catalog" } });
      }
      const entry = (await skillsForTool(context)).find((candidate) => skillId(candidate.remote) === wanted);
      if (!entry) throw new Error("That skill is not available in this thread");
      const skill = await fullSkill(entry);
      const requestedPath = safeSkillPath(path);
      const file = skill.files.find((candidate) => candidate.path === requestedPath);
      if (!file) throw new Error(`Unknown file in ${skill.name}: ${requestedPath}`);
      return JSON.stringify({
        skill: skillDto(entry), path: requestedPath, content: file.content,
        provenance: { app: entry.remote.app, connection: entry.connection, revision: skill.revision },
      });
    },
  });

  const executorPresentation = (pending: string, completed: string) => ({ label: { pending, completed }, icon: { glyph: "Workflow" } });
  const toolkitParameter = z.string().regex(connectionIdPattern).optional()
    .describe("Executor connection to use. Omit for this thread's default; the instructions list the others.");

  bb.agents.registerTool({
    name: "executor_execute",
    description: "Run TypeScript in Executor's sandbox with access to the apps in this thread's Executor connections.",
    instructions: "Call executor_docs with name \"code-mode\" before your first call. One call runs in one connection. Credentials stay in Executor. A call that needs approval asks the user in this thread and returns once they answer. If no answer came, call executor_resume with the returned execution ID.",
    presentation: executorPresentation("Running in Executor", "Ran in Executor"),
    parameters: z.object({ code: z.string().min(1).max(100_000), toolkit: toolkitParameter }).strict(),
    execute: ({ code, toolkit }, context) => callExecutor(context, toolkit, (client) => client.execute(code, context.signal)),
  });

  bb.agents.registerTool({
    name: "executor_docs",
    description: "Read Executor's how-to docs, such as \"code-mode\" for executor_execute, or one app's skills. Omit name to list them.",
    presentation: executorPresentation("Reading Executor docs", "Read Executor docs"),
    parameters: z.object({
      name: z.string().trim().max(100).optional(),
      app: z.string().trim().min(1).max(100).default(EXECUTOR_APP).describe("App whose skills to read. Defaults to Executor's own docs."),
      toolkit: toolkitParameter,
    }).strict(),
    execute: ({ name, app, toolkit }, context) => callExecutor(context, toolkit, (client) =>
      client.callTool("skills", name ? { app, name } : { app }, context.signal)),
  });

  bb.agents.registerTool({
    name: "executor_resume",
    description: "Ask the user again about an Executor call that is still waiting for approval, then continue it. It cannot approve on its own.",
    presentation: executorPresentation("Waiting for Executor approval", "Resumed Executor call"),
    parameters: z.object({ executionId: z.string().min(1).max(200), toolkit: toolkitParameter }).strict(),
    execute: ({ executionId }, context) => resumeInThread(context, executionId),
  });

  bb.agents.configure((context) => {
    const bundleIds = bundleCache.get(context.project.id) ?? [];
    const native = nativeCapabilitiesForBundleIds(bundleIds);
    const agent = threadAgents.get(context.thread.id);
    if (preferences.agentsIntegration && !agent?.bound) void threadAgent(context.thread.id);
    const toolkits = executor ? threadToolkits(context.project.id, agent?.profileId ?? null) : [];
    const selected = sandboxSkills.get(context.host.id);
    const count = native.length + (selected ? selected.length : cachedSkillIds(toolkits).size);
    // Until Agents answers, an agent's own connections are unknown; the tools still check at call time.
    const agentMayHaveToolkits = preferences.agentsIntegration && Boolean(executor) && !agent?.bound && Object.keys(toolkitMap).some((key) => key.startsWith(AGENT_TOOLKITS));
    const described = toolkits.map((id) => currentGrant(id) ? id : `${id} (not signed in)`);
    return {
      tools: ["catalog_search", "catalog_read", ...(toolkits.length || agentMayHaveToolkits ? ["executor_execute", "executor_docs", "executor_resume"] : [])],
      skills: ["catalog"],
      instructions: [
        count
          ? `Executor has ${count} skills and capabilities for this thread. Use catalog_search to find relevant ones and catalog_read to load full instructions.`
          : "Executor is available. Search to discover the skills assigned to this project.",
        toolkits.length
          ? `Executor connections for this thread: ${described.join(", ")}. The default is ${toolkits[0]}. Reach them with executor_execute (TypeScript calling tools.<app>.…), and read executor_docs with name "code-mode" first. Prefer these over locally configured MCP servers for the same service.`
          : agentMayHaveToolkits
            ? "This thread's agent may have Executor connections. Call executor_docs without a connection to use its default; an unassigned connection fails with the list of assigned ones."
            : "",
      ].filter(Boolean).join("\n\n"),
    };
  });

  bb.background.schedule("refresh-executor-skills", "23 * * * *", async () => { await refreshSkills("skills-changed"); });
  bb.background.schedule("check-executor-connections", "*/10 * * * *", async () => {
    await checkConnections().catch((error) => bb.log.warn(`Could not check Executor accounts: ${message(error)}`));
  });

  const executorUsage = "Usage: bb catalog executor <status|configure [--url <url>] [--key-file <dotenv>]|connect <connection-or-url> [--redirect-origin <bb-url>]|disconnect <connection>|use <connection>... (--project <id-or-name>|--agent <@slug-or-id>|--plugin <id>|--global)|use --clear (--project <id-or-name>|--agent <@slug-or-id>|--plugin <id>|--global)|calls [--plugin <id>] [--json]>\n";
  const usage = "Usage: bb catalog <list [--json]|skills [--app <slug>] [--json]|assign <native-capability> [--project <id>]|unassign <native-capability> [--project <id>]|project [--json]|executor ...>\n";

  bb.cli.register({
    name: "catalog",
    summary: "Manage Executor connections, skills, and native capabilities",
    commands: [
      { name: "list", summary: "List connections, skills, and native capabilities", usage: "bb catalog list [--json]" },
      { name: "skills", summary: "List the skills Executor apps ship to your connections", usage: "bb catalog skills [--app <slug>] [--json]" },
      { name: "assign", summary: "Make a native capability available globally or to one project", usage: "bb catalog assign <native-capability> [--project <id>]" },
      { name: "unassign", summary: "Remove a global or project native capability assignment", usage: "bb catalog unassign <native-capability> [--project <id>]" },
      { name: "project", summary: "Rewrite this machine's and every workspace's skill roots", usage: "bb catalog project [--json]" },
      { name: "executor", summary: "Configure Executor, sign in to connections, and choose which connection each scope uses", usage: executorUsage.replace(/^Usage: /u, "").trimEnd() },
    ],
    async run(argv) {
      try {
        if (argv[0] === "list") {
          const [data, overview] = await Promise.all([snapshot(), executorOverview()]);
          if (argv.includes("--json")) return { exitCode: 0, stdout: `${JSON.stringify({ ...data, connections: overview.connections }, null, 2)}\n` };
          const lines = [
            ...overview.connections.map((connection) => `connection\t${connection.id}\t${connection.connected ? "signed in" : "not signed in"}\t${connection.assignedTo.join(", ") || "unassigned"}`),
            ...data.skills.map((skill) => `skill\t${skill.id}\t${skill.revision.slice(0, 12)}`),
            ...data.bundles.filter((bundle) => bundle.nativeCapability).map((bundle) => {
              const count = data.assignments.filter((assignment) => assignment.bundleId === bundle.id).length;
              return `native\t${bundle.name}\t${bundle.nativeCapability!.toolIds.length} tools · ${bundle.nativeCapability!.skillIds.length} skills\t${count} assignments`;
            }),
            ...(data.skillsError ? [`warning\t${data.skillsError}`] : []),
          ];
          return { exitCode: 0, stdout: `${lines.join("\n")}${lines.length ? "\n" : "Nothing configured yet.\n"}` };
        }
        if (argv[0] === "skills") {
          const wanted = cliOption(argv, "--app");
          for (const connection of threadConnections()) await connectionSkills(connection, true).catch(() => undefined);
          const catalog = await skillsOf(threadConnections(), false);
          const skills = catalog.skills.filter((entry) => !wanted || entry.remote.app.toLowerCase() === wanted.toLowerCase());
          if (argv.includes("--json")) return { exitCode: 0, stdout: `${JSON.stringify(skills.map((entry) => ({ ...skillDto(entry), connection: entry.connection })), null, 2)}\n` };
          const lines = [
            ...skills.map((entry) => `${skillId(entry.remote)}\t${entry.connection}\t${entry.remote.description.slice(0, 80)}`),
            ...catalog.errors.map((error) => `warning\t${error}`),
          ];
          return { exitCode: 0, stdout: `${lines.join("\n")}${lines.length ? "\n" : "No skills yet. Add a skills app in Executor and include it in a connection.\n"}` };
        }
        if ((argv[0] === "assign" || argv[0] === "unassign") && argv[1]) {
          const bundle = store.listBundles().find((value) => value.nativeCapability && value.name.toLowerCase() === argv[1]!.toLowerCase());
          if (!bundle) return { exitCode: 1, stderr: `Unknown native capability: ${argv[1]}\n` };
          const targetId = cliOption(argv, "--project") ?? "*";
          const kind = targetId === "*" ? "global" : "project";
          await setCanonicalAssignment(bundle.id, kind, targetId, argv[0] === "assign");
          const scope = kind === "project" ? `project ${targetId}` : "global";
          return { exitCode: 0, stdout: `${bundle.name} ${argv[0] === "assign" ? "assigned to" : "unassigned from"} ${scope}.\n` };
        }
        if (argv[0] === "executor") return await executorCli(argv.slice(1));
        if (argv[0] === "project") {
          const report = await serialize(() => projectEverything("cli"));
          if (argv.includes("--json")) return { exitCode: 0, stdout: `${JSON.stringify(report, null, 2)}\n` };
          const lines = [
            `machine\t${report.machine.skillCount} global skills`,
            ...report.workspaces.map((workspace) => `${workspace.path}\t${workspace.error ?? `${workspace.skillCount} project skills`}`),
          ];
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        }
        return { exitCode: 1, stderr: usage };
      } catch (error) { return resultError(error); }
    },
  });

  async function executorCli(argv: string[]): Promise<PluginCliResult> {
    if (argv[0] === "configure") {
      const keyFile = cliOption(argv, "--key-file");
      const url = cliOption(argv, "--url");
      if (!keyFile && !url) return { exitCode: 1, stderr: executorUsage };
      const source = keyFile ? await readFile(keyFile, "utf8") : "";
      const pat = keyFile ? dotenvValue(source, "EXECUTOR_PAT") ?? dotenvValue(source, "EXECUTOR_API_KEY") : undefined;
      if (keyFile && !pat) return { exitCode: 1, stderr: `${keyFile} has no EXECUTOR_PAT\n` };
      await executorSettings.experimental_set({ ...(url ? { executorUrl: normalizeExecutorUrl(url) } : {}), ...(pat ? { executorApiKey: pat } : {}) });
      await loadExecutor();
      if (!executor) return { exitCode: 1, stderr: "Executor needs a URL.\n" };
      if (!executor.api) return { exitCode: 0, stdout: `Executor URL is ${executor.url}. Add a personal access token with --key-file for account health alerts.\n` };
      const context = await executor.api.context();
      return { exitCode: 0, stdout: `Executor at ${executor.url} accepts the stored token for organization ${context.slug || context.organization}.${keyFile ? ` You can delete ${keyFile}.` : ""}\n` };
    }
    if (argv[0] === "connect" && argv[1]) {
      const config = await bb.sdk.system.config();
      const redirectOrigin = cliOption(argv, "--redirect-origin") ?? config.serverAccess.effectiveUrl ?? config.serverUrl;
      const started = await connectStart(argv[1], redirectOrigin);
      return {
        exitCode: 0,
        stdout: `Open this link in a browser that is signed in to Executor, and approve access for connection ${started.connection}:\n\n${started.url}\n\nExecutor then sends the browser to ${started.redirectUri}, and BB stores the grant. The link works once, for 15 minutes.\n`,
      };
    }
    if (argv[0] === "disconnect" && argv[1]) {
      if (!grants.has(argv[1])) return { exitCode: 1, stderr: `BB holds no grant for connection ${argv[1]}.\n` };
      forgetGrant(argv[1]);
      publish("connection-signed-out");
      return { exitCode: 0, stdout: `BB forgot its grant for connection ${argv[1]}. Revoke it in Executor too if you no longer trust this BB.\n` };
    }
    if (argv[0] === "use") {
      return queueToolkitWrite(async () => {
        const projectRef = cliOption(argv, "--project");
        const agentRef = cliOption(argv, "--agent");
        const pluginRef = cliOption(argv, "--plugin");
        if ([projectRef, agentRef, pluginRef, argv.includes("--global") || undefined].filter(Boolean).length !== 1) return { exitCode: 1, stderr: executorUsage };
        if (agentRef && !preferences.agentsIntegration) return { exitCode: 1, stderr: "Enable Agents in Executor settings → Oh My BB before choosing an agent connection scope.\n" };
        if (pluginRef && !pluginCallerSchema.safeParse(pluginRef).success) return { exitCode: 1, stderr: `Not a plugin ID: ${pluginRef}\n` };
        const project = projectRef ? (await bb.sdk.projects.list()).find((candidate) => candidate.id === projectRef || candidate.name === projectRef) : null;
        if (projectRef && !project) return { exitCode: 1, stderr: `Unknown project: ${projectRef}\n` };
        const agent = agentRef ? (await agentProfiles()).find((candidate) => candidate.id === agentRef || candidate.slug === agentRef.replace(/^@/u, "")) : null;
        if (agentRef && !agent) return { exitCode: 1, stderr: `Unknown agent: ${agentRef}\n` };
        const key = project?.id ?? (agent ? AGENT_TOOLKITS + agent.id : pluginRef ? PLUGIN_TOOLKITS + pluginRef : GLOBAL_TOOLKITS);
        const ids = argv.slice(1).filter((value, index, all) => !value.startsWith("--") && !["--project", "--agent", "--plugin"].includes(all[index - 1]!));
        if (!argv.includes("--clear") && !ids.length) return { exitCode: 1, stderr: executorUsage };
        await saveExecutorToolkits(key, argv.includes("--clear") ? [] : ids);
        const scope = project ? project.name : agent ? `agent @${agent.slug}` : pluginRef ? `plugin ${pluginRef}` : "every project";
        const unsigned = (toolkitMap[key] ?? []).filter((id) => !currentGrant(id));
        return {
          exitCode: 0,
          stdout: `${scope}: ${toolkitMap[key]?.join(", ") ?? "no Executor connections"}\n${unsigned.length ? `Not signed in yet: ${unsigned.join(", ")}. Run: bb catalog executor connect <connection>\n` : ""}`,
        };
      });
    }
    if (argv[0] === "status" || argv.length === 0) {
      if (!executor) return { exitCode: 0, stdout: "Executor is not configured.\n" };
      const overview = await executorOverview();
      const lines = [
        `url\t${executor.url}`,
        `token\t${executor.api ? "set (account health on)" : "not set (account health off)"}`,
        ...overview.connections.map((connection) => `connection\t${connection.id}\t${connection.connected ? "signed in" : "not signed in"}\t${connection.assignedTo.join(", ") || "unassigned"}`),
        ...executorConnections().broken.map((entry) => `warning\t${entry.name}: ${entry.problem}`),
        ...(overview.error ? [`warning\t${overview.error}`] : []),
      ];
      return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
    }
    if (argv[0] === "calls") {
      const calls = store.listPluginCalls(cliOption(argv, "--plugin") ?? null);
      if (argv.includes("--json")) return { exitCode: 0, stdout: `${JSON.stringify(calls, null, 2)}\n` };
      if (!calls.length) return { exitCode: 0, stdout: "No plugin Executor calls in the last 30 days.\n" };
      const lines = calls.map((call) => [call.at, call.caller, call.toolkit, call.mode, call.outcome, `${call.durationMs}ms`, `${call.bytesOut}B`, call.purpose, call.error ?? ""].join("\t").trimEnd());
      return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
    }
    return { exitCode: 1, stderr: executorUsage };
  }

  bb.events.on("thread.created", async ({ thread }) => {
    if (preferences.agentsIntegration && executor && Object.keys(toolkitMap).some((key) => key.startsWith(AGENT_TOOLKITS))) void warmThreadAgent(thread);
    if (!thread.environmentId) return;
    const workspace = await readyWorkspace(thread.environmentId, 10);
    if (workspace) queueProjection("thread-created", () => projectWorkspace(workspace));
  });

  // Fill the skill cache in the background. A changed skill set projects again.
  void refreshSkills("skills-changed").catch((error) => bb.log.warn(`Could not refresh Executor skills: ${message(error)}`));

  bb.log.info("loaded");
}
