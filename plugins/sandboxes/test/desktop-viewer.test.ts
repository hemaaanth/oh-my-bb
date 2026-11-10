import {afterEach,expect,it,vi} from 'vitest';
import {ViewerLease,viewerScript} from '../src/desktop-viewer.js';
import {embeddedViewerUrl} from '../components/viewer-controls.js';
import {runInNewContext} from 'node:vm';
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('rejects automatic contenders and duplicate sockets, then permits a reconnect after pair cleanup',()=>{
 const viewer=new ViewerLease(),secret=viewer.acquire(),cancel=vi.fn();
 expect(viewer.acquire()).toBeNull();expect(viewer.owns(null)).toBe(false);
 const pair=viewer.reserve(secret,cancel)!;
 expect(viewer.reserve(secret,vi.fn())).toBeNull();expect(cancel).not.toHaveBeenCalled();
 pair.done();const next=viewer.reserve(secret,vi.fn())!;
 pair.done();expect(viewer.reserve(secret,vi.fn())).toBeNull();expect(next.current()).toBe(true);
});
it('consumes transfer tickets once, cancels pending upgrades and prevents late callbacks from clearing the new pair',()=>{
 const viewer=new ViewerLease(),first=viewer.acquire(),cancel=vi.fn(),pending=viewer.reserve(first,cancel)!;
 const ticket=viewer.transfer(first)!;expect(cancel).not.toHaveBeenCalled();
 const second=viewer.acquire(false,ticket)!;
 expect(cancel).toHaveBeenCalledOnce();expect(pending.current()).toBe(false);
 expect(viewer.acquire(false,ticket)).toBeNull();expect(viewer.reserve(first,vi.fn())).toBeNull();
 const current=viewer.reserve(second,vi.fn())!;pending.done();
 expect(current.current()).toBe(true);expect(viewer.reserve(second,vi.fn())).toBeNull();
 viewer.release(first);expect(current.current()).toBe(true);
 viewer.release(second);expect(current.current()).toBe(false);
});
it('keeps one prepared ticket through repeated requests until its grant expires or its generation changes',()=>{
 vi.useFakeTimers();
 const viewer=new ViewerLease(),first=viewer.acquire(),cancel=vi.fn(),pair=viewer.reserve(first,cancel)!;
 const expires=Date.now()+15*60000,ticket=viewer.transfer(first,expires)!;
 vi.advanceTimersByTime(60000);expect(viewer.transfer(first,expires)).toBe(ticket);
 expect(pair.current()).toBe(true);expect(cancel).not.toHaveBeenCalled();
 const second=viewer.acquire(false,ticket)!;
 expect(viewer.acquire(false,ticket)).toBeNull();expect(cancel).toHaveBeenCalledOnce();
 const next=viewer.transfer(second,expires)!;expect(next).not.toBe(ticket);
 vi.advanceTimersByTime(14*60000);expect(viewer.acquire(false,next)).toBeNull();expect(viewer.transfer(second,expires)).toBeNull();
 expect(viewer.owns(second)).toBe(true);
});
it('binds tickets to generation and expiry, without revoking the owner when a popup is blocked or never navigates',()=>{
 vi.useFakeTimers();
 const viewer=new ViewerLease(),first=viewer.acquire(),ticket=viewer.transfer(first)!;
 vi.advanceTimersByTime(30000);expect(viewer.acquire(false,ticket)).toBeNull();expect(viewer.owns(first)).toBe(true);
 const stale=viewer.transfer(first)!;const second=viewer.acquire(true);
 expect(viewer.acquire(false,stale)).toBeNull();expect(viewer.owns(second)).toBe(true);
});

const local='http://127.0.0.1:38886',remote='https://owner.getbb.app',configured='https://configured.example';
async function wrapper(declared:string,sender:string,sourceIsParent=true,declare=true){
 vi.stubGlobal('location',{href:declared+'/thread',origin:declared});
 const source=embeddedViewerUrl('https://sandbox--40000.getbb.app/#'+'t'.repeat(43));
 const events:Record<string,(event:unknown)=>Promise<void>>={},commands:string[]=[],replies:Array<{data:{id?:string};origin:string}>=[],elements=new Map();
 const element=()=>({hidden:false,replaceChildren(){},remove(){},removeAttribute(){},setAttribute(){}});
 const parent={postMessage:(data:{id?:string},origin:string)=>replies.push({data,origin})};
 runInNewContext(viewerScript([local,remote,configured]),{
  URLSearchParams,location:{hash:declare?new URL(source).hash:'#'+'t'.repeat(43),pathname:'/',origin:'https://sandbox--40000.getbb.app'},history:{replaceState(){}},
  document:{querySelector:(id:string)=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);},createElement:element,addEventListener(){}},parent,window:{},
  fetch:async(_path:string,args:{body:string})=>{const body=JSON.parse(args.body);commands.push(body.action);return {status:200,ok:true,json:async()=>body.action==='acquire'?{lease:'l'.repeat(43)}:{ticket:'k'.repeat(43),expires:Date.now()+60000}};},
  addEventListener:(type:string,handler:(event:unknown)=>Promise<void>)=>{events[type]=handler;},setInterval(){},
 });
 await new Promise(resolve=>setImmediate(resolve));const before=commands.length;
 await events.message!({source:sourceIsParent?parent:{},origin:sender,data:{protocol:'bb-desktop-v1',id:'transfer',action:'transfer'}});
 return {commands:commands.slice(before),replies:replies.filter(reply=>reply.data.id==='transfer')};
}
it.each([local,remote,configured])('transfers from the declared trusted actual parent %s',async origin=>{
 const proof=await wrapper(origin,origin);
 expect(proof.replies).toHaveLength(1);expect(proof.replies[0]!.origin).toBe(origin);
});
it.each([
 ['https://other.getbb.app','https://other.getbb.app',true,true],
 ['https://sandbox--40000.getbb.app','https://sandbox--40000.getbb.app',true,true],
 [local,remote,true,true],
 [local,local,false,true],
 [remote,remote,true,false],
] as const)('rejects untrusted, undeclared or wrong-frame parent %s/%s',async(declared,sender,source,declare)=>{
 const proof=await wrapper(declared,sender,source,declare);expect(proof.commands).toEqual([]);expect(proof.replies).toEqual([]);
});
