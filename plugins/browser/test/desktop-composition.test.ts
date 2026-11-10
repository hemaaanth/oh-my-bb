import {fork} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createFakePluginHost,makeHostResponse,makeThreadResponse} from '@get-bb/plugin-sdk/testing';
import {expect,it,vi} from 'vitest';
import {z} from 'zod';
import browserPlugin from '../src/server.js';

// Explicit opt-in: each package runs its own implementation in its own process.
it.runIf(!!process.env.BB_TEST_SANDBOXES_SOURCE).each(['open-loss','close-loss'])('retains cleanup across actual Browser/Sandboxes %s',async scenario=>{
 const sandbox=process.env.BB_TEST_SANDBOXES_SOURCE!,ready=Promise.withResolvers<void>();
 const child=fork(join(sandbox,'test/fixtures/desktop-consumer.mjs'),[],{cwd:sandbox,execArgv:[],stdio:['ignore','pipe','pipe','ipc']});
 const jobs=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();let serial=0,errors='';
 child.stderr!.on('data',chunk=>errors+=chunk);
 child.on('message',message=>{
  const reply=z.object({ready:z.boolean().optional(),id:z.number().optional(),result:z.unknown().optional(),error:z.string().optional()}).parse(message);
  if(reply.ready){ready.resolve();return;}
  const job=reply.id===undefined?undefined:jobs.get(reply.id);if(!job)return;jobs.delete(reply.id!);
  reply.error?job.reject(Error(reply.error)):job.resolve(reply.result);
 });
 const exited=Promise.withResolvers<void>();
 child.once('exit',code=>{exited.resolve();const error=Error('Sandboxes fixture exited '+code+': '+errors);ready.reject(error);for(const job of jobs.values())job.reject(error);jobs.clear();});
 const call=(method:string,input?:unknown)=>{
  if(!child.connected)return Promise.reject(Error('Sandboxes fixture disconnected: '+errors));
  const job=Promise.withResolvers<unknown>(),id=++serial;jobs.set(id,job);child.send({id,method,input});return job.promise;
 };
 const host=makeHostResponse({id:'host_fixture',machineProviderId:null,status:'connected'}),thread=makeThreadResponse({id:'thr_fixture',environmentId:'env_fixture'}),actions:string[]=[],rpc:string[]=[];
 const fake=createFakePluginHost({pluginId:'browser',experimental_hostEntry:true,settings:{sandboxesIntegration:true},sdk:{threads:{get:async()=>thread},environments:{get:async()=>({hostId:host.id})},hosts:{get:async()=>host},plugins:{callRpc:async({method,input})=>{rpc.push(method);return await call(method,input) as never;}}},experimental_callHostRpc:async({method,input})=>{
  if(method==='browserDesktopTarget')return {display:':1234',authority:'/private/authority',owner:{pid:42,start:'100'},displayOwner:{pid:43,start:'101'}};
  const action=z.object({action:z.string()}).parse(input).action;actions.push(action);return {ok:true};
 }});
 const inspect=async()=>z.object({sessionLive:z.boolean(),holds:z.array(z.string()),calls:z.array(z.string())}).parse(await call('inspect'));
 try{
  await ready.promise;await browserPlugin(fake.bb,async()=>JSON.stringify({state:'disconnected',url:null}));
  if(scenario==='close-loss')await call('openNormally');
  const pending=fake.harness.behavior.callAgentTool('browser_handoff',{reason:'login',instructions:'Fixture'},{threadId:thread.id});
  if(scenario==='close-loss'){
   await vi.waitFor(()=>expect(fake.harness.pendingInteractions).toHaveLength(1));
   fake.harness.behavior.submitInteraction(fake.harness.pendingInteractions[0]!.id,{done:true});
   expect(await pending).toMatchObject({isError:true});
  }else{await expect(pending).rejects.toThrow();expect(fake.harness.pendingInteractions).toHaveLength(0);}
  expect(actions).toEqual(['pause','discard']);expect(rpc).toContain('desktopCloseV1');
  const uncertain=await inspect();expect(uncertain).toMatchObject({sessionLive:true,holds:[expect.any(String)]});
  await expect(fake.harness.behavior.callRpc('closeBrowserView',{threadId:thread.id})).rejects.toThrow();
  await call('allowClose');await fake.harness.behavior.callRpc('closeBrowserView',{threadId:thread.id});
  const closed=await inspect();expect(closed).toMatchObject({sessionLive:false,holds:[]});expect(actions).not.toContain('resume');
  if(process.env.BB_THREAD_STORAGE)await writeFile(join(process.env.BB_THREAD_STORAGE,'repair-composition-'+scenario+'.json'),JSON.stringify({scenario,actions,rpc,uncertain,closed},null,2));
 }finally{
  await call('allowClose').catch(()=>{});await fake.harness.lifecycle.dispose();await call('dispose').catch(()=>{});await exited.promise;
 }
},15000);
