import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { experimental_buildBridgeToolCallContent as buildBridgeToolCallContent } from "@get-bb/plugin-sdk/provider-bridge";
import type { ImageContent } from "../pi-types.js";
import { setTimeout as delay } from "node:timers/promises";
import { memoryBusyError, prepareOptchatBinding, type HempiOptions } from "../optchat.js";
import { piModelProvider, requireCodexModel, routePiModel } from "../model-routing.js";
import { hempiExtensionArgs } from "./hempi-extension.js";
import { AgentMemoryBusyError, AgentMemoryTurn } from "./agent-memory.js";
import {
  NO_REQUEST_TIMEOUT,
  PiRpcChild,
  PiRpcChildExitedError,
  buildPiChildEnv,
  type PiRpcChildExitInfo,
} from "./rpc-child.js";

export interface PiRpcSessionOptions {
  cwd: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  additionalSkillPaths?: readonly string[];
  shellEnvOverrides?: Record<string, string>;
  dynamicTools?: readonly DynamicToolDefinition[];
  sessionFilePath: string;
  sessionDir: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  scratchDir: string;
  extensionPath: string;
  recordThreadId: string;
  noSession?: boolean;
  onExtensionUiRequest?: (request: Record<string, unknown>) => void;
  providerOptions?: HempiOptions;
  dataDir?: string;
  onInfo?: (message: string) => void;
}

export interface DynamicToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export type ToolCallForwarder = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<
  Parameters<typeof buildBridgeToolCallContent>[0] & { isError?: boolean }
>;

export type PiRpcEvent = Record<string, unknown> & { type: string };
type PiSessionEventHandler = (event: PiRpcEvent) => void;
type PiSessionDoneHandler = (error?: unknown) => void;

type PiInputQueue = "followUp" | "steering";

interface PendingInputConsumption {
  queue: PiInputQueue;
  queuedText: string | null;
  reject: (error: Error) => void;
  resolve: () => void;
}

interface TrackedInputConsumption {
  pending: PendingInputConsumption;
  promise: Promise<void>;
}

export interface PiPromptRunOutcome {
  error?: unknown;
}

export interface PiInputDispatch {
  consumed: Promise<void>;
  settled: Promise<PiPromptRunOutcome | null>;
}

interface PendingRunSettlement {
  resolve: (outcome: PiPromptRunOutcome) => void;
}

interface ChannelReply {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

const PI_TRANSIENT_AUTH_RETRY_DELAY_MS = 250;
const PI_TRANSIENT_AUTH_MAX_RETRIES = 8;
function readinessTimeoutMs(): number {
  const configured = Number(process.env.BB_PI_BRIDGE_READINESS_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 60_000;
}
const CHANNEL_REQUEST_TIMEOUT_MS = 30_000;
const AGENT_END_LEAF_TIMEOUT_MS = 5_000;

type PiSessionConstructionOutcome = { ok: true } | { ok: false; error: Error };

function waitForPiTransientAuthRetry(): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, PI_TRANSIENT_AUTH_RETRY_DELAY_MS),
  );
}

export async function runPiTransientAuthConstruction(args: {
  attempt: () => Promise<PiSessionConstructionOutcome>;
  discardFailedAttempt: () => Promise<void>;
  isClosed: () => boolean;
  waitBeforeRetry: () => Promise<void>;
}): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await args.attempt();
    if (outcome.ok) {
      return;
    }
    if (attempt >= PI_TRANSIENT_AUTH_MAX_RETRIES || args.isClosed()) {
      throw outcome.error;
    }
    await args.discardFailedAttempt();
    await args.waitBeforeRetry();
  }
}

export interface PiRpcSessionState {
  model?: { provider?: string; id?: string; contextWindow?: number };
  thinkingLevel?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  sessionFile?: string;
}

