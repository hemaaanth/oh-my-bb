// @vitest-environment jsdom
import {act,cleanup,fireEvent,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {loadPluginApp,renderSlot} from '@get-bb/plugin-sdk/testing/app';
const app=await loadPluginApp(()=>import('../app'));afterEach(()=>{cleanup();vi.restoreAllMocks();vi.useRealTimers();});
function announce(frame:HTMLIFrameElement,data:Record<string,unknown>,origin=new URL(frame.src).origin,source:Window|null=frame.contentWindow){
 act(()=>{window.dispatchEvent(new MessageEvent('message',{origin,source,data:{protocol:'bb-desktop-v1',...data}}));});
}
it('resolves the owning message thread and never opens a historical view automatically',async()=>{
 const getBrowserView=vi.fn(async()=>({kind:'closed'})),openBrowserView=vi.fn(async()=>({kind:'watch',url:'https://sandbox--1234.getbb.app/#grant'})),closeBrowserView=vi.fn(async()=>null);
 const slot=renderSlot(app.messageDirectives.find(v=>v.id==='browser-live')!,{attributes:{threadId:'thr_other',url:'https://evil.example'},message:{threadId:'thr_browser'},source:'::browser-live{}',openWorkspaceFile:null} as never,{rpc:{getBrowserView,openBrowserView,closeBrowserView} as never});
 await waitFor(()=>expect(getBrowserView).toHaveBeenCalledWith({threadId:'thr_browser'}));expect(openBrowserView).not.toHaveBeenCalled();
 fireEvent.click(slot.getByRole('button',{name:'Show live browser'}));await waitFor(()=>expect(slot.getByTitle('Browser session')).toBeTruthy());expect(openBrowserView).toHaveBeenCalledWith({threadId:'thr_browser'});
 fireEvent.click(slot.getByRole('button',{name:'Close view'}));await waitFor(()=>expect(slot.queryByTitle('Browser session')).toBeNull());expect(closeBrowserView).toHaveBeenCalledWith({threadId:'thr_browser'});
 // Closing an idle thread's view closes its browser too, so no dead reopen button is left behind.
 expect(slot.getByText('Closed')).toBeTruthy();expect(slot.queryByRole('button',{name:'Show live browser'})).toBeNull();
});
it('explains a failed reopen in words the user can act on',async()=>{
 const slot=renderSlot(app.messageDirectives.find(v=>v.id==='browser-live')!,{attributes:{},message:{threadId:'thr_gone'},source:'::browser-live{}',openWorkspaceFile:null} as never,{rpc:{getBrowserView:async()=>({kind:'closed'}),openBrowserView:async()=>{throw Error('Open a headed sandbox browser with bb-browser first');}} as never});
 fireEvent.click(await slot.findByRole('button',{name:'Show live browser'}));
 await waitFor(()=>expect(slot.getByRole('alert').textContent).toMatch(/Ask the agent to open it again/));
});
it('keeps the same frame and grant on fullscreen',async()=>{
 const getBrowserView=vi.fn(async()=>({kind:'watch',url:'https://sandbox--1234.getbb.app/#grant'}));
 const slot=renderSlot(app.messageDirectives.find(v=>v.id==='browser-live')!,{attributes:{},message:{threadId:'thr_browser'},source:'::browser-live{}',openWorkspaceFile:null} as never,{rpc:{getBrowserView} as never});
 const frame=await slot.findByTitle('Browser session'),fullscreen=vi.fn(async()=>{});
 Object.defineProperty(frame,'requestFullscreen',{value:fullscreen});
 for(let i=0;i<3;i++)fireEvent.click(slot.getByRole('button',{name:'Fullscreen'}));
 expect(fullscreen).toHaveBeenCalledTimes(3);expect(slot.getByTitle('Browser session')).toBe(frame);expect(getBrowserView).toHaveBeenCalledOnce();
});
it('opens a prepared session synchronously through the desktop SDK without a WindowProxy, retaining the inline owner',async()=>{
 let inClick=false;
 const nativeOpen=vi.spyOn(window,'open').mockReturnValue(null);
 const openUrl=vi.fn((url:string)=>{expect(inClick).toBe(true);window.open(url,'_blank');return true;});
 const slot=renderSlot(app.messageDirectives.find(v=>v.id==='browser-live')!,{attributes:{},message:{threadId:'thr_browser'},source:'::browser-live{}',openWorkspaceFile:null} as never,{rpc:{getBrowserView:async()=>({kind:'watch',url:'https://viewer.example/#grant'})} as never,openUrl});
 const frame=await slot.findByTitle('Browser session') as HTMLIFrameElement,button=slot.getByRole('button',{name:'Open in new tab'});
 expect(button).toHaveProperty('disabled',true);
 const url='https://viewer.example/#grant&ticket=one-use';
 announce(frame,{state:'ready',url,expires:Date.now()+60000});
 inClick=true;fireEvent.click(button);fireEvent.click(button);inClick=false;
 expect(openUrl.mock.calls).toEqual([[url],[url]]);expect(nativeOpen).toHaveBeenCalledWith(url,'_blank');
 expect(slot.getByTitle('Browser session')).toBe(frame);expect(slot.queryByRole('alert')).toBeNull();
 announce(frame,{state:'elsewhere'});expect(button).toHaveProperty('disabled',true);
});
it('rejects untrusted readiness and a failed SDK launch leaves inline viewing intact',async()=>{
 const openUrl=vi.fn(()=>false);
 const slot=renderSlot(app.messageDirectives.find(v=>v.id==='browser-live')!,{attributes:{},message:{threadId:'thr_browser'},source:'::browser-live{}',openWorkspaceFile:null} as never,{rpc:{getBrowserView:async()=>({kind:'watch',url:'https://viewer.example/#grant'})} as never,openUrl});
 const frame=await slot.findByTitle('Browser session') as HTMLIFrameElement,button=slot.getByRole('button',{name:'Open in new tab'});
 const ready={state:'ready',url:'https://viewer.example/#grant&ticket=one-use',expires:Date.now()+60000};
 announce(frame,ready,'https://evil.example');announce(frame,ready,undefined,window);
 announce(frame,{...ready,url:'https://evil.example/#grant&ticket=one-use'});
 announce(frame,{...ready,url:'https://viewer.example/#old-grant&ticket=one-use'});
 announce(frame,{...ready,expires:Date.now()-1});
 expect(button).toHaveProperty('disabled',true);fireEvent.click(button);expect(openUrl).not.toHaveBeenCalled();
 announce(frame,ready);fireEvent.click(button);await slot.findByRole('alert');
 expect(slot.getByTitle('Browser session')).toBe(frame);expect(button).toHaveProperty('disabled',false);
});
it('clears a prepared URL on expiry and session replacement, including old-document messages on the reused iframe',async()=>{
 vi.useFakeTimers();
 let url='https://viewer.example/#grant';
 const slot=renderSlot(app.messageDirectives.find(v=>v.id==='browser-live')!,{attributes:{},message:{threadId:'thr_browser'},source:'::browser-live{}',openWorkspaceFile:null} as never,{rpc:{getBrowserView:async()=>({kind:'watch',url})} as never,openUrl:()=>true});
 await act(async()=>{});
 const frame=slot.getByTitle('Browser session') as HTMLIFrameElement,button=slot.getByRole('button',{name:'Open in new tab'});
 const ready={state:'ready',url:url+'&ticket=one-use',expires:Date.now()+100};
 announce(frame,ready);expect(button).toHaveProperty('disabled',false);
 await act(async()=>{await vi.advanceTimersByTimeAsync(100);});expect(button).toHaveProperty('disabled',true);
 announce(frame,{...ready,expires:Date.now()+60000});expect(button).toHaveProperty('disabled',false);
 url='https://viewer.example/#new-grant';await slot.emitRealtime('browser-view:thr_browser',null);
 expect(button).toHaveProperty('disabled',true);
 announce(frame,{...ready,expires:Date.now()+60000});expect(button).toHaveProperty('disabled',true);
 announce(frame,{state:'ready',url:url+'&ticket=new-ticket',expires:Date.now()+60000});expect(button).toHaveProperty('disabled',false);
});
