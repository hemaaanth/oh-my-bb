// @vitest-environment jsdom
import {cleanup,fireEvent,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {loadPluginApp,renderSlot} from '@get-bb/plugin-sdk/testing/app';
const app=await loadPluginApp(()=>import('../app'));afterEach(cleanup);
it('resolves the owning message thread and never opens a historical view automatically',async()=>{
 const getBrowserView=vi.fn(async()=>({kind:'closed'})),openBrowserView=vi.fn(async()=>({kind:'watch',url:'https://sandbox--1234.getbb.app/#grant'})),closeBrowserView=vi.fn(async()=>null);
 const slot=renderSlot(app.messageDirectives.find(v=>v.id==='browser-live')!,{attributes:{threadId:'thr_other',url:'https://evil.example'},message:{threadId:'thr_browser'},source:'::browser-live{}',openWorkspaceFile:null} as never,{rpc:{getBrowserView,openBrowserView,closeBrowserView} as never});
 await waitFor(()=>expect(getBrowserView).toHaveBeenCalledWith({threadId:'thr_browser'}));expect(openBrowserView).not.toHaveBeenCalled();
 fireEvent.click(slot.getByRole('button',{name:'Show live browser'}));await waitFor(()=>expect(slot.getByTitle('Browser session')).toBeTruthy());expect(openBrowserView).toHaveBeenCalledWith({threadId:'thr_browser'});
 expect(slot.getByTitle('Browser session').getAttribute('src')).toBe('https://sandbox--1234.getbb.app/#grant');
 fireEvent.click(slot.getByRole('button',{name:'Close view'}));await waitFor(()=>expect(slot.queryByTitle('Browser session')).toBeNull());expect(closeBrowserView).toHaveBeenCalledWith({threadId:'thr_browser'});
 // Closing an idle thread's view closes its browser too, so no dead reopen button is left behind.
 expect(slot.getByText('Closed')).toBeTruthy();expect(slot.queryByRole('button',{name:'Show live browser'})).toBeNull();
});
it('explains a failed reopen in words the user can act on',async()=>{
 const slot=renderSlot(app.messageDirectives.find(v=>v.id==='browser-live')!,{attributes:{},message:{threadId:'thr_gone'},source:'::browser-live{}',openWorkspaceFile:null} as never,{rpc:{getBrowserView:async()=>({kind:'closed'}),openBrowserView:async()=>{throw Error('Open a headed sandbox browser with bb-browser first');}} as never});
 fireEvent.click(await slot.findByRole('button',{name:'Show live browser'}));
 await waitFor(()=>expect(slot.getByRole('alert').textContent).toMatch(/Ask the agent to open it again/));
});
it('explains local viewing without embedding a personal desktop',async()=>{
 const slot=renderSlot(app.messageDirectives.find(v=>v.id==='browser-live')!,{attributes:{},message:{threadId:'thr_local'},source:'::browser-live{}',openWorkspaceFile:null} as never,{rpc:{getBrowserView:()=>({kind:'local'})} as never});
 await waitFor(()=>expect(slot.getByText(/browser is local/)).toBeTruthy());expect(slot.queryByTitle('Browser session')).toBeNull();
});
