import { spawn } from "node:child_process";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { browserHandoffHostContract, browserHandoffRpcContract, BROWSER_HANDOFF_RENDERER, type BrowserLiveState } from "./browser-handoff-contract.js";
import { registerViewer } from "./viewer.js";
export { browserHandoffHostContract } from "./browser-handoff-contract.js";

/** Fixed argv only. The caller cannot choose a command, backend, or profile. */
export function browserThreadControl(input: { threadId: string; action: "pause" | "resume" | "show" | "close" | "discard" }, signal: AbortSignal): Promise<{ ok: boolean }> {
  browserHandoffHostContract.browserThreadControl.input.parse(input);
  return new Promise(resolve => {
    const child = spawn("bb-browser", ["thread", input.action], {
      env: { ...process.env, BB_THREAD_ID: input.threadId }, stdio: "ignore",
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    });
    child.once("error", () => resolve({ ok: false }));
    child.once("close", code => resolve({ ok: code === 0 }));
  });
}

export const BROWSER_AGENT_INSTRUCTIONS = 'Use bb-browser for browser work. BB_THREAD_ID automatically gives this thread its own window and tabs. Use browser_handoff when login, OAuth, a bot check, or another manual browser action needs the user. It pauses automation and preserves the window until Done or Cancel. Never move hidden windows with external commands or kill Brave to expose them. In a sandbox, browser_handoff embeds its private desktop in chat. If the user asks to watch live, use browser_live and emit its ::browser-live{} directive on its own line; watching does not pause automation. On a local machine, browser_handoff requests attention through BB; let the user visit the browser workspace themselves. Never activate windows or change workspaces. Check IS_SANDBOX and the thread environment rather than assuming where the browser runs. Close your browser with `bb-browser close --all` after completing browser work, unless the user is still watching.';

