import {useEffect,useRef,useState,type RefObject} from 'react';
import {useBbNavigate} from '@get-bb/plugin-sdk/app';

// BB Desktop Viewer v1 is a wire protocol, not a dependency on Sandboxes.
export function embeddedViewerUrl(url:string){
 const value=new URL(url,location.href),[token,...fields]=value.hash.slice(1).split('&'),parameters=new URLSearchParams(fields.join('&'));
 parameters.set('parentOrigin',location.origin);value.hash=token+'&'+parameters;
 return value.href;
}
export async function viewerRequest(frame:HTMLIFrameElement,action:'transfer'|'takeover'|'release',timeout=5000,signal?:AbortSignal){
 if(signal?.aborted)throw Error('Viewer request cancelled');
 const origin=new URL(frame.src,location.href).origin,id=crypto.randomUUID();
 const {promise,resolve,reject}=Promise.withResolvers<{url?:string;expires?:number}>();
 const timer=setTimeout(()=>{cleanup();reject(Error('Viewer did not respond. Use View here in the viewer.'));},timeout);
 const receive=(event:MessageEvent)=>{
  if(event.source!==frame.contentWindow||event.origin!==origin||event.data?.protocol!=='bb-desktop-v1'||event.data.id!==id)return;
  cleanup();event.data.error?reject(Error(event.data.error)):resolve(event.data);
 };
 const abort=()=>{cleanup();reject(Error('Viewer request cancelled'));};
 const cleanup=()=>{clearTimeout(timer);window.removeEventListener('message',receive);signal?.removeEventListener('abort',abort);};
 signal?.addEventListener('abort',abort,{once:true});
 window.addEventListener('message',receive);frame.contentWindow?.postMessage({protocol:'bb-desktop-v1',id,action},origin);
 return promise;
}
/** Preparation never yields ownership. The SDK launch must stay in the click. */
export function useViewerPopout(frameRef:RefObject<HTMLIFrameElement|null>,sessionUrl:string|null){
 const navigate=useBbNavigate();
 type Prepared={frame:HTMLIFrameElement;sessionUrl:string;url:string;expires:number};
 const [prepared,setPrepared]=useState<Prepared|null>(null),current=useRef<Prepared|null>(null);
 useEffect(()=>{
  let timer:number|undefined,cancelled=false;
  const save=(value:Prepared|null)=>{window.clearTimeout(timer);current.current=value;setPrepared(value);if(value)timer=window.setTimeout(()=>save(null),value.expires-Date.now());};
  save(null);const frame=frameRef.current;if(!frame||!sessionUrl)return;
  const controller=new AbortController();
  const expected=new URL(frame.src,location.href),origin=expected.origin;
  const accept=(value:{url?:unknown;expires?:unknown})=>{
   if(cancelled||frameRef.current!==frame)return;
   try{const url=new URL(String(value.url));if(url.protocol!=='https:'||url.origin!==origin||url.hash.split('&')[0]!==expected.hash.split('&')[0]||typeof value.expires!=='number'||!Number.isFinite(value.expires)||value.expires<=Date.now())return;save({frame,sessionUrl,url:url.href,expires:value.expires});}catch{}
  };
  const receive=(event:MessageEvent)=>{
   if(event.source!==frame.contentWindow||event.origin!==origin||event.data?.protocol!=='bb-desktop-v1')return;
   if(event.data.state==='ready')accept(event.data);else if(event.data.state)save(null);
  };
  const request=()=>{void viewerRequest(frame,'transfer',5000,controller.signal).then(accept).catch(()=>{});};
  const load=()=>{save(null);request();};
  window.addEventListener('message',receive);frame.addEventListener('load',load);request();
  return()=>{cancelled=true;controller.abort();window.clearTimeout(timer);current.current=null;window.removeEventListener('message',receive);frame.removeEventListener('load',load);};
 },[frameRef,sessionUrl]);
 return {
  ready:!!prepared&&prepared.sessionUrl===sessionUrl&&prepared.frame===frameRef.current&&prepared.expires>Date.now(),
  open(){
   const value=current.current;
   if(!value||value.sessionUrl!==sessionUrl||value.frame!==frameRef.current||value.expires<=Date.now())throw Error('Session is not ready to open. Use View here first.');
   if(!navigate.openUrl(value.url))throw Error('Couldn’t open the session. The inline view is still active.');
  },
 };
}