export class PiRpcSession {
  private child: PiRpcChild | undefined;
  private isCompacting = false;
  private deliveryChain: Promise<void> = Promise.resolve();
  private readonly pendingInputConsumptions: PendingInputConsumption[] = [];
  private lastObservedQueues: Record<PiInputQueue, string[]> = {
    followUp: [],
    steering: [],
  };
  private autoRetryInProgress = false;
  private terminalSteerSettlement: Promise<void> | null = null;
  private readonly pendingRunSettlements: PendingRunSettlement[] = [];
  private readonly channelReplies = new Map<string, ChannelReply>();
  private nextChannelRequestId = 0;
  private lastKnownLeafId: string | null = null;
  private readonly agentEndLeafReports: (string | null)[] = [];
  private agentEndLeafWaiter: ((leafId: string | null) => void) | null = null;
  private ready: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
  } = createDeferred();
  private lastContextUsage: {
    tokens: number | null;
    contextWindow: number;
  } | null = null;
  private liveModel: PiRpcSessionState["model"] | undefined;
  private closed = false;
  private readonly cancellation = new AbortController();
  private starting = false;
  private runOutcome: PiPromptRunOutcome = {};
  private compactionError: Error | undefined;
  private lastState: PiRpcSessionState | undefined;
  private memory: AgentMemoryTurn | undefined;
  private inbox: string | undefined;
  private stopping: Promise<void> | undefined;
  private startDone: Promise<void> | undefined;

  constructor(
    private readonly options: PiRpcSessionOptions,
    private readonly forwardToolCall: ToolCallForwarder,
    private readonly onEvent: PiSessionEventHandler,
    private readonly onDone: PiSessionDoneHandler,
  ) {}

  getIsCompacting(): boolean {
    return this.isCompacting;
  }

  respondToExtensionUi(
    id: string | number,
    fields: Record<string, unknown>,
  ): void {
    this.child?.respondToExtensionUi(id, fields);
  }

  getLiveModel(): PiRpcSessionState["model"] | undefined {
    return this.liveModel;
  }

  getContextUsage(): { tokens: number | null; contextWindow: number } | null {
    return this.lastContextUsage;
  }

  isTurnActive(): boolean {
    return this.starting || this.child !== undefined;
  }

  getLastCheckpoint(): string | null {
    return this.lastKnownLeafId;
  }
  async start(): Promise<void> {
    // Session construction is idle. Only a helper starts before a turn.
    if (this.options.noSession) await this.startChild();
  }

  async startTurn(): Promise<void> {
    if (this.closed) throw new Error("Pi session is closed");
    if (this.starting || this.child) throw new Error("A Pi turn is already active");
    this.starting = true;
    const starting = this.launchTurn();
    this.startDone = starting;
    try { await starting; }
    finally { this.starting = false; if (this.startDone === starting) this.startDone = undefined; }
  }

  private async launchTurn(): Promise<void> {
    this.runOutcome = {};
    this.compactionError = undefined;
    try {
      requireCodexModel(this.options.model ?? {});
      const memoryKey = this.options.providerOptions?.agent ? this.options.providerOptions.memoryKey : undefined;
      if (memoryKey) {
        this.memory = new AgentMemoryTurn({
          memoryKey,
          env: { ...process.env, ...this.options.shellEnvOverrides },
          dataDir: this.options.dataDir ?? this.options.scratchDir,
          signal: this.cancellation.signal,
          onLost: (error) => { this.cancellation.abort(error); this.child?.kill(); },
        });
        // Reports of the agent's work outside its DM. The first prompt of the turn carries them into memory.
        this.inbox = this.options.shellEnvOverrides?.AGENT_INBOX || undefined;
      }
      const binding = prepareOptchatBinding(
        this.options.providerOptions ?? {},
        this.options.sessionFilePath,
        this.options.dataDir ?? this.options.scratchDir,
      );
      try {
        await this.memory?.prepare();
        await this.startChild(binding.args);
      } catch (error) {
        await this.stopChild();
        const code = error instanceof AgentMemoryBusyError ? 75 : error instanceof PiRpcChildExitedError ? error.info.code : null;
        if (code === 75) throw memoryBusyError(binding.label, error);
        throw error;
      }
      binding.bound();
    } catch (error) {
      try { await this.stopTurn(); }
      catch (cleanupError) { throw new Error(`${asError(error).message}\n${asError(cleanupError).message}`, { cause: cleanupError }); }
      throw error;
    }
  }

  private async startChild(bindingArgs: readonly string[] = []): Promise<void> {
    await runPiTransientAuthConstruction({
      attempt: () => this.spawnAndVerify(bindingArgs),
      discardFailedAttempt: async () => {
        const failed = this.child;
        this.child = undefined;
        failed?.kill();
        await failed?.waitForExit();
      },
      isClosed: () => this.closed,
      waitBeforeRetry: async () => { await delay(PI_TRANSIENT_AUTH_RETRY_DELAY_MS, undefined, { signal: this.cancellation.signal }); },
    });
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (this.channelReplies.size) {
      const error = new Error("Pi turn closed before its helper request completed");
      for (const reply of this.channelReplies.values()) reply.reject(error);
      this.channelReplies.clear();
    }
    if (child) { child.closeGracefully(); await child.waitForExit(); }
    this.isCompacting = false;
  }

  async stopTurn(): Promise<void> {
    if (this.stopping) return this.stopping;
    const stopping = (async () => {
      await this.stopChild();
      const memory = this.memory;
      this.memory = undefined;
      await memory?.finish();
    })();
    this.stopping = stopping;
    try { await stopping; } finally { if (this.stopping === stopping) this.stopping = undefined; }
  }

  private async spawnAndVerify(bindingArgs: readonly string[]): Promise<PiSessionConstructionOutcome> {
    const env = buildPiChildEnv(this.options.shellEnvOverrides ?? {});
    delete env.AGENT_INBOX;
    if (this.memory?.homeOverride) env.OPTCHAT_HOME = this.memory.homeOverride;
    // A fork helper edits session metadata and never performs inference.
    if (!this.options.noSession && (!env.MODEL_GATEWAY_BASE_URL || !env.MODEL_GATEWAY_TOKEN))
      throw new Error("Model Gateway is required for Hempi turns. Check gateway setup on this host.");
    if (!this.options.noSession) env.MODEL_GATEWAY_REQUIRED = "1";
    const wanted = this.options.model
      ? this.options.noSession ? { provider: "model-gateway", id: this.options.model.id } : routePiModel(this.options.model, env)
      : undefined;
    const hempiArgs = await hempiExtensionArgs({
      cwd: this.options.cwd, env, dataDir: this.options.dataDir ?? this.options.scratchDir,
      signal: this.cancellation.signal,
    });
    const toolsFilePath = join(
      this.options.scratchDir,
      `pi-tools-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    mkdirSync(dirname(toolsFilePath), { recursive: true });
    writeFileSync(
      toolsFilePath,
      JSON.stringify(this.options.dynamicTools ?? []),
      "utf8",
    );
    const promptFiles = this.writePromptFiles();
    const scratchFiles = [toolsFilePath, ...promptFiles.paths];
    env.PI_BB_TOOLS_FILE = toolsFilePath;

    const args: string[] = ["--mode", "rpc"];
    if (this.options.noSession) {
      args.push("--no-session");
    } else {
      mkdirSync(dirname(this.options.sessionFilePath), { recursive: true });
      args.push("--session", this.options.sessionFilePath);
    }
    args.push(
      "--session-dir",
      this.options.sessionDir,
      "--extension",
      this.options.extensionPath,
      ...hempiArgs,
      ...promptFiles.args,
    );
    if (!this.options.noSession) args.push(...bindingArgs);
    for (const skillPath of this.options.additionalSkillPaths ?? []) {
      args.push("--skill", skillPath);
    }
    args.push("--provider", wanted?.provider ?? piModelProvider(env), "--model", wanted?.id ?? "gpt-");
    if (this.options.thinkingLevel) {
      args.push("--thinking", this.options.thinkingLevel);
    }

    this.ready = createDeferred();
    this.memory?.check();
    const onExtensionUiRequest = this.options.onExtensionUiRequest;
    const child = new PiRpcChild({
      cwd: this.options.cwd,
      env,
      args,
      onEvent: (event) => {
        if (child === this.child) this.handleEvent(event);
      },
      onChannelMessage: (message) => {
        if (child === this.child) this.handleChannelMessage(message);
      },
      onExit: (info) => {
        for (const file of scratchFiles) rmSync(file, { force: true });
        if (child === this.child) this.handleExit(info);
      },
      recordThreadId: this.options.recordThreadId,
      onExtensionUiRequest: onExtensionUiRequest
        ? (request) => {
            if (child === this.child) onExtensionUiRequest(request);
          }
        : undefined,
    });
    this.child = child;

    const state = await this.getState(CHANNEL_REQUEST_TIMEOUT_MS);
    if (this.memory) {
      await child.requestOk({ type: "set_auto_compaction", enabled: false }, CHANNEL_REQUEST_TIMEOUT_MS);
    }
    await this.awaitReady(readinessTimeoutMs(), child);
    if (!this.options.noSession) requireCodexModel(state.model ?? {});
    if (state.model?.provider === "unknown") {
      return {
        ok: false,
        error: new Error("Pi has no authenticated model provider available."),
      };
    }
    if (
      wanted &&
      (state.model?.provider !== wanted.provider ||
        state.model?.id !== wanted.id)
    ) {
      return {
        ok: false,
        error: new Error(
          `Pi did not start with model "${wanted.provider}/${wanted.id}"` +
            (state.model?.id
              ? ` (it chose "${String(state.model.provider)}/${String(state.model.id)}")`
              : "") +
            ". Check that the provider is authenticated.",
        ),
      };
    }
    return { ok: true };
  }

  private awaitReady(timeoutMs: number, child: PiRpcChild): Promise<void> {
    if (child.exited) {
      return Promise.reject(
        new Error("pi exited before its extension reported ready"),
      );
    }
    const ready = this.ready;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("pi extension did not report ready in time"));
      }, timeoutMs);
      timer.unref?.();
      ready.promise.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async getState(timeoutMs?: number): Promise<PiRpcSessionState> {
    if (!this.child) {
      return this.lastState ?? {
        model: this.options.model,
        thinkingLevel: this.options.thinkingLevel,
        isStreaming: false,
        isCompacting: false,
        sessionFile: this.options.sessionFilePath,
      };
    }
    const data = await this.requireChild().requestOk(
      { type: "get_state" },
      timeoutMs,
    );
    const state = (data ?? {}) as PiRpcSessionState;
    this.liveModel = state.model;
    this.lastState = state;
    return state;
  }

  prompt(text: string, images?: ImageContent[]): PiInputDispatch {
    const inbox = this.inbox;
    this.inbox = undefined;
    if (inbox) text = `${inbox}\n\n---\n\n${text}`;
    const child = this.child;
    if (!child || child.exited) {
      const consumed = Promise.reject(new Error("No active Pi session"));
      void consumed.catch(() => undefined);
      return { consumed, settled: Promise.resolve(null) };
    }
    const tracked = this.trackPendingInputConsumption("followUp");
    const settlement = new Promise<PiPromptRunOutcome>((resolve) => {
      this.pendingRunSettlements.push({ resolve });
    });
    const settled = this.dispatchWithTransientAuthRetry(
      child,
      {
        type: "prompt",
        message: text,
        ...(images && images.length > 0 ? { images } : {}),
        streamingBehavior: "followUp",
      },
      NO_REQUEST_TIMEOUT,
    ).then(
      async (data): Promise<PiPromptRunOutcome | null> => {
        if (typeof data === "object" && data !== null && "disposition" in data && data.disposition === "handled") {
          this.resolvePendingInputConsumption(tracked.pending);
          this.pendingRunSettlements.pop()?.resolve({});
          return {};
        }
        if (tracked.pending.queuedText !== null) {
          this.dropRunSettlement();
          return null;
        }
        this.resolvePendingInputConsumption(tracked.pending);
        const outcome = await settlement;
        return outcome;
      },
      (error: unknown): PiPromptRunOutcome | null => {
        this.dropRunSettlement();
        const queued = tracked.pending.queuedText !== null;
        this.rejectPendingInputConsumption(tracked.pending, asError(error));
        this.rejectPendingInputConsumptions(
          "Pi prompt failed before input was consumed",
        );
        this.onDone(error);
        return queued ? null : { error };
      },
    );
    return { consumed: tracked.promise, settled };
  }

  async steer(text: string, images?: ImageContent[]): Promise<void> {
    const child = this.requireChild();
    const tracked = this.trackPendingInputConsumption("steering");
    try {
      await this.dispatchWithTransientAuthRetry(child, {
        type: "prompt",
        message: text,
        ...(images && images.length > 0 ? { images } : {}),
        streamingBehavior: "steer",
      });
    } catch (error) {
      this.rejectPendingInputConsumption(tracked.pending, asError(error));
      this.onDone(error);
      throw error;
    }
    if (tracked.pending.queuedText === null) {
      this.resolvePendingInputConsumption(tracked.pending);
      return;
    }
    void tracked.promise.catch((error) => {
      this.onDone(error);
    });
  }


  async closeGracefully(timeoutMs: number): Promise<string | undefined> {
    this.rejectPendingInputConsumptions("Pi session closed before input was consumed");
    this.closed = true;
    this.cancellation.abort(new Error("Pi turn cancelled"));
    if (this.starting) this.child?.kill();
    await this.startDone?.catch(() => undefined);
    const child = this.child;
    const deadline = Date.now() + timeoutMs;
    if (child && !child.exited) {
      await child.request({ type: "abort" }, Math.max(1, Math.floor(timeoutMs / 2))).catch(() => undefined);
      await this.refreshLeafId(Math.max(1, deadline - Date.now())).catch(() => undefined);
    }
    await this.stopTurn();
    return this.lastKnownLeafId ?? undefined;
  }

  kill(): void {
    this.closed = true;
    this.cancellation.abort(new Error("Pi turn cancelled"));
    this.child?.kill();
  }

  static async forkSessionFile(args: {
    sourceFile: string;
    targetFile: string;
    cwd: string;
    sessionDir: string;
    checkpointId?: string;
    extensionPath: string;
    scratchDir: string;
    recordThreadId: string;
    shellEnvOverrides?: Record<string, string>;
    dataDir: string;
  }): Promise<void> {
    const session = new PiRpcSession(
      {
        cwd: args.cwd,
        ...(args.shellEnvOverrides ? { shellEnvOverrides: args.shellEnvOverrides } : {}),
        sessionFilePath: args.sourceFile,
        sessionDir: args.sessionDir,
        scratchDir: args.scratchDir,
        dataDir: args.dataDir,
        extensionPath: args.extensionPath,
        recordThreadId: args.recordThreadId,
        noSession: true,
      },
      () =>
        Promise.resolve({ content: "fork helper has no tools", isError: true }),
      () => undefined,
      () => undefined,
    );
    try {
      await session.start();
      await session.channelRequest({
        method: "fork",
        sourceFile: args.sourceFile,
        targetFile: args.targetFile,
        cwd: args.cwd,
        sessionDir: args.sessionDir,
        ...(args.checkpointId === undefined
          ? {}
          : { checkpointId: args.checkpointId }),
      });
    } finally {
      session.kill();
    }
  }

  private requireChild(): PiRpcChild {
    if (!this.child || this.child.exited) {
      throw new Error("No active Pi session");
    }
    return this.child;
  }

  private writePromptFiles(): { args: string[]; paths: string[] } {
    const args: string[] = [];
    const paths: string[] = [];
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (this.options.systemPrompt !== undefined) {
      const file = join(this.options.scratchDir, `pi-system-${stamp}.md`);
      writeFileSync(file, this.options.systemPrompt, "utf8");
      args.push("--system-prompt", file);
      paths.push(file);
    }
    if (this.options.appendSystemPrompt !== undefined) {
      const file = join(this.options.scratchDir, `pi-append-${stamp}.md`);
      writeFileSync(file, this.options.appendSystemPrompt, "utf8");
      args.push("--append-system-prompt", file);
      paths.push(file);
    }
    return { args, paths };
  }

  private async dispatchWithTransientAuthRetry(
    child: PiRpcChild,
    command: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await child.requestOk(command, timeoutMs);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error instanceof PiRpcChildExitedError ||
          !error.message.startsWith("No API key found for ") ||
          attempt >= PI_TRANSIENT_AUTH_MAX_RETRIES
        ) {
          throw error;
        }
        await waitForPiTransientAuthRetry();
      }
    }
  }

  private handleEvent(raw: Record<string, unknown>): void {
    if (typeof raw.type !== "string") {
      return;
    }
    const event = raw as PiRpcEvent;
    if (event.type === "compaction_start") {
      this.isCompacting = true;
      if (this.memory)
        this.compactionError = new Error("Pi compacted an agent turn despite automatic compaction being disabled.");
    }
    if (event.type === "compaction_end") this.isCompacting = false;
    this.observeInputConsumption(event);
    this.observeTerminalSteerSettlement(event);
    if (event.type === "agent_end") {
      this.deliverInOrder(async () => {
        const leafId = await this.takeAgentEndLeaf();
        if (leafId !== null) {
          this.lastKnownLeafId = leafId;
        }
        this.onEvent({
          ...event,
          ...(this.lastKnownLeafId === null
            ? {}
            : { providerCheckpointId: this.lastKnownLeafId }),
        });
        if (event.willRetry !== true) this.runOutcome = this.outcomeForRun(event);
      });
      return;
    }
    if (event.type === "agent_settled") {
      this.deliverInOrder(() => {
        this.onEvent(event);
        for (const pending of this.pendingRunSettlements.splice(0)) {
          pending.resolve(this.compactionError ? { error: this.compactionError } : this.runOutcome);
        }
      });
      return;
    }
    if (event.type === "turn_end" || event.type === "compaction_end") {
      this.deliverInOrder(async () => {
        await this.refreshContextUsage().catch(() => undefined);
        this.onEvent(event);
      });
      return;
    }
    this.deliverInOrder(() => {
      this.onEvent(event);
    });
  }

  private deliverInOrder(deliver: () => void | Promise<void>): Promise<void> {
    const next = this.deliveryChain.then(deliver, deliver);
    this.deliveryChain = next.catch(() => undefined);
    return this.deliveryChain;
  }

  private outcomeForRun(event: PiRpcEvent): PiPromptRunOutcome {
    const messages = Array.isArray(event.messages) ? event.messages : [];
    const last = messages[messages.length - 1] as
      | { role?: string; stopReason?: string; errorMessage?: string }
      | undefined;
    if (
      last?.role === "assistant" &&
      last.stopReason === "error" &&
      typeof last.errorMessage === "string"
    ) {
      return { error: new Error(last.errorMessage) };
    }
    return {};
  }

  private dropRunSettlement(): void {
    this.pendingRunSettlements.pop();
  }

  private async refreshLeafId(
    timeoutMs = CHANNEL_REQUEST_TIMEOUT_MS,
  ): Promise<void> {
    const child = this.child;
    if (!child || child.exited) {
      return;
    }
    const data = (await this.channelRequest({ method: "leaf" }, timeoutMs)) as
      | { leafId?: string | null }
      | undefined;
    if (data && typeof data.leafId === "string") {
      this.lastKnownLeafId = data.leafId;
    }
  }

  private takeAgentEndLeaf(): Promise<string | null> {
    const queued = this.agentEndLeafReports.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        if (this.agentEndLeafWaiter === settle) {
          this.agentEndLeafWaiter = null;
        }
        resolve(null);
      }, AGENT_END_LEAF_TIMEOUT_MS);
      timer.unref?.();
      const settle = (leafId: string | null) => {
        clearTimeout(timer);
        resolve(leafId);
      };
      this.agentEndLeafWaiter = settle;
    });
  }

  private async refreshContextUsage(): Promise<void> {
    const child = this.child;
    if (!child || child.exited) {
      return;
    }
    const data = (await child.requestOk({ type: "get_session_stats" })) as
      | {
          contextUsage?: { tokens?: number | null; contextWindow?: number };
        }
      | undefined;
    const usage = data?.contextUsage;
    if (usage && typeof usage.contextWindow === "number") {
      this.lastContextUsage = {
        tokens: typeof usage.tokens === "number" ? usage.tokens : null,
        contextWindow: usage.contextWindow,
      };
    }
  }

  private handleChannelMessage(message: Record<string, unknown>): void {
    const child = this.child;
    if (message.kind === "ready") {
      this.ready.resolve();
      return;
    }
    if (message.kind === "agent-end-leaf") {
      const leafId = typeof message.leafId === "string" ? message.leafId : null;
      const waiter = this.agentEndLeafWaiter;
      if (waiter) {
        this.agentEndLeafWaiter = null;
        waiter(leafId);
      } else {
        this.agentEndLeafReports.push(leafId);
      }
      return;
    }
    if (message.kind === "tool-call" && child) {
      const id = String(message.id);
      const toolName = String(message.toolName);
      const toolArgs =
        typeof message.arguments === "object" && message.arguments !== null
          ? (message.arguments as Record<string, unknown>)
          : {};
      void this.forwardToolCall(toolName, toolArgs).then(
        (result) => {
          child.sendChannel({
            kind: "tool-result",
            id,
            content: buildBridgeToolCallContent(result),
            isError: result.isError === true,
          });
        },
        (error: unknown) => {
          child.sendChannel({
            kind: "tool-result",
            id,
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            isError: true,
          });
        },
      );
      return;
    }
    if (message.kind === "reply") {
      const reply = this.channelReplies.get(String(message.id));
      if (!reply) {
        return;
      }
      this.channelReplies.delete(String(message.id));
      if (typeof message.error === "string") {
        reply.reject(new Error(message.error));
      } else {
        reply.resolve(message.result);
      }
    }
  }

  private channelRequest(
    request: Record<string, unknown>,
    timeoutMs = CHANNEL_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const child = this.requireChild();
    this.nextChannelRequestId += 1;
    const id = `cr-${this.nextChannelRequestId}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.channelReplies.delete(id);
        reject(
          new Error(`pi extension did not answer ${String(request.method)}`),
        );
      }, timeoutMs);
      timer.unref?.();
      this.channelReplies.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.sendChannel({ kind: "request", id, ...request });
    });
  }

  private handleExit(info: PiRpcChildExitInfo): void {
    this.ready.reject(new PiRpcChildExitedError(info));
    for (const [, reply] of this.channelReplies) {
      reply.reject(new PiRpcChildExitedError(info));
    }
    this.channelReplies.clear();
    const leafWaiter = this.agentEndLeafWaiter;
    if (leafWaiter) {
      this.agentEndLeafWaiter = null;
      leafWaiter(null);
    }
    this.rejectPendingInputConsumptions("Pi exited before input was consumed");
    for (const pending of this.pendingRunSettlements.splice(0)) {
      pending.resolve({ error: new PiRpcChildExitedError(info) });
    }
    this.isCompacting = false;
    if (!this.closed && !this.starting) {
      this.onDone(new PiRpcChildExitedError(info));
    }
  }


  private trackPendingInputConsumption(
    queue: PiInputQueue,
  ): TrackedInputConsumption {
    let resolvePromise: () => void = () => undefined;
    let rejectPromise: (error: Error) => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const pending: PendingInputConsumption = {
      queue,
      queuedText: null,
      reject: rejectPromise,
      resolve: resolvePromise,
    };
    this.pendingInputConsumptions.push(pending);
    void promise.catch(() => undefined);
    return { pending, promise };
  }

  private observeInputConsumption(event: PiRpcEvent): void {
    if (event.type !== "queue_update") {
      return;
    }
    this.observeQueue("steering", toStringArray(event.steering));
    this.observeQueue("followUp", toStringArray(event.followUp));
  }

  private observeQueue(
    queue: PiInputQueue,
    queuedTexts: readonly string[],
  ): void {
    const lastObserved = this.lastObservedQueues[queue];
    const added = listMultisetDifference(queuedTexts, lastObserved);
    const removed = listMultisetDifference(lastObserved, queuedTexts);
    this.lastObservedQueues[queue] = [...queuedTexts];
    for (const queuedText of added) {
      const pending = this.pendingInputConsumptions.find(
        (entry) => entry.queue === queue && entry.queuedText === null,
      );
      if (!pending) {
        break;
      }
      pending.queuedText = queuedText;
    }
    for (const queuedText of removed) {
      const pending = this.pendingInputConsumptions.find(
        (entry) => entry.queue === queue && entry.queuedText === queuedText,
      );
      if (pending) {
        this.resolvePendingInputConsumption(pending);
      }
    }
  }

  private observeTerminalSteerSettlement(event: PiRpcEvent): void {
    if (event.type === "agent_end") {
      if (event.willRetry !== true) {
        this.scheduleTerminalSteerSettlement();
      }
      return;
    }
    if (event.type === "auto_retry_start") {
      this.autoRetryInProgress = true;
      this.clearTerminalSteerSettlement();
      return;
    }
    if (event.type === "auto_retry_end") {
      this.autoRetryInProgress = false;
      if (event.success !== true) {
        this.rejectPendingInputConsumptions(
          "Pi auto retry ended before steer was consumed",
          "steering",
        );
      }
    }
  }

  private scheduleTerminalSteerSettlement(): void {
    if (
      !this.pendingInputConsumptions.some(
        (entry) => entry.queue === "steering",
      ) ||
      this.terminalSteerSettlement !== null
    ) {
      return;
    }
    const child = this.child;
    if (!child || child.exited) {
      return;
    }
    const settlement = child
      .request({ type: "get_state" })
      .then((response) => {
        const state = (response.data ?? {}) as Partial<PiRpcSessionState>;
        return state.isStreaming === true;
      })
      .catch(() => false)
      .then((streaming) => {
        if (this.terminalSteerSettlement !== settlement) {
          return;
        }
        this.terminalSteerSettlement = null;
        if (this.autoRetryInProgress || streaming) {
          return;
        }
        this.rejectPendingInputConsumptions(
          "Pi turn ended before steer was consumed",
          "steering",
        );
      });
    this.terminalSteerSettlement = settlement;
  }

  private clearTerminalSteerSettlement(): void {
    this.terminalSteerSettlement = null;
  }

  private resolvePendingInputConsumption(
    pending: PendingInputConsumption,
  ): void {
    const index = this.pendingInputConsumptions.indexOf(pending);
    if (index === -1) {
      return;
    }
    this.pendingInputConsumptions.splice(index, 1);
    pending.resolve();
  }

  private rejectPendingInputConsumption(
    pending: PendingInputConsumption,
    error: Error,
  ): void {
    const index = this.pendingInputConsumptions.indexOf(pending);
    if (index === -1) {
      return;
    }
    this.pendingInputConsumptions.splice(index, 1);
    pending.reject(error);
  }

  private rejectPendingInputConsumptions(
    message: string,
    queue?: PiInputQueue,
  ): void {
    this.clearTerminalSteerSettlement();
    for (const pending of this.pendingInputConsumptions.splice(0)) {
      if (queue !== undefined && pending.queue !== queue) {
        this.pendingInputConsumptions.push(pending);
        continue;
      }
      pending.reject(new Error(message));
    }
  }
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function listMultisetDifference(
  source: readonly string[],
  subtract: readonly string[],
): string[] {
  const remaining = [...subtract];
  const difference: string[] = [];
  for (const entry of source) {
    const index = remaining.indexOf(entry);
    if (index === -1) {
      difference.push(entry);
      continue;
    }
    remaining.splice(index, 1);
  }
  return difference;
}
