import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINTS, VOICE_SAMPLE } from "../../shared/constants.js";
import { DESKTOP_DEVICE, FULL_SETUP, loadPlugin, makeContext } from "../core-test-host.js";
import { insertCall } from "../ledger.js";
import { NO_KEY_ERROR } from "../live-session.js";
import { readPreferences, writePreferences } from "../preferences.js";
import { readSample, sampleKey, writeSample } from "./cache.js";
import { VOICES_ACCESS_ERROR, VOICES_SCOPE_ERROR, createCustomVoice, removeCustomVoice } from "./custom.js";
import { SAMPLE_BUSY_ERROR, sampleSpeech, voiceSample } from "./sample.js";
import { SAMPLE_SILENT_ERROR, recordSample, type SampleSessionConfig } from "./sample-session.js";
import { wrapWav } from "./wav.js";

/** A stand-in socket, as in telephony.test.ts. */
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
  open() {
    for (const listener of this.listeners.open ?? []) listener({});
  }
  types() {
    return this.sent.map((event) => event.type);
  }
}

const SESSION: SampleSessionConfig = {
  model: "gpt-live-1",
  instructions: "Read the line.",
  input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "Say it." }] }],
  audio: { format: { type: "audio/pcm", rate: 24_000 }, output: { voice: "gleam" } },
};
const audio = (bytes: number[]) => ({ type: "session.output_audio.delta", delta: Buffer.from(bytes).toString("base64") });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("wrapWav", () => {
  it("writes a 44-byte PCM16 mono header and drops a stray last byte", () => {
    const wav = wrapWav(new Uint8Array([1, 2, 3, 4, 5]), 24_000);
    const view = new DataView(wav.buffer);
    const ascii = (start: number) => String.fromCharCode(...wav.subarray(start, start + 4));
    expect(wav.length).toBe(48);
    expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint32(4, true)).toBe(40);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint32(28, true)).toBe(48_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(4);
    expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4]);
  });
});

describe("sample cache", () => {
  it("misses, then hits and marks the sample as used", async () => {
    const { ctx } = await makeContext();
    const key = sampleKey("gpt-live-1:gleam", "style", "line");
    expect(readSample(ctx.db, key)).toBeNull();
    writeSample(ctx.db, { key, voice: "gleam", wav: new Uint8Array([1, 2]) }, { now: 10 });
    expect([...readSample(ctx.db, key, 20)!]).toEqual([1, 2]);
    expect(ctx.db.prepare("SELECT used_at FROM voice_samples WHERE key = ?").get(key)).toEqual({ used_at: 20 });
  });

  it("makes a new key for any change to the voice, the style, or the line", () => {
    const key = sampleKey("v", "s", "t");
    expect(new Set([key, sampleKey("w", "s", "t"), sampleKey("v", "x", "t"), sampleKey("v", "s", "u")]).size).toBe(4);
  });

  it("drops the least recently used samples over the cap, and keeps the new one", async () => {
    const { ctx } = await makeContext();
    const wav = new Uint8Array(40);
    writeSample(ctx.db, { key: "a", voice: "a", wav }, { now: 1, capBytes: 100 });
    writeSample(ctx.db, { key: "b", voice: "b", wav }, { now: 2, capBytes: 100 });
    readSample(ctx.db, "a", 3); // a is now newer than b
    writeSample(ctx.db, { key: "c", voice: "c", wav }, { now: 4, capBytes: 100 });
    const keys = () => (ctx.db.prepare("SELECT key FROM voice_samples ORDER BY key").all() as Array<{ key: string }>).map((row) => row.key);
    expect(keys()).toEqual(["a", "c"]);
    writeSample(ctx.db, { key: "big", voice: "big", wav: new Uint8Array(500) }, { now: 5, capBytes: 100 });
    expect(keys()).toEqual(["big"]);
  });
});

