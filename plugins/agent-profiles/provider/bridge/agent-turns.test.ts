import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { FULL_PERMISSION_OPTIONS, startFakePiBridge, type FakePiBridgeHarness } from "./test-support";

const setupPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";

const agentId = "11111111-1111-4111-8111-111111111111";
const otherAgentId = "22222222-2222-4222-8222-222222222222";
const agentModel = `agent/${agentId}`;
const memoryKey = `agent-${agentId}`;
const baseOptions = {
  kind: "agents", agentId, agent: "deckmaster", memoryKey, agentName: "Deckmaster", instructions: "Review the deck.",
  modelMode: "level", level: "high", providerId: "hempi", model: "openai-codex/gpt-6-sol", reasoningLevel: "high",
};
let harness: FakePiBridgeHarness;
let nextId = 7000;
let launchLog: string;
let commandLog: string;

beforeEach(async () => {
  harness = await startFakePiBridge({ prefix: "agents-turns-", initialize: true, processLog: true });
  vi.stubEnv("FAKE_PI_GATEWAY_MODELS", "1");
  vi.stubEnv("MODEL_GATEWAY_BASE_URL", "");
  launchLog = join(harness.workspaceDir, "launches.jsonl");
  commandLog = join(harness.workspaceDir, "commands.jsonl");
  vi.stubEnv("FAKE_PI_LAUNCH_LOG", launchLog);
  vi.stubEnv("FAKE_PI_COMMAND_LOG", commandLog);
});
afterEach(async () => { await harness.teardown(); });

const launches = () => existsSync(launchLog)
  ? readFileSync(launchLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { args: string[] }).filter(({ args }) => args.includes("--session"))
  : [];
const launchModel = (index: number) => {
  const args = launches()[index]!.args;
  return [args[args.indexOf("--provider") + 1], args[args.indexOf("--model") + 1], args[args.indexOf("--thinking") + 1]];
};
async function start(threadId: string, providerOptions = baseOptions, model = agentModel, method = "thread/start", providerThreadId?: string) {
  const response = await harness.request(++nextId, method, {
    threadId, cwd: harness.workspaceDir, instructionMode: "append", ...(providerThreadId ? { providerThreadId } : {}),
    options: { ...FULL_PERMISSION_OPTIONS, model, providerOptions: { ...providerOptions, threadId } },
  });
  return response;
}
async function turn(threadId: string, providerThreadId: string, text: string, providerOptions = baseOptions, model = agentModel, envVars?: Record<string, string>) {
  const id = ++nextId;
  return harness.request(id, "turn/start", {
    threadId, providerThreadId, clientRequestId: `creq_${id.toString(16).padStart(10, "a").replace(/0|1/gu, "a")}`,
    input: [{ type: "text", text, mentions: [] }],
    options: { ...FULL_PERMISSION_OPTIONS, model, providerOptions: { ...providerOptions, threadId }, ...(envVars ? { envVars } : {}) },
  });
}

