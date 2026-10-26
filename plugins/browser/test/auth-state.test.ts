import { expect, it, vi } from 'vitest';
// @ts-expect-error Runtime modules ship as plain JavaScript.
import { importState, validateState, verifyAccount } from '../docker/auth-state.mjs';

it('rejects invalid or oversized storage before browser calls',async()=>{
  for(const state of [{origins:[{origin:'https://example.com/path'}]}, {origins:[{origin:'file:///tmp'}]}, {origins:[{origin:'https://example.com',localStorage:[{name:'x',value:1}]}]}, {origins:[{origin:'https://example.com',indexedDB:[{name:'db',version:1,stores:[{name:'s',keyPath:null,autoIncrement:true,entries:[],indexes:[]}]}]}]}, {accountChecks:[{url:'https://example.com',selector:'#account',expected:''}]}, {cookies:[],padding:'x'.repeat(2*1024*1024)}]) {
    const call=vi.fn(); await expect(importState(call,()=>()=>{},state)).rejects.toThrow('Unsupported login storage');expect(call).not.toHaveBeenCalled();
  }
  expect(validateState({cookies:[],origins:[]})).toEqual({cookies:[],origins:[]});
});
it('imports on an inert background target, reads back, then installs cookies and closes',async()=>{
  let listener:Function=()=>{};
  const calls:{method:string,params:any}[]=[];
  const call=vi.fn(async(method:string,params:any={})=>{
    calls.push({method,params});
    if(method==='Target.createTarget')return {targetId:'private'};
    if(method==='Target.attachToTarget')return {sessionId:'import'};
    if(method==='Page.navigate')listener({sessionId:'import',method:'Fetch.requestPaused',params:{requestId:'nav'}});
    if(method==='Runtime.evaluate')return {result:{value:'https://example.com'}};
    if(method==='Storage.getCookies')return {cookies:[{name:'session',value:'secret',domain:'example.com',path:'/'}]};
    if(method==='DOMStorage.getDOMStorageItems')return {entries:[['token','secret']]};
    return {};
  });
  const unsubscribe=vi.fn();
  await importState(call,(handler:Function)=>{listener=handler;return unsubscribe;},{cookies:[{name:'session',value:'secret',domain:'example.com',path:'/'}],origins:[{origin:'https://example.com',localStorage:[{name:'token',value:'secret'}]}]});
  expect(calls[0]).toEqual({method:'Target.createTarget',params:{url:'about:blank',background:true}});
  expect(calls.find(c=>c.method==='Network.setBypassServiceWorker')?.params).toEqual({bypass:true});
  expect(calls.find(c=>c.method==='Fetch.fulfillRequest')).toBeDefined();
  expect(calls.findIndex(c=>c.method==='Storage.setCookies')).toBeGreaterThan(calls.findIndex(c=>c.method==='DOMStorage.getDOMStorageItems'));
  expect(calls.at(-1)?.method).toBe('Target.closeTarget');expect(unsubscribe).toHaveBeenCalledOnce();
});
it('does not install cookies after failed readback and still closes the target',async()=>{
  const call=vi.fn(async(method:string)=> method==='Target.createTarget'?{targetId:'private'}:method==='Target.attachToTarget'?{sessionId:'import'}:method==='Runtime.evaluate'?{result:{value:'https://example.com'}}:method==='DOMStorage.getDOMStorageItems'?{entries:[]}:{});
  await expect(importState(call,()=>()=>{},{cookies:[{name:'x',value:'v',domain:'example.com',path:'/'}],origins:[{origin:'https://example.com',localStorage:[{name:'token',value:'secret'}]}]})).rejects.toThrow('verification failed');
  expect(call.mock.calls.some(c=>c[0]==='Storage.setCookies')).toBe(false);expect(call.mock.calls.at(-1)?.[0]).toBe('Target.closeTarget');
});
it('checks the expected account and stops on navigation failure',async()=>{
  const page=vi.fn(async(method:string)=>method==='Runtime.evaluate'?{result:{value:true}}:{});
  await verifyAccount(page,[{url:'https://example.com/account',selector:'#account',expected:'alice@example.com'}]);
  expect(page.mock.calls[1]?.[0]).toBe('Runtime.evaluate');
  const failure=vi.fn(async()=>({errorText:'unavailable'}));
  await expect(verifyAccount(failure,[{url:'https://example.com/account',selector:'#account',expected:'Alice'}])).rejects.toThrow('Cannot verify');
});
