import {afterEach,expect,it,vi} from 'vitest';
// @ts-expect-error Runtime modules ship as plain JavaScript.
import {prepareDesktop} from '../docker/desktop.mjs';
afterEach(()=>vi.unstubAllGlobals());
it('maximizes the private browser before handoff and releases file chooser interception',async()=>{
 const calls:Array<{method:string;params:any}>=[];
 vi.stubGlobal('fetch',vi.fn(async()=>({json:async()=>({webSocketDebuggerUrl:'ws://127.0.0.1:1234/browser'})})));
 const close=vi.fn();
 vi.stubGlobal('WebSocket',class{
  onopen?:()=>void;onmessage?:(event:{data:string})=>void;
  constructor(){queueMicrotask(()=>this.onopen?.());}
  close=close;
  send(data:string){const message=JSON.parse(data);calls.push(message);const result=message.method==='Target.getTargets'?{targetInfos:[{type:'page',targetId:'main'}]}:message.method==='Browser.getWindowForTarget'?{windowId:7}:message.method==='Target.attachToTarget'?{sessionId:'page'}:{};queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({id:message.id,result})}));}
 });
 await prepareDesktop({port:1234});
 expect(calls.find(call=>call.method==='Browser.setWindowBounds')?.params).toEqual({windowId:7,bounds:{windowState:'maximized'}});
 expect(calls.find(call=>call.method==='Page.setInterceptFileChooserDialog')?.params).toEqual({enabled:false});expect(close).toHaveBeenCalledOnce();
});
