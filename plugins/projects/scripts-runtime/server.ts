import { defineRpcContract, type BbPluginApi, type ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract } from "./host-contract.js";
import { registerAgentSetup } from "./agent-setup.js";
import { agentSetupConfigSchema, setupApprovalDigest, setupRecipeSchema } from "./setup-contract.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const commandTextSchema = z.string().trim().min(1).max(10_000);
const paseoHookSchema = z
  .union([commandTextSchema, z.array(commandTextSchema).min(1).max(50)])
  .transform((value) => Array.isArray(value) ? ["set -e", ...value].join("\n") : value)
  .pipe(commandTextSchema);
const paseoScriptSchema = z
  .object({
    command: commandTextSchema,
    type: z.enum(["command", "service"]).optional(),
    description: z.string().trim().max(500).optional(),
  })
  .passthrough();
const paseoTerminalSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    command: commandTextSchema,
  })
  .passthrough();
const paseoManifestSchema = z
  .object({
    worktree: z
      .object({
        setup: paseoHookSchema.optional(),
        teardown: paseoHookSchema.optional(),
        terminals: z.array(paseoTerminalSchema).max(50).optional(),
      })
      .passthrough()
      .optional(),
    scripts: z.record(z.string().trim().min(1).max(100), paseoScriptSchema).optional(),
  })
  .passthrough();
const portSchema = z.number().int().min(1).max(65_535);
const repositorySetupSchema = z.object({
  configuredAt: z.iso.date().optional(),
  verified: z.boolean().optional(),
  verifiedAt: z.iso.date().optional(),
}).refine((status) => status.verified !== true || status.verifiedAt !== undefined, {
  message: "verified repository setup requires verifiedAt",
});
const bbManifestSchema = paseoManifestSchema.extend({
  agentSetup: agentSetupConfigSchema.optional(),
  repositorySetup: repositorySetupSchema.optional(),
  scripts: z.record(z.string().trim().min(1).max(100), paseoScriptSchema.extend({
    port: portSchema.optional(),
  }).refine((script) => script.port === undefined || script.type === "service", {
    message: "port is only supported for services",
  })).optional(),
  worktree: paseoManifestSchema.shape.worktree.unwrap().extend({
    terminals: z.array(paseoTerminalSchema.extend({ port: portSchema.optional() })).max(50).optional(),
  }).optional(),
});

export type HookPhase = "setup" | "teardown";
type HookSource = "native" | "bb.json" | "paseo.json";
type ScriptType = "command" | "service";
type ScriptSource = "script" | "worktree-terminal";

interface WorkspaceHook {
  source: HookSource;
  command: string;
}

interface WorkspaceAction {
  id: string;
  name: string;
  command: string;
  description: string | null;
  type: ScriptType;
  source: ScriptSource;
  autostart: boolean;
  port: number | null;
  preparation?: z.infer<typeof setupRecipeSchema>;
}

interface WorkspaceDefinition {
  manifestFound: boolean;
  manifestFile: "bb.json" | "paseo.json" | null;
  setup: WorkspaceHook | null;
  teardown: WorkspaceHook | null;
  actions: WorkspaceAction[];
}

interface WorkspaceContext {
  threadId: string;
  projectId: string;
  environmentId: string;
  hostId: string;
  workspacePath: string;
  sourceCheckoutPath: string;
  branchName: string;
}

const runRecordSchema = z.object({
  terminalId: z.string().min(1),
  environmentId: z.string().min(1),
  threadId: z.string().min(1),
  hostId: z.string().min(1),
  workspacePath: z.string().min(1),
  actionId: z.string().min(1),
  port: z.number().int().min(1).max(65_535).nullable(),
  startedAt: z.number(),
});
type RunRecord = z.infer<typeof runRecordSchema>;
const runStatusSchema = z.enum(["not-run", "starting", "running", "disconnected", "exited", "unknown"]);
type ActionRun = {
  record: RunRecord | null;
  status: z.infer<typeof runStatusSchema>;
  exitCode: number | null;
  closeReason: string | null;
  portState: "listening" | "closed" | "unknown" | null;
};
type InspectionCache = {
  definitions: Map<string, Promise<WorkspaceDefinition>>;
  services: Map<string, Promise<ActionRun>>;
};

const actionViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  description: z.string().nullable(),
  type: z.enum(["command", "service"]),
  source: z.enum(["script", "worktree-terminal"]),
  autostart: z.boolean(),
  status: runStatusSchema,
  exitCode: z.number().nullable(),
  closeReason: z.string().nullable(),
  portState: z.enum(["listening", "closed", "unknown"]).nullable(),
  terminalId: z.string().nullable(),
  port: z.number().int().min(1).max(65_535).nullable(),
});
export type ScriptActionView = z.infer<typeof actionViewSchema>;
const hookViewSchema = z.object({ source: z.enum(["native", "bb.json", "paseo.json"]) });
const inspectResultSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    workspacePath: z.string(),
    manifestFound: z.boolean(),
    manifestFile: z.enum(["bb.json", "paseo.json"]).nullable(),
    setup: hookViewSchema.nullable(),
    teardown: hookViewSchema.nullable(),
    actions: z.array(actionViewSchema),
  }),
  z.object({
    available: z.literal(false),
    message: z.string(),
  }),
]);
export type InspectResult = z.infer<typeof inspectResultSchema>;
const launchResultSchema = z.object({
  terminalId: z.string(),
  title: z.string(),
  service: z.boolean(),
  reused: z.boolean(),
  port: z.number().int().min(1).max(65_535).nullable(),
});
export const rpcContract = defineRpcContract({
  inspect: {
    input: z.object({ threadId: z.string().min(1) }),
    output: inspectResultSchema,
  },
  inspectMany: {
    input: z.object({ threadIds: z.array(z.string().min(1)).max(100) }).strict(),
    output: z.record(z.string(), inspectResultSchema),
  },
  run: {
    input: z.object({ threadId: z.string().min(1), actionId: z.string().min(1) }),
    output: launchResultSchema,
  },
  runHook: {
    input: z.object({ threadId: z.string().min(1), phase: z.enum(["setup", "teardown"]) }),
    output: launchResultSchema,
  },
  stopService: {
    input: z.object({ threadId: z.string().min(1), actionId: z.string().min(1) }),
    output: z.object({ stopped: z.boolean() }),
  },
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
  return /(?:ENOENT|not found|does not exist|404)/iu.test(errorMessage(error));
}
function isMissingTerminal(error: unknown): boolean {
  return /\b(?:terminal(?:\s+\S+)?\s+(?:was\s+)?not found|unknown terminal|terminal\b.*does not exist)\b/iu.test(errorMessage(error));
}
function isWorkspaceUnavailable(error: unknown): boolean {
  return /(?:has no environment|has no workspace path|environment is .+, not ready|host is not connected|host_unavailable)/iu
    .test(errorMessage(error));
}

function workspaceUnavailableMessage(error: unknown): string {
  return /(?:host is not connected|host_unavailable)/iu.test(errorMessage(error))
    ? "This workspace host is offline."
    : errorMessage(error);
}

function hostPath(workspacePath: string, name: string): string {
  return `${workspacePath.replace(/[\\/]$/u, "")}/${name}`;
}

async function readOptionalText(
  bb: BbPluginApi,
  hostId: string,
  workspacePath: string,
  relativePath: string,
): Promise<string | null> {
  try {
    const file = await bb.sdk.files.read({
      hostId,
      rootPath: workspacePath,
      path: hostPath(workspacePath, relativePath),
    });
    return file.contentEncoding === "base64"
      ? Buffer.from(file.content, "base64").toString("utf8")
      : file.content;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export function parseWorkspaceManifest(content: string, file: "bb.json" | "paseo.json") {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${errorMessage(error)}`);
  }
  const parsed = (file === "bb.json" ? bbManifestSchema : paseoManifestSchema).safeParse(value);
  if (!parsed.success) {
    throw new Error(`${file} is invalid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

async function previewAgentSetup(bb: BbPluginApi, environmentId: string) {
  const environment = await bb.sdk.environments.get({ environmentId });
  if (environment.status !== "ready" || !environment.path) throw new Error("Choose a ready workspace");
  const text = await readOptionalText(bb, environment.hostId, environment.path, "bb.json");
  if (text === null) throw new Error("Add agentSetup to bb.json in this workspace");
  const manifest = parseWorkspaceManifest(text, "bb.json");
  if (!manifest.agentSetup) throw new Error("Add agentSetup to bb.json in this workspace");
  const config = agentSetupConfigSchema.parse(manifest.agentSetup);
  const script = manifest.scripts?.[config.script];
  if (!script || script.type === "service") throw new Error("agentSetup.script must name a one-shot script");
  const recipe = setupRecipeSchema.parse({ name: config.script, script: config.script, command: script.command, env: config.env });
  return { environmentId, hostId: environment.hostId, workspacePath: environment.path, recipe, digest: setupApprovalDigest(environment.hostId, environment.path, recipe) };
}

async function readWorkspaceDefinition(
  bb: BbPluginApi,
  hostId: string,
  workspacePath: string,
): Promise<WorkspaceDefinition> {
  const [nativeSetup, nativeTeardown, bbText] = await Promise.all([
    readOptionalText(bb, hostId, workspacePath, ".bb-env-setup.sh"),
    readOptionalText(bb, hostId, workspacePath, ".bb-env-teardown.sh"),
    readOptionalText(bb, hostId, workspacePath, "bb.json"),
  ]);
  const text = bbText ?? await readOptionalText(bb, hostId, workspacePath, "paseo.json");
  const manifestFile = text === null ? null : bbText !== null ? "bb.json" : "paseo.json";
  const manifest = text === null ? null : parseWorkspaceManifest(text, manifestFile!);
  const actions: WorkspaceAction[] = [];
  const agentSetup = manifestFile === "bb.json" && manifest?.agentSetup
    ? agentSetupConfigSchema.parse(manifest.agentSetup) : null;

  for (const [name, script] of Object.entries(manifest?.scripts ?? {})) {
    actions.push({
      id: `script:${name}`,
      name,
      command: script.command,
      description: script.description ?? null,
      type: script.type ?? "command",
      source: "script",
      autostart: false,
      port: manifestFile === "bb.json" && typeof script.port === "number" ? script.port : null,
      ...(agentSetup?.script === name ? {
        preparation: setupRecipeSchema.parse({ name, script: name, command: script.command, env: agentSetup.env }),
      } : {}),
    });
  }
  for (const [index, terminal] of (manifest?.worktree?.terminals ?? []).entries()) {
    actions.push({
      id: `worktree-terminal:${index}:${terminal.name}`,
      name: terminal.name,
      command: terminal.command,
      description: null,
      type: "service",
      source: "worktree-terminal",
      autostart: true,
      port: manifestFile === "bb.json" && typeof terminal.port === "number" ? terminal.port : null,
    });
  }

  return {
    manifestFound: manifest !== null,
    manifestFile,
    setup:
      nativeSetup !== null
        ? { source: "native", command: `env bash ${shellQuote(hostPath(workspacePath, ".bb-env-setup.sh"))}` }
        : manifest?.worktree?.setup
          ? { source: manifestFile!, command: manifest.worktree.setup }
          : null,
    teardown:
      nativeTeardown !== null
        ? { source: "native", command: `env bash ${shellQuote(hostPath(workspacePath, ".bb-env-teardown.sh"))}` }
        : manifest?.worktree?.teardown
          ? { source: manifestFile!, command: manifest.worktree.teardown }
          : null,
    actions,
  };
}

async function contextForThread(bb: BbPluginApi, threadId: string): Promise<WorkspaceContext> {
  const thread = await bb.sdk.threads.get({ threadId });
  if (!thread.environmentId) throw new Error("This thread has no environment");
  const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
  if (!environment.path) throw new Error("This environment has no workspace path");
  if (environment.status !== "ready") {
    throw new Error(`This environment is ${environment.status}, not ready`);
  }
  return {
    threadId,
    projectId: thread.projectId,
    environmentId: environment.id,
    hostId: environment.hostId,
    workspacePath: environment.path,
    sourceCheckoutPath: environment.path,
    branchName: environment.branchName ?? "",
  };
}

function runKey(context: WorkspaceContext, action: Pick<WorkspaceAction, "id" | "type">): string {
  return action.type === "service"
    ? `service:${context.environmentId}:${encodeURIComponent(action.id)}`
    : `run:${context.environmentId}:${context.threadId}:${encodeURIComponent(action.id)}`;
}

async function readRunRecord(bb: BbPluginApi, key: string) {
  const raw = await bb.storage.kv.get<unknown>(key);
  if (raw === undefined) return null;
  const parsed = runRecordSchema.safeParse(raw);
  if (!parsed.success) {
    await bb.storage.kv.delete(key);
    return null;
  }
  return parsed.data;
}

async function actionRun(bb: BbPluginApi, context: WorkspaceContext, action: Pick<WorkspaceAction, "id" | "type">): Promise<ActionRun> {
  const record = await readRunRecord(bb, runKey(context, action));
  const view: ActionRun = { record, status: "not-run", exitCode: null, closeReason: null, portState: null };
  if (!record) return view;
  try {
    const terminal = await bb.sdk.terminals.get({ terminalId: record.terminalId });
    view.status = terminal.status;
    view.exitCode = terminal.exitCode;
    view.closeReason = terminal.closeReason;
  } catch (error) {
    view.status = isMissingTerminal(error) ? "exited" : "unknown";
    if (view.status === "unknown" && record.port !== null) view.portState = "unknown";
    return view;
  }
  if (record.port !== null && (view.status === "running" || view.status === "starting")) {
    try {
      const result = await hostClient(bb).call("probe_port", { port: record.port }, { hostId: context.hostId, timeoutMs: 2_000 });
      view.portState = result.state;
    } catch {
      view.portState = "unknown";
    }
  } else if (record.port !== null && view.status === "disconnected") {
    view.portState = "unknown";
  }
  return view;
}

async function closeWorkspaceServices(
  bb: BbPluginApi,
  hostId: string,
  workspacePath: string,
): Promise<void> {
  for (const key of await bb.storage.kv.list("service:")) {
    const raw = await bb.storage.kv.get<unknown>(key);
    const parsed = runRecordSchema.safeParse(raw);
    if (!parsed.success) {
      await bb.storage.kv.delete(key);
      continue;
    }
    if (parsed.data.hostId !== hostId || parsed.data.workspacePath !== workspacePath) continue;
    try {
      await bb.sdk.terminals.close({ terminalId: parsed.data.terminalId, mode: "force" });
    } catch (error) {
      if (!isMissingTerminal(error)) throw error;
    }
  }
}


const hostClients = new WeakMap<BbPluginApi, ExperimentalHostClient<typeof hostContract>>();
const serviceLaunches = new WeakMap<BbPluginApi, Map<string, Promise<z.infer<typeof launchResultSchema>>>>();

function hostClient(bb: BbPluginApi) {
  let client = hostClients.get(bb);
  if (!client) {
    client = bb.hosts.experimental_client({ contract: hostContract });
    hostClients.set(bb, client);
  }
  return client;
}

async function allocatePort(
  bb: BbPluginApi,
  context: Pick<WorkspaceContext, "hostId">,
): Promise<number> {
  const { port } = await hostClient(bb).call("allocate_port", {}, { hostId: context.hostId, timeoutMs: 15_000 });
  return port;
}

function hookCommand(
  hook: WorkspaceHook,
  context: Pick<WorkspaceContext, "sourceCheckoutPath" | "workspacePath" | "branchName">,
): string {
  return [
    `export PASEO_SOURCE_CHECKOUT_PATH=${shellQuote(context.sourceCheckoutPath)}`,
    `export PASEO_WORKTREE_PATH=${shellQuote(context.workspacePath)}`,
    `export PASEO_BRANCH_NAME=${shellQuote(context.branchName)}`,
    hook.command,
  ].join("\n");
}

function serviceCommand(command: string, port: number | null): string {
  const environment = [`export HOST=${shellQuote("127.0.0.1")}`];
  if (port !== null) {
    environment.push(`export BB_PORT=${port}`, `export PASEO_PORT=${port}`, `export PASEO_WORKTREE_PORT=${port}`);
  }
  return [...environment, command].join("\n");
}

async function launchAction(bb: BbPluginApi, context: WorkspaceContext, action: WorkspaceAction) {
  if (action.type !== "service") return createActionTerminal(bb, context, action);
  let pending = serviceLaunches.get(bb);
  if (!pending) {
    pending = new Map();
    serviceLaunches.set(bb, pending);
  }
  const key = runKey(context, action);
  const existing = pending.get(key);
  if (existing) return { ...await existing, reused: true };
  const launch = createActionTerminal(bb, context, action);
  pending.set(key, launch);
  try {
    return await launch;
  } finally {
    pending.delete(key);
  }
}

async function createActionTerminal(
  bb: BbPluginApi,
  context: WorkspaceContext,
  action: WorkspaceAction,
): Promise<z.infer<typeof launchResultSchema>> {
  const title = `${action.type === "service" ? "Service" : "Script"} · ${action.name}`;
  if (action.type === "service") {
    const existing = await actionRun(bb, context, action);
    if (existing.status === "unknown" || existing.status === "disconnected") {
      throw new Error("Reconnect the workspace before starting this service; its current state is unknown.");
    }
    if (existing.record && (existing.status === "running" || existing.status === "starting")) {
      return {
        terminalId: existing.record.terminalId,
        title,
        service: true,
        reused: true,
        port: existing.record.port,
      };
    }
  }

  const port = action.type === "service"
    ? action.port ?? (/\$(?:\{)?(?:BB_PORT|PASEO_(?:WORKTREE_)?PORT)(?![A-Za-z0-9_])/u.test(action.command)
      ? await allocatePort(bb, context) : null)
    : null;
  let command = action.type === "service" ? serviceCommand(action.command, port) : action.command;
  if (action.preparation) {
    if (action.type === "service") throw new Error("agentSetup.script must name a one-shot script");
    const staged = await hostClient(bb).call("stage_setup", { cwd: context.workspacePath, recipe: action.preparation }, { hostId: context.hostId, timeoutMs: 3_000 });
    command = `python3 ${shellQuote(staged.setupScript)}`;
  }
  const terminal = await bb.sdk.terminals.create({
    cols: 120,
    rows: 40,
    scope:
      action.type === "service"
        ? { kind: "environment", environmentId: context.environmentId }
        : { kind: "thread", threadId: context.threadId },
    start: {
      mode: "command",
      command,
    },
    title,
  });

  await bb.storage.kv.set(runKey(context, action), {
    terminalId: terminal.id,
    environmentId: context.environmentId,
    threadId: context.threadId,
    hostId: context.hostId,
    workspacePath: context.workspacePath,
    actionId: action.id,
    port,
    startedAt: Date.now(),
  } satisfies RunRecord);

  bb.realtime.publish("workspace-scripts", {
    type: "changed",
    environmentId: context.environmentId,
  });
  return {
    terminalId: terminal.id,
    title,
    service: action.type === "service",
    reused: false,
    port,
  };
}

async function inspect(bb: BbPluginApi, threadId: string, cache?: InspectionCache): Promise<InspectResult> {
  try {
    const context = await contextForThread(bb, threadId);
    let definitionPromise = cache?.definitions.get(context.environmentId);
    if (!definitionPromise) {
      definitionPromise = readWorkspaceDefinition(bb, context.hostId, context.workspacePath);
      cache?.definitions.set(context.environmentId, definitionPromise);
    }
    const definition = await definitionPromise;
    const actions = await Promise.all(definition.actions.map(async (action) => {
      const key = runKey(context, action);
      let statePromise = action.type === "service" ? cache?.services.get(key) : undefined;
      if (!statePromise) {
        statePromise = actionRun(bb, context, action);
        if (action.type === "service") cache?.services.set(key, statePromise);
      }
      const state = await statePromise;
      return {
        ...action,
        status: state.status,
        exitCode: state.exitCode,
        closeReason: state.closeReason,
        terminalId: state.record?.terminalId ?? null,
        port: state.record?.port ?? action.port,
        portState: state.portState,
      };
    }));
    return {
      available: true as const,
      workspacePath: context.workspacePath,
      manifestFound: definition.manifestFound,
      manifestFile: definition.manifestFile,
      setup: definition.setup ? { source: definition.setup.source } : null,
      teardown: definition.teardown ? { source: definition.teardown.source } : null,
      actions,
    };
  } catch (error) {
    if (!isWorkspaceUnavailable(error)) throw error;
    return {
      available: false as const,
      message: workspaceUnavailableMessage(error),
    };
  }
}

async function runAction(bb: BbPluginApi, threadId: string, actionId: string) {
  const context = await contextForThread(bb, threadId);
  const definition = await readWorkspaceDefinition(bb, context.hostId, context.workspacePath);
  const action = definition.actions.find((candidate) => candidate.id === actionId);
  if (!action) throw new Error(`Workspace script ${actionId} was not found`);
  return launchAction(bb, context, action);
}

async function runHookInTerminal(bb: BbPluginApi, threadId: string, phase: HookPhase) {
  const context = await contextForThread(bb, threadId);
  const definition = await readWorkspaceDefinition(bb, context.hostId, context.workspacePath);
  const hook = definition[phase];
  if (!hook) throw new Error(`This workspace has no ${phase} hook`);
  if (phase === "teardown") {
    await closeWorkspaceServices(bb, context.hostId, context.workspacePath);
  }
  const title = `Workspace ${phase}`;
  const terminal = await bb.sdk.terminals.create({
    cols: 120,
    rows: 40,
    scope: { kind: "thread", threadId },
    start: { mode: "command", command: hookCommand(hook, context) },
    title,
  });
  return { terminalId: terminal.id, title, service: false, reused: false, port: null };
}

async function stopService(bb: BbPluginApi, threadId: string, actionId: string) {
  const context = await contextForThread(bb, threadId);
  const state = await actionRun(bb, context, { id: actionId, type: "service" });
  if (!state.record || state.status === "exited" || state.status === "not-run") return { stopped: false };
  try {
    await bb.sdk.terminals.close({ terminalId: state.record.terminalId, mode: "force" });
  } catch (error) {
    if (!isMissingTerminal(error)) throw error;
    return { stopped: false };
  }
  bb.realtime.publish("workspace-scripts", {
    type: "changed",
    environmentId: context.environmentId,
  });
  return { stopped: true };
}

async function startWorkspaceServices(bb: BbPluginApi, threadId: string) {
  const context = await contextForThread(bb, threadId);
  const definition = await readWorkspaceDefinition(bb, context.hostId, context.workspacePath);
  const terminals: z.infer<typeof launchResultSchema>[] = [];
  for (const action of definition.actions.filter((candidate) => candidate.autostart)) {
    terminals.push(await launchAction(bb, context, action));
  }
  return { terminals };
}

export default function plugin(bb: BbPluginApi) {
  const agentSetup = registerAgentSetup(bb, environmentId => previewAgentSetup(bb, environmentId));
  const settings = bb.settings.define({
    autoStartServices: {
      type: "boolean",
      label: "Start workspace services automatically",
      description: "Start declared worktree terminals when a thread's workspace becomes active.",
      default: true,
    },
  });
  bb.rpc.register(rpcContract, {
    inspect: ({ threadId }) => inspect(bb, threadId),
    inspectMany: async ({ threadIds }) => {
      const cache: InspectionCache = { definitions: new Map(), services: new Map() };
      const entries = await Promise.all([...new Set(threadIds)].map(async (threadId) => {
        try { return [threadId, await inspect(bb, threadId, cache)] as const; }
        catch (error) { return [threadId, { available: false as const, message: errorMessage(error) }] as const; }
      }));
      return Object.fromEntries(entries);
    },
    run: ({ threadId, actionId }) => runAction(bb, threadId, actionId),
    runHook: ({ threadId, phase }) => runHookInTerminal(bb, threadId, phase),
    stopService: ({ threadId, actionId }) => stopService(bb, threadId, actionId),
  });

  // BB 0.43 core runs .bb-env-setup.sh / .bb-env-teardown.sh on the environment
  // lifecycle itself, so this plugin no longer runs setup/teardown hooks. It
  // still owns repository-declared services, which core has no concept of:
  // auto-start declared worktree terminals once the thread's workspace is
  // active (running services are reused, never duplicated).
  bb.events.on("thread.active", async ({ thread }) => {
    if (!(await settings.get()).autoStartServices) return;
    try {
      await startWorkspaceServices(bb, thread.id);
    } catch (error) {
      if (!isWorkspaceUnavailable(error) && !isMissingFile(error)) {
        bb.log.warn(`workspace-scripts autostart failed: ${errorMessage(error)}`);
      }
    }
  });

  bb.cli.register({
    name: "workspace-scripts",
    summary: "Inspect and run scripts declared by the current workspace",
    commands: [
      { name: "list", summary: "List workspace scripts", usage: "bb projects scripts list" },
      { name: "run", summary: "Run a workspace script", usage: "bb projects scripts run <script-name>" },
      { name: "setup", summary: "Run workspace setup", usage: "bb projects scripts setup" },
      { name: "teardown", summary: "Run workspace teardown", usage: "bb projects scripts teardown" },
      { name: "stop", summary: "Stop a workspace service", usage: "bb projects scripts stop <script-name>" },
      { name: "prepare", summary: "Wait for the named preparation script", usage: "bb projects scripts prepare" },
      { name: "agent-setup", summary: "Configure approved agent setup", usage: "bb projects scripts agent-setup <list|enable <agent>|disable <agent>>" },
    ],
    async run(argv, context) {
      if (argv[0] === "agent-setup") {
        try { return await agentSetup.cli(argv, context.threadId); }
        catch (error) { return { exitCode: 2, stderr: `${errorMessage(error)}\n` }; }
      }
      if (!context.threadId) {
        return { exitCode: 2, stderr: "Run this command from a BB thread.\n" };
      }
      try {
        if (argv[0] === "prepare") return await agentSetup.prepare(context.threadId, context.signal);
        if (argv[0] === "list") {
          const result = await inspect(bb, context.threadId);
          if (!result.available) {
            return { exitCode: 2, stderr: `${result.message}\n` };
          }
          const lines = result.actions.map((action) =>
            `${action.name}\t${action.type}\t${action.status}${action.exitCode === null ? "" : ` (${action.exitCode})`}${action.port === null ? "" : `\tport ${action.port} (${action.portState ?? "assigned"})`}`,
          );
          return { exitCode: 0, stdout: `${lines.join("\n")}${lines.length ? "\n" : ""}` };
        }
        if (argv[0] === "setup" || argv[0] === "teardown") {
          const result = await runHookInTerminal(bb, context.threadId, argv[0]);
          return { exitCode: 0, stdout: `${result.title} started in terminal ${result.terminalId}.\n` };
        }
        if ((argv[0] === "run" || argv[0] === "stop") && argv[1]) {
          const snapshot = await inspect(bb, context.threadId);
          if (!snapshot.available) {
            return { exitCode: 2, stderr: `${snapshot.message}\n` };
          }
          const action = snapshot.actions.find((candidate) => candidate.name === argv[1] || candidate.id === argv[1]);
          if (!action) throw new Error(`Workspace script ${argv[1]} was not found`);
          if (argv[0] === "stop") {
            const result = await stopService(bb, context.threadId, action.id);
            return { exitCode: 0, stdout: result.stopped ? "Service stopped.\n" : "Service was not running.\n" };
          }
          const result = await runAction(bb, context.threadId, action.id);
          return { exitCode: 0, stdout: `${result.title} ${result.reused ? "is already running" : `started in terminal ${result.terminalId}`}.\n` };
        }
        return { exitCode: 2, stderr: "Usage: bb projects scripts <list|run <name>|prepare|setup|teardown|stop <name>|agent-setup>\n" };
      } catch (error) {
        return { exitCode: 1, stderr: `${errorMessage(error)}\n` };
      }
    },
  });
}
