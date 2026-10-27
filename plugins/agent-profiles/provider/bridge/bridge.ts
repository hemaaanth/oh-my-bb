#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { runAgentSetup } from "../agent-setup.js";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  buildShellEnvOverrides,
  bridgeRequestEnvelopeSchema,
  createBridgeIo,
  createBridgeLineHandler,
  createPendingToolCallTracker,
  decodeBridgeJsonRpcResponse,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  providerInstallationRunParamsSchema,
  providerInstallationStatusParamsSchema,
  providerMaintenanceParamsSchema,
  isStandaloneBuiltinCompactCommand,
  modelListParamsSchema,
  runBridgeRequest,
  skillsConfigureParamsSchema,
  threadDiscardParamsSchema,
  threadForkParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  type BridgeToolCallRequest,
  type InitializeResult,
  type ThreadDelta,
  type ThreadEventContextWindowUsage,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { ImageContent } from "../pi-types.js";
import { agentCatalogModels, agentsCatalogSchema } from "../agent-catalog.js";
import { parseHempiOptions, requireAgentIdentity, type HempiOptions } from "../optchat.js";
import { resolveAgentExecution } from "../../server/model-levels.js";
import { createPiDeltaTranslator } from "../delta-translation.js";
import {
  buildPiSessionParams,
  buildPiTurnOptions,
  type PiSessionParams,
} from "../session-params.js";
import { piSessionNeedsRelocation } from "./session-cwd.js";
import { BB_PI_EXTENSION_SOURCE } from "./bb-pi-extension.js";
import {
  createExtensionUiCoordinator,
  type ExtensionUiCoordinator,
} from "./extension-ui.js";
import { type InteractionUiRequest } from "../extension-ui-contract.js";
import {
  getPiInstallGate,
  getPiProviderInstallationRun,
  getPiProviderInstallationStatus,
  resetPiInstallGateForTests,
} from "./provider-maintenance.js";
import {
  closeAllPiCatalogs,
  createLiveContextWindowResolver,
  getPiCatalog,
  peekPiCatalog,
} from "./catalog.js";
import {
  PiRpcSession,
  type PiRpcSessionOptions,
  type ToolCallForwarder,
} from "./rpc-session.js";
import {
  resolvePiBridgeSessionDir,
  resolvePiSessionFilePath,
} from "./session-paths.js";
import { extractPiPromptInput } from "./turn-input.js";

const piCommandSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("initialize"),
    params: initializeParamsSchema,
  }),
  z.object({ method: z.literal("model/list"), params: modelListParamsSchema }),
  z.object({
    method: z.literal("provider/health"),
    params: providerMaintenanceParamsSchema,
  }),
  z.object({
    method: z.literal("provider/usage"),
    params: providerMaintenanceParamsSchema,
  }),
  z.object({
    method: z.literal("provider/installation/status"),
    params: providerInstallationStatusParamsSchema,
  }),
  z.object({
    method: z.literal("provider/installation/run"),
    params: providerInstallationRunParamsSchema,
  }),
  z.object({
    method: z.literal("thread/start"),
    params: threadStartParamsSchema,
  }),
  z.object({
    method: z.literal("thread/resume"),
    params: threadResumeParamsSchema,
  }),
  z.object({
    method: z.literal("thread/fork"),
    params: threadForkParamsSchema,
  }),
  z.object({ method: z.literal("turn/start"), params: turnStartParamsSchema }),
  z.object({ method: z.literal("turn/steer"), params: turnSteerParamsSchema }),
  z.object({
    method: z.literal("thread/stop"),
    params: threadStopParamsSchema,
  }),
  z.object({
    method: z.literal("thread/discard"),
    params: threadDiscardParamsSchema,
  }),
  z.object({
    method: z.literal("skills/configure"),
    params: skillsConfigureParamsSchema,
  }),
]);

type PiCommand = z.infer<typeof piCommandSchema>;

const piCommandMethodValues = piCommandSchema.options.map(
  (option) => option.shape.method.value,
);

type DecodedPiBridgeRequest =
  | { kind: "request"; request: PiCommand & { id: string | number } }
  | { kind: "unknown-method"; id: string | number; method: string }
  | {
      kind: "invalid-params";
      id: string | number;
      method: string;
      issues: string;
    }
  | { kind: "ignored" };

function decodePiJsonRpcRequest(raw: unknown): DecodedPiBridgeRequest {
  const envelope = bridgeRequestEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return { kind: "ignored" };
  }
  const command = piCommandSchema.safeParse({
    method: envelope.data.method,
    params: envelope.data.params ?? {},
  });
  if (command.success) {
    return {
      kind: "request",
      request: { ...command.data, id: envelope.data.id },
    };
  }
  if (
    !(piCommandMethodValues as readonly string[]).includes(envelope.data.method)
  ) {
    return {
      kind: "unknown-method",
      id: envelope.data.id,
      method: envelope.data.method,
    };
  }
  return {
    kind: "invalid-params",
    id: envelope.data.id,
    method: envelope.data.method,
    issues: command.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; "),
  };
}

interface BridgeEventNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

interface CurrentThreadSessionArgs {
  sessionSerial: number;
  threadId: string;
}

