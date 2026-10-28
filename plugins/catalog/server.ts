import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { BbPluginApi, ExperimentalPluginRpcHandlerContext, PluginCliResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ExecutorClient, connectionProblem, normalizeExecutorUrl, patternMatches, toolkitSlugPattern, type ApprovalRequest, type ExecutorTool, type PausedCall, type ToolkitDetail } from "./executor.js";
import { harnessCatalog, materializeSkills } from "./materialize.js";
import { pluginCallerSchema, preferencesSchema, rpcContract, type NativeCapabilityInput } from "./contract.js";
import { CatalogStore, migrations, type ApprovedSkill, type PluginExecutorCall, type Source } from "./store.js";
import { syncCatalogSource } from "./sync.js";
import manifest from "./package.json" with { type: "json" };
import { CatalogAssignmentStore } from "./assignment-store.js";
import { createAssignmentRuntime, requireAssignmentClient, requireProjects } from "./assignment-runtime.js";
import { AssignmentError } from "./assignment-contract.js";

const okSchema = z.object({ ok: z.literal(true) });
/** One checkout on one machine: a project source or a bb worktree. */
interface Workspace { hostId: string; path: string; projectId: string }

function sourceDto(source: Source) {
  const { approvedReleaseId: _approvedReleaseId, pendingReleaseId: _pendingReleaseId, ...visible } = source;
  return visible;
}

