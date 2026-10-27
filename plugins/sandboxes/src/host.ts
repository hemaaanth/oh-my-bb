import { homedir } from "node:os";
import { runtimeEnvironmentContract } from "./runtime-environment-contract.js";
import { join } from "node:path";
import { experimental_defineHostEntry, type ExperimentalHostWorkerLease } from "@get-bb/plugin-sdk/host";
import { sandboxSshHostContract } from "./ssh-contract.js";
import { SandboxNetworkHost } from "./network-host.js";
import {desktopHostContract} from "./desktop-contract.js";
import {SandboxDesktopHost} from "./desktop-host.js";

// Both consumers share this owner and enrollment code, never mutable identity state.
let pending:Promise<unknown>=Promise.resolve(),desktopPending:Promise<unknown>=Promise.resolve();
let ssh:SandboxNetworkHost|undefined,browser:SandboxNetworkHost|undefined;
let lease:ExperimentalHostWorkerLease|undefined;
let desktops:SandboxDesktopHost|undefined,desktopLease:ExperimentalHostWorkerLease|undefined;
function serial<T>(action:()=>Promise<T>){const next=pending.then(action,action);pending=next.catch(()=>undefined);return next;}
function serialDesktop<T>(action:()=>Promise<T>){const next=desktopPending.then(action,action);desktopPending=next.catch(()=>undefined);return next;}
function network(directory:string,kind:'ssh'|'browser'){
 ssh??=new SandboxNetworkHost(join(directory,'ssh'));
 browser??=new SandboxNetworkHost(join(directory,'browser-network'),'browser');
 return kind==='ssh'?ssh:browser;
}
async function releaseWorker(){if(!await ssh?.referenced()&&!await browser?.referenced()){await lease?.dispose();lease=undefined;}}
export default experimental_defineHostEntry({
 contract:{...sandboxSshHostContract,...desktopHostContract,...runtimeEnvironmentContract},
 handlers:{
  runtimeEnvironment:()=>({home:homedir()}),
  openDesktop:(input,context)=>serialDesktop(async()=>{
   desktops??=new SandboxDesktopHost(join(context.experimental_paths.dataDir,"desktops"),()=>{void desktopLease?.dispose();desktopLease=undefined;});
   const result=await desktops.open(input,context.signal);desktopLease??=context.experimental_retainWorker();return result;
  }),
  closeDesktop:(input)=>serialDesktop(async()=>{await desktops?.close(input.id);return null;}),
  configureSsh:(input,context)=>serial(async()=>{
   const runtime=network(context.experimental_paths.dataDir,'ssh');
   lease??=context.experimental_retainWorker();
   try{return await runtime.acquire('ssh',input,context.signal);}catch(error){if(!await runtime.referenced())await runtime.stop(new AbortController().signal);await releaseWorker();throw error;}
  }),
  stopSsh:(_,context)=>serial(async()=>{
   const runtime=network(context.experimental_paths.dataDir,'ssh');
   await runtime.release('ssh',context.signal);await releaseWorker();return null;
  }),
  configureBrowserNetwork:(input,context)=>serial(async()=>{
   const runtime=network(context.experimental_paths.dataDir,'browser');
   lease??=context.experimental_retainWorker();
   try{return await runtime.acquire(input.threadId,input,context.signal);}catch(error){if(!await runtime.referenced())await runtime.stop(new AbortController().signal);await releaseWorker();throw error;}
  }),
  releaseBrowserNetwork:(input,context)=>serial(async()=>{
   const runtime=network(context.experimental_paths.dataDir,'browser');
   await runtime.release(input.threadId,context.signal,input.generation);await releaseWorker();return null;
  }),
 },
 // A worker reload must not interrupt a retained session's network daemon.
 dispose:()=>serial(async()=>{await desktopPending;await desktops?.dispose();desktops=undefined;await desktopLease?.dispose();desktopLease=undefined;await lease?.dispose();lease=undefined;ssh=undefined;browser=undefined;}),
});
