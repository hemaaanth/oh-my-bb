// @ts-expect-error noVNC ships JavaScript.
import RFB from '@novnc/novnc';
const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
const screen=document.querySelector<HTMLElement>('#screen')!,status=document.querySelector<HTMLElement>('#status')!,retry=document.querySelector<HTMLButtonElement>('#retry')!;
let rfb:any,connecting=false,ended=false,generation=0,viewOnly=false;
function state(message:string,connected=false){status.textContent=connected&&viewOnly?'Watching':message;screen.inert=!connected;retry.hidden=connected||ended;}
async function connect(){
 if(connecting||ended)return;connecting=true;const current=++generation;rfb?.disconnect();state('Connecting…');retry.hidden=true;
 try{
  const response=await fetch('/session',{method:'POST',headers:{authorization:'Bearer '+token}});
  if(response.status===403){ended=true;state('Session ended');return;}
  if(!response.ok)throw Error('Connection unavailable');
  const {password,threadTitle,viewOnly:watch}=await response.json();viewOnly=!!watch;
  document.querySelector<HTMLElement>('#thread-name')!.textContent=threadTitle;document.title=threadTitle;
  rfb=new RFB(screen,`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/socket`,{credentials:{password},wsProtocols:['bb-desktop',token]});
  rfb.viewOnly=viewOnly;rfb.scaleViewport=true;rfb.resizeSession=!viewOnly;rfb.background='#09090b';
  rfb.addEventListener('connect',()=>{if(current!==generation)return;state('Connected',true);});
  rfb.addEventListener('disconnect',()=>{if(current!==generation)return;state('Disconnected');});
  rfb.addEventListener('securityfailure',()=>{if(current===generation)state('Connection rejected');});
 }catch{state('Connection unavailable');}finally{connecting=false;}
}
retry.onclick=()=>{void connect();};
const fullscreen=document.querySelector<HTMLButtonElement>('#fullscreen')!;
document.addEventListener('fullscreenchange',()=>{fullscreen.title=fullscreen.ariaLabel=document.fullscreenElement?'Exit full screen':'Full screen';fullscreen.setAttribute('aria-pressed',String(!!document.fullscreenElement));});
fullscreen.onclick=()=>{if(document.fullscreenElement)void document.exitFullscreen();else void document.documentElement.requestFullscreen();};
void connect();
// Let the browser deliver an explicit paste; never read or sync the clipboard in the background.
window.addEventListener('keydown',event=>{if(!screen.inert&&screen.contains(document.activeElement)&&(event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='v')event.stopImmediatePropagation();},true);
screen.addEventListener('paste',event=>{
 if(screen.inert||viewOnly||!rfb)return;event.preventDefault();const text=event.clipboardData?.getData('text/plain')||'';
 if(text.length>4096){status.textContent='Clipboard is too large';return;}
 rfb.sendKey(0xffe7,'MetaLeft',false);rfb.sendKey(0xffe3,'ControlLeft',false);
 // VNC clipboard updates have no completion acknowledgement; send explicit pasted text as key events.
 for(const character of text){const code=character.codePointAt(0)!;rfb.sendKey(code===10||code===13?0xff0d:code===9?0xff09:code<256?code:0x01000000|code);}
});
