import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it} from 'vitest';
const source=readFileSync('docker/trusted-browser.mjs','utf8');
const functions=source.slice(source.indexOf('function wantedPlacement()'),source.indexOf('function privateDisplayServer()'))+source.slice(source.indexOf('function withNativeBrowser('),source.indexOf('function stateMarkerPath('));
it.each([
 ['auto',false,'desktop'],['auto',true,'private'],['desktop',true,'desktop'],['private',false,'private'],
])('native threads honor %s with remote presence %s', (mode,remote,expected)=>{
 const launched:string[]=[];
 const context:any={
  setting:()=>mode,env:{},which:()=>'/fixture/bb',spawnSync:()=>({stdout:JSON.stringify({remoteClients:remote?1:0})}),
  fail:(message:string)=>{throw Error(message)},
  withNativeLock:(_:unknown,f:()=>unknown)=>f(),liveNativeBrowser:()=>null,
  existsSync:()=>false,threadHoldPath:()=>'/hold',resetNativeSessions:()=>{},stopNativeBrowser:()=>{},
  launchNativeBrowser:(_:unknown,placement:string)=>{launched.push(placement);return {placement}},
  applyNativeState:()=>{},join:(...parts:string[])=>parts.join('/'),writePrivate:()=>{},rmSync:()=>{},ensurePrivateDir:()=>{},
  leasePath:()=>'/lease',processStart:()=>1,process:{pid:1},otherLeases:()=>true,
 };
 runInNewContext(functions+';withNativeBrowser({thread:"thr_fixture",dir:"/fixture"},true,b=>b)',context);
 expect(launched).toEqual([expected]);
});
it('rejects invalid native display settings',()=>{
 expect(()=>runInNewContext(functions+';wantedPlacement()', {setting:()=> 'typo',fail:(s:string)=>{throw Error(s)}})).toThrow('BB_BROWSER_DISPLAY');
});
it('retires a closed desktop thread without requiring private-display geometry',()=>{
 const removed:string[]=[];
 const retire=source.slice(source.indexOf('function retireThreadNativeBrowser('),source.indexOf('// Under the profile',source.indexOf('function retireThreadNativeBrowser(')));
 runInNewContext(retire+';retireThreadNativeBrowser({thread:"thr_fixture"})',{
  existsSync:()=>false,threadHoldPath:()=>'/hold',otherLeases:()=>false,readThreadRecord:()=>null,sessionList:()=>[],
  readNativeBrowser:()=>({placement:'desktop',pid:1}),liveNativeBrowser:()=>null,alive:()=>false,
  profileHolder:()=>null,stopPrivateDisplay:()=>{},clearNativeRuntime:()=>{},recordPath:()=>'/browser.json',
  rmSync:(p:string)=>removed.push(p),logNativeLifecycle:()=>{},fail:(s:string)=>{throw Error(s)},
 });
 expect(removed).toEqual(['/browser.json']);
});
