import { createServer } from "node:http";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { ExperimentalPluginWebSocketHandler } from "@get-bb/plugin-sdk";
import { expect, it, vi } from "vitest";
import { BrowserCookieConnection } from "../src/browser-cookie-connection.js";
import { browserExtensionOrigin } from "../src/browser-extension-download.js";
import { browserSettingDescriptors } from "../src/config.js";
import { registerRelay } from "../src/relay.js";
import { registerViewer } from "../src/viewer.js";
const { WebSocketServer } = createRequire(import.meta.url)("ws");

it.runIf(process.env.BB_TEST_REAL_BROWSER === '1')('drives the actual paired extension without claiming or closing personal fixture tabs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'browser-relay-real-'));let handler:ExperimentalPluginWebSocketHandler|undefined,viewerOffline=false;
 const fake=createFakePluginHost({pluginId:'browser',experimental_hostEntry:true,experimental_callHostRpc:async({input})=>{const request=input as {threadId:string,action:unknown};if(viewerOffline)return {ok:false,data:''};try{return {ok:true,data:await run(['thread','viewer',JSON.stringify(request.action)],request.threadId,'')};}catch{return {ok:false,data:''};}},sdk:{threads:{get:async({threadId})=>({title:'Fixture '+threadId}) as never}}});
 const viewer=registerViewer(fake.bb);
 const settings=fake.bb.settings.define(browserSettingDescriptors),cookies=new BrowserCookieConnection(fake.bb,join(root,'cookies'));await cookies.register();
 vi.spyOn(fake.bb.http,'experimental_websocket').mockImplementation((_path,callback)=>{handler=callback;});registerRelay(fake.bb,cookies,()=>settings.get());
 const server=createServer(async(req,res)=>{
  try{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
   if(req.url==='/command'){const body=JSON.parse(Buffer.concat(chunks).toString());const result=await fake.harness.behavior.runCli([Buffer.from(JSON.stringify({argv:body.argv})).toString('base64url')],{threadId:body.threadId});res.writeHead(result.exitCode===0?200:400,{'content-type':'application/json'});res.end(JSON.stringify(result));return;}
   if(req.url==='/fixture'){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Relay fixture</title><h1>Relay fixture</h1><input id="name"><button onclick="document.querySelector(\'h1\').textContent=\'Saved \'+document.querySelector(\'#name\').value">Save</button>');return;}
   const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(typeof value==='string')headers.set(key,value);
   const result=await fake.harness.behavior.fetchHttp(req.method!,req.url!.replace('/api/v1/plugins/browser/http',''),{headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})});res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));
  }catch{res.writeHead(500);res.end();}
 });
 const wss=new WebSocketServer({noServer:true});server.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,(ws:any)=>{
  const url=new URL(req.url!,`http://${req.headers.host}`),headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(typeof value==='string')headers.set(key,value);
  const handlers=handler!({url,headers,request:new Request(url,{headers})});const adapter={send:(value:string|Uint8Array)=>ws.send(value),close:(code?:number,reason?:string)=>ws.close(code,reason),get readyState(){return ws.readyState;}};
  void handlers.onOpen?.(adapter);ws.on('message',(data:Buffer)=>void handlers.onMessage?.(adapter,data.toString()));ws.on('close',(code:number,reason:Buffer)=>void handlers.onClose?.(adapter,{code,reason:reason.toString()}));
 }));
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw Error('No fixture listener');const base=`http://127.0.0.1:${address.port}`;
 const shim=join(root,'bb');await writeFile(shim,`#!${process.execPath}\nconst q=JSON.parse(Buffer.from(process.argv.at(-1),'base64url').toString());fetch(${JSON.stringify(base+'/command')},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({argv:q.argv,threadId:process.env.BB_THREAD_ID})}).then(r=>r.json()).then(r=>{if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);process.exitCode=r.exitCode}).catch(e=>{console.error(e.message);process.exitCode=1});\n`,{mode:0o700});
 const env:NodeJS.ProcessEnv={...process.env,HOME:root,XDG_CONFIG_HOME:join(root,'config'),BB_BROWSER_HOME:join(root,'runtime'),BB_BROWSER_BACKEND:'native',BB_BROWSER_PROFILE:'Brave-relay-fixture',BB_BROWSER_EGRESS:'direct',BB_BROWSER_STATE:'',BB_BROWSER_EXECUTABLE:process.env.BB_TEST_BRAVE_EXECUTABLE||'/opt/brave.com/brave/brave',BB_THREAD_ID:'thr_pairing_fixture'};
 const run=(args:string[],relayThread?:string,backend='relay')=>{const {promise,resolve:done,reject}=Promise.withResolvers<string>();const child=spawn(process.execPath,[resolve('docker/trusted-browser.mjs'),...args],{env:relayThread?{...env,BB_BROWSER_BACKEND:backend,BB_THREAD_ID:relayThread,BB_BROWSER_HEADLESS:backend==='isolated'?'1':'',PATH:root+':'+env.PATH}:env,stdio:['ignore','pipe','pipe']});let out='',error='';child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>error+=chunk);child.once('error',reject);child.once('close',code=>code===0?done(out):reject(Error(args.join(" ")+": "+error)));return promise;};
 const view=(args:string[])=>run(args,'thr_viewer','isolated');
 try{
  const pairing=await cookies.beginPairing(),origin=await browserExtensionOrigin();await run(['open',origin+'/options.html']);await run(['fill','#server',base]);await run(['fill','#code',pairing.code]);await run(['click','button[type=submit]']);await expect.poll(async()=>(await cookies.status()).paired).toBe(true);
  await run(['tab','new',base+'/fixture']);
  await expect.poll(async()=>{try{return JSON.parse(await run(['doctor'],'thr_a')).connected;}catch{return false;}}).toBe(true);
  await run(['open',base+'/fixture'],'thr_a');
  const doctor=JSON.parse(await run(['doctor'],'thr_a'));expect(doctor.targetWindow).toBe(doctor.ownedWindow);
  await expect(run(['observe'],'thr_a','native')).rejects.toThrow('different browser backend');
  const point=JSON.parse(await run(['eval','(()=>{const r=document.querySelector("#name").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()'],'thr_a'));await run(['thread','pause'],'thr_a','');
  const viewerUrl=new URL(viewer.issue('thr_a','fixture-host'));await view(['open',base+viewerUrl.pathname+viewerUrl.search]);
  await expect.poll(()=>view(['eval','document.querySelector("#status").textContent']),{timeout:15000}).toContain('Connected');
  await expect.poll(()=>view(['eval','document.querySelector("#screen").naturalWidth>0'])).toContain('true');
  await view(['eval',`(async()=>{const s=document.querySelector('#screen'),r=s.getBoundingClientRect(),p=${JSON.stringify(point)};for(const type of ['mousedown','mouseup'])s.dispatchEvent(new MouseEvent(type,{bubbles:true,clientX:r.left+p.x*r.width/s.naturalWidth,clientY:r.top+p.y*r.height/s.naturalHeight}));await chain;return true;})()`]);
  await view(['fill','#text','Human relay']);expect(await view(['eval','document.querySelector("#text").value'])).toContain('Human relay');await view(['click','#input button']);await view(['eval','chain.then(()=>true)']);
  viewerOffline=true;await expect.poll(()=>view(['eval','document.querySelector("#status").textContent']),{timeout:10000}).toContain('Session unavailable');viewerOffline=false;
  await view(['click','header > button']);await expect.poll(()=>view(['eval','document.querySelector("#status").textContent']),{timeout:10000}).toContain('Connected');
  await view(['screenshot',join(root,'viewer.png')]);viewer.revoke('thr_a');
  await expect.poll(()=>view(['eval','document.querySelector("#status").textContent']),{timeout:10000}).toContain('Viewer expired');
  await run(['thread','resume'],'thr_a','');expect(await run(['eval','document.querySelector("#name").value'],'thr_a')).toContain('Human relay');
  const image=join(root,'relay.png');await run(['screenshot',image],'thr_a');expect((await readFile(image)).subarray(1,4).toString()).toBe('PNG');
  let observation=JSON.parse(await run(['observe'],'thr_a'));const input=observation.controls.find((row:{tag:string})=>row.tag==='input');await run(['act',JSON.stringify({revision:observation.revision,target:input.id,operation:'fill',value:'Relay Alice'})],'thr_a');
  observation=JSON.parse(await run(['observe'],'thr_a'));const save=observation.controls.find((row:{name:string})=>row.name==='Save');await run(['act',JSON.stringify({revision:observation.revision,target:save.id,operation:'click'})],'thr_a');expect((await run(['read'],'thr_a'))).toContain('Saved Relay Alice');
  const own=JSON.parse(await run(['tab','list'],'thr_a')).tabs;expect(own.every((tab:{owned:boolean})=>tab.owned)).toBe(true);
  const discovered=JSON.parse(await run(['tab','discover'],'thr_b')).tabs;const personal=discovered.find((tab:{id:number,url:string})=>tab.url===base+'/fixture'&&!own.some((owned:{id:number})=>owned.id===tab.id));expect(personal).toBeDefined();
  await expect(run(['tab','borrow',String(personal.id)],'thr_b')).rejects.toThrow('leased');
  await run(['close','--all'],'thr_a');
  await run(['tab','borrow',String(personal.id)],'thr_b');await run(['close','--all'],'thr_b');
  expect(JSON.parse(await run(['tab','discover'],'thr_a')).tabs.some((tab:{id:number})=>tab.id===personal.id)).toBe(true);
  await run(['close','--all'],'thr_a');
  const still=JSON.parse(await run(['tab','discover'],'thr_c')).tabs;expect(still.some((tab:{id:number})=>tab.id===personal.id)).toBe(true);expect(still.some((tab:{id:number})=>own.some((owned:{id:number})=>owned.id===tab.id))).toBe(false);
 }finally{
  await view(['thread','discard']).catch(()=>{});for(const thread of ['thr_a','thr_b','thr_c'])await run(['thread','discard'],thread,'').catch(()=>{});await run(['thread','discard']).catch(()=>{});
  const profile=join(root,'config/BraveSoftware/Brave-relay-fixture');let owner=0;try{owner=Number(/-(\d+)$/.exec(await readlink(join(profile,'SingletonLock')))?.[1]);}catch{}
  if(owner){const command=(await readFile('/proc/'+owner+'/cmdline','utf8')).replaceAll('\0',' ');if(!command.includes(' --user-data-dir='+profile+' ')||command.includes(' --type='))throw Error('Refused to stop an unrelated browser');process.kill(owner,'SIGTERM');await expect.poll(async()=>{try{return (await readFile('/proc/'+owner+'/stat','utf8')).split(') ').at(-1)!.split(' ')[0]==='Z';}catch{return true;}},{timeout:5000}).toBe(true);}
  for(const client of wss.clients)client.terminate();wss.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await fake.harness.lifecycle.dispose();vi.restoreAllMocks();await rm(root,{recursive:true,force:true});
 }
},120000);
