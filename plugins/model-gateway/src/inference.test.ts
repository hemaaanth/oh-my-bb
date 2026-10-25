import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { statusSchema } from "./contracts.js";
import { parseResponsesStream } from "./inference.js";
import { createAccountPoolPlugin } from "./server.js";

const T = 1_800_000_000_000;
const OPENROUTER = "https://openrouter.test/api/v1";
const JOURNAL = { experimental_caller: { kind: "plugin", pluginId: "journal" } } as const;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface Sent {
  who: string;
  url: string;
  headers: Headers;
  body: string;
}

const sse = (body: BodyInit) => new Response(body, { headers: { "content-type": "text/event-stream" } });
const frame = (event: { type: string } & Record<string, unknown>) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const completed = (text: string, extra: object = {}) =>
  sse(
    frame({ type: "response.output_text.delta", delta: text }) +
      frame({
        type: "response.completed",
        response: {
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text }] }],
          usage: { input_tokens: 12, output_tokens: 5 },
          ...extra,
        },
      }),
  );
// The package's ES lib has no Promise.withResolvers.
const hang = (signal: AbortSignal | null) =>
  new Promise<Response>((_resolve, reject) =>
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
  );

async function gateway(options: { codex?: boolean; keys?: boolean } = {}) {
  const sent: Sent[] = [];
  let reply: (signal: AbortSignal | null, url: string) => Response | Promise<Response> = () => completed('{"ok":true}');
  const dataDir = await mkdtemp(path.join(tmpdir(), "mgw-inference-"));
  const host = createFakePluginHost({
    pluginId: "model-gateway",
    dataDir,
    sdk: {
      hosts: { list: async () => [{ id: "host-one", name: "One" }] },
      system: { providerStates: async () => ({ providers: [] }) },
      plugins: { list: async () => ({ plugins: [{ id: "model-gateway", enabled: true }] }) },
    },
  });
  await host.bb.storage.kv.set("config", {
    anthropicUpstreamBaseUrl: "https://anthropic.test",
    codexUpstreamBaseUrl: "https://chatgpt.test",
  });
  await createAccountPoolPlugin({
    now: () => T,
    usageUrl: "data:application/json,{}",
    codexUsageUrl: "data:application/json,{}",
    fetch: async (input, init) => {
      if (String(input).startsWith("data:")) return Response.json({});
      const headers = new Headers(init?.headers);
      const who = headers.get("x-api-key") ?? headers.get("authorization")?.replace(/^Bearer /u, "") ?? "none";
      sent.push({
        who,
        url: String(input),
        headers,
        body: init?.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) : String(init?.body ?? ""),
      });
      return reply(init?.signal ?? null, String(input));
    },
    importCredentials: async () => ({
      accessToken: "max-token",
      refreshToken: "max-refresh",
      expiresAt: T + 86_400_000,
      subscriptionType: "max",
      rateLimitTier: "max_20x",
      email: "max@example.com",
      accountUuid: "11111111-1111-4111-8111-111111111111",
    }),
    importCodexCredentials: async () => ({
      accessToken: "pro-token",
      refreshToken: "pro-refresh",
      idToken: null,
      accountId: "chatgpt-account",
      email: "pro@example.com",
      expiresAt: T + 86_400_000,
    }),
  })(host.bb);
  const rpc = host.harness.behavior.callRpc;
  const cli = (...argv: string[]) => host.harness.behavior.runCli(argv);
  const add = (provider: string, source: object) =>
    rpc("account.add", { provider, source, label: null, priority: 100 });
  await add("claude", { kind: "import" });
  if (options.keys) {
    await add("claude", { kind: "api-key", apiKey: "anthropic-key" });
    await cli("key", "add", "responses-compatible-key", "--label", "openrouter", "--base-url", OPENROUTER, "--key", "sk-or");
  }
  if (options.codex !== false) await add("codex", { kind: "import" });
  const service = host.harness.behavior.runService("hub");
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    service.controller.abort();
    await service.done;
  };
  cleanups.push(async () => {
    await stop();
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await vi.waitFor(async () => {
    const result = await cli("status", "--json");
    expect(statusSchema.parse(JSON.parse(result.stdout)).accepting).toBe(true);
  });
  return {
    sent,
    cli,
    rpc,
    stop,
    setReply: (next: typeof reply) => {
      reply = next;
    },
    complete: (input: object, context: object = JOURNAL) =>
      rpc("inference.complete", { system: "Summarize.", input: "Notes.", ...input }, context) as Promise<Record<string, any>>,
    status: (context: object = JOURNAL) => rpc("inference.status", null, context) as Promise<Record<string, any>>,
  };
}

describe("inference.complete", () => {
  it("uses only the ChatGPT subscription even with paid keys first in the chain and auto on", async () => {
    const gw = await gateway({ keys: true });
    expect((await gw.cli("chain", "set", "codex", "responses-compatible-key:openrouter", "chatgpt-oauth:*")).exitCode).toBe(0);
    expect((await gw.cli("auto", "codex", "--key", "openrouter")).exitCode).toBe(0);
    const result = await gw.complete({
      model: "gpt-5.6-luna",
      schema: { name: "entry", schema: { type: "object", properties: { ok: { type: "boolean" } } } },
    });
    expect(result).toEqual({
      ok: true,
      text: '{"ok":true}',
      model: "gpt-5.6-luna",
      billing: "subscription",
      usage: { inputTokens: 12, outputTokens: 5 },
    });
    expect(gw.sent.map(({ who, url }) => [who, url])).toEqual([["pro-token", "https://chatgpt.test/responses"]]);
    const [request] = gw.sent;
    expect(request!.headers.get("chatgpt-account-id")).toBe("chatgpt-account");
    const body = JSON.parse(request!.body);
    expect(body).toEqual({
      model: "gpt-5.6-luna",
      instructions: "Summarize.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Notes." }] }],
      stream: true,
      store: false,
      reasoning: { effort: "low" },
      text: {
        format: {
          type: "json_schema",
          name: "entry",
          schema: { type: "object", properties: { ok: { type: "boolean" } } },
          strict: true,
        },
      },
    });
    expect(await gw.rpc("live.get", null)).toMatchObject({ threads: [] });
  });

  it("defaults to gpt-6-luna and rejects any other model, oversized or unknown input", async () => {
    const gw = await gateway();
    expect(await gw.complete({})).toMatchObject({ ok: true, model: "gpt-6-luna" });
    expect(JSON.parse(gw.sent[0]!.body).model).toBe("gpt-6-luna");
    for (const input of [
      { model: "gpt-6-sol" },
      { input: "x".repeat(64_001) },
      { system: "" },
      { maxOutputTokens: 10 },
      { timeoutMs: 120_000 },
      { schema: { name: "bad name", schema: {} } },
      { schema: { name: "big", schema: { blob: "x".repeat(17_000) } } },
      // Each field fits; together with JSON escaping they do not.
      { system: "\u0001".repeat(16_000), input: "\u0001".repeat(10_000) },
    ])
      await expect(gw.complete(input)).rejects.toMatchObject({ code: "invalid_input" });
    expect(gw.sent).toHaveLength(1);
  });

  it("is forbidden to any caller but the Journal plugin", async () => {
    const gw = await gateway();
    for (const context of [{}, { experimental_caller: { kind: "plugin", pluginId: "pages" } }]) {
      expect(await gw.complete({}, context)).toMatchObject({ ok: false, code: "forbidden", retryAt: null });
      expect(await gw.status(context)).toMatchObject({ available: false, usableAccounts: 0 });
    }
    expect(gw.sent).toHaveLength(0);
  });

  it("reports no subscription account without falling back to API keys", async () => {
    const gw = await gateway({ codex: false, keys: true });
    expect(await gw.status()).toMatchObject({ available: false, usableAccounts: 0, reason: expect.stringContaining("ChatGPT") });
    expect(await gw.complete({})).toMatchObject({ ok: false, code: "unavailable" });
    expect(gw.sent).toHaveLength(0);
  });

  it("holds a rate-limited account and then answers without calling upstream", async () => {
    const gw = await gateway();
    expect(await gw.status()).toMatchObject({ available: true, usableAccounts: 1, retryAt: null, reason: null });
    gw.setReply(() => Response.json({ error: { message: "slow down" } }, { status: 429, headers: { "retry-after": "60" } }));
    expect(await gw.complete({})).toEqual({
      ok: false,
      code: "rate_limited",
      message: expect.any(String),
      retryAt: T + 60_000,
    });
    expect(gw.sent).toHaveLength(1);
    expect(await gw.rpc("live.get", null)).toMatchObject({ holds: [{ until: T + 60_000 }] });
    expect(await gw.complete({})).toMatchObject({ ok: false, code: "rate_limited", retryAt: T + 60_000 });
    expect(await gw.status()).toMatchObject({ available: false, usableAccounts: 0, retryAt: T + 60_000 });
    expect(gw.sent).toHaveLength(1);
  });

  it("returns safe upstream errors without credentials", async () => {
    const gw = await gateway();
    gw.setReply(() => Response.json({ error: { message: "bad request" } }, { status: 400 }));
    const failed = await gw.complete({});
    expect(failed).toMatchObject({ ok: false, code: "upstream_error", message: "ChatGPT returned HTTP 400. bad request" });
    gw.setReply(() => Promise.reject(new TypeError("fetch failed pro-token")));
    const offline = await gw.complete({});
    expect(offline).toMatchObject({ ok: false, code: "upstream_error" });
    expect(JSON.stringify([failed, offline])).not.toMatch(/pro-token|pro-refresh|chatgpt-account/u);
  });

  it("maps malformed and oversized streams to typed failures", async () => {
    const gw = await gateway();
    gw.setReply(() => sse(frame({ type: "response.output_text.delta", delta: "partial" })));
    expect(await gw.complete({})).toMatchObject({ ok: false, code: "upstream_error" });
    gw.setReply(() => sse(frame({ type: "response.incomplete", response: { status: "incomplete", output: [] } })));
    expect(await gw.complete({})).toMatchObject({ ok: false, code: "invalid_output" });
    gw.setReply(() => sse(frame({ type: "response.completed", response: { status: "completed", output: [] } })));
    expect(await gw.complete({})).toMatchObject({ ok: false, code: "invalid_output" });
    gw.setReply(() => completed("x".repeat(70_000)));
    expect(await gw.complete({})).toMatchObject({ ok: false, code: "invalid_output" });
  });

  it("never waits out a short hold inline: one 429 with a short retry-after returns at once", async () => {
    const gw = await gateway();
    gw.setReply(() => Response.json({}, { status: 429, headers: { "retry-after": "5" } }));
    const started = Date.now();
    expect(await gw.complete({})).toMatchObject({ ok: false, code: "rate_limited", retryAt: T + 5_000 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(gw.sent).toHaveLength(1);
  });

  it("stops reading a stalled body that ignores abort, on timeout and on shutdown", async () => {
    const gw = await gateway();
    const stalled = () => sse(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }));
    gw.setReply(stalled);
    expect(await gw.complete({ timeoutMs: 1_000 })).toMatchObject({ ok: false, code: "timeout" });
    const pending = gw.complete({});
    await vi.waitFor(() => expect(gw.sent).toHaveLength(2));
    await gw.stop();
    expect(await pending).toMatchObject({ ok: false, code: "stopped" });
  });

  it("times out, limits concurrency and stops in-flight calls on shutdown", async () => {
    const gw = await gateway();
    gw.setReply((signal) => hang(signal));
    expect(await gw.complete({ timeoutMs: 1_000 })).toMatchObject({ ok: false, code: "timeout" });
    const first = gw.complete({});
    const second = gw.complete({});
    await vi.waitFor(() => expect(gw.sent).toHaveLength(3));
    expect(await gw.status()).toMatchObject({ inFlight: 2, maxConcurrent: 2 });
    expect(await gw.complete({})).toMatchObject({ ok: false, code: "busy", retryAt: T + 2_000 });
    await gw.stop();
    expect(await first).toMatchObject({ ok: false, code: "stopped" });
    expect(await second).toMatchObject({ ok: false, code: "stopped" });
    expect(await gw.complete({})).toMatchObject({ ok: false, code: "stopped" });
    expect(await gw.status()).toMatchObject({ available: false, inFlight: 0 });
  });
});

