import { spawn } from "node:child_process";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const browserSyncHostContract = defineRpcContract({
  provisionBrowser: { input:z.object({payload:z.string().max(6*1024*1024)}).strict(),output:z.object({ok:z.boolean()}) },

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
