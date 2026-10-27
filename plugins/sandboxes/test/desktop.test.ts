import {createFakePluginHost,makeHostResponse,makeThreadResponse} from '@get-bb/plugin-sdk/testing';
import {afterEach,expect,it} from 'vitest';
import {registerDesktops} from '../src/desktop.js';
import {validateDesktop} from '../src/desktop-host.js';
const dispose:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of dispose.splice(0))await close();});
const target={display:':1234',authority:'/private/authority',owner:{pid:42,start:'100'},displayOwner:{pid:43,start:'101'}};
it('binds a desktop grant to the requesting thread host and withdraws only its port on release',async()=>{
 const calls:Array<{method:string;input:unknown}>=[];
 const fake=createFakePluginHost({pluginId:'sandboxes',experimental_hostEntry:true,sharedPortTunnelIdentities:{host_fixture:{label:'sandbox-fixture',baseDomain:'getbb.app'}},experimental_callHostRpc:async call=>{calls.push(call);return call.method==='openDesktop'?{port:41234,expires:Date.now()+900000}:null;},sdk:{threads:{get:async()=>makeThreadResponse({id:'thr_fixture',title:'Browser <upgrade> & handoff',environmentId:'env_fixture'})},environments:{get:async()=>({hostId:'host_fixture'}) as never},hosts:{get:async()=>makeHostResponse({id:'host_fixture',machineProviderId:'sandbox-daytona'})}}});dispose.push(()=>fake.harness.lifecycle.dispose());registerDesktops(fake.bb);
 const caller={experimental_caller:{kind:'plugin' as const,pluginId:'browser'}};
 await expect(fake.harness.behavior.callRpc('desktopOpenV1',{threadId:'thr_fixture',target})).rejects.toThrow('installed plugin');
 const result=await fake.harness.behavior.callRpc('desktopOpenV1',{threadId:'thr_fixture',target},caller) as {url:string};expect(result.url).toMatch(/^https:\/\/sandbox-fixture--41234.getbb.app\/#[-\w]{43}$/);
 expect(calls[0]?.input).toMatchObject({threadTitle:'Browser <upgrade> & handoff'});
 expect(fake.harness.inspection.sharedPortDeclarations.at(-1)).toMatchObject({hostId:'host_fixture',ports:[41234]});
 await fake.harness.behavior.callRpc('desktopCloseV1',{threadId:'thr_fixture'},{experimental_caller:{kind:'plugin',pluginId:'other-plugin'}});expect(calls).toHaveLength(1);
 await fake.harness.behavior.callRpc('desktopCloseV1',{threadId:'thr_fixture'},caller);expect(calls.at(-1)?.method).toBe('closeDesktop');expect(fake.harness.inspection.sharedPortDeclarations.at(-1)).toMatchObject({hostId:'host_fixture',ports:[]});
});
it('rejects stale or non-owned displays before launching VNC',async()=>{
 await expect(validateDesktop(target)).rejects.toThrow('no longer running');
});
