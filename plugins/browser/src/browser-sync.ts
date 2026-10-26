import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { TrustedBrowserSettings } from "./trusted-browser.js";

export const browserSyncHostContract = defineRpcContract({
  provisionBrowser: { input:z.object({payload:z.string().max(6*1024*1024)}).strict(),output:z.object({ok:z.boolean()}) },
  syncBrowserCookies: {
    input: z.object({ state: z.string().max(5 * 1024 * 1024) }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
});

/** The fixed command receives secrets only over stdin; no terminal or log. */
function browserInput(argv: string[], input: string, signal: AbortSignal): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("bb-browser", argv, {
      stdio: ["pipe", "ignore", "ignore"],
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    child.once("error", () => resolve({ ok: false }));
    child.once("close", (code) => resolve({ ok: code === 0 }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

export const syncBrowserCookies = (state:string,signal:AbortSignal) => browserInput(["state","sync","default"],state,signal);
export const provisionBrowser = (payload:string,signal:AbortSignal) => browserInput(["provision"],payload,signal);

export function registerBrowserProvisioning(bb:BbPluginApi,payload:()=>Promise<Record<string,unknown>|null>) {
  const client=bb.hosts.experimental_client({contract:browserSyncHostContract});
  const controller=new AbortController();bb.onDispose(()=>controller.abort());
  let queue=Promise.resolve();
  const reconcile=()=>queue=queue.then(async()=>{
    const current = await payload();
    if (!current) return;
    const state=JSON.stringify(current);
    const hosts=(await bb.sdk.hosts.list({signal:controller.signal})).filter(host=>host.status==='connected'&&host.machineProviderId?.startsWith('sandbox-'));
    await Promise.all(hosts.map(async host=>{
      try {
        const result=await client.call('provisionBrowser',{payload:state},{hostId:host.id,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(35000)])});
        if(!result.ok)bb.log.warn(`Browser settings could not be applied on ${host.id}; retrying next minute`);
      }catch{if(!controller.signal.aborted)bb.log.warn(`Browser settings unavailable on ${host.id}; retrying next minute`);}
    }));
  }).catch(()=>{if(!controller.signal.aborted)bb.log.warn('Browser settings reconciliation failed; retrying next minute');});
  bb.background.schedule('browser-settings','* * * * *',reconcile);
  return reconcile;
}

export function registerBrowserCookieSync(bb: BbPluginApi, settings: () => Promise<TrustedBrowserSettings & { syncEnabled: boolean }>): (hostId: string) => void {
  const sent = new Map<string, string>();
  const controller = new AbortController();
  const client = bb.hosts.experimental_client({ contract: browserSyncHostContract });
  bb.onDispose(() => controller.abort());
  let running = false;
  bb.background.schedule("browser-cookie-sync", "* * * * *", async () => {
    if (running) return;
    running = true;
    try {
      const current = await settings();
      if (!current.browserStateFile.trim() || !current.syncEnabled) { sent.clear(); return; }
      const file = current.browserStateFile.replace(/^~(?=\/|$)/, homedir());
      if ((await stat(file)).size > 5 * 1024 * 1024) throw new Error("Browser state is too large");
      const state = await readFile(file, "utf8");
      // Ordinary manually exported state keeps its create/resume semantics.
      if (JSON.parse(state)?.bbCookieSync !== true) { sent.clear(); return; }
      const revision = createHash("sha256").update(state).digest("hex");
      const hosts = await bb.sdk.hosts.list({ signal: controller.signal });
      const connected = new Set(hosts.filter((host) => host.status === "connected" && host.lifecycle.phase === "active").map((host) => host.id));
      for (const id of sent.keys()) if (!connected.has(id)) sent.delete(id);
      const eligible = hosts.filter((host) => connected.has(host.id) && host.machineProviderId?.startsWith("sandbox-"));
      const results = await Promise.allSettled(eligible.map(async (host) => {
        const { allowed } = await bb.sdk.plugins.callRpc({ pluginId: "sandboxes", method: "browserAccessV1", input: { hostId: host.id }, outputSchema: z.object({ allowed: z.boolean() }) });
        if (!allowed) { sent.delete(host.id); return; }
        if (sent.get(host.id) === revision) return;
        try {
          const result = await client.call("syncBrowserCookies", { state }, { hostId: host.id, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]) });
          if (result.ok) sent.set(host.id, revision);
          else bb.log.warn(`Browser cookie sync failed on ${host.id}; update its bb-browser and retry`);
        } catch {
          bb.log.warn(`Browser cookie sync unavailable on ${host.id}; retrying next minute`);
        }
      }));
      results.forEach((result, index) => {
        if (result.status === "rejected" && !controller.signal.aborted) bb.log.warn(`Browser cookie sync could not check project access on ${eligible[index].id}; retrying next minute`);
      });
    } catch {
      if (!controller.signal.aborted) bb.log.warn("Browser cookie sync could not read its source or list eligible machines; retrying next minute");
    } finally { running = false; }
  });
  return (hostId) => sent.delete(hostId);
}
