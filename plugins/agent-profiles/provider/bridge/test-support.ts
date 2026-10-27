import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { z } from "zod";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import type {
  BridgeJsonRpcId,
  BridgeJsonRpcObject,
  BridgeJsonRpcOutputMessage,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { experimental_closeAllForTests, experimental_providerBridge, handleLine } from "./bridge.js";
import { PI_BRIDGE_ARGS_ENV, PI_BRIDGE_COMMAND_ENV, resolvePiLaunch } from "./rpc-child.js";
import { PI_BRIDGE_SESSION_DIR_ENV } from "./session-paths.js";
import { startMemoryFixture } from "../memory-test-support.js";

export const fakePiPath = fileURLToPath(
  new URL("./fake-pi-rpc.mjs", import.meta.url),
);

export function isolatePiTestEnv(root: string): void {
  const home = join(root, "home");
  const bin = join(root, "empty-bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("OPTCHAT_HOME", join(root, "optchat"));
  vi.stubEnv("FAKE_PI_TEST_ROOT", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "pi-agent"));
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("PI_SKIP_VERSION_CHECK", "1");
  vi.stubEnv("PATH", bin);
  vi.stubEnv(PI_BRIDGE_COMMAND_ENV, process.execPath);
  vi.stubEnv(PI_BRIDGE_ARGS_ENV, JSON.stringify([fakePiPath]));
}

export function assertFakePiLaunch(): void {
  const launch = resolvePiLaunch(process.env);
  if (launch.command !== process.execPath || launch.args.length !== 1 || launch.args[0] !== fakePiPath) {
    throw new Error("Offline tests require the fake Pi launcher; refusing to start real Pi.");
  }
}

export const FULL_PERMISSION_OPTIONS = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
  model: "openai-codex/gpt-fake",
} as const;

const INITIALIZE_ID = 100;
const FIRST_HARNESS_REQUEST_ID = 1_000_000;
const RESPONSE_DEADLINE_MS = 60_000;

