import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { Response as UndiciResponse } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertLegalChains,
  chainsSchema,
  contextWindow,
  expandChain,
  fitForChatGpt,
  gatewayModel,
  isLegalUpstream,
  isNewUserTurn,
  mapModel,
  needsApiKeyUpstream,
  ompModels,
  orderEntries,
  readThreadToken,
  responseExhaustion,
  signThreadToken,
  upstreamKind,
  verifyThreadToken,
  DEFAULT_MODEL_MAP,
  type ThreadIdentity,
} from "./chain.js";
import { accountSchema, statusSchema, type Account } from "./contracts.js";
import { createAccountPoolPlugin } from "./server.js";
import { createClaudeAdapter } from "./upstreams/claude-adapter.js";
import { createCodexAdapter } from "./upstreams/codex-adapter.js";
import { EMPTY_QUOTA, HubTokenStore } from "./upstreams/store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function account(overrides: Partial<Account>): Account {
  return accountSchema.parse({
    id: crypto.randomUUID(),
    provider: "claude",
    kind: "oauth",
    label: "account",
    email: null,
    subscriptionType: null,
    rateLimitTier: null,
    enabled: true,
    priority: 100,
    createdAt: 0,
    ...overrides,
  });
}

describe("chain config", () => {
  it("expands wildcards to enabled accounts in priority order, once each", () => {
    const max = account({ label: "max", priority: 2 });
    const max2 = account({ label: "max2", priority: 1 });
    const off = account({ label: "off", enabled: false });
    const key = account({ label: "key", kind: "api-key" });
    const pro = account({ label: "pro", provider: "codex" });
    const labels = expandChain(
      [max.id, "claude-oauth:*", "claude-key:*", "chatgpt-oauth:*"],
      [max, max2, off, key, pro],
    ).map((entry) => entry.map(({ label }) => label));
    expect(labels).toEqual([["max"], ["max2"], ["key"], ["pro"]]);
  });

  it("expands <kind>:<label> entries and maps per key before per kind (P4)", () => {
    const kimi = account({ label: "kimi", kind: "api-key", baseUrl: "https://kimi.test/anthropic" });
    const glm = account({ label: "glm", kind: "api-key", baseUrl: "https://glm.test/anthropic" });
    const openrouter = account({ label: "or", kind: "api-key", provider: "codex", baseUrl: "https://or.test/api/v1" });
    const direct = account({ label: "direct", kind: "api-key" });
    expect([kimi, glm, openrouter, direct].map(upstreamKind)).toEqual([
      "anthropic-compatible-key",
      "anthropic-compatible-key",
      "responses-compatible-key",
      "claude-key",
    ]);
    const labels = expandChain(
      ["anthropic-compatible-key:glm", "anthropic-compatible-key:*", "responses-compatible-key:or", "claude-key:*", "anthropic-compatible-key:gone"],
      [kimi, glm, openrouter, direct],
    ).map((entry) => entry.map(({ label }) => label));
    expect(labels).toEqual([["glm"], ["kimi"], ["or"], ["direct"], []]);
    const map = {
      "anthropic-compatible-key": { "claude-*": "generic" },
      "anthropic-compatible-key:kimi": { "claude-opus-*": "kimi-k3" },
    };
    expect(mapModel(map, kimi, "claude-opus-5-5")).toBe("kimi-k3");
    expect(mapModel(map, kimi, "claude-haiku-4-5")).toBe("generic");
    expect(mapModel(map, glm, "claude-opus-5-5")).toBe("generic");
    expect(gatewayModel({ "responses-compatible-key": { "gpt-6-*": "openai/gpt-6" } }, openrouter, "gw-gpt-6-sol")).toBe("openai/gpt-6");
    expect(chainsSchema.safeParse({ codex: ["anthropic-compatible-key:kimi"] }).success).toBe(true);
    expect(chainsSchema.safeParse({ codex: ["anthropic-compatible-key:bad label"] }).success).toBe(false);
    expect(() => assertLegalChains(chainsSchema.parse({ pi: ["claude-oauth:*"] }), [])).toThrow(/claude-code harness/u);
  });

  it("maps automatic Claude fallbacks to the configured cost tiers", () => {
    expect(mapModel(DEFAULT_MODEL_MAP, "chatgpt-oauth", "claude-opus-4-7")).toBe(
      "gpt-6-sol",
    );
    expect(mapModel(DEFAULT_MODEL_MAP, "chatgpt-oauth", "claude-sonnet-5")).toBe(
      "gpt-5.6-terra",
    );
    expect(mapModel(DEFAULT_MODEL_MAP, "chatgpt-oauth", "claude-haiku-4-5")).toBe(
      "gpt-6-luna",
    );
    expect(mapModel(DEFAULT_MODEL_MAP, "chatgpt-oauth", "claude-fable-5-1")).toBe(
      "gpt-6-astra",
    );
    expect(mapModel(DEFAULT_MODEL_MAP, "claude-oauth", "claude-opus-4-7")).toBe(
      null,
    );
  });

  it("allows Claude OAuth only for a Claude Code token on a Messages path", () => {
    expect(isLegalUpstream("claude-oauth", "claude-code", "/v1/messages")).toBe(
      true,
    );
    expect(
      isLegalUpstream("claude-oauth", "claude-code", "/v1/messages/count_tokens"),
    ).toBe(true);
    expect(isLegalUpstream("claude-oauth", "claude-code", "/v1/responses")).toBe(
      false,
    );
    expect(isLegalUpstream("claude-oauth", "codex", "/v1/messages")).toBe(false);
    expect(isLegalUpstream("claude-oauth", "acp-omp", "/v1/messages")).toBe(
      false,
    );
    expect(isLegalUpstream("claude-oauth", null, "/v1/messages")).toBe(false);
    expect(isLegalUpstream("claude-key", "acp-omp", "/v1/messages")).toBe(true);
    expect(isLegalUpstream("chatgpt-oauth", "codex", "/v1/responses")).toBe(
      true,
    );
  });

  it("rejects chains that put Claude OAuth behind another harness", () => {
    const max = account({});
    const key = account({ kind: "api-key" });
    const chains = (patch: object) => chainsSchema.parse(patch);
    expect(() => assertLegalChains(chains({}), [max, key])).not.toThrow();
    expect(() =>
      assertLegalChains(chains({ codex: ["claude-oauth:*"] }), [max]),
    ).toThrow(/claude-code harness/u);
    expect(() =>
      assertLegalChains(chains({ "acp-omp": [max.id] }), [max]),
    ).toThrow(/claude-code harness/u);
    expect(() =>
      assertLegalChains(chains({ "acp-omp": [key.id] }), [max, key]),
    ).not.toThrow();
    expect(() =>
      assertLegalChains(chains({ pi: [crypto.randomUUID()] }), [max]),
    ).toThrow(/not a known account/u);
    expect(chainsSchema.safeParse({ codex: ["openai:*"] }).success).toBe(false);
  });

  it("keeps Claude OAuth away from omp, FX and nanocodex", () => {
    const max = account({});
    for (const harness of ["acp-omp", "acp-fx", "acp-nanocodex"] as const) {
      for (const path of ["/v1/messages", "/v1/responses", "/v1/models"])
        expect(isLegalUpstream("claude-oauth", harness, path)).toBe(false);
      expect(isLegalUpstream("chatgpt-oauth", harness, "/v1/responses")).toBe(
        true,
      );
      expect(() =>
        assertLegalChains(
          chainsSchema.parse({ [harness]: ["chatgpt-oauth:*", "claude-oauth:*"] }),
          [max],
        ),
      ).toThrow(/claude-code harness/u);
      expect(() =>
        assertLegalChains(chainsSchema.parse({ [harness]: [max.id] }), [max]),
      ).toThrow(/claude-code harness/u);
    }
  });

  it("maps omp, FX and nanocodex models onto ChatGPT", () => {
    const map = DEFAULT_MODEL_MAP;
    expect(ompModels(map)).toEqual([
      "gw-gpt-6-astra",
      "gw-gpt-6-sol",
      "gw-gpt-5.6-terra",
      "gw-gpt-6-luna",
    ]);
    expect(gatewayModel(map, "chatgpt-oauth", "gw-gpt-6-astra")).toBe(
      "gpt-6-astra",
    );
    expect(gatewayModel(map, "chatgpt-oauth", "gpt-6-sol")).toBe("gpt-6-sol");
    expect(gatewayModel(map, "chatgpt-oauth", "gpt-5.6-luna")).toBe(
      "gpt-5.6-luna",
    );
    expect(
      gatewayModel(
        { "chatgpt-oauth": { "kimi-k3": "gpt-6-sol" } },
        "chatgpt-oauth",
        "kimi-k3",
      ),
    ).toBe("gpt-6-sol");
    for (const model of ["kimi-k3", "@cf/zai-org/glm-5.3", "mimo-v2.6-pro"])
      expect(needsApiKeyUpstream(model)).toBe(true);
    for (const model of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", null])
      expect(needsApiKeyUpstream(model)).toBe(false);
    const extra = { type: "additional_tools", tools: [{ name: "exec_command" }] };
    expect(
      fitForChatGpt(
        {
          model: "gw-gpt-6-sol",
          input: [extra],
          max_output_tokens: 1,
          temperature: 0,
          top_p: 1,
          stop: ["x"],
          user: "u",
          store: false,
        },
        "gpt-6-sol",
      ),
    ).toEqual({ model: "gpt-6-sol", input: [extra], store: false });
  });
});

describe("thread tokens", () => {
  const secret = Buffer.alloc(32, 7).toString("base64url");
  const identity: ThreadIdentity = {
    hostId: "host-one",
    threadId: "thr_one",
    harness: "claude-code",
  };

  it("carries the host, thread and harness and rejects a forged thread id", () => {
    const token = signThreadToken(secret, identity);
    expect(readThreadToken(token)).toEqual(identity);
    expect(verifyThreadToken(secret, token)).toBe(true);
    const [, mac] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify(["host-one", "thr_two", "claude-code"])).toString("base64url")}.${mac}`;
    expect(readThreadToken(forged)?.threadId).toBe("thr_two");
    expect(verifyThreadToken(secret, forged)).toBe(false);
    const otherHarness = `${Buffer.from(JSON.stringify(["host-one", "thr_one", "codex"])).toString("base64url")}.${mac}`;
    expect(verifyThreadToken(secret, otherHarness)).toBe(false);
    expect(
      verifyThreadToken(Buffer.alloc(32, 8).toString("base64url"), token),
    ).toBe(false);
  });

  it("authenticates through the host secret and keeps the prior secret for the grace window", async () => {
    let now = 1_000;
    const dir = await mkdtemp(path.join(tmpdir(), "mgw-tokens-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const tokens = new HubTokenStore(dir, () => now);
    const token = await tokens.forThread(identity);
    expect(await tokens.authenticate(token)).toEqual(identity);
    const [, mac] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify(["host-one", "thr_other", "claude-code"])).toString("base64url")}.${mac}`;
    expect(await tokens.authenticate(forged)).toBeNull();
    expect(await tokens.authenticate("not-a-token")).toBeNull();
    const stored = await fs.readFile(
      path.join(dir, "hub-token-host-one.json"),
      "utf8",
    );
    expect(stored).not.toContain(token);
    await tokens.rotate("host-one");
    expect(await tokens.forThread(identity)).not.toBe(token);
    now += 9 * 60 * 1_000;
    expect(await tokens.authenticate(token)).toEqual(identity);
    now += 2 * 60 * 1_000;
    expect(await tokens.authenticate(token)).toBeNull();
  });
});