describe("parseResponsesStream", () => {
  const stream = (text: string, chunk = 7) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(text);
        for (let index = 0; index < bytes.length; index += chunk) controller.enqueue(bytes.subarray(index, index + chunk));
        controller.close();
      },
    });

  it("reads text split across chunks and CRLF frames, falling back to output items", async () => {
    const body =
      frame({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "héllo" }] } }).replace(/\n/gu, "\r\n") +
      frame({ type: "response.completed", response: { status: "completed", output: [] } });
    expect(await parseResponsesStream(stream(body))).toEqual({ kind: "text", text: "héllo", usage: null });
  });

  it("keeps frames whole when CRLF, UTF-8 or the last frame split across chunks", async () => {
    const terminal = JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "naïve" }] }] } });
    // One event over two data lines: a split CRLF that adds a blank line would cut it in half.
    const cut = terminal.indexOf(",");
    const body = (
      frame({ type: "response.output_text.delta", delta: "é" }) +
      `event: response.completed\ndata: ${terminal.slice(0, cut)}\ndata: ${terminal.slice(cut)}\n\n`
    ).replace(/\n/gu, "\r\n");
    // Every chunk size splits some CRLF pair and some multi-byte character.
    for (const chunk of [1, 2, 3, 5]) expect(await parseResponsesStream(stream(body, chunk))).toEqual({ kind: "text", text: "naïve", usage: null });
    // No blank line after the terminal frame.
    const unterminated = frame({ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "end" }] }] } }).trimEnd() + "\r";
    expect(await parseResponsesStream(stream(unterminated, 4))).toMatchObject({ kind: "text", text: "end" });
  });

  it("returns when its signal aborts a read the body never answers", async () => {
    const controller = new AbortController();
    const parsed = parseResponsesStream(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }), controller.signal);
    controller.abort();
    expect(await parsed).toMatchObject({ kind: "error", code: "upstream_error" });
  });

  it("stops reading past the size cap", async () => {
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
      },
    });
    expect(await parseResponsesStream(endless)).toMatchObject({ kind: "error", code: "invalid_output" });
    expect(pulls).toBeLessThan(10);
  });
});
