import { defineRpcContract, type BbPluginApi, type ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract } from "./host-contract.js";

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

export type HookPhase = "setup" | "teardown";
type HookSource = "bb" | "paseo";
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
}

interface WorkspaceDefinition {
  manifestFound: boolean;
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

const serviceRecordSchema = z.object({
  terminalId: z.string().min(1),
  environmentId: z.string().min(1),
  threadId: z.string().min(1),
  hostId: z.string().min(1),
  workspacePath: z.string().min(1),
  actionId: z.string().min(1),
  port: z.number().int().min(1).max(65_535).nullable(),
  startedAt: z.number(),
});
type ServiceRecord = z.infer<typeof serviceRecordSchema>;

const actionViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  description: z.string().nullable(),
  type: z.enum(["command", "service"]),
  source: z.enum(["script", "worktree-terminal"]),
  autostart: z.boolean(),
  running: z.boolean(),
  terminalId: z.string().nullable(),
  port: z.number().int().min(1).max(65_535).nullable(),
});
const hookViewSchema = z.object({ source: z.enum(["bb", "paseo"]) });
const inspectResultSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    workspacePath: z.string(),
    manifestFound: z.boolean(),
    setup: hookViewSchema.nullable(),
    teardown: hookViewSchema.nullable(),
    actions: z.array(actionViewSchema),
  }),
  z.object({
    available: z.literal(false),
    message: z.string(),
  }),
]);
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

