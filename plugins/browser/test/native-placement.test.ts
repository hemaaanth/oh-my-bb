import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it} from 'vitest';
const source=readFileSync('docker/trusted-browser.mjs','utf8');
const functions=source.slice(source.indexOf('function displayMode()'),source.indexOf('function privateDisplayServer()'))+source.slice(source.indexOf('function withNativeBrowser('),source.indexOf('function stateMarkerPath('));
type Seat={session?:boolean;locked?:boolean;dpms?:boolean};
const placementContext=(mode:string,remote:boolean,seat:Seat={},running:unknown=null,leased=true)=>{
 const launched:string[]=[],moves:unknown[]=[];
 const context:any={
  setting:()=>mode,env:{},which:()=>'/fixture/bb',
  spawnSync:(command:string)=>({stdout:command==='hyprctl'?JSON.stringify([{name:'DP-1',disabled:false,dpmsStatus:seat.dpms??true}]):JSON.stringify({remoteClients:remote?1:0})}),
  hyprlandSession:()=>seat.session??false,readdirSync:()=>['1','2','self'],statSync:()=>({uid:1000}),
  readFileSync:(path:string)=>path==='/proc/2/comm'&&seat.locked?'hyprlock\n':'bash\n',
  fail:(message:string)=>{throw Error(message)},
  withNativeLock:(_:unknown,f:()=>unknown)=>f(),liveNativeBrowser:()=>running,
  existsSync:()=>false,threadHoldPath:()=>'/hold',resetNativeSessions:()=>{},stopNativeBrowser:()=>{},
  launchNativeBrowser:(_:unknown,placement:string)=>{launched.push(placement);return {placement}},
  logNativeLifecycle:(_:unknown,event:string,__:unknown,detail:unknown)=>moves.push([event,detail]),
  addWindowRule:()=>{},checkNativeWindows:()=>1,withThreadLock:(_:unknown,f:()=>unknown)=>f(),retireThreadNativeBrowser:()=>{},
  applyNativeState:()=>{},join:(...parts:string[])=>parts.join('/'),writePrivate:()=>{},rmSync:()=>{},ensurePrivateDir:()=>{},
  leasePath:()=>'/lease',processStart:()=>1,process:{pid:1,getuid:()=>1000},otherLeases:()=>leased,
 };
 runInNewContext(functions+';withNativeBrowser({thread:"thr_fixture",dir:"/fixture",windowClass:"fixture"},true,b=>b)',context);
 return {launched,moves};
};
it.each([
 ['auto',false,{},'desktop'],['auto',true,{},'private'],['desktop',true,{},'desktop'],['private',false,{session:true},'private'],
 // A connected phone or web client does not hide someone who sits at the host.
 ['auto',true,{session:true},'desktop'],
 ['auto',true,{session:true,locked:true},'private'],['auto',true,{session:true,dpms:false},'private'],
] as const)('native threads honor %s with remote presence %s and seat %j', (mode,remote,seat,expected)=>{
 expect(placementContext(mode,remote,seat).launched).toEqual([expected]);
});
it('keeps a running auto browser where it is when presence changes',()=>{
 const private_={placement:'private',display:{geometry:'1920x1080'}};
 expect(placementContext('auto',false,{session:true},private_,false)).toEqual({launched:[],moves:[]});
 expect(placementContext('auto',true,{},{placement:'desktop'},false)).toEqual({launched:[],moves:[]});
});
it('still moves a running browser for an explicit display setting',()=>{
 const result=placementContext('desktop',true,{},{placement:'private',display:{geometry:'1920x1080'}},false);
 expect(result).toEqual({launched:['desktop'],moves:[['placement-change',{from:'private',to:'desktop'}]]});
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
it('tells the handoff card where a paused window is',()=>{
 const pauseOp=source.slice(source.indexOf('  if (op === "pause") {'),source.indexOf('  if (op === "resume") {'));
 const pause=(backend:string,browser:unknown)=>{
  const printed:string[]=[],held:string[]=[];
  runInNewContext(`(function(){const op="pause";${pauseOp}})()`,{
   plannedIdentity:()=>({backend}),threadHoldPath:()=>'/hold',writePrivate:(path:string)=>held.push(path),nativeWorkspace:()=>'8',
   withNativeBrowser:(_:unknown,launch:boolean,f:(b:unknown)=>unknown)=>{expect(launch).toBe(false);return f(browser);},
   withNativeLock:(_:unknown,f:()=>unknown)=>f(),withThreadLock:(_:unknown,f:()=>unknown)=>f(),threadCdp:()=>({}),
   console:{log:(line:string)=>printed.push(line)},JSON,
  });
  expect(held).toEqual(['/hold']);
  return JSON.parse(printed[0]!);
 };
 expect(pause('native',{placement:'desktop'})).toEqual({ok:true,workspace:'8',placement:'desktop'});
 expect(pause('native',{placement:'private'})).toEqual({ok:true,workspace:'8',placement:'private'});
 // An old record has no placement. Those browsers always ran on the desktop.
 expect(pause('native',{})).toEqual({ok:true,workspace:'8',placement:'desktop'});
 expect(pause('native',null)).toEqual({ok:true,workspace:'8'});
 expect(pause('agent',null)).toEqual({ok:true,workspace:'8'});
});
