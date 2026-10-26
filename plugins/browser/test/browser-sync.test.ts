import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerBrowserCookieSync, syncBrowserCookies } from "../src/browser-sync.js";
import { NO_TRUSTED_BROWSER } from "../src/trusted-browser.js";

const disposers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "browser-fanout-"));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "state.json");
  const settings = { ...NO_TRUSTED_BROWSER, browserStateFile: file, syncEnabled: true };
  const host = makeHostResponse({ id: "host_browser", status: "connected", machineProviderId: "sandbox-daytona", lifecycle: {
    phase: "active", message: null, pendingLog: "", suspendedAt: null, teardown: null,
  } });
  const environments = [{ projectId: "allowed" }];
  let ok = true;
  const fake = createFakePluginHost({ pluginId: "sandboxes", experimental_hostEntry: true,
    sdk: {
      hosts: { list: async () => [host] },
      plugins: {callRpc:async () => ({allowed:environments.every(environment=>environment.projectId === "allowed")}) as never},
      environments: { list: async () => environments as never },
      projects: { get: async ({ projectId }) => ({ id: projectId, name: projectId }) as never },
    },
    experimental_callHostRpc: async () => ({ ok }),
  });
  disposers.push(() => fake.harness.lifecycle.dispose());
  registerBrowserCookieSync(fake.bb, async () => settings);
  const state = (extra = {}) => JSON.stringify({ bbCookieSync: true, cookies: [], origins: [], ...extra });
  await writeFile(file, state());
  return { ...fake, settings, host, environments, file, state, setOk: (next: boolean) => { ok = next; }, sync: () => fake.harness.behavior.runSchedule("browser-cookie-sync") };
}
it("pushes each changed snapshot once, with no cookie values in logs", async () => {
  const { sync, harness, file, state } = await setup();
  await sync(); await sync();
  expect(harness.experimental_hostRpcCalls).toHaveLength(1);
  await writeFile(file, state({ cookies: [{ name: "sid", value: "secret-cookie", domain: "example.test" }] }));
  await sync();
  expect(harness.experimental_hostRpcCalls).toHaveLength(2);
  expect(harness.experimental_hostRpcCalls[1]).toMatchObject({ hostId: "host_browser", method: "syncBrowserCookies" });
  expect(JSON.stringify(harness.logEntries)).not.toContain("secret-cookie");
});
it("never wakes sleeping hosts and resends after a disconnect", async () => {
  const { sync, harness, host } = await setup();
  await sync();
  host.status = "disconnected"; host.lifecycle!.phase = "suspended";
  await sync();
  expect(harness.experimental_hostRpcCalls).toHaveLength(1);
  host.status = "connected"; host.lifecycle!.phase = "active";
  await sync();
  expect(harness.experimental_hostRpcCalls).toHaveLength(2);
  expect(harness.sdk.callsTo("hosts.experimental_resume")).toHaveLength(0);
});
it("skips non-sandbox hosts", async () => {
  const { sync, harness, host } = await setup();
  host.machineProviderId = "local";
  await sync();
  expect(harness.experimental_hostRpcCalls).toHaveLength(0);
});
it("retries failed imports and leaves ordinary manual exports on their existing schedule", async () => {
  const { sync, harness, setOk, file } = await setup();
  setOk(false); await sync();
  setOk(true); await sync(); await sync();
  expect(harness.experimental_hostRpcCalls).toHaveLength(2);
  await writeFile(file, '{"cookies":[]}');
  await sync();
  expect(harness.experimental_hostRpcCalls).toHaveLength(2);
});
it("does nothing when global continuous sharing is disabled", async () => {
  const { sync, harness, settings } = await setup();
  settings.syncEnabled = false;
  await sync();
  expect(harness.sdk.callsTo("hosts.list")).toHaveLength(0);
});


it("the host helper sends cookies only on stdin and hides subprocess output", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-host-sync-"));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "bb-browser");
  const captured = join(root, "captured.json");
  await writeFile(file, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(captured)},JSON.stringify({args:process.argv.slice(2),input:fs.readFileSync(0,'utf8')}));console.error('cookie-secret');`, { mode: 0o700 });
  vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
  try {
    const state = '{"cookies":[{"value":"cookie-secret"}]}';
    expect(await syncBrowserCookies(state, new AbortController().signal)).toEqual({ ok: true });
    expect(JSON.parse(await readFile(captured, "utf8"))).toEqual({ args: ["state", "sync", "default"], input: state });
    await writeFile(file, '#!/bin/sh\necho cookie-secret >&2\nexit 1\n');
    expect(await syncBrowserCookies(state, new AbortController().signal)).toEqual({ ok: false });
  } finally { vi.unstubAllEnvs(); }
});
