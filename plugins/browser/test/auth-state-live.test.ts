import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

it.runIf(process.env.BB_TEST_AUTH_BROWSER === '1')('roundtrips scoped login storage without loading the source site during import',async()=>{
  const root=await mkdtemp(join(tmpdir(),'bb-auth-state-'));let requests=0,account='Alice';
  const server=createServer((_req,res)=>{requests++;res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Auth fixture</title><div id="account">${account}</div><script>window.siteCodeRan=true</script>`);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('No fixture address');const origin=`http://127.0.0.1:${address.port}`;
  const run=(thread:string,args:string[])=>new Promise<string>((resolveRun,reject)=>{
    const child=spawn('node',[resolve('docker/trusted-browser.mjs'),...args],{env:{...process.env,HOME:root,BB_BROWSER_HOME:join(root,'browser'),BB_BROWSER_BACKEND:'isolated',BB_BROWSER_HEADLESS:'1',BB_BROWSER_EXECUTABLE:process.env.BB_TEST_BRAVE||'/opt/brave.com/brave/brave',BB_BROWSER_EGRESS:'direct',BB_BROWSER_STATE:'none',BB_THREAD_ID:thread},stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.on('error',reject);child.on('exit',code=>code===0?resolveRun(out):reject(Error(err||out)));const timer=setTimeout(()=>child.kill('SIGTERM'),60000);child.on('close',()=>clearTimeout(timer));
  });
  try {
    await run('auth_source',['open',origin]);
    await run('auth_source',['eval',`(async()=>{localStorage.setItem('token','fixture-secret');const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('login',1);r.onupgradeneeded=()=>{const s=r.result.createObjectStore('sessions');s.createIndex('account','account');};r.onsuccess=()=>resolve(r.result);r.onerror=reject;});await new Promise((resolve,reject)=>{const tx=db.transaction('sessions','readwrite');tx.objectStore('sessions').put({account:'Alice',token:'fixture-secret'},'primary');tx.oncomplete=resolve;tx.onerror=reject;});db.close();document.cookie='session=fixture-cookie; path=/';return true})()`]);
    await run('auth_source',['state','save','fixture','--indexed-db','login']);
    await run('auth_source',['eval',`(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('unsupported',1);r.onupgradeneeded=()=>r.result.createObjectStore('sessions',{autoIncrement:true});r.onsuccess=()=>resolve(r.result)});db.close();return true})()`]);
    await expect(run('auth_source',['state','save','fixture','--indexed-db','unsupported'])).rejects.toThrow('Unsupported login database');
    const state=JSON.parse(await readFile(join(root,'browser/state/fixture.json'),'utf8'));expect(state.origins[0].indexedDB[0].stores[0].entries).toEqual([{key:'primary',value:{account:'Alice',token:'fixture-secret'}}]);
    await run('auth_dest',['doctor']);await run('auth_dest',['thread','pause']);const before=requests;
    await run('auth_dest',['identity','seed','fixture','127.0.0.1']);expect(requests).toBe(before);
    await run('auth_dest',['thread','resume']);await run('auth_dest',['open',origin]);
    expect(await run('auth_dest',['eval','localStorage.getItem("token")'])).toContain('fixture-secret');
    expect(await run('auth_dest',['eval',`(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('login');r.onsuccess=()=>resolve(r.result)});const value=await new Promise(resolve=>{const r=db.transaction('sessions').objectStore('sessions').get('primary');r.onsuccess=()=>resolve(r.result)});db.close();return value.account})()`])).toContain('Alice');
    await run('auth_dest',['state','save','checked','--account-check',JSON.stringify({url:origin,selector:'#account',expected:'Alice'})]);
    await expect(run('auth_dest',['state','save','wrong','--account-check',JSON.stringify({url:origin,selector:'#account',expected:'Bob'})])).rejects.toThrow('could not be verified');
    const checked=JSON.parse(await readFile(join(root,'browser/state/checked.json'),'utf8'));checked.accountChecks[0].expected='Bob';await writeFile(join(root,'browser/state/checked.json'),JSON.stringify(checked));
    await run('auth_dest',['thread','pause']);
    await expect(run('auth_dest',['identity','seed','checked','127.0.0.1'])).rejects.toThrow('could not be verified');
    await run('auth_dest',['thread','resume']);
    await expect(run('auth_dest',['eval','1+1'])).rejects.toThrow('Login import needs attention');
    await run('auth_dest',['thread','pause']);account='Bob';await run('auth_dest',['identity','verify']);await run('auth_dest',['thread','resume']);
    expect(await run('auth_dest',['eval','document.querySelector("#account").innerText'])).toContain('Bob');
  } finally {
    for(const thread of ['auth_source','auth_dest'])await run(thread,['thread','discard']).catch(()=>{});
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});
  }
},120000);
it.runIf(process.env.BB_TEST_AUTH_BROWSER === '1')('enforces WebRTC proxy preferences before launching a private profile',async()=>{
  const root=await mkdtemp(join(tmpdir(),'bb-network-policy-')),thread='network_policy';
  const profile=join(root,'sessions',thread,'profile','Default');
  const {mkdir}=await import('node:fs/promises');await mkdir(profile,{recursive:true});
  await writeFile(join(profile,'Preferences'),JSON.stringify({homepage:'https://example.com',webrtc:{ip_handling_policy:'default',ip_handling_url:[{url:'*',handling:'default'}]}}));
  const run=(operation:string[])=>new Promise<string>((done,reject)=>{
    const child=spawn('node',[resolve('docker/session.mjs')],{env:{...process.env,BB_BROWSER_HEADLESS:'1'},stdio:['pipe','pipe','pipe']});
    let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.on('error',reject);child.on('exit',code=>code===0?done(out):reject(Error(err)));
    child.stdin.end(JSON.stringify({home:root,thread,identity:{mode:'direct',proxy:'socks5://127.0.0.1:1080',brave:{path:process.env.BB_TEST_BRAVE||'/opt/brave.com/brave/brave'}},argv:operation}));
  });
  try{
    await run(['doctor']);const prefs=JSON.parse(await readFile(join(profile,'Preferences'),'utf8'));
    expect(prefs.homepage).toBe('https://example.com');expect(prefs.webrtc.ip_handling_policy).toBe('disable_non_proxied_udp');expect(prefs.webrtc.ip_handling_url).toEqual([]);
  }finally{await run(['thread','discard']).catch(()=>{});await rm(root,{recursive:true,force:true});}
},30000);