export function parsePaseoManifest(content: string): z.infer<typeof paseoManifestSchema> {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`paseo.json is not valid JSON: ${errorMessage(error)}`);
  }
  const parsed = paseoManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`paseo.json is invalid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

async function readWorkspaceDefinition(
  bb: BbPluginApi,
  hostId: string,
  workspacePath: string,
): Promise<WorkspaceDefinition> {
  const [nativeSetup, nativeTeardown, paseoText] = await Promise.all([
    readOptionalText(bb, hostId, workspacePath, ".bb-env-setup.sh"),
    readOptionalText(bb, hostId, workspacePath, ".bb-env-teardown.sh"),
    readOptionalText(bb, hostId, workspacePath, "paseo.json"),
  ]);
  const paseo = paseoText === null ? null : parsePaseoManifest(paseoText);
  const actions: WorkspaceAction[] = [];

  for (const [name, script] of Object.entries(paseo?.scripts ?? {})) {
    actions.push({
      id: `script:${name}`,
      name,
      command: script.command,
      description: script.description ?? null,
      type: script.type ?? "command",
      source: "script",
      autostart: false,
    });
  }
  for (const [index, terminal] of (paseo?.worktree?.terminals ?? []).entries()) {
    actions.push({
      id: `worktree-terminal:${index}:${terminal.name}`,
      name: terminal.name,
      command: terminal.command,
      description: null,
      type: "service",
      source: "worktree-terminal",
      autostart: true,
    });
  }

  return {
    manifestFound: paseo !== null,
    setup:
      nativeSetup !== null
        ? { source: "bb", command: `env bash ${shellQuote(hostPath(workspacePath, ".bb-env-setup.sh"))}` }
        : paseo?.worktree?.setup
          ? { source: "paseo", command: paseo.worktree.setup }
          : null,
    teardown:
      nativeTeardown !== null
        ? { source: "bb", command: `env bash ${shellQuote(hostPath(workspacePath, ".bb-env-teardown.sh"))}` }
        : paseo?.worktree?.teardown
          ? { source: "paseo", command: paseo.worktree.teardown }
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

function serviceKey(environmentId: string, actionId: string): string {
  return `service:${environmentId}:${encodeURIComponent(actionId)}`;
}

async function readServiceRecord(
  bb: BbPluginApi,
  environmentId: string,
  actionId: string,
): Promise<ServiceRecord | null> {
  const raw = await bb.storage.kv.get<unknown>(serviceKey(environmentId, actionId));
  if (raw === undefined) return null;
  const parsed = serviceRecordSchema.safeParse(raw);
  if (!parsed.success) {
    await bb.storage.kv.delete(serviceKey(environmentId, actionId));
    return null;
  }
  return parsed.data;
}

async function activeServiceRecord(
  bb: BbPluginApi,
  environmentId: string,
  actionId: string,
): Promise<ServiceRecord | null> {
  const record = await readServiceRecord(bb, environmentId, actionId);
  if (record === null) return null;
  const terminal = await bb.sdk.terminals
    .get({ terminalId: record.terminalId })
    .catch(() => null);
  if (terminal && terminal.status !== "exited") return record;
  await bb.storage.kv.delete(serviceKey(environmentId, actionId));
  return null;
}

async function closeWorkspaceServices(
  bb: BbPluginApi,
  hostId: string,
  workspacePath: string,
): Promise<void> {
  for (const key of await bb.storage.kv.list("service:")) {
    const raw = await bb.storage.kv.get<unknown>(key);
    const parsed = serviceRecordSchema.safeParse(raw);
    if (!parsed.success) {
      await bb.storage.kv.delete(key);
      continue;
    }
    if (parsed.data.hostId !== hostId || parsed.data.workspacePath !== workspacePath) continue;
    await bb.sdk.terminals
      .close({ terminalId: parsed.data.terminalId, mode: "force" })
      .catch(() => undefined);
    await bb.storage.kv.delete(key);
  }
}


const hostClients = new WeakMap<BbPluginApi, ExperimentalHostClient<typeof hostContract>>();

async function allocatePort(
  bb: BbPluginApi,
  context: Pick<WorkspaceContext, "hostId">,
): Promise<number> {
  let client = hostClients.get(bb);
  if (!client) {
    client = bb.hosts.experimental_client({ contract: hostContract });
    hostClients.set(bb, client);
  }
  const { port } = await client.call("allocate_port", {}, { hostId: context.hostId, timeoutMs: 15_000 });
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
    environment.push(`export PASEO_PORT=${port}`, `export PASEO_WORKTREE_PORT=${port}`);
  }
  return [...environment, command].join("\n");
}

async function launchAction(
  bb: BbPluginApi,
  context: WorkspaceContext,
  action: WorkspaceAction,
): Promise<z.infer<typeof launchResultSchema>> {
  const title = `${action.type === "service" ? "Service" : "Script"} · ${action.name}`;
  if (action.type === "service") {
    const existing = await activeServiceRecord(bb, context.environmentId, action.id);
    if (existing !== null) {
      return {
        terminalId: existing.terminalId,
        title,
        service: true,
        reused: true,
        port: existing.port,
      };
    }
  }

  const port =
    action.type === "service" &&
    /\$(?:\{)?PASEO_(?:WORKTREE_)?PORT(?:\})?/u.test(action.command)
      ? await allocatePort(bb, context)
      : null;
  const terminal = await bb.sdk.terminals.create({
    cols: 120,
    rows: 40,
    scope:
      action.type === "service"
        ? { kind: "environment", environmentId: context.environmentId }
        : { kind: "thread", threadId: context.threadId },
    start: {
      mode: "command",
      command: action.type === "service" ? serviceCommand(action.command, port) : action.command,
    },
    title,
  });

  if (action.type === "service") {
    await bb.storage.kv.set(serviceKey(context.environmentId, action.id), {
      terminalId: terminal.id,
      environmentId: context.environmentId,
      threadId: context.threadId,
      hostId: context.hostId,
      workspacePath: context.workspacePath,
      actionId: action.id,
      port,
      startedAt: Date.now(),
    } satisfies ServiceRecord);
  }

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

async function inspect(bb: BbPluginApi, threadId: string) {
  try {
    const context = await contextForThread(bb, threadId);
    const definition = await readWorkspaceDefinition(bb, context.hostId, context.workspacePath);
    const actions = await Promise.all(
      definition.actions.map(async (action) => {
        const service =
          action.type === "service"
            ? await activeServiceRecord(bb, context.environmentId, action.id)
            : null;
        return {
          ...action,
          running: service !== null,
          terminalId: service?.terminalId ?? null,
          port: service?.port ?? null,
        };
      }),
    );
    return {
      available: true as const,
      workspacePath: context.workspacePath,
      manifestFound: definition.manifestFound,
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
  const key = serviceKey(context.environmentId, actionId);
  const record = await readServiceRecord(bb, context.environmentId, actionId);
  if (record === null) return { stopped: false };
  await bb.sdk.terminals.close({ terminalId: record.terminalId, mode: "force" }).catch(() => undefined);
  await bb.storage.kv.delete(key);
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
  const settings = bb.settings.define({
    autoStartServices: {
      type: "boolean",
      label: "Start declared workspace services automatically",
      description: "Start paseo.json worktree terminals when a thread's workspace becomes active.",
      default: true,
    },
  });
  bb.rpc.register(rpcContract, {
    inspect: ({ threadId }) => inspect(bb, threadId),
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
      { name: "list", summary: "List workspace scripts", usage: "bb workspace-scripts list" },
      { name: "run", summary: "Run a workspace script", usage: "bb workspace-scripts run <script-name>" },
      { name: "setup", summary: "Run workspace setup", usage: "bb workspace-scripts setup" },
      { name: "teardown", summary: "Run workspace teardown", usage: "bb workspace-scripts teardown" },
      { name: "stop", summary: "Stop a workspace service", usage: "bb workspace-scripts stop <script-name>" },
    ],
    async run(argv, context) {
      if (!context.threadId) {
        return { exitCode: 2, stderr: "Run this command from a BB thread.\n" };
      }
      try {
        if (argv[0] === "list") {
          const result = await inspect(bb, context.threadId);
          if (!result.available) {
            return { exitCode: 2, stderr: `${result.message}\n` };
          }
          const lines = result.actions.map((action) =>
            `${action.name}\t${action.type}\t${action.running ? "running" : "stopped"}`,
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
        return { exitCode: 2, stderr: "Usage: bb workspace-scripts <list|run <name>|setup|teardown|stop <name>>\n" };
      } catch (error) {
        return { exitCode: 1, stderr: `${errorMessage(error)}\n` };
      }
    },
  });
}