function skillDto(skill: ApprovedSkill) {
  const { files, skillId: _skillId, ...visible } = skill;
  return { ...visible, fileCount: files.length };
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
  return { exitCode: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
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
  if (context?.experimental_caller?.kind !== "client") throw new Error("Use the BB client for Executor settings and toolkit configuration.");
}

/**
 * Project → Executor toolkit slugs. The `*` key holds toolkits every project
 * gets, and `agent:<profile-id>` keys hold toolkits for every thread an Agents
 * profile runs, in whichever project that thread runs. `plugin:<plugin-id>`
 * keys hold toolkits another plugin's backend reaches through `executorCall`;
 * they are separate from the thread scopes and `*` does not apply to them.
 */
const toolkitMapSchema = z.record(z.string(), z.array(z.string().regex(toolkitSlugPattern)));
const TOOLKIT_MAP_KEY = "executor-toolkits";
const connectionAlertsSchema = z.record(z.string(), z.object({ name: z.string().optional(), problem: z.string(), since: z.number() }));
const CONNECTION_ALERTS_KEY = "executor-connection-alerts";
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
type ThreadAgent = z.infer<typeof threadAgentSchema>;
/** Must match APPROVAL_RENDERER_ID in app.tsx. */
const APPROVAL_RENDERER_ID = "executor-approval";
/** One Executor call can pause more than once, e.g. code that makes two gated calls. */
const MAX_APPROVALS_PER_CALL = 10;
const MAX_APPROVAL_ARGS_CHARS = 8_000;
/** Codex gives up on a tool after about 60 s, so a queued approval opens its own card well before. */
const APPROVAL_QUEUE_WAIT_MS = 30_000;
const APPROVALS_CHANGED = "executor-approvals-changed";
const MAX_ALLOWED_THREADS = 1_000;
const APPROVAL_INDEX_TTL_MS = 60 * 60_000;
const APPROVAL_INDEX_RETRY_MS = 60_000;

interface ApprovalIndex { at: number; tools: Map<string, ExecutorTool>; integrations: Map<string, string>; accounts: Map<string, string> }
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

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  db.pragma("foreign_keys = ON");
  const store = new CatalogStore(db);
  const bundleCache = new Map<string, string[]>();
  const assignmentStore = new CatalogAssignmentStore(db, store);
  const assignments = createAssignmentRuntime(bb, assignmentStore, manifest.version, () => {
    bundleCache.clear();
    publish("assignment-changed");
  });
  const sandboxSkills = new Map(await Promise.all((await bb.storage.kv.list("sandbox-skills:" )).map(async (key) => [key.slice("sandbox-skills:".length), z.array(z.string()).parse(await bb.storage.kv.get(key))] as const)));
  const selectedSkills = (hostId: string) => {
    const ids = sandboxSkills.get(hostId);
    return ids === undefined ? undefined : store.listApprovedSkills().filter((skill) => ids.includes(skill.id));
  };
  async function threadHost(threadId?: string) {
    if (!threadId || sandboxSkills.size === 0) return undefined;
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return undefined;
    return (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId;
  }


  function skillsForBundleIds(bundleIds: readonly string[]) {
    const bundles = new Map(store.listBundles().map((bundle) => [bundle.id, bundle]));
    const missing = bundleIds.find((id) => !bundles.has(id));
    if (missing) throw new AssignmentError("owner-unavailable", `Assigned Executor bundle ${missing} is unresolved. Restore its definition before materializing skills.`);
    const skillIds = new Set(bundleIds.flatMap((bundleId) => bundles.get(bundleId)?.skillIds ?? []));
    return store.listApprovedSkills().filter((skill) => skillIds.has(skill.id));
  }
  function nativeCapabilitiesForBundleIds(bundleIds: readonly string[]) {
    const wanted = new Set(bundleIds);
    return store.listBundles()
      .filter((bundle) => wanted.has(bundle.id) && bundle.nativeCapability)
      .map((bundle) => bundle.nativeCapability!);
  }

  // The remote Executor server owns which connections and policies make up a toolkit.
  // This plugin records which toolkits each project's agents may use, and carries
  // their calls from the BB server so sandboxes never hold the key.
  const executorSettings = bb.settings.define({
    executorUrl: {
      type: "string",
      label: "Executor URL",
      description: "Server that stores your service connections.",
      default: "",
    },
    executorApiKey: {
      type: "string",
      label: "Executor API key",
      description: "Connects this BB server to Executor.",
      secret: true,
    },
  });
  let executor: { client: ExecutorClient; url: string } | null = null;
  let toolkitMap = toolkitMapSchema.parse(await bb.storage.kv.get(TOOLKIT_MAP_KEY) ?? {});
  let preferences = preferencesSchema.parse(await bb.storage.kv.get("preferences") ?? {
    agentsIntegration: Object.keys(toolkitMap).some((key) => key.startsWith(AGENT_TOOLKITS)),
  });
  let preferenceWrites: Promise<unknown> = Promise.resolve();
  let toolkitWrites: Promise<unknown> = Promise.resolve();
  /** Integrations per mapped toolkit, for agent instructions; refreshed on changes and hourly. */
  let toolkitIntegrations = new Map<string, string[]>();

  /** A thread's toolkits: its agent's, then its project's, then the global ones. The first is the default. */
  function threadToolkits(projectId: string, profileId: string | null): string[] {
    const agent = preferences.agentsIntegration && profileId ? toolkitMap[AGENT_TOOLKITS + profileId] ?? [] : [];
    return [...new Set([...agent, ...(toolkitMap[projectId] ?? []), ...(toolkitMap[GLOBAL_TOOLKITS] ?? [])])];
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
  async function refreshToolkitIntegrations() {
    if (!executor) { toolkitIntegrations = new Map(); return; }
    toolkitIntegrations = await executor.client.toolkitIntegrations([...new Set(Object.values(toolkitMap).flat())]);
  }
  // Queue target lookups too: an earlier slow lookup must not outlive a later clear.
  function queueToolkitWrite<T>(write: () => Promise<T>) {
    const save = toolkitWrites.then(write);
    toolkitWrites = save.catch(() => undefined);
    return save;
  }
  async function saveExecutorToolkits(key: string, slugs: string[], expected?: string[]) {
    if (slugs.length && expected && JSON.stringify(toolkitMap[key] ?? []) !== JSON.stringify(expected)) throw new Error("This toolkit mapping changed. Reopen it and review the current choices before saving.");
    if (slugs.length) {
      if (!executor) throw new Error("Configure Executor in the native Configuration fields first.");
      const known = new Set((await executor.client.listToolkits()).map((toolkit) => toolkit.slug));
      const missing = slugs.filter((slug) => !known.has(slug));
      if (missing.length) throw new Error(`Executor has no toolkit named ${missing.join(", ")}. Create it in Executor first.`);
    }
    const next = { ...toolkitMap };
    if (slugs.length) next[key] = [...new Set(slugs)];
    else delete next[key];
    await bb.storage.kv.set(TOOLKIT_MAP_KEY, next);
    toolkitMap = next;
    await refreshToolkitIntegrations().catch(() => bb.log.warn("Executor toolkit mapping saved, but integration descriptions could not be refreshed."));
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
  /**
   * Broken connections, by address. Executor gives up on a connection after one
   * refused refresh and says nothing, so this plugin checks every ten minutes. Each
   * change goes out on CONNECTIONS_CHANGED, and the app shows it as a pop-up.
   */
  const connectionAlerts = connectionAlertsSchema.parse(await bb.storage.kv.get(CONNECTION_ALERTS_KEY) ?? {});
  /** One check at a time, so a scheduled run and a settings view never record the same change twice. */
  let checking: Promise<void> | null = null;
  function checkConnections(): Promise<void> {
    checking ??= runConnectionCheck().finally(() => { checking = null; });
    return checking;
  }
  async function runConnectionCheck() {
    if (!executor) return;
    const now = Date.now();
    const connections = await executor.client.listConnections();
    let changed = false;
    const recovered: { address: string; name: string; removed: boolean }[] = [];
    for (const connection of connections) {
      const problem = connectionProblem(connection);
      const known = connectionAlerts[connection.address];
      if (!problem || known?.problem === problem) continue;
      const name = `${connection.address.replace(/^tools\./u, "")}${connection.identityLabel ? ` (${connection.identityLabel})` : ""}`;
      connectionAlerts[connection.address] = { name, problem, since: known?.since ?? now };
      bb.log.warn(`Executor connection ${name} needs attention: ${problem}`);
      changed = true;
    }
    for (const [address, entry] of Object.entries(connectionAlerts)) {
      const connection = connections.find((candidate) => candidate.address === address);
      if (connection && connectionProblem(connection)) continue;
      const name = entry.name ?? address.replace(/^tools\./u, "");
      recovered.push({ address, name, removed: !connection });
      bb.log.info(`Executor connection ${name} ${connection ? "works again" : "was removed"}.`);
      delete connectionAlerts[address];
      changed = true;
    }
    if (!changed) return;
    await bb.storage.kv.set(CONNECTION_ALERTS_KEY, connectionAlerts);
    bb.realtime.publish(CONNECTIONS_CHANGED, { recovered });
  }
  /** Broken connections for the app's pop-ups. Reads the last check, so it is cheap on every app load. */
  function executorConnections() {
    return {
      url: executor?.url ?? null,
      broken: executor ? Object.entries(connectionAlerts).map(([address, entry]) => ({ address, name: entry.name ?? address.replace(/^tools\./u, ""), problem: entry.problem, since: entry.since })) : [],
    };
  }
  async function loadExecutor() {
    const values = await executorSettings.get();
    const url = values.executorUrl.trim() ? normalizeExecutorUrl(values.executorUrl) : "";
    const apiKey = (values.executorApiKey ?? "").trim();
    executor = url && apiKey ? { client: new ExecutorClient({ url, apiKey }), url } : null;
    await refreshToolkitIntegrations().catch((error) => bb.log.warn(`Could not read Executor toolkits: ${error instanceof Error ? error.message : String(error)}`));
  }
  executorSettings.onChange(() => {
    void loadExecutor().catch((error) => bb.log.warn(`Invalid Executor settings: ${error instanceof Error ? error.message : String(error)}`));
  });
  await loadExecutor().catch((error) => bb.log.warn(`Invalid Executor settings: ${error instanceof Error ? error.message : String(error)}`));

  async function callExecutor(context: { threadId: string; projectId: string; signal: AbortSignal }, toolkit: string | undefined, tool: string, args: Record<string, unknown>) {
    if (!executor) throw new Error("Executor is not configured. Run: bb catalog executor configure --url <url> --key-file <dotenv>");
    const client = executor.client;
    const allowed = threadToolkits(context.projectId, (await threadAgent(context.threadId)).profileId);
    if (!allowed.length) throw new Error("No Executor toolkits are assigned to this project or agent.");
    const slug = toolkit ?? allowed[0]!;
    if (!allowed.includes(slug)) throw new Error(`Toolkit ${slug} is not assigned to this project or agent. Use one of: ${allowed.join(", ")}.`);
    let output = await client.callTool(slug, tool, args, context.signal);
    for (let approvals = 0; output.paused && approvals < MAX_APPROVALS_PER_CALL; approvals += 1) {
      // Without a decision from the thread, the agent gets Executor's own link.
      if (!await askInThread(client, context, slug, output.paused)) break;
      output = await client.callTool(slug, "resume", { executionId: output.paused.executionId }, context.signal);
    }
    return output.text;
  }

  /**
   * What an approval card shows beside the call itself: the integration's
   * name, the account, the tool's own description, and why Executor asks.
   * Tools, integrations and accounts change rarely, so they are cached for an
   * hour and reread at most once a minute when a tool is missing. Rules are
   * read per approval, because they are the part people edit.
   */
  let approvalIndex: ApprovalIndex | null = null;
  async function loadApprovalIndex(client: ExecutorClient, address: string): Promise<ApprovalIndex | null> {
    const age = approvalIndex ? Date.now() - approvalIndex.at : Infinity;
    if (approvalIndex && age < APPROVAL_INDEX_TTL_MS && (approvalIndex.tools.has(address) || age < APPROVAL_INDEX_RETRY_MS)) return approvalIndex;
    const [tools, integrations, connections] = await Promise.all([client.listTools(), client.listIntegrations(), client.listConnections()]);
    approvalIndex = {
      at: Date.now(),
      tools: new Map(tools.map((tool) => [tool.address, tool])),
      integrations: new Map(integrations.map((integration) => [integration.slug, integration.name])),
      accounts: new Map(connections.map((connection) => [connection.address, connection.identityLabel || connection.name])),
    };
    return approvalIndex;
  }
  async function approvalDetail(client: ExecutorClient, toolkit: string, request: ApprovalRequest) {
    const [index, policies] = await Promise.all([
      loadApprovalIndex(client, request.address).catch(() => approvalIndex),
      client.toolkitPolicies(toolkit).catch(() => null),
    ]);
    const tool = index?.tools.get(request.address);
    const [integrationSlug = "", , connection = ""] = request.address.replace(/^tools\./u, "").split(".");
    const integration = index?.integrations.get(tool?.integration ?? integrationSlug) ?? tool?.integration ?? integrationSlug;
    const rule = policies?.find((policy) => policy.action === "require_approval" && patternMatches(policy.pattern, request.address));
    const reason = rule
      ? `Toolkit ${toolkit} has a rule that asks before ${rule.pattern.endsWith("*") ? `every ${rule.pattern} tool` : "this tool"}.`
      : tool?.requiresApproval ? `${integration} marks this tool as one that changes data, so Executor asks first.` : "Executor asks before this call.";
    const toolName = tool?.name ?? request.address.split(".").at(-1) ?? "";
    return {
      integration,
      account: index?.accounts.get(`tools.${tool?.integration ?? integrationSlug}.user.${tool?.connection ?? connection}`) ?? null,
      tool: toolName,
      description: tool?.description?.trim() || null,
      reason,
      // Executor's own message often just repeats the tool name and its arguments.
      message: request.message.startsWith(`${toolName} Arguments:`) ? "" : request.message,
    };
  }

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

  function requireApprovalAccess(client: ExecutorClient, context: { threadId: string; projectId: string; signal: AbortSignal }, toolkit: string) {
    context.signal.throwIfAborted();
    if (executor?.client !== client || !threadToolkits(context.projectId, threadAgents.get(context.threadId)?.profileId ?? null).includes(toolkit)) {
      throw new Error("Executor toolkit access changed while approval was pending. Run it again.");
    }
  }

  /**
   * Asks the user in the thread, then records their answer with Executor.
   * Only the user can answer the form, so the agent still cannot approve its
   * own call. False when no answer came (timeout, restart) or Executor could
   * not show the call, which leaves the approval link as the way to answer.
   */
  async function askInThread(client: ExecutorClient, context: { threadId: string; projectId: string; signal: AbortSignal }, toolkit: string, paused: PausedCall): Promise<boolean> {
    const request = await client.approvalRequest(paused).catch((error: unknown) => {
      bb.log.warn(`Could not read Executor approval ${paused.executionId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (!request) return false;
    if (threadAllowed.get(context.threadId)?.has(request.address)) {
      requireApprovalAccess(client, context, toolkit);
      await client.decide(paused, "accept");
      return true;
    }
    const name = request.address.replace(/^tools\./u, "");
    const shown = request.args === null ? "" : JSON.stringify(request.args, null, 2) ?? "";
    const args = shown.length > MAX_APPROVAL_ARGS_CHARS ? `${shown.slice(0, MAX_APPROVAL_ARGS_CHARS)}\n… (truncated)` : shown;
    const detail = await approvalDetail(client, toolkit, request);
    const queue = approvalQueue(context.threadId);
    const entry: QueuedApproval = {
      id: randomUUID(), address: request.address, name,
      summary: detail.description ? `${detail.integration}: ${detail.description}` : `${detail.integration}: ${detail.tool}`,
      open: false, decision: null, stop: new AbortController(),
    };
    queue.entries.push(entry);
    approvalsChanged(context.threadId);
    try {
      await waitForTurn(queue, entry, context.signal);
      if (!entry.decision) {
        if (!entry.open) return false;
        const result = await bb.ui.requestInput({
          threadId: context.threadId,
          rendererId: APPROVAL_RENDERER_ID,
          title: `Approve ${name}`.slice(0, 200),
          payload: { approvalId: entry.id, toolkit, address: request.address, ...detail, args, approvalUrl: paused.approvalUrl },
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
          if (answer.approved) requireApprovalAccess(client, context, toolkit);
          entry.decision = answer.approved ? "accept" : "decline";
          const others = queue.entries.filter((other) => other !== entry);
          if (answer.approved && answer.scope === "thread") {
            allowInThread(context.threadId, request.address);
            answerQueued(context.threadId, others.filter((other) => other.address === request.address));
          }
          if (answer.approved && answer.scope === "all") answerQueued(context.threadId, others);
        } else if (!entry.decision) {
          // Dismissing the form is a decline; any other cancellation is no answer at all.
          if (result.reason !== "user") return false;
          entry.decision = "decline";
        }
      }
      if (entry.decision === "accept") requireApprovalAccess(client, context, toolkit);
      await client.decide(paused, entry.decision!);
      return true;
    } finally {
      entry.open = false;
      queue.entries.splice(queue.entries.indexOf(entry), 1);
      approvalsChanged(context.threadId);
    }
  }

  // Plugin toolkit scopes are bound to the SDK's verified caller. Background
  // reads decline immediately; paused writes can be displayed and declined.
  // Acceptance is only through the native owner interaction, never this RPC.
  const pluginPaused = new Map<string, { caller: string; toolkit: string; purpose: string; paused: PausedCall; expires: number }>();
  const pluginQueues = new Map<string, Promise<unknown>>();
  const pluginCallTimes = new Map<string, number[]>();
  function pluginClient(caller: string, toolkit: string): ExecutorClient {
    if (!executor) throw new Error("Executor is not configured. Run: bb catalog executor configure --url <url> --key-file <dotenv>");
    const allowed = toolkitMap[PLUGIN_TOOLKITS + caller] ?? [];
    if (!allowed.length) throw new Error(`No Executor toolkit is mapped to plugin ${caller}. Run: bb catalog executor use <toolkit> --plugin ${caller}`);
    if (!allowed.includes(toolkit)) throw new Error(`Toolkit ${toolkit} is not mapped to plugin ${caller}. Use one of: ${allowed.join(", ")}.`);
    return executor.client;
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
  async function pausedForPlugin(client: ExecutorClient, entry: { caller: string; toolkit: string; purpose: string; paused: PausedCall }) {
    const request = await client.approvalRequest(entry.paused).catch((error: unknown) => {
      bb.log.warn(`Could not read Executor approval ${entry.paused.executionId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    const at = Date.now();
    for (const [id, pending] of pluginPaused) if (pending.expires < at) pluginPaused.delete(id);
    pluginPaused.set(entry.paused.executionId, { ...entry, expires: at + PLUGIN_PAUSE_TTL_MS });
    const shown = request?.args == null ? "" : JSON.stringify(request.args, null, 2) ?? "";
    return {
      executionId: entry.paused.executionId,
      approvalUrl: entry.paused.approvalUrl,
      address: request?.address.replace(/^tools\./u, "") ?? "unknown",
      message: request?.message ?? "",
      args: shown.length > MAX_APPROVAL_ARGS_CHARS ? `${shown.slice(0, MAX_APPROVAL_ARGS_CHARS)}\n… (truncated)` : shown,
    };
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
      error = (caught instanceof Error ? caught.message : String(caught)).slice(0, 500);
      throw caught;
    } finally {
      try { store.recordPluginCall({ ...call, bytesOut, durationMs: Date.now() - started, outcome, error }); }
      catch (caught) { bb.log.warn(`Could not record Executor call from plugin ${call.caller}: ${caught instanceof Error ? caught.message : String(caught)}`); }
    }
  }
  function pluginExecutorCall(input: { caller: string; toolkit: string; code: string; mode: "read" | "write"; purpose: string }, context: ExperimentalPluginRpcHandlerContext) {
    const { caller, toolkit, code, mode, purpose } = input;
    requirePluginCaller(caller, context);
    return serialized(caller, () => auditedPluginCall({ caller, toolkit, mode, purpose }, async (outcome) => {
      const client = pluginClient(caller, toolkit);
      takeCallSlot(caller);
      const output = await client.callTool(toolkit, "execute", { code }, AbortSignal.timeout(PLUGIN_CALL_TIMEOUT_MS));
      if (!output.paused) return { text: output.text, paused: null };
      if (mode === "read") {
        outcome("declined");
        const request = await client.approvalRequest(output.paused).catch(() => null);
        await client.decide(output.paused, "decline").catch((error: unknown) => bb.log.warn(`Could not decline Executor call ${output.paused!.executionId} for plugin ${caller}: ${error instanceof Error ? error.message : String(error)}`));
        throw new Error(`${request?.address.replace(/^tools\./u, "") ?? "A tool"} needs approval, and read calls never wait for one, so this plugin declined it. Make writes in mode "write".`);
      }
      outcome("paused");
      return { text: output.text, paused: await pausedForPlugin(client, { caller, toolkit, purpose, paused: output.paused }) };
    }));
  }
  function pluginExecutorDecide(input: { caller: string; executionId: string; action: "accept" | "decline" }, context: ExperimentalPluginRpcHandlerContext) {
    const { caller, executionId, action } = input;
    if (context?.experimental_caller?.kind !== "client") {
      requirePluginCaller(caller, context);
    }
    if (action === "accept") throw new Error("Executor acceptance requires a native owner interaction; executorDecide only supports decline.");
    const pending = pluginPaused.get(executionId);
    if (!pending || pending.caller !== caller || pending.expires < Date.now()) {
      return Promise.reject(new Error("No paused Executor call with that ID is waiting for this plugin. It may have expired; run it again."));
    }
    pluginPaused.delete(executionId);
    return serialized(caller, () => auditedPluginCall({ caller, toolkit: pending.toolkit, mode: "write", purpose: `${action}: ${pending.purpose}`.slice(0, 200) }, async (outcome) => {
      const client = pluginClient(caller, pending.toolkit);
      await client.decide(pending.paused, action);
      outcome("declined");
      // The declined execution still finishes; its result carries nothing the plugin needs.
      await client.callTool(pending.toolkit, "resume", { executionId }, AbortSignal.timeout(PLUGIN_CALL_TIMEOUT_MS)).catch(() => undefined);
      return { text: "Declined.", paused: null };
    }));
  }

  async function projectBundleIds(projectId: string): Promise<string[]> {
    const projection = await assignments.read();
    const ids = [...new Set([...projection.globalBundleIds, ...(projection.projects.find((project) => project.projectId === projectId)?.bundleIds ?? [])])];
    bundleCache.set(projectId, ids);
    return ids;
  }

  async function globalBundleIds(): Promise<string[]> {
    return (await assignments.read()).globalBundleIds;
  }

  async function warmBundleCache(projectId?: string | null) {
    if (projectId) {
      await projectBundleIds(projectId);
      return;
    }
    const projectIds = (await targets()).map((target) => target.id);
    const projection = await assignments.read();
    bundleCache.clear();
    for (const projectId of projectIds) bundleCache.set(projectId, [...new Set([
      ...projection.globalBundleIds, ...(projection.projects.find((project) => project.projectId === projectId)?.bundleIds ?? []),
    ])]);
  }

  async function targets() {
    return bb.sdk.projects.list().then((projects) => projects
      .filter((project) => project.kind === "standard")
      .map((project) => ({ kind: "project" as const, id: project.id, name: project.name, detail: project.gitRemoteUrl })));
  }

  async function catalogOverview() {
    const assignmentState = assignmentStore.status();
    return {
      sources: store.listSources().map(sourceDto), skills: store.listApprovedSkills({ includeDisabled: true }).map(skillDto),
      bundles: store.listBundles(), targets: await targets(), harnesses: harnessCatalog(), assignmentState,
      assignments: assignmentState.state === "active" ? assignmentStore.records().flatMap((record) => record.type === "reference"
        ? [{ bundleId: record.targetId, kind: record.projectId === null ? "global" as const : "project" as const, targetId: record.projectId ?? "*" }]
        : []) : null,
    };
  }

  async function snapshot() {
    const bundles = store.listBundles();
    const canonical = await assignments.read();
    const assignmentRows = [
      ...canonical.globalBundleIds.map((bundleId) => ({ bundleId, kind: "global" as const, targetId: "*" })),
      ...canonical.projects.flatMap((project) => project.bundleIds.map((bundleId) => ({ bundleId, kind: "project" as const, targetId: project.projectId }))),
    ];
    return {
      sources: store.listSources().map(sourceDto),
      skills: store.listApprovedSkills({ includeDisabled: true }).map(skillDto),
      bundles,
      assignments: assignmentRows,
      targets: await targets(),
      harnesses: harnessCatalog(),
    };
  }

  async function removeCanonicalBundles(bundleIds: readonly string[]) {
    for (const bundleId of bundleIds) {
      await assignments.write("removeBundle", { bundleId });
    }
  }


  /**
   * Shared agent and Claude roots carry global skills. BB receives the same
   * capabilities through this plugin's tools, so publishing another copy into its
   * own root would advertise every skill twice to Codex.
   */
  async function projectMachine(hostId: string, homePath: string | null) {
    const config = await bb.sdk.system.config();
    const primary = hostId === config.primaryHostId;
    const home = primary ? homedir() : homePath;
    if (!home) throw new Error("Could not resolve a home directory for that machine");
    const base = primary ? config.dataDir : `${home}/.bb`;
    return materializeSkills({
      bb, hostId, skills: selectedSkills(hostId) ?? skillsForBundleIds(await globalBundleIds()),
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
   * A workspace carries skills assigned to its project in provider roots.
   * The skill tools expose them inside BB without a second BB-root projection.
   */
  async function projectWorkspace(workspace: Workspace) {
    const globalIds = new Set(await globalBundleIds());
    const workspaceBundleIds = (await projectBundleIds(workspace.projectId)).filter((id) => !globalIds.has(id));
    return materializeSkills({
      bb, hostId: workspace.hostId, keepOutOfGit: true,
      skills: selectedSkills(workspace.hostId) !== undefined ? [] : skillsForBundleIds(workspaceBundleIds),
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
        // for that path so an old thread cannot replace its skill assignment.
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
    const projection = await assignments.read();
    skillsForBundleIds([...projection.globalBundleIds, ...projection.projects.flatMap((project) => project.bundleIds)]);
    const config = await bb.sdk.system.config();
    const machine = config.primaryHostId ? await projectMachine(config.primaryHostId, null) : null;
    const report: ProjectionReport = { machine: { skillCount: machine?.skillCount ?? 0, roots: machine?.roots ?? [] }, workspaces: [] };
    for (const workspace of await workspaces()) {
      try {
        const outcome = await projectWorkspace(workspace);
        report.workspaces.push({ path: workspace.path, skillCount: outcome.skillCount, error: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.workspaces.push({ path: workspace.path, skillCount: 0, error: message });
        bb.log.warn(`Could not project Executor skills into ${workspace.path}: ${message}`);
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
    void serialize(work).catch((error) => bb.log.warn(`Could not project Executor skills (${reason}): ${error instanceof Error ? error.message : String(error)}`));
  }

  function publish(reason: string) {
    bb.realtime.publish("catalog-changed", { reason });
    void queueProjection(reason, () => projectEverything(reason));
  }

  async function syncOne(id: string) {
    const outcome = await syncCatalogSource(store, store.requireSource(id));
    publish("source-synced");
    return outcome;
  }

  async function syncAll() {
    let checked = 0;
    let updated = 0;
    let failed = 0;
    for (const source of store.listSources().filter((candidate) => candidate.enabled)) {
      checked += 1;
      try {
        if ((await syncCatalogSource(store, source)).updated) updated += 1;
      } catch (error) {
        failed += 1;
        bb.log.warn(`Could not sync Executor source ${source.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (checked) publish("sources-synced");
    return { checked, updated, failed };
  }

  async function skillsForTool(context: { projectId: string; threadId?: string }) {
    const hostId = await threadHost(context.threadId);
    if (hostId && sandboxSkills.has(hostId)) return selectedSkills(hostId)!;
    return skillsForBundleIds(await projectBundleIds(context.projectId));
  }
  async function nativeCapabilitiesForTool(context: { projectId: string }) {
    return nativeCapabilitiesForBundleIds(await projectBundleIds(context.projectId));
  }


  async function setCanonicalAssignment(bundleId: string, kind: "global" | "project", targetId: string, enabled: boolean) {
    if (kind === "global") {
      if (targetId !== "*") throw new Error("Global assignments use the * target");
      await assignments.write("setGlobalBundle", { targetId: bundleId, enabled });
      await warmBundleCache();
    } else {
      await assignments.write("setProjectBundle", { projectId: targetId, targetId: bundleId, enabled });
      await warmBundleCache(targetId);
    }
    const capability = store.nativeCapability(bundleId);
    if (capability?.assignmentChangedRpc) {
      await bb.sdk.plugins.callRpc({
        pluginId: capability.pluginId,
        method: capability.assignmentChangedRpc,
        input: { bundleId },
        outputSchema: okSchema,
      }).catch((error) => {
        bb.log.warn(`Could not refresh ${capability.name} assignment state: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    publish("assignment-changed");
  }

  const materialize = (input: { hostId: string; homePath: string; projectId: string | null; workspacePath: string | null }) => serialize(async () => {
    if (!sandboxSkills.has(input.hostId)) {
      const projection = await assignments.read();
      skillsForBundleIds([...projection.globalBundleIds, ...(projection.projects.find((project) => project.projectId === input.projectId)?.bundleIds ?? [])]);
    }
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
      (error) => materializationJobs.set(jobId, {
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    ).finally(() => {
      const expiry = setTimeout(() => materializationJobs.delete(jobId), 60 * 60_000);
      expiry.unref();
    });
    return { jobId };
  };

  bb.rpc.register(rpcContract, {
    catalogOverview: (_input, context) => { requireCatalogClient(context); return catalogOverview(); },
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
        if (scope === "global" && targetId !== "*") throw new Error("Global toolkits use the * target.");
        if (toolkits.length && scope === "project" && !(await targets()).some((project) => project.id === targetId)) throw new Error("Choose an existing project.");
        if (scope === "plugin") pluginCallerSchema.parse(targetId);
        if (toolkits.length && scope === "agent" && (!preferences.agentsIntegration || !(await agentProfiles()).some((agent) => agent.id === targetId))) throw new Error("Enable Agents in Executor settings → Oh My BB and choose an existing profile ID.");
        const key = scope === "global" ? GLOBAL_TOOLKITS : scope === "agent" ? AGENT_TOOLKITS + targetId : scope === "plugin" ? PLUGIN_TOOLKITS + targetId : targetId;
        await saveExecutorToolkits(key, toolkits, expectedToolkits);
        bb.realtime.publish("catalog-changed", { reason: "toolkits-changed" });
        return { ok: true as const };
      });
    },
    assignmentStatus: () => assignmentStore.status(),
    initializeAssignmentsV1: async (input, context) => {
      requireAssignmentClient(context);
      await assignments.initialize(input);
      return { ok: true as const };
    },
    stageAssignmentsV1: (identity, context) => {
      requireAssignmentClient(context);
      return assignments.stage(identity);
    },
    activateAssignmentsV1: async (identity, context) => {
      requireAssignmentClient(context);
      await assignments.activate(identity);
      bundleCache.clear();
      return { ok: true as const };
    },
    assignmentReceiptV1: (identity, context) => {
      requireProjects(context);
      if (assignmentStore.status().state === "staged") assignments.requirePinnedRelease(identity);
      return assignmentStore.receipt(identity);
    },
    assignmentAbortV1: (identity, context) => {
      requireProjects(context);
      assignmentStore.abort(identity);
      return { ok: true as const };
    },
    assignmentReadV1: ({ method, input, ...identity }, context) => {
      requireProjects(context);
      return assignments.compatibilityRead(identity, method, input);
    },
    assignmentWriteV1: ({ method, input, ...identity }, context) => {
      requireProjects(context);
      assignmentStore.requireActive(identity);
      return assignments.write(method, input);
    },
    assignmentReverseExportV1: ({ cursor, reverseGeneration, ...identity }, context) => {
      requireProjects(context);
      return assignments.reverse(identity, cursor, reverseGeneration);
    },
    getSandboxSkills: ({ hostId }) => ({ skillIds: sandboxSkills.get(hostId) ?? null }),
    executorToolkits: ({ caller }, context) => {
      requirePluginCaller(caller, context);
      return {
        configured: executor !== null,
        toolkits: (toolkitMap[PLUGIN_TOOLKITS + caller] ?? []).map((slug) => ({ slug, integrations: toolkitIntegrations.get(slug) ?? [] })),
      };
    },
    executorCall: pluginExecutorCall,
    executorDecide: pluginExecutorDecide,
    executorApprovals: ({ threadId }) => ({
      pending: (approvalQueues.get(threadId)?.entries ?? []).filter((entry) => !entry.decision).map(({ id, name, summary, open }) => ({ approvalId: id, name, summary, open })),
    }),
    executorOverview,
    executorConnections,
    setSandboxSkills: async ({ hostId, skillIds }) => {
      const available = new Set(store.listApprovedSkills().map((skill) => skill.id));
      if (skillIds.some((id) => !available.has(id))) throw new Error("An unavailable skill was selected.");
      const selected = [...new Set(skillIds)];
      await bb.storage.kv.set(`sandbox-skills:${hostId}`, selected);
      sandboxSkills.set(hostId, selected);
      return { ok: true as const };
    },
    snapshot,
    listBundles: () => ({ bundles: store.listBundles() }),
    legacyAssignments: () => ({ assignments: store.listAssignments() }),
    registerNativeCapability: (input) => {
      const { bundle, changed } = store.saveNativeCapability(input);
      if (changed) publish("native-capability-registered");
      return bundle;
    },
    saveSource: ({ expected, ...input }) => {
      if (input.id) {
        const current = store.requireSource(input.id);
        const fields = ["name", "repositoryUrl", "gitRef", "subdirectory", "updatePolicy", "enabled"] as const;
        if (!expected || fields.some((key) => current[key] !== expected[key])) throw new Error("This source changed. Reopen it and review the current values before saving.");
      }
      const saved = store.saveSource(input); publish("source-saved"); return sourceDto(saved);
    },
    deleteSource: async ({ id }) => {
      store.requireSource(id);
      const generatedBundleIds = store.listBundles().filter((bundle) => bundle.sourceId === id).map((bundle) => bundle.id);
      await removeCanonicalBundles(generatedBundleIds);
      store.deleteSource(id);
      publish("source-deleted");
      return { ok: true as const };
    },
    syncSource: async ({ id }) => sourceDto((await syncOne(id)).source),
    syncAll: async () => syncAll(),
    approveSource: ({ id }) => { const source = store.approveSource(id); publish("source-approved"); return sourceDto(source); },
    saveBundle: ({ expected, ...input }) => {
      if (input.id) {
        const current = store.requireBundle(input.id);
        const members = (ids: string[]) => JSON.stringify([...new Set(ids)].sort());
        if (!expected || current.name !== expected.name || current.description !== expected.description || members(current.skillIds) !== members(expected.skillIds)) throw new Error("This custom set changed. Reopen it and review the current skills before saving.");
      }
      const validIds = new Set(store.listApprovedSkills().map((skill) => skill.id));
      const unknown = input.skillIds.find((id) => !validIds.has(id));
      if (unknown) throw new Error(`Bundle references an unavailable approved skill: ${unknown}`);
      const saved = store.saveBundle(input); publish("bundle-saved"); return saved;
    },
    deleteBundle: async ({ id }) => {
      const bundle = store.requireBundle(id);
      if (bundle.sourceId) throw new Error(`${bundle.name} belongs to a source and is removed with it`);
      await removeCanonicalBundles([id]);
      store.deleteBundle(id);
      publish("bundle-deleted");
      return { ok: true as const };
    },
    setAssignment: async ({ bundleId, kind, targetId, enabled }) => {
      store.requireBundle(bundleId);
      if (kind !== "global" && kind !== "project") throw new Error("Skills are assigned to projects now. Agent and credential-set assignments were migrated into Projects.");
      await setCanonicalAssignment(bundleId, kind, targetId, enabled);
      return { ok: true as const };
    },
    setSkillsEnabled: ({ skillIds, enabled }) => {
      for (const skillId of skillIds) store.setSkillEnabled(skillId, enabled);
      publish("skills-toggled");
      return { ok: true as const };
    },
    refreshAvailability: async ({ projectId }) => {
      await warmBundleCache(projectId);
      publish("project-availability-changed");
      return { ok: true as const };
    },
    materialize,
    startMaterialize,
    materializationStatus: ({ jobId }) => materializationJobs.get(jobId) ?? {
      state: "failed" as const,
      error: "Materialization job is no longer available",
    },
  });

  bb.agents.registerTool({
    name: "catalog_search",
    description: "Search approved skills available to this project before reading one in full.",
    instructions: "Search returns capability IDs and provenance. Pass an exact returned ID to catalog_read.",
    presentation: {
      label: {
        pending: "Searching Executor skills",
        completed: "Searched Executor skills",
      },
      icon: { glyph: "Search" },
    },
    parameters: z.object({ query: z.string().trim().max(500).default(""), limit: z.number().int().min(1).max(50).default(20) }).strict(),
    async execute({ query, limit }, context) {
      const needle = query.toLowerCase();
      const bundleIds = await projectBundleIds(context.projectId);
      const skills = (await skillsForTool(context)).map((skill) => ({ kind: "skill" as const, ...skillDto(skill) }));
      const native = nativeCapabilitiesForBundleIds(bundleIds).map(nativeCapabilityDto);
      const matches = [...native, ...skills].filter((capability) =>
        JSON.stringify(capability).toLowerCase().includes(needle),
      ).slice(0, limit);
      return JSON.stringify({ count: matches.length, capabilities: matches });
    },
  });

  bb.agents.registerTool({
    name: "catalog_read",
    description: "Read a file from one approved Executor skill available to this project.",
    presentation: {
      label: {
        pending: "Reading Executor skill",
        completed: "Read Executor skill",
      },
      icon: { glyph: "Explore" },
    },
    parameters: z.object({ skillId: z.string().min(1), path: z.string().default("SKILL.md") }).strict(),
    async execute({ skillId, path }, context) {
      if (skillId.startsWith("native:")) {
        const bundleId = skillId.slice("native:".length);
        const capability = (await nativeCapabilitiesForTool(context)).find((candidate) => candidate.id === bundleId);
        if (!capability) throw new Error("That native capability is not available in this project");
        return JSON.stringify({
          capability: nativeCapabilityDto(capability),
          provenance: { pluginId: capability.pluginId, managedBy: "catalog" },
        });
      }
      const skill = (await skillsForTool(context)).find((candidate) => candidate.id === skillId);
      if (!skill) throw new Error("That skill is not available in this project");
      const requestedPath = safeSkillPath(path);
      const file = skill.files.find((candidate) => candidate.path === requestedPath);
      if (!file) throw new Error(`Unknown file in ${skill.name}: ${requestedPath}`);
      return JSON.stringify({
        skill: skillDto(skill), path: requestedPath, content: file.content,
        provenance: { repository: store.requireSource(skill.sourceId).repositoryUrl, revision: skill.revision },
      });
    },
  });

  const executorPresentation = (pending: string, completed: string) => ({ label: { pending, completed }, icon: { glyph: "Workflow" } });
  const toolkitParameter = z.string().regex(toolkitSlugPattern).optional()
    .describe("Executor toolkit to use. Omit for this thread's default; the instructions list the others.");

  bb.agents.registerTool({
    name: "executor_execute",
    description: "Run TypeScript in Executor's sandbox with access to the remote MCP and API integrations in this thread's Executor toolkits.",
    instructions: "Call executor_docs with name \"execute\" before your first call. One call runs in one toolkit. Credentials stay in Executor. A call that needs approval asks the user in this thread and returns once they answer. If it returns an approval link instead, give the user the link, then call executor_resume with the same toolkit.",
    presentation: executorPresentation("Running in Executor", "Ran in Executor"),
    parameters: z.object({ code: z.string().min(1).max(100_000), toolkit: toolkitParameter }).strict(),
    execute: ({ code, toolkit }, context) => callExecutor(context, toolkit, "execute", { code }),
  });

  bb.agents.registerTool({
    name: "executor_docs",
    description: "Read Executor's own how-to docs, such as the workflow for executor_execute. Omit name to list them.",
    presentation: executorPresentation("Reading Executor docs", "Read Executor docs"),
    parameters: z.object({ name: z.string().trim().max(100).optional(), toolkit: toolkitParameter }).strict(),
    execute: ({ name, toolkit }, context) => callExecutor(context, toolkit, "skills", name ? { name } : {}),
  });

  bb.agents.registerTool({
    name: "executor_resume",
    description: "Continue an Executor call that returned an approval link. It waits for the user's decision; it cannot approve on its own.",
    presentation: executorPresentation("Waiting for Executor approval", "Resumed Executor call"),
    parameters: z.object({ executionId: z.string().min(1).max(200), toolkit: toolkitParameter }).strict(),
    execute: ({ executionId, toolkit }, context) => callExecutor(context, toolkit, "resume", { executionId }),
  });

  bb.agents.configure((context) => {
    const local = assignmentStore.status().state === "active" ? assignmentStore.projection() : null;
    const bundleIds = local ? [...new Set([...local.globalBundleIds, ...(local.projects.find((project) => project.projectId === context.project.id)?.bundleIds ?? [])])]
      : bundleCache.get(context.project.id) ?? [];
    const skills = selectedSkills(context.host.id) ?? skillsForBundleIds(bundleIds);
    const native = nativeCapabilitiesForBundleIds(bundleIds);
    const count = native.length + skills.length;
    const agent = threadAgents.get(context.thread.id);
    if (preferences.agentsIntegration && !agent?.bound) void threadAgent(context.thread.id);
    const toolkits = executor ? threadToolkits(context.project.id, agent?.profileId ?? null) : [];
    // Until Agents answers, an agent's own toolkits are unknown; the tools still check at call time.
    const agentMayHaveToolkits = preferences.agentsIntegration && Boolean(executor) && !agent?.bound && Object.keys(toolkitMap).some((key) => key.startsWith(AGENT_TOOLKITS));
    const described = toolkits.map((slug) => {
      const integrations = toolkitIntegrations.get(slug);
      return integrations?.length ? `${slug} (${integrations.join(", ")})` : slug;
    });
    return {
      tools: ["catalog_search", "catalog_read", ...(toolkits.length || agentMayHaveToolkits ? ["executor_execute", "executor_docs", "executor_resume"] : [])],
      skills: ["catalog"],
      instructions: [
        count
          ? `Executor has ${count} approved capabilities assigned to this project. Use catalog_search to find relevant capabilities and catalog_read to load full instructions.`
          : "Executor is available. Search to discover the skills assigned to this project.",
        toolkits.length
          ? `Executor toolkits for this thread: ${described.join("; ")}. The default is ${toolkits[0]}. Reach them with executor_execute (TypeScript calling tools.<integration>.…), and read executor_docs with name "execute" first. Prefer these over locally configured MCP servers for the same service.`
          : agentMayHaveToolkits
            ? "This thread's agent may have Executor toolkits. Call executor_docs without a toolkit to use its default; an unassigned toolkit fails with the list of assigned ones."
            : "",
      ].filter(Boolean).join("\n\n"),
    };
  });

  bb.background.schedule("sync-sources", "17 3 * * 0", async () => { await syncAll(); });
  bb.background.schedule("refresh-executor-toolkits", "23 * * * *", async () => { await refreshToolkitIntegrations(); });
  bb.background.schedule("check-executor-connections", "*/10 * * * *", async () => {
    await checkConnections().catch((error) => bb.log.warn(`Could not check Executor connections: ${error instanceof Error ? error.message : String(error)}`));
  });

  bb.cli.register({
    name: "catalog",
    summary: "Manage versioned skill sources and capability bundles",
    commands: [
      { name: "list", summary: "List sources, packages, bundles, and assignments", usage: "bb catalog list [--json]" },
      { name: "add", summary: "Subscribe to and initially sync a Git skill source", usage: "bb catalog add <name> <https-url> [--ref <git-ref>] [--subdirectory <path>] [--review]" },
      { name: "sync", summary: "Sync every enabled source or one source ID", usage: "bb catalog sync [source-id]" },
      { name: "approve", summary: "Approve a source's pending revision", usage: "bb catalog approve <source-id>" },
      { name: "skills", summary: "List approved skills and whether each one is on", usage: "bb catalog skills [--source <name>] [--json]" },
      { name: "enable", summary: "Turn one approved skill on", usage: "bb catalog enable <skill-id>" },
      { name: "disable", summary: "Turn one approved skill off", usage: "bb catalog disable <skill-id>" },
      { name: "assign", summary: "Make a skill set available globally or to one project", usage: "bb catalog assign <skill-set> [--project <id>]" },
      { name: "unassign", summary: "Remove a global or project skill-set assignment", usage: "bb catalog unassign <skill-set> [--project <id>]" },
      { name: "project", summary: "Rewrite this machine's and every workspace's skill roots from the current assignments", usage: "bb catalog project [--json]" },
      { name: "executor", summary: "Configure Executor and choose which of its toolkits each project uses", usage: "bb catalog executor <status|configure [--url <url>] [--key-file <dotenv>]|use <toolkit>... (--project <id-or-name>|--agent <@slug-or-id>|--plugin <id>|--global)|use --clear (--project <id-or-name>|--agent <@slug-or-id>|--plugin <id>|--global)|calls [--plugin <id>] [--json]>" },
    ],
    async run(argv) {
      try {
        if (argv[0] === "list") {
          const data = await snapshot();
          if (argv.includes("--json")) return { exitCode: 0, stdout: `${JSON.stringify(data, null, 2)}\n` };
          const packages = data.bundles.map((bundle) => {
            const assignmentCount = data.assignments.filter((assignment) => assignment.bundleId === bundle.id).length;
            if (bundle.nativeCapability) {
              return `native\t${bundle.name}\t${bundle.nativeCapability.toolIds.length} tools · ${bundle.nativeCapability.skillIds.length} skills\t${assignmentCount} assignments`;
            }
            return `${bundle.sourceId ? "package" : "bundle "}\t${bundle.name}\t${bundle.skillIds.length} skills\t${assignmentCount} assignments`;
          });
          const lines = [
            ...data.sources.map((source) => `${source.enabled ? "on " : "off"}\t${source.name}\t${source.approvedRevision?.slice(0, 12) ?? "not synced"}${source.pendingRevision ? "\tupdate awaiting approval" : ""}`),
            ...packages,
          ];
          return { exitCode: 0, stdout: `${lines.join("\n")}${lines.length ? "\n" : "No Executor sources configured.\n"}` };
        }
        if (argv[0] === "add" && argv[1] && argv[2]) {
          const input = {
            name: argv[1],
            repositoryUrl: argv[2],
            gitRef: cliOption(argv, "--ref") ?? "main",
            subdirectory: cliOption(argv, "--subdirectory") ?? "",
            updatePolicy: argv.includes("--review") ? "review" as const : "automatic" as const,
            enabled: true,
          };
          const source = store.saveSource(input);
          publish("source-saved");
          const synced = await syncOne(source.id);
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({ source: sourceDto(synced.source), importedSkills: store.listApprovedSkills().filter((skill) => skill.sourceId === source.id).length, assignments: 0 }, null, 2)}\n`,
          };
        }
        if (argv[0] === "sync") {
          const outcome = argv[1] ? { source: sourceDto((await syncOne(argv[1])).source) } : await syncAll();
          return { exitCode: 0, stdout: `${JSON.stringify(outcome, null, 2)}\n` };
        }
        if (argv[0] === "approve" && argv[1]) {
          const source = sourceDto(store.approveSource(argv[1])); publish("source-approved");
          return { exitCode: 0, stdout: `${source.name} now uses ${source.approvedRevision}.\n` };
        }
        if (argv[0] === "skills") {
          const wanted = cliOption(argv, "--source");
          const skills = store.listApprovedSkills({ includeDisabled: true })
            .filter((skill) => !wanted || skill.sourceName.toLowerCase() === wanted.toLowerCase());
          if (argv.includes("--json")) return { exitCode: 0, stdout: `${JSON.stringify(skills.map(skillDto), null, 2)}\n` };
          const lines = skills.map((skill) => `${skill.enabled ? "on " : "off"}\t${skill.id}\t${skill.name}`);
          return { exitCode: 0, stdout: `${lines.join("\n")}${lines.length ? "\n" : "No approved skills yet.\n"}` };
        }
        if ((argv[0] === "enable" || argv[0] === "disable") && argv[1]) {
          store.setSkillEnabled(argv[1], argv[0] === "enable");
          publish("skill-toggled");
          return { exitCode: 0, stdout: `${argv[1]} is now ${argv[0] === "enable" ? "on" : "off"}.\n` };
        }
        if ((argv[0] === "assign" || argv[0] === "unassign") && argv[1]) {
          const bundle = store.listBundles().find((value) => value.name.toLowerCase() === argv[1].toLowerCase());
          if (!bundle) return { exitCode: 1, stderr: `Unknown Executor package or bundle: ${argv[1]}\n` };
          const targetId = cliOption(argv, "--project") ?? "*";
          const kind = targetId === "*" ? "global" : "project";
          await setCanonicalAssignment(bundle.id, kind, targetId, argv[0] === "assign");
          const report = await serialize(() => projectEverything("cli"));
          const scope = kind === "project" ? `project ${targetId}` : "global";
          return { exitCode: 0, stdout: `${bundle.name} ${argv[0] === "assign" ? "assigned to" : "unassigned from"} ${scope}. ${report.machine.skillCount} global skills projected.\n` };
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
        return { exitCode: 1, stderr: "Usage: bb catalog <list [--json]|add <name> <https-url> [--ref <git-ref>] [--subdirectory <path>] [--review]|sync [source-id]|approve <source-id>|skills [--source <name>] [--json]|enable <skill-id>|disable <skill-id>|assign <skill-set> [--project <id>]|unassign <skill-set> [--project <id>]|project>\n" };
      } catch (error) { return resultError(error); }
    },
  });

  /** Names a toolkit-map key for people: a project, an agent, a plugin, or every project. Null when its target is gone. */
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

  /**
   * Compares Catalog's toolkit map with Executor. A thread can call any of
   * its toolkits, so when two of them treat one tool differently the looser
   * rule decides; those pairs are reported, together with broken
   * connections, toolkits nothing uses, and assignments that name a missing
   * toolkit, project or agent.
   */
  async function executorOverview() {
    if (!executor) return { configured: false, url: null, error: null, toolkits: [], warnings: [] };
    try {
      await checkConnections();
      const [details, tools, scopeName] = await Promise.all([executor.client.toolkitDetails(), executor.client.listTools(), scopeNamer()]);
      const bySlug = new Map(details.map((detail) => [detail.slug, detail]));
      const warnings = Object.entries(connectionAlerts).map(([address, entry]) =>
        `Connection ${address.replace(/^tools\./u, "")} has needed attention since ${new Date(entry.since).toISOString()}: ${entry.problem}. Fix or reconnect it in Executor.`);
      for (const [key, slugs] of Object.entries(toolkitMap)) {
        const scope = scopeName(key);
        if (!scope) warnings.push(`Toolkits ${slugs.join(", ")} are assigned to ${key.startsWith(AGENT_TOOLKITS) ? "an agent" : "a project"} that no longer exists (${key}).`);
        for (const slug of slugs.filter((candidate) => !bySlug.has(candidate))) warnings.push(`${scope ?? key} uses toolkit ${slug}, which Executor does not have.`);
      }
      const assigned = (slug: string) => Object.entries(toolkitMap).filter(([, slugs]) => slugs.includes(slug)).map(([key]) => scopeName(key) ?? key);
      for (const detail of details) if (!assigned(detail.slug).length) warnings.push(`Toolkit ${detail.slug} is not assigned anywhere, so no thread can use it.`);

      // Rules replace the tool's own default; among matching rules the most restrictive wins.
      const rank = { approve: 0, require_approval: 1, block: 2 } as const;
      const effective = (detail: ToolkitDetail, tool: ExecutorTool) => {
        if (!detail.connections.some((pattern) => patternMatches(pattern, tool.address))) return null;
        const matched = detail.policies.filter((policy) => patternMatches(policy.pattern, tool.address));
        if (!matched.length) return tool.requiresApproval ? "require_approval" : "approve";
        return matched.reduce((strictest, policy) => rank[policy.action] > rank[strictest.action] ? policy : strictest).action;
      };
      const threadSets = Object.keys(toolkitMap).filter((key) => !key.startsWith(PLUGIN_TOOLKITS))
        .map((key) => key.startsWith(AGENT_TOOLKITS) ? threadToolkits("", key.slice(AGENT_TOOLKITS.length)) : threadToolkits(key === GLOBAL_TOOLKITS ? "" : key, null));
      const pairs = new Set(threadSets.flatMap((slugs) => slugs.flatMap((a, i) => slugs.slice(i + 1).map((b) => [a, b].sort().join(" ")))));
      const verb = { approve: "runs it", require_approval: "asks first", block: "blocks it" } as const;
      for (const pair of [...pairs].sort()) {
        const [a, b] = pair.split(" ").map((slug) => bySlug.get(slug)) as [ToolkitDetail | undefined, ToolkitDetail | undefined];
        if (!a || !b) continue;
        const differing = tools.flatMap((tool) => {
          const [left, right] = [effective(a, tool), effective(b, tool)];
          return left && right && left !== right ? [`${tool.address.replace(/^tools\./u, "")} (${a.slug} ${verb[left]}, ${b.slug} ${verb[right]})`] : [];
        });
        if (differing.length) warnings.push(`${a.slug} and ${b.slug} share threads but treat ${differing.length} tool${differing.length === 1 ? "" : "s"} differently, so the looser one decides: ${differing.slice(0, 3).join("; ")}${differing.length > 3 ? "; …" : ""}`);
      }
      return {
        configured: true, url: executor.url, error: null, warnings,
        toolkits: details.map((detail) => ({
          slug: detail.slug, name: detail.name,
          integrations: [...new Set(detail.connections.map((pattern) => pattern.split(".")[0]!))].sort(),
          assignedTo: assigned(detail.slug),
          tools: tools.filter((tool) => detail.connections.some((pattern) => patternMatches(pattern, tool.address))).length,
          rules: {
            approve: detail.policies.filter((policy) => policy.action === "approve").length,
            requireApproval: detail.policies.filter((policy) => policy.action === "require_approval").length,
            block: detail.policies.filter((policy) => policy.action === "block").length,
          },
        })),
      };
    } catch (error) {
      return { configured: true, url: executor.url, error: error instanceof Error ? error.message : String(error), toolkits: [], warnings: [] };
    }
  }

  async function executorCli(argv: string[]): Promise<PluginCliResult> {
    const usage = "Usage: bb catalog executor <status|configure [--url <url>] [--key-file <dotenv>]|use <toolkit>... (--project <id-or-name>|--agent <@slug-or-id>|--plugin <id>|--global)|use --clear (--project <id-or-name>|--agent <@slug-or-id>|--plugin <id>|--global)|calls [--plugin <id>] [--json]>\n";
    if (argv[0] === "configure") {
      const keyFile = cliOption(argv, "--key-file");
      const url = cliOption(argv, "--url");
      if (!keyFile && !url) return { exitCode: 1, stderr: usage };
      const apiKey = keyFile ? dotenvValue(await readFile(keyFile, "utf8"), "EXECUTOR_API_KEY") : undefined;
      if (keyFile && !apiKey) return { exitCode: 1, stderr: `${keyFile} has no EXECUTOR_API_KEY\n` };
      await executorSettings.experimental_set({ ...(url ? { executorUrl: normalizeExecutorUrl(url) } : {}), ...(apiKey ? { executorApiKey: apiKey } : {}) });
      await loadExecutor();
      if (!executor) return { exitCode: 1, stderr: "Executor needs both a URL and an API key.\n" };
      await executor.client.listToolkits();
      return { exitCode: 0, stdout: `Executor at ${executor.url} is reachable with the stored key.${keyFile ? ` You can delete ${keyFile}.` : ""}\n` };
    }
    if (argv[0] === "use") {
      return queueToolkitWrite(async () => {
        const projectRef = cliOption(argv, "--project");
        const agentRef = cliOption(argv, "--agent");
        const pluginRef = cliOption(argv, "--plugin");
        if ([projectRef, agentRef, pluginRef, argv.includes("--global") || undefined].filter(Boolean).length !== 1) return { exitCode: 1, stderr: usage };
        if (agentRef && !preferences.agentsIntegration) return { exitCode: 1, stderr: "Enable Agents in Executor settings → Oh My BB before choosing an agent toolkit scope.\n" };
        if (pluginRef && !pluginCallerSchema.safeParse(pluginRef).success) return { exitCode: 1, stderr: `Not a plugin ID: ${pluginRef}\n` };
        const project = projectRef ? (await bb.sdk.projects.list()).find((candidate) => candidate.id === projectRef || candidate.name === projectRef) : null;
        if (projectRef && !project) return { exitCode: 1, stderr: `Unknown project: ${projectRef}\n` };
        const agent = agentRef ? (await agentProfiles()).find((candidate) => candidate.id === agentRef || candidate.slug === agentRef.replace(/^@/u, "")) : null;
        if (agentRef && !agent) return { exitCode: 1, stderr: `Unknown agent: ${agentRef}\n` };
        const key = project?.id ?? (agent ? AGENT_TOOLKITS + agent.id : pluginRef ? PLUGIN_TOOLKITS + pluginRef : GLOBAL_TOOLKITS);
        const slugs = argv.slice(1).filter((value, index, all) => !value.startsWith("--") && !["--project", "--agent", "--plugin"].includes(all[index - 1]!));
        if (!argv.includes("--clear") && !slugs.length) return { exitCode: 1, stderr: usage };
        await saveExecutorToolkits(key, argv.includes("--clear") ? [] : slugs);
        const scope = project ? project.name : agent ? `agent @${agent.slug}` : pluginRef ? `plugin ${pluginRef}` : "every project";
        return { exitCode: 0, stdout: `${scope}: ${toolkitMap[key]?.join(", ") ?? "no Executor toolkits"}\n` };
      });
    }
    if (argv[0] === "status" || argv.length === 0) {
      if (!executor) return { exitCode: 0, stdout: "Executor is not configured.\n" };
      await refreshToolkitIntegrations();
      const [connections, scopeName, overview] = await Promise.all([executor.client.listConnections(), scopeNamer(), executorOverview()]);
      const lines = [
        `url\t${executor.url}`,
        ...connections.map((connection) => `connection\t${connection.address.replace(/^tools\./u, "")}\t${connection.lastHealth?.status ?? "unknown"}`),
        ...Object.entries(toolkitMap).map(([key, slugs]) => `toolkits\t${scopeName(key) ?? key}\t${slugs.map((slug) => toolkitIntegrations.has(slug) ? `${slug} (${toolkitIntegrations.get(slug)!.join(", ") || "empty"})` : `${slug} (missing)`).join("; ")}`),
        ...overview.warnings.map((warning) => `warning\t${warning}`),
        ...(overview.error ? [`warning\tCould not compare toolkits: ${overview.error}`] : []),
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
    return { exitCode: 1, stderr: usage };
  }

  for (const source of store.listSources()) store.ensurePackageBundle(source.id);

  bb.events.on("thread.created", async ({ thread }) => {
    if (preferences.agentsIntegration && executor && Object.keys(toolkitMap).some((key) => key.startsWith(AGENT_TOOLKITS))) void warmThreadAgent(thread);
    if (!thread.environmentId) return;
    const workspace = await readyWorkspace(thread.environmentId, 10);
    if (workspace) await queueProjection("thread-created", () => projectWorkspace(workspace));
  });


  bb.log.info("loaded");
}