interface ThreadSession {
  session: PiRpcSession;
  sessionSerial: number;
  closing: boolean;
  providerThreadId: string;
  cwd: string;
  construction: PiSessionParams;
  constructionModel: { provider: string; id: string } | undefined;
}

let sessionSerialCounter = 0;
const THREAD_STOP_CLOSE_TIMEOUT_MS = 8_000;

const { send, sendResult, sendError } = createBridgeIo<
  BridgeEventNotification | BridgeToolCallRequest | InteractionUiRequest
>();

const sessions = new Map<string, ThreadSession>();
const closingSessions = new Map<string, Promise<string | undefined>>();
const { forwardToolCall, handleToolCallResponse, resolvePendingToolCalls } =
  createPendingToolCallTracker({ sendToolCall: send });

const extensionUi: ExtensionUiCoordinator = createExtensionUiCoordinator({
  sendInteractionRequest: send,
});

let configuredSkillPaths: string[] | null = null;

let scratchDir: string | null = null;
let scratchDirIsPrivate = false;
let extensionPath: string | null = null;
let persistentDataDir: string | null = null;

function requireScratchDir(): string {
  if (scratchDir === null) {
    scratchDir = join(
      tmpdir(),
      `bb-pi-bridge-${process.pid}-${Math.random().toString(16).slice(2)}`,
    );
    scratchDirIsPrivate = true;
    mkdirSync(scratchDir, { recursive: true });
  }
  return scratchDir;
}

function requireExtensionPath(): string {
  if (extensionPath === null) {
    const path = join(requireScratchDir(), "bb-pi-extension.mjs");
    writeFileSync(path, BB_PI_EXTENSION_SOURCE, "utf8");
    extensionPath = path;
  }
  return extensionPath;
}

function bridgeDataDir(): string {
  return persistentDataDir ?? join(requireScratchDir(), "data");
}

const contextWindows = createLiveContextWindowResolver();
const piDeltaTranslator = createPiDeltaTranslator({
  resolveModelContextWindow: contextWindows.resolve,
});

function createForwardToolCall(getThreadId: () => string): ToolCallForwarder {
  return (toolName, args) => {
    const threadId = getThreadId();
    const threadSession = sessions.get(threadId);
    if (!threadSession || threadSession.closing) {
      return Promise.resolve({
        content: "Thread session not found",
        isError: true,
      });
    }
    return forwardToolCall({
      arguments: args,
      providerThreadId: threadSession.providerThreadId,
      scope: threadSession,
      threadId,
      toolName,
    });
  };
}

const preparingTurns = new Map<string, AbortController>();

async function closeThreadSession(args: {
  message: string;
  threadId: string;
}): Promise<string | undefined> {
  preparingTurns.get(args.threadId)?.abort();
  preparingTurns.delete(args.threadId);
  const existingClose = closingSessions.get(args.threadId);
  if (existingClose) {
    return existingClose;
  }
  const threadSession = sessions.get(args.threadId);
  if (!threadSession) {
    return;
  }
  threadSession.closing = true;
  resolvePendingToolCalls(threadSession, args.message);
  extensionUi.cancelPendingForScope(threadSession);
  const closePromise = Promise.resolve()
    .then(() =>
      threadSession.session.closeGracefully(THREAD_STOP_CLOSE_TIMEOUT_MS),
    )
    .finally(() => {
      if (sessions.get(args.threadId) === threadSession) {
        sessions.delete(args.threadId);
      }
      closingSessions.delete(args.threadId);
    });
  closingSessions.set(args.threadId, closePromise);
  return closePromise;
}

async function closeThreadSessionsGracefully(message: string): Promise<void> {
  await Promise.all(
    Array.from(sessions.keys()).map((threadId) =>
      closeThreadSession({ message, threadId }),
    ),
  );
}

function sendThreadDeltas(
  threadId: string,
  deltas: readonly ThreadDelta[],
): void {
  if (deltas.length === 0) {
    return;
  }
  send({
    jsonrpc: "2.0",
    method: THREAD_DELTA_NOTIFICATION_METHOD,
    params: { threadId, deltas: [...deltas] },
  });
}

function emitForSession(
  threadId: string,
  method: string,
  params: Record<string, unknown>,
): void {
  sendThreadDeltas(
    threadId,
    piDeltaTranslator.translate(
      { jsonrpc: "2.0", method, params },
      { threadId, cwd: sessions.get(threadId)?.cwd },
    ),
  );
}

function sendThreadIdentity(threadId: string, providerThreadId: string): void {
  send({
    jsonrpc: "2.0",
    method: BRIDGE_NOTIFICATION_METHODS.threadIdentity,
    params: { threadId, providerThreadId, sessionRestorable: true },
  });
}

function sendSessionScopedError(
  threadId: string,
  providerThreadId: string,
  message: string,
): void {
  send({
    jsonrpc: "2.0",
    method: BRIDGE_NOTIFICATION_METHODS.error,
    params: { threadId, providerThreadId, message },
  });
}

function emitSessionError(
  threadSession: ThreadSession,
  threadId: string,
  message: string,
): void {
  emitForSession(threadId, "error", { threadId, message });
  sendSessionScopedError(threadId, threadSession.providerThreadId, message);
}

