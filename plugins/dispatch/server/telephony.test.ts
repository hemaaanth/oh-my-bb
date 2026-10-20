import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS, SETUP_LABELS, WEBHOOK_ROUTE_LABEL } from "../shared/constants.js";
import { FULL_SETUP, loadPlugin, makeContext, published, threadRow, type Stubs } from "./core-test-host.js";
import { getCall, openCalls } from "./ledger.js";
import { publishStop } from "./live-session.js";
import { registerPhone } from "./register-phone.js";
import { HANGUP_GRACE_MS, buildDialSipTwiml, placeCall, runSideband } from "./telephony.js";

const WEBHOOKS_PRESENT = { plugins: { list: async () => ({ plugins: [{ id: "webhooks", name: "Webhooks", enabled: true, status: "running" }] }), reload: async () => ({}) } };
const READY_STUBS = WEBHOOKS_PRESENT as unknown as Stubs;
const WEBHOOKS_CALLER = { experimental_caller: { kind: "plugin", pluginId: "webhooks" } } as const;
const incoming = (type: string, sessionId: string | null) => ({
  endpointId: "ep_1",
  endpointName: "OpenAI",
  deliveryId: "dl_1",
  receivedAt: "2026-10-19T10:00:00.000Z",
  idempotencyKey: "idem_1",
  fields: { type, session_id: sessionId },
});

/** A stand-in socket: records how it was opened and what it sent, and lets a test push messages. */
class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = FakeSocket.OPEN;
  sent: Array<Record<string, unknown>> = [];
  listeners: Record<string, Array<(event: { data?: string }) => void>> = {};
  constructor(
    readonly url: string,
    readonly init: unknown,
  ) {
    FakeSocket.last = this;
  }
  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const listener of this.listeners.close ?? []) listener({});
  }
  receive(message: Record<string, unknown>) {
    for (const listener of this.listeners.message ?? []) listener({ data: JSON.stringify(message) });
  }
  types() {
    return this.sent.map((event) => event.type);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const functionCall = (name: string, callId: string, args: Record<string, unknown> = {}) => ({
  type: "response.event",
  event: { type: "response.output_item.done", item: { type: "function_call", name, call_id: callId, arguments: JSON.stringify(args) } },
});

type FetchCall = { url: string; init: RequestInit };
let fetchCalls: FetchCall[] = [];
let respond: (url: string) => Response | Promise<Response> = () => new Response("{}", { status: 200 });

beforeEach(() => {
  fetchCalls = [];
  respond = () => new Response("{}", { status: 200 });
  FakeSocket.last = null;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} });
    return respond(String(url));
  });
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const phoneRows = (ctx: Awaited<ReturnType<typeof makeContext>>["ctx"]) =>
  ctx.db.prepare("SELECT * FROM calls WHERE channel = 'phone'").all() as Array<Record<string, unknown>>;
const kindsOf = (ctx: Awaited<ReturnType<typeof makeContext>>["ctx"], callId: string) =>
  (ctx.db.prepare("SELECT kind FROM call_trace WHERE call_id = ? ORDER BY id").all(callId) as Array<{ kind: string }>).map((row) => row.kind);
const payloadsOf = (ctx: Awaited<ReturnType<typeof makeContext>>["ctx"], callId: string, kind: string) =>
  (ctx.db.prepare("SELECT payload_json FROM call_trace WHERE call_id = ? AND kind = ? ORDER BY id").all(callId, kind) as Array<{ payload_json: string | null }>).map(
    (row) => (row.payload_json ? JSON.parse(row.payload_json) : null),
  );

describe("buildDialSipTwiml", () => {
  it("bridges to the project over TLS and answers on bridge", () => {
    const twiml = buildDialSipTwiml("proj_abc123");
    expect(twiml).toContain('<Dial answerOnBridge="true">');
    expect(twiml).toContain("<Sip>sip:proj_abc123@sip.api.openai.com;transport=tls</Sip>");
  });
});