it("keeps one memory key across model changes, two turns, and resume without native compaction", async () => {
  const threadId = "thr_agent_primary";
  const started = await start(threadId);
  expect(started.error).toBeUndefined();
  const providerThreadId = z.object({ providerThreadId: z.string() }).parse(started.result).providerThreadId;
  expect(launches()).toEqual([]);
  expect((await turn(threadId, providerThreadId, "/remember persistent fact")).error).toBeUndefined();
  let since = await harness.waitForTurnBoundary(threadId);
  const low = { ...baseOptions, level: "low" };
  expect((await turn(threadId, providerThreadId, "/recall", low)).error).toBeUndefined();
  since = await harness.waitForTurnBoundary(threadId, since);
  expect(JSON.stringify(harness.deltasOf(threadId))).toContain("persistent fact");
  expect(launchModel(0)).toEqual(["model-gateway", "gpt-6-sol", "high"]);
  expect(launchModel(1)).toEqual(["model-gateway", "gpt-5.6-terra", "medium"]);
  expect(launches().every(({ args }) => args[args.indexOf("--optchat-profile") + 1] === memoryKey)).toBe(true);
  const resumed = await start(threadId, low, agentModel, "thread/resume", providerThreadId);
  expect(resumed.error).toBeUndefined();
  expect((await turn(threadId, providerThreadId, "/long", low)).error).toBeUndefined();
  await harness.waitForTurnBoundary(threadId, since);
  expect(harness.deltasOf(threadId).filter((delta) => String(delta.kind).includes("compact"))).toEqual([]);
  expect(readFileSync(commandLog, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual(Array(3).fill({ type: "set_auto_compaction", enabled: false }));
  expect(harness.deltasOf(threadId).filter((delta) => delta.kind === "turn.boundary").map((delta) => delta.status)).toEqual(["completed", "completed", "completed"]);
});

it("refuses mismatched start, resume, turn and steer before another prompt", async () => {
  const threadId = "thr_agent_guard";
  expect((await start(threadId, baseOptions, `agent/${otherAgentId}`)).error).toMatchObject({ message: expect.stringContaining("bound agent") });
  expect((await start(threadId, { ...baseOptions, agentId: otherAgentId })).error).toMatchObject({ message: expect.stringContaining("bound agent") });
  const started = await start(threadId);
  const providerThreadId = z.object({ providerThreadId: z.string() }).parse(started.result).providerThreadId;
  expect((await start(threadId, baseOptions, `agent/${otherAgentId}`, "thread/resume", providerThreadId)).error).toMatchObject({ message: expect.stringContaining("bound agent") });
  expect((await turn(threadId, providerThreadId, "wrong", baseOptions, `agent/${otherAgentId}`)).error).toMatchObject({ message: expect.stringContaining("bound agent") });
  expect((await turn(threadId, providerThreadId, "wrong", { ...baseOptions, memoryKey: "agent-elsewhere" })).error).toMatchObject({ message: expect.stringContaining("memory key") });
  const steered = await harness.request(++nextId, "turn/steer", {
    threadId, providerThreadId, expectedTurnId: "turn", clientRequestId: `creq_${nextId.toString(16).padStart(10, "a").replace(/0|1/gu, "a")}`,
    input: [{ type: "text", text: "wrong", mentions: [] }],
    options: { ...FULL_PERMISSION_OPTIONS, model: `agent/${otherAgentId}` },
  });
  expect(steered.error).toMatchObject({ message: expect.stringContaining("bound agent") });
  expect(launches()).toEqual([]);
});

it.each(["primary", "remote"] as const)("uses the same frozen memory on %s and reports copy-back failures", async (hostId) => {
  // The fake host issues the capability for this exact key on each turn.
  await harness.teardown();
  harness = await startFakePiBridge({ prefix: `agents-${hostId}-`, initialize: true, processLog: true, hostId });
  vi.stubEnv("FAKE_PI_GATEWAY_MODELS", "1");
  vi.stubEnv("MODEL_GATEWAY_BASE_URL", "");
  launchLog = join(harness.workspaceDir, "launches.jsonl");
  commandLog = join(harness.workspaceDir, "commands.jsonl");
  vi.stubEnv("FAKE_PI_LAUNCH_LOG", launchLog);
  vi.stubEnv("FAKE_PI_COMMAND_LOG", commandLog);
  const started = await start(`thr_agent_${hostId}`);
  const providerThreadId = z.object({ providerThreadId: z.string() }).parse(started.result).providerThreadId;
  expect((await turn(`thr_agent_${hostId}`, providerThreadId, "/remember shared-key")).error).toBeUndefined();
  let since = await harness.waitForTurnBoundary(`thr_agent_${hostId}`);
  expect((await harness.memory.hosts.get("primary")!.state({ profile: memoryKey })).held).toBe(false);
  expect((await turn(`thr_agent_${hostId}`, providerThreadId, "/recall", { ...baseOptions, agent: "new-slug" })).error).toBeUndefined();
  since = await harness.waitForTurnBoundary(`thr_agent_${hostId}`, since);
  expect(JSON.stringify(harness.deltasOf(`thr_agent_${hostId}`))).toContain("shared-key");
  if (hostId === "remote") {
    harness.memory.failNextWrite();
    expect((await turn(`thr_agent_${hostId}`, providerThreadId, "/remember copyback-retained")).error).toBeUndefined();
    await harness.waitForTurnBoundary(`thr_agent_${hostId}`, since);
    expect(harness.deltasOf(`thr_agent_${hostId}`).filter((delta) => delta.kind === "turn.boundary").at(-1))
      .toMatchObject({ status: "failed", error: { message: expect.stringContaining("remote copy is retained") } });
  }
});

it("routes an explicit Gateway pin only on Gateway transport and leaves Hempi compaction enabled", async () => {
  const pinned = { ...baseOptions, modelMode: "pinned", providerId: "model-gateway", model: "model-gateway/gpt-6-sol" };
  const threadId = "thr_gateway_pin";
  const started = await start(threadId, pinned);
  const providerThreadId = z.object({ providerThreadId: z.string() }).parse(started.result).providerThreadId;
  expect((await turn(threadId, providerThreadId, "no gateway", pinned, agentModel, { MODEL_GATEWAY_BASE_URL: "" })).error).toMatchObject({ message: expect.stringContaining("required") });
  expect(launches()).toEqual([]);
  vi.stubEnv("MODEL_GATEWAY_BASE_URL", "http://fake-gateway.invalid/http/v1");
  expect((await turn(threadId, providerThreadId, "/handled", pinned)).error).toBeUndefined();
  await harness.waitForTurnBoundary(threadId);
  expect(launchModel(0).slice(0, 2)).toEqual(["model-gateway", "gpt-6-sol"]);
  const hempi = await harness.startThread("thr_hempi_control", { options: { ...FULL_PERMISSION_OPTIONS, model: "openai-codex/gpt-6-sol" } });
  const hempiThreadId = z.object({ providerThreadId: z.string() }).parse(hempi.result).providerThreadId;
  const id = ++nextId;
  expect((await harness.request(id, "turn/start", {
    threadId: "thr_hempi_control", providerThreadId: hempiThreadId, clientRequestId: `creq_${id.toString(16).padStart(10, "a").replace(/0|1/gu, "a")}`,
    input: [{ type: "text", text: "/long", mentions: [] }], options: { ...FULL_PERMISSION_OPTIONS, model: "openai-codex/gpt-6-sol" },
  })).error).toBeUndefined();
  await harness.waitForTurnBoundary("thr_hempi_control");
  expect(harness.deltasOf("thr_hempi_control").some((delta) => String(delta.kind).includes("compact"))).toBe(true);
  expect(readFileSync(commandLog, "utf8").trim().split("\n")).toHaveLength(1);
});

it("fails visibly if Pi unexpectedly compacts an agent turn", async () => {
  vi.stubEnv("FAKE_PI_IGNORE_AUTO_COMPACTION", "1");
  const threadId = "thr_unexpected_compaction";
  const started = await start(threadId);
  const providerThreadId = z.object({ providerThreadId: z.string() }).parse(started.result).providerThreadId;
  expect((await turn(threadId, providerThreadId, "/long")).error).toBeUndefined();
  await harness.waitForTurnBoundary(threadId);
  expect(harness.deltasOf(threadId).find((delta) => delta.kind === "context.compacted")).toBeDefined();
  expect(harness.deltasOf(threadId).find((delta) => delta.kind === "turn.boundary"))
    .toMatchObject({ status: "failed", error: { message: expect.stringContaining("despite automatic compaction being disabled") } });
});

it("rejects an unsupported saved pin before launching a Pi turn", async () => {
  const threadId = "thr_bad_pin";
  const bad = { ...baseOptions, modelMode: "pinned", providerId: "anthropic", model: "anthropic/claude-fable-5" };
  const started = await start(threadId, bad);
  expect(started.error).toMatchObject({ message: expect.stringContaining("Unsupported Pi agent pin") });
  expect(launches()).toEqual([]);
});


it("acknowledges setup work promptly and keeps the prompt until tools are ready", async () => {
  const threadId = "thr_agent_setup";
  const script = join(harness.workspaceDir, "setup.py");
  const release = join(harness.workspaceDir, "release");
  const entered = join(harness.workspaceDir, "entered");
  writeFileSync(script, `import pathlib,time
pathlib.Path(${JSON.stringify(entered)}).touch()
while not pathlib.Path(${JSON.stringify(release)}).exists(): time.sleep(.01)
`);
  const envVars = { AGENT_SETUP_SCRIPT: script, PATH: setupPath };
  const started = await harness.request(++nextId, "thread/start", {
    threadId, cwd: harness.workspaceDir, instructionMode: "append",
    options: { ...FULL_PERMISSION_OPTIONS, model: agentModel, providerOptions: { ...baseOptions, threadId }, envVars },
  });
  const providerThreadId = z.object({ providerThreadId: z.string() }).parse(started.result).providerThreadId;
  expect(launches()).toEqual([]);
  const submitted = await turn(threadId, providerThreadId, "saved setup prompt", baseOptions, agentModel, envVars);
  expect(submitted.error).toBeUndefined();
  await vi.waitFor(() => expect(existsSync(entered)).toBe(true));
  expect(launches()).toEqual([]);
  expect(harness.deltasOf(threadId).filter(delta => delta.kind === "input.accepted")).toEqual([]);
  writeFileSync(release, "ready");
  await harness.waitForTurnBoundary(threadId);
  expect(launches()).toHaveLength(1);
  expect(JSON.stringify(harness.deltasOf(threadId))).toContain("saved setup prompt");
  expect(harness.deltasOf(threadId)).toContainEqual(expect.objectContaining({ kind: "input.accepted" }));
}, 10_000);

it("reports setup failure as a failed accepted turn without launching Pi", async () => {
  const threadId = "thr_agent_setup_failure";
  const script = join(harness.workspaceDir, "setup-fail.py");
  writeFileSync(script, "raise SystemExit('setup deliberately failed')\n");
  const started = await start(threadId);
  const providerThreadId = z.object({ providerThreadId: z.string() }).parse(started.result).providerThreadId;
  expect((await turn(threadId, providerThreadId, "must not run", baseOptions, agentModel, { AGENT_SETUP_SCRIPT: script, PATH: setupPath })).error).toBeUndefined();
  await harness.waitForTurnBoundary(threadId);
  expect(launches()).toEqual([]);
  expect(harness.deltasOf(threadId).filter(delta => delta.kind === "input.accepted")).toEqual([]);
  expect(harness.deltasOf(threadId)).toContainEqual(expect.objectContaining({ kind: "turn.boundary", status: "failed", error: expect.objectContaining({ message: expect.stringContaining("setup deliberately failed") }) }));
});

it("cancels setup on thread stop and never forwards its saved prompt", async () => {
  const threadId = "thr_agent_setup_cancel";
  const script = join(harness.workspaceDir, "setup-wait.py");
  const entered = join(harness.workspaceDir, "entered");
  const release = join(harness.workspaceDir, "release");
  writeFileSync(script, `import pathlib,time
pathlib.Path(${JSON.stringify(entered)}).touch()
while not pathlib.Path(${JSON.stringify(release)}).exists(): time.sleep(.01)
`);
  const started = await start(threadId);
  const providerThreadId = z.object({ providerThreadId: z.string() }).parse(started.result).providerThreadId;
  expect((await turn(threadId, providerThreadId, "cancelled setup prompt", baseOptions, agentModel, { AGENT_SETUP_SCRIPT: script, PATH: setupPath })).error).toBeUndefined();
  await vi.waitFor(() => expect(existsSync(entered)).toBe(true));
  expect((await harness.request(++nextId, "thread/stop", { threadId, providerThreadId, activeTurnId: "turn_setup", intent: "interrupt" })).error).toBeUndefined();
  writeFileSync(release, "ready");
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(launches()).toEqual([]);
});

it("blocks a reported setup error without a staged script before the prompt", async () => {
  const threadId = "thr_setup_unknown";
  const started = await start(threadId);
  const providerThreadId = z.object({ providerThreadId: z.string() }).parse(started.result).providerThreadId;
  const result = await turn(threadId, providerThreadId, "must remain unforwarded", baseOptions, agentModel, {
    AGENT_SETUP_ERROR: "Synthetic setup status is unknown",
  });
  expect(result.error).toMatchObject({ message: expect.stringContaining("Synthetic setup status is unknown") });
  expect(launches()).toEqual([]);
  expect(harness.deltasOf(threadId).filter(delta => delta.kind === "input.accepted")).toEqual([]);
});