const threadDeltaParamsSchema = z.object({
  threadId: z.string(),
  deltas: z.array(z.record(z.string(), z.unknown())),
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface StartFakePiBridgeOptions {
  prefix: string;
  sessionDir?: (workspaceDir: string) => string;
  initialize: boolean;
  processLog?: boolean;
  hostId?: "primary" | "remote" | "remote2";
}

export interface FakePiBridgeHarness {
  workspaceDir: string;
  sessionDir: string;
  messages: BridgeJsonRpcOutputMessage[];
  memory: Awaited<ReturnType<typeof startMemoryFixture>>;
  takeMessages(): BridgeJsonRpcOutputMessage[];
  request(
    id: BridgeJsonRpcId,
    method: string,
    params: BridgeJsonRpcObject,
  ): Promise<BridgeJsonRpcOutputMessage>;
  startThread(
    threadId: string,
    extra?: BridgeJsonRpcObject,
  ): Promise<BridgeJsonRpcOutputMessage>;
  deltasOf(threadId: string): Record<string, unknown>[];
  waitFor(predicate: () => boolean, what: string): Promise<void>;
  waitForDelta(
    threadId: string,
    predicate: (delta: Record<string, unknown>) => boolean,
    since?: number,
  ): Promise<void>;
  waitForTurnBoundary(threadId: string, since?: number): Promise<number>;
  waitForMessage(
    predicate: (message: BridgeJsonRpcOutputMessage) => boolean,
    what: string,
  ): Promise<BridgeJsonRpcOutputMessage>;
  readProcessLog(): { spawned: number[]; exited: number[] };
  teardown(): Promise<void>;
}

export async function startFakePiBridge(
  options: StartFakePiBridgeOptions,
): Promise<FakePiBridgeHarness> {
  const workspaceDir = mkdtempSync(join(tmpdir(), options.prefix));
  const sessionDir =
    options.sessionDir === undefined
      ? join(workspaceDir, "sessions")
      : options.sessionDir(workspaceDir);
  const processLogPath = join(workspaceDir, "process.log");
  isolatePiTestEnv(workspaceDir);
  const memory = await startMemoryFixture(workspaceDir);
  const hostId = options.hostId ?? "primary";
  await experimental_providerBridge.start?.({
    pluginId: "agent-profiles",
    dataDir: memory.dataDirs[hostId],
    tempDir: join(workspaceDir, "bridge-temp"),
  });
  const threadAgents = new Map<string, string>();
  vi.stubEnv(PI_BRIDGE_SESSION_DIR_ENV, sessionDir);
  if (options.processLog === true) {
    vi.stubEnv("FAKE_PI_PROCESS_LOG", processLogPath);
  }
  const harness = createBridgeJsonRpcTestHarness(handleLine);
  let nextHarnessRequestId = FIRST_HARNESS_REQUEST_ID;
  const bridge: FakePiBridgeHarness = {
    workspaceDir,
    sessionDir,
    memory,
    messages: harness.messages,
    takeMessages: harness.takeMessages,
    async request(id, method, params) {
      assertFakePiLaunch();
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      const opts = params.options as BridgeJsonRpcObject | undefined;
      const providerOptions = opts?.providerOptions as BridgeJsonRpcObject | undefined;
      if (method === "thread/start" && threadId && typeof providerOptions?.agent === "string")
        threadAgents.set(threadId, typeof providerOptions.memoryKey === "string"
          ? providerOptions.memoryKey.slice("agent-".length) : providerOptions.agent);
      if (method === "turn/start") params = { ...params, options: { ...opts, envVars: {
        MODEL_GATEWAY_BASE_URL: "http://fake-gateway.invalid/v1", MODEL_GATEWAY_TOKEN: "fake-token",
        ...opts?.envVars as BridgeJsonRpcObject,
      } } };
      const agent = threadId ? threadAgents.get(threadId) : undefined;
      if (method === "turn/start" && threadId && agent && (opts === undefined || opts !== null && typeof opts === "object" && !Array.isArray(opts))) {
        params = { ...params, options: { ...opts, envVars: { MODEL_GATEWAY_BASE_URL: "http://fake-gateway.invalid/v1", MODEL_GATEWAY_TOKEN: "fake-token", ...opts?.envVars as BridgeJsonRpcObject, ...await memory.env(threadId, agent, hostId) } } };
      }
      harness.sendRequest(id, method, params);
      const deadline = Date.now() + RESPONSE_DEADLINE_MS;
      while (Date.now() < deadline) {
        const response = harness.messages.find((message) => message.id === id);
        if (response !== undefined) return response;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`no response to ${method}`);
    },
    startThread(threadId, extra = {}) {
      nextHarnessRequestId += 1;
      return bridge.request(nextHarnessRequestId, "thread/start", {
        threadId,
        cwd: workspaceDir,
        instructionMode: "append",
        options: FULL_PERMISSION_OPTIONS,
        ...extra,
      });
    },
    deltasOf(threadId) {
      return harness.messages
        .filter((message) => message.method === "thread/delta")
        .map((message) => threadDeltaParamsSchema.parse(message.params))
        .filter((params) => params.threadId === threadId)
        .flatMap((params) => params.deltas);
    },
    async waitFor(predicate, what) {
      const deadline = Date.now() + RESPONSE_DEADLINE_MS;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`timed out waiting for ${what}`);
    },
    waitForDelta(threadId, predicate, since = 0) {
      return bridge.waitFor(
        () => bridge.deltasOf(threadId).slice(since).some(predicate),
        `a delta of ${threadId}`,
      );
    },
    async waitForTurnBoundary(threadId, since = 0) {
      await bridge.waitFor(
        () =>
          bridge
            .deltasOf(threadId)
            .slice(since)
            .some((delta) => delta.kind === "turn.boundary"),
        `the turn of ${threadId} to end`,
      );
      return bridge.deltasOf(threadId).length;
    },
    async waitForMessage(predicate, what) {
      await bridge.waitFor(() => harness.messages.some(predicate), what);
      const found = harness.messages.find(predicate);
      if (found === undefined) throw new Error(`timed out waiting for ${what}`);
      return found;
    },
    readProcessLog() {
      const lines = existsSync(processLogPath)
        ? readFileSync(processLogPath, "utf8").split("\n").filter(Boolean)
        : [];
      const spawned: number[] = [];
      const exited: number[] = [];
      for (const line of lines) {
        const [step, pid] = line.split(":");
        (step === "spawn" ? spawned : exited).push(Number(pid));
      }
      return { spawned, exited };
    },
    async teardown() {
      await experimental_closeAllForTests();
      await bridge.waitFor(
        () => bridge.readProcessLog().spawned.every((pid) => !isRunning(pid)),
        "fake Pi processes to exit",
      );
      harness.restore();
      await memory.close();
      vi.unstubAllEnvs();
      rmSync(workspaceDir, { recursive: true, force: true });
    },
  };
  if (options.initialize) {
    try {
      await bridge.request(INITIALIZE_ID, "initialize", {
        protocolVersion: 2,
        client: { name: "test", version: "0" },
        grammarVersions: [3, 3],
      });
    } catch (error) {
      await bridge.teardown();
      throw error;
    }
  }
  return bridge;
}
