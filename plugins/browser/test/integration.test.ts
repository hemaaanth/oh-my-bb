import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import plugin from "../src/server.js";
import { registerViewer } from "../src/viewer.js";
import { browserExtensionOrigin } from "../src/browser-extension-download.js";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
const dispose: Array<() => Promise<void>>=[];
afterEach(async()=>{for(const fn of dispose.splice(0))await fn();});
it("migrates pairing privately once and preserves old tokens and grants",async()=>{
 const token="t".repeat(43), connection={tokenHash:createHash('sha256').update(token).digest('hex'),lastSyncAt:null,cookies:0,skippedPartitioned:0,localImported:null};
 let available=true;
 const fake=createFakePluginHost({pluginId:'browser',experimental_hostEntry:true,sdk:{plugins:{callRpc:async({method})=>{
   if(method==='browserLegacyV1')return {settings:{browserExitNode:'fixture-home',browserHomeEgressIp:'198.51.100.8'},connection,pairing:{hash:'a'.repeat(64),expiresAt:Date.now()+60000},state:null} as never;
   if(method==='browserAccessV1')return {allowed:available} as never;throw Error('unexpected RPC');
 }}}});dispose.push(()=>fake.harness.lifecycle.dispose());await plugin(fake.bb);
 const caller={experimental_caller:{kind:'plugin' as const,pluginId:'sandboxes'}};
 const snapshot={cookies:[]};const origin=await browserExtensionOrigin();
 const response=await fake.harness.behavior.callRpc('legacyHttpV1',{path:'/cookie-sync/snapshot',method:'POST',origin,authorization:'Bearer '+token,body:JSON.stringify(snapshot)},caller) as {status:number,body:string};
 expect(response.status).toBe(200);expect(response.body).not.toContain(token);
 expect(await fake.bb.storage.kv.get('browser-cookie-connection')).toMatchObject({tokenHash:connection.tokenHash});
 expect(await fake.bb.storage.kv.get('browser-cookie-pairing')).toMatchObject({hash:'a'.repeat(64)});
 available=false;await expect(fake.harness.behavior.callRpc('prepareSandboxV1',{hostId:'host_fixture'},caller)).rejects.toThrow('Sandbox host');
 await expect(fake.harness.behavior.callRpc('prepareSandboxV1',{hostId:'host_fixture'})).rejects.toThrow('Sandboxes plugin required');
 await fake.harness.behavior.callRpc('disconnectBrowserCookies',null);
 const revoked=z.object({status:z.number()}).parse(await fake.harness.behavior.callRpc('legacyHttpV1',{path:'/cookie-sync/snapshot',method:'POST',origin,authorization:'Bearer '+token,body:'{"cookies":[]}'},caller));expect(revoked.status).toBe(401);
 expect(JSON.stringify(fake.harness.logEntries)).not.toContain(token);
});
it("Browser loads without Sandboxes and does not enable fast credentials",async()=>{
 const fake=createFakePluginHost({pluginId:'browser',experimental_hostEntry:true});dispose.push(()=>fake.harness.lifecycle.dispose());await plugin(fake.bb);
 expect(await fake.harness.behavior.callRpc('browserCookieStatus',null)).toMatchObject({paired:false});
 const request=Buffer.from(JSON.stringify({argv:['fast','--allow-model','{"task":"fixture","completion":{"textIncludes":"done"}}']})).toString('base64url');
 const result=await fake.harness.behavior.runCli([request],{threadId:'thr_fixture'});
 expect(result.exitCode).toBe(1);expect(result.stderr).toContain('off');
});
it("viewer grants isolate threads and expire on revoke without exposing a desktop listener",async()=>{
 const fake=createFakePluginHost({pluginId:'browser',experimental_hostEntry:true,experimental_callHostRpc:async({input})=>({ok:true,data:JSON.stringify({data:Buffer.from(z.object({threadId:z.string()}).parse(input).threadId).toString('base64')})})});dispose.push(()=>fake.harness.lifecycle.dispose());
 const viewer=registerViewer(fake.bb),a=new URL(viewer.issue('thr_a','host_a')),b=new URL(viewer.issue('thr_b','host_b'));
 const post=(token:string)=>fake.harness.behavior.fetchHttp('POST','/viewer-control',{headers:{'content-type':'application/json'},body:JSON.stringify({token,action:{type:'frame'}})});
 expect((await post('bad-token')).status).toBe(403);
 const first=await post(a.searchParams.get('token')!);expect(first.status).toBe(200);expect(await first.json()).toEqual({data:Buffer.from('thr_a').toString('base64')});
 viewer.revoke('thr_a');expect((await post(a.searchParams.get('token')!)).status).toBe(403);expect((await post(b.searchParams.get('token')!)).status).toBe(200);
 expect(fake.harness.experimental_hostRpcCalls.map(call=>call.hostId)).toEqual(['host_a','host_b']);
});
it('does not let delayed legacy migration replace a new Browser pairing or authentication seed',async()=>{
 let legacyAvailable=false;const oldToken='l'.repeat(43);
 const connection={tokenHash:createHash('sha256').update(oldToken).digest('hex'),lastSyncAt:1,cookies:1,skippedPartitioned:0,localImported:null};
 const legacyState=JSON.stringify({cookies:[{name:'sid',value:'old-account',domain:'example.test',path:'/',secure:true,httpOnly:true}],origins:[]});
 const fake=createFakePluginHost({pluginId:'browser',experimental_hostEntry:true,sdk:{plugins:{callRpc:async({method})=>{
   if(method==='browserLegacyV1'){if(!legacyAvailable)throw Error('not installed');return {settings:{browserStateFile:'/legacy/all-accounts.json'},connection,pairing:null,state:legacyState} as never;}
   if(method==='browserAccessV1')return {allowed:true} as never;throw Error('Unexpected RPC');
 }}}});dispose.push(()=>fake.harness.lifecycle.dispose());await plugin(fake.bb);
 const pairing=z.object({code:z.string()}).parse(await fake.harness.behavior.callRpc('beginBrowserCookiePairing',null));
 const response=await fake.harness.behavior.fetchHttp('POST','/cookie-sync/pair',{headers:{'content-type':'application/json'},body:JSON.stringify({code:pairing.code})});const {token}=z.object({token:z.string()}).parse(await response.json());
 const snapshot={cookies:[{name:'sid',value:'new-account',domain:'example.test',path:'/',secure:true,httpOnly:true,session:true}]};
 expect((await fake.harness.behavior.fetchHttp('POST','/cookie-sync/snapshot',{headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(snapshot)})).status).toBe(200);
 legacyAvailable=true;const prepared=z.object({state:z.string().nullable()}).parse(await fake.harness.behavior.callRpc('prepareSandboxV1',{hostId:'host_fixture'},{experimental_caller:{kind:'plugin',pluginId:'sandboxes'}}));
 expect(prepared.state).toBeNull();
 const stored=await readFile(join(dirname(fake.bb.storage.database().name),'browser-cookies/state.json'),'utf8');expect(stored).toContain('new-account');expect(stored).not.toContain('old-account');
 expect(await fake.bb.storage.kv.get('browser-cookie-connection')).toMatchObject({tokenHash:createHash('sha256').update(token).digest('hex')});
});