describe("placeCall", () => {
  it("lists every missing item by label and makes no network call", async () => {
    const { ctx, harness } = await makeContext({ openaiKey: FULL_SETUP.openaiKey }, READY_STUBS);
    const result = await placeCall(ctx);
    expect(result).toEqual({
      status: "not-ready",
      missing: [SETUP_LABELS.twilioSid, SETUP_LABELS.twilioToken, SETUP_LABELS.twilioCallerNumber, SETUP_LABELS.yourPhoneNumber, SETUP_LABELS.openaiSipProject],
    });
    expect(fetchCalls).toHaveLength(0);
    expect(published(harness, CHANNELS.callControl)).toHaveLength(0);
  });

  it("names the webhook route when the Webhooks plugin is absent", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    const result = await placeCall(ctx);
    expect(result).toEqual({ status: "not-ready", missing: [WEBHOOK_ROUTE_LABEL] });
    expect(fetchCalls).toHaveLength(0);
  });

  it("publishes a stop, then posts the TLS TwiML to Twilio with basic auth", async () => {
    const { ctx, harness } = await makeContext({ ...FULL_SETUP }, READY_STUBS);
    let stoppedBeforeDial = false;
    respond = () => {
      stoppedBeforeDial = published(harness, CHANNELS.callControl).length === 1;
      return new Response(JSON.stringify({ sid: "CA123" }), { status: 201 });
    };
    const result = await placeCall(ctx);
    expect(result).toMatchObject({ status: "placed", callSid: "CA123" });
    expect(result.status === "placed" && result.detail).toContain(FULL_SETUP.yourPhoneNumber);
    expect(stoppedBeforeDial).toBe(true);
    expect(published(harness, CHANNELS.callControl)).toEqual([{ action: "stop", nonce: null, reason: "replaced" }]);

    const [call] = fetchCalls;
    expect(call!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${FULL_SETUP.twilioSid}/Calls.json`);
    const headers = call!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(`${FULL_SETUP.twilioSid}:${FULL_SETUP.twilioToken}`).toString("base64")}`);
    const form = new URLSearchParams(String(call!.init.body));
    expect(form.get("To")).toBe(FULL_SETUP.yourPhoneNumber);
    expect(form.get("From")).toBe(FULL_SETUP.twilioCallerNumber);
    expect(form.get("Twiml")).toContain(`sip:${FULL_SETUP.openaiSipProject}@sip.api.openai.com;transport=tls`);
    expect(form.get("Twiml")).toContain('answerOnBridge="true"');
  });

  it("surfaces a Twilio refusal with the status and a body clipped to 300 characters", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP }, READY_STUBS);
    respond = () => new Response("x".repeat(500), { status: 401 });
    const result = await placeCall(ctx);
    expect(result).toEqual({ status: "error", detail: `Twilio 401: ${"x".repeat(300)}` });
  });

  it("reports a network failure as an error result", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP }, READY_STUBS);
    respond = () => {
      throw new Error("socket hang up");
    };
    expect(await placeCall(ctx)).toEqual({ status: "error", detail: "Twilio request failed: socket hang up" });
  });
});

