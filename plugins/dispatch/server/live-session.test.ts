import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../shared/constants.js";
import type { CallControlPayload } from "../shared/contract.js";
import { APP_CONTEXT, DESKTOP_DEVICE, FULL_SETUP, makeContext, published } from "./core-test-host.js";
import { getCall, insertCall, openCalls } from "./ledger.js";
import {
  NO_KEY_ERROR,
  PHONE_BUSY_ERROR,
  PHONE_DEVICE,
  buildPhoneSessionBody,
  buildSessionBody,
  endCallsEverywhere,
  onCallStop,
  openCall,
  parseCreatedSession,
} from "./live-session.js";

const input = { sdp: "v=0 offer", nonce: "nonce_new", clientId: "client_a", realmId: "realm_a", device: DESKTOP_DEVICE, context: APP_CONTEXT };
// The reply shape the live API returns (checked 2026-10-19).
const answer = () => new Response(JSON.stringify({ session: { id: "sess_1" }, transport: { type: "webrtc", sdp: "v=0 answer" } }), { headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session body", () => {
  it("carries the voice, both models, both prompts, and the catalog", async () => {
    const { ctx } = await makeContext({ openaiKey: FULL_SETUP.openaiKey });
    const body = await buildSessionBody(ctx, { channel: "app", device: DESKTOP_DEVICE, context: APP_CONTEXT });
    expect(body).toMatchObject({ model: "gpt-live-1", audio: { output: { voice: "gleam" } } });
    expect(body).not.toHaveProperty("type");
    expect(body.delegation.responses).toMatchObject({ model: "gpt-5.6-terra", tool_choice: "auto", parallel_tool_calls: true });
    expect(body.instructions).toContain("Juno");
    expect(body.delegation.responses.tools.every((tool) => tool.type === "function")).toBe(true);
    expect(JSON.stringify(body)).not.toContain(FULL_SETUP.openaiKey);
  });

  it("builds the phone body without app tools", async () => {
    const { ctx } = await makeContext({ openaiKey: FULL_SETUP.openaiKey });
    const body = await buildPhoneSessionBody(ctx);
    const names = body.delegation.responses.tools.map((tool) => tool.name);
    expect(names).not.toContain("set_pane");
    expect(names).not.toContain("set_composer_text");
    expect(body.instructions).toContain("a phone call");
    expect(PHONE_DEVICE.runtime).toBe("sip");
  });
});

describe("parseCreatedSession", () => {
  it("reads JSON with transport.sdp, and plain SDP with a Location header", async () => {
    expect(await parseCreatedSession(answer())).toEqual({ sdp: "v=0 answer", sessionId: "sess_1" });
    const plain = new Response("v=0 plain", { headers: { "content-type": "application/sdp", location: "/v1/live/sessions/sess_2" } });
    expect(await parseCreatedSession(plain)).toEqual({ sdp: "v=0 plain", sessionId: "sess_2" });
    await expect(parseCreatedSession(new Response("{}", { headers: { "content-type": "application/json" } }))).rejects.toThrow(/answer/);
  });
});

describe("openCall", () => {
  it("stops other calls with the new nonce, creates the session, and records a row", async () => {
    const fetchMock = vi.fn(async () => answer());
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, harness } = await makeContext({ openaiKey: FULL_SETUP.openaiKey });
    const old = insertCall(ctx, { channel: "app", device: DESKTOP_DEVICE, nonce: "nonce_old" });
    const heard: CallControlPayload[] = [];
    const stop = onCallStop((payload) => heard.push(payload));
    const result = await openCall(ctx, input);
    stop();

    expect(published(harness, CHANNELS.callControl)).toEqual([{ action: "stop", nonce: "nonce_new", reason: "replaced" }]);
    expect(heard).toEqual([{ action: "stop", nonce: "nonce_new", reason: "replaced" }]);
    expect(result).toMatchObject({ sdp: "v=0 answer", sessionId: "sess_1" });
    expect(getCall(ctx, result.callId)).toMatchObject({ channel: "app", nonce: "nonce_new", openaiSessionId: "sess_1", clientId: "client_a" });
    expect(getCall(ctx, old)).toMatchObject({ closeReason: "replaced" });
    expect(openCalls(ctx).map((call) => call.id)).toEqual([result.callId]);

    const [url, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/live\/sessions$/);
    expect((request.headers as Record<string, string>).Authorization).toBe(`Bearer ${FULL_SETUP.openaiKey}`);
    const sent = JSON.parse(String(request.body));
    expect(Object.keys(sent)).toEqual(["session", "transport"]);
    expect(sent.session).toMatchObject({ model: "gpt-live-1" });
    expect(sent.session).not.toHaveProperty("type");
    expect(sent.transport).toEqual({ type: "webrtc", sdp: "v=0 offer" });
    expect(String(request.body)).not.toContain(FULL_SETUP.openaiKey);
  });

  it("rejects while a phone call is live", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer()));
    const { ctx } = await makeContext({ openaiKey: FULL_SETUP.openaiKey });
    insertCall(ctx, { channel: "phone", device: PHONE_DEVICE });
    await expect(openCall(ctx, input)).rejects.toThrow(PHONE_BUSY_ERROR);
  });

  it("rejects without a key", async () => {
    const fetchMock = vi.fn(async () => answer());
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = await makeContext();
    await expect(openCall(ctx, input)).rejects.toThrow(NO_KEY_ERROR);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an OpenAI failure with its status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad offer", { status: 400 })));
    const { ctx } = await makeContext({ openaiKey: FULL_SETUP.openaiKey });
    await expect(openCall(ctx, input)).rejects.toThrow("OpenAI 400: bad offer");
    expect(openCalls(ctx)).toEqual([]);
  });
});

describe("endCallsEverywhere", () => {
  it("ends every open call and publishes a null-nonce stop", async () => {
    const { ctx, harness } = await makeContext();
    insertCall(ctx, { channel: "app", device: DESKTOP_DEVICE, nonce: "n1" });
    expect(endCallsEverywhere(ctx, { reason: "bye" })).toEqual({ stopped: true });
    expect(openCalls(ctx)).toEqual([]);
    expect(published(harness, CHANNELS.callControl)).toEqual([{ action: "stop", nonce: null, reason: "bye" }]);
    expect(endCallsEverywhere(ctx, {})).toEqual({ stopped: false });
  });

  it("with a nonce ends only that call", async () => {
    const { ctx } = await makeContext();
    insertCall(ctx, { channel: "app", device: DESKTOP_DEVICE, nonce: "n1" });
    const other = insertCall(ctx, { channel: "app", device: DESKTOP_DEVICE, nonce: "n2" });
    endCallsEverywhere(ctx, { nonce: "n1" });
    expect(openCalls(ctx).map((call) => call.id)).toEqual([other]);
  });
});
