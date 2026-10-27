import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { FULL_PERMISSION_OPTIONS, type FakePiBridgeHarness, startFakePiBridge } from "./test-support.js";

let harness: FakePiBridgeHarness;
let requestId = 2000;
let launchLog: string;
type Launch = { pid: number; args: string[] };

beforeEach(async () => {
  harness = await startFakePiBridge({ prefix: "hempi-provider-", initialize: true, processLog: true });
  launchLog = join(harness.workspaceDir, "launches.jsonl");
  vi.stubEnv("FAKE_PI_LAUNCH_LOG", launchLog);
  vi.stubEnv("MODEL_GATEWAY_BASE_URL", "");
});
afterEach(async () => { await harness.teardown(); });

function launches(): Launch[] {
  return existsSync(launchLog) ? readFileSync(launchLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

async function start(threadId: string, providerOptions: Record<string, unknown> = {}): Promise<string> {
  const response = await harness.startThread(threadId, { options: { ...FULL_PERMISSION_OPTIONS, providerOptions: { threadId, ...providerOptions } } });
  expect(response.error).toBeUndefined();
  return z.object({ providerThreadId: z.string() }).parse(response.result).providerThreadId;
}

function turn(threadId: string, providerThreadId: string, text: string, providerOptions?: Record<string, unknown>, model: string = FULL_PERMISSION_OPTIONS.model, envVars?: Record<string, string>) {
  requestId++;
  return harness.request(requestId, "turn/start", {
    threadId, providerThreadId, clientRequestId: `creq_${requestId.toString(16).padStart(10, "0").replace(/0/g, "w").replace(/1/g, "x")}`,
    input: [{ type: "text", text, mentions: [] }],
    options: { ...FULL_PERMISSION_OPTIONS, model, ...(envVars === undefined ? {} : { envVars }), ...(providerOptions === undefined ? {} : { providerOptions: { threadId, ...providerOptions } }) },
  });
}

it("starts once per turn, keeps the session file, and holds the child through agent_end until agent_settled", async () => {
  const threadId = "thr_lifecycle";
  const providerThreadId = await start(threadId);
  expect(launches()).toEqual([]);
  const endMarker = join(harness.workspaceDir, "end");
  const settledMarker = join(harness.workspaceDir, "settled");
  vi.stubEnv("FAKE_PI_END_MARKER", endMarker);
  vi.stubEnv("FAKE_PI_SETTLED_MARKER", settledMarker);
  expect((await turn(threadId, providerThreadId, "/delayed-settle")).error).toBeUndefined();
  await harness.waitFor(() => existsSync(endMarker), "agent_end");
  const firstPid = Number(readFileSync(endMarker, "utf8"));
  expect(harness.readProcessLog().exited).not.toContain(firstPid);
  expect(harness.deltasOf(threadId).filter((item) => item.kind === "turn.boundary")).toEqual([]);
  await harness.waitForTurnBoundary(threadId);
  expect(existsSync(settledMarker)).toBe(true);
  expect(harness.readProcessLog().exited).toContain(firstPid);
  const since = harness.deltasOf(threadId).length;
  expect((await turn(threadId, providerThreadId, "second")).error).toBeUndefined();
  await harness.waitForTurnBoundary(threadId, since);
  const children = launches();
  expect(children).toHaveLength(2);
  expect(children[1].pid).not.toBe(children[0].pid);
  const sessions = children.map(({ args }) => args[args.indexOf("--session") + 1]);
  expect(sessions).toEqual([join(harness.sessionDir, `${providerThreadId}.jsonl`), join(harness.sessionDir, `${providerThreadId}.jsonl`)]);
  expect(harness.readProcessLog().exited).toEqual(expect.arrayContaining(children.map(({ pid }) => pid)));
  expect(children[0].args).toEqual(expect.arrayContaining(["--provider", "model-gateway", "--model", "gpt-fake"]));
});

it("settles handled commands without agent events and surfaces only warning notices", async () => {
  const id = await start("thr_handled");
  expect((await turn("thr_handled", id, "/handled")).error).toBeUndefined();
  await harness.waitForTurnBoundary("thr_handled");
  const deltas = harness.deltasOf("thr_handled");
  expect(deltas).toContainEqual(expect.objectContaining({ kind: "provider.warning", summary: "Command warned" }));
  expect(deltas.filter((item) => item.summary === "Command handled" || item.summary === "Memory ready")).toHaveLength(0);
  expect(deltas.filter((item) => item.kind === "turn.boundary")).toEqual([expect.objectContaining({ status: "completed" })]);
  expect(harness.readProcessLog().exited).toEqual([launches()[0].pid]);
});

it("refreshes persistent persona instructions and binds the agent only on turns", async () => {
  const persona = { agent: "engineer", agentName: "Engineer", memoryKey: "agent-engineer", instructions: "first persona" };
  const id = await start("thr_agent", persona);
  expect(launches()).toEqual([]);
  await turn("thr_agent", id, "/handled");
  await harness.waitForTurnBoundary("thr_agent");
  const first = launches()[0].args;
  expect(first).toEqual(expect.arrayContaining(["--optchat-profile", "agent-engineer", "--optchat-create"]));
  expect(first).not.toContain("--optchat-import-session");
  const file = first[first.indexOf("--optchat-instructions") + 1];
  expect(readFileSync(file, "utf8")).toBe("first persona");
  const since = harness.deltasOf("thr_agent").length;
  await turn("thr_agent", id, "/handled", { ...persona, instructions: "updated persona" });
  await harness.waitForTurnBoundary("thr_agent", since);
  expect(readFileSync(file, "utf8")).toBe("updated persona");
  const second = launches()[1].args;
  expect(second[second.indexOf("--optchat-instructions") + 1]).toBe(file);
});

it("imports existing native history once per session file and survives off/on", async () => {
  const id = await start("thr_memory");
  await turn("thr_memory", id, "native history");
  let since = await harness.waitForTurnBoundary("thr_memory");
  for (const longMemory of [true, false, true]) {
    expect((await turn("thr_memory", id, "/handled", { longMemory })).error).toBeUndefined();
    since = await harness.waitForTurnBoundary("thr_memory", since);
  }
  const [, first, off, again] = launches().map(({ args }) => args);
  expect(first).toEqual(expect.arrayContaining(["--optchat-profile", "thread-thr_memory", "--optchat-create", "--optchat-import-session", join(harness.sessionDir, `${id}.jsonl`)]));
  expect(off.filter((arg) => arg.startsWith("--optchat-"))).toEqual([]);
  expect(again).toContain("--optchat-profile");
  expect(again).not.toContain("--optchat-import-session");
  expect(again).not.toContain("--optchat-instructions");
});

it("binds a new long-memory thread without importing a nonexistent session or later importing its own history", async () => {
  const id = await start("thr_empty", { longMemory: true });
  expect(existsSync(join(harness.sessionDir, `${id}.jsonl`))).toBe(false);
  await turn("thr_empty", id, "new history");
  const since = await harness.waitForTurnBoundary("thr_empty");
  await turn("thr_empty", id, "/handled");
  await harness.waitForTurnBoundary("thr_empty", since);
  for (const { args } of launches()) {
    expect(args).toContain("--optchat-profile");
    expect(args).not.toContain("--optchat-import-session");
  }
});

it("does not mark a failed import as successful", async () => {
  const id = await start("thr_import");
  await turn("thr_import", id, "native history");
  let since = await harness.waitForTurnBoundary("thr_import");
  vi.stubEnv("FAKE_PI_STARTUP_EXIT", "65");
  expect((await turn("thr_import", id, "/handled", { longMemory: true })).error).toMatchObject({ message: expect.stringContaining("optchat: import failed:") });
  vi.stubEnv("FAKE_PI_STARTUP_EXIT", "");
  await turn("thr_import", id, "/handled");
  since = await harness.waitForTurnBoundary("thr_import", since);
  await turn("thr_import", id, "/handled");
  await harness.waitForTurnBoundary("thr_import", since);
  expect(launches().map(({ args }) => args.includes("--optchat-import-session"))).toEqual([false, true, true, false]);
});

it("runs agent tasks without a memory key unbound, so they never wait for the DM", async () => {
  const id = await start("thr_task", { agent: "engineer", agentName: "Engineer", instructions: "persona" });
  expect((await turn("thr_task", id, "/handled")).error).toBeUndefined();
  await harness.waitForTurnBoundary("thr_task");
  expect(launches().at(-1)?.args).not.toContain("--optchat-profile");
});

it("fails a busy profile at once instead of waiting inside turn start", async () => {
  const id = await start("thr_busy", { agent: "engineer", agentName: "Engineer", memoryKey: "agent-engineer", instructions: "persona" });
  vi.stubEnv("FAKE_PI_ATTEMPT_FILE", join(harness.workspaceDir, "attempts"));
  vi.stubEnv("FAKE_PI_BUSY_ATTEMPTS", "999");
  const response = await turn("thr_busy", id, "/handled");
  expect(response.error).toMatchObject({ message: expect.stringContaining("Engineer's memory is held by another process") });
  expect(launches()).toHaveLength(1);
});

it.each([65, 66])("reports startup exit %s with its stderr line and never retries", async (code) => {
  const id = await start(`thr_exit_${code}`, { longMemory: true });
  vi.stubEnv("FAKE_PI_STARTUP_EXIT", String(code));
  const response = await turn(`thr_exit_${code}`, id, "/handled");
  expect(response.error).toMatchObject({ message: expect.stringContaining(code === 65 ? "optchat: import failed:" : "optchat: profile not found:") });
  expect(launches()).toHaveLength(1);
});

it("fails a recovery-marker refusal with its location and does not retry it as busy", async () => {
  const id = await start("thr_recovery", { longMemory: true });
  const profile = join(harness.workspaceDir, "optchat/profiles/thread-thr_recovery");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "remote-pending.json"), JSON.stringify({ hostId: "remote-host", operationId: "retained-operation", directory: "/retained/profile" }));
  const response = await turn("thr_recovery", id, "/handled");
  expect(response.error).toMatchObject({ message: expect.stringContaining("requires remote memory recovery") });
  expect(response.error).toMatchObject({ message: expect.stringContaining("/retained/profile on remote-host") });
  expect(launches()).toHaveLength(1);
});

