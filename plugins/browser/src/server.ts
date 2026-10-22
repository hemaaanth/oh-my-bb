import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { dirname, join } from "node:path";
import { z } from "zod";
import { BrowserCookieConnection } from "./browser-cookie-connection.js";
import { browserExtensionOrigin } from "./browser-extension-download.js";
import { browserSettingDescriptors } from "./config.js";
import { registerBrowserHandoff, BROWSER_AGENT_INSTRUCTIONS } from "./browser-handoff.js";
import { registerBrowserCookieSync, syncBrowserCookies, registerBrowserProvisioning } from "./browser-sync.js";
import { trustedBrowserPayload } from "./trusted-browser.js";
import {browserViewerHostContract} from "./viewer-contract.js";
import { registerRelay } from "./relay.js";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define(browserSettingDescriptors);
  const directory = join(dirname(bb.storage.database().name), "browser-cookies");
  const cookies = new BrowserCookieConnection(bb, directory, async (state, signal) => {
    if (!(await settings.get()).legacyLiveSync || !(await settings.get()).sharePersonalLogins) return { ok: false };
    return syncBrowserCookies(state, signal);
  });
  // Migration is private, resumable and never rewrites legacy state or profile paths.
  const migrate = async () => {
    if (await bb.storage.kv.get("migration-v1")) return;
    let legacy;
    try { legacy = await bb.sdk.plugins.callRpc({ pluginId: "sandboxes", method: "browserLegacyV1", input: null,
      outputSchema: z.object({ settings: z.record(z.string(), z.string()), connection: z.unknown(), pairing: z.unknown(), state: z.string().nullable() }) }); }
    catch { return; } // Browser also works without Sandboxes; retry when the integration is used.
    const adopted = await cookies.importLegacy(legacy);
    if (adopted) {
      const current = await settings.get();
      const imported = Object.fromEntries(Object.entries(legacy.settings).filter(([key, value]) => value && !current[key as keyof typeof current]));
      if (Object.keys(imported).length) await settings.experimental_set(imported);
      if (legacy.connection) await settings.experimental_set({ legacyLiveSync: true });
    }
    await bb.storage.kv.set("migration-v1", true);
  };
  await cookies.register();
  registerBrowserCookieSync(bb, async () => ({ ...await cookies.settings(await settings.get()), syncEnabled: (await settings.get()).legacyLiveSync && (await settings.get()).sharePersonalLogins }));
  const sandboxPayload = async () => {
    const current = await settings.get();
    const source = current.sharePersonalLogins ? await cookies.settings(current) : current;
    const {payload,warnings} = await trustedBrowserPayload(source);
    for (const warning of warnings) bb.log.warn(warning);
    return {...payload,tailscaleAuthKey:'',networkService:'sandboxes-v1',access:'isolated',legacyLiveSync:current.sharePersonalLogins && current.legacyLiveSync};
  };
  const reconcile = registerBrowserProvisioning(bb, sandboxPayload);
  settings.onChange(() => { void reconcile(); });
  const network=async(hostId:string,threadId:string,held:boolean)=>{
    const payload=held?(await trustedBrowserPayload(await settings.get())).payload:null;
    return bb.sdk.plugins.callRpc({pluginId:'sandboxes',method:'browserNetworkV1',input:{hostId,threadId,held,...(payload?{exitNode:payload.exitNode,authKey:payload.tailscaleAuthKey}:{})},outputSchema:z.object({socket:z.string(),proxyPort:z.number().int(),client:z.string()}).nullable()});
  };
  const hold = async (hostId: string, threadId: string, held = true) => {
    const host = await bb.sdk.hosts.get({ hostId });
    if (!host.machineProviderId?.startsWith("sandbox-")) return;
    await bb.sdk.plugins.callRpc({ pluginId: "sandboxes", method: "browserHoldV1", input: { hostId, threadId, held }, outputSchema: z.null() });
  };
  const desktopClient=bb.hosts.experimental_client({contract:browserViewerHostContract}),desktopSessions=new Set<string>();
  const closeDesktop=async(threadId:string)=>{if(!desktopSessions.has(threadId))return;await bb.sdk.plugins.callRpc({pluginId:'sandboxes',method:'desktopCloseV1',input:{threadId},outputSchema:z.null()});desktopSessions.delete(threadId);};
  bb.onDispose(async()=>{await Promise.allSettled([...desktopSessions].map(closeDesktop));});
  registerBrowserHandoff(bb, { openDesktop:async(hostId,threadId,viewOnly=false)=>{
    const host=await bb.sdk.hosts.get({hostId});if(!host.machineProviderId?.startsWith('sandbox-'))return null;
    const target=await desktopClient.call('browserDesktopTarget',{threadId,watch:viewOnly},{hostId,timeoutMs:30000});
    if(!target)return null; // Paired regular profiles and scratch headless sessions remain page-only.
    const result=await bb.sdk.plugins.callRpc({pluginId:'sandboxes',method:'desktopOpenV1',input:{threadId,target,viewOnly},outputSchema:z.object({url:z.string(),expires:z.number()})});desktopSessions.add(threadId);return result.url;
  },closeDesktop,hold, release: (hostId, threadId) => hold(hostId, threadId, false),cleanupNetwork:async(hostId,threadId)=>{await network(hostId,threadId,false);} });
  registerRelay(bb, cookies, () => settings.get(),async(threadId,held)=>{
    const thread=await bb.sdk.threads.get({threadId});if(!thread.environmentId)throw Error('This thread has no sandbox network host');
    return network((await bb.sdk.environments.get({environmentId:thread.environmentId})).hostId,threadId,held);
  });
  const contract = defineRpcContract({
    prepareSandboxV1: { input: z.object({ hostId: z.string() }), output: z.record(z.string(), z.unknown()) },
    legacyHttpV1: { input: z.object({ path: z.enum(["/cookie-sync/pair", "/cookie-sync/snapshot"]), method: z.enum(["POST", "OPTIONS"]), origin: z.string(), authorization: z.string(), body: z.string().max(5 * 1024 * 1024) }), output: z.object({ status: z.number(), body: z.string(), origin: z.string() }) },
  });
  bb.rpc.register(contract, {
    prepareSandboxV1: async ({ hostId }, context) => {
      if (context.experimental_caller.kind !== "plugin" || context.experimental_caller.pluginId !== "sandboxes") throw new Error("Sandboxes plugin required");
      await migrate();
      const { allowed } = await bb.sdk.plugins.callRpc({ pluginId: "sandboxes", method: "browserAccessV1", input: { hostId }, outputSchema: z.object({ allowed: z.boolean() }) });
      if (!allowed) throw new Error("Sandbox host required");
      return sandboxPayload();
    },
    legacyHttpV1: async (input, context) => {
      if (context.experimental_caller.kind !== "plugin" || context.experimental_caller.pluginId !== "sandboxes") throw new Error("Sandboxes plugin required");
      await migrate(); const origin = await browserExtensionOrigin();
      const result = (status: number, body: unknown) => ({ status, body: JSON.stringify(body), origin });
      if (input.origin && input.origin !== origin) return result(403, { error: "Extension origin required" });
      if (input.method === "OPTIONS") return { status: 204, body: "", origin };
      try {
        const body = JSON.parse(input.body);
        if (input.path.endsWith("/pair")) { const paired = await cookies.pair(z.object({ code: z.string().min(32).max(128) }).strict().parse(body).code); return result(paired ? 200 : 401, paired ?? { error: "Pairing expired" }); }
        const token = input.authorization.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
        const value = token ? await cookies.snapshot(token, body) : null;
        return result(value ? 200 : 401, value ?? { error: "Pair this extension first" });
      } catch { return result(400, { error: "Invalid cookie snapshot" }); }
    },
  });
  bb.agents.contributeInstructions(() => BROWSER_AGENT_INSTRUCTIONS);
}