describe("recordSample", () => {
  beforeEach(() => {
    FakeSocket.last = null;
    vi.stubGlobal("WebSocket", FakeSocket);
  });

  it("starts a client-mode session, asks for the line, pumps silence, and closes cleanly after the voice goes quiet", async () => {
    vi.useFakeTimers();
    const result = recordSample({ apiKey: "sk-test", session: SESSION, speak: "Say it." });
    const socket = FakeSocket.last!;
    expect(socket.url).toBe(ENDPOINTS.liveSocket);
    expect(socket.init).toEqual({ headers: { Authorization: "Bearer sk-test" } });
    socket.open();
    expect(socket.sent[0]).toEqual({ type: "session.start", event_id: "sample_start", session: SESSION });
    expect(socket.sent[0]).not.toHaveProperty("session.delegation");
    socket.receive({ type: "session.started" });
    expect(socket.sent[1]).toEqual({ type: "session.commentary.append", event_id: "sample_say", delegation_id: null, content: "Say it." });
    await vi.advanceTimersByTimeAsync(300);
    expect(socket.types().filter((type) => type === "session.input_audio.append").length).toBeGreaterThanOrEqual(2);
    socket.receive(audio([1, 2]));
    await vi.advanceTimersByTimeAsync(1000);
    socket.receive(audio([3, 4]));
    await vi.advanceTimersByTimeAsync(VOICE_SAMPLE.quietMs);
    expect(socket.types().at(-1)).toBe("session.close");
    expect(socket.readyState).toBe(FakeSocket.OPEN);
    const sent = socket.sent.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(socket.sent.length).toBe(sent); // the silence pump stopped
    socket.receive({ type: "session.closed" });
    expect([...(await result)]).toEqual([1, 2, 3, 4]);
    expect(socket.readyState).toBe(3);
  });

  it("stops at the cap and releases the socket when session.closed never comes", async () => {
    vi.useFakeTimers();
    const result = recordSample({ apiKey: "sk-test", session: SESSION, speak: "Say it.", timing: { capMs: 1000, quietMs: 5000, closeMs: 200 } });
    const socket = FakeSocket.last!;
    socket.open();
    socket.receive({ type: "session.started" });
    socket.receive(audio([9, 9]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.types().at(-1)).toBe("session.close");
    await vi.advanceTimersByTimeAsync(200);
    expect([...(await result)]).toEqual([9, 9]);
    expect(socket.readyState).toBe(3);
  });

  it("reports an OpenAI error before the session starts", async () => {
    const result = recordSample({ apiKey: "sk-test", session: SESSION, speak: "Say it." });
    const socket = FakeSocket.last!;
    socket.open();
    socket.receive({ type: "error", error: { message: "Unknown voice: shimmer" } });
    await expect(result).rejects.toThrow("OpenAI: Unknown voice: shimmer");
    expect(socket.readyState).toBe(3);
  });

  it("says the voice did not speak when the session closes with no audio", async () => {
    const result = recordSample({ apiKey: "sk-test", session: SESSION, speak: "Say it." });
    const socket = FakeSocket.last!;
    socket.open();
    socket.receive({ type: "session.started" });
    socket.receive({ type: "session.closed" });
    await expect(result).rejects.toThrow(SAMPLE_SILENT_ERROR);
    // OpenAI closed first, so there is nothing to close.
    expect(socket.types()).not.toContain("session.close");
    expect(socket.readyState).toBe(3);
  });
});

describe("voiceSample", () => {
  it("is refused while a call is live, before any session opens", async () => {
    const { ctx } = await makeContext({ openaiKey: FULL_SETUP.openaiKey });
    insertCall(ctx, { channel: "app", device: DESKTOP_DEVICE });
    const record = vi.fn();
    await expect(voiceSample(ctx, { voice: "gleam" }, record)).rejects.toThrow(SAMPLE_BUSY_ERROR);
    expect(record).not.toHaveBeenCalled();
  });

  it("needs the OpenAI key for a new sample", async () => {
    const { ctx } = await makeContext();
    await expect(voiceSample(ctx, { voice: "gleam" }, vi.fn())).rejects.toThrow(NO_KEY_ERROR);
  });

  it("records once with the saved style, wraps a WAV, and serves the next play from the cache", async () => {
    const { ctx } = await makeContext({ openaiKey: FULL_SETUP.openaiKey });
    await writePreferences(ctx, { voiceStyle: { pace: "brisk" } });
    const record = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
    const first = await voiceSample(ctx, { voice: "sage" }, record);
    expect(first.cached).toBe(false);
    expect(Buffer.from(first.wav, "base64").subarray(0, 4).toString()).toBe("RIFF");
    expect(record).toHaveBeenCalledTimes(1);
    const call = record.mock.calls[0] as unknown as [{ apiKey: string; session: SampleSessionConfig; speak: string }];
    expect(call[0].apiKey).toBe(FULL_SETUP.openaiKey);
    expect(call[0].session.audio.output.voice).toBe("sage");
    expect(call[0].session.instructions).toContain("# Voice style");
    expect(call[0].session.instructions).toContain("briskly");
    expect(call[0].speak).toBe(sampleSpeech(VOICE_SAMPLE.text));

    const second = await voiceSample(ctx, { voice: "sage" }, record);
    expect(second).toEqual({ wav: first.wav, cached: true });
    expect(record).toHaveBeenCalledTimes(1);

    // A style change is a new sample.
    await writePreferences(ctx, { voiceStyle: { pace: "slower" } });
    expect((await voiceSample(ctx, { voice: "sage" }, record)).cached).toBe(false);
    expect(record).toHaveBeenCalledTimes(2);

    // Samples never touch the calls ledger or usage.
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM calls").get()).toEqual({ n: 0 });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM call_trace").get()).toEqual({ n: 0 });
  });

  it("sends a custom voice as { id } with its description in the instructions", async () => {
    const { ctx } = await makeContext({ openaiKey: FULL_SETUP.openaiKey });
    await writePreferences(ctx, { customVoices: [{ id: "voice_abc", name: "Calm", prompt: "A calm, low voice.", createdAt: "" }] });
    const record = vi.fn(async () => new Uint8Array([0, 0]));
    await voiceSample(ctx, { voice: "voice_abc" }, record);
    const call = record.mock.calls[0] as unknown as [{ session: SampleSessionConfig }];
    expect(call[0].session.audio.output.voice).toEqual({ id: "voice_abc" });
    expect(call[0].session.instructions).toContain("- Your voice: A calm, low voice.");
  });

  it("shares one session between two plays of the same new sample", async () => {
    const { ctx } = await makeContext({ openaiKey: FULL_SETUP.openaiKey });
    let done: (pcm: Uint8Array) => void = () => {};
    const record = vi.fn(() => new Promise<Uint8Array>((resolve) => (done = resolve)));
    const plays = [voiceSample(ctx, { voice: "gleam" }, record), voiceSample(ctx, { voice: "gleam" }, record)];
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    done(new Uint8Array([5, 6]));
    const [a, b] = await Promise.all(plays);
    expect(a!.wav).toBe(b!.wav);
  });

  it("is registered as an RPC and refuses during a live call", async () => {
    const { harness, bb } = await loadPlugin({ openaiKey: FULL_SETUP.openaiKey });
    bb.storage
      .database()
      .prepare("INSERT INTO calls (id, channel, device_json, started_at) VALUES ('call_1', 'phone', '{}', ?)")
      .run(Date.now());
    await expect(harness.callRpc("voiceSample", { voice: "gleam" })).rejects.toThrow(SAMPLE_BUSY_ERROR);
  });
});