describe("sticky rules", () => {
  it("detects a new user turn in Messages and Responses bodies", () => {
    expect(
      isNewUserTurn({ messages: [{ role: "user", content: "hi" }] }),
    ).toBe(true);
    expect(
      isNewUserTurn({
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "system", content: "reminder" },
        ],
      }),
    ).toBe(true);
    expect(
      isNewUserTurn({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "tool_use", id: "t" }] },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t" },
              { type: "text", text: "<system-reminder>" },
            ],
          },
        ],
      }),
    ).toBe(false);
    expect(isNewUserTurn({ input: "hi" })).toBe(true);
    expect(
      isNewUserTurn({
        input: [
          { type: "message", role: "developer", content: [] },
          { type: "message", role: "user", content: [] },
        ],
      }),
    ).toBe(true);
    expect(isNewUserTurn({ input: [{ role: "user", content: "hi" }] })).toBe(
      true,
    );
    expect(
      isNewUserTurn({
        input: [
          { type: "message", role: "user", content: [] },
          { type: "function_call", call_id: "c" },
          { type: "function_call_output", call_id: "c", output: "ok" },
        ],
      }),
    ).toBe(false);
    expect(isNewUserTurn(null)).toBe(false);
  });

  it("keeps a bound fallback first until the primary resets, and always mid tool-loop", () => {
    expect(orderEntries(3, -1, null, false, 0)).toEqual({
      order: [0, 1, 2],
      sticky: false,
    });
    expect(orderEntries(3, 1, 100, false, 50)).toEqual({
      order: [1, 2, 0],
      sticky: true,
    });
    expect(orderEntries(3, 1, 100, true, 50).sticky).toBe(true);
    expect(orderEntries(3, 1, 100, false, 150).sticky).toBe(true);
    expect(orderEntries(3, 1, 100, true, 150)).toEqual({
      order: [0, 1, 2],
      sticky: false,
    });
    expect(orderEntries(3, 1, null, true, 0).sticky).toBe(false);
  });
});

describe("S6 exhaustion rules", () => {
  const now = 1_700_000_000_000;
  const empty = { accountId: crypto.randomUUID(), ...EMPTY_QUOTA };
  const codex = createCodexAdapter({
    refreshUrl: "https://auth.test/token",
    usageUrl: "https://usage.test",
  });
  const claude = createClaudeAdapter({
    refreshUrl: "https://auth.test/token",
    usageUrl: "https://usage.test",
    profileUrl: "https://profile.test",
  });

  it("reads ChatGPT exhaustion and reset from x-codex headers only", () => {
    // Pooler fixture: 429 {"error":{"message":"quota exhausted"}} with used-percent 100.
    expect(
      responseExhaustion(
        codex,
        429,
        new Headers({
          "x-codex-primary-used-percent": "100",
          "x-codex-primary-reset-after-seconds": "3600",
        }),
        "other",
        empty,
        now,
      ),
    ).toEqual({ resetAt: now + 3_600_000 });
    // Pooler fixture: 429 {} with over-limit true.
    expect(
      responseExhaustion(
        codex,
        429,
        new Headers({
          "x-codex-primary-used-percent": "40",
          "x-codex-secondary-over-limit": "true",
          "x-codex-secondary-reset-at": String(now / 1_000 + 86_400),
        }),
        "other",
        empty,
        now,
      ),
    ).toEqual({ resetAt: now + 86_400_000 });
    expect(
      responseExhaustion(
        codex,
        429,
        new Headers({ "retry-after": "5" }),
        "other",
        empty,
        now,
      ),
    ).toBeNull();
    expect(
      responseExhaustion(
        codex,
        200,
        new Headers({ "x-codex-primary-used-percent": "100" }),
        "other",
        empty,
        now,
      ),
    ).toBeNull();
  });

  it("reads Anthropic exhaustion and reset from unified rate-limit headers only", () => {
    // Pooler fixture: 429 {"rejected":true} with 5h-status rejected.
    expect(
      responseExhaustion(
        claude,
        429,
        new Headers({
          "anthropic-ratelimit-unified-5h-status": "rejected",
          "anthropic-ratelimit-unified-5h-reset": String(now / 1_000 + 1_800),
          "anthropic-ratelimit-unified-7d-status": "allowed",
          "anthropic-ratelimit-unified-7d-reset": String(now / 1_000 + 500_000),
        }),
        "opus",
        empty,
        now,
      ),
    ).toEqual({ resetAt: now + 1_800_000 });
    expect(
      responseExhaustion(
        claude,
        429,
        new Headers({
          "anthropic-ratelimit-unified-7d_fable-status": "rejected",
          "anthropic-ratelimit-unified-7d_fable-reset": String(
            now / 1_000 + 7_200,
          ),
        }),
        "fable",
        empty,
        now,
      ),
    ).toEqual({ resetAt: now + 7_200_000 });
    expect(
      responseExhaustion(
        claude,
        429,
        new Headers({ "anthropic-ratelimit-unified-5h-status": "allowed" }),
        "opus",
        empty,
        now,
      ),
    ).toBeNull();
  });

  it("knows context windows per vendor model", () => {
    const none = new Headers();
    expect(contextWindow("claude-opus-4-7", none)).toBe(200_000);
    expect(
      contextWindow(
        "claude-opus-4-7",
        new Headers({ "anthropic-beta": "context-1m-2025-08-07,other" }),
      ),
    ).toBe(1_000_000);
    expect(contextWindow("gpt-6-astra", none)).toBe(272_000);
    expect(contextWindow("mystery", none)).toBeNull();
    expect(contextWindow(null, none)).toBeNull();
  });
});