it("keeps catalogs, health probes and fork helpers unbound even for agent threads", async () => {
  const threadId = "thr_probe";
  const id = await start(threadId, { agent: "engineer", instructions: "persona" });
  await turn(threadId, id, "/handled");
  await harness.waitForTurnBoundary(threadId);
  const listed = await harness.request(++requestId, "model/list", { cwd: harness.workspaceDir });
  expect(listed.result).toMatchObject({ models: [expect.objectContaining({ id: "openai-codex/gpt-fake" }), expect.objectContaining({ id: "openai-codex/gpt-fake-mini" })] });
  const health = await harness.request(++requestId, "provider/health", { providerId: "hempi", cwd: harness.workspaceDir });
  // Unsupported health keeps Hempi and Agents out of BB's model picker.
  expect(health.result).toEqual({ supported: false });
  const forked = await harness.request(++requestId, "thread/fork", {
    threadId: "thr_fork", sourceProviderThreadId: id, cwd: harness.workspaceDir,
    instructionMode: "append", options: { ...FULL_PERMISSION_OPTIONS, providerOptions: { agent: "engineer", instructions: "persona", threadId: "thr_fork" } },
  });
  expect(forked.error).toBeUndefined();
  const helpers = launches().filter(({ args }) => args.includes("--no-session"));
  expect(helpers).toHaveLength(2);
  for (const helper of helpers) expect(helper.args.filter((arg) => arg.startsWith("--optchat-"))).toEqual([]);
});

