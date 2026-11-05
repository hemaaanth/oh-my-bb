import {createFakePluginHost,makeHostResponse,makeThreadResponse} from '@get-bb/plugin-sdk/testing';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {chmod,copyFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Duplex} from 'node:stream';
import {afterEach,expect,it} from 'vitest';
import {registerDesktops} from '../src/desktop.js';
import {SandboxDesktopHost,validateDesktop} from '../src/desktop-host.js';
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
it('rejects stale or non-owned displays before launching voxl',async()=>{
 await expect(validateDesktop(target)).rejects.toThrow('no longer running');
});

// Answers like voxl: /healthz is public, every other reply echoes what the proxy forwarded.
const fakeVoxl=`#!${process.execPath}
const http=require('node:http'),port=Number(process.argv.find(a=>a.startsWith('--port=')).slice(7));
const seen=req=>JSON.stringify({url:req.url,auth:req.headers.authorization,host:req.headers.host,origin:req.headers.origin??null,cookie:req.headers.cookie??null,password:process.env.VOXL_PASSWORD,display:process.env.DISPLAY});
const server=http.createServer((req,res)=>{if(req.url==='/healthz'){res.end('ok');return;}res.setHeader('Connection','keep-alive');res.end(seen(req));});
server.on('upgrade',(req,socket)=>{socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nX-Seen: '+Buffer.from(seen(req)).toString('base64')+'\\r\\n\\r\\n');socket.pipe(socket);});
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
 const x=spawn(join(directory,'Xvfb'),['-c','sleep 60; :',':77','-auth',authority,'-nolisten','tcp'],{stdio:'ignore'});dispose.push(async()=>{x.kill();});
 await new Promise(resolve=>x.once('spawn',resolve));
 const target={display:':77',authority,owner:{pid:process.pid,start:await started(process.pid)},displayOwner:{pid:x.pid!,start:await started(x.pid!)}};
 const path=process.env.PATH;dispose.push(async()=>{process.env.PATH=path;});
 const host=new SandboxDesktopHost();dispose.push(()=>host.dispose());
 const token=randomBytes(32).toString('base64url');
 const input={id:'desk',target,threadTitle:'Thread',token,notices:'NOTICES',tunnel:{label:'sbx',baseDomain:'getbb.app'}};
 process.env.PATH='/nonexistent';
 await expect(host.open(input,AbortSignal.timeout(5000))).rejects.toThrow('no voxl');
 process.env.PATH=directory+':'+path;
 const {port}=await host.open(input,AbortSignal.timeout(10000)),base=`http://127.0.0.1:${port}`,origin=base;
 const get=async(route:string,init?:RequestInit)=>{const res=await fetch(base+route,init);return {status:res.status,text:await res.text(),policy:res.headers.get('content-security-policy')};};
 expect((await get('/')).text).toContain('/bb-desktop-start.js');
 expect((await get('/licenses')).text).toBe('NOTICES');
 const page=await get(`/?token=${token}&x=1`),seen=JSON.parse(page.text);
 expect(seen).toMatchObject({url:'/?x=1',host:expect.stringMatching(/^127\.0\.0\.1:\d+$/),origin:null,cookie:null,display:':77'});
 expect(seen.auth).toBe('Bearer '+seen.password);expect(seen.password).not.toContain(token);
 expect(page.policy).toBe("frame-ancestors 'self' https://*.getbb.app");
 expect((await get('/client.js')).status).toBe(200);
 for(const route of ['/stats','/?token='+'x'.repeat(43),`/files/a?token=${token}`])expect((await get(route)).status).toBe(403);
 expect((await get('/stats',{headers:{Authorization:'Bearer '+token}})).status).toBe(200);
 expect((await get(`/wait?token=${token}`,{method:'POST',headers:{Origin:'https://evil.example'}})).status).toBe(403);
 expect((await get(`/wait?token=${token}`,{method:'POST',headers:{Origin:`https://sbx--${port}.getbb.app`}})).status).toBe(200);
 expect((await upgrade(port,`/ws?token=${token}`,'https://evil.example')).status).toBe(403);
 expect((await upgrade(port,'/ws',origin)).status).toBe(403);
 const first=await upgrade(port,`/ws?token=${token}&v=2`,origin);
 expect(first.seen).toMatchObject({url:'/ws?v=2',origin:null});
 const echo=await new Promise<string>(resolve=>{first.socket!.once('data',data=>resolve(String(data)));first.socket!.write('frame');});expect(echo).toBe('frame');
 const replaced=new Promise(resolve=>first.socket!.once('close',resolve));
 const second=await upgrade(port,`/ws?token=${token}`,origin);expect(second.status).toBe(101);await replaced;
 const voxlGone=new Promise(resolve=>second.socket!.once('close',resolve));
 await host.close('desk');await voxlGone;
 await expect(fetch(base+'/')).rejects.toThrow();
});
