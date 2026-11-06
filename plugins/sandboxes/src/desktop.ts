import {execFile} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {BbPluginApi} from '@get-bb/plugin-sdk';
import {z} from 'zod';
import type {NativeIdleSuspendHolds} from './provider/idle-suspend.js';
import {desktopHostContract,desktopRpcContract,sandboxDesktopRpcContract,type DesktopTarget,type SandboxDesktopView} from './desktop-contract.js';

export const SANDBOX_DESKTOP_DIRECTIVE='sandbox-desktop';
/** Runs the bb CLI on the server machine. Only the server's own host uses it. */
export type BbCli=(args:string[])=>Promise<string>;
const runBb:BbCli=args=>new Promise((resolve,reject)=>execFile(process.env.BB_CLI||'bb',args,{timeout:15000},(error,stdout)=>error?reject(error):resolve(stdout)));

export interface SandboxDesktops{open(threadId:string,viewOnly:boolean,agent?:boolean):Promise<SandboxDesktopView>;view(threadId:string):SandboxDesktopView;close(threadId:string):Promise<void>}

/**
 * Provider-independent desktop viewing through voxl. Consumers such as Browser
 * own their private display; the sandbox's own display belongs to this plugin.
 */
export function registerDesktops(bb:BbPluginApi,idle:()=>NativeIdleSuspendHolds|undefined=()=>undefined,cli:BbCli=runBb):SandboxDesktops{
 const client=bb.hosts.experimental_client({contract:desktopHostContract});
 type Grant={hostId:string;session:string;port:number;expires:number;url:string;viewOnly:boolean;shared?:string;agent?:boolean;local?:boolean};
 const active=new Map<string,Grant>();
 // A replaced grant keeps streaming briefly, so the viewer can swap frames without a black gap.
 const retiring=new Map<string,{grant:Grant;timer:ReturnType<typeof setTimeout>}>();
 let serial=0;
 const idFor=(plugin:string,thread:string)=>createHash('sha256').update(plugin+'\0'+thread).digest('hex');
 // A plugin id cannot contain '/', so this never collides with a consumer's grant.
 const sharedId=(threadId:string)=>idFor('sandboxes/desktop',threadId);
 const changed=(threadId:string)=>bb.realtime.publish('sandbox-desktop:'+threadId,null);
 // The server's own machine is never declared; bb connect shares its ports.
 const localHosts=new Set<string>();
 const publish=(hostId:string)=>{if(!localHosts.has(hostId))bb.hosts.declareSharedPorts(hostId,[...active.values(),...[...retiring.values()].map(v=>v.grant)].filter(v=>v.hostId===hostId).map(v=>v.port));};
 // The server's own machine has no machine credential. It shares ports through the server's bb connect tunnel.
 const serverTunnel=async()=>{
  const status=JSON.parse(await cli(['connect','status','--json'])) as {state?:string;url?:string};
  if(status.state!=='connected'||!status.url)throw Error('bb connect is not connected; a remote desktop view needs it');
  const [label,...rest]=new URL(status.url).hostname.split('.');
  return {label:label!,baseDomain:rest.join('.')};
 };
 const stop=async(grant:Grant)=>{try{await client.call('closeDesktop',{id:grant.session},{hostId:grant.hostId,timeoutMs:10000});}finally{idle()?.release(grant.hostId,'desktop:'+grant.session);if(grant.local)await cli(['connect','unexpose',String(grant.port),'--host',grant.hostId]).catch(()=>bb.log.warn('A local desktop share could not be removed; run bb connect unexpose '+grant.port));}};
 const retire=(id:string)=>{const value=retiring.get(id);if(!value)return;clearTimeout(value.timer);retiring.delete(id);publish(value.grant.hostId);void stop(value.grant).catch(()=>{});};
 const close=async(id:string)=>{retire(id);const value=active.get(id);if(!value)return;active.delete(id);publish(value.hostId);if(value.shared)changed(value.shared);await stop(value);};
 const grant=async(id:string,threadId:string,viewOnly:boolean,target?:DesktopTarget,agent=false)=>{
  const thread=await bb.sdk.threads.get({threadId});if(!thread.environmentId)throw Error('Desktop thread has no host');
  const {hostId}=await bb.sdk.environments.get({environmentId:thread.environmentId}),host=await bb.sdk.hosts.get({hostId});
  // A consumer's private display is validated on its host, so a local host qualifies.
  // The shared screen is always a sandbox's own.
  if(host.status!=='connected'||(!target&&!host.machineProviderId?.startsWith('sandbox-')))throw Error('A connected sandbox desktop is required');
  // Consumers' private displays switch at once. The sandbox's own view overlaps the old and new streams.
  const previous=active.get(id);
  if(target||previous?.hostId!==hostId)await close(id);else retire(id);
  const session=id+'-'+(++serial).toString(36);
  idle()?.hold(hostId,'desktop:'+session);
  try{
   const local=host.machineProviderId===null;if(local)localHosts.add(hostId);
   const token=randomBytes(32).toString('base64url'),tunnel=local?await serverTunnel():await bb.hosts.ensureSharedPortTunnel(hostId);
   const payload={id:session,appOrigin:new URL(bb.server.experimental_appUrl||bb.server.loopbackBaseUrl).origin,viewOnly,threadTitle:(thread.title?.trim()||thread.titleFallback?.trim()||'Untitled thread').slice(0,240),token,notices:await readFile(new URL('../dist/desktop-licenses.txt',import.meta.url),'utf8'),tunnel};
   // Starting the sandbox display can take up to 20 seconds.
   const {port,expires}=target?await client.call('openDesktop',{...payload,target},{hostId,timeoutMs:15000}):await client.call('openSharedDesktop',payload,{hostId,timeoutMs:45000});
   if(local)try{await cli(['connect','expose',String(port),'--host',hostId,'--json']);}catch(error){await client.call('closeDesktop',{id:session},{hostId,timeoutMs:10000}).catch(()=>{});throw error;}
   const url=`https://${tunnel.label}--${port}.${tunnel.baseDomain}/#${token}`;
   const old=active.get(id);
   active.set(id,{hostId,session,port,expires,url,viewOnly,...(target?{}:{shared:threadId}),...(agent?{agent}:{}),...(local?{local}:{})});
   if(old){const timer=setTimeout(()=>retire(id),8000);timer.unref?.();retiring.set(id,{grant:old,timer});}
   publish(hostId);if(!target)changed(threadId);
   return {url,expires};
  }catch(error){idle()?.release(hostId,'desktop:'+session);throw error;}
 };
 const view=(threadId:string):SandboxDesktopView=>{const value=active.get(sharedId(threadId));return value&&value.expires>Date.now()?{kind:'open',url:value.url,expires:value.expires,viewOnly:value.viewOnly,...(value.agent?{agent:true}:{})}:{kind:'closed'};};
 const desktops:SandboxDesktops={
  // A view the agent opens shows itself in the side panel, even if the reply leaves out the directive.
  open:async(threadId,viewOnly,agent)=>{await grant(sharedId(threadId),threadId,viewOnly,undefined,agent);return view(threadId);},
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
  instructions:`Use when the user asks to see or use the sandbox desktop. It opens view only; the user takes control from the card. Pass viewOnly:false only when the user asks to control it now. After opening, emit ::${SANDBOX_DESKTOP_DIRECTIVE}{} exactly once on its own line in the reply. The view also opens in the thread side panel by itself. For a thread’s Browser window use browser_live instead.`,
  parameters:z.object({action:z.enum(['open','close']).default('open'),viewOnly:z.boolean().default(true)}).strict(),
  execute:async({action,viewOnly},context)=>{
   if(action==='close'){await desktops.close(context.threadId);return 'Sandbox desktop view closed.';}
   await desktops.open(context.threadId,viewOnly,true);
   return `Sandbox desktop opened${viewOnly?' view-only':''}. It closes after 15 minutes.\n::${SANDBOX_DESKTOP_DIRECTIVE}{}`;
  },
 });
 const sweep=setInterval(()=>{for(const [id,value]of active)if(value.expires<=Date.now())void close(id).catch(()=>{});},10000);sweep.unref();
 bb.onDispose(async()=>{clearInterval(sweep);await Promise.allSettled([...active.keys()].map(close));});
 return desktops;
}
