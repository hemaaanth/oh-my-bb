// @vitest-environment jsdom
import {cleanup,fireEvent,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {loadPluginApp,renderSlot} from '@get-bb/plugin-sdk/testing/app';
import {popoutViewer} from '../components/viewer-controls';
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
it('keeps the same frame and grant on fullscreen and leaves ownership unchanged when a popup is blocked',async()=>{
 const getBrowserView=vi.fn(async()=>({kind:'watch',url:'https://sandbox--1234.getbb.app/#grant'}));
 const slot=renderSlot(app.messageDirectives.find(v=>v.id==='browser-live')!,{attributes:{},message:{threadId:'thr_browser'},source:'::browser-live{}',openWorkspaceFile:null} as never,{rpc:{getBrowserView} as never});
 const frame=await slot.findByTitle('Browser session'),fullscreen=vi.fn(async()=>{});
 Object.defineProperty(frame,'requestFullscreen',{value:fullscreen});
 for(let i=0;i<3;i++)fireEvent.click(slot.getByRole('button',{name:'Fullscreen'}));
 expect(fullscreen).toHaveBeenCalledTimes(3);expect(slot.getByTitle('Browser session')).toBe(frame);expect(getBrowserView).toHaveBeenCalledOnce();
 const post=vi.spyOn((frame as HTMLIFrameElement).contentWindow!,'postMessage'),open=vi.spyOn(window,'open').mockReturnValue(null);
 fireEvent.click(slot.getByRole('button',{name:'Open in new tab'}));await slot.findByRole('alert');
 expect(post).not.toHaveBeenCalled();expect(slot.getByTitle('Browser session')).toBe(frame);open.mockRestore();
});
it('accepts a pop-out ticket only from the exact viewer origin and frame',async()=>{
 const frame=document.createElement('iframe');frame.src='https://viewer.example/#grant';document.body.append(frame);
 const replace=vi.fn(),close=vi.fn(),tab={opener:window,location:{replace},close};
 const open=vi.spyOn(window,'open').mockReturnValue(tab as unknown as Window);
 const post=vi.spyOn(frame.contentWindow!,'postMessage');
 const pending=popoutViewer(frame),request=post.mock.calls[0]![0];
 expect(tab.opener).toBeNull();
 const url='https://viewer.example/#grant&ticket=single-use';
 window.dispatchEvent(new MessageEvent('message',{origin:'https://evil.example',source:frame.contentWindow,data:{...request,url}}));
 window.dispatchEvent(new MessageEvent('message',{origin:'https://viewer.example',source:window,data:{...request,url}}));
 expect(replace).not.toHaveBeenCalled();
 window.dispatchEvent(new MessageEvent('message',{origin:'https://viewer.example',source:frame.contentWindow,data:{...request,url}}));
 await pending;expect(replace).toHaveBeenCalledWith(url);expect(close).not.toHaveBeenCalled();open.mockRestore();frame.remove();
});
