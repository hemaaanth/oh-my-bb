import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { SandboxSettings } from "./config.js";
import { sandboxSshHostContract } from "./ssh-contract.js";
import { sandboxProviderValues } from "./backend.js";
import { SandboxSshDesktop, sandboxSshTarget } from "./ssh-desktop.js";

const exec = promisify(execFile);
const PREFIX = "ssh/";
const recordSchema = z.object({
  hostId: z.string(),
  nodeId: z.string().nullable(),
  authority: z.string().nullable(),
  origins: z.array(z.string()),
  retiredNodeIds: z.array(z.string()),
  retiring: z.boolean(),
  error: z.string().nullable(),
});
export type SandboxSshRecord = z.infer<typeof recordSchema>;
type SshSettings = Pick<SandboxSettings, "sshEnabled" | "sshAuthKey" | "sshApiKey">;
const clientConfigSchema = z.object({
  servers: z.record(z.string(), z.object({
    hosts: z.record(z.string(), z.object({ sshAuthority: z.string() })),
  })),
});

export function sandboxSshOrigins(loopbackUrl: string, appUrl: string | null): string[] {
  const loopback = new URL(loopbackUrl);
  const alternate = new URL(loopback);
  if (loopback.hostname === "127.0.0.1") alternate.hostname = "localhost";
  if (loopback.hostname === "localhost") alternate.hostname = "127.0.0.1";
  return [...new Set([loopback.origin, alternate.origin, ...(appUrl ? [new URL(appUrl).origin] : [])])];
}

export class SandboxSsh {
  private pending: Promise<unknown> = Promise.resolve();
  private client: ExperimentalHostClient<typeof sandboxSshHostContract> | undefined;
  private readonly controller = new AbortController();

  constructor(
    private readonly bb: BbPluginApi,
    private readonly settings: () => Promise<SshSettings>,
    private readonly desktop: Pick<SandboxSshDesktop, "configure" | "remove">,
    private readonly runClient = async (args: string[]) => {
      const result = await exec("bb-app", ["--data-dir", bb.server.experimental_dataDir, "client", "ssh-target", ...args], {
        timeout: 15_000, maxBuffer: 1024 * 1024, signal: this.controller.signal,
      });
      return result.stdout;
    },
    private readonly request: typeof fetch = fetch,
  ) {}