function toContextWindowUsagePayload(
  contextUsage: { tokens: number | null; contextWindow: number } | null,
): ThreadEventContextWindowUsage | null {
  if (!contextUsage) {
    return null;
  }
  return {
    usedTokens: contextUsage.tokens,
    modelContextWindow:
      contextUsage.contextWindow > 0 ? contextUsage.contextWindow : null,
    estimated: true,
  };
}

function emitContextWindowUsage(threadId: string): void {
  const threadSession = sessions.get(threadId);
  if (!threadSession) {
    return;
  }
  const contextWindowUsage = toContextWindowUsagePayload(
    threadSession.session.getContextUsage(),
  );
  if (!contextWindowUsage) {
    return;
  }
  emitForSession(threadId, "thread/contextWindowUsage/updated", {
    threadId,
    contextWindowUsage,
  });
}

function nextSessionSerial(): number {
  sessionSerialCounter += 1;
  return sessionSerialCounter;
}

function getCurrentThreadSession(
  args: CurrentThreadSessionArgs,
): ThreadSession | undefined {
  const threadSession = sessions.get(args.threadId);
  if (
    !threadSession ||
    threadSession.closing ||
    threadSession.sessionSerial !== args.sessionSerial
  ) {
    return undefined;
  }
  return threadSession;
}

function createOnPiEvent(
  args: CurrentThreadSessionArgs,
): (event: Record<string, unknown>) => void {
  return (event) => {
    const threadSession = getCurrentThreadSession(args);
    if (!threadSession) return;
    emitForSession(args.threadId, "sdk/message", {
      threadId: args.threadId,
      message: event,
    });
    if (event.type === "turn_end" || event.type === "compaction_end") {
      emitContextWindowUsage(args.threadId);
    }
  };
}

function createOnExtensionUiRequest(
  args: CurrentThreadSessionArgs,
): (request: Record<string, unknown>) => void {
  return (request) => {
    const threadSession = getCurrentThreadSession(args);
    if (!threadSession || threadSession.closing) return;
    // Status lines and info notices are terminal chrome (OptChat counts, "fast on"). In chat they are noise,
    // so only warnings and errors reach the thread.
    if (request.method === "setStatus") return;
    if (request.method === "notify") {
      const message = request.message;
      if ((request.notifyType === "warning" || request.notifyType === "error")
        && typeof message === "string" && message.trim()) {
        sendThreadDeltas(args.threadId, [{ kind: "provider.warning", category: "general", summary: message, vouchedTurn: true }]);
      }
      return;
    }
    extensionUi.handle({
      scope: threadSession,
      request,
      threadId: args.threadId,
      providerThreadId: threadSession.providerThreadId,
      respond: (requestId, fields) =>
        threadSession.session.respondToExtensionUi(requestId, fields),
    });
  };
}

function createOnSessionDone(
  args: CurrentThreadSessionArgs,
): (error?: unknown) => void {
  return (error?: unknown) => {
    if (error) {
      reportSessionError({ ...args, error });
      return;
    }
    const threadSession = getCurrentThreadSession(args);
    if (!threadSession) {
      return;
    }
    void closeThreadSession({
      message: "Pi session ended while tool call was pending",
      threadId: args.threadId,
    }).catch((shutdownError: unknown) => {
      sendSessionScopedError(
        args.threadId,
        threadSession.providerThreadId,
        shutdownError instanceof Error
          ? shutdownError.message
          : String(shutdownError),
      );
    });
  };
}

function reportPromptSettled(args: {
  error?: unknown;
  sessionSerial: number;
  threadId: string;
}): void {
  const threadSession = getCurrentThreadSession(args);
  if (!threadSession) {
    return;
  }
  const errorMessage =
    args.error === undefined
      ? undefined
      : args.error instanceof Error
        ? args.error.message
        : String(args.error);
  sendThreadDeltas(args.threadId, [{
    kind: "turn.boundary",
    status: errorMessage === undefined ? "completed" : "failed",
    ...(errorMessage === undefined ? {} : { error: { message: errorMessage } }),
    ...(threadSession.session.getLastCheckpoint() === null ? {} : {
      providerCheckpointId: threadSession.session.getLastCheckpoint()!,
    }),
    claimIfIdle: true,
  }]);
}

function reportSessionError(
  args: CurrentThreadSessionArgs & { error: unknown },
): void {
  const threadSession = getCurrentThreadSession(args);
  if (!threadSession) return;
  emitSessionError(
    threadSession,
    args.threadId,
    args.error instanceof Error ? args.error.message : String(args.error),
  );
}

