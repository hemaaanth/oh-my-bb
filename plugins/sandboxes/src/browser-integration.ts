import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { SandboxSettings } from "./config.js";
import { sandboxSshHostContract } from './ssh-contract.js';

export const browserIntegrationContract = defineRpcContract({
  browserAccessV1: { input: z.object({ hostId: z.string() }), output: z.object({ allowed: z.boolean() }) },
  browserLegacyV1: { input: z.null(), output: z.object({ settings: z.record(z.string(), z.string()), connection: z.unknown(), pairing: z.unknown(), state: z.string().nullable() }) },
  browserHoldV1: { input: z.object({ hostId: z.string(), threadId: z.string(), held: z.boolean() }), output: z.null() },
  browserNetworkV1:{input:z.object({hostId:z.string(),threadId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),held:z.boolean(),exitNode:z.string().optional(),authKey:z.string().optional(),generation:z.string().regex(/^[a-f0-9]{32}$/).optional()}).strict(),output:z.object({socket:z.string(),proxyPort:z.number().int(),client:z.string()}).nullable()},
});
const keys = ["browserUserAgent", "browserExitNode", "browserHomeEgressIp", "browserTailscaleAuthKey", "browserTailscaleAuthKeyFile", "browserStateFile"] as const;
export function registerBrowserIntegration(bb: BbPluginApi, settings: () => Promise<Pick<SandboxSettings, typeof keys[number]> & Partial<Pick<SandboxSettings,"sshAuthKey">> & {browserProjects?:string}>, directory: string,
  idle: () => { hold(id: string): void; release(id: string): void } | undefined) {
  const holds = new Map<string, Set<string>>();
  const allowedHost = async (hostId: string) => (await bb.sdk.hosts.get({hostId})).machineProviderId?.startsWith("sandbox-") === true;
  bb.rpc.register(browserIntegrationContract, {
    browserAccessV1: async ({ hostId }, context) => {
      if (context.experimental_caller.kind !== "plugin" || context.experimental_caller.pluginId !== "browser") throw new Error("Browser plugin required");
      return {allowed:await allowedHost(hostId)};
    },
    browserNetworkV1:async(input,context)=>{
      if(context.experimental_caller.kind!=='plugin'||context.experimental_caller.pluginId!=='browser')throw Error('Browser plugin required');
      const host=await bb.sdk.hosts.get({hostId:input.hostId});if(!host.machineProviderId?.startsWith('sandbox-'))throw Error('Sandbox network host required');
      if(input.held&&!await allowedHost(input.hostId))throw Error('Sandbox host required');
      const client=bb.hosts.experimental_client({contract:sandboxSshHostContract});
      if(input.held)return client.call('configureBrowserNetwork',{hostId:input.hostId,threadId:input.threadId,...(input.generation?{generation:input.generation}:{}),exitNode:input.exitNode||'',authKey:input.authKey?.trim()||(await settings()).sshAuthKey?.trim()||''},{hostId:input.hostId,timeoutMs:240000});
      await client.call('releaseBrowserNetwork',{threadId:input.threadId,...(input.generation?{generation:input.generation}:{})},{hostId:input.hostId,timeoutMs:30000});return null;
    },
    browserLegacyV1: async (_, context) => {
      if (context.experimental_caller.kind !== "plugin" || context.experimental_caller.pluginId !== "browser") throw new Error("Browser plugin required");
      const current = { ...await settings() };
      // Keep the retired native secret readable only for Browser's existing migration.
      try { current.browserTailscaleAuthKey = await readFile(join(dirname(directory), "secrets", "browserTailscaleAuthKey"), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      let state = null; try { state = await readFile(join(directory, "state.json"), "utf8"); } catch {}
      return { settings: Object.fromEntries(keys.map(key => [key, current[key]])), connection: await bb.storage.kv.get("browser-cookie-connection") ?? null,
        pairing: await bb.storage.kv.get("browser-cookie-pairing") ?? null, state };
    },
    browserHoldV1: async ({ hostId, threadId, held }, context) => {
      if (context.experimental_caller.kind !== "plugin" || context.experimental_caller.pluginId !== "browser") throw new Error("Browser plugin required");
      const owners = holds.get(hostId) ?? new Set<string>();
      held ? owners.add(threadId) : owners.delete(threadId);
      if (owners.size) { holds.set(hostId, owners); idle()?.hold(hostId); }
      else { holds.delete(hostId); idle()?.release(hostId); }
      return null;
    },
  });
  // Old paired extensions keep their token and URL. Browser is the only state owner.
  for (const path of ["/cookie-sync/pair", "/cookie-sync/snapshot"]) for (const method of ["POST", "OPTIONS"] as const) {
    bb.http.route(method, path, async c => {
      const reader = c.req.raw.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 5 * 1024 * 1024) { await reader.cancel(); return c.json({ error: "Request too large" }, 413); } chunks.push(value); }
      try {
        const response = await bb.sdk.plugins.callRpc({ pluginId: "browser", method: "legacyHttpV1", input: { path, method, origin: c.req.header("origin") ?? "", authorization: c.req.header("authorization") ?? "", body: Buffer.concat(chunks).toString("utf8") }, outputSchema: z.object({ status: z.number(), body: z.string(), origin: z.string() }) });
        c.header("Access-Control-Allow-Origin", response.origin); c.header("Access-Control-Allow-Headers", "authorization,content-type"); c.header("Access-Control-Allow-Methods", "POST,OPTIONS"); c.header("Cache-Control", "no-store");
        return new Response(response.body || null, { status: response.status, headers: { "content-type": "application/json", "access-control-allow-origin": response.origin, "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "POST,OPTIONS", "cache-control": "no-store" } });
      } catch { return c.json({ error: "Install or enable Browser to retain this connection" }, 503); }
    }, { auth: "none" });
  }
  return;
}
