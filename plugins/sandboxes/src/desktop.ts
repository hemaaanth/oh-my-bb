import {randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {BbPluginApi} from '@get-bb/plugin-sdk';
import {z} from 'zod';
import type {NativeIdleSuspendHolds} from './provider/idle-suspend.js';
import {desktopHostContract,desktopRpcContract,sandboxDesktopRpcContract,type DesktopTarget,type SandboxDesktopView} from './desktop-contract.js';

export const SANDBOX_DESKTOP_DIRECTIVE='sandbox-desktop';
export interface SandboxDesktops{open(threadId:string,viewOnly:boolean):Promise<SandboxDesktopView>;view(threadId:string):SandboxDesktopView;close(threadId:string):Promise<void>}

/**
 * Provider-independent desktop viewing through voxl. Consumers such as Browser
 * own their private display; the sandbox's own display belongs to this plugin.
 */
export function registerDesktops(bb:BbPluginApi,idle:()=>NativeIdleSuspendHolds|undefined=()=>undefined):SandboxDesktops{
 const client=bb.hosts.experimental_client({contract:desktopHostContract});
 const active=new Map<string,{hostId:string;port:number;expires:number;url:string;viewOnly:boolean;shared?:string}>();
 const idFor=(plugin:string,thread:string)=>createHash('sha256').update(plugin+'\0'+thread).digest('hex');
 // A plugin id cannot contain '/', so this never collides with a consumer's grant.
 const sharedId=(threadId:string)=>idFor('sandboxes/desktop',threadId);
 const changed=(threadId:string)=>bb.realtime.publish('sandbox-desktop:'+threadId,null);
 const publish=(hostId:string)=>bb.hosts.declareSharedPorts(hostId,[...active.values()].filter(v=>v.hostId===hostId).map(v=>v.port));
 const close=async(id:string)=>{const value=active.get(id);if(!value)return;active.delete(id);publish(value.hostId);if(value.shared)changed(value.shared);try{await client.call('closeDesktop',{id},{hostId:value.hostId,timeoutMs:10000});}finally{idle()?.release(value.hostId,'desktop:'+id);}};
 const grant=async(id:string,threadId:string,viewOnly:boolean,target?:DesktopTarget)=>{
  const thread=await bb.sdk.threads.get({threadId});if(!thread.environmentId)throw Error('Desktop thread has no host');
  const {hostId}=await bb.sdk.environments.get({environmentId:thread.environmentId}),host=await bb.sdk.hosts.get({hostId});
  if(host.status!=='connected'||!host.machineProviderId?.startsWith('sandbox-'))throw Error('A connected sandbox desktop is required');
  await close(id);
  idle()?.hold(hostId,'desktop:'+id);
  try{
   const token=randomBytes(32).toString('base64url'),tunnel=await bb.hosts.ensureSharedPortTunnel(hostId);
   const payload={id,appOrigin:new URL(bb.server.experimental_appUrl||bb.server.loopbackBaseUrl).origin,viewOnly,threadTitle:(thread.title?.trim()||thread.titleFallback?.trim()||'Untitled thread').slice(0,240),token,notices:await readFile(new URL('../dist/desktop-licenses.txt',import.meta.url),'utf8'),tunnel};
   // Starting the sandbox display can take up to 20 seconds.
   const {port,expires}=target?await client.call('openDesktop',{...payload,target},{hostId,timeoutMs:15000}):await client.call('openSharedDesktop',payload,{hostId,timeoutMs:45000});
   const url=`https://${tunnel.label}--${port}.${tunnel.baseDomain}/#${token}`;
   active.set(id,{hostId,port,expires,url,viewOnly,...(target?{}:{shared:threadId})});publish(hostId);if(!target)changed(threadId);
   return {url,expires};
  }catch(error){idle()?.release(hostId,'desktop:'+id);throw error;}
 };
 const view=(threadId:string):SandboxDesktopView=>{const value=active.get(sharedId(threadId));return value&&value.expires>Date.now()?{kind:'open',url:value.url,expires:value.expires,viewOnly:value.viewOnly}:{kind:'closed'};};
 const desktops:SandboxDesktops={
  open:async(threadId,viewOnly)=>{await grant(sharedId(threadId),threadId,viewOnly);return view(threadId);},
  view,
  close:threadId=>close(sharedId(threadId)),
 };
 bb.rpc.register(desktopRpcContract,{
  desktopOpenV1:async(input,context)=>{
   if(context.experimental_caller.kind!=='plugin')throw Error('An installed plugin must request desktop access');
   return grant(idFor(context.experimental_caller.pluginId,input.threadId),input.threadId,input.viewOnly,input.target);
  },
  desktopCloseV1:async({threadId},context)=>{if(context.experimental_caller.kind!=='plugin')throw Error('An installed plugin must release desktop access');await close(idFor(context.experimental_caller.pluginId,threadId));return null;},
 });
 bb.rpc.register(sandboxDesktopRpcContract,{
  openSandboxDesktop:({threadId,viewOnly})=>desktops.open(threadId,viewOnly),
  getSandboxDesktop:async({threadId})=>view(threadId),
  closeSandboxDesktop:async({threadId})=>{await desktops.close(threadId);return null;},
 });
 bb.agents.registerTool({
  name:'sandbox_desktop',description:'Show or close an inline live view of this sandbox’s own desktop, where GUI apps and computer use draw.',
  instructions:`Use when the user asks to see or use the sandbox desktop. It opens view only; the user takes control from the card. Pass viewOnly:false only when the user asks to control it now. After opening, emit ::${SANDBOX_DESKTOP_DIRECTIVE}{} exactly once on its own line in the reply. The user can also open it from the thread side panel. For a thread’s Browser window use browser_live instead.`,
  parameters:z.object({action:z.enum(['open','close']).default('open'),viewOnly:z.boolean().default(true)}).strict(),
  execute:async({action,viewOnly},context)=>{
   if(action==='close'){await desktops.close(context.threadId);return 'Sandbox desktop view closed.';}
   await desktops.open(context.threadId,viewOnly);
   return `Sandbox desktop opened${viewOnly?' view-only':''}. It closes after 15 minutes.\n::${SANDBOX_DESKTOP_DIRECTIVE}{}`;
  },
 });
 const sweep=setInterval(()=>{for(const [id,value]of active)if(value.expires<=Date.now())void close(id).catch(()=>{});},10000);sweep.unref();
 bb.onDispose(async()=>{clearInterval(sweep);await Promise.allSettled([...active.keys()].map(close));});
 return desktops;
}