async function handleRequest(
  request: PiCommand & { id: string | number },
): Promise<void> {
  switch (request.method) {
    case "initialize": {
      const result: InitializeResult = {
        protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        capabilities: {
          sessionRestore: true,
          threadArchive: false,
          threadRename: false,
          threadGoalClear: false,
          fork: "checkpoint",
          approvalEnforcedBy: "runtime",
          grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
          steerMode: "inject",
          skills: { configure: true },
        },
      };
      sendResult(request.id, result);
      break;
    }
    case "model/list":
      await handleModelList(request.id, request.params);
      break;
    case "provider/health":
      sendResult(request.id, { supported: false });
      break;
    case "provider/usage":
      sendResult(request.id, { supported: false });
      break;
    case "provider/installation/status":
      sendResult(
        request.id,
        await getPiProviderInstallationStatus(request.params.checkUpdates),
      );
      break;
    case "provider/installation/run":
      sendResult(
        request.id,
        await getPiProviderInstallationRun(request.params.action),
      );
      break;
    case "thread/start":
      await handleThreadConstruction(
        request.id,
        request.params.threadId,
        `pi_${randomUUID()}`,
        toPiSessionParams(request.params),
      );
      break;
    case "thread/resume": {
      await handleThreadConstruction(
        request.id,
        request.params.threadId,
        request.params.providerThreadId,
        toPiSessionParams(request.params),
      );
      break;
    }
    case "thread/fork":
      await handleThreadFork(request.id, request.params);
      break;
    case "turn/start":
      await handleTurnStart(request.id, request.params);
      break;
    case "turn/steer":
      await handleTurnSteer(request.id, request.params);
      break;
    case "thread/stop":
      await handleThreadStop(request.id, request.params);
      break;
    case "thread/discard":
      sendResult(request.id, await handleThreadDiscard(request.params));
      break;
    case "skills/configure":
      configuredSkillPaths = request.params.roots.map((root) => root.path);
      sendResult(request.id, { ok: true });
      break;
  }
}

type ThreadForkParams = z.infer<typeof threadForkParamsSchema>;
type TurnStartParams = z.infer<typeof turnStartParamsSchema>;
type TurnSteerParams = z.infer<typeof turnSteerParamsSchema>;
type ThreadStopParams = z.infer<typeof threadStopParamsSchema>;
type ThreadRefParams = z.infer<typeof threadDiscardParamsSchema>;

function toPiSessionParams(
  params: z.infer<typeof threadStartParamsSchema>,
): PiSessionParams {
  const session = buildPiSessionParams({
    threadId: params.threadId,
    cwd: params.cwd,
    options: params.options,
    instructionMode: params.instructionMode,
    dynamicTools: params.dynamicTools,
    additionalSkillPaths: configuredSkillPaths ?? undefined,
  });
  if (session.providerOptions.kind === "agents" || session.providerOptions.agentId)
    requireAgentIdentity(session.providerOptions, params.threadId, session.model ?? "");
  return session;
}