describe("phoneDial and bb dispatch call", () => {
  it("returns not-ready with labels, no fetch, and no stop when anything is missing", async () => {
    const { harness } = await loadPlugin({ openaiKey: FULL_SETUP.openaiKey }, READY_STUBS);
    const result = (await harness.callRpc("phoneDial", {})) as { status: string; missing: string[] };
    expect(result.status).toBe("not-ready");
    expect(result.missing).toContain(SETUP_LABELS.twilioSid);
    expect(fetchCalls).toHaveLength(0);
    expect(published(harness, CHANNELS.callControl)).toHaveLength(0);
  });

  it("the CLI call fails with the missing labels, and prints the detail when placed", async () => {
    const missing = await loadPlugin({ openaiKey: FULL_SETUP.openaiKey }, READY_STUBS);
    const failed = await missing.harness.runCli(["call"]);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain(SETUP_LABELS.twilioSid);

    respond = () => new Response(JSON.stringify({ sid: "CA9" }), { status: 201 });
    const ready = await loadPlugin({ ...FULL_SETUP }, READY_STUBS);
    const placed = await ready.harness.runCli(["call"]);
    expect(placed.exitCode).toBe(0);
    expect(placed.stdout).toContain("CA9");
    expect(placed.stdout).not.toContain(FULL_SETUP.twilioToken);
  });

  it("the CLI call reports a Twilio error on one line", async () => {
    respond = () => new Response("nope", { status: 400 });
    const { harness } = await loadPlugin({ ...FULL_SETUP }, READY_STUBS);
    const result = await harness.runCli(["call"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Twilio 400: nope");
  });
});

describe("webhooks_receive", () => {
  it("ignores other event types and events without a session id", async () => {
    const { harness } = await loadPlugin({ ...FULL_SETUP }, READY_STUBS);
    expect(await harness.callRpc("webhooks_receive", incoming("realtime.call.incoming", "sess_1"), WEBHOOKS_CALLER)).toEqual({ handled: false });
    expect(await harness.callRpc("webhooks_receive", incoming("live.transport.incoming", null), WEBHOOKS_CALLER)).toEqual({ handled: false });
    expect(fetchCalls).toHaveLength(0);
    expect(FakeSocket.last).toBeNull();
  });

  it("accepts under a session key without a transport, records a phone row, and attaches the sideband", async () => {
    const { harness, bb } = await loadPlugin({ ...FULL_SETUP }, READY_STUBS);
    const result = await harness.callRpc("webhooks_receive", incoming("live.transport.incoming", "sess_abc"), WEBHOOKS_CALLER);
    expect(result).toEqual({ handled: true, accepted: true });

    const accept = fetchCalls.find((call) => call.url.endsWith("/sessions/sess_abc/accept"));
    expect(accept).toBeDefined();
    expect((accept!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FULL_SETUP.openaiKey}`);
    const body = JSON.parse(String(accept!.init.body));
    expect(Object.keys(body)).toEqual(["session"]);
    expect(body.session).toMatchObject({ model: "gpt-live-1" });
    expect(body.session).not.toHaveProperty("type");
    expect(body.session.transport).toBeUndefined();
    expect(body.session.instructions).toContain("a phone call");

    const rows = bb.storage.database().prepare("SELECT * FROM calls WHERE channel = 'phone'").all() as Array<Record<string, string>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ openai_session_id: "sess_abc", ended_at: null });
    expect(JSON.parse(rows[0]!.device_json!)).toMatchObject({ platform: "phone", displayMode: "none", runtime: "sip" });
    const trace = bb.storage.database().prepare("SELECT kind FROM call_trace WHERE call_id = ? ORDER BY id").all(rows[0]!.id) as Array<{ kind: string }>;
    expect(trace.map((row) => row.kind)).toEqual(["call.started"]);

    expect(FakeSocket.last!.url).toBe("wss://api.openai.com/v1/live/sessions/sess_abc/attach");
    expect(FakeSocket.last!.init).toEqual({ headers: { Authorization: `Bearer ${FULL_SETUP.openaiKey}` } });
    FakeSocket.last!.close();
    await settle();
  });

  it("records call.failed with a clipped body when the accept is refused", async () => {
    const { harness, bb } = await loadPlugin({ ...FULL_SETUP }, READY_STUBS);
    respond = (url) => (url.endsWith("/accept") ? new Response("y".repeat(500), { status: 404 }) : new Response("{}"));
    const result = await harness.callRpc("webhooks_receive", incoming("live.transport.incoming", "sess_gone"), WEBHOOKS_CALLER);
    expect(result).toEqual({ handled: true, accepted: false });
    expect(FakeSocket.last).toBeNull();

    const row = bb.storage.database().prepare("SELECT * FROM calls WHERE channel = 'phone'").get() as Record<string, unknown>;
    expect(row).toMatchObject({ openai_session_id: "sess_gone", close_reason: "failed" });
    const failed = bb.storage.database().prepare("SELECT payload_json FROM call_trace WHERE call_id = ? AND kind = 'call.failed'").get(row.id) as { payload_json: string };
    expect(JSON.parse(failed.payload_json).detail).toBe(`OpenAI 404: ${"y".repeat(300)}`);
  });

  it("answers a duplicate delivery for a live session once", async () => {
    const { harness } = await loadPlugin({ ...FULL_SETUP }, READY_STUBS);
    await harness.callRpc("webhooks_receive", incoming("live.transport.incoming", "sess_dup"), WEBHOOKS_CALLER);
    const second = await harness.callRpc("webhooks_receive", incoming("live.transport.incoming", "sess_dup"), WEBHOOKS_CALLER);
    expect(second).toEqual({ handled: true, accepted: true });
    expect(fetchCalls.filter((call) => call.url.endsWith("/accept"))).toHaveLength(1);
    FakeSocket.last!.close();
    await settle();
  });

  it("refuses a second session while another phone call is live", async () => {
    const { harness } = await loadPlugin({ ...FULL_SETUP }, READY_STUBS);
    await harness.callRpc("webhooks_receive", incoming("live.transport.incoming", "sess_one"), WEBHOOKS_CALLER);
    const second = await harness.callRpc("webhooks_receive", incoming("live.transport.incoming", "sess_two"), WEBHOOKS_CALLER);
    expect(second).toEqual({ handled: true, accepted: false });
    expect(fetchCalls.filter((call) => call.url.endsWith("/accept"))).toHaveLength(1);
    FakeSocket.last!.close();
    await settle();
  });

  it("stops an app call that is live before it accepts", async () => {
    const { harness, bb } = await loadPlugin({ ...FULL_SETUP }, READY_STUBS);
    bb.storage.database().prepare("INSERT INTO calls (id, channel, nonce, device_json, started_at) VALUES ('call_app', 'app', 'n1', '{}', ?)").run(Date.now());
    await harness.callRpc("webhooks_receive", incoming("live.transport.incoming", "sess_x"), WEBHOOKS_CALLER);
    expect(published(harness, CHANNELS.callControl)).toEqual([{ action: "stop", nonce: null, reason: "replaced" }]);
    expect(bb.storage.database().prepare("SELECT close_reason FROM calls WHERE id = 'call_app'").get()).toEqual({ close_reason: "replaced" });
    FakeSocket.last!.close();
    await settle();
  });

  it("logs a caller that is not the Webhooks plugin, and still handles a well-formed event", async () => {
    const { harness } = await loadPlugin({ ...FULL_SETUP }, READY_STUBS);
    const other = { experimental_caller: { kind: "plugin", pluginId: "somebody" } } as const;
    const result = await harness.callRpc("webhooks_receive", incoming("live.transport.incoming", "sess_o"), other);
    expect(result).toEqual({ handled: true, accepted: true });
    expect(harness.inspection.logEntries.some((entry) => entry.level === "warn" && entry.message.includes('"somebody"'))).toBe(true);
    FakeSocket.last!.close();
    await settle();
  });
});

describe("sideband loop", () => {
  async function startCall(stubs: Stubs = READY_STUBS) {
    const made = await makeContext({ ...FULL_SETUP }, stubs);
    const { insertCall } = await import("./ledger.js");
    const { PHONE_DEVICE } = await import("./live-session.js");
    const callId = insertCall(made.ctx, { channel: "phone", device: PHONE_DEVICE, openaiSessionId: "sess_s" });
    const done = runSideband(made.ctx, callId, "sess_s");
    await settle();
    return { ...made, callId, done, socket: FakeSocket.last! };
  }

  it("answers a batch of tool calls in order and sends one continue", async () => {
    const stubs = { ...READY_STUBS, threads: { list: async () => [threadRow()] }, projects: { list: async () => [] } } as unknown as Stubs;
    const { socket, ctx, callId, done } = await startCall(stubs);
    socket.receive(functionCall("get_context", "fc_1"));
    socket.receive(functionCall("dance", "fc_2"));
    await settle();
    await settle();

    expect(socket.types()).toEqual(["response.item.create", "response.item.create", "response.create"]);
    const [first, second] = socket.sent as Array<{ item: { call_id: string; output: string; type: string } }>;
    expect(first!.item).toMatchObject({ type: "function_call_output", call_id: "fc_1" });
    // The phone branch of get_context: a note about the phone call and the live threads.
    const context = JSON.parse(first!.item.output);
    expect(context).toMatchObject({ channel: "phone", liveThreads: [{ id: "thr_a" }] });
    expect(context.note).toMatch(/phone call/);
    // A failed tool still has an output.
    expect(second!.item).toMatchObject({ call_id: "fc_2", output: "Error: There is no tool named dance." });
    // The executor traces the call and the result once.
    expect(kindsOf(ctx, callId)).toEqual(["tool.call", "tool.result", "tool.call", "tool.result"]);
    expect(payloadsOf(ctx, callId, "tool.result").map((payload) => payload.status)).toEqual(["success", "error"]);

    socket.close();
    await done;
  });

  it("sends a second continue for a later batch", async () => {
    const { socket, done } = await startCall();
    socket.receive(functionCall("dance", "fc_1"));
    await settle();
    socket.receive(functionCall("dance", "fc_2"));
    await settle();
    expect(socket.types().filter((type) => type === "response.create")).toHaveLength(2);
    socket.close();
    await done;
  });

  it("records usage snapshots and keeps the last one as billed seconds", async () => {
    const { socket, ctx, callId, done } = await startCall();
    socket.receive({ type: "session.usage.updated", usage: { seconds: 12 } });
    socket.receive({ type: "session.usage.updated", usage: { seconds: 30 } });
    expect(payloadsOf(ctx, callId, "usage.seconds")).toEqual([{ seconds: 12 }, { seconds: 30 }]);
    expect(getCall(ctx, callId)!.billedSeconds).toBe(30);
    socket.close();
    await done;
  });

  it("ends the call on a closed event with the reason and final seconds", async () => {
    const { socket, ctx, callId, done } = await startCall();
    socket.receive({ type: "session.closed", reason: "hangup", usage: { seconds: 61 } });
    await done;
    expect(kindsOf(ctx, callId)).toEqual(["call.closed", "call.stopped"]);
    expect(payloadsOf(ctx, callId, "call.closed")).toEqual([{ reason: "hangup", seconds: 61 }]);
    const call = getCall(ctx, callId)!;
    expect(call).toMatchObject({ closeReason: "hangup", billedSeconds: 61, unclean: false });
    expect(call.endedAt).not.toBeNull();
    expect(openCalls(ctx)).toHaveLength(0);
  });

  it("records an unclean stop when the socket closes without a closed event", async () => {
    const { socket, ctx, callId, done, harness } = await startCall();
    socket.close();
    await done;
    expect(payloadsOf(ctx, callId, "call.stopped")).toEqual([{ unclean: true, reason: "connection lost" }]);
    expect(getCall(ctx, callId)!.unclean).toBe(true);
    expect(harness.inspection.logEntries.some((entry) => entry.level === "warn" && entry.message.includes("lost the sideband"))).toBe(true);
  });

  it("records an error event", async () => {
    const { socket, ctx, callId, done } = await startCall();
    socket.receive({ type: "error", error: { message: "rate limited" } });
    expect(payloadsOf(ctx, callId, "error")).toEqual([{ message: "rate limited" }]);
    socket.close();
    await done;
  });

  it("ignores messages that are not JSON or not tool calls", async () => {
    const { socket, done } = await startCall();
    for (const listener of socket.listeners.message ?? []) listener({ data: "not json" });
    socket.receive({ type: "response.event", event: { type: "response.output_item.done", item: { type: "message" } } });
    socket.receive(functionCall("", "fc_x"));
    await settle();
    expect(socket.sent).toHaveLength(0);
    socket.close();
    await done;
  });

  it("hangs up at OpenAI when a stop control is published, then closes after the grace period", async () => {
    const { socket, ctx, callId, done } = await startCall();
    vi.useFakeTimers();
    publishStop(ctx, { action: "stop", nonce: "n_new", reason: "replaced" });
    expect(getCall(ctx, callId)).toMatchObject({ closeReason: "replaced" });
    await vi.advanceTimersByTimeAsync(0);
    const hangup = fetchCalls.find((call) => call.url.endsWith("/sessions/sess_s/hangup"));
    expect(hangup).toBeDefined();
    expect((hangup!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FULL_SETUP.openaiKey}`);

    // The final usage can still arrive after the hang-up.
    socket.receive({ type: "session.closed", reason: "hangup", usage: { seconds: 44 } });
    await done;
    expect(getCall(ctx, callId)).toMatchObject({ closeReason: "replaced", billedSeconds: 44, unclean: false });
    expect(kindsOf(ctx, callId).filter((kind) => kind === "call.stopped")).toHaveLength(1);
  });

  it("closes the socket itself when the closed event never arrives after a hang-up", async () => {
    const { socket, ctx, callId, done } = await startCall();
    vi.useFakeTimers();
    publishStop(ctx, { action: "stop", nonce: null, reason: "stopped" });
    await vi.advanceTimersByTimeAsync(HANGUP_GRACE_MS);
    await done;
    expect(socket.readyState).toBe(3);
    expect(kindsOf(ctx, callId)).toEqual(["call.stopped"]);
  });

  it("does not run tools that arrive after a hang-up", async () => {
    const { socket, ctx, done } = await startCall();
    publishStop(ctx, { action: "stop", nonce: null, reason: "stopped" });
    socket.receive(functionCall("dance", "fc_late"));
    await settle();
    expect(socket.sent).toHaveLength(0);
    socket.close();
    await done;
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM call_trace WHERE kind = 'tool.call'").get()).toEqual({ n: 0 });
  });
});

describe("registerPhone", () => {
  it("closes a phone row left open by a restart as unclean, and leaves app rows alone", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    const now = Date.now();
    ctx.db.prepare("INSERT INTO calls (id, channel, device_json, started_at) VALUES ('call_ph', 'phone', '{}', ?)").run(now);
    ctx.db.prepare("INSERT INTO calls (id, channel, device_json, started_at) VALUES ('call_ap', 'app', '{}', ?)").run(now);
    registerPhone(ctx);
    expect(getCall(ctx, "call_ph")).toMatchObject({ unclean: true, closeReason: "connection lost" });
    expect(getCall(ctx, "call_ap")!.endedAt).toBeNull();
    expect(phoneRows(ctx)).toHaveLength(1);
  });
});
