// New in the gateway: verifies plan decision 8.1 (S5) is actually wired
// into the contributeEnv/contributeEnvHealth registrations in server.ts,
// not just implemented in coexistence.ts in isolation.
import fs from "node:fs/promises";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ACCOUNT_POOL_BLOCKED_LABEL } from "./coexistence.js";
import { createAccountPoolPlugin } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startBlockedPlugin() {
  const dataDir = await mkdtemp(
    path.join(tmpdir(), "bb-model-gateway-coexistence-"),
  );
  const host = createFakePluginHost({
    pluginId: "model-gateway",
    dataDir,
    sdk: {
      hosts: { list: async () => [{ id: "host-one", name: "One" }] },
      system: { providerStates: async () => ({ providers: [] }) },
      plugins: {
        list: async () => ({
          plugins: [{ id: "account-pool", enabled: true }],
        }),
      },
    },
  });
  const plugin = createAccountPoolPlugin({
    usageUrl: "data:application/json,{}",
  });
  await plugin(host.bb);
  cleanups.push(async () => {
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return host;
}

describe("Account Pooler coexistence gate", () => {
  it("contributes no claude-code env while the Account Pooler is enabled", async () => {
    const host = await startBlockedPlugin();
    const entries = await host.harness.behavior.resolveProviderEnv(
      "claude-code",
      { threadId: "thread-one", projectId: "project-one", hostId: "host-one" },
    );
    expect(entries).toEqual([]);
  });

  it("reports the blocked health label for claude-code while the Account Pooler is enabled", async () => {
    const host = await startBlockedPlugin();
    const health = await host.harness.behavior.resolveProviderEnvHealth(
      "claude-code",
      { hostId: "host-one" },
    );
    expect(health).toEqual({
      label: ACCOUNT_POOL_BLOCKED_LABEL,
      statusMessage: expect.any(String),
    });
  });

  it("contributes no codex env while the Account Pooler is enabled", async () => {
    const host = await startBlockedPlugin();
    const entries = await host.harness.behavior.resolveProviderEnv("codex", {
      threadId: "thread-codex",
      projectId: "project-one",
      hostId: "host-one",
    });
    expect(entries).toEqual([]);
  });

  it("reports the blocked health label for codex while the Account Pooler is enabled", async () => {
    const host = await startBlockedPlugin();
    const health = await host.harness.behavior.resolveProviderEnvHealth(
      "codex",
      { hostId: "host-one" },
    );
    expect(health).toEqual({
      label: ACCOUNT_POOL_BLOCKED_LABEL,
      statusMessage: expect.any(String),
    });
  });

  it("wires doctor and import-pool into the CLI", async () => {
    const host = await startBlockedPlugin();
    const doctor = await host.harness.behavior.runCli(["doctor"]);
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stdout).toContain(
      "Account Pooler installed and enabled: true",
    );
    const importPool = await host.harness.behavior.runCli(["import-pool"]);
    expect(importPool.exitCode).toBe(1);
    expect(importPool.stderr).toContain("Account Pooler plugin");
  });
});
