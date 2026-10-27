import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { FULL_PERMISSION_OPTIONS, startFakePiBridge, type FakePiBridgeHarness } from "./test-support";

let harness: FakePiBridgeHarness;
let requestId = 6000;
beforeEach(async () => {
  harness = await startFakePiBridge({ prefix: "hempi-remote-lifecycle-", initialize: true, processLog: true, hostId: "remote" });
  vi.stubEnv("MODEL_GATEWAY_BASE_URL", "");
});
afterEach(async () => { await harness.teardown(); });
async function start(threadId: string) {
  const response = await harness.startThread(threadId, { options: { ...FULL_PERMISSION_OPTIONS, providerOptions: { threadId, agent: "engineer", agentName: "Engineer", memoryKey: "agent-engineer", instructions: "Engineer persona." } } });
  expect(response.error).toBeUndefined();
  return z.object({ providerThreadId: z.string() }).parse(response.result).providerThreadId;
}
async function turn(threadId: string, providerThreadId: string, text: string) {
  const id = ++requestId;
  return harness.request(id, "turn/start", { threadId, providerThreadId, clientRequestId: `creq_${id.toString(16).padStart(10, "w").replace(/0/g, "w").replace(/1/g, "x")}`, input: [{ type: "text", text, mentions: [] }], options: FULL_PERMISSION_OPTIONS });
}

it("copies memory after Pi exit, waits for copy-back before BB completion, and recalls from another agent thread", async () => {
  vi.stubEnv("FAKE_PI_EXIT_FACT", "fact-written-at-process-exit");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const enteredCommit = new Promise<void>((resolve) => { entered = resolve; });
  harness.memory.beforeCall = async (method) => { if (method === "memoryCommit") { entered(); await gate; } };
  const writer = await start("thr_remote_writer");
  expect((await turn("thr_remote_writer", writer, "/remember before-exit")).error).toBeUndefined();
  await enteredCommit;
  try {
    expect(harness.readProcessLog().exited).toEqual(harness.readProcessLog().spawned);
    expect(harness.deltasOf("thr_remote_writer").some((delta) => delta.kind === "turn.boundary")).toBe(false);
    expect((await harness.memory.hosts.get("primary")!.state({ profile: "agent-engineer" })).held).toBe(true);
  } finally { release(); }
  await harness.waitForTurnBoundary("thr_remote_writer");
  expect(harness.deltasOf("thr_remote_writer")).toContainEqual(expect.objectContaining({ kind: "turn.boundary", status: "completed" }));
  expect(readFileSync(join(harness.workspaceDir, "optchat/profiles/agent-engineer/fake-memory-fact.txt"), "utf8")).toBe("fact-written-at-process-exit");
  vi.stubEnv("FAKE_PI_EXIT_FACT", "");
  harness.memory.beforeCall = undefined;
  const reader = await start("thr_remote_reader");
  expect((await turn("thr_remote_reader", reader, "/recall")).error).toBeUndefined();
  await harness.waitForTurnBoundary("thr_remote_reader");
  expect(JSON.stringify(harness.deltasOf("thr_remote_reader"))).toContain("fact-written-at-process-exit");
  expect(new Set(harness.readProcessLog().spawned).size).toBe(2);
});

it("fails the BB boundary when memory copy-back fails and retains recoverable remote data", async () => {
  harness.memory.failNextWrite();
  const writer = await start("thr_remote_copyback_failure");
  expect((await turn("thr_remote_copyback_failure", writer, "/remember retained-after-failure")).error).toBeUndefined();
  await harness.waitForTurnBoundary("thr_remote_copyback_failure");
  const boundary = harness.deltasOf("thr_remote_copyback_failure").find((delta) => delta.kind === "turn.boundary");
  expect(boundary).toMatchObject({ status: "failed", error: { message: expect.stringContaining("remote copy is retained") } });
  expect(harness.readProcessLog().exited).toEqual(harness.readProcessLog().spawned);
  const state = await harness.memory.hosts.get("primary")!.state({ profile: "agent-engineer" });
  expect(state.held).toBe(false);
  expect(state.pending?.phase).toBe("failed");
  expect(harness.memory.hosts.get("remote")!.remote({ operationId: state.pending!.operationId }).ready).toBe(true);
});

it("copies cancelled-turn memory after Pi exits and before acknowledging thread stop", async () => {
  vi.stubEnv("FAKE_PI_EXIT_FACT", "fact-retained-on-cancel");
  const providerThreadId = await start("thr_remote_cancel");
  expect((await turn("thr_remote_cancel", providerThreadId, "/hold")).error).toBeUndefined();
  const stopped = await harness.request(++requestId, "thread/stop", { threadId: "thr_remote_cancel", providerThreadId, intent: "interrupt", activeTurnId: null });
  expect(stopped.error).toBeUndefined();
  expect(harness.readProcessLog().exited).toEqual(harness.readProcessLog().spawned);
  expect(readFileSync(join(harness.workspaceDir, "optchat/profiles/agent-engineer/fake-memory-fact.txt"), "utf8")).toBe("fact-retained-on-cancel");
  expect((await harness.memory.hosts.get("primary")!.state({ profile: "agent-engineer" })).held).toBe(false);
});