// Hub tests with fake upstreams: entry 0 is a Claude Max OAuth account,
// entry 1 an Anthropic API key account, so failover needs no translation.
describe("chain failover in the hub", () => {
  const T = 1_800_000_000_000;
  const RESET = T + 60 * 60 * 1_000;

  interface Upstream {
    maxExhausted: boolean;
    attempts: string[];
    requests: Array<{
      who: string;
      url: string;
      headers: Headers;
      body: string;
      signal: AbortSignal | null;
    }>;
    /** Optional per-upstream answers; the default echoes who served. */
    reply?: (
      who: string,
      signal: AbortSignal | null,
      url: string,
    ) => Response | Promise<Response> | undefined;
  }

  async function gateway(
    options: { withCodex?: boolean; config?: object } = {},
  ) {
    let now = T;
    const upstream: Upstream = {
      maxExhausted: false,
      attempts: [],
      requests: [],
    };
    const dataDir = await mkdtemp(path.join(tmpdir(), "mgw-chain-"));
    const host = createFakePluginHost({
      pluginId: "model-gateway",
      dataDir,
      sdk: {
        hosts: { list: async () => [{ id: "host-one", name: "One" }] },
        system: { providerStates: async () => ({ providers: [] }) },
        plugins: {
          list: async () => ({
            plugins: [{ id: "model-gateway", enabled: true }],
          }),
        },
      },
    });
    await host.bb.storage.kv.set("config", {
      anthropicUpstreamBaseUrl: "https://anthropic.test",
      codexUpstreamBaseUrl: "https://chatgpt.test",
      ...options.config,
    });
    await createAccountPoolPlugin({
      now: () => now,
      jevTimeoutMs: 50,
      usageUrl: "data:application/json,{}",
      codexUsageUrl: "data:application/json,{}",
      fetch: async (input, init) => {
        if (String(input).startsWith("data:")) return Response.json({});
        const headers = new Headers(init?.headers);
        const who =
          headers.get("x-api-key") ??
          headers.get("authorization")?.replace(/^Bearer /u, "") ??
          "none";
        upstream.attempts.push(who);
        upstream.requests.push({
          who,
          url: String(input),
          headers,
          body:
            init?.body instanceof ArrayBuffer
              ? new TextDecoder().decode(init.body)
              : typeof init?.body === "string"
                ? init.body
                : "",
          signal: init?.signal ?? null,
        });
        const replied = upstream.reply?.(who, init?.signal ?? null, String(input));
        if (replied !== undefined) return replied;
        if (who === "max-token" && upstream.maxExhausted)
          return Response.json(
            { rejected: true },
            {
              status: 429,
              headers: {
                "anthropic-ratelimit-unified-5h-status": "rejected",
                "anthropic-ratelimit-unified-5h-reset": String(RESET / 1_000),
              },
            },
          );
        return Response.json({ served: who });
      },
      importCredentials: async () => ({
        accessToken: "max-token",
        refreshToken: "max-refresh",
        expiresAt: T + 24 * 60 * 60 * 1_000,
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
        expiresAt: T + 24 * 60 * 60 * 1_000,
      }),
    })(host.bb);
    const add = async (source: object, provider = "claude") =>
      accountSchema.parse(
        await host.harness.behavior.callRpc("account.add", {
          provider,
          source,
          label: null,
          priority: 100,
        }),
      );
    const max = await add({ kind: "import" });
    const key = await add({ kind: "api-key", apiKey: "key-token" });
    const pro = options.withCodex ? await add({ kind: "import" }, "codex") : null;
    const service = host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    await vi.waitFor(async () => {
      const result = await host.harness.behavior.runCli(["status", "--json"]);
      expect(statusSchema.parse(JSON.parse(result.stdout)).accepting).toBe(
        true,
      );
    });
    const cli = (...argv: string[]) => host.harness.behavior.runCli(argv);
    const token = async (provider: "claude-code" | "codex", threadId: string) => {
      const entries = await host.harness.behavior.resolveProviderEnv(provider, {
        threadId,
        projectId: "project-one",
        hostId: "host-one",
      });
      const entry = entries.find(
        (candidate) =>
          candidate.name === "ANTHROPIC_AUTH_TOKEN" ||
          candidate.name === "CODEX_POOL_AUTH_TOKEN",
      );
      if (typeof entry?.value !== "string") throw new Error("No token.");
      return entry.value;
    };
    const env = (harness: string, threadId: string) =>
      host.harness.behavior.resolveProviderEnv(harness, {
        threadId,
        projectId: "project-one",
        hostId: "host-one",
      });
    const send = async (
      key: string,
      body: object,
      route = "/v1/messages",
      extra: Record<string, string> = {},
    ) => {
      const response = await host.harness.behavior.fetchHttp("POST", route, {
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          ...extra,
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    };
    const route = async (threadId: string) => {
      const result = await cli("status", "--thread", threadId, "--json");
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout) as {
        entryIndex: number;
        stickyUntil: number | null;
        reason: string;
      };
    };
    return {
      host,
      upstream,
      max,
      key,
      pro,
      cli,
      token,
      env,
      send,
      route,
      setNow: (value: number) => {
        now = value;
      },
    };
  }

  const userTurn = {
    model: "claude-opus-4-7",
    messages: [{ role: "user", content: "hello" }],
  };
  const toolResult = {
    model: "claude-opus-4-7",
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    ],
  };

  it("fails over mid tool-loop before any byte, stays until reset, and returns only at a new user turn", async () => {
    const gw = await gateway();
    expect(
      (await gw.cli("chain", "set", "claude-code", gw.max.id, "claude-key:*"))
        .exitCode,
    ).toBe(0);
    const key = await gw.token("claude-code", "thr_loop");

    expect(await gw.send(key, userTurn)).toEqual({
      status: 200,
      text: '{"served":"max-token"}',
    });
    expect((await gw.route("thr_loop")).entryIndex).toBe(0);

    // Max runs out while a tool loop is running: the 429 is never forwarded.
    gw.upstream.maxExhausted = true;
    gw.upstream.attempts.length = 0;
    expect(await gw.send(key, toolResult)).toEqual({
      status: 200,
      text: '{"served":"key-token"}',
    });
    expect(gw.upstream.attempts).toEqual(["max-token", "key-token"]);
    expect(await gw.route("thr_loop")).toMatchObject({
      entryIndex: 1,
      stickyUntil: RESET,
      reason: "primary exhausted",
    });

    // Max recovers upstream, but the thread stays on entry 1 until the reset.
    gw.upstream.maxExhausted = false;
    gw.upstream.attempts.length = 0;
    gw.setNow(T + 10 * 60 * 1_000);
    expect((await gw.send(key, toolResult)).text).toBe('{"served":"key-token"}');
    gw.setNow(T + 30 * 60 * 1_000);
    expect((await gw.send(key, userTurn)).text).toBe('{"served":"key-token"}');
    expect(gw.upstream.attempts).toEqual(["key-token", "key-token"]);

    // After the reset, mid tool-loop still stays on the fallback...
    gw.setNow(RESET + 1);
    gw.upstream.attempts.length = 0;
    expect((await gw.send(key, toolResult)).text).toBe('{"served":"key-token"}');
    expect(gw.upstream.attempts).toEqual(["key-token"]);
    // ...and the next user turn returns to entry 0.
    expect((await gw.send(key, userTurn)).text).toBe('{"served":"max-token"}');
    expect(await gw.route("thr_loop")).toMatchObject({
      entryIndex: 0,
      stickyUntil: null,
      reason: "primary",
    });
  });

  it("moves a held primary to entry 1 and returns after the hold is cleared (P1 test hook)", async () => {
    const gw = await gateway();
    await gw.cli("chain", "set", "claude-code", gw.max.id, "claude-key:*");
    const key = await gw.token("claude-code", "thr_hold");
    const held = await gw.cli(
      "account",
      "hold",
      gw.max.id,
      "--until",
      new Date(T + 60 * 60 * 1_000).toISOString(),
    );
    expect(held.exitCode).toBe(0);
    expect((await gw.send(key, toolResult)).text).toBe('{"served":"key-token"}');
    expect(gw.upstream.attempts).toEqual(["key-token"]);
    expect(await gw.route("thr_hold")).toMatchObject({
      entryIndex: 1,
      stickyUntil: T + 60 * 60 * 1_000,
    });
    expect((await gw.send(key, userTurn)).text).toBe('{"served":"key-token"}');
    expect(
      (await gw.cli("account", "hold", gw.max.id, "--clear")).exitCode,
    ).toBe(0);
    expect((await gw.send(key, toolResult)).text).toBe('{"served":"key-token"}');
    expect((await gw.send(key, userTurn)).text).toBe('{"served":"max-token"}');
    expect((await gw.route("thr_hold")).entryIndex).toBe(0);
  });

  it("never chooses Claude OAuth for a token of another harness or a non-Messages path", async () => {
    const gw = await gateway({ withCodex: true });
    // The chain setting is rejected for every non-Claude-Code harness.
    const rejected = await gw.cli("chain", "set", "codex", "claude-oauth:*");
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toMatch(/claude-code harness/u);
    expect(
      (await gw.cli("chain", "set", "acp-omp", gw.max.id)).exitCode,
    ).toBe(1);
    await expect(
      gw.host.harness.behavior.callRpc("config.set", {
        chains: { pi: ["claude-oauth:*"] },
      }),
    ).rejects.toThrow(/claude-code harness/u);
    await gw.cli("chain", "set", "claude-code", gw.max.id);
    // A Codex token asking for Messages never reaches the Max account.
    const codexKey = await gw.token("codex", "thr_codex");
    const viaCodex = await gw.send(codexKey, userTurn);
    expect(viaCodex.status).not.toBe(200);
    // A Claude Code token on the Responses path never reaches it either.
    const claudeKey = await gw.token("claude-code", "thr_claude");
    const viaResponses = await gw.send(
      claudeKey,
      { model: "gpt-6-sol", input: "hi" },
      "/v1/responses",
    );
    expect(viaResponses.status).not.toBe(200);
    expect(gw.upstream.attempts).not.toContain("max-token");
  });

  it("rejects a token whose thread id was forged", async () => {
    const gw = await gateway();
    const key = await gw.token("claude-code", "thr_real");
    const [, mac] = key.split(".");
    const forged = `${Buffer.from(JSON.stringify(["host-one", "thr_other", "claude-code"])).toString("base64url")}.${mac}`;
    expect((await gw.send(forged, userTurn)).status).toBe(401);
    expect((await gw.send(key, userTurn)).status).toBe(200);
  });

  const fixture = (name: string) =>
    readFileSync(new URL(`./translate/fixtures/${name}`, import.meta.url));
  const captured = JSON.parse(
    fixture("claude-code-requests.json").toString(),
  ) as Record<"title" | "turn" | "toolResult" | "countTokens", { messages: unknown[] }>;
  const sse = (body: BodyInit) =>
    new Response(body, { headers: { "content-type": "text/event-stream" } });
  const events = (text: string) =>
    text
      .trim()
      .split("\n\n")
      .map((frame) => JSON.parse(frame.split("\n")[1]!.slice(6)) as {
        type: string;
        content_block?: { type: string; signature?: string };
        delta?: { type: string; signature?: string };
      });

  it("fails a Claude Code tool loop over to ChatGPT with translation, and fails back at the next user turn", async () => {
    const gw = await gateway({ withCodex: true });
    await gw.cli("chain", "set", "claude-code", "claude-oauth:*", "chatgpt-oauth:*");
    const key = await gw.token("claude-code", "thr_e2e");
    gw.upstream.reply = (who) =>
      who === "pro-token" ? sse(fixture("chatgpt-two-tools.sse").toString()) : undefined;
    const signals = () =>
      gw.host.harness.inspection.realtimeSignals.filter(
        ({ channel }) => channel === "model-gateway.route-changed",
      );

    expect((await gw.send(key, captured.turn)).status).toBe(200);
    expect(signals()).toEqual([
      { channel: "model-gateway.route-changed", payload: { threadId: "thr_e2e" } },
    ]);
    expect(
      await gw.host.harness.behavior.callRpc("thread.route", {
        threadId: "thr_e2e",
      }),
    ).toMatchObject({ upstreamKind: "claude-oauth", chainIndex: 0 });

    // S6: Max runs out in the middle of the tool loop.
    gw.upstream.maxExhausted = true;
    gw.upstream.attempts.length = 0;
    const response = await gw.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "x-claude-code-session-id": "00000000-0000-4000-8000-000000000001",
        },
        body: JSON.stringify(captured.toolResult),
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const streamed = events(await response.text());
    expect(streamed[0]?.type).toBe("message_start");
    expect(streamed.at(-1)?.type).toBe("message_stop");
    expect(
      streamed.filter(
        (event) =>
          event.type === "content_block_start" &&
          event.content_block?.type === "tool_use",
      ),
    ).toHaveLength(2);
    const signature = streamed.find(
      (event) => event.delta?.type === "signature_delta",
    )?.delta?.signature;
    expect(signature).toMatch(/^mgw1:/u);
    expect(gw.upstream.attempts).toEqual(["max-token", "pro-token"]);
    const sent = gw.upstream.requests.at(-1)!;
    expect(sent.url).toBe("https://chatgpt.test/responses");
    expect(sent.headers.get("chatgpt-account-id")).toBe("chatgpt-account");
    expect(sent.headers.get("originator")).toBe("bb");
    expect(sent.headers.get("session_id")).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(JSON.parse(sent.body)).toMatchObject({
      model: "gpt-6-sol",
      stream: true,
      store: false,
    });

    expect(await gw.route("thr_e2e")).toMatchObject({
      entryIndex: 1,
      stickyUntil: RESET,
      reason: "primary exhausted",
    });
    expect(
      await gw.host.harness.behavior.callRpc("thread.route", {
        threadId: "thr_e2e",
      }),
    ).toEqual({
      harness: "claude-code",
      upstreamKind: "chatgpt-oauth",
      accountLabel: expect.any(String),
      model: "gpt-6-sol",
      chainIndex: 1,
      chain: ["Claude Max", "ChatGPT"],
      stickyUntil: RESET,
      autoModel: null,
      auto: null,
    });
    expect(signals()).toHaveLength(2);
    expect(
      await gw.host.harness.behavior.resolveProviderEnvHealth("claude-code", {
        hostId: "host-one",
      } as never),
    ).toMatchObject({ label: "Gateway: on fallback" });

    // count_tokens while on ChatGPT: a local estimate, no upstream call.
    gw.upstream.attempts.length = 0;
    const counted = await gw.send(
      key,
      captured.countTokens,
      "/v1/messages/count_tokens",
    );
    expect(counted.status).toBe(200);
    expect(JSON.parse(counted.text)).toEqual({
      input_tokens: expect.any(Number),
    });
    expect(JSON.parse(counted.text).input_tokens).toBeGreaterThan(0);
    expect(gw.upstream.attempts).toEqual([]);

    // The hold clears; the next new user turn goes back to Anthropic, minus
    // the thinking the gateway minted from ChatGPT reasoning.
    gw.upstream.maxExhausted = false;
    gw.setNow(RESET + 1);
    const nextTurn = {
      ...captured.toolResult,
      messages: [
        ...captured.toolResult.messages,
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Checked.", signature },
            { type: "text", text: "Done." },
          ],
        },
        { role: "user", content: "thanks, now the next step" },
      ],
    };
    expect((await gw.send(key, nextTurn)).status).toBe(200);
    expect(gw.upstream.attempts).toEqual(["max-token"]);
    const back = gw.upstream.requests.at(-1)!;
    expect(back.body).not.toContain("mgw1:");
    expect(back.body).toContain("Done.");
    expect(await gw.route("thr_e2e")).toMatchObject({
      entryIndex: 0,
      reason: "primary",
    });
    expect(signals()).toHaveLength(3);
    expect(
      await gw.host.harness.behavior.resolveProviderEnvHealth("claude-code", {
        hostId: "host-one",
      } as never),
    ).toMatchObject({ label: "Gateway" });
  });

  it("answers a translation-unsupported request with a 400 and no failover", async () => {
    const gw = await gateway({ withCodex: true });
    await gw.cli("chain", "set", "claude-code", "chatgpt-oauth:*");
    const key = await gw.token("claude-code", "thr_bad");
    // BB may supply a Response from another realm. It still has the wire API.
    const json = vi.spyOn(Response, "json").mockImplementation((body, init) =>
      UndiciResponse.json(body, init as Parameters<typeof UndiciResponse.json>[1]) as unknown as Response,
    );
    try {
      const response = await gw.send(key, {
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "hi" }],
        mcp_servers: [{ url: "https://mcp.test" }],
      });
      expect(response.status).toBe(400);
      expect(JSON.parse(response.text)).toMatchObject({
        type: "error",
        error: { type: "invalid_request_error" },
      });
      expect(gw.upstream.attempts).toEqual([]);
    } finally {
      json.mockRestore();
    }
  });

  it("aborts the translated upstream fetch when the client disconnects", async () => {
    const gw = await gateway({ withCodex: true });
    await gw.cli("chain", "set", "claude-code", "chatgpt-oauth:*");
    const key = await gw.token("claude-code", "thr_abort");
    const first = fixture("chatgpt-two-tools.sse").toString().split("\n\n")[0];
    gw.upstream.reply = () =>
      sse(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`${first}\n\n`));
          },
        }),
      );
    const client = new AbortController();
    const response = await gw.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...captured.toolResult, stream: true }),
        signal: client.signal,
      },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "message_start",
    );
    const upstreamSignal = gw.upstream.requests.at(-1)!.signal!;
    expect(upstreamSignal.aborted).toBe(false);
    client.abort();
    await reader.cancel().catch(() => undefined);
    await vi.waitFor(() => expect(upstreamSignal.aborted).toBe(true));

    // Disconnect while the upstream has not answered yet.
    gw.upstream.reply = (_who, signal) =>
      new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason)),
      );
    const early = new AbortController();
    const pending = gw.host.harness.behavior
      .fetchHttp("POST", "/v1/messages", {
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(captured.toolResult),
        signal: early.signal,
      })
      .catch(() => null);
    await vi.waitFor(() => expect(gw.upstream.requests).toHaveLength(2));
    early.abort();
    await vi.waitFor(() =>
      expect(gw.upstream.requests[1]?.signal?.aborted).toBe(true),
    );
    await pending;
  });

  it("moves a pinned account on a long plain 429 to the next entry, but waits once on a short one", async () => {
    const gw = await gateway();
    await gw.cli("chain", "set", "claude-code", gw.max.id, "claude-key:*");
    const key = await gw.token("claude-code", "thr_pinned");
    // The captured Claude Code session pins the account through affinity.
    expect((await gw.send(key, captured.turn)).text).toBe(
      '{"served":"max-token"}',
    );
    let limited = 0;
    let retryAfter = "3600";
    gw.upstream.reply = (who) =>
      who === "max-token" && limited-- > 0
        ? Response.json(
            { error: "rate limited" },
            { status: 429, headers: { "retry-after": retryAfter } },
          )
        : undefined;

    limited = 1;
    gw.upstream.attempts.length = 0;
    expect((await gw.send(key, captured.toolResult)).text).toBe(
      '{"served":"key-token"}',
    );
    expect(gw.upstream.attempts).toEqual(["max-token", "key-token"]);
    expect((await gw.route("thr_pinned")).entryIndex).toBe(1);

    // Short hold on a pinned account: one wait, then the same account.
    const thread = await gw.token("claude-code", "thr_short");
    gw.setNow(T + 2 * 60 * 60 * 1_000);
    expect((await gw.send(thread, captured.turn)).text).toBe(
      '{"served":"max-token"}',
    );
    limited = 1;
    retryAfter = "0.05";
    gw.upstream.attempts.length = 0;
    expect((await gw.send(thread, captured.toolResult)).text).toBe(
      '{"served":"max-token"}',
    );
    expect(gw.upstream.attempts).toEqual(["max-token", "max-token"]);
  });

  it("answers 400 when the context exceeds every remaining model", async () => {
    const gw = await gateway({
      withCodex: true,
      config: { chains: { "claude-code": ["claude-oauth:*", "chatgpt-oauth:*"] } },
    });
    const key = await gw.token("claude-code", "thr_big");
    const big = {
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "x".repeat(1_200_000) }],
    };
    // Same protocol: Max judges its own window, so compaction still works.
    expect(await gw.send(key, big)).toEqual({
      status: 200,
      text: '{"served":"max-token"}',
    });
    gw.upstream.maxExhausted = true;
    gw.upstream.attempts.length = 0;
    const response = await gw.send(key, big);
    expect(response.status).toBe(400);
    expect(response.text).toMatch(
      /Gateway: context \(\d+ tokens\) exceeds every available fallback model\. Compact the thread\./u,
    );
    expect(gw.upstream.attempts).toEqual(["max-token"]);
  });

  it("compacts Claude Code before a configured Responses fallback fills", async () => {
    const gw = await gateway({ withCodex: true });
    const compactWindow = async () =>
      (await gw.env("claude-code", "thr_compact")).find(
        (entry) => entry.name === "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
      )?.value;
    // Leave room for the gateway's deliberately conservative local estimate,
    // which can run higher than the usage tokens Claude Code sees.
    expect(await compactWindow()).toBe("160000");
    expect((await gw.cli("chain", "set", "claude-code", "claude-oauth:*")).exitCode).toBe(0);
    expect(await compactWindow()).toBeUndefined();
  });

  it("shows and sets chains and the model map through the CLI", async () => {
    const gw = await gateway();
    const shown = await gw.cli("chain", "show");
    expect(shown.stdout).toContain("claude-code");
    expect(shown.stdout).toMatch(/0 {2}claude-oauth:\*\t/u);
    const mapped = await gw.cli(
      "model-map",
      "set",
      "chatgpt-oauth",
      "gpt-5.6-luna",
      "gpt-6-luna",
    );
    expect(mapped.exitCode).toBe(0);
    expect(
      JSON.parse((await gw.cli("model-map", "show", "--json")).stdout),
    ).toMatchObject({
      "chatgpt-oauth": {
        "claude-opus-*": "gpt-6-sol",
        "gpt-5.6-luna": "gpt-6-luna",
      },
    });
    expect((await gw.cli("status", "--thread", "thr_none")).exitCode).toBe(1);
  });

  const MOUNT = "/api/v1/plugins/model-gateway/http";
  const completed = (id: string) =>
    sse(
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { id, output: [] },
      })}\n\n`,
    );
  const valueOf = async (
    entries: Promise<Array<{ name: string; value: unknown }>>,
    name: string,
  ) => (await entries).find((entry) => entry.name === name)?.value;

  it("routes omp through gw- models on ChatGPT, fitted to the Codex backend (S1)", async () => {
    const gw = await gateway({ withCodex: true });
    const entries = await gw.env("acp-omp", "thr_omp");
    expect(entries.map(({ name }) => name)).toEqual(["MODEL_GATEWAY_TOKEN"]);
    const key = entries[0]!.value as string;

    // omp discovery (openai-models-list) gets gw- ids and never hits ChatGPT.
    const models = await gw.host.harness.behavior.fetchHttp("GET", "/v1/models", {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(await models.json()).toEqual({
      object: "list",
      data: ["gw-gpt-6-astra", "gw-gpt-6-sol", "gw-gpt-5.6-terra", "gw-gpt-6-luna"].map((id) => ({
        id,
        object: "model",
        owned_by: "model-gateway",
      })),
    });
    expect(gw.upstream.attempts).toEqual([]);

    gw.upstream.reply = () => completed("resp_omp");
    const tool = { type: "function", name: "bash", parameters: {} };
    const sent = await gw.send(
      key,
      {
        model: "gw-gpt-6-astra",
        instructions: "be brief",
        input: [{ role: "user", content: "hi" }],
        tools: [tool],
        max_output_tokens: 32_000,
        temperature: 1,
        store: false,
        stream: true,
      },
      "/v1/responses",
    );
    expect(sent.status).toBe(200);
    const upstream = gw.upstream.requests.at(-1)!;
    expect(upstream.url).toBe("https://chatgpt.test/responses");
    expect(upstream.who).toBe("pro-token");
    expect(upstream.headers.get("chatgpt-account-id")).toBe("chatgpt-account");
    expect(JSON.parse(upstream.body)).toEqual({
      model: "gpt-6-astra",
      instructions: "be brief",
      input: [{ role: "user", content: "hi" }],
      tools: [tool],
      store: false,
      stream: true,
    });
    expect(await gw.route("thr_omp")).toMatchObject({
      entryIndex: 0,
      model: "gpt-6-astra",
    });
  });

  it("authenticates FX by its query token and never forwards FX's own ChatGPT login (S2)", async () => {
    const gw = await gateway({ withCodex: true });
    const entries = gw.env("acp-fx", "thr_fx");
    const responsesUrl = (await valueOf(
      entries,
      "FX_E2E_OPENAI_CODEX_RESPONSES_URL",
    )) as { serverPath: string };
    const modelsUrl = (await valueOf(entries, "FX_E2E_OPENAI_CODEX_MODELS_URL")) as {
      serverPath: string;
    };
    expect(responsesUrl.serverPath).toMatch(
      /^\/api\/v1\/plugins\/model-gateway\/http\/v1\/responses\?gateway_token=[\w-]+\.[\w-]+$/u,
    );
    expect(modelsUrl.serverPath).toMatch(
      /^\/api\/v1\/plugins\/model-gateway\/http\/v1\/models\?gateway_token=/u,
    );
    const fxHeaders = {
      authorization: "Bearer fx-own-chatgpt-token",
      "chatgpt-account-id": "fx-own-account",
      originator: "fx_cli",
      "openai-beta": "responses=experimental",
      "session-id": "fx-session",
      "content-type": "application/json",
    };
    const fetchHttp = gw.host.harness.behavior.fetchHttp;
    gw.upstream.reply = () => completed("resp_fx");
    // FX's title call on its fixed small model, as captured in S2.
    const title = await fetchHttp(
      "POST",
      `${responsesUrl.serverPath.slice(MOUNT.length)}&probe=s2`,
      {
        headers: fxHeaders,
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          input: [{ role: "user", content: "title this" }],
          stream: true,
        }),
      },
    );
    expect(title.status).toBe(200);
    await title.text();
    const turn = gw.upstream.requests.at(-1)!;
    expect(turn.url).toBe("https://chatgpt.test/responses?probe=s2");
    expect(turn.headers.get("authorization")).toBe("Bearer pro-token");
    expect(turn.headers.get("chatgpt-account-id")).toBe("chatgpt-account");
    expect(turn.headers.get("originator")).toBe("bb");
    expect(turn.headers.get("session-id")).toBe("fx-session");
    expect(JSON.parse(turn.body).model).toBe("gpt-5.6-luna");

    gw.upstream.reply = () => Response.json({ models: [{ slug: "gpt-6-sol" }] });
    const models = await fetchHttp(
      "GET",
      `${modelsUrl.serverPath.slice(MOUNT.length)}&client_version=0.157.0`,
      { headers: fxHeaders },
    );
    expect(await models.json()).toEqual({ models: [{ slug: "gpt-6-sol" }] });
    expect(gw.upstream.requests.at(-1)!.url).toBe(
      "https://chatgpt.test/models?client_version=0.157.0",
    );

    for (const request of gw.upstream.requests) {
      expect(request.url).not.toContain("gateway_token");
      for (const [, value] of request.headers)
        expect(value).not.toMatch(/fx-own-|fx_cli/u);
    }
    // FX's own bearer is not a hub token.
    const bare = await fetchHttp("POST", "/v1/responses", {
      headers: fxHeaders,
      body: JSON.stringify({ model: "gpt-6-sol", input: "hi" }),
    });
    expect(bare.status).toBe(401);
  });

  it("serves nanocodex over the WebSocket route with additional_tools intact, and asks for a key upstream for key-only models (S3)", async () => {
    const gw = await gateway({ withCodex: true });
    const entries = await gw.env("acp-nanocodex", "thr_nano");
    expect(entries.map(({ name, value }) => [name, value])).toEqual([
      ["NANOCODEX_API_BASE_URL", { serverPath: `${MOUNT}/v1` }],
      ["MODEL_GATEWAY_TOKEN", expect.any(String)],
    ]);
    const key = entries[1]!.value as string;
    gw.upstream.reply = () => completed("resp_nano");
    const socket = await gw.host.harness.behavior.experimental_openWebSocket(
      "/v1/responses",
      {
        headers: {
          authorization: `Bearer ${key}`,
          "openai-beta": "responses_websockets=2026-02-06",
        },
      },
    );
    const additionalTools = {
      type: "additional_tools",
      tools: [{ type: "function", name: "exec_command", parameters: {} }],
    };
    const user = { role: "user", content: [{ type: "input_text", text: "hi" }] };
    await socket.receive(
      JSON.stringify({
        type: "response.create",
        model: "gpt-6-sol",
        input: [additionalTools, user],
      }),
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(JSON.parse(socket.sent[0] as string)).toMatchObject({
      type: "response.completed",
      response: { id: "resp_nano" },
    });
    const upstream = gw.upstream.requests.at(-1)!;
    expect(upstream.who).toBe("pro-token");
    expect(JSON.parse(upstream.body)).toMatchObject({
      model: "gpt-6-sol",
      input: [additionalTools, user],
    });

    const before = gw.upstream.requests.length;
    await socket.receive(
      JSON.stringify({ type: "response.create", model: "kimi-k3", input: [user] }),
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(JSON.parse(socket.sent[1] as string)).toMatchObject({
      type: "response.failed",
      response: { error: { message: expect.stringMatching(/kimi-k3 needs an API-key upstream.*bb gateway key add/u) } },
    });
    expect(gw.upstream.requests).toHaveLength(before);
  });

  it("accepts Codex's x-bb-account-pool-token over HTTP and WebSocket", async () => {
    const gw = await gateway({ withCodex: true });
    const key = await gw.token("codex", "thr_codex_header");
    gw.upstream.reply = () => completed("resp_codex");
    const headers = {
      "x-bb-account-pool-token": key,
      authorization: "Bearer codex-own-login",
      "content-type": "application/json",
    };
    const http = await gw.host.harness.behavior.fetchHttp("POST", "/v1/responses", {
      headers,
      body: JSON.stringify({ model: "gpt-6-sol", input: "hi" }),
    });
    expect(http.status).toBe(200);
    await http.text();
    const socket = await gw.host.harness.behavior.experimental_openWebSocket(
      "/v1/responses",
      { headers },
    );
    await socket.receive(
      JSON.stringify({ type: "response.create", model: "gpt-6-sol", input: [] }),
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(socket.closeCalls).toEqual([]);
    expect(gw.upstream.attempts).toEqual(["pro-token", "pro-token"]);
  });

  it("never serves omp, FX or nanocodex from Claude OAuth, even with a stored illegal chain", async () => {
    const illegal = ["claude-oauth:*", "chatgpt-oauth:*"];
    const gw = await gateway({
      withCodex: true,
      config: {
        chains: { "acp-omp": illegal, "acp-fx": illegal, "acp-nanocodex": illegal },
      },
    });
    for (const harness of ["acp-omp", "acp-fx", "acp-nanocodex"]) {
      const rejected = await gw.cli("chain", "set", harness, "claude-oauth:*");
      expect(rejected.exitCode).toBe(1);
      expect(rejected.stderr).toMatch(/claude-code harness/u);
    }
    const tokens = {
      "acp-omp": (await valueOf(gw.env("acp-omp", "thr_l1"), "MODEL_GATEWAY_TOKEN")) as string,
      "acp-nanocodex": (await valueOf(
        gw.env("acp-nanocodex", "thr_l2"),
        "MODEL_GATEWAY_TOKEN",
      )) as string,
      "acp-fx": new URLSearchParams(
        (
          (await valueOf(gw.env("acp-fx", "thr_l3"), "FX_E2E_OPENAI_CODEX_RESPONSES_URL")) as {
            serverPath: string;
          }
        ).serverPath.split("?")[1],
      ).get("gateway_token")!,
    };
    gw.upstream.reply = (who) =>
      who === "pro-token" ? completed("resp_legal") : undefined;
    for (const token of Object.values(tokens)) {
      const responses = await gw.send(
        token,
        { model: "gpt-6-sol", input: "hi" },
        "/v1/responses",
      );
      expect(responses.status).toBe(200);
      await gw.send(token, userTurn);
    }
    expect(gw.upstream.attempts).not.toContain("max-token");
    expect(gw.upstream.attempts.length).toBeGreaterThan(0);
  });

  it("contributes env and health per ACP harness, off with routing --off or without a ChatGPT account", async () => {
    const withoutCodex = await gateway();
    for (const harness of ["acp-omp", "acp-fx", "acp-nanocodex"]) {
      expect(await withoutCodex.env(harness, "thr_none")).toEqual([]);
      expect(
        await withoutCodex.host.harness.behavior.resolveProviderEnvHealth(harness, {
          hostId: "host-one",
        }),
      ).toBeNull();
    }
    const gw = await gateway({ withCodex: true });
    for (const harness of ["acp-omp", "acp-fx", "acp-nanocodex"]) {
      expect(
        await gw.host.harness.behavior.resolveProviderEnvHealth(harness, {
          hostId: "host-one",
        }),
      ).toMatchObject({ label: "Gateway" });
      expect((await gw.cli("routing", harness, "--off")).exitCode).toBe(0);
      expect(await gw.env(harness, "thr_off")).toEqual([]);
      expect(
        await gw.host.harness.behavior.resolveProviderEnvHealth(harness, {
          hostId: "host-one",
        }),
      ).toBeNull();
    }
  });

  it("prints and writes the setup for omp, FX and nanocodex", async () => {
    const gw = await gateway();
    const printed = await gw.cli("setup", "omp", "--print");
    expect(printed.stdout).toContain(
      "baseUrl: http://127.0.0.1:38886/api/v1/plugins/model-gateway/http/v1",
    );
    const home = await mkdtemp(path.join(tmpdir(), "mgw-setup-home-"));
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      const file = path.join(home, ".omp", "agent", "models.yml");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "providers:\n  mine:\n    api: openai-responses\n");
      const written = await gw.cli(
        "setup",
        "omp",
        "--server-url",
        "http://127.0.0.1:40000",
      );
      expect(written.exitCode).toBe(0);
      expect(written.stdout).toContain(`Backup: ${file}.bak-`);
      const text = await fs.readFile(file, "utf8");
      expect(text).toContain(
        "  model-gateway:\n    baseUrl: http://127.0.0.1:40000/api/v1/plugins/model-gateway/http/v1\n",
      );
      expect(text).toContain("  mine:\n    api: openai-responses\n");
    } finally {
      process.env.HOME = previous;
      await fs.rm(home, { recursive: true, force: true });
    }
    const fx = await gw.cli("setup", "fx");
    expect(fx.stdout).toContain("./oh-my-bb/agents/fx-acp");
    expect(fx.stdout).toContain("npm install --global ./fx-acp-0.1.0.tgz");
    expect(fx.stdout).toContain("require FX or fx-acp");
    expect(fx.stdout).toContain("fx login codex");
    const nano = await gw.cli("setup", "nanocodex");
    expect(nano.stdout).toContain('"command": "nanocodex-acp"');
    expect(nano.stdout).toContain("./oh-my-bb/agents/nanocodex-acp");
    expect(nano.stdout).toContain("npm install --global ./nanocodex-acp-0.1.0.tgz");
    expect(nano.stdout).toContain("does not install or require nanocodex");
  });

  // P4: API-key upstreams, Responses -> Messages translation, Pi.
  const KIMI = "https://kimi.test/anthropic";
  const OPENROUTER = "https://openrouter.test/api/v1";
  const addKey = (
    gw: Awaited<ReturnType<typeof gateway>>,
    kind: string,
    label: string,
    baseUrl: string | null,
    apiKey: string,
  ) =>
    gw.cli(
      "key",
      "add",
      kind,
      "--label",
      label,
      ...(baseUrl === null ? [] : ["--base-url", baseUrl]),
      // What the bb CLI turns `--key-stdin` into.
      "--key",
      apiKey,
    );
  const chatgptExhausted = () =>
    new Response("{}", {
      status: 429,
      headers: { "x-codex-primary-used-percent": "100" },
    });
  const anthropicTwoTools = () => sse(fixture("anthropic-two-tools.sse").toString());
  const responsesEvents = (text: string) =>
    text
      .trim()
      .split("\n\n")
      .map((frame) => JSON.parse(frame.split("\n")[1]!.slice(6)) as Record<string, any>);
  const codexBody = (input: unknown[]) => ({
    model: "gpt-6-sol",
    instructions: "You are Codex.",
    input,
    tools: [
      { type: "function", name: "shell", parameters: { type: "object", properties: { command: { type: "array" } } } },
      { type: "custom", name: "apply_patch", description: "Apply a patch." },
    ],
    reasoning: { effort: "medium" },
    include: ["reasoning.encrypted_content"],
    store: false,
    stream: true,
  });
  const codexUser = { type: "message", role: "user", content: [{ type: "input_text", text: "List the files, then patch the README." }] };

  it("adds API keys from stdin only and never prints, returns or logs them", async () => {
    const gw = await gateway();
    const added = await addKey(gw, "anthropic-compatible-key", "kimi", KIMI, "sk-kimi-secret");
    expect(added.exitCode).toBe(0);
    expect(added.stdout).toContain("Added anthropic-compatible-key:kimi");
    expect(added.stdout).toContain("API keys bill per token.");
    const raw = await gw.cli("key", "add", "responses-compatible-key", "--label", "or", "--base-url", OPENROUTER, "--key-stdin");
    expect(raw).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("--key-stdin") });
    for (const [kind, label, baseUrl, message] of [
      ["anthropic-compatible-key", "glm", null, /need one/u],
      ["claude-key", "direct", KIMI, /claude-key takes no --base-url/u],
      ["anthropic-compatible-key", "kimi", KIMI, /already exists/u],
      ["anthropic-compatible-key", "bad label", KIMI, /Labels use/u],
      ["claude-oauth", "max", null, /kind/u],
    ] as const) {
      const rejected = await addKey(gw, kind, label, baseUrl, "sk-kimi-secret");
      expect(rejected.exitCode).toBe(1);
      expect(rejected.stderr).toMatch(message);
      expect(rejected.stderr).not.toContain("sk-kimi-secret");
    }
    await gw.cli("chain", "set", "claude-code", "anthropic-compatible-key:kimi");
    gw.upstream.reply = () => Response.json({ served: true });
    await gw.send(await gw.token("claude-code", "thr_keylog"), userTurn);
    expect(gw.upstream.attempts).toEqual(["sk-kimi-secret"]);
    const outputs = [
      (await gw.cli("account", "list")).stdout,
      (await gw.cli("account", "list", "--json")).stdout,
      (await gw.cli("status", "--json")).stdout,
      (await gw.cli("chain", "show")).stdout,
      JSON.stringify(await gw.host.harness.behavior.callRpc("account.list", null)),
      JSON.stringify(await gw.host.harness.behavior.callRpc("status.get", null)),
      JSON.stringify(gw.host.harness.inspection.logEntries),
    ];
    for (const output of outputs) expect(output).not.toContain("sk-kimi-secret");
    expect(outputs[0]).toContain(`anthropic-compatible-key ${KIMI}`);
    expect(outputs[3]).toContain("anthropic-compatible-key:kimi\tkimi");
  });

  it("fails Claude Code over from Max to an Anthropic-compatible key without translation", async () => {
    const gw = await gateway();
    await addKey(gw, "anthropic-compatible-key", "kimi", KIMI, "sk-kimi");
    expect((await gw.cli("chain", "set", "claude-code", "claude-oauth:*", "anthropic-compatible-key:kimi")).exitCode).toBe(0);
    expect((await gw.cli("model-map", "set", "anthropic-compatible-key:kimi", "claude-opus-*", "kimi-k3")).exitCode).toBe(0);
    const key = await gw.token("claude-code", "thr_kimi");
    gw.upstream.maxExhausted = true;
    const served = await gw.send(key, toolResult, "/v1/messages", { "anthropic-beta": "context-1m-2025-08-07" });
    expect(served).toEqual({ status: 200, text: '{"served":"sk-kimi"}' });
    expect(gw.upstream.attempts).toEqual(["max-token", "sk-kimi"]);
    const upstream = gw.upstream.requests.at(-1)!;
    expect(upstream.url).toBe(`${KIMI}/v1/messages`);
    expect(upstream.headers.get("authorization")).toBe("Bearer sk-kimi");
    expect(upstream.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(upstream.headers.get("anthropic-beta")).toBe("context-1m-2025-08-07");
    expect(JSON.parse(upstream.body)).toEqual({ ...toolResult, model: "kimi-k3" });
    expect(await gw.route("thr_kimi")).toMatchObject({ entryIndex: 1, model: "kimi-k3", reason: "primary exhausted" });
    // While bound to the key, count_tokens is answered locally.
    const before = gw.upstream.attempts.length;
    const counted = await gw.send(key, toolResult, "/v1/messages/count_tokens");
    expect(JSON.parse(counted.text)).toEqual({ input_tokens: expect.any(Number) });
    expect(gw.upstream.attempts).toHaveLength(before);
  });

  it("fails Codex over from ChatGPT to a Responses-compatible key, keeping sampling fields", async () => {
    const gw = await gateway({ withCodex: true });
    await addKey(gw, "responses-compatible-key", "openrouter", OPENROUTER, "sk-or");
    await gw.cli("chain", "set", "codex", "chatgpt-oauth:*", "responses-compatible-key:openrouter");
    await gw.cli("chain", "set", "acp-omp", "responses-compatible-key:openrouter");
    await gw.cli("model-map", "set", "responses-compatible-key", "gpt-6-*", "openai/gpt-6");
    gw.upstream.reply = (who) => (who === "pro-token" ? chatgptExhausted() : completed(`resp_${who}`));
    const body = { model: "gpt-6-sol", input: [{ role: "user", content: "hi" }], max_output_tokens: 1_000, temperature: 0.5, stream: true };
    const served = await gw.send(await gw.token("codex", "thr_or"), body, "/v1/responses");
    expect(served.status).toBe(200);
    expect(gw.upstream.attempts).toEqual(["pro-token", "sk-or"]);
    const upstream = gw.upstream.requests.at(-1)!;
    expect(upstream.url).toBe(`${OPENROUTER}/responses`);
    expect(upstream.headers.get("chatgpt-account-id")).toBeNull();
    expect(JSON.parse(upstream.body)).toEqual({ ...body, model: "openai/gpt-6" });
    expect(await gw.route("thr_or")).toMatchObject({ entryIndex: 1, model: "openai/gpt-6" });
    // omp's gw- ids reach a key with the ChatGPT-only field stripping off.
    const omp = (await valueOf(gw.env("acp-omp", "thr_omp_or"), "MODEL_GATEWAY_TOKEN")) as string;
    await gw.send(omp, { ...body, model: "gw-gpt-6-astra" }, "/v1/responses");
    expect(JSON.parse(gw.upstream.requests.at(-1)!.body)).toEqual({ ...body, model: "openai/gpt-6" });
  });

  it("serves Codex from an Anthropic-compatible key with Responses <-> Messages translation", async () => {
    const gw = await gateway({ withCodex: true });
    await addKey(gw, "anthropic-compatible-key", "kimi", KIMI, "sk-kimi");
    await gw.cli("chain", "set", "codex", "chatgpt-oauth:*", "anthropic-compatible-key:kimi");
    await gw.cli("model-map", "set", "anthropic-compatible-key:kimi", "gpt-6-*", "kimi-k3");
    gw.upstream.reply = (who) => (who === "pro-token" ? chatgptExhausted() : anthropicTwoTools());
    const key = await gw.token("codex", "thr_codex_kimi");
    const first = await gw.send(key, codexBody([codexUser]), "/v1/responses");
    expect(first.status).toBe(200);
    const events = responsesEvents(first.text);
    const completedEvent = events.at(-1)!;
    expect(completedEvent).toMatchObject({ type: "response.completed", response: { model: "gpt-6-sol", status: "completed" } });
    const output = completedEvent.response.output as Array<Record<string, any>>;
    expect(output.map((item) => item.type)).toEqual(["reasoning", "message", "function_call", "custom_tool_call"]);
    expect(output[2]).toMatchObject({ call_id: "toolu_syn_shell", name: "shell", arguments: '{"command":["ls","-la"]}' });
    const upstream = gw.upstream.requests.at(-1)!;
    expect(upstream.who).toBe("sk-kimi");
    expect(upstream.url).toBe(`${KIMI}/v1/messages`);
    expect([...upstream.headers.values()].join(" ")).not.toContain(key);
    expect(JSON.parse(upstream.body)).toMatchObject({
      model: "kimi-k3",
      system: "You are Codex.",
      stream: true,
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: [{ type: "text", text: "List the files, then patch the README." }] }],
      tools: [{ name: "shell" }, { name: "apply_patch", input_schema: { properties: { input: { type: "string" } } } }],
    });
    expect(await gw.route("thr_codex_kimi")).toMatchObject({ entryIndex: 1, model: "kimi-k3" });

    // The tool loop continues on the key; Kimi's own thinking replays, results pair up.
    const second = await gw.send(
      key,
      codexBody([
        codexUser,
        ...output,
        { type: "function_call_output", call_id: "toolu_syn_shell", output: "README.md" },
        { type: "custom_tool_call_output", call_id: "toolu_syn_patch", output: "Done!" },
      ]),
      "/v1/responses",
    );
    expect(second.status).toBe(200);
    expect(gw.upstream.attempts.at(-1)).toBe("sk-kimi");
    const messages = JSON.parse(gw.upstream.requests.at(-1)!.body).messages;
    expect(messages[1].content.map((block: { type: string }) => block.type)).toEqual(["thinking", "text", "tool_use", "tool_use"]);
    expect(messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_syn_shell", content: "README.md" },
      { type: "tool_result", tool_use_id: "toolu_syn_patch", content: "Done!" },
    ]);
  });

  it("serves nanocodex kimi-k3 over the WebSocket route from an Anthropic-compatible key, with additional_tools", async () => {
    const gw = await gateway({ withCodex: true });
    await addKey(gw, "anthropic-compatible-key", "kimi", KIMI, "sk-kimi");
    await gw.cli("chain", "set", "acp-nanocodex", "chatgpt-oauth:*", "anthropic-compatible-key:kimi");
    gw.upstream.reply = () => anthropicTwoTools();
    const token = (await valueOf(gw.env("acp-nanocodex", "thr_nano_kimi"), "MODEL_GATEWAY_TOKEN")) as string;
    const socket = await gw.host.harness.behavior.experimental_openWebSocket("/v1/responses", {
      headers: { authorization: `Bearer ${token}` },
    });
    const additionalTools = {
      type: "additional_tools",
      tools: [
        { type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
        { type: "function", name: "write_stdin", parameters: { type: "object", properties: {} } },
      ],
    };
    const frames = () => socket.sent.map((frame) => JSON.parse(frame as string) as Record<string, any>);
    await socket.receive(JSON.stringify({ type: "response.create", model: "kimi-k3", input: [additionalTools, codexUser] }));
    await vi.waitFor(() => expect(frames().at(-1)?.type).toBe("response.completed"));
    // kimi-k3 skips the ChatGPT entry and passes through unmapped.
    expect(gw.upstream.attempts).toEqual(["sk-kimi"]);
    const upstream = JSON.parse(gw.upstream.requests.at(-1)!.body);
    expect(upstream).toMatchObject({ model: "kimi-k3", stream: true });
    expect(upstream.tools.map((tool: { name: string }) => tool.name)).toEqual(["exec_command", "write_stdin"]);
    const firstId = frames().at(-1)!.response.id as string;

    // previous_response_id: the WS route replays the translated output, thinking included.
    const count = socket.sent.length;
    await socket.receive(
      JSON.stringify({
        type: "response.create",
        model: "kimi-k3",
        previous_response_id: firstId,
        input: [{ type: "function_call_output", call_id: "toolu_syn_shell", output: "README.md" }],
      }),
    );
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(count + 1));
    await vi.waitFor(() => expect(frames().at(-1)?.type).toBe("response.completed"));
    const replayed = JSON.parse(gw.upstream.requests.at(-1)!.body).messages;
    expect(replayed[1].content[0]).toMatchObject({ type: "thinking", signature: "c3ludGhldGljLXNpZ25hdHVyZS0x" });
    expect(replayed[2].content[0]).toEqual({ type: "tool_result", tool_use_id: "toolu_syn_shell", content: "README.md" });
  });

  it("benches a key that is out of credit and moves on; plain 429s stay plain holds", async () => {
    const gw = await gateway();
    await addKey(gw, "anthropic-compatible-key", "kimi", KIMI, "sk-kimi");
    await gw.cli("chain", "set", "claude-code", "anthropic-compatible-key:kimi", "claude-key:*");
    let kimi: () => Response = () =>
      Response.json({ error: { type: "exceeded_current_quota_error", message: "Your account is suspended due to insufficient balance" } }, { status: 429 });
    gw.upstream.reply = (who) => (who === "sk-kimi" ? kimi() : undefined);
    const key = await gw.token("claude-code", "thr_credit");
    expect(await gw.send(key, userTurn)).toEqual({ status: 200, text: '{"served":"key-token"}' });
    expect(gw.upstream.attempts).toEqual(["sk-kimi", "key-token"]);
    const accounts = JSON.parse((await gw.cli("account", "list", "--json")).stdout).accounts as Array<{ label: string; heldUntil: number | null }>;
    expect(accounts.find(({ label }) => label === "kimi")?.heldUntil).toBe(T + 30 * 60 * 1_000);
    expect(await gw.route("thr_credit")).toMatchObject({ entryIndex: 1, stickyUntil: T + 30 * 60 * 1_000 });
    gw.upstream.attempts.length = 0;
    await gw.send(key, userTurn);
    expect(gw.upstream.attempts).toEqual(["key-token"]);

    // 402 benches too; a plain 429 is a short hold, not a bench.
    gw.setNow(T + 31 * 60 * 1_000);
    kimi = () => new Response("payment required", { status: 402 });
    gw.upstream.attempts.length = 0;
    await gw.send(key, userTurn);
    expect(gw.upstream.attempts).toEqual(["sk-kimi", "key-token"]);
    gw.setNow(T + 62 * 60 * 1_000);
    kimi = () => Response.json({ error: { type: "rate_limit_error", message: "slow down" } }, { status: 429, headers: { "retry-after": "600" } });
    await gw.send(key, userTurn);
    const held = JSON.parse((await gw.cli("account", "list", "--json")).stdout).accounts as Array<{ label: string; heldUntil: number | null }>;
    expect(held.find(({ label }) => label === "kimi")?.heldUntil).toBe(T + 62 * 60 * 1_000 + 600_000);
  });

  it("drops the gateway's Anthropic thinking from a Responses body before ChatGPT", async () => {
    const gw = await gateway({ withCodex: true });
    gw.upstream.reply = () => completed("resp_back");
    const minted = {
      type: "reasoning",
      id: "rs_gw",
      summary: [],
      encrypted_content: `mgwa1:${Buffer.from(JSON.stringify({ model: "kimi-k3", thinking: "t", signature: "s" })).toString("base64")}`,
    };
    const chatgpt = { type: "reasoning", id: "rs_native", summary: [], encrypted_content: "gAAAA-native" };
    const body = { model: "gpt-6-sol", input: [codexUser, minted, chatgpt], stream: true };
    expect((await gw.send(await gw.token("codex", "thr_back"), body, "/v1/responses")).status).toBe(200);
    expect(JSON.parse(gw.upstream.requests.at(-1)!.body).input).toEqual([codexUser, chatgpt]);
  });

  // P5 part A: thinking and reasoning go back only to the upstream that minted them.
  it("replays a key's thinking only to that key: Max -> Kimi mid-loop -> Max at the next user turn", async () => {
    const gw = await gateway();
    await addKey(gw, "anthropic-compatible-key", "kimi", KIMI, "sk-kimi");
    await gw.cli("chain", "set", "claude-code", "claude-oauth:*", "anthropic-compatible-key:kimi");
    const key = await gw.token("claude-code", "thr_kimi_back");
    gw.upstream.reply = (who) => (who === "sk-kimi" ? anthropicTwoTools() : undefined);
    const kimiSignature = "c3ludGhldGljLXNpZ25hdHVyZS0x";
    const loop = {
      model: "claude-opus-4-7",
      stream: true,
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Max thought.", signature: "max-sig" },
            { type: "tool_use", id: "t1", name: "Bash", input: {} },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
    };
    gw.upstream.maxExhausted = true;
    const served = await gw.send(key, loop);
    expect(served.status).toBe(200);
    expect(gw.upstream.attempts).toEqual(["max-token", "sk-kimi"]);
    const toKimi = JSON.parse(gw.upstream.requests.at(-1)!.body);
    expect(toKimi.messages[1].content.map((block: { type: string }) => block.type)).toEqual(["tool_use"]);
    // Kimi's signature reaches Claude Code only inside the gateway envelope.
    const streamed = events(served.text);
    expect(streamed.find((event) => event.content_block?.type === "thinking")?.content_block?.signature).toMatch(/^mgwk1:/u);
    const signature = streamed.find((event) => event.delta?.type === "signature_delta")?.delta?.signature;
    expect(signature).toMatch(/^mgwk1:/u);
    expect(served.text).not.toContain(kimiSignature);

    // The tool loop stays on Kimi, which gets its own signature back unwrapped.
    const next = {
      ...loop,
      messages: [
        ...loop.messages,
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Kimi thought.", signature },
            { type: "tool_use", id: "t2", name: "Bash", input: {} },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] },
      ],
    };
    gw.upstream.maxExhausted = false;
    await gw.send(key, next);
    expect(gw.upstream.attempts.at(-1)).toBe("sk-kimi");
    expect(JSON.parse(gw.upstream.requests.at(-1)!.body).messages[3].content[0]).toEqual({
      type: "thinking",
      thinking: "Kimi thought.",
      signature: kimiSignature,
    });

    // Max resets: the next user turn goes back with Max's thinking and none of Kimi's.
    gw.setNow(RESET + 1);
    await gw.send(key, {
      ...next,
      messages: [
        ...next.messages,
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
        { role: "user", content: "next step" },
      ],
    });
    expect(gw.upstream.attempts.at(-1)).toBe("max-token");
    const back = gw.upstream.requests.at(-1)!.body;
    expect(back).toContain("max-sig");
    expect(back).not.toContain("mgwk1:");
    expect(back).not.toContain(kimiSignature);
    expect(back).not.toContain("Kimi thought.");
  });

  it("replays a Responses key's reasoning only to that key: ChatGPT -> OpenRouter mid-loop -> ChatGPT at the next user turn", async () => {
    const gw = await gateway({ withCodex: true });
    await addKey(gw, "responses-compatible-key", "openrouter", OPENROUTER, "sk-or");
    await gw.cli("chain", "set", "codex", "chatgpt-oauth:*", "responses-compatible-key:openrouter");
    const orReasoning = { type: "reasoning", id: "rs_or", summary: [], encrypted_content: "or-encrypted" };
    let chatgptOut = true;
    gw.upstream.reply = (who) =>
      who === "pro-token"
        ? chatgptOut
          ? new Response("{}", {
              status: 429,
              headers: {
                "x-codex-primary-used-percent": "100",
                "x-codex-primary-reset-at": String(RESET / 1_000),
              },
            })
          : completed("resp_back")
        : sse(
            [
              { type: "response.output_item.done", output_index: 0, item: orReasoning },
              { type: "response.completed", response: { id: "resp_or", output: [orReasoning] } },
            ]
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
          );
    const key = await gw.token("codex", "thr_or_back");
    const native = { type: "reasoning", id: "rs_native", summary: [], encrypted_content: "gAAAA-native" };
    const call = (id: string) => [
      { type: "function_call", call_id: id, name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: id, output: "ok" },
    ];
    const loop = codexBody([codexUser, native, ...call("c1")]);
    const served = await gw.send(key, loop, "/v1/responses");
    expect(gw.upstream.attempts).toEqual(["pro-token", "sk-or"]);
    expect(gw.upstream.requests.at(-1)!.body).not.toContain("gAAAA-native");
    expect(served.text).not.toContain("or-encrypted");
    const done = responsesEvents(served.text)[0]!.item as Record<string, unknown>;
    expect(done.encrypted_content).toMatch(/^mgwk1:/u);
    expect(responsesEvents(served.text)[1]!.response.output[0].encrypted_content).toBe(done.encrypted_content);

    // The tool loop stays on OpenRouter, which gets its own reasoning back unwrapped.
    chatgptOut = false;
    const next = codexBody([...loop.input, done, ...call("c2")]);
    await gw.send(key, next, "/v1/responses");
    expect(gw.upstream.attempts.at(-1)).toBe("sk-or");
    const toOpenRouter = JSON.parse(gw.upstream.requests.at(-1)!.body).input as Array<{ type: string }>;
    expect(toOpenRouter.filter((item) => item.type === "reasoning")).toEqual([orReasoning]);

    // ChatGPT resets: the next user turn goes back with ChatGPT's reasoning and none of OpenRouter's.
    gw.setNow(RESET + 1);
    const assistant = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] };
    await gw.send(key, codexBody([...next.input, assistant, codexUser]), "/v1/responses");
    expect(gw.upstream.attempts.at(-1)).toBe("pro-token");
    const back = JSON.parse(gw.upstream.requests.at(-1)!.body).input as Array<{ type: string }>;
    expect(back.filter((item) => item.type === "reasoning")).toEqual([native]);
    expect(JSON.stringify(back)).not.toMatch(/mgwk1:|or-encrypted/u);
  });

  it("logs once per thread what a Messages key cannot take, with no body content", async () => {
    const gw = await gateway({ withCodex: true });
    await addKey(gw, "anthropic-compatible-key", "kimi", KIMI, "sk-kimi");
    await gw.cli("chain", "set", "codex", "anthropic-compatible-key:kimi");
    await gw.cli("model-map", "set", "anthropic-compatible-key:kimi", "gpt-6-*", "kimi-k3");
    gw.upstream.reply = () => anthropicTwoTools();
    const key = await gw.token("codex", "thr_dropped");
    const base = codexBody([{ type: "compaction", encrypted_content: "secret-summary" }, codexUser]);
    const body = { ...base, tools: [...base.tools, { type: "web_search" }] };
    expect((await gw.send(key, body, "/v1/responses")).status).toBe(200);
    expect((await gw.send(key, body, "/v1/responses")).status).toBe(200);
    const logs = JSON.stringify(gw.host.harness.inspection.logEntries);
    expect(logs.match(/left out/gu)).toHaveLength(1);
    expect(logs).toContain("left out tool:web_search, item:compaction for thread thr_dropped");
    expect(logs).not.toMatch(/secret-summary|List the files/u);
  });

  // P5 WP5.1: Jev picks the model per user turn, through a fake OpenRouter endpoint.
  const jevAnswer = (choice: string, confidence: number) =>
    Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify({ choice, confidence }) } }] });
  const isJev = (url: string) => url === `${OPENROUTER}/chat/completions`;

  it("asks Jev at each new user turn, keeps the pick through the tool loop, and fails open", async () => {
    const gw = await gateway({ withCodex: true });
    await addKey(gw, "responses-compatible-key", "openrouter", OPENROUTER, "sk-or");
    expect(await gw.cli("auto", "codex")).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("Jev needs an OpenRouter key") });
    const enabled = await gw.cli("auto", "codex", "--key", "openrouter");
    expect(enabled.stdout).toContain("Auto (Jev): codex");
    expect(enabled.stdout).toContain("only the truncated last user message and the candidate model names");
    let jev: (signal: AbortSignal | null) => Response | Promise<Response> = () => jevAnswer("gpt-6-luna", 0.9);
    gw.upstream.reply = (_who, signal, url) => (isJev(url) ? jev(signal) : completed("resp_auto"));
    const key = await gw.token("codex", "thr_auto");
    const jevCalls = () => gw.upstream.requests.filter((request) => isJev(request.url));
    const served = () => JSON.parse(gw.upstream.requests.at(-1)!.body).model as string;
    const status = async () => (await gw.cli("status", "--thread", "thr_auto")).stdout;
    const loop = (input: unknown[]) => [...input, ...[
      { type: "function_call", call_id: `c${input.length}`, name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: `c${input.length}`, output: "ok" },
    ]];
    const nextTurn = (input: unknown[]) => [...input, { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] }, codexUser];

    // Pick: Jev gets the last user message and the candidates, nothing else.
    let input: unknown[] = [codexUser];
    expect((await gw.send(key, codexBody(input), "/v1/responses")).status).toBe(200);
    expect(served()).toBe("gpt-6-luna");
    expect(jevCalls()).toHaveLength(1);
    const asked = jevCalls()[0]!;
    expect(asked.headers.get("authorization")).toBe("Bearer sk-or");
    const question = JSON.parse(asked.body);
    expect(question.model).toBe("typesafe/jev-1.13");
    expect(question.messages[0].content).toContain("Candidates, cheapest first: gpt-6-luna, gpt-6-sol, gpt-6-astra, gpt-5.6-terra.");
    expect(question.messages[1]).toEqual({ role: "user", content: "List the files, then patch the README." });
    expect(asked.body).not.toContain("You are Codex.");
    expect(await status()).toContain("Auto: auto → gpt-6-luna (jev 0.90)");
    expect(await gw.host.harness.behavior.callRpc("thread.route", { threadId: "thr_auto" })).toMatchObject({
      chainIndex: 0,
      model: "gpt-6-luna",
      auto: "jev 0.90",
    });

    // Sticky within the tool loop: no new question, same model.
    jev = () => jevAnswer("gpt-6-astra", 0.95);
    input = loop(input);
    await gw.send(key, codexBody(input), "/v1/responses");
    expect(jevCalls()).toHaveLength(1);
    expect(served()).toBe("gpt-6-luna");

    // Re-pick at the next user turn.
    input = nextTurn(input);
    await gw.send(key, codexBody(input), "/v1/responses");
    expect(jevCalls()).toHaveLength(2);
    expect(served()).toBe("gpt-6-astra");
    expect(jevCalls()[1]!.body).not.toContain("Done.");

    // Fail open to the client's model: low confidence, HTTP error, network error, timeout.
    const failures: Array<[typeof jev, string]> = [
      [() => jevAnswer("gpt-6-luna", 0.3), "fail open: low confidence 0.30"],
      [() => new Response("busy", { status: 503 }), "fail open: HTTP 503"],
      [() => Promise.reject(new TypeError("fetch failed")), "fail open: error"],
      [() => jevAnswer("gpt-5-nano", 0.99), "fail open: unreadable answer"],
      [
        (signal) =>
          new Promise<Response>((_resolve, reject) =>
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
          ),
        "fail open: timeout",
      ],
    ];
    for (const [answer, reason] of failures) {
      jev = answer;
      input = nextTurn(input);
      expect((await gw.send(key, codexBody(input), "/v1/responses")).status).toBe(200);
      expect(served()).toBe("gpt-6-sol");
      expect(await status()).toContain(`Auto: client model (${reason})`);
      // The failed-open turn stays on the client model through its tool loop.
      input = loop(input);
      await gw.send(key, codexBody(input), "/v1/responses");
      expect(served()).toBe("gpt-6-sol");
    }
    expect(jevCalls()).toHaveLength(2 + failures.length);
    expect(JSON.stringify(gw.host.harness.inspection.logEntries)).not.toContain("List the files");

    // Off again: the client's model, no status line.
    await gw.cli("auto", "codex", "--off");
    input = nextTurn(input);
    await gw.send(key, codexBody(input), "/v1/responses");
    expect(served()).toBe("gpt-6-sol");
    expect(await status()).not.toContain("Auto:");
  });

  it("offers Jev only candidates a legal, unexhausted account can serve", async () => {
    const gw = await gateway();
    await addKey(gw, "responses-compatible-key", "openrouter", OPENROUTER, "sk-or");
    await gw.cli("chain", "set", "claude-code", "claude-oauth:*");
    await gw.cli("auto", "claude-code", "--key", "openrouter");
    const reset = String(RESET / 1_000);
    // Max reports its Opus week used up on the first Opus request.
    gw.upstream.reply = (who, _signal, url) =>
      isJev(url)
        ? jevAnswer("claude-opus-5-5", 0.9)
        : who === "max-token" && served() === "claude-opus-5-5"
          ? Response.json(
              { served: who },
              { headers: { "anthropic-ratelimit-unified-7d_opus-utilization": "1", "anthropic-ratelimit-unified-7d_opus-reset": reset } },
            )
          : undefined;
    const key = await gw.token("claude-code", "thr_auto_max");
    const jevCalls = () => gw.upstream.requests.filter((request) => isJev(request.url)).length;
    const served = () => JSON.parse(gw.upstream.requests.at(-1)!.body).model as string;
    const turn = { ...captured.turn, model: "claude-opus-4-7" };
    expect((await gw.send(key, turn)).status).toBe(200);
    expect(jevCalls()).toBe(1);
    expect(served()).toBe("claude-opus-5-5");

    // Max's Opus week is now used up: Sonnet is the only candidate, so no question.
    expect((await gw.send(key, turn)).status).toBe(200);
    expect(jevCalls()).toBe(1);
    expect(served()).toBe("claude-sonnet-5");
    expect((await gw.cli("status", "--thread", "thr_auto_max")).stdout).toContain("Auto: auto → claude-sonnet-5 (only candidate)");
    // Side calls: the title call takes the pick without a question; Haiku calls keep their model.
    expect((await gw.send(key, captured.title)).status).toBe(200);
    expect(served()).toBe("claude-sonnet-5");
    expect((await gw.send(key, { ...captured.turn, model: "claude-haiku-4-5-20251001" })).status).toBe(200);
    expect(served()).toBe("claude-haiku-4-5-20251001");
    expect(jevCalls()).toBe(1);
  });

  it("never counts Claude OAuth as a Jev candidate for another harness", async () => {
    const gw = await gateway({
      withCodex: true,
      config: {
        chains: { "acp-omp": ["claude-oauth:*", "chatgpt-oauth:*"] },
        auto: { harnesses: ["acp-omp"], key: "openrouter", model: "typesafe/jev-1.13" },
      },
    });
    await addKey(gw, "responses-compatible-key", "openrouter", OPENROUTER, "sk-or");
    gw.upstream.reply = (_who, _signal, url) => (isJev(url) ? jevAnswer("gpt-6-luna", 0.9) : completed("resp_omp"));
    const token = (await valueOf(gw.env("acp-omp", "thr_auto_omp"), "MODEL_GATEWAY_TOKEN")) as string;
    const body = { ...codexBody([codexUser]), model: "gw-gpt-6-sol" };
    // With ChatGPT held only Max is left, which omp may not use: no candidate, no question.
    await gw.cli("account", "hold", gw.pro!.id, "--until", new Date(RESET).toISOString());
    await gw.send(token, body, "/v1/responses");
    expect(gw.upstream.attempts).toEqual([]);
    await gw.cli("account", "hold", gw.pro!.id, "--clear");
    expect((await gw.send(token, body, "/v1/responses")).status).toBe(200);
    expect(gw.upstream.attempts).toEqual(["sk-or", "pro-token"]);
    expect(JSON.parse(gw.upstream.requests.at(-1)!.body).model).toBe("gpt-6-luna");
  });

  it("routes Pi through the gateway: env, health, routing --off, and the legal guard", async () => {
    const withoutCodex = await gateway();
    expect(await withoutCodex.env("pi", "thr_pi_none")).toEqual([]);
    const gw = await gateway({ withCodex: true, config: { chains: { pi: ["claude-oauth:*", "chatgpt-oauth:*"] } } });
    const entries = await gw.env("pi", "thr_pi");
    expect(entries.map(({ name, value }) => [name, value])).toEqual([
      ["MODEL_GATEWAY_BASE_URL", { serverPath: `${MOUNT}/v1` }],
      ["MODEL_GATEWAY_TOKEN", expect.any(String)],
    ]);
    const token = entries[1]!.value as string;
    expect(await gw.host.harness.behavior.resolveProviderEnvHealth("pi", { hostId: "host-one" })).toMatchObject({ label: "Gateway" });
    // The stored chain names Claude OAuth; Pi still never reaches Max, on either route.
    expect((await gw.cli("chain", "set", "pi", "claude-oauth:*")).stderr).toMatch(/claude-code harness/u);
    gw.upstream.reply = (who) => (who === "pro-token" ? completed("resp_pi") : undefined);
    const sent = await gw.send(token, { model: "gpt-6-sol", input: "hi", max_output_tokens: 128_000, stream: true }, "/v1/responses");
    expect(sent.status).toBe(200);
    await gw.send(token, userTurn);
    expect(gw.upstream.attempts).not.toContain("max-token");
    expect(JSON.parse(gw.upstream.requests[0]!.body)).toEqual({ model: "gpt-6-sol", input: "hi", stream: true });
    expect(await gw.route("thr_pi")).toMatchObject({ harness: "pi" });
    expect((await gw.cli("routing", "pi", "--off")).exitCode).toBe(0);
    expect(await gw.env("pi", "thr_pi_off")).toEqual([]);
  });

  it("writes the Pi extension into the Pi agent dir, owned whole and backed up", async () => {
    const gw = await gateway();
    const agentDir = await mkdtemp(path.join(tmpdir(), "mgw-pi-agent-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const file = path.join(agentDir, "extensions", "model-gateway.js");
      const printed = await gw.cli("setup", "pi", "--print");
      expect(printed.stdout).toContain('pi.registerProvider("model-gateway"');
      await expect(fs.stat(file)).rejects.toThrow();
      const written = await gw.cli("setup", "pi");
      expect(written.exitCode).toBe(0);
      const text = await fs.readFile(file, "utf8");
      expect(text).toContain('const MODELS = ["gpt-6-astra","gpt-6-sol","gpt-5.6-terra","gpt-6-luna"];');
      expect(text).toContain("process.env.MODEL_GATEWAY_BASE_URL");
      expect(text).toContain('api: "openai-responses"');
      expect((await gw.cli("setup", "pi")).stdout).toContain("already up to date");
      await fs.writeFile(file, `${text}// local edit\n`);
      expect((await gw.cli("setup", "pi")).stdout).toContain(`Backup: ${file}.bak-`);
      expect(await fs.readFile(file, "utf8")).toBe(text);
      await fs.writeFile(file, "export default function mine() {}\n");
      const refused = await gw.cli("setup", "pi");
      expect(refused).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("not managed by the gateway") });
      expect(await fs.readFile(file, "utf8")).toBe("export default function mine() {}\n");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });
});
