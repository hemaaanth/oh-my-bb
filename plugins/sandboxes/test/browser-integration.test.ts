import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import { registerBrowserIntegration } from "../src/browser-integration.js";
import { provisionTrustedBrowser } from "../src/trusted-browser.js";
const dispose:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const fn of dispose.splice(0))await fn();});
it('allows every sandbox project regardless of old per-project grants',async()=>{
 const environments=[{projectId:'allowed'}];
 const fake=createFakePluginHost({pluginId:'sandboxes',sdk:{hosts:{list:async()=>[],get:async()=>makeHostResponse({id:'host_fixture',machineProviderId:'sandbox-daytona'})},environments:{list:async()=>environments as never},projects:{get:async({projectId})=>({id:projectId,name:projectId}) as never}}});dispose.push(()=>fake.harness.lifecycle.dispose());
 const current={browserProjects:'allowed',browserUserAgent:'',browserExitNode:'',browserHomeEgressIp:'',browserTailscaleAuthKey:'',browserTailscaleAuthKeyFile:'',browserStateFile:''};
 registerBrowserIntegration(fake.bb,async()=>current,'/nonexistent/fixture',()=>undefined);
 const caller={experimental_caller:{kind:'plugin' as const,pluginId:'browser'}};
 expect(await fake.harness.behavior.callRpc('browserAccessV1',{hostId:'host_fixture'},caller)).toEqual({allowed:true});
 environments.push({projectId:'private'});
 await fake.bb.storage.kv.set('browser-project-grants',{allowed:false,private:false});
 expect(await fake.harness.behavior.callRpc('browserAccessV1',{hostId:'host_fixture'},caller)).toEqual({allowed:true});
 await expect(fake.harness.behavior.callRpc('browserLegacyV1',null)).rejects.toThrow('Browser plugin required');
});
it('withholds credentials and keeps machine preparation working when Browser is absent',async()=>{
 const fake=createFakePluginHost({pluginId:'sandboxes'});dispose.push(()=>fake.harness.lifecycle.dispose());
 let received:unknown;const logs:string[]=[];
 await provisionTrustedBrowser({bb:fake.bb,hostId:'host_fixture',enabled:true,signal:new AbortController().signal,executor:{exec:async (request:{stdin?:string})=>{received=JSON.parse(request.stdin||'{}');return {exitCode:0};}} as never,report:{log:(line:string)=>logs.push(line)} as never});
 expect(received).toBeUndefined();expect(logs.join(' ')).toContain('no browser identity was provisioned');
});
it('shares the Sandboxes enrollment key unless Browser explicitly overrides it',async()=>{
 const enrollments:Array<{authKey:string;generation?:string}>=[];
 const releases:unknown[]=[];
 const fake=createFakePluginHost({pluginId:'sandboxes',experimental_hostEntry:true,experimental_callHostRpc:async({method,input})=>{if(method==='releaseBrowserNetwork'){releases.push(input);return null;}enrollments.push(input as {authKey:string});return {socket:'/private/tailscaled.sock',proxyPort:1080,client:'tailscale'};},sdk:{hosts:{get:async()=>makeHostResponse({id:'host_fixture',machineProviderId:'sandbox-daytona'})},environments:{list:async()=>[{projectId:'allowed'}] as never},projects:{get:async()=>({id:'allowed',name:'allowed'}) as never}}});dispose.push(()=>fake.harness.lifecycle.dispose());
 registerBrowserIntegration(fake.bb,async()=>({browserProjects:'allowed',browserUserAgent:'',browserExitNode:'',browserHomeEgressIp:'',browserTailscaleAuthKey:'',browserTailscaleAuthKeyFile:'',browserStateFile:'',sshAuthKey:'shared-fixture-key'}),'/nonexistent/fixture',()=>undefined);
 const caller={experimental_caller:{kind:'plugin' as const,pluginId:'browser'}};
 const input={hostId:'host_fixture',threadId:'thr_fixture',held:true,exitNode:'home'};
 const result=await fake.harness.behavior.callRpc('browserNetworkV1',input,caller);
 expect(enrollments[0]?.authKey).toBe('shared-fixture-key');expect(JSON.stringify(result)).not.toContain('fixture-key');
 await fake.harness.behavior.callRpc('browserNetworkV1',{...input,authKey:'override-fixture-key',generation:'a'.repeat(32)},caller);
 expect(enrollments[1]).toMatchObject({authKey:'override-fixture-key',generation:'a'.repeat(32)});
 await fake.harness.behavior.callRpc('browserNetworkV1',{...input,held:false,generation:'a'.repeat(32)},caller);
 expect(releases).toEqual([{threadId:input.threadId,generation:'a'.repeat(32)}]);
 await expect(fake.harness.behavior.callRpc('browserNetworkV1',input)).rejects.toThrow('Browser plugin required');expect(enrollments).toHaveLength(2);
});

it("keeps the retired native Browser key available only to the verified migration caller", async () => {
 const directory=await mkdtemp(join(tmpdir(), 'sandbox-browser-migration-'));
 const fake=createFakePluginHost({pluginId:'sandboxes'});
 try {
  await mkdir(join(directory,'secrets'));
  await writeFile(join(directory,'secrets','browserTailscaleAuthKey'),'fixture-retained-key',{mode:0o600});
  registerBrowserIntegration(fake.bb,async()=>({browserUserAgent:'',browserExitNode:'',browserHomeEgressIp:'',browserTailscaleAuthKey:'',browserTailscaleAuthKeyFile:'',browserStateFile:''}),join(directory,'browser-cookies'),()=>undefined);
  await expect(fake.harness.behavior.callRpc('browserLegacyV1',null)).rejects.toThrow('Browser plugin required');
  const result=await fake.harness.behavior.callRpc('browserLegacyV1',null,{experimental_caller:{kind:'plugin',pluginId:'browser'}}) as {settings:Record<string,string>};
  expect(result.settings.browserTailscaleAuthKey).toBe('fixture-retained-key');
 } finally {await fake.harness.dispose();await rm(directory,{recursive:true,force:true});}
});
