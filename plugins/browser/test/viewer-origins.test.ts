import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {afterEach,expect,it,vi} from 'vitest';
import {registerViewer} from '../src/viewer.js';

const dispose:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of dispose.splice(0))await close();});
const loopback='http://127.0.0.1:38886',remote='https://owner.getbb.app',configured='https://configured.example';
it.each([null,configured])('accepts own Connect and loopback for page controls with configured URL %s',async(appUrl)=>{
 const connect=vi.fn(async()=>JSON.stringify({state:'connected',url:remote}));
 const fake=createFakePluginHost({pluginId:'browser',appUrl,loopbackBaseUrl:loopback,experimental_hostEntry:true,experimental_callHostRpc:async()=>({ok:true,data:JSON.stringify({data:'fixture-frame'})})});
 dispose.push(()=>fake.harness.lifecycle.dispose());
 const viewer=registerViewer(fake.bb,connect);expect(connect).not.toHaveBeenCalled();
 const issued=await viewer.issue('thr_fixture','host_fixture');
 expect(issued.startsWith('/api/')).toBe(true);
 const localUrl=new URL(issued,loopback),remoteUrl=new URL(issued,remote);
 expect(localUrl.origin).toBe(loopback);expect(remoteUrl.origin).toBe(remote);
 const token=localUrl.searchParams.get('token');
 const page=await fake.harness.behavior.fetchHttp('GET','/viewer?token='+token);
 const policy=page.headers.get('content-security-policy');
 for(const origin of [loopback,remote,...appUrl?[appUrl]:[]]){
  expect(policy).toContain(origin);
  const headers={'content-type':'application/json',origin};
  const lease=await fake.harness.behavior.fetchHttp('POST','/viewer-lease',{headers,body:JSON.stringify({token,takeover:true})});
  expect(lease.status).toBe(200);const {owner}=await lease.json() as {owner:string};
  const input=await fake.harness.behavior.fetchHttp('POST','/viewer-control',{headers,body:JSON.stringify({token,owner,action:{type:'frame'}})});
  expect(input.status).toBe(200);expect(await input.json()).toEqual({data:'fixture-frame'});
 }
 expect(policy).not.toContain('*.getbb.app');
 const calls=fake.harness.experimental_hostRpcCalls.length;
 for(const origin of ['https://other.getbb.app','https://owner--40000.getbb.app','https://evil.example','null','']){
  const headers={'content-type':'application/json',origin};
  expect((await fake.harness.behavior.fetchHttp('POST','/viewer-lease',{headers,body:JSON.stringify({token,takeover:true})})).status).toBe(403);
  expect((await fake.harness.behavior.fetchHttp('POST','/viewer-control',{headers,body:JSON.stringify({token,owner:'x'.repeat(43),action:{type:'frame'}})})).status).toBe(403);
 }
 expect(fake.harness.experimental_hostRpcCalls.length).toBe(calls);
 expect(connect).toHaveBeenCalledOnce();
});
it('does not authorize a disconnected Connect origin',async()=>{
 const fake=createFakePluginHost({pluginId:'browser',loopbackBaseUrl:loopback});dispose.push(()=>fake.harness.lifecycle.dispose());
 const viewer=registerViewer(fake.bb,async()=>JSON.stringify({state:'disconnected',url:remote}));
 const token=new URL(await viewer.issue('thr_fixture','host_fixture'),loopback).searchParams.get('token');
 expect((await fake.harness.behavior.fetchHttp('POST','/viewer-lease',{headers:{'content-type':'application/json',origin:remote},body:JSON.stringify({token,takeover:true})})).status).toBe(403);
});