  dispose() { this.controller.abort(); }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.pending.then(action, action);
    this.pending = next.catch(() => undefined);
    return next;
  }

  private hostClient() {
    // Construct lazily: disabled installations never dispatch a host worker.
    return this.client ??= this.bb.hosts.experimental_client({ contract: sandboxSshHostContract });
  }

  async list(): Promise<SandboxSshRecord[]> {
    const keys = await this.bb.storage.kv.list(PREFIX);
    return Promise.all(keys.map(async (key) => recordSchema.parse(await this.bb.storage.kv.get(key))));
  }

  private save(record: SandboxSshRecord) {
    return this.bb.storage.kv.set(`${PREFIX}${record.hostId}`, record);
  }

  private async clientConfig() {
    try { return clientConfigSchema.parse(JSON.parse(await this.runClient(["list", "--json"]))); }
    catch { throw new Error("Cannot configure SSH on this BB server: bb-app client ssh-target must be available on PATH"); }
  }

  private async clearMappings(record: SandboxSshRecord) {
    const config = await this.clientConfig();
    for (const origin of record.origins) {
      if (config.servers[origin]?.hosts[record.hostId]?.sshAuthority === sandboxSshTarget(record.hostId)) {
        await this.runClient(["remove", origin, "--host-id", record.hostId]);
      }
    }
  }

  private async setMappings(record: SandboxSshRecord) {
    const config = await this.clientConfig();
    for (const origin of record.origins) {
      const existing = config.servers[origin]?.hosts[record.hostId]?.sshAuthority;
      // A manually configured target belongs to the user, even when SSH is enabled.
      if (existing === undefined) {
        await this.runClient(["set", origin, sandboxSshTarget(record.hostId), "--host-id", record.hostId]);
      }
    }
  }

  private async deleteNode(nodeId: string, apiKey: string) {
    if (apiKey.trim() === "") throw new Error("Tailscale cleanup needs the sandbox SSH API key");
    const response = await this.request(`https://api.tailscale.com/api/v2/device/${encodeURIComponent(nodeId)}`, {
      method: "DELETE",
      headers: { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` },
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok && response.status !== 404) throw new Error(`Tailscale device cleanup failed (HTTP ${response.status})`);
  }

  private async clean(record: SandboxSshRecord, apiKey: string) {
    for (const nodeId of [...record.retiredNodeIds]) {
      await this.deleteNode(nodeId, apiKey);
      record.retiredNodeIds = record.retiredNodeIds.filter((id) => id !== nodeId);
      await this.save(record);
    }
    if (record.retiring) {
      // Revoke remote access before attempting desktop configuration cleanup.
      if (record.nodeId !== null) {
        await this.deleteNode(record.nodeId, apiKey);
        record.nodeId = null;
        await this.save(record);
      }
      await this.clearMappings(record);
      await this.desktop.remove(record.hostId);
      await this.bb.storage.kv.delete(`${PREFIX}${record.hostId}`);
    }
  }

  ensure(hostId: string): Promise<void> {
    return this.serial(async () => {
      const settings = await this.settings();
      if (!settings.sshEnabled) return;
      const host = await this.bb.sdk.hosts.get({ hostId });
      if (!sandboxProviderValues.some((provider) => host.machineProviderId === `sandbox-${provider}`)) throw new Error("SSH setup only applies to Sandboxes machines");
      let record = recordSchema.parse(await this.bb.storage.kv.get(`${PREFIX}${hostId}`) ?? {
        hostId, nodeId: null, authority: null, origins: [], retiredNodeIds: [], retiring: false, error: null,
      });
      try {
        if (!settings.sshAuthKey.trim() || !settings.sshApiKey.trim()) {
          throw new Error("Set both the sandbox SSH enrollment key and Tailscale cleanup API key");
        }
        const identity = await this.hostClient().call("configureSsh", {
          hostId, authKey: settings.sshAuthKey,
        }, { hostId, timeoutMs: 240_000, signal: this.controller.signal });
        if (record.nodeId !== null && record.nodeId !== identity.nodeId) record.retiredNodeIds.push(record.nodeId);
        record = {
          ...record, nodeId: identity.nodeId, authority: identity.authority,
          origins: [...new Set([...record.origins, ...sandboxSshOrigins(this.bb.server.loopbackBaseUrl, this.bb.server.experimental_appUrl)])],
          retiring: false, error: identity.error,
        };
        await this.save(record);
        if (identity.error !== null) throw new Error(identity.error);
        await this.desktop.configure(hostId, identity.authority);
        await this.setMappings(record);
        await this.clean(record, settings.sshApiKey);
        record.error = null;
      } catch (error) {
        record.error = error instanceof Error ? error.message : "Sandbox SSH setup failed";
        await this.save(record);
        throw error;
      }
      await this.save(record);
    });
  }

  retire(hostId: string): Promise<void> {
    return this.serial(async () => {
      const stored = await this.bb.storage.kv.get(`${PREFIX}${hostId}`);
      if (stored === undefined) return;
      const record = recordSchema.parse(stored);
      record.retiring = true;
      await this.save(record);
      await this.clean(record, (await this.settings()).sshApiKey);
    });
  }

  async reconcile(): Promise<void> {
    const settings = await this.settings();
    if (!settings.sshEnabled && (await this.list()).length === 0) return;
    const hosts = await this.bb.sdk.hosts.list({ includeCreating: true });
    const byId = new Map(hosts.map((host) => [host.id, host]));
    for (const record of await this.list()) {
      const host = byId.get(record.hostId);
      if (!host || !settings.sshEnabled || record.retiring) {
        if (host?.status === "connected") {
          await this.hostClient().call("stopSsh", null, { hostId: host.id, signal: this.controller.signal }).catch(() => undefined);
        }
        await this.retire(record.hostId).catch(() => this.bb.log.warn(`SSH cleanup pending for ${record.hostId}; run bb sandbox ssh-status`));
      }
    }
    if (settings.sshEnabled) {
      for (const host of hosts) {
        if (sandboxProviderValues.some((provider) => host.machineProviderId === `sandbox-${provider}`) && host.status === "connected" && host.lifecycle?.phase === "active") {
          await this.ensure(host.id).catch(() => this.bb.log.warn(`SSH setup failed for ${host.id}; run bb sandbox ssh-status`));
        }
      }
    }
  }
}
