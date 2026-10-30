import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomInt, createHash } from 'node:crypto';
import { mkdir, chmod, readFile, writeFile, rename, rm, readdir, stat, readlink } from 'node:fs/promises';
import { existsSync, openSync, closeSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageOperation } from '../browser-extension/page-operations.js';
import { desktopOperation,prepareDesktop } from './desktop.mjs';
import { nodeRuntime } from './node-runtime.mjs';
import { importState, verifyAccount, validateState, databaseState } from './auth-state.mjs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const { home, thread, identity, argv } = input;
if (!/^[A-Za-z0-9_-]{1,128}$/.test(thread)) throw Error('Isolated sessions require BB_THREAD_ID');
const directory = join(home, 'sessions', thread);
await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
const recordFile = join(directory, 'session.json'), holdFile = join(home, 'threads', thread + '.hold');
const lock = join(directory, 'lock');
let locked = false;
const read = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };
const processStart = async pid => { try { const text = await readFile('/proc/' + pid + '/stat', 'utf8'); const fields=text.slice(text.lastIndexOf(')')+2).split(' ');return fields[0]==='Z'?null:fields[19]; } catch { return null; } };
const alive = async p => !!p?.start && await processStart(p.pid) === p.start;
const profileOwner = async profile => {
  try { const pid=Number(/-(\d+)$/.exec(await readlink(join(profile,'SingletonLock')))?.[1]);
    if(!pid||(await stat('/proc/'+pid)).uid!==process.getuid())return null;
    const args=' '+(await readFile('/proc/'+pid+'/cmdline','utf8')).split('\0').filter(Boolean).join(' ')+' ';
    if(!args.includes(' --user-data-dir='+profile+' ')||args.includes(' --type='))return null;
    return {pid,start:await processStart(pid)};
  } catch{return null;}
};
const stop = async child => {
  if(!await alive(child))return;
  process.kill(child.pid,'SIGTERM');
  for(let i=0;i<30&&await alive(child);i++)await new Promise(resolve=>setTimeout(resolve,100));
  if(await alive(child))process.kill(child.pid,'SIGKILL');
  for(let i=0;i<20&&await alive(child);i++)await new Promise(resolve=>setTimeout(resolve,50));
  if(await alive(child))throw Error('Owned browser process did not stop; ownership was retained');
};
const privateWrite = async (file, value) => { const tmp = file + '.' + process.pid; await writeFile(tmp, JSON.stringify(value), { mode: 0o600 }); await rename(tmp, file); };
for (let i = 0; i < 300; i++) {
  try { await mkdir(lock); await privateWrite(join(lock, 'owner'), { pid: process.pid, start: await processStart(process.pid) }); locked = true; break; }
  catch (error) { if (error.code !== 'EEXIST') throw error; const owner = await read(join(lock, 'owner')); if (owner && !await alive(owner)) await rm(lock, { recursive: true, force: true }); else await new Promise(resolve => setTimeout(resolve, 100)); }
}
if (!locked) throw Error('Session busy (30s); no browser input sent');
let ws, record;
try {
  record = await read(recordFile);
  if (record && await alive(record) && identity.networkGeneration && record.networkGeneration !== identity.networkGeneration) {
    // A monitor captures its generation at startup; retire it before promotion.
    await stop(record.monitor); record.monitor=null;
    record.networkGeneration = identity.networkGeneration; await privateWrite(recordFile,record);
    const events=spawn(nodeRuntime(),[fileURLToPath(new URL('./session-events.mjs',import.meta.url)),directory,home,thread],{detached:true,stdio:'ignore'});events.on('error',()=>{});events.unref();
    record.monitor={pid:events.pid,start:await processStart(events.pid)};await privateWrite(recordFile,record);
  }
  const [command, ...args] = input.operation || argv;
  const viewer = command === 'thread' && args[0] === 'viewer';
  const viewerInput=viewer?JSON.parse(args.slice(1).join(' ')||'{}'):null;
  const control = command === 'thread';
  const seeding = command === 'identity' && args[0] === 'seed';
  const verifying = command === 'identity' && args[0] === 'verify';
  if (existsSync(holdFile) && !control && !seeding && !verifying && command !== 'close') throw Error('Browser paused for manual handoff');
  if (verifying && !existsSync(holdFile)) throw Error('Pause this session before verifying its signed-in account');
  if (seeding && !existsSync(holdFile)) throw Error('Pause this session before explicitly replacing its authentication seed');
  if (control && args[0] === 'pause') {
    if (!await alive(record)) throw Error('Open this session before handing it off');
    if(record.display)await prepareDesktop(record);
    await mkdir(dirname(holdFile), { recursive: true, mode: 0o700 }); await writeFile(holdFile, 'manual\n', { mode: 0o600 });
    console.log(JSON.stringify({ ok: true, session: record.session, host: record.host }));
  } else if (control && args[0] === 'resume') { await rm(holdFile, { force: true }); console.log('{"ok":true}'); }
  else if(control&&args[0]==='desktop'){
    if((!existsSync(holdFile)&&args[1]!=='--watch')||!await alive(record)||!await alive(record.display))throw Error('A running headed isolated session is required; pause it for interactive access');
    console.log(JSON.stringify({display:record.display.name,authority:record.display.authority,vncSocket:record.display.vncSocket,owner:{pid:record.pid,start:record.start},displayOwner:{pid:record.display.pid,start:record.display.start}}));
  }
  else if (command === 'close' || control && ['close', 'discard'].includes(args[0])) {
    if (existsSync(holdFile) && args[0] !== 'discard') { console.log('{"ok":true,"held":true}'); }
    else {
      const owner=await profileOwner(join(directory,'profile'));
      for (const child of [owner,record?.display?.manager,record?.display]) await stop(child);
      await rm(recordFile, { force: true }); await rm(holdFile, { force: true }); console.log('{"ok":true}');
    }
  } else if(command === 'dialog'||viewer&&viewerInput.type==='dialog') {
    if(viewer&&!existsSync(holdFile))throw Error('Viewer expired');
    const dialogArgs=viewer?[viewerInput.accept?'accept':'dismiss',viewerInput.promptText||'']:args;
    const dialog=await read(join(directory,'dialog.json'));
    if(!dialogArgs[0]||dialogArgs[0]==='inspect')console.log(JSON.stringify({pending:dialog}));
    else {
      if(!dialog||!['accept','dismiss'].includes(dialogArgs[0]))throw Error('No pending dialog or unsupported dialog operation');
      const id=randomBytes(12).toString('hex');await privateWrite(join(directory,'dialog-request.json'),{id,accept:dialogArgs[0]==='accept',promptText:dialogArgs[1]||''});
      let answer;for(let i=0;i<150;i++){answer=await read(join(directory,'dialog-result.json'));if(answer?.id===id)break;await new Promise(resolve=>setTimeout(resolve,100));}
      if(answer?.id!==id||!answer.ok)throw Error(answer?.error||'Dialog decision deadline; inspect before retrying');
      console.log(JSON.stringify({handled:true,accepted:dialogArgs[0]==='accept'}));
    }
  } else {
    const running = await alive(record);
    if (identity.networkSession && (record?.session !== identity.networkSession || !running)) {
      throw Object.assign(Error('Browser ended during network acquisition; reacquire before sending input'), {code:'BB_BROWSER_REACQUIRE'});
    }
    if (!running) {
      const starting=join(home,'sessions','.starting');let capacityLock=false;
      for(let i=0;i<300;i++){try{await mkdir(starting);await privateWrite(join(starting,'owner'),{pid:process.pid,start:await processStart(process.pid)});capacityLock=true;break;}catch(error){if(error.code!=='EEXIST')throw error;const owner=await read(join(starting,'owner'));if(owner&&!await alive(owner))await rm(starting,{recursive:true,force:true});else await new Promise(resolve=>setTimeout(resolve,100));}}
      if(!capacityLock)throw Error('Browser startup capacity check busy (30s)');
      try {
      if (control) throw Error('Browser session is no longer running; reopen it explicitly');
      // Runtime and profile are per thread. A restarted process never reuses an old target.
      for(const child of [record?.display?.manager,record?.display])await stop(child);
      const parent = dirname(directory);
      const sessions = await readdir(parent);
      let count = 0; for (const name of sessions) if (await alive(await read(join(parent, name, 'session.json')))) count++;
      if (count >= 4) throw Error('Four isolated sessions are already running; close an idle session first');
      const profile = join(directory, 'profile'); await mkdir(profile, { recursive: true, mode: 0o700 });
      if (identity.proxy) {
        const defaults=join(profile,'Default');await mkdir(defaults,{recursive:true,mode:0o700});
        const file=join(defaults,'Preferences');let preferences={};
        try{preferences=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw Error('Cannot apply private browser network policy');}
        await privateWrite(file,{...preferences,webrtc:{...preferences.webrtc,ip_handling_policy:'disable_non_proxied_udp',ip_handling_url:[]}});
      }
      const log = openSync(join(directory, 'browser.log'), 'a', 0o600);
      let display;
      const headless = process.env.BB_BROWSER_HEADLESS === '1';
      if (!headless) {
        const number = randomInt(100, 10000), name = ':' + number, authority = join(directory, 'Xauthority');
        const auth = spawnSync('xauth', ['-f', authority, 'add', name, '.', randomBytes(16).toString('hex')], { stdio: 'ignore', timeout: 5000 });
        if (auth.status !== 0) throw Error('Headed isolated sessions need xauth and TigerVNC on this host');
        const vncSocket='/tmp/bb-vnc-'+randomBytes(16).toString('hex')+'.sock';
        const displayServer = spawn('Xtigervnc', [name, '-geometry', '1440x1000', '-depth', '24', '-rfbport', '-1', '-rfbunixpath', vncSocket, '-rfbunixmode', '0600', '-SecurityTypes', 'None', '-AcceptSetDesktopSize', '1', '-AlwaysShared', '-nolisten', 'tcp', '-auth', authority], { detached: true, stdio: ['ignore', log, log] });
        displayServer.on('error', () => {}); displayServer.unref();
        for (let i = 0; i < 100 && !existsSync('/tmp/.X11-unix/X' + number); i++) await new Promise(resolve => setTimeout(resolve, 30));
        if (!existsSync('/tmp/.X11-unix/X' + number)) throw Error('Private resizable display failed; install tigervnc-standalone-server on this host');
        display = { pid: displayServer.pid, start: await processStart(displayServer.pid), name, authority, vncSocket };
        const manager=spawn('openbox',[],{detached:true,stdio:['ignore',log,log],env:{...process.env,DISPLAY:name,XAUTHORITY:authority,WAYLAND_DISPLAY:''}});try{await new Promise((resolve,reject)=>{manager.once('spawn',resolve);manager.once('error',reject);});}catch{await stop(display);closeSync(log);throw Error('Private session window manager unavailable; install Openbox on this host');}manager.unref();display.manager={pid:manager.pid,start:await processStart(manager.pid)};
      }
      const flags = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-quic', '--disable-blink-features=AutomationControlled', '--window-size=1440,1000', ...(headless?[]:['--start-maximized']), ...(headless ? ['--headless=new'] : ['--ozone-platform=x11']), ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])];
      if (identity.proxy) flags.push(`--proxy-server=${identity.proxy}`, '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
      if (identity.userAgent) flags.push('--user-agent=' + identity.userAgent);
      await rm(join(profile, 'DevToolsActivePort'), { force: true });
      const child = spawn(display?'dbus-run-session':identity.brave.path, [...(display?['--','sh','-c','dbus-update-activation-environment DISPLAY XAUTHORITY XDG_CURRENT_DESKTOP GDK_BACKEND; exec "$@"','bb-private-desktop',identity.brave.path]:[]),...flags, 'about:blank'], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, ...(display ? { DISPLAY: display.name, XAUTHORITY: display.authority, WAYLAND_DISPLAY: '',DBUS_SESSION_BUS_ADDRESS:'',GTK_USE_PORTAL:'0',GDK_BACKEND:'x11',XDG_CURRENT_DESKTOP:'Openbox' } : {}) } });
      child.on('error', () => {}); child.unref(); closeSync(log);
      let port;
      for (let i = 0; i < 200; i++) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {} await new Promise(resolve => setTimeout(resolve, 50)); }
      if (!port) { await stop(await profileOwner(profile)); await stop(display); throw Error('Isolated Brave did not start; see private session browser.log'); }
      const owner=await profileOwner(profile);if(!owner?.start)throw Error('Could not verify isolated Brave profile owner');
      record = { ...owner, port, display, networkGeneration:identity.networkGeneration, session: randomBytes(16).toString('hex'), thread, host: process.env.HOSTNAME || 'local', lastUsed:Date.now(), profile, headless, fingerprint: createHash('sha256').update(JSON.stringify([identity.mode, identity.proxy, identity.userAgent])).digest('hex') };
      await privateWrite(recordFile, record);
      const events = spawn(nodeRuntime(),[fileURLToPath(new URL('./session-events.mjs',import.meta.url)),directory,home,thread],{detached:true,stdio:'ignore'}); events.on('error',()=>{}); events.unref();
      record.monitor={pid:events.pid,start:await processStart(events.pid)};await privateWrite(recordFile,record);
      } finally {await rm(starting,{recursive:true,force:true});}
    }
    if(!await alive(record.monitor)){const events=spawn(nodeRuntime(),[fileURLToPath(new URL('./session-events.mjs',import.meta.url)),directory,home,thread],{detached:true,stdio:'ignore'});events.on('error',()=>{});events.unref();record.monitor={pid:events.pid,start:await processStart(events.pid)};await privateWrite(recordFile,record);}
    const fingerprint = createHash('sha256').update(JSON.stringify([identity.mode, identity.proxy, identity.userAgent])).digest('hex');
    if (record.fingerprint !== fingerprint) throw Error('Session network or identity changed. Close the session before changing its routing; no fallback used');
    if(viewer&&record.display){
      if(!existsSync(holdFile))throw Error('Viewer expired; session is not paused');
      console.log(JSON.stringify(desktopOperation(record.display,viewerInput)));
      await privateWrite(recordFile,{...record,lastUsed:Date.now()});
    }else{
    const version = await (await fetch('http://127.0.0.1:' + record.port + '/json/version', { signal: AbortSignal.timeout(5000) })).json();
    const endpoint = new URL(version.webSocketDebuggerUrl);
    if (endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost') throw Error('Nonlocal debugger refused');
    ws = new WebSocket(endpoint); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const listeners = new Set();
    let id = 0; const pending = new Map(); let dialog = await read(join(directory,'dialog.json'));
    const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(Error(method + ' deadline (15s); inspect before retrying')); }, 15000);
      pending.set(n, { resolve, reject, timer }); ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    ws.onmessage = event => { const message = JSON.parse(event.data), p = pending.get(message.id); for(const listener of listeners)listener(message); if (p) { clearTimeout(p.timer); pending.delete(message.id); message.error ? p.reject(Error(message.error.message)) : p.resolve(message.result); }
      else if (message.method === 'Page.javascriptDialogOpening') { dialog = message.params; record.dialog = dialog; }
      else if (message.method === 'Page.javascriptDialogClosed') { dialog = null; record.dialog = null; }
      else if (message.method === 'Page.screencastFrame') void call('Page.screencastFrameAck', { sessionId: message.params.sessionId }, message.sessionId).catch(() => {});
    };
    const targets = (await call('Target.getTargets')).targetInfos.filter(t => t.type === 'page');
    const runtime=join('/tmp','bb-ab-'+process.getuid()+'-'+createHash('sha256').update(home).digest('hex').slice(0,16)),namespace='bb-i-'+record.session.slice(0,12);await mkdir(runtime,{recursive:true,mode:0o700});await chmod(runtime,0o700);
    const pinDirectory = join(runtime,'namespaces',namespace,'run'); await mkdir(pinDirectory,{recursive:true,mode:0o700});
    const pinFile = join(pinDirectory,'default.target');
    const pinned = await read(pinFile);
    const usable=targets.filter(t=>!/^chrome(?:-extension)?:/.test(t.url));
    let target = usable.find(t=>t.targetId === pinned?.targetId) || usable.find(t => t.targetId === record.target);
    if(viewer){
      if(viewerInput.type==='tab'){if(!usable.some(t=>t.targetId===viewerInput.target))throw Error('Viewer target is outside this session');record.viewerTargetId=viewerInput.target;}
      target=usable.find(t=>t.targetId===record.viewerTargetId)||target;
    }
    if(!target)target={targetId:(await call('Target.createTarget',{url:'about:blank',background:true})).targetId,url:'about:blank'};
    if (!target) target = { targetId: (await call('Target.createTarget', { url: 'about:blank', background: true })).targetId };
    record.target = target.targetId;
    if(!pinned)await privateWrite(pinFile,{targetId:target.targetId,url:target.url||'about:blank',pinned:true});
    const sessionId = (await call('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
    const page = (method, params) => call(method, params, sessionId);
    if(command !== 'dialog' && !dialog)await page('Page.enable');
    if (identity.mode === 'home' && !control) {
      // Verify a request made by Brave itself. Proxy failure never retries direct.
      const proof = await call('Target.createTarget', { url: 'about:blank', background: true });
      try { const sid = (await call('Target.attachToTarget', { targetId: proof.targetId, flatten: true })).sessionId;
        const c = (method, params) => call(method, params, sid);
        const url = process.env.BB_BROWSER_IP_ECHO_URL || 'https://api.ipify.org';
        const nav = await c('Page.navigate', { url }); if (nav.errorText) throw Error('Home egress browser probe failed: ' + nav.errorText);
        let ip = ''; for (let i = 0; i < 50; i++) { const result = await c('Runtime.evaluate', { expression: 'document.body?.innerText.trim()', returnByValue: true }); ip = result.result?.value || ''; if (/^[0-9a-f:.]+$/i.test(ip)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
        const expected = (process.env.BB_BROWSER_HOME_EGRESS_IP || input.expectedIps || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!ip || !expected.length || !expected.includes(ip)) throw Error('Browser home egress verification failed or expected IP is unset; no direct fallback');
        record.egress = { ip, verifiedAt: Date.now() };
      } finally { await call('Target.closeTarget', { targetId: proof.targetId }); }
    }
    const applySeed = async state => {
      validateState(state);
      await privateWrite(join(directory,'seed-error'),{checks:state.accountChecks||[]});
      await importState(call, listener => { listeners.add(listener); return () => listeners.delete(listener); }, state);
      await verifyAccount(page, state.accountChecks);
      await privateWrite(join(directory,'seed-applied'),{at:Date.now()});
      await rm(join(directory,'seed-error'),{force:true});
    };
    if(existsSync(join(directory,'seed-error'))&&!control&&!seeding&&command!=='doctor'&&!verifying)throw Error('Login import needs attention. Pause for manual login, then run identity verify.');
    if (!control && !seeding && !verifying && command!=='doctor' && !existsSync(join(directory,'seed-applied'))) { if(identity.state)await applySeed(JSON.parse(await readFile(identity.state,'utf8'))); else await privateWrite(join(directory,'seed-applied'),{at:Date.now()}); }
    let result;
    if (viewer) {
      if (!existsSync(holdFile)) throw Error('Viewer expired; session is not paused');
      const action = viewerInput;
      if (action.type === 'frame') result = {...(dialog?{data:''}:await pageOperation(page, ['screenshot'])),tabs:usable.map(t=>({id:t.targetId,title:t.title,url:t.url})),current:target.targetId,dialog};
      else if(action.type==='tab')result={selected:target.targetId};
      else if(action.type==='scroll')result=await pageOperation(page,['scroll',action.deltaY<0?'up':'down',String(Math.abs(action.deltaY))]);
      else if (action.type === 'pointer') { if (!Number.isFinite(action.x) || !Number.isFinite(action.y) || action.x < 0 || action.x > 16384 || action.y < 0 || action.y > 16384) throw Error('Invalid viewer coordinates'); result = await page('Input.dispatchMouseEvent', { type: action.event === 'move' ? 'mouseMoved' : action.event === 'up' ? 'mouseReleased' : 'mousePressed', x: action.x, y: action.y, button: 'left', clickCount: 1 }); }
      else if (action.type === 'text') result = await page('Input.insertText', { text: String(action.text || '').slice(0, 4096) });
      else if (action.type === 'key') result = await pageOperation(page, ['press', String(action.key || '').slice(0, 40)]);
      else throw Error('Unknown viewer action');
    } else if (control && args[0] === 'show') { if (record.headless) throw Error('This scratch session is headless; create a headed session for handoff'); result = { ok: true, session: record.session }; }
    else if (command === 'doctor') result = {connected:true,session:record.session,thread,host:record.host,authentication:'isolated profile',headed:!record.headless,egress:record.egress || identity.mode,dialog,errors:await read(join(directory,'diagnostics.json')) || []};
    else if (command === 'wait' && args.length === 1 && /^\d+$/.test(args[0])) {
      const milliseconds=Number(args[0]);
      if(milliseconds>30000)throw Error('Numeric waits support at most 30000 ms per command');
      // A timer needs no general-engine connection; keep normal ownership and egress checks.
      await new Promise(resolve=>setTimeout(resolve,milliseconds));
      result={success:true,data:{waited:milliseconds}};
    }
    else if (command === 'identity') {
      if(args[0]!=='verify'&&!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(args[1]||''))throw Error('Invalid identity seed name');
      if(args[0]==='seed') {
        const domains=(args[2]||'').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
        if(!domains.length||domains.some(d=>!/^[a-z0-9.-]+$/.test(d)))throw Error('Explicit seed domains required');
        const state=JSON.parse(await readFile(join(home,'state',args[1]+'.json'),'utf8'));
        const allowed=d=>domains.some(domain=>d.replace(/^\./,'')===domain||d.endsWith('.'+domain));
        validateState(state);
        if((state.accountChecks||[]).some(c=>!allowed(new URL(c.url).hostname)))throw Error('Account check is outside the requested seed domains');
        const scoped={cookies:(state.cookies||[]).filter(c=>allowed(c.domain)),origins:(state.origins||[]).filter(o=>allowed(new URL(o.origin).hostname)),accountChecks:state.accountChecks};
        if(!scoped.cookies.length&&!scoped.origins.length)throw Error('No saved login storage matches those domains');
        await applySeed(scoped);
        result={seeded:args[1],domains};
      } else if(args[0]==='save') {
        const options=args.slice(2),databaseNames=[],accountChecks=[];
        for(let i=0;i<options.length;i+=2){
          if(!options[i+1])throw Error('Missing state save option value');
          if(options[i]==='--indexed-db')databaseNames.push(...options[i+1].split(',').filter(Boolean));
          else if(options[i]==='--account-check')accountChecks.push(JSON.parse(options[i+1]));
          else throw Error('Unknown state save option');
        }
        if(databaseNames.length>8||databaseNames.some(n=>n.length>256))throw Error('Select at most eight login databases');
        validateState({accountChecks});
        // Account checks may navigate; verify only after capturing the requested origin.
        const cookies=(await call('Storage.getCookies')).cookies,origins=[];
        const local=await page('Runtime.evaluate',{expression:'({origin:location.origin,localStorage:Object.entries(localStorage).map(([name,value])=>({name,value}))})',returnByValue:true});
        if(local.result?.value&&/^https?:/.test(local.result.value.origin))origins.push(local.result.value);
        if(databaseNames.length){
          if(!origins.length)throw Error('Open the signed-in site before saving a login database');
          const captured=await page('Runtime.evaluate',{expression:`(${databaseState.toString()})('capture',${JSON.stringify(databaseNames.map(name=>({name})))})`,awaitPromise:true,returnByValue:true});
          if(captured.exceptionDetails)throw Error('Unsupported login database. Use manual login.');
          origins[0].indexedDB=captured.result?.value;
        }
        const state=validateState({cookies,origins,accountChecks});
        await verifyAccount(page,accountChecks);
        await mkdir(join(home,'state'),{recursive:true,mode:0o700});await privateWrite(join(home,'state',args[1]+'.json'),state);result={saved:args[1],cookies:cookies.length,origins:origins.length,accountChecks:accountChecks.length};
      } else if(args[0]==='verify') {
        const failed=await read(join(directory,'seed-error'));
        if(!failed?.checks?.length)throw Error('Retry the seed import; no expected account was supplied to verify');
        await verifyAccount(page,failed.checks);
        await privateWrite(join(directory,'seed-applied'),{at:Date.now()});await rm(join(directory,'seed-error'),{force:true});result={verified:true};
      } else throw Error('Use identity seed <name> <domains> while paused, or state save <name>');
    }
    else if (['observe', 'act', 'dialog', 'screenshot', 'settle'].includes(command)) result = await pageOperation(page, [command,...args], { dialog });
    else {
      const engineEnv={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_'))),AGENT_BROWSER_SOCKET_DIR:runtime};
      const connected=spawnSync('agent-browser',['--config',input.agentConfig,'--namespace',namespace,'--session','default','connect',String(record.port)],{encoding:'utf8',timeout:30000,env:engineEnv});
      if(connected.status!==0)throw Error('Could not connect general engine to the isolated browser: '+(connected.stderr?.trim()||connected.error?.code||`exit ${connected.status}, signal ${connected.signal||'none'}`));
      const binding=command === 'tab' ? {status:0} : spawnSync('agent-browser',['--config',input.agentConfig,'--namespace',namespace,'--session','default','--cdp',String(record.port),'--pin-tab','tab',target.targetId],{encoding:'utf8',timeout:30000,env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_'))),AGENT_BROWSER_SOCKET_DIR:runtime}});
      if(binding.status!==0)throw Error('Could not bind the general engine to this session target: '+binding.stderr.trim());
      const child = spawnSync('agent-browser', ['--config', input.agentConfig, '--namespace', namespace, '--session', 'default', '--cdp', String(record.port), '--pin-tab', ...argv], { encoding: 'utf8', timeout: 30000, env: {...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_BROWSER_'))),AGENT_BROWSER_SOCKET_DIR:runtime} });
      if (child.stdout) process.stdout.write(child.stdout); if (child.stderr) process.stderr.write(child.stderr); process.exitCode = child.status ?? 1;
      record.target=(await read(pinFile))?.targetId||record.target;
    }
    await call('Target.detachFromTarget', { sessionId }).catch(() => {});
    if (result !== undefined) { if (command === 'screenshot' && args[0] && !args[0].startsWith('--')) { await writeFile(args[0], Buffer.from(result.data, 'base64'), { mode: 0o600 }); console.log(JSON.stringify({ path: args[0] })); } else console.log(JSON.stringify(result)); }
    await privateWrite(recordFile, { ...record, dialog, lastUsed: Date.now() });
    }
  }
} catch (error) {
  if (error.code !== 'BB_BROWSER_REACQUIRE') throw error;
  process.stderr.write(error.message+'\n'); process.exitCode=75;
} finally { ws?.close(); await rm(lock, { recursive: true, force: true }); }
