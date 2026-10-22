import {randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {BbPluginApi} from '@get-bb/plugin-sdk';
import type {NativeIdleSuspendHolds} from './provider/idle-suspend.js';
import {desktopHostContract,desktopRpcContract} from './desktop-contract.js';

/** Provider-independent VNC access. Consumers own the app/display; Sandboxes owns the viewer. */
export function registerDesktops(bb:BbPluginApi,idle:()=>NativeIdleSuspendHolds|undefined=()=>undefined){
 const client=bb.hosts.experimental_client({contract:desktopHostContract});
 const active=new Map<string,{hostId:string;port:number;expires:number}>();
 const idFor=(plugin:string,thread:string)=>createHash('sha256').update(plugin+'\0'+thread).digest('hex');
 const publish=(hostId:string)=>bb.hosts.declareSharedPorts(hostId,[...active.values()].filter(v=>v.hostId===hostId).map(v=>v.port));
 const close=async(id:string)=>{const value=active.get(id);if(!value)return;active.delete(id);publish(value.hostId);try{await client.call('closeDesktop',{id},{hostId:value.hostId,timeoutMs:10000});}finally{idle()?.release(value.hostId,'desktop:'+id);}};
 let script:Promise<string>|undefined;
 bb.rpc.register(desktopRpcContract,{
  desktopOpenV1:async(input,context)=>{
   if(context.experimental_caller.kind!=='plugin')throw Error('An installed plugin must request desktop access');
   const thread=await bb.sdk.threads.get({threadId:input.threadId});if(!thread.environmentId)throw Error('Desktop thread has no host');
   const {hostId}=await bb.sdk.environments.get({environmentId:thread.environmentId}),host=await bb.sdk.hosts.get({hostId});
   if(host.status!=='connected'||!host.machineProviderId?.startsWith('sandbox-'))throw Error('A connected sandbox desktop is required');
   const id=idFor(context.experimental_caller.pluginId,input.threadId);await close(id);
   idle()?.hold(hostId,'desktop:'+id);
   try{
   const token=randomBytes(32).toString('base64url'),tunnel=await bb.hosts.ensureSharedPortTunnel(hostId);
   script??=readFile(new URL('../dist/desktop-client.js',import.meta.url),'utf8');
   const {port,expires}=await client.call('openDesktop',{id,target:input.target,appOrigin:new URL(bb.server.experimental_appUrl||bb.server.loopbackBaseUrl).origin,viewOnly:input.viewOnly,threadTitle:(thread.title?.trim()||thread.titleFallback?.trim()||'Untitled thread').slice(0,240),token,clientScript:await script,notices:await readFile(new URL('../dist/desktop-licenses.txt',import.meta.url),'utf8'),tunnel},{hostId,timeoutMs:15000});
   active.set(id,{hostId,port,expires});publish(hostId);
   return {url:`https://${tunnel.label}--${port}.${tunnel.baseDomain}/#${token}`,expires};
   }catch(error){idle()?.release(hostId,'desktop:'+id);throw error;}
  },
  desktopCloseV1:async({threadId},context)=>{if(context.experimental_caller.kind!=='plugin')throw Error('An installed plugin must release desktop access');await close(idFor(context.experimental_caller.pluginId,threadId));return null;},
 });
 const sweep=setInterval(()=>{for(const [id,grant]of active)if(grant.expires<=Date.now())void close(id).catch(()=>{});},10000);sweep.unref();
 bb.onDispose(async()=>{clearInterval(sweep);await Promise.allSettled([...active.keys()].map(close));});
}
