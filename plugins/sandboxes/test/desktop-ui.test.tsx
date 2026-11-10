// @vitest-environment jsdom
import {act,cleanup,fireEvent} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {loadPluginApp,renderSlot} from '@get-bb/plugin-sdk/testing/app';
const app=await loadPluginApp(()=>import('../app'));
afterEach(()=>{cleanup();vi.restoreAllMocks();window.sessionStorage.clear();});
function announce(frame:HTMLIFrameElement,data:Record<string,unknown>,origin=new URL(frame.src).origin,source:Window|null=frame.contentWindow){
 act(()=>{window.dispatchEvent(new MessageEvent('message',{origin,source,data:{protocol:'bb-desktop-v1',...data}}));});
}
it('launches a prepared HTTPS transfer in the user click when the desktop host returns no WindowProxy',async()=>{
 let inClick=false;const nativeOpen=vi.spyOn(window,'open').mockReturnValue(null);
 const openUrl=vi.fn((url:string)=>{expect(inClick).toBe(true);window.open(url,'_blank');return true;});
 const slot=renderSlot(app.messageDirectives.find(value=>value.id==='sandbox-desktop')!,{attributes:{},message:{threadId:'thr_desktop'},source:'::sandbox-desktop{}',openWorkspaceFile:null} as never,{rpc:{getSandboxDesktop:async()=>({kind:'open',url:'https://viewer.example/#grant',expires:Date.now()+60000,viewOnly:true})} as never,openUrl});
 const frame=await slot.findByTitle('Sandbox desktop') as HTMLIFrameElement,button=slot.getByRole('button',{name:'Open in new tab'});
 expect(button).toHaveProperty('disabled',true);
 const url='https://viewer.example/#grant&ticket=prepared';announce(frame,{state:'ready',url,expires:Date.now()+60000});
 inClick=true;fireEvent.click(button);fireEvent.click(button);inClick=false;
 expect(openUrl.mock.calls).toEqual([[url],[url]]);expect(nativeOpen).toHaveBeenCalledWith(url,'_blank');
 expect(slot.getByTitle('Sandbox desktop')).toBe(frame);expect(slot.queryByRole('alert')).toBeNull();
 announce(frame,{state:'elsewhere'});expect(button).toHaveProperty('disabled',true);
});
it('rejects foreign, stale-grant and expired readiness and retains the stream when launch is rejected',async()=>{
 const openUrl=vi.fn(()=>false);
 const slot=renderSlot(app.messageDirectives.find(value=>value.id==='sandbox-desktop')!,{attributes:{},message:{threadId:'thr_desktop'},source:'::sandbox-desktop{}',openWorkspaceFile:null} as never,{rpc:{getSandboxDesktop:async()=>({kind:'open',url:'https://viewer.example/#grant',expires:Date.now()+60000,viewOnly:true})} as never,openUrl});
 const frame=await slot.findByTitle('Sandbox desktop') as HTMLIFrameElement,button=slot.getByRole('button',{name:'Open in new tab'}),ready={state:'ready',url:'https://viewer.example/#grant&ticket=prepared',expires:Date.now()+60000};
 announce(frame,ready,'https://other.example');announce(frame,ready,undefined,window);
 announce(frame,{...ready,url:'https://other.example/#grant&ticket=prepared'});announce(frame,{...ready,url:'https://viewer.example/#stale&ticket=prepared'});announce(frame,{...ready,expires:Date.now()-1});
 expect(button).toHaveProperty('disabled',true);fireEvent.click(button);expect(openUrl).not.toHaveBeenCalled();
 announce(frame,ready);fireEvent.click(button);await slot.findByRole('alert');
 expect(slot.getByTitle('Sandbox desktop')).toBe(frame);expect(button).toHaveProperty('disabled',false);
});
