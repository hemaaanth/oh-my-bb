import {spawn,type ChildProcess} from 'node:child_process';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {mkdir,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {createServer as httpServer} from 'node:http';
import {createServer as tcpServer,connect,type Server as TcpServer} from 'node:net';
import {join} from 'node:path';
import {WebSocketServer,WebSocket} from 'ws';
import type {DesktopTarget} from './desktop-contract.js';

export async function processMatches(owner:{pid:number;start:string}){
 try{const text=await readFile('/proc/'+owner.pid+'/stat','utf8'),fields=text.slice(text.lastIndexOf(')')+2).split(' ');return fields[0]!=='Z'&&fields[19]===owner.start;}catch{return false;}
}
export async function validateDesktop(target:DesktopTarget){
 if(process.platform!=='linux'||!await processMatches(target.owner)||!await processMatches(target.displayOwner))throw Error('Desktop session is no longer running');
 const [args,file,owner,app]=await Promise.all([readFile('/proc/'+target.displayOwner.pid+'/cmdline','utf8'),stat(target.authority),stat('/proc/'+target.displayOwner.pid),stat('/proc/'+target.owner.pid)]);
 const words=args.split('\0'),binary=words[0]?.split('/').at(-1);
 const tiger=binary==='Xtigervnc'&&!!target.vncSocket;
 if(tiger){const socket=await stat(target.vncSocket!);if(!socket.isSocket()||socket.uid!==owner.uid||(socket.mode&0o077)!==0||words[words.indexOf('-rfbunixpath')+1]!==target.vncSocket||words[words.indexOf('-rfbport')+1]!=='-1')throw Error('Only an owned private VNC socket can be shared');}
 if((!tiger&&(binary!=='Xvfb'||!!target.vncSocket))||!words.includes(target.display)||words[words.indexOf('-auth')+1]!==target.authority||owner.uid!==process.getuid?.()||app.uid!==owner.uid||file.uid!==owner.uid||words[words.indexOf('-nolisten')+1]!=='tcp'||!file.isFile()||(file.mode&0o077)!==0)throw Error('Only an owned private X display can be shared');
}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function listen(server:TcpServer){await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address();if(!address||typeof address==='string')throw Error('Cannot allocate a private desktop port');return address.port;}
// Pages theme colors and spacing, kept local so remote desktops do not depend on Pages.
const html=`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remote desktop</title><link rel="license" href="/licenses"><style>
:root{color-scheme:dark;--bb-bg:#09090b;--bb-surface:#131313;--bb-text:#dfdfde;--bb-muted:#9b9b9b;--bb-rule:#1c1c1c;--bb-hover:#262626;--bb-accent:#818cf8;--bb-radius-sm:.5rem;--bb-space-tight:.5rem;--bb-space-group:1rem}
*{box-sizing:border-box}
body{margin:0;background:var(--bb-bg);color:var(--bb-text);font:400 .875rem/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;height:100dvh;display:flex;flex-direction:column;-webkit-font-smoothing:antialiased}
header{min-height:48px;display:flex;align-items:center;gap:var(--bb-space-tight);padding:.5rem var(--bb-space-group);flex-shrink:0}
#thread-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#status{white-space:nowrap;color:var(--bb-muted);font-size:.75rem;margin-left:auto}
button{font:inherit;color:var(--bb-muted);border:0;border-radius:var(--bb-radius-sm);background:transparent;padding:.375rem .625rem;cursor:pointer;white-space:nowrap}
button:hover{background:var(--bb-hover);color:var(--bb-text)}
button:focus-visible{outline:2px solid var(--bb-accent);outline-offset:2px}
#screen{flex:1;min-height:0;overflow:hidden;background:var(--bb-bg)}
#fullscreen{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;flex-shrink:0}
canvas{outline:none}
@media(max-width:400px){header{padding:.5rem;gap:.25rem}button{padding:.375rem .5rem}}
</style><header><span id="thread-name">Browser</span><span id="status" role="status" aria-live="polite">Connecting…</span><button id="retry" hidden>Reconnect</button><button id="fullscreen" aria-label="Full screen" title="Full screen"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg></button></header><main id="screen" aria-label="Remote desktop"></main><script type="module" src="/client.js"></script></html>`;

export class SandboxDesktopHost{
 private sessions=new Map<string,{port:number;expires:number;close:()=>Promise<void>}>();
 constructor(private directory:string,private onIdle?:()=>void){}
 async close(id:string){const session=this.sessions.get(id);if(session){await session.close();if(this.sessions.get(id)===session)this.sessions.delete(id);if(!this.sessions.size)this.onIdle?.();}}
 async dispose(){await Promise.all([...this.sessions.keys()].map(id=>this.close(id)));}
 async open(input:{id:string;target:DesktopTarget;viewOnly?:boolean;appOrigin?:string;threadTitle:string;token:string;clientScript:string;notices:string;tunnel:{label:string;baseDomain:string}},signal:AbortSignal){
  await this.close(input.id);await validateDesktop(input.target);signal.throwIfAborted();
  const directory=join(this.directory,input.id);await mkdir(directory,{recursive:true,mode:0o700});
  const password=randomBytes(6).toString('base64url'),passwordFile=join(directory,'password');await writeFile(passwordFile,password+'\n',{mode:0o600});
  let vncPort=0;
  if(!input.target.vncSocket||input.viewOnly){const reservation=tcpServer();vncPort=await listen(reservation);await new Promise<void>(resolve=>reservation.close(()=>resolve()));}
  const vncConnect=()=>input.target.vncSocket&&!input.viewOnly?connect(input.target.vncSocket):connect(vncPort,'127.0.0.1');
  let child:ChildProcess|undefined,server:ReturnType<typeof httpServer>|undefined,wss:WebSocketServer|undefined,timer:ReturnType<typeof setInterval>|undefined,closed=false,closing:Promise<void>|undefined;
  const sockets=new Set<ReturnType<typeof connect>>();
  const close=()=>closing??=(async()=>{
   closed=true;if(timer)clearInterval(timer);for(const socket of sockets)socket.destroy();for(const client of wss?.clients||[])client.terminate();wss?.close();server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
   if(child?.pid&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child!.once('exit',resolve)),delay(1000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
   await rm(passwordFile,{force:true});
  })();
  try{
   if(!input.target.vncSocket||input.viewOnly){
   child=spawn('x11vnc',['-display',input.target.display,'-auth',input.target.authority,'-localhost','-listen','127.0.0.1','-rfbport',String(vncPort),'-passwdfile',passwordFile,...(input.viewOnly?['-viewonly']:[]),'-forever','-shared','-noxdamage','-quiet'],{stdio:'ignore'});
   await new Promise<void>((resolve,reject)=>{child!.once('spawn',resolve);child!.once('error',reject);});
   }
   let ready=false;
   for(let i=0;i<60;i++){
    if(child&&(child.exitCode!==null||child.signalCode!==null))throw Error('VNC could not attach to this private display');
    ready=await new Promise<boolean>(resolve=>{const socket=vncConnect();socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.setTimeout(100,()=>{socket.destroy();resolve(false);});});
    if(ready)break;await delay(50);signal.throwIfAborted();
   }
   if(!ready)throw Error('Private VNC did not start');
   signal.throwIfAborted();
   const expires=Date.now()+15*60000;let port=0;
   const valid=(value:string|undefined)=>{const expected=Buffer.from(input.token),got=Buffer.from(value||'');return !closed&&Date.now()<expires&&got.length===expected.length&&timingSafeEqual(got,expected);};
   server=httpServer((req,res)=>{
    const path=(req.url||'/').split('?')[0];res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'self' https://*.getbb.app"+(input.appOrigin?" "+input.appOrigin:""));
    if(req.method==='GET'&&path==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
    if(req.method==='GET'&&path==='/licenses'){res.setHeader('Content-Type','text/plain');res.end(input.notices);return;}
    if(req.method==='GET'&&path==='/client.js'){res.setHeader('Content-Type','text/javascript');res.end(input.clientScript);return;}
    if(req.method==='POST'&&path==='/session'&&valid(req.headers.authorization?.replace(/^Bearer /,''))){res.setHeader('Content-Type','application/json');res.setHeader('Set-Cookie',`bb-desktop=${input.token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.max(0,Math.floor((expires-Date.now())/1000))}`);res.end(JSON.stringify({password,threadTitle:input.threadTitle,viewOnly:!!input.viewOnly}));return;}
    res.writeHead(403);res.end('Session ended');
   });
   wss=new WebSocketServer({noServer:true,maxPayload:1024*1024,perMessageDeflate:false});
   server.on('upgrade',(req,socket,head)=>{
    const protocolToken=req.headers['sec-websocket-protocol']?.split(',').map(value=>value.trim()).find(value=>/^[A-Za-z0-9_-]{43}$/.test(value));
    const token=protocolToken||req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('bb-desktop='))?.slice('bb-desktop='.length);
    const expected=`https://${input.tunnel.label}--${port}.${input.tunnel.baseDomain}`;
    if((req.url||'/').split('?')[0]!=='/socket'||!valid(token)||![expected,`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(req.headers.origin||'')){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    wss!.handleUpgrade(req,socket,head,ws=>{
     // A new viewer replaces the old connection; uncertain input is never replayed.
     for(const client of wss!.clients)if(!input.viewOnly&&client!==ws)client.close(1000,'Reconnected elsewhere');
     const tcp=vncConnect();sockets.add(tcp);
     ws.on('message',data=>{if(!valid(token)){ws.close(1008,'Session ended');return;}if(!tcp.write(Buffer.from(data as Buffer))){ws.close(1013,'Connection busy');tcp.destroy();}});
     tcp.on('data',data=>{if(ws.readyState===WebSocket.OPEN){if(ws.bufferedAmount>4*1024*1024){ws.close(1013,'Connection slow');tcp.destroy();}else ws.send(data);}});
     tcp.on('error',()=>ws.close(1011,'Desktop unavailable'));tcp.on('close',()=>{sockets.delete(tcp);ws.close();});ws.on('close',()=>tcp.destroy());ws.on('error',()=>tcp.destroy());
    });
   });
   port=await listen(server);this.sessions.set(input.id,{port,expires,close});
   timer=setInterval(()=>{if(Date.now()>=expires)void this.close(input.id);else void Promise.all([processMatches(input.target.owner),processMatches(input.target.displayOwner)]).then(alive=>{if(alive.some(v=>!v))void this.close(input.id);});},1000);timer.unref();
   return {port,expires};
  }catch(error){await close();throw error;}
 }
}
