import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

it.each(['dead','removed','replaced'])('requires a new network generation when the acquired browser was %s', async kind => {
  const home=await mkdtemp(join(tmpdir(),'browser-network-'));
  const directory=join(home,'sessions','thr_fixture');
  try {
    await mkdir(directory,{recursive:true});
    if(kind!=='removed')await writeFile(join(directory,'session.json'),JSON.stringify({pid:99999999,start:'1',session:kind==='dead'?'previous':'replacement',networkGeneration:'a'.repeat(32)}));
    const result=spawnSync(process.execPath,[resolve('docker/session.mjs')],{encoding:'utf8',input:JSON.stringify({home,thread:'thr_fixture',identity:{networkSession:'previous',networkGeneration:'a'.repeat(32),brave:{path:'/must-not-launch'}},argv:['eval','1+1']})});
    expect(result.status,result.stderr).toBe(75);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('reacquire before sending input');
    await expect(stat(join(directory,'lock'))).rejects.toMatchObject({code:'ENOENT'});
    await expect(stat(join(directory,'profile'))).rejects.toMatchObject({code:'ENOENT'});
  } finally {await rm(home,{recursive:true,force:true});}
});

it('does not launch a replacement if the browser dies after the expected-session liveness sample', async () => {
  const generation='a'.repeat(32), identity={mode:'direct',proxy:null,userAgent:'',brave:{path:'/must-not-launch'},networkSession:'previous',networkGeneration:generation};
  const record={pid:123,start:'42',port:9000,session:'previous',networkGeneration:generation,monitor:{pid:789,start:'42'},fingerprint:createHash('sha256').update(JSON.stringify([identity.mode,identity.proxy,identity.userAgent])).digest('hex')};
  let browserReads=0, launches=0;
  const source=readFileSync(resolve('docker/session.mjs'),'utf8').replace(/^import .*;\n/gm,'').replaceAll('import.meta.url',JSON.stringify('file:///fixture/session.mjs'));
  const fields=Array(22).fill('0');fields[19]='42';
  const run=runInNewContext(`(async()=>{${source}})()`,{
    readFileSync:()=>JSON.stringify({home:'/home',thread:'thr_fixture',identity,argv:['eval','1+1']}),
    readFile:async(path:string)=>{
      if(path.endsWith('/session.json'))return JSON.stringify(record);
      if(path==='/proc/123/stat'){fields[0]=++browserReads<=2?'S':'Z';return `123 (browser) ${fields.join(' ')}`;}
      if(path==='/proc/789/stat'){fields[0]='S';return `789 (monitor) ${fields.join(' ')}`;}
      throw Error('ENOENT');
    },
    mkdir:async()=>{},chmod:async()=>{},writeFile:async()=>{},rename:async()=>{},rm:async()=>{},readdir:async()=>[],
    existsSync:()=>false,openSync:()=>1,closeSync:()=>{},
    spawn:()=>{launches++;throw Error('Unexpected replacement');},
    fetch:async()=>{throw Error('Existing browser died');},
    process:{pid:456,env:{BB_BROWSER_HEADLESS:'1'}},join,dirname,createHash,AbortSignal,
  });
  await expect(run).rejects.toThrow('Existing browser died');
  expect(launches).toBe(0);expect(browserReads).toBe(2);
});
