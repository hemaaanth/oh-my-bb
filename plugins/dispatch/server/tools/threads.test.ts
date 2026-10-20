import { describe, expect, it } from "vitest";
import { APP_CONTEXT, PHONE_CONTEXT, makeContext, projectRow, threadRow, type Stubs } from "../core-test-host.js";
import { executeServerTool } from "./index.js";
import { CONFIG_REFUSAL, isConfigurationRequest } from "./threads.js";

const thread = threadRow();
const threadStubs = (extra: Record<string, unknown> = {}) =>
  ({
    threads: {
      get: async () => thread,
      send: async () => ({}),
      update: async () => ({}),
      open: async () => ({}),
      output: async () => ({ output: "" }),
      events: { list: async () => [{ type: "turn/completed", data: { status: "completed" } }] },
      ...extra,
    },
    projects: { list: async () => [projectRow()] },
  }) as unknown as Stubs;

async function call(stubs: Stubs, name: string, args: Record<string, unknown>, context = APP_CONTEXT) {
  const { ctx, harness } = await makeContext(undefined, stubs);
  const result = await executeServerTool(ctx, { callId: "none", name, args, context });
  return { result, harness };
}

describe("send_to_thread", () => {
  it("refuses a model, provider, or machine change and points to set_thread_model", async () => {
    expect(CONFIG_REFUSAL).toContain("set_thread_model");
    const { result, harness } = await call(threadStubs(), "send_to_thread", { thread_id: "thr_a", message: "Switch to the Opus model please" });
    expect(result).toEqual({ status: "error", output: `Error: ${CONFIG_REFUSAL}` });
    expect(harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
    expect(isConfigurationRequest("move this to my laptop machine")).toBe(true);
    expect(isConfigurationRequest("Fix the header model test")).toBe(false);
  });

  it("sends the message as the user", async () => {
    const { result, harness } = await call(threadStubs(), "send_to_thread", { thread_id: "thr_a", message: "Please add a test.", quiet: true });
    expect(result.status).toBe("success");
    expect(JSON.parse(result.output)).toEqual({ threadId: "thr_a", title: "Fix the header", sent: true, note: "The thread was not brought on screen." });
    expect(harness.inspection.sdk.callsTo("threads.send")).toEqual([
      [{ threadId: "thr_a", input: [{ type: "text", text: "Please add a test.", mentions: [] }], mode: "auto" }],
    ]);
    expect(harness.inspection.sdk.callsTo("threads.open")).toEqual([]);
  });

  it("opens the thread in the app window on a phone call", async () => {
    const { harness } = await call(threadStubs(), "send_to_thread", { thread_id: "thr_a", message: "Carry on." }, PHONE_CONTEXT);
    expect(harness.inspection.sdk.callsTo("threads.open")).toEqual([[{ threadId: "thr_a", file: null }]]);
  });
});

describe("the other thread tools", () => {
  it("read_thread reports the last outcome when there is no output", async () => {
    const { result } = await call(threadStubs(), "read_thread", { thread_id: "thr_a" });
    expect(JSON.parse(result.output)).toMatchObject({ title: "Fix the header", project: "Website", lastOutcome: { kind: "completed" } });
  });

  it("an unknown thread is an Error: result", async () => {
    const stubs = threadStubs({ get: async () => Promise.reject(new Error("404")) });
    const { result } = await call(stubs, "stop_thread", { thread_id: "thr_x" });
    expect(result.status).toBe("error");
    expect(result.output).toMatch(/^Error: There is no thread with id thr_x/);
  });

  it("set_thread_model keeps the provider and passes the model id", async () => {
    const stubs = {
      ...threadStubs(),
      providers: {
        list: async () => [{ id: "codex", displayName: "Codex", available: true }],
        models: async () => ({ models: [{ id: "gpt-5.5-mini", displayName: "GPT-5.5 Mini", isDefault: false }] }),
      },
    } as unknown as Stubs;
    const { result, harness } = await call(stubs, "set_thread_model", { thread_id: "thr_a", model: "5.5 mini" });
    expect(JSON.parse(result.output)).toMatchObject({ provider: "Codex", model: "GPT-5.5 Mini" });
    expect(harness.inspection.sdk.callsTo("threads.update")).toEqual([[{ threadId: "thr_a", model: "gpt-5.5-mini" }]]);
    expect(harness.inspection.sdk.callsTo("providers.list")).toEqual([[{ environmentId: "env_a" }]]);
  });

  it("refuses app tools and unknown tools on the server", async () => {
    expect((await call(threadStubs(), "set_pane", { thread_id: "thr_a", action: "toggle" })).result.output).toBe(
      "Error: set_pane runs in the app, not on the server.",
    );
    expect((await call(threadStubs(), "set_pane", { thread_id: "thr_a", action: "toggle" }, PHONE_CONTEXT)).result.output).toBe(
      "Error: set_pane is not available on this call.",
    );
    expect((await call(threadStubs(), "dance", {})).result.output).toBe("Error: There is no tool named dance.");
  });

  it("get_context on the phone lists live threads and says there is no screen", async () => {
    const stubs = { threads: { list: async () => [thread] }, projects: { list: async () => [projectRow()] } } as unknown as Stubs;
    const { result } = await call(stubs, "get_context", {}, PHONE_CONTEXT);
    const parsed = JSON.parse(result.output);
    expect(parsed).toMatchObject({ channel: "phone", liveThreads: [{ id: "thr_a", status: "active", project: "Website" }] });
    expect(parsed.note).toMatch(/phone call/);
  });

  it("traces the call and its result", async () => {
    const { ctx, bb } = await makeContext(undefined, threadStubs());
    bb.storage.database().prepare("INSERT INTO calls (id, channel, device_json, started_at) VALUES ('call_t', 'app', '{}', 1)").run();
    await executeServerTool(ctx, { callId: "call_t", name: "rename_thread", args: { thread_id: "thr_a", title: "New" }, context: APP_CONTEXT });
    const kinds = bb.storage.database().prepare("SELECT kind FROM call_trace WHERE call_id = 'call_t' ORDER BY id").all() as Array<{ kind: string }>;
    expect(kinds.map((row) => row.kind)).toEqual(["tool.call", "tool.result"]);
  });
});
