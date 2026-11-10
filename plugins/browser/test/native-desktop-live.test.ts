import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
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

it.runIf(process.env.BB_TEST_REAL_NATIVE==='1')('keeps native thread profiles, displays and authentication independent without modifying the legacy profile',async()=>{
 const root=await mkdtemp(join(tmpdir(),'bb-native-desktop-proof-')),storage=process.env.BB_THREAD_STORAGE;
 const legacy=join(root,'config/BraveSoftware/Brave-native-fixture');
 await mkdir(legacy,{recursive:true});await writeFile(join(legacy,'preserve'),'legacy authentication fixture');
 const server=createServer((req,res)=>{
  const account=new URL(req.url!,'http://fixture').searchParams.get('account');
  if(account)res.setHeader('Set-Cookie',`fixture=${account}; Path=/; SameSite=Lax; Max-Age=3600`);
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Native desktop fixture</title><h1>Native fixture</h1><label>Name<input id="name"></label><button onclick="document.querySelector(\'h1\').textContent=\'Saved \'+document.querySelector(\'#name\').value">Save</button>');
 });
 const listening=Promise.withResolvers<void>();server.listen(0,'127.0.0.1',listening.resolve);await listening.promise;
 const address=server.address();if(!address||typeof address==='string')throw Error('Fixture listener unavailable');const url=`http://127.0.0.1:${address.port}`;
 const env={...process.env,BB_BROWSER_HOME:root,BB_BROWSER_BACKEND:'native',BB_BROWSER_PROFILE:'Brave-native-fixture',BB_BROWSER_EGRESS:'direct',BB_BROWSER_STATE:'',XDG_CONFIG_HOME:join(root,'config'),BB_BROWSER_EXECUTABLE:process.env.BB_TEST_BRAVE_EXECUTABLE||'/usr/bin/brave-origin'};
 const run=async(thread:string,args:string[])=>{
  const result=Promise.withResolvers<string>(),child=spawn('bb-browser',args,{env:{...env,BB_THREAD_ID:thread},stdio:['ignore','pipe','pipe']});let out='',error='';
  child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>error+=chunk);child.once('error',result.reject);child.once('close',code=>code===0?result.resolve(out):result.reject(Error(thread+' '+args.join(' ')+': '+error)));return result.promise;
 };
 const identity=(thread:string)=>join(root,'native',createHash('sha256').update(legacy+'\0'+thread).digest('hex').slice(0,12));
 const record=async(thread:string)=>JSON.parse(await readFile(join(identity(thread),'browser.json'),'utf8'));
 const value=async(thread:string,expression:string)=>JSON.parse(await run(thread,['--json','eval',expression])).data.result;
 const seed=async(value:string)=>{await mkdir(join(root,'state'),{recursive:true});await writeFile(join(root,'state/default.json'),JSON.stringify({bbCookieSync:true,cookies:[{name:'fixture',value,domain:'127.0.0.1',path:'/',expires:Math.floor(Date.now()/1000)+3600}],origins:[]}));};
 const threads=['thr_native_fixture_a','thr_native_fixture_b','thr_native_fixture_missing'];let receipt:Record<string,unknown>={};
 try{
  await seed('seed-one');await run(threads[0]!,['open',url]);expect(await value(threads[0]!,'document.cookie')).toBe('fixture=seed-one');
  await run(threads[0]!,['open',url+'/?account=A']);await run(threads[1]!,['open',url+'/?account=B']);
  const a=await record(threads[0]!),b=await record(threads[1]!);
  for(const key of ['profile','pid','windowClass'])expect(a[key]).not.toBe(b[key]);
  for(const key of ['pid','name','authority','vncSocket'])expect(a.display[key]).not.toBe(b.display[key]);
  expect(a.display.geometry).toBe('1920x1080');expect(b.display.geometry).toBe('1920x1080');
  await run(threads[0]!,['thread','pause']);const desktop=JSON.parse(await run(threads[0]!,['thread','desktop']));expect(desktop.display).toBe(a.display.name);await run(threads[0]!,['thread','resume']);
  await seed('seed-two');await run(threads[0]!,['close','--all']);await run(threads[0]!,['open',url]);
  expect(await value(threads[0]!,'document.cookie')).toBe('fixture=A');expect(await value(threads[1]!,'document.cookie')).toBe('fixture=B');
  expect((await record(threads[0]!)).profile).toBe(a.profile);
  expect(await readFile(join(legacy,'preserve'),'utf8')).toBe('legacy authentication fixture');
  await rm(join(root,'state/default.json'));await run(threads[2]!,['open',url]);expect(await value(threads[2]!,'document.cookie')).toBe('');
  await seed('seed-three');await run(threads[2]!,['close','--all']);await run(threads[2]!,['open',url]);
  expect(await value(threads[2]!,'document.cookie')).toBe('');
  const pageMetrics=await value(threads[0]!,'({width:screen.width,height:screen.height,outerWidth,outerHeight})');
  const query=spawnSync('python',['-c',displayGeometry],{env:{...process.env,DISPLAY:a.display.name,XAUTHORITY:a.display.authority},encoding:'utf8'});
  if(query.status!==0)throw Error('Owned X11 geometry query failed: '+query.stderr);
  const geometry=JSON.parse(query.stdout);
  receipt={nativeA:a,nativeB:b,geometry,pageMetrics,argv:(await readFile('/proc/'+a.pid+'/cmdline','utf8')).split('\0'),seed:'first seed imported; A/B remain after source change; A close/reopen keeps profile; missing seed on first use is not replaced by a later source seed',extension:'bb-browser open and native grouping succeeded on fresh profiles',legacy:'sentinel unchanged'};
  if(storage){await run(threads[0]!,['screenshot',join(storage,'native-fixture-page.png')]);await writeFile(join(storage,'native-desktop-proof.json'),JSON.stringify(receipt,null,2));}
  expect(geometry).toMatchObject({width:1920,height:1080});
  expect(geometry.windows).toContainEqual({width:1920,height:1080,x:0,y:0});
 }catch(error){if(storage)await writeFile(join(storage,'native-desktop-proof-error.txt'),String(error));throw error;}finally{
  for(const thread of threads){await run(thread,['thread','discard']).catch(()=>{});let owned;try{owned=await record(thread);}catch{continue;}
   if(!owned.profile.startsWith(root))throw Error('Refusing fixture cleanup outside root');
   for(const process of [owned,owned.display?.manager,owned.display])if(process?.pid){try{globalThis.process.kill(process.pid,process===owned?'SIGKILL':'SIGTERM');}catch{}}
  }
  const closed=Promise.withResolvers<void>();server.close(()=>closed.resolve());await closed.promise;await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
 }
},120000);
