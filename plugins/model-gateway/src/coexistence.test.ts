import fs from "node:fs/promises";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ACCOUNT_POOL_PLUGIN_ID, isAccountPoolRouting } from "./coexistence.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function hostWithPlugins(
  plugins: Array<{ id: string; enabled: boolean }>,
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bb-coexistence-"));
  const host = createFakePluginHost({
    pluginId: "model-gateway",
    dataDir,
    sdk: { plugins: { list: async () => ({ plugins }) } },
  });
  cleanups.push(async () => {
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return host;
}

describe("isAccountPoolRouting", () => {
  it("is true when the Account Pooler is installed and enabled", async () => {
    const host = await hostWithPlugins([
      { id: ACCOUNT_POOL_PLUGIN_ID, enabled: true },
    ]);
    expect(await isAccountPoolRouting(host.bb)).toBe(true);
  });

  it("is false when the Account Pooler is installed but disabled", async () => {
    const host = await hostWithPlugins([
      { id: ACCOUNT_POOL_PLUGIN_ID, enabled: false },
    ]);
    expect(await isAccountPoolRouting(host.bb)).toBe(false);
  });

  it("is false when the Account Pooler is not installed", async () => {
    const host = await hostWithPlugins([
      { id: "model-gateway", enabled: true },
    ]);
    expect(await isAccountPoolRouting(host.bb)).toBe(false);
  });
});
