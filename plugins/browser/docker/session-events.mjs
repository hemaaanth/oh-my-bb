import { readFile, writeFile, rename, rm, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const [directory, home, thread] = process.argv.slice(2);
const read = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };
const record = await read(join(directory, 'session.json'));
if (!record) process.exit(0);
const start = async pid => { try { const text = await readFile('/proc/' + pid + '/stat', 'utf8'),fields=text.slice(text.lastIndexOf(')')+2).split(' ');return fields[0]==='Z'?null:fields[19]; } catch { return null; } };
const alive = async child => !!child?.start && await start(child.pid) === child.start;
const version = await (await fetch('http://127.0.0.1:' + record.port + '/json/version', {signal:AbortSignal.timeout(5000)})).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let next = 0; const pending = new Map(), sessions = new Map(), events = [];
const call = (method, params = {}, sessionId) => {
  const id = ++next, {promise, resolve, reject} = Promise.withResolvers();
  const timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out')); },5000);
  pending.set(id,{resolve,reject,timer}); ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})); return promise;
};
let writes = Promise.resolve();
const persist = (file, value) => { writes = writes.then(async () => { const tmp = file + '.' + process.pid; await writeFile(tmp,JSON.stringify(value),{mode:0o600}); await rename(tmp,file); }).catch(() => {}); };
ws.onmessage = event => {
  const data = JSON.parse(event.data), p = pending.get(data.id);
  if (p) { clearTimeout(p.timer); pending.delete(data.id); data.error ? p.reject(Error(data.error.message)) : p.resolve(data.result); return; }
  const targetId = sessions.get(data.sessionId);
  if (data.method === 'Page.javascriptDialogOpening') persist(join(directory,'dialog.json'),{...data.params,targetId});
  if (data.method === 'Page.javascriptDialogClosed') persist(join(directory,'dialog.json'),null);
  if (data.method === 'Runtime.exceptionThrown' || data.method === 'Network.loadingFailed') { events.push({at:Date.now(),method:data.method,targetId,detail:data.params?.errorText || data.params?.exceptionDetails?.text || 'Page error'}); if(events.length>40)events.shift(); persist(join(directory,'diagnostics.json'),events); }
};
ws.onclose = () => { void (async()=>{if(!record.native&&!await alive(record)){
  for(const child of [record.display?.manager,record.display])if(await alive(child))try{process.kill(child.pid,'SIGTERM');}catch{}
  try{if((await readFile(join(home,'network-service'),'utf8')).trim()==='sandboxes-v1')spawnSync('bb',['plugin','run','browser',Buffer.from(JSON.stringify({argv:['network','release',...(record.networkGeneration?[record.networkGeneration]:[])]})).toString('base64url')],{timeout:30000,stdio:'ignore',env:{...process.env,BB_THREAD_ID:thread}});}catch{}
}await writes;process.exit(0);})(); };
async function scan() {
  const request=await read(join(directory,'dialog-request.json'));
  if(request){
    const dialog=await read(join(directory,'dialog.json'));const sessionId=[...sessions].find(([,target])=>target===dialog?.targetId)?.[0];
    let result={id:request.id,ok:false,error:'Dialog is no longer open; inspect current state'};
    try{if(sessionId){await call('Page.handleJavaScriptDialog',{accept:!!request.accept,promptText:String(request.promptText||'')},sessionId);result={id:request.id,ok:true};}}catch(error){result.error=error.message;}
    persist(join(directory,'dialog-result.json'),result);await rm(join(directory,'dialog-request.json'),{force:true});await writes;
  }
  const current = await read(join(directory,'session.json'));
  if (!current || current.session !== record.session || !await alive(record) || record.native && !await read(record.ownerRecord)) { ws.close(); return; }
  const hold = join(home,'threads',thread+'.hold'); let held = false;
  try { held = Date.now() - (await stat(hold)).mtimeMs < 16 * 60_000; } catch {}
  if (!record.native && !held && Date.now() - (current.lastUsed || Date.now()) > 30 * 60_000) {
    const lock=join(directory,'lock');
    try { await mkdir(lock); } catch(error) { if(error.code==='EEXIST')return;throw error; }
    try {
    await writeFile(join(lock,'owner'),JSON.stringify({pid:process.pid,start:await start(process.pid)}),{mode:0o600});
    const latest=await read(join(directory,'session.json'));
    let heldNow=false;try{heldNow=Date.now()-(await stat(hold)).mtimeMs<16*60_000;}catch{}
    if(latest?.session!==record.session||heldNow||Date.now()-(latest.lastUsed||Date.now())<=30*60_000)return;
    for(const child of [record,record.display])if(await alive(child))try{process.kill(child.pid,'SIGTERM');}catch{}
    // Keep ownership until death is confirmed; the next scan escalates a stuck process.
    await new Promise(resolve=>setTimeout(resolve,1000));
    if(await alive(record))process.kill(record.pid,'SIGKILL');
    if(await alive(record.display))process.kill(record.display.pid,'SIGKILL');
    await rm(join(directory,'session.json'),{force:true}); await rm(hold,{force:true});
    } finally {await rm(lock,{recursive:true,force:true});}
    ws.close(); return;
  }
  // Host/container memory limits bound the browser. Lifetime CPU and summed RSS
  // are not health checks: both can kill healthy sessions during manual handoff.
  const targets = (await call('Target.getTargets')).targetInfos.filter(t=>t.type==='page'&&(!record.native||current.targetIds.includes(t.targetId)));
  for(const target of targets)if(![...sessions.values()].includes(target.targetId)) {
    const {sessionId}=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});sessions.set(sessionId,target.targetId);
    await call('Page.enable',{},sessionId);await call('Runtime.enable',{},sessionId);await call('Network.enable',{},sessionId);
  }
}
await scan();
const timer=setInterval(()=>void scan().catch(()=>ws.close()),2000);
process.on('SIGTERM',()=>{clearInterval(timer);ws.close();});
