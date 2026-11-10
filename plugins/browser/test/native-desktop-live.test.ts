import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {setTimeout as delay} from 'node:timers/promises';
import {createFakePluginHost,makeThreadResponse,makeHostResponse} from '@get-bb/plugin-sdk/testing';
import {registerBrowserHandoff} from '../src/browser-handoff.js';
// Read-only X11 diagnostics. Brave Shields can mask DOM screen/outer-window dimensions.
const displayGeometry=String.raw`
import ctypes, json, os
x=ctypes.CDLL('libX11.so.6')
x.XOpenDisplay.restype=ctypes.c_void_p
d=x.XOpenDisplay(os.environ['DISPLAY'].encode())
if not d: raise RuntimeError('Owned display unavailable')
x.XDefaultRootWindow.argtypes=[ctypes.c_void_p]; x.XDefaultRootWindow.restype=ctypes.c_ulong
x.XDisplayWidth.argtypes=x.XDisplayHeight.argtypes=[ctypes.c_void_p,ctypes.c_int]
x.XQueryTree.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.POINTER(ctypes.c_ulong),ctypes.POINTER(ctypes.c_ulong),ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)),ctypes.POINTER(ctypes.c_uint)]
x.XGetGeometry.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.POINTER(ctypes.c_ulong),ctypes.POINTER(ctypes.c_int),ctypes.POINTER(ctypes.c_int),ctypes.POINTER(ctypes.c_uint),ctypes.POINTER(ctypes.c_uint),ctypes.POINTER(ctypes.c_uint),ctypes.POINTER(ctypes.c_uint)]
root=x.XDefaultRootWindow(d); parent=ctypes.c_ulong(); returned=ctypes.c_ulong(); children=ctypes.POINTER(ctypes.c_ulong)(); count=ctypes.c_uint()
x.XQueryTree(d,root,ctypes.byref(returned),ctypes.byref(parent),ctypes.byref(children),ctypes.byref(count))
windows=[]
for i in range(count.value):
 a,b=ctypes.c_int(),ctypes.c_int(); w,h,border,depth=ctypes.c_uint(),ctypes.c_uint(),ctypes.c_uint(),ctypes.c_uint()
 if x.XGetGeometry(d,children[i],ctypes.byref(returned),ctypes.byref(a),ctypes.byref(b),ctypes.byref(w),ctypes.byref(h),ctypes.byref(border),ctypes.byref(depth)): windows.append({'width':w.value,'height':h.value,'x':a.value,'y':b.value})
print(json.dumps({'width':x.XDisplayWidth(d,0),'height':x.XDisplayHeight(d,0),'windows':windows}))
`;