export function registerBrowserHandoff(bb: BbPluginApi, idle?: { hold(hostId: string, threadId: string): void | Promise<void>; release(hostId: string, threadId: string): void | Promise<void>;cleanupNetwork?(hostId:string,threadId:string):Promise<void>;openDesktop?(hostId:string,threadId:string,viewOnly?:boolean):Promise<string|null>;closeDesktop?(threadId:string):Promise<void> }) {
  const viewer = registerViewer(bb);
  const client = bb.hosts.experimental_client({ contract: browserHandoffHostContract });
  const controller = new AbortController();
  const pending = new Set<string>();
  const active = new Set<string>();
  bb.events.on("thread.active", ({ thread }) => { active.add(thread.id); });
  bb.onDispose(() => controller.abort());
  const hostForThread = async (id: string) => {
    const thread = await bb.sdk.threads.get({ threadId: id });
    if (!thread.environmentId) throw new Error("This thread has no browser host");
    return (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId;
  };
  const control = async (id: string, action: "pause" | "resume" | "show" | "close" | "discard", signal = controller.signal, hostId?: string) =>
    client.call("browserThreadControl", { threadId: id, action }, { hostId: hostId ?? await hostForThread(id), signal, timeoutMs: 65_000 });

  const live=new Map<string,{url:string;expires:number}>();
  const opening=new Map<string,Promise<BrowserLiveState>>();
  const changed=(id:string)=>bb.realtime.publish('browser-view:'+id,null);
  const state=(id:string):BrowserLiveState=>pending.has(id)?{kind:'handoff'}:live.has(id)?{kind:'watch',url:live.get(id)!.url}:{kind:'closed'};
  const stopLive=async(id:string)=>{
    await opening.get(id)?.catch(()=>{});
    if(!live.has(id))return;
    await idle?.closeDesktop?.(id);live.delete(id);changed(id);
  };
  const startLive=(id:string):Promise<BrowserLiveState>=>{
    if(pending.has(id)||live.has(id))return Promise.resolve(state(id));
    const existing=opening.get(id);if(existing)return existing;
    const task=(async()=>{
      const hostId=await hostForThread(id),host=await bb.sdk.hosts.get({hostId});
      if(!host.machineProviderId?.startsWith('sandbox-'))return {kind:'local'} as const;
      const url=await idle?.openDesktop?.(hostId,id,true);
      if(!url)throw Error('Open a headed sandbox browser with bb-browser first');
      live.set(id,{url,expires:Date.now()+15*60000});changed(id);return state(id);
    })().finally(()=>opening.delete(id));
    opening.set(id,task);return task;
  };
  bb.rpc.register(browserHandoffRpcContract, {
    openBrowserView:({threadId})=>startLive(threadId),
    getBrowserView:async({threadId})=>state(threadId),
    closeBrowserView:async({threadId})=>{await finishLive(threadId);return null;},
    showBrowserHandoff: async ({ threadId: id }) => {
      if (!pending.has(id)) throw new Error("This thread is not waiting for browser input");
      return control(id, "show");
    },
  });
  bb.agents.registerTool({
    name:'browser_live',description:'Show or close an inline live view of this thread’s sandbox browser, when the user asks to watch. Does not pause automation. Local browsers use browser_handoff for attention instead.',
    instructions:'Open the page with bb-browser first. Use only when the user requests live viewing. After opening, emit ::browser-live{} exactly once on its own line in the reply. Viewing is read-only; use browser_handoff when the user needs to interact.',
    parameters:z.object({action:z.enum(['open','close']).default('open')}).strict(),
    execute:async({action},context)=>{
      if(action==='close'){await finishLive(context.threadId);return 'Live browser view closed.';}
      const view=await startLive(context.threadId);
      return view.kind==='local'?'This browser is local. Use browser_handoff if the user needs to act; it requests attention without switching workspaces.':view.kind==='handoff'?'A browser handoff is already waiting in this chat.':'Live sandbox browser view opened. Automation can continue.\n::browser-live{}';
    },
  });
  bb.agents.registerTool({
    name: "browser_handoff",
    description: "Pause this thread's browser and ask the user to complete a login, OAuth, button click, or bot check. Shows a native BB action card. Returns after Done or Cancel.",
    instructions: "Use when browser work needs a person. Open the relevant page with bb-browser first. Explain the exact action. Do not ask for passwords or codes in chat. While this tool waits, leave the browser alone. After Done, take a fresh snapshot and verify the result before continuing. On cancellation stop this browser task.",
    parameters: z.object({ reason: z.enum(["login", "oauth", "bot-check", "button", "other"]), instructions: z.string().trim().min(1).max(2000) }).strict(),
    presentation: { label: { pending: "Browser needs your attention", completed: "Browser handoff answered" }, icon: { glyph: "Globe" } },
    execute: async (input, context) => {
      if (pending.has(context.threadId)) throw new Error("This thread already has a browser handoff");
      const hostId = await hostForThread(context.threadId);
      if (pending.has(context.threadId)) throw new Error("This thread already has a browser handoff");
      pending.add(context.threadId);
      let completed = false;
      let cleanupOk = false;
      try {
        await stopLive(context.threadId);changed(context.threadId);
        await idle?.hold(hostId, context.threadId);
        if (!(await control(context.threadId, "pause", context.signal, hostId)).ok) throw new Error("Could not pause the browser for manual input; update bb-browser on this host");
        const host = await bb.sdk.hosts.get({ hostId });
        const desktopUrl=await idle?.openDesktop?.(hostId,context.threadId);
        const result = await bb.ui.requestInput({
          threadId: context.threadId, rendererId: BROWSER_HANDOFF_RENDERER,
          title: "Browser needs your attention", payload: { ...input, host: host.name, inlineViewer:!!desktopUrl,...(desktopUrl?{viewerUrl:desktopUrl}:host.machineProviderId?.startsWith('sandbox-')?{viewerUrl:viewer.issue(context.threadId,hostId)}:{}) }, timeoutMs: 15 * 60_000,
          presentation: { label: { pending: "Waiting for your browser action", completed: "Browser action answered" }, icon: { glyph: "Globe" } },
          describeSubmission: value => ({ title: value && typeof value === "object" && "done" in value && value.done === true ? "Finished browser action" : "Cancelled browser action" }),
        }, { signal: context.signal });
        completed = result.outcome === "submitted" && !!result.value && typeof result.value === "object" && "done" in result.value && result.value.done === true;

      } finally {
        viewer.revoke(context.threadId);
        let desktopClosed=true;
        try{await idle?.closeDesktop?.(context.threadId);}catch{desktopClosed=false;bb.log.warn("Desktop viewer cleanup could not be confirmed; discarding its browser");}
        // A separate signal is necessary when the tool was stopped by the user.
        const signal = AbortSignal.timeout(65_000);
        const released = await control(context.threadId, completed && desktopClosed ? "resume" : "discard", signal, hostId).catch(() => ({ ok: false }));
        cleanupOk = released.ok && desktopClosed;
        pending.delete(context.threadId);changed(context.threadId);
        await idle?.release(hostId, context.threadId);
        if (!released.ok) bb.log.warn(`Browser handoff cleanup failed for ${context.threadId}; retry bb-browser thread resume or discard on its host`);
      }
      if (!cleanupOk) return { content: [{ type: "text" as const, text: "Browser handoff cleanup could not be confirmed. Stop automation. Check that its viewer has closed before reopening the browser." }], isError: true };
      return completed ? "The user finished the browser action. Take a fresh bb-browser snapshot and verify it before continuing." : { content: [{ type: "text" as const, text: "Browser handoff cancelled or expired. Stop this browser task. Its window has been closed." }], isError: true };
    },
  });

  const clean = async ({ thread }: { thread: { id: string; environmentId: string | null } }) => {
    active.delete(thread.id);
    if (pending.has(thread.id) || live.has(thread.id) || opening.has(thread.id) || !thread.environmentId) return;
    try {
      const hostId = (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId;
      const host = await bb.sdk.hosts.get({ hostId });
      if (host.status !== "connected" || host.lifecycle.phase !== "active") return;
      if (active.has(thread.id) || pending.has(thread.id)) return;
      if (!(await control(thread.id, "close", controller.signal, hostId)).ok) bb.log.warn(`Browser cleanup failed for ${thread.id}`);
      if(host.machineProviderId?.startsWith('sandbox-'))await idle?.cleanupNetwork?.(hostId,thread.id);
    } catch { if (!controller.signal.aborted) bb.log.warn(`Browser cleanup unavailable for ${thread.id}`); }
  };
  async function finishLive(id:string){const existed=live.has(id)||opening.has(id);await stopLive(id);if(existed&&!active.has(id)){const thread=await bb.sdk.threads.get({threadId:id});if(!active.has(id))await clean({thread});}}
  for (const event of ["thread.idle", "thread.failed", "thread.archived", "thread.deleted"] as const) bb.events.on(event,async value=>{
    if(event==='thread.archived'||event==='thread.deleted')await stopLive(value.thread.id);
    await clean(value);
  });
  const sweep=setInterval(()=>{for(const [id,view]of live)if(view.expires<=Date.now())void finishLive(id).catch(()=>bb.log.warn('Expired live browser view cleanup failed'));},10000);sweep.unref();
  bb.onDispose(async()=>{clearInterval(sweep);await Promise.allSettled([...new Set([...live.keys(),...opening.keys()])].map(stopLive));});
}
