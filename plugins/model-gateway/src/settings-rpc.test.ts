// Settings pane RPC: the legal guard holds on the server, and no read or write
// RPC returns a key, token, or OAuth credential.
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import { accountSchema } from "./contracts.js";
import { createAccountPoolPlugin } from "./server.js";

const SECRETS = [
  "sk-settings-KEY-never-returned",
  "oauth-settings-ACCESS",
  "oauth-settings-REFRESH",
];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(pooler = false) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bb-gateway-settings-"));
  const host = createFakePluginHost({
    pluginId: "model-gateway",
    dataDir,
    sdk: {
      hosts: { list: async () => [] },
      system: { providerStates: async () => ({ providers: [] }) },
      plugins: {
        list: async () => ({
          plugins: [
            { id: "model-gateway", enabled: true },
            { id: "account-pool", enabled: pooler },
          ],
        }),
      },
    },
  });
  await createAccountPoolPlugin({
    usageUrl: "data:application/json,{}",
    importCredentials: async () => ({
      accessToken: "oauth-settings-ACCESS",
      refreshToken: "oauth-settings-REFRESH",
      expiresAt: Date.now() + 60 * 60 * 1_000,
      subscriptionType: "max",
      rateLimitTier: "max_5x",
      email: "pool@example.com",
      accountUuid: "11111111-1111-4111-8111-111111111111",
    }),
  })(host.bb);
  cleanups.push(async () => {
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const call = (method: string, input: unknown) =>
    host.harness.behavior.callRpc(method, input);
  const oauth = accountSchema.parse(
    await call("account.add", {
      provider: "claude",
      source: { kind: "import" },
      label: "max",
      priority: 1,
    }),
  );
  const key = accountSchema.parse(
    await call("key.add", {
      kind: "responses-compatible-key",
      label: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: SECRETS[0],
      priority: 100,
    }),
  );
  return { host, call, oauth, key };
}

it("returns no key, token, or OAuth credential from any settings RPC", async () => {
  const { call, oauth } = await setup();
  const outputs: unknown[] = [];
  for (const [method, input] of [
    ["account.list", null],
    ["status.get", null],
    ["config.get", null],
    ["routing.get", null],
    ["chain.options", null],
    ["live.get", null],
    ["hold.clear", { accountId: oauth.id }],
    ["chain.set", { harness: "codex", entries: ["responses-compatible-key:openrouter"] }],
    ["modelMap.set", { key: "responses-compatible-key", pattern: "claude-*", model: "gpt-x" }],
    ["auto.set", { harness: "codex", key: "openrouter" }],
  ] as const)
    outputs.push(await call(method, input));
  const text = JSON.stringify(outputs);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
});

it("blocks Claude OAuth outside claude-code in chain.options and refuses to save it", async () => {
  const { call } = await setup();
  const options = (await call("chain.options", null)) as Record<
    string,
    Array<{ entry: string; label: string; blocked: string | null }>
  >;
  // Kinds only, in plain names; per-account entries stay in `bb gateway chain set`.
  expect(options.codex?.map((option) => option.label)).toEqual([
    "Claude Max",
    "Anthropic API",
    "ChatGPT",
    "Anthropic-compatible keys",
    "Responses-compatible keys",
  ]);
  expect(options.codex?.find((option) => option.entry === "claude-oauth:*")?.blocked).toBe(
    "Claude OAuth accounts serve only the claude-code harness",
  );
  expect(options["claude-code"]?.find((option) => option.entry === "claude-oauth:*")?.blocked).toBeNull();
  await expect(
    call("chain.set", { harness: "codex", entries: ["chatgpt-oauth:*", "claude-oauth:max"] }),
  ).rejects.toThrow(/Claude OAuth accounts serve only the claude-code harness/);
  const config = (await call("config.get", null)) as { chains: Record<string, string[]> };
  expect(config.chains.codex).toEqual(["chatgpt-oauth:*"]);
});

it("edits the model map and Jev auto through the CLI's rules", async () => {
  const { call } = await setup();
  await call("modelMap.set", { key: "claude-key", pattern: "claude-*", model: "claude-x" });
  let config = (await call("modelMap.set", {
    key: "claude-key",
    pattern: "claude-*",
    model: null,
  })) as { modelMap: Record<string, unknown>; auto: { harnesses: string[] } };
  expect(config.modelMap["claude-key"]).toBeUndefined();
  await expect(call("auto.set", { harness: "pi", key: "missing" })).rejects.toThrow(
    "No responses-compatible-key is labelled missing.",
  );
  config = (await call("auto.set", { harness: "pi", key: "openrouter" })) as typeof config;
  expect(config.auto.harnesses).toEqual(["pi"]);
});

it("reports Account Pooler blocking and the setup text on routing.get", async () => {
  const { call, host } = await setup(true);
  const routing = (await call("routing.get", null)) as {
    enabled: Record<string, boolean>;
    blockedBy: string | null;
    setup: Record<string, string>;
    ladders: Record<string, string[]>;
  };
  expect(routing.blockedBy).toMatch(/Account Pooler/);
  expect(routing.ladders["claude-code"]).toEqual(["claude-sonnet-5", "claude-opus-5-5"]);
  expect(routing.ladders.codex).toEqual([
    "gpt-6-luna",
    "gpt-6-sol",
    "gpt-6-astra",
    "gpt-5.6-terra",
  ]);
  expect(Object.keys(routing.enabled)).toHaveLength(6);
  expect(routing.setup["acp-omp"]).toContain("bb gateway setup omp");
  expect(routing.setup["acp-fx"]).toContain("fx login codex");
  await call("routing.set", { provider: "pi", enabled: true });
  expect(((await call("routing.get", null)) as typeof routing).enabled.pi).toBe(true);
  expect(host.harness.inspection.realtimeSignals).toContainEqual({
    channel: "model-gateway.accounts-changed",
    payload: {},
  });
});

it("lists an account hold on live.get and clears it", async () => {
  const { call, host, key } = await setup();
  const hold = await host.harness.behavior.runCli(["account", "hold", key.id, "--until", "+1h"]);
  expect(hold.exitCode).toBe(0);
  const live = (await call("live.get", null)) as {
    holds: Array<{ accountId: string; label: string }>;
    threads: unknown[];
  };
  expect(live.holds).toMatchObject([{ accountId: key.id, label: "openrouter" }]);
  expect(live.threads).toEqual([]);
  expect(await call("hold.clear", { accountId: key.id })).toEqual({ cleared: true });
  expect(((await call("live.get", null)) as typeof live).holds).toEqual([]);
});
