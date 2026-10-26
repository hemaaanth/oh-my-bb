import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.runIf(process.env.BB_TEST_REAL_BROWSER === "1")("isolates accounts, consumes guarded actions, retains handoff sessions and cleans up owned processes",async()=>{
 const root=await mkdtemp(join(tmpdir(),'browser-real-'));
 const server=createServer((req,res)=>{const url=new URL(req.url!,'http://fixture');const account=url.searchParams.get('account');if(account)res.setHeader('set-cookie',`fixture=${account}; Path=/; SameSite=Lax`);res.end('<!doctype html><style>body{background:rgb(20,180,60)}#off{position:absolute;top:4000px}#cover{position:fixed;inset:0;display:none}</style><h1>Account fixture</h1><label>Name<input id="name" autofocus></label><input type="password" value="secret-fixture"><button onclick="window.saved=(window.saved||0)+1">Save</button><p id="off">Offscreen</p><div id="cover"></div>');});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw Error('Fixture listener failed');
 const url=`http://127.0.0.1:${address.port}`;
 const env={...process.env,BB_BROWSER_HOME:root,BB_BROWSER_BACKEND:'',BB_BROWSER_TAILSCALE_USERSPACE:'1',BB_BROWSER_EGRESS:'direct',BB_BROWSER_HEADLESS:'1',BB_BROWSER_EXECUTABLE:process.env.BB_TEST_BRAVE_EXECUTABLE||'/opt/brave.com/brave/brave'};
 const run=async(threadId:string,args:string[],extraEnv:Record<string,string>={})=>{
  const {promise,resolve:done,reject}=Promise.withResolvers<string>();const child=spawn(process.execPath,[resolve('docker/trusted-browser.mjs'),...args],{env:{...env,...extraEnv,BB_THREAD_ID:threadId},stdio:['ignore','pipe','pipe']});let out='',error='';child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>error+=chunk);child.once('error',reject);child.once('close',code=>code===0?done(out):reject(Error(error)));return promise;
 };
 const json=async(t:string,args:string[])=>JSON.parse(await run(t,args));
 const value=async(t:string,expression:string)=>(await json(t,['--json','eval',expression])).data.result;
 try{
  await Promise.all([run('thr_a',['open',url+'/?account=A']),run('thr_b',['open',url+'/?account=B'])]);
  const record=async()=>JSON.parse(await readFile(join(root,'sessions/thr_a/session.json'),'utf8'));
  const legacy=await record(), oldMonitor=legacy.monitor.pid;delete legacy.networkGeneration;
  await writeFile(join(root,'sessions/thr_a/session.json'),JSON.stringify(legacy));
  await writeFile(join(root,'threads/thr_a.network.json'),JSON.stringify({generation:'e'.repeat(32)}));
  await run('thr_a',['thread','pause']);await run('thr_a',['thread','resume']);
  expect((await record()).networkGeneration).toBeUndefined();
  await value('thr_a','1+1');
  const generation=(await record()).networkGeneration;expect(generation).toMatch(/^[a-f0-9]{32}$/);
  expect((await record()).monitor.pid).not.toBe(oldMonitor);
  expect(await value('thr_a','navigator.webdriver')).toBe(false);
  await writeFile(join(root,'agent-browser'),'#!/bin/sh\necho engine-unavailable >&2\nexit 17\n',{mode:0o700});
  const unavailableEngine={PATH:`${root}:${process.env.PATH||'/usr/bin:/bin'}`};
  const waited=JSON.parse(await run('thr_a',['wait','20'],unavailableEngine));
  expect(waited).toEqual({success:true,data:{waited:20}});
  await expect(run('thr_a',['wait','30001'],unavailableEngine)).rejects.toThrow('at most 30000');
  expect(await value('thr_a','document.cookie')).toBe('fixture=A');expect(await value('thr_b','document.cookie')).toBe('fixture=B');
  let observation=await json('thr_a',['observe']);expect(JSON.stringify(observation)).not.toContain('secret-fixture');
  const button=observation.controls.find((row:{name:string})=>row.name==='Save');
  await value('thr_a','document.querySelector("#off").textContent="Changed outside viewport";true');
  const action={revision:observation.revision,target:button.id,operation:'click'};
  await run('thr_a',['act',JSON.stringify(action)]);expect(await value('thr_a','window.saved')).toBe(1);
  await expect(run('thr_a',['act',JSON.stringify(action)])).rejects.toThrow('consumed');
  observation=await json('thr_a',['observe']);await value('thr_a','document.querySelector("#cover").style.display="block";true');
  await expect(run('thr_a',['act',JSON.stringify({...action,revision:observation.revision})])).rejects.toThrow('covered');
  await value('thr_a','document.querySelector("#cover").style.display="none";document.querySelector("#name").focus();true');
  const before=(await json('thr_a',['doctor'])).session;
  await run('thr_a',['thread','pause']);await expect(run('thr_a',['observe'])).rejects.toThrow('paused');
  const frame=await json('thr_a',['thread','viewer','{"type":"frame"}']);expect(Buffer.from(frame.data,'base64').subarray(1,4).toString()).toBe('PNG');
  await run('thr_a',['thread','viewer','{"type":"text","text":"human input"}']);await run('thr_a',['thread','resume']);
  expect((await json('thr_a',['doctor'])).session).toBe(before);expect(await value('thr_a','document.querySelector("#name").value')).toBe('human input');
  await expect(run('thr_a',['thread','viewer','{"type":"text","text":"stale"}'])).rejects.toThrow('expired');
  const current=await json('thr_a',['observe']),delta=await json('thr_a',['observe','--delta']);expect(delta.baseRevision).toBe(current.revision);expect(JSON.stringify(delta).length).toBeLessThan(JSON.stringify(current).length);
  await value('thr_a','setTimeout(()=>confirm("Fixture explicit confirmation"),100);true');
  await expect.poll(async()=> (await json('thr_a',['dialog','inspect'])).pending?.message).toBe('Fixture explicit confirmation');await run('thr_a',['dialog','dismiss']);
  await run('thr_a',['state','save','fixture']);expect(JSON.parse(await readFile(join(root,'state/fixture.json'),'utf8')).cookies.find((cookie:{name:string})=>cookie.name==='fixture').value).toBe('A');
  expect(await value('thr_b','document.cookie')).toBe('fixture=B');
  await value('thr_a',`window.open(${JSON.stringify(url+'/popup')},'_blank');true`);await run('thr_a',['thread','pause']);
  const pages=await json('thr_a',['thread','viewer','{"type":"frame"}']);const popup=pages.tabs.find((tab:{url:string})=>tab.url===url+'/popup');expect(popup).toBeDefined();
  await run('thr_a',['thread','viewer',JSON.stringify({type:'tab',target:popup.id})]);await run('thr_a',['thread','viewer','{"type":"text","text":"Popup human"}']);await run('thr_a',['thread','resume']);
  await run('thr_a',['tab',popup.id]);expect(await value('thr_a','document.querySelector("#name").value')).toBe('Popup human');
  expect((await record()).networkGeneration).toBe(generation);
  await run('thr_a',['thread','discard']);await run('thr_a',['open',url]);
  expect((await record()).networkGeneration).not.toBe(generation);
 }finally{
  for(const thread of ['thr_a','thr_b'])await run(thread,['thread','discard']).catch(()=>{});
  await new Promise<void>(done=>server.close(()=>done()));await rm(root,{recursive:true,force:true});
 }
},120000);