describe("custom voices", () => {
  type FetchCall = { url: string; init: RequestInit };
  let fetchCalls: FetchCall[] = [];
  let respond: () => Response = () => new Response("{}");
  beforeEach(() => {
    fetchCalls = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return respond();
    });
  });

  it("creates a prompt voice with the key only in the Authorization header, and lists it without choosing it", async () => {
    const { ctx } = await makeContext({ openaiKey: FULL_SETUP.openaiKey });
    respond = () => Response.json({ id: "voice_123", name: "Calm", prompt: "A calm voice.", created_at: 1_790_000_000 });
    const prefs = await createCustomVoice(ctx, { name: " Calm ", prompt: " A calm voice. " });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(ENDPOINTS.voices);
    expect((fetchCalls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FULL_SETUP.openaiKey}`);
    expect(JSON.parse(String(fetchCalls[0]!.init.body))).toEqual({ type: "prompt", name: "Calm", prompt: "A calm voice.", model: "auto" });
    expect(prefs.customVoices).toEqual([{ id: "voice_123", name: "Calm", prompt: "A calm voice.", createdAt: new Date(1_790_000_000_000).toISOString() }]);
    expect(prefs.voice).toBe("gleam");
    expect(JSON.stringify(prefs)).not.toContain(FULL_SETUP.openaiKey);
  });

  it("names the missing api.voices.write permission", async () => {
    const { ctx } = await makeContext({ openaiKey: FULL_SETUP.openaiKey });
    respond = () => new Response(JSON.stringify({ error: { message: "Missing scopes: api.voices.write" } }), { status: 401 });
    await expect(createCustomVoice(ctx, { name: "Calm", prompt: "A calm voice." })).rejects.toThrow(VOICES_SCOPE_ERROR);
    respond = () => new Response("Not found", { status: 404 });
    await expect(createCustomVoice(ctx, { name: "Calm", prompt: "A calm voice." })).rejects.toThrow(VOICES_ACCESS_ERROR);
    respond = () => new Response("Too many voices", { status: 400 });
    await expect(createCustomVoice(ctx, { name: "Calm", prompt: "A calm voice." })).rejects.toThrow("OpenAI 400: Too many voices");
    expect((await readPreferences(ctx)).customVoices).toEqual([]);
  });

  it("checks the input before it calls OpenAI", async () => {
    const { ctx } = await makeContext({ openaiKey: FULL_SETUP.openaiKey });
    await expect(createCustomVoice(ctx, { name: " ", prompt: "x" })).rejects.toThrow("Give the voice a name.");
    await expect(createCustomVoice(ctx, { name: "x", prompt: "" })).rejects.toThrow("Describe the voice.");
    await expect(createCustomVoice(ctx, { name: "x", prompt: "y".repeat(1001) })).rejects.toThrow(/under 1000 characters/);
    expect(fetchCalls).toEqual([]);
  });

  it("removes a voice from the list, and a chosen one falls back to the default voice", async () => {
    const { ctx } = await makeContext();
    await writePreferences(ctx, {
      voice: "voice_a",
      customVoices: [
        { id: "voice_a", name: "A", prompt: "a", createdAt: "" },
        { id: "voice_b", name: "B", prompt: "b", createdAt: "" },
      ],
    });
    const prefs = await removeCustomVoice(ctx, { id: "voice_a" });
    expect(prefs.customVoices.map((voice) => voice.id)).toEqual(["voice_b"]);
    expect(prefs.voice).toBe("gleam");
    expect(fetchCalls).toEqual([]);
  });
});