it("rejects forbidden thread and turn models before a main process can start", async () => {
  const rejected = await harness.startThread("thr_forbidden", { options: { ...FULL_PERMISSION_OPTIONS, model: "anthropic/forbidden-model" } });
  expect(rejected.error).toMatchObject({ message: expect.stringContaining("openai-codex/*") });
  const id = await start("thr_guard");
  const response = await turn("thr_guard", id, "/handled", undefined, "anthropic/forbidden-model");
  expect(response.error).toMatchObject({ message: expect.stringContaining("openai-codex/*") });
  expect(launches()).toEqual([]);
});

it("requires a Gateway URL and token even when native credentials are available", async () => {
  vi.stubEnv("FAKE_PI_GATEWAY_MODELS", "1");
  const threadId = "thr_gateway";
  const model = "openai-codex/gpt-6-sol";
  const response = await harness.startThread(threadId, { options: { ...FULL_PERMISSION_OPTIONS, model } });
  const id = z.object({ providerThreadId: z.string() }).parse(response.result).providerThreadId;
  expect((await turn(threadId, id, "/handled", undefined, model, { MODEL_GATEWAY_BASE_URL: "" })).error).toMatchObject({ message: expect.stringContaining("required") });
  expect((await turn(threadId, id, "/handled", undefined, model, { MODEL_GATEWAY_TOKEN: "" })).error).toMatchObject({ message: expect.stringContaining("required") });
  expect(launches()).toEqual([]);
  expect((await turn(threadId, id, "/handled", undefined, model, { MODEL_GATEWAY_BASE_URL: "http://turn-gateway.invalid/v1" })).error).toBeUndefined();
  await harness.waitForTurnBoundary(threadId);
  expect(launches().map(({ args }) => args[args.indexOf("--provider") + 1])).toEqual(["model-gateway"]);
});

