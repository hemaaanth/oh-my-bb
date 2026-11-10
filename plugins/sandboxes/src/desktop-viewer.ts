import {randomBytes} from 'node:crypto';

/** All transitions are synchronous. A pending upgrade occupies the same slot as a live pair. */
export class ViewerLease {
 private current: string|null=null;
 private generation=0;
 private connection: {cancel:()=>void}|null=null;
 private ticket: {secret:string;generation:number;expires:number}|null=null;
 owns(secret:unknown){return typeof secret==='string'&&secret===this.current;}
 private replace(){this.revoke();this.current=randomBytes(32).toString('base64url');return this.current;}
 acquire(takeover=false,ticket?:string){
  if(ticket){
   const issued=this.ticket;
   if(!issued||issued.secret!==ticket||issued.generation!==this.generation||issued.expires<=Date.now())return null;
   return this.replace();
  }
  return !this.current||takeover?this.replace():null;
 }
 transfer(secret:unknown){
  if(!this.owns(secret))return null;
  this.ticket={secret:randomBytes(32).toString('base64url'),generation:this.generation,expires:Date.now()+30000};
  return this.ticket.secret;
 }
 release(secret:unknown){if(this.owns(secret))this.revoke();}
 reserve(secret:unknown,cancel:()=>void){
  if(!this.owns(secret)||this.connection)return null;
  const connection={cancel};this.connection=connection;
  return {current:()=>this.owns(secret)&&this.connection===connection,done:()=>{if(this.connection===connection)this.connection=null;}};
 }
 revoke(){
  this.current=null;this.generation++;this.ticket=null;
  const old=this.connection;this.connection=null;old?.cancel();
 }
}

export const viewerPage=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remote desktop</title><link rel="license" href="/licenses"><style>html,body,#desktop{margin:0;width:100%;height:100%;overflow:hidden;background:#09090b;color:#ddd;font:14px system-ui}#desktop{display:grid;place-items:center}iframe{width:100%;height:100%;border:0}#placeholder{text-align:center}button{padding:8px;margin:6px;cursor:pointer}#tools{position:fixed;right:8px;top:8px}#tools[hidden]{display:none}</style><div id="desktop"><div id="placeholder"><p id="status" role="status">Connecting…</p><button id="return" hidden>View here</button></div></div><div id="tools" hidden><button id="popout">Pop out</button><button id="fullscreen">Fullscreen</button></div><script src="/bb-desktop-start.js"></script></html>`;

/** BB Desktop Viewer v1: exact parent origin/source, request id, no credentials in notifications. */
export function viewerScript(appOrigins:readonly string[]){return `
const allowedParentOrigins=${JSON.stringify(appOrigins)},fragment=location.hash.slice(1),parts=fragment.split('&'),token=parts[0],parameters=new URLSearchParams(parts.slice(1).join('&')),ticket=parameters.get('ticket'),declaredParentOrigin=parameters.get('parentOrigin'),parentOrigin=allowedParentOrigins.includes(declaredParentOrigin)?declaredParentOrigin:null;
history.replaceState(null,'',location.pathname);
const desktop=document.querySelector('#desktop'),placeholder=document.querySelector('#placeholder'),status=document.querySelector('#status'),returnButton=document.querySelector('#return');
let lease=null,child=null,ended=false,busy=false,initialized;
function notify(state){if(parent!==window&&parentOrigin)parent.postMessage({protocol:'bb-desktop-v1',state},parentOrigin)}
function retire(message='Viewing elsewhere'){child?.remove();child=null;desktop.replaceChildren(placeholder);status.textContent=message;returnButton.hidden=ended;notify('elsewhere')}
async function command(action,extra={}){const response=await fetch('/viewer-lease',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({action,lease,...extra})});if(response.status===403){ended=true;lease=null;retire('Session ended');throw Error('Session ended')}if(!response.ok)throw Error('Viewer unavailable');return response.json()}
function show(secret){if(child&&lease===secret)return;child?.remove();lease=secret;child=document.createElement('iframe');child.title='Desktop stream';child.allow='clipboard-read; clipboard-write';child.referrerPolicy='no-referrer';child.src='/view?'+new URLSearchParams({token,lease});desktop.replaceChildren(child);notify('viewing')}
async function acquire(takeover=false){if(busy)return;busy=true;try{const result=await command('acquire',{takeover,...(!takeover&&ticket?{ticket}:{})});if(result.lease)show(result.lease);else retire()}catch(error){retire(error.message)}finally{busy=false}}
async function check(){if(!lease||ended)return;const expected=lease;try{const result=await command('status');if(expected===lease&&!result.current){lease=null;retire()}}catch{/* A failed poll never acquires or returns ownership. */}}
async function transfer(){await initialized;if(!lease)throw Error('Use View here first');const result=await command('transfer');if(!result.ticket)throw Error('Viewing elsewhere');return location.origin+'/#'+token+'&ticket='+result.ticket}
async function popout(){const tab=window.open('about:blank','_blank');if(!tab){status.textContent='Popup blocked. Allow popups and try again.';return}tab.opener=null;try{tab.location.replace(await transfer())}catch(error){tab.close();status.textContent=error.message}}
returnButton.onclick=()=>acquire(true);document.querySelector('#popout').onclick=popout;document.querySelector('#fullscreen').onclick=()=>desktop.requestFullscreen?.();document.querySelector('#tools').hidden=parent!==window;
addEventListener('message',async event=>{if(event.source!==parent||event.origin!==parentOrigin||event.data?.protocol!=='bb-desktop-v1'||typeof event.data.id!=='string')return;const {id,action}=event.data;try{await initialized;let url;if(action==='transfer')url=await transfer();else if(action==='accept'&&typeof event.data.ticket==='string'){const result=await command('acquire',{ticket:event.data.ticket});if(!result.lease)throw Error('Transfer expired');show(result.lease)}else if(action==='takeover')await acquire(true);else if(action==='release'){await command('release');lease=null;retire()}else return;event.source.postMessage({protocol:'bb-desktop-v1',id,url},event.origin)}catch(error){event.source.postMessage({protocol:'bb-desktop-v1',id,error:error.message},event.origin)}});
addEventListener('focus',check);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void check()});setInterval(check,1000);
addEventListener('pagehide',()=>{if(lease)void fetch('/viewer-lease',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({action:'release',lease})}).catch(()=>{})});
if(/^[A-Za-z0-9_-]{43}$/.test(token))initialized=acquire();else{ended=true;retire('Session ended')}
`;}