it('applies the two global browser policies to every sandbox without sharing seeds when disabled',async()=>{
 const {makeHostResponse}=await import('@get-bb/plugin-sdk/testing');
 const {writeFile}=await import('node:fs/promises');
 const fake=createFakePluginHost({pluginId:'browser',experimental_hostEntry:true,
  experimental_callHostRpc:async()=>({ok:true}),
  sdk:{hosts:{list:async()=>[
   makeHostResponse({id:'sandbox_a',status:'connected',machineProviderId:'sandbox-daytona'}),
   makeHostResponse({id:'sandbox_b',status:'connected',machineProviderId:'sandbox-modal'}),
   makeHostResponse({id:'local',status:'connected',machineProviderId:null}),
  ]},plugins:{callRpc:async({method})=>{if(method==='browserAccessV1')return {allowed:true}as never;throw Error('No legacy state');}}},
 });dispose.push(()=>fake.harness.lifecycle.dispose());await plugin(fake.bb);
 const file=join(dirname(fake.bb.storage.database().name),'seed.json');
 await writeFile(file,JSON.stringify({cookies:[{name:'sid',value:'private-fixture',domain:'example.test',path:'/'}],origins:[]}));
 const caller={experimental_caller:{kind:'plugin' as const,pluginId:'sandboxes'}};
 const prepare=()=>fake.harness.behavior.callRpc('prepareSandboxV1',{hostId:'sandbox_a'},caller) as Promise<Record<string,unknown>>;
 await fake.harness.behavior.setSettings({homeRouting:true,sharePersonalLogins:true,browserExitNode:'home-fixture',browserStateFile:file});
 expect(await prepare()).toMatchObject({egress:'home',exitNode:'home-fixture',requiredState:'default',access:'isolated'});
 expect((await prepare()).state).toContain('private-fixture');
 await fake.harness.behavior.setSettings({sharePersonalLogins:false});
 expect(await prepare()).toMatchObject({egress:'home',state:null,requiredState:'',legacyLiveSync:false});
 await fake.harness.behavior.runSchedule('browser-settings');
 const calls=fake.harness.experimental_hostRpcCalls;
 expect(new Set(calls.map(call=>call.hostId))).toEqual(new Set(['sandbox_a','sandbox_b']));
 expect(calls.slice(-2).every(call=>JSON.parse((call.input as {payload:string}).payload).state===null)).toBe(true);
 await fake.harness.behavior.setSettings({homeRouting:false});
 expect(await prepare()).toMatchObject({egress:'direct',exitNode:'',state:null});
 expect(JSON.stringify(fake.harness.logEntries)).not.toContain('private-fixture');
});

it('starts standalone without probing or enabling another plugin',async()=>{
 let probes=0;
 const fake=createFakePluginHost({pluginId:'browser',experimental_hostEntry:true,sdk:{plugins:{callRpc:async()=>{probes++;throw Error('Other plugin unavailable');}}}});
 dispose.push(()=>fake.harness.lifecycle.dispose());await plugin(fake.bb);
 expect(probes).toBe(0);
 expect(await fake.harness.behavior.callRpc('browserCookieStatus',null)).toMatchObject({paired:false});
});