it.runIf(process.env.BB_TEST_REAL_NATIVE==='1')('retires fully closed native threads without losing persistent auth or disturbing active owners',async()=>{
 const root=await mkdtemp(join(tmpdir(),'bb-native-desktop-proof-')),storage=process.env.BB_THREAD_STORAGE;
 const legacy=join(root,'config/BraveSoftware/Brave-native-fixture');
 await mkdir(legacy,{recursive:true});await writeFile(join(legacy,'preserve'),'legacy authentication fixture');
 // The installed shell launcher masks its child's exit status with `|| true`.
 // Supervise the actual engine PID. Core limits apply only to fixture children.
 const supervisor=join(root,'brave-supervisor.mjs'),exits=join(root,'exits.jsonl');
 await writeFile(supervisor,`#!/usr/bin/env node
import{spawn}from'node:child_process';import{appendFileSync}from'node:fs';
const child=spawn('prlimit',['--core=0:0','--',process.env.BB_TEST_REAL_BRAVE,...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,CHROME_WRAPPER:process.env.BB_TEST_CHROME_WRAPPER,CHROME_VERSION_EXTRA:'stable',GNOME_DISABLE_CRASH_DIALOG:'SET_BY_GOOGLE_CHROME'}});
child.once('exit',(code,signal)=>{appendFileSync(process.env.BB_TEST_ENGINE_EXITS,JSON.stringify({pid:child.pid,code,signal})+'\\n');process.exit(code??1)});
`);await chmod(supervisor,0o700);
 const gateReached=Promise.withResolvers<void>();let releaseGate=()=>{};
 const server=createServer((req,res)=>{
  if(req.url==='/gate'){releaseGate=()=>res.end('released');gateReached.resolve();return;}
  if(req.url==='/motion'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Native motion fixture</title><style>body{margin:0;background:#121212;color:white}#box{position:absolute;top:200px;width:40px;height:350px;background:rgb(255,0,0);animation:move 3s linear infinite}@keyframes move{from{transform:translateX(100px)}to{transform:translateX(1700px)}}</style><span id="counter"></span><div id="box"></div><script>let n=0;function tick(){document.querySelector("#counter").textContent=++n;requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>');return;}
  const account=new URL(req.url!,'http://fixture').searchParams.get('account');
  if(account)res.setHeader('Set-Cookie',`fixture=${account}; Path=/; SameSite=Lax; Max-Age=3600`);
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Native desktop fixture</title><h1>Native fixture</h1><label>Name<input id="name"></label><button onclick="document.querySelector(\'h1\').textContent=\'Saved \'+document.querySelector(\'#name\').value">Save</button>');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw Error('Fixture listener unavailable');const url=`http://127.0.0.1:${address.port}`;
 const env={...process.env,BB_BROWSER_HOME:root,BB_BROWSER_BACKEND:'native',BB_BROWSER_PROFILE:'Brave-native-fixture',BB_BROWSER_EGRESS:'direct',BB_BROWSER_STATE:'',BB_BROWSER_REQUIRED_STATE:'',XDG_CONFIG_HOME:join(root,'config'),BB_BROWSER_EXECUTABLE:supervisor,BB_TEST_REAL_BRAVE:process.env.BB_TEST_BRAVE_EXECUTABLE||'/opt/brave-origin-bin/brave',BB_TEST_CHROME_WRAPPER:process.env.BB_TEST_CHROME_WRAPPER||'/opt/brave-origin-bin/brave-origin',BB_TEST_ENGINE_EXITS:exits};
 const start=(thread:string,args:string[])=>{
  const result=Promise.withResolvers<string>(),child=spawn('bb-browser',args,{env:{...env,BB_THREAD_ID:thread},stdio:['ignore','pipe','pipe']});let out='',error='';
  child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>error+=chunk);child.once('error',result.reject);child.once('close',code=>code===0?result.resolve(out):result.reject(Error(thread+' '+args.join(' ')+': '+error)));
  return {pid:child.pid!,result:result.promise};
 };
 const run=(thread:string,args:string[])=>start(thread,args).result;
 const identity=(thread:string)=>join(root,'native',createHash('sha256').update(legacy+'\0'+thread).digest('hex').slice(0,12));
 const owned:Array<any>=[],disposers:Array<()=>Promise<void>>=[],retirements:Array<unknown>=[];
 const record=async(thread:string)=>{const value=JSON.parse(await readFile(join(identity(thread),'browser.json'),'utf8'));owned.push(value);return value;};
 const value=async(thread:string,expression:string)=>JSON.parse(await run(thread,['--json','eval',expression])).data.result;
 const contents=async(path:string)=>readFile(path,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
 const proc=(pid:number)=>contents('/proc/'+pid+'/stat');
 const markers=async(thread:string)=>Promise.all(['seed-initialized','state-applied','state-applied.cookies'].map(name=>contents(join(identity(thread),name))));
 const seed=async(value:string)=>{await mkdir(join(root,'state'),{recursive:true});await writeFile(join(root,'state/default.json'),JSON.stringify({bbCookieSync:true,cookies:[{name:'fixture',value,domain:'127.0.0.1',path:'/',expires:Math.floor(Date.now()/1000)+3600}],origins:[]}));};
 const retired=async(thread:string,before:any,reason:string)=>{
  const exit=async()=>{const text=await contents(exits);return text?.trim().split('\n').map(line=>JSON.parse(line)).find(entry=>entry.pid===before.pid);};
  await expect.poll(exit,{timeout:10000}).toEqual({pid:before.pid,code:0,signal:null});
  for(const pid of [before.pid,before.display.pid,before.display.manager.pid])await expect.poll(()=>proc(pid),{timeout:10000}).toBeNull();
  expect(await contents(join(identity(thread),'browser.json'))).toBeNull();
  retirements.push({reason,before,exit:await exit(),mainDisplayAndManagerGone:true});
 };
 const lifecycle=(id:string)=>{
  const thread=makeThreadResponse({id,environmentId:'env_native_fixture'}),host=makeHostResponse({id:'host_native_fixture',status:'connected',lifecycle:{phase:'active',suspendedAt:null,message:null,pendingLog:'',teardown:null}});
  const desktopOwners=new Set<string>();
  const fake=createFakePluginHost({pluginId:'browser',experimental_hostEntry:true,sdk:{threads:{get:async()=>thread},environments:{get:async()=>({hostId:host.id})},hosts:{get:async()=>host}},experimental_callHostRpc:async call=>{
   const input=call.input as {threadId:string;action:string};expect(input.threadId).toBe(id);
   if(input.action==='close'||input.action==='discard')expect(desktopOwners.has(id)).toBe(false);
   await run(id,['thread',input.action]);return {ok:true};
  }});
  registerBrowserHandoff(fake.bb,{
   hold(){},release(){},
   async openDesktop(_host,threadId,watch){expect(threadId).toBe(id);await run(id,['thread','desktop',...(watch?['--watch']:[])]);desktopOwners.add(id);return 'https://viewer.invalid/#owned-fixture';},
   async closeDesktop(threadId){desktopOwners.delete(threadId);},
  },async()=>JSON.stringify({state:'disconnected',url:null}));
  disposers.push(()=>fake.harness.lifecycle.dispose());return {thread,harness:fake.harness};
 };
 const threads=['thr_native_fixture_a','thr_native_fixture_b','thr_native_fixture_missing'];let receipt:Record<string,unknown>={};
 try{
  await seed('seed-one');await run(threads[0]!,['open',url]);expect(await value(threads[0]!,'document.cookie')).toBe('fixture=seed-one');
  // System-managed extensions may open first-install tabs. Settle only this
  // disposable profile before visual proof, without changing policy or flags.
  const initial=await record(threads[0]!);await delay(12000);
  await run(threads[0]!,['close','--all']);await retired(threads[0]!,initial,'first-install fixture profile settled');
  await run(threads[0]!,['open',url+'/?account=A']);await run(threads[1]!,['open',url+'/?account=B']);
  const a=await record(threads[0]!),b=await record(threads[1]!),initialMarkers=await markers(threads[0]!);
  for(const key of ['profile','pid','windowClass'])expect(a[key]).not.toBe(b[key]);
  for(const key of ['pid','name','authority','vncSocket'])expect(a.display[key]).not.toBe(b.display[key]);
  expect(a.display.geometry).toBe('1920x1080');expect(b.display.geometry).toBe('1920x1080');
  await run(threads[0]!,['--session','extra','open',url]);await run(threads[0]!,['--session','extra','close']);
  expect((await record(threads[0]!)).pid).toBe(a.pid);expect(await value(threads[0]!,'document.cookie')).toBe('fixture=A');
  await seed('seed-two');
  await value(threads[0]!,"document.cookie='fixture=changed-immediately; Path=/; Max-Age=3600';document.cookie='fresh=added-immediately; Path=/; Max-Age=3600';document.cookie='session=restart-not-guaranteed; Path=/';true");
  await run(threads[0]!,['close','--all']);await retired(threads[0]!,a,'close --all after immediate persistent cookie add/change');
  await run(threads[0]!,['open',url]);const reopened=await record(threads[0]!),cookies=await value(threads[0]!,'document.cookie');
  for(const pid of [reopened.pid,reopened.display.pid,reopened.display.manager.pid])expect([a.pid,a.display.pid,a.display.manager.pid]).not.toContain(pid);
  expect(reopened.profile).toBe(a.profile);expect(await markers(threads[0]!)).toEqual(initialMarkers);
  expect(cookies.split('; ')).toEqual(expect.arrayContaining(['fixture=changed-immediately','fresh=added-immediately']));
  expect(await value(threads[1]!,'document.cookie')).toBe('fixture=B');expect((await record(threads[1]!)).pid).toBe(b.pid);
  const pageMetrics=await value(threads[0]!,'({width:screen.width,height:screen.height,outerWidth,outerHeight})');
  const query=spawnSync('python',['-c',displayGeometry],{env:{...process.env,DISPLAY:reopened.display.name,XAUTHORITY:reopened.display.authority},encoding:'utf8'});
  if(query.status!==0)throw Error('Owned X11 geometry query failed: '+query.stderr);const geometry=JSON.parse(query.stdout);
  expect(geometry).toMatchObject({width:1920,height:1080});expect(geometry.windows).toContainEqual({width:1920,height:1080,x:0,y:0});
  await run(threads[0]!,['open',url+'/motion']);await delay(5000);
  // No eval/read/screenshot during measurement: those commands emulate focus.
  const started=Date.now(),capture=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','x11grab','-framerate','60','-video_size','1920x1080','-i',reopened.display.name,'-t','4','-filter_threads','1','-vf','format=rgb24,crop=1920:2:0:400','-threads','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{env:{...process.env,XAUTHORITY:reopened.display.authority},timeout:15000,maxBuffer:16*1024*1024});
  if(capture.status!==0)throw Error('Independent root motion capture failed: '+capture.stderr);
  const positions:Array<number|null>=[],bytesPerFrame=1920*2*3;
  for(let offset=0;offset+bytesPerFrame<=capture.stdout.length;offset+=bytesPerFrame){
   let red:number|null=null;for(let x=0;x<1920;x++){const i=offset+x*3;if(capture.stdout[i]!>200&&capture.stdout[i+1]!<80&&capture.stdout[i+2]!<80){red=x;break;}}positions.push(red);
  }
  let changes=0,freeze=0,longest=0,prior=positions[0];
  for(const position of positions){if(position===prior)freeze++;else{changes++;longest=Math.max(longest,freeze/60);freeze=1;prior=position;}}
  longest=Math.max(longest,freeze/60);
  const motion={rootFrames:positions.length,positionChanges:changes,motionHz:changes/((Date.now()-started)/1000),longestFreezeSeconds:longest,missingBoxFrames:positions.filter(value=>value===null).length};
  receipt.motion=motion;
  if(storage&&motion.missingBoxFrames)spawnSync('ffmpeg',['-y','-hide_banner','-loglevel','error','-f','x11grab','-video_size','1920x1080','-i',reopened.display.name,'-frames:v','1',join(storage,'native-motion-failure.png')],{env:{...process.env,XAUTHORITY:reopened.display.authority},timeout:10000});
  expect(motion.rootFrames).toBe(240);expect(motion.missingBoxFrames).toBe(0);expect(changes).toBeGreaterThan(160);expect(longest).toBeLessThan(0.25);
  if(storage)await run(threads[0]!,['screenshot',join(storage,'native-fixture-page.png')]);
  const leaseCommand=start(threads[0]!,['--json','eval',`fetch(${JSON.stringify(url+'/gate')}).then(()=>({leaseFinished:true}))`]);
  await Promise.race([gateReached.promise,leaseCommand.result.then(()=>{throw Error('Lease command finished before reaching the fixture gate');})]);
  const closing=start(threads[0]!,['close','--all']);
  await expect.poll(()=>contents(join(identity(threads[0]!),'leases',String(closing.pid))),{timeout:10000}).not.toBeNull();
  expect(await proc(reopened.pid)).not.toBeNull();releaseGate();
  expect(JSON.parse(await leaseCommand.result).data.result).toEqual({leaseFinished:true});await closing.result;
  await retired(threads[0]!,reopened,'close racing a real active command lease');
  await run(threads[0]!,['open',url]);const watched=await record(threads[0]!),events=lifecycle(threads[0]!);
  expect(await events.harness.behavior.callRpc('openBrowserView',{threadId:events.thread.id})).toMatchObject({kind:'watch'});
  await events.harness.behavior.emitThreadEvent('thread.idle',{thread:events.thread,lastAssistantText:'Watch stays open'});
  expect((await record(threads[0]!)).pid).toBe(watched.pid);expect(await proc(watched.pid)).not.toBeNull();
  await events.harness.behavior.emitThreadEvent('thread.archived',{thread:events.thread});
  await retired(threads[0]!,watched,'archive revokes watch before terminal native cleanup');
  await run(threads[0]!,['open',url]);const held=await record(threads[0]!);
  const handoff=events.harness.behavior.callAgentTool('browser_handoff',{reason:'other',instructions:'Owned fixture only.'},{threadId:events.thread.id});
  await expect.poll(()=>events.harness.pendingInteractions.length).toBe(1);
  await run(threads[0]!,['thread','close']);await events.harness.behavior.emitThreadEvent('thread.idle',{thread:events.thread,lastAssistantText:'Handoff stays paused'});
  expect((await record(threads[0]!)).pid).toBe(held.pid);expect(await contents(join(root,'threads',threads[0]+'.hold'))).not.toBeNull();
  expect(JSON.parse(await run(threads[0]!,['thread','desktop'])).display).toBe(held.display.name);
  events.harness.behavior.submitInteraction(events.harness.pendingInteractions[0]!.id,{done:false});expect(await handoff).toMatchObject({isError:true});
  await retired(threads[0]!,held,'cancelled handoff discards and retires its held native browser');
  const other=lifecycle(threads[1]!);await other.harness.behavior.emitThreadEvent('thread.deleted',{thread:other.thread});await retired(threads[1]!,b,'thread deleted');
  expect(await readFile(join(legacy,'preserve'),'utf8')).toBe('legacy authentication fixture');
  await rm(join(root,'state/default.json'));await run(threads[2]!,['open',url]);expect(await value(threads[2]!,'document.cookie')).toBe('');
  const missing=await record(threads[2]!),missingMarkers=await markers(threads[2]!);
  await seed('seed-three');await run(threads[2]!,['thread','close']);await retired(threads[2]!,missing,'thread close with no initial seed');
  await run(threads[2]!,['open',url]);expect(await value(threads[2]!,'document.cookie')).toBe('');expect(await markers(threads[2]!)).toEqual(missingMarkers);
  const last=await record(threads[2]!);await run(threads[2]!,['thread','discard']);await retired(threads[2]!,last,'explicit thread discard');
  receipt={nativeA:a,nativeB:b,reopened,geometry,pageMetrics,motion,cookiesAfterActualReplacement:cookies,seedMarkersPreserved:true,missingSeedNotReplaced:true,retirements,legacy:'sentinel unchanged',proof:'Actual bb-browser, Brave, Xvnc and Openbox. Physical motion uses independent FFmpeg after CLI detachment. SDK lifecycle host RPCs execute the real CLI. Watch/hold checks cover lifecycle ownership, not a rendered BB viewer.'};
 }catch(error){receipt.error=String(error);throw error;}finally{
  releaseGate();for(const dispose of disposers)await dispose();
  // Emergency fixture cleanup only. Successful proof must leave no process
  // here; never use this fallback as evidence that normal retirement worked.
  const emergency:number[]=[];
  for(const before of owned){
   if(!before.profile.startsWith(root))throw Error('Refusing fixture cleanup outside root');
   const cmd=await contents('/proc/'+before.pid+'/cmdline');
   if(cmd?.includes('--user-data-dir='+before.profile)){emergency.push(before.pid);try{process.kill(before.pid,'SIGKILL');}catch{}}
   for(const owner of [before.display.manager,before.display]){
    const stat=await proc(owner.pid);if(stat&&stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]===owner.start){emergency.push(owner.pid);try{process.kill(owner.pid,'SIGTERM');}catch{}}
   }
  }
  receipt.emergencyCleanup=emergency;receipt.retirements=retirements;
  if(storage)await writeFile(join(storage,'native-desktop-proof.json'),JSON.stringify(receipt,null,2));
  await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
 }
 expect(receipt.emergencyCleanup).toEqual([]);
},120000);