it("routes Gateway catalogs and forks without binding memory and includes Gateway Claude models", async () => {
  vi.stubEnv("MODEL_GATEWAY_BASE_URL", "http://gateway.invalid/http/v1");
  vi.stubEnv("FAKE_PI_GATEWAY_MODELS", "1");
  const listed = await harness.request(++requestId, "model/list", { cwd: harness.workspaceDir });
  expect(listed.result).toMatchObject({ models: expect.arrayContaining([expect.objectContaining({ id: "openai-codex/gpt-6-sol" })]) });
  const health = await harness.request(++requestId, "provider/health", { providerId: "hempi", cwd: harness.workspaceDir });
  expect(health.error).toBeUndefined();
  const threadId = "thr_gateway_fork_source";
  const response = await harness.startThread(threadId, { options: { ...FULL_PERMISSION_OPTIONS, model: "openai-codex/gpt-6-sol" } });
  const id = z.object({ providerThreadId: z.string() }).parse(response.result).providerThreadId;
  expect((await turn(threadId, id, "/handled", undefined, "openai-codex/gpt-6-sol")).error).toBeUndefined();
  await harness.waitForTurnBoundary(threadId);
  const forked = await harness.request(++requestId, "thread/fork", {
    threadId: "thr_gateway_fork", sourceProviderThreadId: id, cwd: harness.workspaceDir,
    instructionMode: "append", options: { ...FULL_PERMISSION_OPTIONS, model: "openai-codex/gpt-6-sol", providerOptions: { agent: "engineer", instructions: "persona" } },
  });
  expect(forked.error).toBeUndefined();
  const helpers = launches().filter(({ args }) => args.includes("--no-session"));
  expect(helpers).toHaveLength(2);
  for (const { args } of helpers) {
    expect(args[args.indexOf("--provider") + 1]).toBe("model-gateway");
    expect(args.filter((arg) => arg.startsWith("--optchat-"))).toEqual([]);
  }
});

it("lists canonical Codex inventory from the installed Gateway extension without a thread token or direct login", async () => {
  vi.stubEnv("FAKE_PI_GATEWAY_MODELS", "1");
  vi.stubEnv("FAKE_PI_NO_DIRECT_AUTH", "1");
  const listed = await harness.request(++requestId, "model/list", { cwd: harness.workspaceDir });
  expect(listed.result).toMatchObject({ models: expect.arrayContaining([expect.objectContaining({ id: "openai-codex/gpt-6-sol" })]) });
  expect(launches().map(({ args }) => args[args.indexOf("--provider") + 1])).toEqual(["openai-codex"]);
  expect(launches()[0].args.filter((arg) => arg.startsWith("--optchat-"))).toEqual([]);
});

it("fails closed before discovery when a sanitized launcher loses BB_PI_BRIDGE_COMMAND", async () => {
  vi.stubEnv("BB_PI_BRIDGE_COMMAND", undefined);
  await expect(harness.request(++requestId, "model/list", { cwd: harness.workspaceDir }))
    .rejects.toThrow("Offline tests require the fake Pi launcher");
  expect(launches()).toEqual([]);
});
