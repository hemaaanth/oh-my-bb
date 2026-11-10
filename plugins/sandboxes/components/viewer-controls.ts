// BB Desktop Viewer v1 is a wire protocol, not a dependency on Sandboxes.
export function embeddedViewerUrl(url:string){
 const value=new URL(url,location.href),[token,...fields]=value.hash.slice(1).split('&'),parameters=new URLSearchParams(fields.join('&'));
 parameters.set('parentOrigin',location.origin);value.hash=token+'&'+parameters;
 return value.href;
}
export async function viewerRequest(frame:HTMLIFrameElement,action:'transfer'|'takeover'|'release'|'accept',ticket?:string){
 const origin=new URL(frame.src,location.href).origin,id=crypto.randomUUID();
 // This package targets ES2022, before Promise.withResolvers.
 return new Promise<{url?:string}>((resolve,reject)=>{
  const timer=setTimeout(()=>{cleanup();reject(Error('Viewer did not respond. Use View here in the viewer.'));},5000);
  const receive=(event:MessageEvent)=>{
   if(event.source!==frame.contentWindow||event.origin!==origin||event.data?.protocol!=='bb-desktop-v1'||event.data.id!==id)return;
   cleanup();event.data.error?reject(Error(event.data.error)):resolve(event.data);
  };
  const cleanup=()=>{clearTimeout(timer);window.removeEventListener('message',receive);};
  window.addEventListener('message',receive);frame.contentWindow?.postMessage({protocol:'bb-desktop-v1',id,action,ticket},origin);
 });
}
export async function popoutViewer(frame:HTMLIFrameElement){
 const tab=window.open('about:blank','_blank');
 if(!tab)throw Error('Popup blocked. Allow popups and try again.');
 tab.opener=null;
 try{const {url}=await viewerRequest(frame,'transfer');if(!url||new URL(url).origin!==new URL(frame.src).origin)throw Error('Invalid viewer transfer');tab.location.replace(url);}
 catch(error){tab.close();throw error;}
}
