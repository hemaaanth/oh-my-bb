import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxSsh, sandboxSshOrigins } from "../src/ssh.js";
import { sandboxProviderValues } from "../src/backend.js";

const ENROLLMENT_KEY = "tskey-auth-secret";
const API_KEY = "tskey-api-secret";
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(disposers.splice(0).map((dispose) => dispose())); });

function setup(provider = "daytona") {
  const settings = { sshEnabled: true, sshAuthKey: ENROLLMENT_KEY, sshApiKey: API_KEY };
  const identity = { nodeId: "node-one", authority: "root@bb-host-ssh.tailnet.ts.net", error: null as string | null };
  const host = makeHostResponse({ id: "host_ssh", status: "connected", machineProviderId: `sandbox-${provider}`, lifecycle: {
    phase: "active", message: null, pendingLog: "", suspendedAt: null, teardown: null,
  } });
  let hosts = [host];
  const fake = createFakePluginHost({
    pluginId: "sandboxes", experimental_hostEntry: true, loopbackBaseUrl: "http://127.0.0.1:38886",
    sdk: { hosts: { get: async () => host, list: async () => hosts } },
    experimental_callHostRpc: async ({ method }) => method === "configureSsh" ? { ...identity } : null,
  });
  const config: { servers: Record<string, { hosts: Record<string, { sshAuthority: string }> }> } = { servers: {} };
  const runClient = vi.fn(async (args: string[]) => {
    if (args[0] === "list") return JSON.stringify(config);
    const origin = args[1];
    if (args[0] === "set") {
      config.servers[origin] ??= { hosts: {} };
      config.servers[origin].hosts[args[4]] = { sshAuthority: args[2] };
    } else if (args[0] === "remove") delete config.servers[origin]?.hosts[args[3]];
    return "";
  });
  const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const desktop = { configure: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) };
  const ssh = new SandboxSsh(fake.bb, async () => ({ ...settings }), desktop, runClient, request);
  disposers.push(async () => { ssh.dispose(); await fake.harness.dispose(); });
  return { ...fake, ssh, settings, identity, host, config, runClient, request, desktop, removeHost: () => { hosts = []; } };
}

describe("sandbox SSH", () => {
  it("uses both desktop loopback origins without changing the port", () => {
    expect(sandboxSshOrigins("http://127.0.0.1:38886", "https://bb.example.test/thread/one"))
      .toEqual(["http://127.0.0.1:38886", "http://localhost:38886", "https://bb.example.test"]);
  });

  it.each(sandboxProviderValues)("configures %s through the shared host entry", async (provider) => {
    const { ssh, harness, config } = setup(provider);
    await ssh.ensure("host_ssh");
    expect(config.servers["http://127.0.0.1:38886"].hosts.host_ssh.sshAuthority).toBe("bb-sandbox-host_ssh");
    expect(harness.experimental_hostRpcCalls).toContainEqual(expect.objectContaining({
      method: "configureSsh", hostId: "host_ssh", input: { hostId: "host_ssh", authKey: ENROLLMENT_KEY },
    }));
    expect(JSON.stringify(await ssh.list())).not.toContain(ENROLLMENT_KEY);
    expect(JSON.stringify(await ssh.list())).not.toContain(API_KEY);
  });

  it("does nothing when disabled and requires cleanup credentials before enrolling", async () => {
    const { ssh, settings, harness } = setup();
    settings.sshEnabled = false;
    await ssh.ensure("host_ssh");
    expect(harness.experimental_hostRpcCalls).toHaveLength(0);
    settings.sshEnabled = true;
    settings.sshApiKey = "";
    await expect(ssh.ensure("host_ssh")).rejects.toThrow("Set both");
    expect(harness.experimental_hostRpcCalls).toHaveLength(0);
  });

  it("preserves manually configured targets, including during deletion", async () => {
    const { ssh, config, request } = setup();
    config.servers["http://127.0.0.1:38886"] = { hosts: { host_ssh: { sshAuthority: "my-own-target" } } };
    await ssh.ensure("host_ssh");
    await ssh.retire("host_ssh");
    expect(config.servers["http://127.0.0.1:38886"].hosts.host_ssh.sshAuthority).toBe("my-own-target");
    expect(config.servers["http://localhost:38886"].hosts.host_ssh).toBeUndefined();
    expect(request).toHaveBeenCalledWith("https://api.tailscale.com/api/v2/device/node-one", expect.objectContaining({ method: "DELETE" }));
    expect(await ssh.list()).toEqual([]);
  });

  it("refreshes its own mappings and removes the previous device after re-enrollment", async () => {
    const { ssh, identity, config, request } = setup();
    await ssh.ensure("host_ssh");
    identity.nodeId = "node-two";
    identity.authority = "root@bb-host-ssh-1.tailnet.ts.net";
    await ssh.ensure("host_ssh");
    expect(config.servers["http://localhost:38886"].hosts.host_ssh.sshAuthority).toBe("bb-sandbox-host_ssh");
    expect(request).toHaveBeenCalledTimes(1);
    expect((await ssh.list())[0].nodeId).toBe("node-two");
  });

  it("retains failed cleanup across a restart and retries without waking a missing host", async () => {
    const { ssh, bb, identity, request, runClient, desktop, removeHost } = setup();
    await ssh.ensure("host_ssh");
    request.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(ssh.retire("host_ssh")).rejects.toThrow("HTTP 403");
    expect((await ssh.list())[0]).toMatchObject({ retiring: true, nodeId: identity.nodeId });
    removeHost();
    const reloaded = new SandboxSsh(bb, async () => ({ sshEnabled: false, sshAuthKey: "", sshApiKey: API_KEY }), desktop, runClient, request);
    await reloaded.reconcile();
    expect(await reloaded.list()).toEqual([]);
    reloaded.dispose();
  });

  it("reconciles only connected active hosts and revokes access when disabled", async () => {
    const { ssh, host, settings, harness, request } = setup();
    host.lifecycle!.phase = "suspended";
    host.status = "disconnected";
    await ssh.reconcile();
    expect(harness.experimental_hostRpcCalls).toHaveLength(0);
    host.lifecycle!.phase = "active";
    host.status = "connected";
    await ssh.reconcile();
    settings.sshEnabled = false;
    await ssh.reconcile();
    expect(harness.experimental_hostRpcCalls).toContainEqual(expect.objectContaining({ method: "stopSsh" }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(await ssh.list()).toEqual([]);
  });

  it("keeps a device eligible for cleanup even when SSH policy fails", async () => {
    const { ssh, identity, runClient } = setup();
    identity.error = "Could not enable Tailscale SSH; check tailnet SSH policy";
    await expect(ssh.ensure("host_ssh")).rejects.toThrow("SSH policy");
    expect((await ssh.list())[0]).toMatchObject({ nodeId: identity.nodeId, error: identity.error });
    expect(runClient).not.toHaveBeenCalled();
    await ssh.retire("host_ssh");
    expect(await ssh.list()).toEqual([]);
  });
});
