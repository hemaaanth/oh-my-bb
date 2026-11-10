import {createFakePluginHost,makeHostResponse,makeThreadResponse} from '@get-bb/plugin-sdk/testing';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {chmod,copyFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {request} from 'node:http';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Duplex} from 'node:stream';
import {afterEach,expect,it} from 'vitest';
import {registerDesktops} from '../src/desktop.js';
import {SandboxDesktopHost,maximizeRule,openboxConfig,validateDesktop} from '../src/desktop-host.js';
import {desktopHostContract} from '../src/desktop-contract.js';
const connectStatus=async()=>JSON.stringify({state:'connected',url:'https://owner.getbb.app'});
const dispose:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of dispose.splice(0))await close();});
const target={display:':1234',authority:'/private/authority',owner:{pid:42,start:'100'},displayOwner:{pid:43,start:'101'}};
it('binds a desktop grant to the requesting thread host and withdraws only its port on release',async()=>{
 const calls:Array<{method:string;input:unknown}>=[];
 const fake=createFakePluginHost({pluginId:'sandboxes',experimental_hostEntry:true,sharedPortTunnelIdentities:{host_fixture:{label:'sandbox-fixture',baseDomain:'getbb.app'}},experimental_callHostRpc:async call=>{calls.push(call);return call.method==='openDesktop'?{port:41234,expires:Date.now()+900000}:null;},sdk:{threads:{get:async()=>makeThreadResponse({id:'thr_fixture',title:'Browser <upgrade> & handoff',environmentId:'env_fixture'})},environments:{get:async()=>({hostId:'host_fixture'}) as never},hosts:{get:async()=>makeHostResponse({id:'host_fixture',machineProviderId:'sandbox-daytona'})}}});dispose.push(()=>fake.harness.lifecycle.dispose());registerDesktops(fake.bb,undefined,connectStatus);
 const caller={experimental_caller:{kind:'plugin' as const,pluginId:'browser'}};
 await expect(fake.harness.behavior.callRpc('desktopOpenV1',{threadId:'thr_fixture',target})).rejects.toThrow('installed plugin');
 const result=await fake.harness.behavior.callRpc('desktopOpenV1',{threadId:'thr_fixture',target},caller) as {url:string};expect(result.url).toMatch(/^https:\/\/sandbox-fixture--41234.getbb.app\/#[-\w]{43}$/);
 expect(calls[0]?.input).toMatchObject({threadTitle:'Browser <upgrade> & handoff'});
 expect(fake.harness.inspection.sharedPortDeclarations.at(-1)).toMatchObject({hostId:'host_fixture',ports:[41234]});
 await fake.harness.behavior.callRpc('desktopCloseV1',{threadId:'thr_fixture'},{experimental_caller:{kind:'plugin',pluginId:'other-plugin'}});expect(calls).toHaveLength(1);
 await fake.harness.behavior.callRpc('desktopCloseV1',{threadId:'thr_fixture'},caller);expect(calls.at(-1)?.method).toBe('closeDesktop');expect(fake.harness.inspection.sharedPortDeclarations.at(-1)).toMatchObject({hostId:'host_fixture',ports:[]});
});
it('shares a consumer private display on the server machine through bb connect but keeps the shared screen sandbox-only',async()=>{
 const calls:Array<{method:string;input:unknown}>=[],cli:string[][]=[];
 const fake=createFakePluginHost({pluginId:'sandboxes',experimental_hostEntry:true,experimental_callHostRpc:async call=>{calls.push(call);return call.method==='openDesktop'?{port:41234,expires:Date.now()+900000}:null;},sdk:{threads:{get:async()=>makeThreadResponse({id:'thr_fixture',title:'Local',environmentId:'env_fixture'})},environments:{get:async()=>({hostId:'host_local'}) as never},hosts:{get:async()=>makeHostResponse({id:'host_local',machineProviderId:null})}}});dispose.push(()=>fake.harness.lifecycle.dispose());
 registerDesktops(fake.bb,undefined,async args=>{cli.push(args);return args[1]==='status'?JSON.stringify({state:'connected',url:'https://owner.getbb.app'}):'{}';});
 const caller={experimental_caller:{kind:'plugin' as const,pluginId:'browser'}};
 expect(await fake.harness.behavior.callRpc('desktopOpenV1',{threadId:'thr_fixture',target},caller)).toMatchObject({url:expect.stringMatching(/^https:\/\/owner--41234.getbb.app\/#[-\w]{43}$/)});
 expect(calls[0]).toMatchObject({method:'openDesktop',input:{tunnel:{label:'owner',baseDomain:'getbb.app'}}});
 expect(cli).toEqual([['connect','status','--json'],['connect','expose','41234','--host','host_local','--json']]);
 await expect(fake.harness.behavior.callRpc('openSandboxDesktop',{threadId:'thr_fixture',viewOnly:true})).rejects.toThrow('sandbox desktop is required');
 await fake.harness.behavior.callRpc('desktopCloseV1',{threadId:'thr_fixture'},caller);
 expect(calls.map(call=>call.method)).toEqual(['openDesktop','closeDesktop']);
 expect(cli.at(-1)).toEqual(['connect','unexpose','41234','--host','host_local']);
 expect(fake.harness.inspection.sharedPortDeclarations.filter(value=>value.hostId==='host_local')).toEqual([]);
});
it('opens one shared desktop per thread for the panel, the directive and the agent tool',async()=>{
 const calls:Array<{method:string;input:unknown}>=[];
 const fake=createFakePluginHost({pluginId:'sandboxes',experimental_hostEntry:true,sharedPortTunnelIdentities:{host_fixture:{label:'sandbox-fixture',baseDomain:'getbb.app'}},experimental_callHostRpc:async call=>{calls.push(call);return call.method==='openSharedDesktop'?{port:42000,expires:Date.now()+900000}:null;},sdk:{threads:{get:async()=>makeThreadResponse({id:'thr_fixture',title:'Desk',environmentId:'env_fixture'})},environments:{get:async()=>({hostId:'host_fixture'}) as never},hosts:{get:async()=>makeHostResponse({id:'host_fixture',machineProviderId:'sandbox-daytona'})}}});dispose.push(()=>fake.harness.lifecycle.dispose());registerDesktops(fake.bb,undefined,connectStatus);
 expect(await fake.harness.behavior.callRpc('getSandboxDesktop',{threadId:'thr_fixture'})).toEqual({kind:'closed'});
 const view=await fake.harness.behavior.callRpc('openSandboxDesktop',{threadId:'thr_fixture',viewOnly:false});
 expect(view).toMatchObject({kind:'open',viewOnly:false,url:expect.stringMatching(/^https:\/\/sandbox-fixture--42000.getbb.app\/#[-\w]{43}$/)});
 expect(calls[0]).toMatchObject({method:'openSharedDesktop',input:{viewOnly:false,threadTitle:'Desk'}});expect(calls[0]?.input).not.toHaveProperty('target');
 expect(await fake.harness.behavior.callRpc('getSandboxDesktop',{threadId:'thr_fixture'})).toEqual(view);expect(view).not.toHaveProperty('agent');
 expect(fake.harness.inspection.realtimeSignals.filter(signal=>signal.channel==='sandbox-desktop:thr_fixture')).toHaveLength(1);
 expect(await fake.harness.behavior.callAgentTool('sandbox_desktop',{action:'open'},{threadId:'thr_fixture'})).toContain('::sandbox-desktop{}');
 // Mode replacement closes the old grant before opening the next one.
 expect(calls.map(call=>call.method)).toEqual(['openSharedDesktop','closeDesktop','openSharedDesktop']);
 const sessions=[calls[0],calls[2]].map(call=>(call!.input as {id:string}).id);expect(sessions[0]).toEqual(sessions[1]);
 expect(calls[2]).toMatchObject({input:{viewOnly:true}});expect(await fake.harness.behavior.callRpc('getSandboxDesktop',{threadId:'thr_fixture'})).toMatchObject({kind:'open',viewOnly:true,agent:true});
 await fake.harness.behavior.callAgentTool('sandbox_desktop',{action:'close'},{threadId:'thr_fixture'});
 expect(calls.map(call=>call.method)).toEqual(['openSharedDesktop','closeDesktop','openSharedDesktop','closeDesktop']);
 expect((calls[3]!.input as {id:string}).id).toBe(sessions[1]);
 expect(await fake.harness.behavior.callRpc('getSandboxDesktop',{threadId:'thr_fixture'})).toEqual({kind:'closed'});
 expect(fake.harness.inspection.sharedPortDeclarations.at(-1)).toMatchObject({hostId:'host_fixture',ports:[]});
});
it('maximizes desktop windows on top of the system openbox config',()=>{
 expect(openboxConfig('<openbox_config><applications><application class="x"/></applications></openbox_config>')).toBe('<openbox_config><applications><application class="x"/>'+maximizeRule+'</applications></openbox_config>');
 expect(openboxConfig(null)).toContain('<applications>'+maximizeRule+'</applications>');
});
it('rejects stale or non-owned displays before launching voxl',async()=>{
 await expect(validateDesktop(target)).rejects.toThrow('no longer running');
});

// Answers like voxl: /healthz is public, every other reply echoes what the proxy forwarded.
const fakeVoxl=`#!${process.execPath}
const http=require('node:http'),port=Number(process.argv.find(a=>a.startsWith('--port=')).slice(7));
const seen=req=>JSON.stringify({url:req.url,auth:req.headers.authorization,host:req.headers.host,origin:req.headers.origin??null,cookie:req.headers.cookie??null,password:process.env.VOXL_PASSWORD,display:process.env.DISPLAY,args:process.argv.slice(2)});
const server=http.createServer((req,res)=>{if(req.url==='/healthz'){res.end('ok');return;}res.setHeader('Connection','keep-alive');res.end(seen(req));});
server.on('upgrade',(req,socket)=>{setTimeout(()=>{if(socket.destroyed)return;socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nX-Seen: '+Buffer.from(seen(req)).toString('base64')+'\\r\\n\\r\\n');socket.pipe(socket);},new URL(req.url,'http://fixture').searchParams.has('delay')?500:0);});
server.listen(port,'127.0.0.1');`;
const started=async(pid:number)=>{const text=await readFile(`/proc/${pid}/stat`,'utf8');return text.slice(text.lastIndexOf(')')+2).split(' ')[19]!;};
async function upgrade(port:number,path:string,origin:string){
 return await new Promise<{status:number;socket?:Duplex;seen?:Record<string,unknown>}>((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port,path,headers:{Connection:'Upgrade',Upgrade:'websocket',Origin:origin}});
  req.once('upgrade',(res,socket)=>resolve({status:101,socket,seen:JSON.parse(Buffer.from(String(res.headers['x-seen']),'base64').toString())}));
  req.once('response',res=>{res.resume();resolve({status:res.statusCode!});});req.once('error',reject);req.end();
 });
}
it.skipIf(process.platform!=='linux')('proxies an owned display through voxl with the session token and only from the tunnel origin',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'bb-desktop-'));dispose.push(()=>rm(directory,{recursive:true,force:true}));
 const authority=join(directory,'authority');await writeFile(authority,'',{mode:0o600});
 await writeFile(join(directory,'voxl'),fakeVoxl);await chmod(join(directory,'voxl'),0o755);
 // validateDesktop reads the X server's binary name and flags from /proc.
 await copyFile('/bin/sh',join(directory,'Xvfb'));await chmod(join(directory,'Xvfb'),0o755);
 const x=spawn(join(directory,'Xvfb'),['-c','sleep 60; :',':77','-screen','0','1920x1080x24','-auth',authority,'-nolisten','tcp'],{stdio:'ignore'});dispose.push(async()=>{x.kill();});
 await new Promise(resolve=>x.once('spawn',resolve));
 const target={display:':77',authority,owner:{pid:process.pid,start:await started(process.pid)},displayOwner:{pid:x.pid!,start:await started(x.pid!)}};
 const path=process.env.PATH;dispose.push(async()=>{process.env.PATH=path;});
 const host=new SandboxDesktopHost();dispose.push(()=>host.dispose());
 const token=randomBytes(32).toString('base64url');
 const input={id:'desk',target,appOrigins:['http://127.0.0.1:38886','https://owner.getbb.app','https://configured.example'],threadTitle:'Thread',token,notices:'NOTICES',tunnel:{label:'sbx',baseDomain:'getbb.app'}};
 const home=process.env.HOME;dispose.push(async()=>{process.env.HOME=home;});
 process.env.PATH='/nonexistent';process.env.HOME=directory;
 await expect(host.open(input,AbortSignal.timeout(5000))).rejects.toThrow('no voxl');
 process.env.PATH=directory+':'+path;process.env.HOME=home;
 const {port}=await host.open(input,AbortSignal.timeout(10000)),base=`http://127.0.0.1:${port}`,origin=base;
 const get=async(route:string,init?:RequestInit)=>{const res=await fetch(base+route,init);return {status:res.status,text:await res.text(),policy:res.headers.get('content-security-policy')};};
 expect((await get('/')).text).toContain('/bb-desktop-start.js');
 expect((await get('/licenses')).text).toBe('NOTICES');
 const leaseRequest=async(action:string,extra:Record<string,unknown>={})=>{
  const response=await fetch(base+'/viewer-lease',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({action,...extra})});return {status:response.status,...await response.json()};
 };
 expect((await get(`/?token=${token}`)).text).toContain('/bb-desktop-start.js');
 expect((await get(`/view?token=${token}`)).status).toBe(403);
 const {lease}=await leaseRequest('acquire');expect(lease).toMatch(/^[-\w]{43}$/);
 expect((await leaseRequest('acquire')).lease).toBeNull();
 const page=await get(`/view?token=${token}&lease=${lease}&x=1`),seen=JSON.parse(page.text);
 expect(seen).toMatchObject({url:'/?x=1',host:expect.stringMatching(/^127\.0\.0\.1:\d+$/),origin:null,cookie:null,display:':77'});
 expect(seen.auth).toBe('Bearer '+seen.password);expect(seen.password).not.toContain(token);
 expect(seen.args).toContain('--enable-resize=false');
 expect(page.policy).toBe("frame-ancestors 'self' http://127.0.0.1:38886 https://owner.getbb.app https://configured.example");
 expect((await get('/client.js')).status).toBe(200);
 for(const route of ['/stats','/?token='+'x'.repeat(43),`/files/a?token=${token}&lease=${lease}`])if(!route.startsWith('/?'))expect((await get(route)).status).toBe(403);
 expect((await get(`/stats?token=${token}&lease=${lease}`)).status).toBe(200);
 expect((await get('/viewer-lease',{method:'POST',headers:{Origin:'https://evil.example',Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{\"action\":\"acquire\",\"takeover\":true}'})).status).toBe(403);
 expect((await upgrade(port,`/ws?token=${token}&lease=${lease}`,'https://evil.example')).status).toBe(403);
 expect((await upgrade(port,`/ws?token=${token}`,origin)).status).toBe(403);
 const first=await upgrade(port,`/ws?token=${token}&lease=${lease}&v=2`,origin);
 expect(first.seen).toMatchObject({url:'/ws?v=2',origin:null});
 expect((await upgrade(port,`/ws?token=${token}&lease=${lease}`,origin)).status).toBe(403);
 const echo=await new Promise<string>(resolve=>{first.socket!.once('data',data=>resolve(String(data)));first.socket!.write('frame');});expect(echo).toBe('frame');
 const ticket=(await leaseRequest('transfer',{lease})).ticket;
 // Issuing a ticket does not interrupt the current stream.
 expect((await leaseRequest('status',{lease})).current).toBe(true);
 const gone=new Promise(resolve=>first.socket!.once('close',resolve));
 const next=(await leaseRequest('acquire',{ticket})).lease;await gone;
 expect((await leaseRequest('acquire',{ticket})).lease).toBeNull();
 expect((await upgrade(port,`/ws?token=${token}&lease=${lease}`,origin)).status).toBe(403);
 const second=await upgrade(port,`/ws?token=${token}&lease=${next}`,origin);expect(second.status).toBe(101);
 second.socket!.destroy();
 await new Promise(resolve=>setTimeout(resolve,20));
 const reconnect=await upgrade(port,`/ws?token=${token}&lease=${next}`,origin);expect(reconnect.status).toBe(101);reconnect.socket!.destroy();
 await new Promise(resolve=>setTimeout(resolve,20));
 // A pending upstream handshake is retired before another lease can connect.
 const pending=upgrade(port,`/ws?token=${token}&lease=${next}&delay=1`,origin).catch(()=>({status:0}));
 await new Promise(resolve=>setTimeout(resolve,50));
 const last=(await leaseRequest('acquire',{takeover:true})).lease;
 expect((await pending).status).not.toBe(101);
 await new Promise(resolve=>setTimeout(resolve,550));
 expect((await upgrade(port,`/ws?token=${token}&lease=${next}`,origin)).status).toBe(403);
 const current=await upgrade(port,`/ws?token=${token}&lease=${last}`,origin);expect(current.status).toBe(101);
 const voxlGone=new Promise(resolve=>current.socket!.once('close',resolve));
 await host.close('desk');await voxlGone;
 await expect(fetch(base+'/')).rejects.toThrow();
});
it.skipIf(process.platform!=='linux')('accepts an owned TigerVNC display under its Arch name Xvnc',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'bb-desktop-'));dispose.push(()=>rm(directory,{recursive:true,force:true}));
 const authority=join(directory,'authority'),vncSocket=join(directory,'vnc.sock');await writeFile(authority,'',{mode:0o600});
 const socket=createServer();await new Promise<void>(resolve=>socket.listen(vncSocket,resolve));dispose.push(()=>new Promise(resolve=>socket.close(()=>resolve())));await chmod(vncSocket,0o600);
 await copyFile('/bin/sh',join(directory,'Xvnc'));await chmod(join(directory,'Xvnc'),0o755);
 const x=spawn(join(directory,'Xvnc'),['-c','sleep 60; :',':78','-geometry','1920x1080','-AcceptSetDesktopSize','0','-rfbport','-1','-rfbunixpath',vncSocket,'-nolisten','tcp','-auth',authority],{stdio:'ignore'});dispose.push(async()=>{x.kill();});
 await new Promise(resolve=>x.once('spawn',resolve));
 const owned={display:':78',authority,vncSocket,owner:{pid:process.pid,start:await started(process.pid)},displayOwner:{pid:x.pid!,start:await started(x.pid!)}};
 await expect(validateDesktop(owned)).resolves.toBeUndefined();
 await chmod(vncSocket,0o666);await expect(validateDesktop(owned)).rejects.toThrow('private VNC socket');
});
it.skipIf(process.platform!=='linux')('starts and streams the sandbox display without an authority file',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'bb-desktop-'));dispose.push(()=>rm(directory,{recursive:true,force:true}));
 await writeFile(join(directory,'voxl'),fakeVoxl);await chmod(join(directory,'voxl'),0o755);
 await copyFile('/bin/sh',join(directory,'Xvfb'));await chmod(join(directory,'Xvfb'),0o755);
 // Stands in for bb-sandbox-display: it starts the shared Xvfb and records its display.
 await writeFile(join(directory,'bb-sandbox-display'),`#!/bin/sh\n"${directory}/Xvfb" -c 'sleep 60; :' :88 -screen 0 1920x1080x24 -nolisten tcp >/dev/null 2>&1 &\necho $! > "${directory}/pid"\n`);await chmod(join(directory,'bb-sandbox-display'),0o755);
 await writeFile(join(directory,'display'),':88');
 const env={PATH:process.env.PATH,BB_DATA_DIR:process.env.BB_DATA_DIR};dispose.push(async()=>{process.env.PATH=env.PATH;if(env.BB_DATA_DIR===undefined)delete process.env.BB_DATA_DIR;else process.env.BB_DATA_DIR=env.BB_DATA_DIR;});
 dispose.push(async()=>{const pid=await readFile(join(directory,'pid'),'utf8').catch(()=>'');if(pid.trim())try{process.kill(Number(pid));}catch{}});
 process.env.PATH=directory+':'+env.PATH;process.env.BB_DATA_DIR=directory;
 const host=new SandboxDesktopHost();dispose.push(()=>host.dispose());
 const token=randomBytes(32).toString('base64url');
 const {port}=await host.openShared({id:'shared',threadTitle:'Thread',token,notices:'',tunnel:{label:'sbx',baseDomain:'getbb.app'}},AbortSignal.timeout(10000));
 const base=`http://127.0.0.1:${port}`;
 const {lease}=await(await fetch(base+'/viewer-lease',{method:'POST',headers:{Origin:base,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{\"action\":\"acquire\"}'})).json() as {lease:string};
 const seen=JSON.parse(await (await fetch(base+`/view?token=${token}&lease=${lease}`)).text());
 expect(seen).toMatchObject({display:':88',auth:'Bearer '+seen.password});
 // Resizing would leave the sandbox's windows off-screen and move the agent's click targets.
 expect(seen.args).not.toContain('--enable-resize=true');
 await host.close('shared');
});

it('drains a pending open before close and never overlaps mode replacements',async()=>{
 let finish!:()=>void,started!:()=>void;
 const opening=new Promise<void>(resolve=>{finish=resolve;}),began=new Promise<void>(resolve=>{started=resolve;});
 let count=0,max=0;
 const methods:string[]=[];
 const fake=createFakePluginHost({pluginId:'sandboxes',experimental_hostEntry:true,sharedPortTunnelIdentities:{host_fixture:{label:'fixture',baseDomain:'getbb.app'}},experimental_callHostRpc:async({method})=>{
  methods.push(method);
  if(method==='openSharedDesktop'){count++;max=Math.max(count,max);started();await opening;return {port:42000,expires:Date.now()+900000};}
  if(method==='closeDesktop')count--;
  return null;
 },sdk:{threads:{get:async()=>makeThreadResponse({id:'thr_fixture',environmentId:'env_fixture'})},environments:{get:async()=>({hostId:'host_fixture'}) as never},hosts:{get:async()=>makeHostResponse({id:'host_fixture',machineProviderId:'sandbox-daytona'})}}});
 dispose.push(()=>fake.harness.lifecycle.dispose());const desktop=registerDesktops(fake.bb,undefined,connectStatus);
 const first=desktop.open('thr_fixture',true);await began;
 const replacement=desktop.open('thr_fixture',false),closed=desktop.close('thr_fixture');
 finish();await Promise.all([first,replacement,closed]);
 expect(methods).toEqual(['openSharedDesktop','closeDesktop','openSharedDesktop','closeDesktop']);
 expect(max).toBe(1);expect(count).toBe(0);expect(desktop.view('thr_fixture')).toEqual({kind:'closed'});
});

it.each([false,true])('retains an unconfirmed %s pending/live owner and hold until close succeeds',async(failOpen)=>{
 let rejectClose=true,count=0;
 const holds=new Set<string>(),sessions=new Set<string>();
 const fake=createFakePluginHost({pluginId:'sandboxes',experimental_hostEntry:true,sharedPortTunnelIdentities:{host_fixture:{label:'fixture',baseDomain:'getbb.app'}},experimental_callHostRpc:async({method,input})=>{
  const id=(input as {id:string}).id;sessions.add(id);
  if(method==='openSharedDesktop'){count++;if(failOpen)throw Error('Open acknowledgement lost');return {port:42000,expires:Date.now()+900000};}
  if(method==='closeDesktop'){if(rejectClose)throw Error('Close acknowledgement lost');count--;}
  return null;
 },sdk:{threads:{get:async()=>makeThreadResponse({id:'thr_fixture',environmentId:'env_fixture'})},environments:{get:async()=>({hostId:'host_fixture'}) as never},hosts:{get:async()=>makeHostResponse({id:'host_fixture',machineProviderId:'sandbox-daytona'})}}});
 dispose.push(async()=>{rejectClose=false;await fake.harness.lifecycle.dispose();});
 const desktop=registerDesktops(fake.bb,()=>({hold:(_host:string,key:string)=>holds.add(key),release:(_host:string,key:string)=>holds.delete(key)}) as never,connectStatus);
 if(failOpen)await expect(desktop.open('thr_fixture',true)).rejects.toThrow();else await desktop.open('thr_fixture',true);
 await expect(desktop.close('thr_fixture')).rejects.toThrow();expect(count).toBe(1);expect(holds.size).toBe(1);
 await expect(desktop.open('thr_fixture',false)).rejects.toThrow();expect(count).toBe(1);expect(sessions.size).toBe(1);
 rejectClose=false;await desktop.close('thr_fixture');
 expect(count).toBe(0);expect(holds.size).toBe(0);expect(desktop.view('thr_fixture')).toEqual({kind:'closed'});
});

it.each([null,'https://configured.example'])('carries only this server origins through the desktop host parser with app URL %s',async(appUrl)=>{
 let payload:unknown;
 const fake=createFakePluginHost({pluginId:'sandboxes',appUrl,loopbackBaseUrl:'http://127.0.0.1:38886',experimental_hostEntry:true,sharedPortTunnelIdentities:{host_fixture:{label:'remote-sandbox',baseDomain:'getbb.app'}},experimental_callHostRpc:async({method,input})=>{if(method==='openDesktop'){payload=input;return {port:41234,expires:Date.now()+900000};}return null;},sdk:{threads:{get:async()=>makeThreadResponse({id:'thr_fixture',environmentId:'env_fixture'})},environments:{get:async()=>({hostId:'host_fixture'}) as never},hosts:{get:async()=>makeHostResponse({id:'host_fixture',machineProviderId:'sandbox-daytona'})}}});
 dispose.push(()=>fake.harness.lifecycle.dispose());registerDesktops(fake.bb,undefined,connectStatus);
 const caller={experimental_caller:{kind:'plugin' as const,pluginId:'browser'}};
 await fake.harness.behavior.callRpc('desktopOpenV1',{threadId:'thr_fixture',target},caller);
 const parsed=desktopHostContract.openDesktop.input.parse(JSON.parse(JSON.stringify(payload)));
 expect(parsed.appOrigins).toEqual(['http://127.0.0.1:38886',...appUrl?[appUrl]:[],'https://owner.getbb.app']);
 expect(parsed.appOrigins).not.toContain('https://remote-sandbox.getbb.app');
 await expect(fake.harness.behavior.callRpc('desktopOpenV1',{threadId:'thr_fixture',target,appOrigins:['https://other.getbb.app']},caller)).rejects.toThrow();
});