async function handleModelList(
  id: string | number,
  params: { cwd?: string; providerOptions?: unknown },
): Promise<void> {
  if (params.providerOptions && typeof params.providerOptions === "object" &&
    ("kind" in params.providerOptions || "agents" in params.providerOptions || "revision" in params.providerOptions)) {
    try {
      const catalog = agentsCatalogSchema.parse(params.providerOptions);
      sendResult(id, { models: agentCatalogModels(catalog), selectedOnlyModels: [] });
    } catch (error) {
      sendError(id, -32602, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  const gate = await getPiInstallGate();
  if (!gate.ok) {
    sendError(
      id,
      gate.status === "not_installed"
        ? BRIDGE_JSON_RPC_ERRORS.MISSING_EXECUTABLE
        : -32000,
      gate.status === "not_installed"
        ? "Could not find the pi CLI on this host. Install @earendil-works/pi-coding-agent and retry."
        : (gate.statusMessage ?? "Pi is not supported on this host."),
    );
    return;
  }
  try {
    const catalog = await getPiCatalog(
      params.cwd ?? process.cwd(),
      requireExtensionPath(),
      bridgeDataDir(),
    );
    contextWindows.learn(await catalog.rawModels());
    sendResult(id, await catalog.listModels());
  } catch (error) {
    sendError(
      id,
      -32000,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function resolvePiModel(
  modelStr: string,
  cwd: string,
): Promise<{ provider: string; id: string }> {
  if (!(modelStr.startsWith("openai-codex/") && modelStr.length > "openai-codex/".length) &&
    !/^model-gateway\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(modelStr)) {
    throw new Error("Hempi only supports openai-codex/* models, directly or through model-gateway/gpt-*.");
  }
  const slashIdx = modelStr.indexOf("/");
  if (slashIdx > 0) {
    const provider = modelStr.slice(0, slashIdx);
    const id = modelStr.slice(slashIdx + 1);
    const warm = peekPiCatalog(cwd);
    if (warm !== null) {
      const models = await (await warm).rawModels();
      if (
        models.some((m) => m.provider === provider) &&
        !models.some((m) => m.provider === provider && m.id === id)
      ) {
        throw new Error(
          `Pi model "${modelStr}" is not served by provider "${provider}" on this host.`,
        );
      }
    }
    return { provider, id };
  }
  throw new Error("Hempi only supports openai-codex/* models, directly or through model-gateway/gpt-*.");
}
async function resolveAgentPiModel(options: HempiOptions, cwd: string) {
  if (!options.agentId || !options.modelMode || !options.level ||
    !options.providerId || !options.model || !options.reasoningLevel)
    throw new Error("Agents require a bound execution policy.");
  const catalog = await getPiCatalog(cwd, requireExtensionPath(), bridgeDataDir());
  const models = (await catalog.listModels()).models;
  const execution = resolveAgentExecution({
    modelMode: options.modelMode, level: options.level, providerId: options.providerId,
    model: options.model, reasoningLevel: options.reasoningLevel,
  }, models);
  const slash = execution.model.indexOf("/");
  return {
    model: { provider: execution.model.slice(0, slash), id: execution.model.slice(slash + 1) },
    thinkingLevel: buildPiTurnOptions({ reasoningLevel: execution.reasoningLevel }).thinkingLevel,
  };
}

async function buildSessionOptions(args: {
  params: PiSessionParams;
  providerThreadId: string;
  threadId: string;
  sessionSerial: number;
}): Promise<PiRpcSessionOptions> {
  const agent = args.params.providerOptions.agentId
    ? await resolveAgentPiModel(args.params.providerOptions, args.params.cwd)
    : undefined;
  const model = agent?.model ?? (args.params.model
    ? await resolvePiModel(args.params.model, args.params.cwd)
    : (await (await getPiCatalog(args.params.cwd, requireExtensionPath(), bridgeDataDir())).rawModels())[0]);
  if (!model) throw new Error("Hempi has no authenticated openai-codex model available.");
  return {
    cwd: args.params.cwd,
    model: { provider: model.provider, id: model.id },
    sessionFilePath: resolvePiSessionFilePath({
      env: process.env,
      threadId: args.providerThreadId,
    }),
    sessionDir: resolvePiBridgeSessionDir({ env: process.env }),
    systemPrompt: args.params.baseInstructions,
    appendSystemPrompt: args.params.appendSystemPrompt,
    shellEnvOverrides: args.params.shellEnvOverrides,
    ...(args.params.additionalSkillPaths
      ? { additionalSkillPaths: [...args.params.additionalSkillPaths] }
      : {}),
    ...((agent?.thinkingLevel ?? args.params.thinkingLevel)
      ? { thinkingLevel: agent?.thinkingLevel ?? args.params.thinkingLevel }
      : {}),
    ...(args.params.dynamicTools && args.params.dynamicTools.length > 0
      ? { dynamicTools: args.params.dynamicTools }
      : {}),
    scratchDir: requireScratchDir(),
    extensionPath: requireExtensionPath(),
    recordThreadId: args.threadId,
    providerOptions: args.params.providerOptions,
    dataDir: bridgeDataDir(),
    onInfo: (message) => sendThreadDeltas(args.threadId, [{
      kind: "provider.warning", category: "general", summary: message, vouchedTurn: true,
    }]),
    onExtensionUiRequest: createOnExtensionUiRequest({
      sessionSerial: args.sessionSerial,
      threadId: args.threadId,
    }),
  };
}

async function constructPiThreadSession(
  threadId: string,
  providerThreadId: string,
  params: PiSessionParams,
): Promise<ThreadSession> {
  const sessionSerial = nextSessionSerial();
  const sessionOptions = await buildSessionOptions({
    params,
    providerThreadId,
    threadId,
    sessionSerial,
  });
  const session = new PiRpcSession(
    sessionOptions,
    createForwardToolCall(() => threadId),
    createOnPiEvent({ sessionSerial, threadId }),
    createOnSessionDone({ sessionSerial, threadId }),
  );
  const threadSession: ThreadSession = {
    session,
    sessionSerial,
    closing: false,
    providerThreadId,
    cwd: params.cwd,
    construction: params,
    constructionModel: sessionOptions.model,
  };
  sessions.set(threadId, threadSession);
  try {
    await session.start();
    const liveModel = session.getLiveModel();
    if (
      liveModel &&
      typeof liveModel.id === "string" &&
      typeof liveModel.provider === "string"
    ) {
      contextWindows.learn([
        {
          id: liveModel.id,
          provider: liveModel.provider,
          contextWindow: liveModel.contextWindow,
        },
      ]);
    }
    return threadSession;
  } catch (error) {
    if (sessions.get(threadId) === threadSession) {
      sessions.delete(threadId);
    }
    session.kill();
    throw error;
  }
}

function retireReplacedPiChild(replaced: ThreadSession): void {
  replaced.closing = true;
  resolvePendingToolCalls(
    replaced,
    "Pi thread session replaced while tool call was pending",
  );
  extensionUi.cancelPendingForScope(replaced);
  void replaced.session
    .closeGracefully(THREAD_STOP_CLOSE_TIMEOUT_MS)
    .catch(() => undefined);
}

async function rebuildThreadSession(
  threadId: string,
  previous: ThreadSession,
  params: PiSessionParams,
): Promise<ThreadSession> {
  let replacement: ThreadSession;
  try {
    replacement = await constructPiThreadSession(
      threadId,
      previous.providerThreadId,
      params,
    );
  } catch (error) {
    if (!sessions.has(threadId) && !previous.closing) {
      sessions.set(threadId, previous);
    }
    throw error;
  }
  retireReplacedPiChild(previous);
  return replacement;
}

function sendSessionResetBoundary(threadId: string): void {
  piDeltaTranslator.resetThread(threadId);
  sendThreadDeltas(threadId, [{ kind: "session.reset" }]);
}

function sendThreadSessionResult(
  id: string | number,
  threadId: string,
  providerThreadId: string,
): void {
  sendThreadIdentity(threadId, providerThreadId);
  sendSessionResetBoundary(threadId);
  sendResult(id, { providerThreadId, sessionRestorable: true });
}

async function handleThreadConstruction(
  id: string | number,
  threadId: string,
  providerThreadId: string,
  params: PiSessionParams,
): Promise<void> {
  const existing = sessions.get(threadId);
  if (existing && (existing.construction.providerOptions.agentId !== params.providerOptions.agentId ||
    existing.construction.providerOptions.memoryKey !== params.providerOptions.memoryKey))
    throw new Error("Agent identity or memory key changed on this thread.");
  if (existing) {
    await closeThreadSession({
      message: "Pi thread session replaced while tool call was pending",
      threadId,
    });
  }
  const sourceFile = resolvePiSessionFilePath({
    env: process.env,
    threadId: providerThreadId,
  });
  const relocate = piSessionNeedsRelocation(sourceFile, params.cwd);
  const nextProviderThreadId = relocate ? `pi_${randomUUID()}` : providerThreadId;
  const targetFile = resolvePiSessionFilePath({
    env: process.env,
    threadId: nextProviderThreadId,
  });
  try {
    if (relocate) {
      await PiRpcSession.forkSessionFile({
        sourceFile,
        targetFile,
        cwd: params.cwd,
        shellEnvOverrides: params.shellEnvOverrides,
        dataDir: bridgeDataDir(),
        sessionDir: resolvePiBridgeSessionDir({ env: process.env }),
        extensionPath: requireExtensionPath(),
        scratchDir: requireScratchDir(),
        recordThreadId: threadId,
      });
    }
    await constructPiThreadSession(threadId, nextProviderThreadId, params);
  } catch (error) {
    if (relocate) rmSync(targetFile, { force: true });
    throw error;
  }
  sendThreadSessionResult(id, threadId, nextProviderThreadId);
}

async function handleThreadFork(
  id: string | number,
  params: ThreadForkParams,
): Promise<void> {
  const sessionParams = toPiSessionParams(params);
  const sourceSessionFile = resolvePiSessionFilePath({
    env: process.env,
    threadId: params.sourceProviderThreadId,
  });
  if (!existsSync(sourceSessionFile)) {
    sendError(
      id,
      -32000,
      `Cannot fork: source pi session file not found for thread "${params.sourceProviderThreadId}"`,
    );
    return;
  }
  const targetSessionFile = resolvePiSessionFilePath({
    env: process.env,
    threadId: params.threadId,
  });
  mkdirSync(resolvePiBridgeSessionDir({ env: process.env }), {
    recursive: true,
  });
  try {
    await PiRpcSession.forkSessionFile({
      sourceFile: sourceSessionFile,
      targetFile: targetSessionFile,
      cwd: params.cwd,
      shellEnvOverrides: sessionParams.shellEnvOverrides,
      dataDir: bridgeDataDir(),
      sessionDir: resolvePiBridgeSessionDir({ env: process.env }),
      ...(params.sourceProviderCheckpointId === undefined
        ? {}
        : { checkpointId: params.sourceProviderCheckpointId }),
      extensionPath: requireExtensionPath(),
      scratchDir: requireScratchDir(),
      recordThreadId: params.threadId,
    });
  } catch (error) {
    rmSync(targetSessionFile, { force: true });
    sendError(
      id,
      -32000,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  await handleThreadConstruction(
    id,
    params.threadId,
    params.threadId,
    sessionParams,
  );
}

function startPiPrompt(
  threadSession: ThreadSession,
  threadId: string,
  text: string,
  images: ImageContent[],
): Promise<void> {
  const dispatch = threadSession.session.prompt(
    text,
    images.length > 0 ? images : undefined,
  );
  void dispatch.settled.then(async (outcome) => {
    if (outcome === null) {
      return;
    }
    try { await threadSession.session.stopTurn(); }
    catch (error) { outcome.error = outcome.error === undefined ? error : new Error(`${String(outcome.error)}\n${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    reportPromptSettled({
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      sessionSerial: threadSession.sessionSerial,
      threadId,
    });
  });
  return dispatch.consumed;
}


function recordAcceptedTurnInput(params: TurnStartParams): void {
  sendThreadDeltas(params.threadId, [
    { kind: "input.accepted", clientRequestId: params.clientRequestId },
  ]);
}

async function reconcileTurnOptions(
  threadId: string,
  threadSession: ThreadSession,
  options: TurnStartParams["options"],
): Promise<ThreadSession> {
  const turnOptions = buildPiTurnOptions(options);
  const construction = threadSession.construction;
  const providerOptions = options.providerOptions === undefined
    ? construction.providerOptions
    : parseHempiOptions(options.providerOptions);
  if (construction.providerOptions.agentId) {
    requireAgentIdentity(providerOptions, threadId, options.model ?? construction.model ?? "");
    if (providerOptions.agentId !== construction.providerOptions.agentId ||
      providerOptions.memoryKey !== construction.providerOptions.memoryKey)
      throw new Error("Agent identity or memory key changed on this thread.");
  } else if (providerOptions.agentId || providerOptions.kind === "agents") {
    throw new Error("An unbound thread cannot become an agent thread.");
  }
  const providerOptionsChanged = !isDeepStrictEqual(providerOptions, construction.providerOptions);
  const shellEnvOverrides =
    options.envVars && Object.keys(options.envVars).length > 0
      ? { BB_THREAD_ID: threadId, ...buildShellEnvOverrides(options.envVars) }
      : undefined;
  const environmentChanged =
    shellEnvOverrides !== undefined &&
    !isDeepStrictEqual(shellEnvOverrides, construction.shellEnvOverrides);
  const changedModelRequest =
    turnOptions.model !== undefined && turnOptions.model !== construction.model
      ? turnOptions.model
      : undefined;
  const thinkingLevelChanged =
    turnOptions.thinkingLevel !== undefined &&
    turnOptions.thinkingLevel !== construction.thinkingLevel;
  if (
    !environmentChanged &&
    changedModelRequest === undefined &&
    !thinkingLevelChanged && !providerOptionsChanged
  ) {
    return threadSession;
  }
  const nextModel =
    changedModelRequest === undefined || construction.providerOptions.agentId
      ? undefined
      : await resolvePiModel(changedModelRequest, construction.cwd);
  const modelChanged =
    nextModel !== undefined &&
    (threadSession.constructionModel === undefined ||
      threadSession.constructionModel.provider !== nextModel.provider ||
      threadSession.constructionModel.id !== nextModel.id);
  if (!environmentChanged && !modelChanged && !thinkingLevelChanged && !providerOptionsChanged) {
    return threadSession;
  }
  const replacement = await rebuildThreadSession(threadId, threadSession, {
    ...construction,
    providerOptions,
    ...(shellEnvOverrides === undefined ? {} : { shellEnvOverrides }),
    ...(turnOptions.model === undefined ? {} : { model: turnOptions.model }),
    ...(turnOptions.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: turnOptions.thinkingLevel }),
  });
  sendThreadIdentity(threadId, replacement.providerThreadId);
  sendSessionResetBoundary(threadId);
  send({
    jsonrpc: "2.0",
    method: BRIDGE_NOTIFICATION_METHODS.sessionReplaced,
    params: {
      threadId,
      providerThreadId: replacement.providerThreadId,
      reason:
        "Execution settings changed; the pi session was rebuilt to apply them.",
      contextLost: false,
    },
  });
  return replacement;
}

async function handleTurnStart(
  id: string | number,
  params: TurnStartParams,
): Promise<void> {
  const liveSession = sessions.get(params.threadId);
  if (!liveSession || liveSession.closing) {
    sendError(id, -32000, "No active pi session");
    return;
  }
  let threadSession: ThreadSession;
  if (preparingTurns.has(params.threadId) || liveSession.session.isTurnActive()) {
    sendError(id, -32000, "A Pi turn is already active; use turn/steer.");
    return;
  }
  const setupEnv = params.options.envVars ?? liveSession.construction.shellEnvOverrides;
  if (setupEnv.AGENT_SETUP_SCRIPT) {
    if (isStandaloneBuiltinCompactCommand(params.input)) {
      sendError(id, -32000, "Manual compaction is not supported by Hempi.");
      return;
    }
    const input = extractPiPromptInput(params.input);
    if (input === null) {
      sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "Missing input text");
      return;
    }
    // Setup is turn work. Acknowledge promptly, retain this input, and run
    // outside both the construction and turn/start RPC deadlines.
    const controller = new AbortController();
    preparingTurns.set(params.threadId, controller);
    sendThreadDeltas(params.threadId, [{ kind: "turn.open" }]);
    sendResult(id, { threadId: params.threadId });
    void runPreparedTurn(params, liveSession, setupEnv, controller, input);
    return;
  }
  try {
    threadSession = await reconcileTurnOptions(
      params.threadId,
      liveSession,
      params.options,
    );
  } catch (error) {
    sendError(
      id,
      -32000,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  if (isStandaloneBuiltinCompactCommand(params.input)) {
    sendError(id, -32000, "Manual compaction is not supported by Hempi.");
    return;
  }
  const input = extractPiPromptInput(params.input);
  if (input === null) {
    sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "Missing input text");
    return;
  }
  const { text, images } = input;
  try {
    await threadSession.session.startTurn();
    await startPiPrompt(threadSession, params.threadId, text, images);
    recordAcceptedTurnInput(params);
    sendResult(id, { threadId: params.threadId });
  } catch (error) {
    sendError(
      id,
      -32000,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function runPreparedTurn(
  params: TurnStartParams,
  threadSession: ThreadSession,
  setupEnv: Record<string, string>,
  controller: AbortController,
  input: { text: string; images: ImageContent[] },
): Promise<void> {
  try {
    await runAgentSetup(setupEnv, controller.signal);
    if (controller.signal.aborted) return;
    threadSession = await reconcileTurnOptions(params.threadId, threadSession, params.options);
    if (controller.signal.aborted) return;
    await threadSession.session.startTurn();
    if (controller.signal.aborted) return;
    await startPiPrompt(threadSession, params.threadId, input.text, input.images);
    recordAcceptedTurnInput(params);
  } catch (error) {
    if (!controller.signal.aborted) {
      const message = error instanceof Error ? error.message : String(error);
      sendSessionScopedError(params.threadId, threadSession.providerThreadId, message);
      sendThreadDeltas(params.threadId, [{ kind: "turn.boundary", status: "failed", error: { message }, claimIfIdle: true }]);
    }
  } finally {
    if (controller.signal.aborted && sessions.get(params.threadId) === threadSession) {
      await closeThreadSession({ threadId: params.threadId, message: "Agent setup cancelled" }).catch(() => undefined);
    }
    if (preparingTurns.get(params.threadId) === controller) preparingTurns.delete(params.threadId);
  }
}

async function handleTurnSteer(
  id: string | number,
  params: TurnSteerParams,
): Promise<void> {
  if (preparingTurns.has(params.threadId)) {
    sendError(id, -32000, "Agent setup is running; wait or stop this turn.");
    return;
  }
  const threadSession = sessions.get(params.threadId);
  if (!threadSession || threadSession.closing) {
    sendError(id, -32000, "No active pi session");
    return;
  }
  try {
    if (threadSession.construction.providerOptions.agentId) {
      const next = params.options.providerOptions === undefined
        ? threadSession.construction.providerOptions
        : parseHempiOptions(params.options.providerOptions);
      requireAgentIdentity(next, params.threadId, params.options.model ?? threadSession.construction.model ?? "");
      if (next.agentId !== threadSession.construction.providerOptions.agentId ||
        next.memoryKey !== threadSession.construction.providerOptions.memoryKey)
        throw new Error("Agent identity or memory key changed on this thread.");
    }
  } catch (error) {
    sendError(id, -32000, error instanceof Error ? error.message : String(error));
    return;
  }
  const input = extractPiPromptInput(params.input);
  if (input === null) {
    sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "Missing input text");
    return;
  }
  const { text, images } = input;
  if (threadSession.session.getIsCompacting()) {
    sendError(id, -32000, "Cannot steer while context compaction is active");
    return;
  }
  try {
    await threadSession.session.steer(
      text,
      images.length > 0 ? images : undefined,
    );
    sendThreadDeltas(params.threadId, [
      { kind: "input.accepted", clientRequestId: params.clientRequestId },
    ]);
    sendResult(id, { threadId: params.threadId });
  } catch (error) {
    sendError(
      id,
      -32000,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handleThreadStop(
  id: string | number,
  params: ThreadStopParams,
): Promise<void> {
  const threadSession = sessions.get(params.threadId);
  if (
    params.intent === "interrupt" &&
    threadSession !== undefined &&
    !threadSession.closing
  ) {
    sendThreadDeltas(params.threadId, [{ kind: "session.ended" }]);
  }
  const providerCheckpointId =
    (await closeThreadSession({
      message: "Pi thread stopped while tool call was pending",
      threadId: params.threadId,
    })) ?? null;
  sendResult(id, { ok: true, providerCheckpointId });
}

async function handleThreadDiscard(
  params: ThreadRefParams,
): Promise<{ ok: true }> {
  await closeThreadSession({
    message: "Pi staged thread discarded while tool call was pending",
    threadId: params.threadId,
  });
  rmSync(
    resolvePiSessionFilePath({
      env: process.env,
      threadId: params.providerThreadId,
    }),
    {
      force: true,
    },
  );
  return { ok: true };
}

function handleParsedMessage(parsed: unknown): void {
  const response = decodeBridgeJsonRpcResponse(parsed);
  if (response) {
    if (extensionUi.handleRuntimeResponse(response)) {
      return;
    }
    if (handleToolCallResponse(response)) {
      return;
    }
  }
  const decoded = decodePiJsonRpcRequest(parsed);
  if (decoded.kind === "ignored") {
    return;
  }
  if (decoded.kind === "unknown-method") {
    sendError(
      decoded.id,
      BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      `Unknown method "${decoded.method}"`,
    );
    return;
  }
  if (decoded.kind === "invalid-params") {
    sendError(
      decoded.id,
      BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      `Invalid params for "${decoded.method}": ${decoded.issues}`,
    );
    return;
  }
  runBridgeRequest({ request: decoded.request, handleRequest, sendError });
}

export const handleLine = createBridgeLineHandler({ handleParsedMessage });

/** @internal Test inspection: where this process writes its scratch files. */
export function experimental_scratchDirForTests(): string {
  return requireScratchDir();
}

/**
 * @internal Test cleanup: every pi child this process runs, and the private
 * scratch dir (a suite never runs the entry's `start`, so nothing else would
 * remove it).
 */
export async function experimental_closeAllForTests(): Promise<void> {
  await closeThreadSessionsGracefully("Pi bridge test teardown");
  await closeAllPiCatalogs();
  resetPiInstallGateForTests();
  if (scratchDir !== null && scratchDirIsPrivate) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = null;
    scratchDirIsPrivate = false;
    extensionPath = null;
  }
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start: (context) => {
    persistentDataDir = context.dataDir;
    scratchDir = join(context.tempDir, "pi");
    scratchDirIsPrivate = false;
    mkdirSync(scratchDir, { recursive: true });
  },
  onClose: () => {
    void closeThreadSessionsGracefully(
      "Pi bridge shutting down while tool call was pending",
    ).finally(() => {
      void closeAllPiCatalogs();
      process.exit(0);
    });
  },
  onSigterm: () => {
    void closeThreadSessionsGracefully(
      "Pi bridge terminated while tool call was pending",
    ).finally(() => {
      void closeAllPiCatalogs();
      process.exit(0);
    });
  },
});
