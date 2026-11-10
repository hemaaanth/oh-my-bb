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
const runBb=(args:string[],serverUrl:string)=>new Promise<string>((resolve,reject)=>execFile(process.env.BB_CLI||'bb',args,{timeout:15000,maxBuffer:1024*1024,env:{...process.env,BB_SERVER_URL:serverUrl}},(error,stdout)=>error?reject(error):resolve(stdout)));

export interface SandboxDesktops{open(threadId:string,viewOnly:boolean,agent?:boolean):Promise<SandboxDesktopView>;view(threadId:string):SandboxDesktopView;close(threadId:string):Promise<void>}

/**
 * Provider-independent desktop viewing through voxl. Consumers such as Browser
 * own their private display; the sandbox's own display belongs to this plugin.
 */
export function registerDesktops(bb:BbPluginApi,idle:()=>NativeIdleSuspendHolds|undefined=()=>undefined,cli:BbCli=args=>runBb(args,bb.server.loopbackBaseUrl)):SandboxDesktops{
 const client=bb.hosts.experimental_client({contract:desktopHostContract});
 type Grant={hostId:string;session:string;port:number;expires:number;url:string;viewOnly:boolean;shared?:string;agent?:boolean;local?:boolean};
 type Pending={hostId:string;session:string;local?:boolean;port?:number};
 const pending=new Map<string,Pending>();
 const active=new Map<string,Grant>();
 const operations=new Map<string,Promise<unknown>>();
 const serialize=<T,>(id:string,action:()=>Promise<T>)=>{
  const job=(operations.get(id)??Promise.resolve()).catch(()=>{}).then(action);
  operations.set(id,job);
  void job.finally(()=>{if(operations.get(id)===job)operations.delete(id);}).catch(()=>{});
  return job;
 };
 const idFor=(plugin:string,thread:string)=>createHash('sha256').update(plugin+'\0'+thread).digest('hex');
 // A plugin id cannot contain '/', so this never collides with a consumer's grant.
 const sharedId=(threadId:string)=>idFor('sandboxes/desktop',threadId);
 const changed=(threadId:string)=>bb.realtime.publish('sandbox-desktop:'+threadId,null);
 // The server's own machine is never declared; bb connect shares its ports.
 const localHosts=new Set<string>();
 const publish=(hostId:string)=>{if(!localHosts.has(hostId))bb.hosts.declareSharedPorts(hostId,[...active.values()].filter(v=>v.hostId===hostId).map(v=>v.port));};
 // The server's own machine has no machine credential. It shares ports through the server's bb connect tunnel.
 const serverTunnel=(status:{state:string;url?:string|null})=>{
  if(status.state!=='connected'||!status.url)throw Error('bb connect is not connected; a remote desktop view needs it');
  const [label,...rest]=new URL(status.url).hostname.split('.');
  return {label:label!,baseDomain:rest.join('.')};
 };
 const stop=async(value:Pending)=>{
  await client.call('closeDesktop',{id:value.session},{hostId:value.hostId,timeoutMs:10000});
  idle()?.release(value.hostId,'desktop:'+value.session);
  if(value.local&&value.port!==undefined)await cli(['connect','unexpose',String(value.port),'--host',value.hostId]).catch(()=>bb.log.warn('A local desktop share could not be removed; run bb connect unexpose '+value.port));
 };
 const close=async(id:string)=>{
  const grant=active.get(id),value=grant??pending.get(id);if(!value)return;
  // Retain the owner and hold until the host confirms that pending/live work is drained.
  await stop(value);pending.delete(id);active.delete(id);publish(value.hostId);
  if(grant?.shared)changed(grant.shared);
 };
 const grant=async(id:string,threadId:string,viewOnly:boolean,target?:DesktopTarget,agent=false)=>{
  const thread=await bb.sdk.threads.get({threadId});if(!thread.environmentId)throw Error('Desktop thread has no host');
  const {hostId}=await bb.sdk.environments.get({environmentId:thread.environmentId}),host=await bb.sdk.hosts.get({hostId});
  // A consumer's private display is validated on its host, so a local host qualifies.
  // The shared screen is always a sandbox's own.
  if(host.status!=='connected'||(!target&&!host.machineProviderId?.startsWith('sandbox-')))throw Error('A connected sandbox desktop is required');
  // Drain the previous stream before starting a replacement, including mode changes.
  await close(id);
  const session=id;
  idle()?.hold(hostId,'desktop:'+session);
  try{
   const local=host.machineProviderId===null;if(local)localHosts.add(hostId);
   const connect=z.object({state:z.string(),url:z.string().nullable().optional()}).parse(JSON.parse(await cli(['connect','status','--json'])));
   const appOrigins=[...new Set([bb.server.loopbackBaseUrl,bb.server.experimental_appUrl,...connect.state==='connected'?[connect.url]:[]].filter((value):value is string=>!!value).map(value=>{
    const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Invalid BB viewer origin');return url.origin;
   }))];
   const token=randomBytes(32).toString('base64url'),tunnel=local?serverTunnel(connect):await bb.hosts.ensureSharedPortTunnel(hostId);
   const payload={id:session,appOrigins,viewOnly,threadTitle:(thread.title?.trim()||thread.titleFallback?.trim()||'Untitled thread').slice(0,240),token,notices:await readFile(new URL('../dist/desktop-licenses.txt',import.meta.url),'utf8'),tunnel};
   // Starting the sandbox display can take up to 20 seconds.
   const opening:Pending={hostId,session,...(local?{local}:{})};pending.set(id,opening);
   const {port,expires}=target?await client.call('openDesktop',{...payload,target},{hostId,timeoutMs:15000}):await client.call('openSharedDesktop',payload,{hostId,timeoutMs:45000});
   opening.port=port;
   if(local)await cli(['connect','expose',String(port),'--host',hostId,'--json']);
   const url=`https://${tunnel.label}--${port}.${tunnel.baseDomain}/#${token}`;
   active.set(id,{hostId,session,port,expires,url,viewOnly,...(target?{}:{shared:threadId}),...(agent?{agent}:{}),...(local?{local}:{})});
   pending.delete(id);
   publish(hostId);if(!target)changed(threadId);
   return {url,expires};
  }catch(error){
   if(pending.has(id)||active.has(id))await close(id).catch(()=>bb.log.warn('Desktop open cleanup is unconfirmed; owner and hold retained until close succeeds'));
   else idle()?.release(hostId,'desktop:'+session);
   throw error;
  }
 };
 const view=(threadId:string):SandboxDesktopView=>{const value=active.get(sharedId(threadId));return value&&value.expires>Date.now()?{kind:'open',url:value.url,expires:value.expires,viewOnly:value.viewOnly,...(value.agent?{agent:true}:{})}:{kind:'closed'};};
 const desktops:SandboxDesktops={
  // A view the agent opens shows itself in the side panel, even if the reply leaves out the directive.
  open:async(threadId,viewOnly,agent)=>serialize(sharedId(threadId),async()=>{await grant(sharedId(threadId),threadId,viewOnly,undefined,agent);return view(threadId);}),
  view,
  close:threadId=>serialize(sharedId(threadId),()=>close(sharedId(threadId))),
 };
 bb.rpc.register(desktopRpcContract,{
  desktopOpenV1:async(input,context)=>{
   if(context.experimental_caller.kind!=='plugin')throw Error('An installed plugin must request desktop access');
   const id=idFor(context.experimental_caller.pluginId,input.threadId);
   return serialize(id,()=>grant(id,input.threadId,input.viewOnly,input.target));
  },
  desktopCloseV1:async({threadId},context)=>{if(context.experimental_caller.kind!=='plugin')throw Error('An installed plugin must release desktop access');const id=idFor(context.experimental_caller.pluginId,threadId);await serialize(id,()=>close(id));return null;},
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
 const sweep=setInterval(()=>{for(const [id,value]of active)if(value.expires<=Date.now())void serialize(id,()=>close(id)).catch(()=>{});},10000);sweep.unref();
 bb.onDispose(async()=>{clearInterval(sweep);await Promise.allSettled([...operations.values()]);await Promise.allSettled([...new Set([...active.keys(),...pending.keys()])].map(close));});
 return desktops;
}
