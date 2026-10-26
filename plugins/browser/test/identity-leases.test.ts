import { runInNewContext } from "node:vm";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it('applies the same persisted account lease to borrow, automation and paused viewer input',async()=>{
 const source=(await readFile('browser-extension/relay.js','utf8')).replace("import { pageOperation } from './page-operations.js';",'').replace('export function relayStatus','function relayStatus');
 const storage:Record<string,any>={};let inputs=0;
 const tabs=new Map([[10,{id:10,url:'https://accounts.example.test/login',windowId:1}],[20,{id:20,url:'https://accounts.example.test/login',windowId:2}]]);
 const listener=()=>({addListener(){}});
 const load=async()=>{
  const context:Record<string,any>={URL,Map,Set,Date,Number,Error,Array,Promise,JSON,setTimeout,clearTimeout,crypto:{randomUUID:()=> 'fixture-browser-run'},WebSocket:class{static OPEN=1;},pageOperation:async()=>{inputs++;return {ok:true};},chrome:{debugger:{onDetach:listener(),onEvent:listener(),attach:async()=>{},detach:async()=>{},sendCommand:async()=>({})},tabs:{onUpdated:listener(),onCreated:listener(),get:async(id:number)=>{if(!tabs.has(id))throw Error('No tab');return tabs.get(id);}},tabGroups:{TAB_GROUP_ID_NONE:-1},storage:{onChanged:listener(),session:{get:async()=>storage,set:async(value:unknown)=>Object.assign(storage,value)},local:{get:async()=>({}),set:async()=>{}}},alarms:{onAlarm:listener()},runtime:{onMessage:listener()}}};
  runInNewContext(source+'\nglobalThis.fixture={execute,ready:initialization};',context);
  await context.fixture.ready;return context.fixture;
 };
 let runtime=await load();const send=(threadId:string,argv:string[])=>runtime.execute({threadId,argv,deadline:Date.now()+30000});
 await send('threadA',['tab','borrow','10']);await send('threadA',['eval','1']);expect(inputs).toBe(1);
 await expect(send('threadB',['tab','borrow','20'])).rejects.toThrow('leased');
 // A pre-upgrade borrowed tab can already be persisted. It still cannot bypass leases through handoff.
 storage.threadSessions.threadB={owned:[],borrowed:[20],current:20,paused:true,label:'B'};
 runtime=await load();await expect(send('threadB',['eval','1'])).rejects.toThrow('leased');
 await expect(send('threadB',['thread','viewer',JSON.stringify({type:'text',text:'switch account'})])).rejects.toThrow('leased');expect(inputs).toBe(1);
 await send('threadB',['thread','resume']);await expect(send('threadB',['eval','1'])).rejects.toThrow('leased');expect(inputs).toBe(1);
});
