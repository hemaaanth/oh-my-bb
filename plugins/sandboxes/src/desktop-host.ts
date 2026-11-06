import {spawn,type ChildProcess} from 'node:child_process';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {access,readdir,readFile,stat} from 'node:fs/promises';
import {createServer as httpServer,request as httpRequest,type IncomingHttpHeaders,type ServerResponse} from 'node:http';
import type {Duplex} from 'node:stream';
import {createServer as tcpServer,type Server as TcpServer} from 'node:net';
import {homedir} from 'node:os';
import {join} from 'node:path';
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
type Screen={display:string;authority?:string;owners:{pid:number;start:string}[]};
// The sandbox's own Xvfb has no cookie: every process of the sandbox user draws on it.
// Displays with -auth are private and are shared only through validateDesktop.
async function sharedXvfb(){
 const uid=process.getuid?.(),found:{display:string;pid:number;start:string}[]=[];
 for(const pid of await readdir('/proc')){
  if(!/^\d+$/.test(pid))continue;
  try{
   const [args,text,info]=await Promise.all([readFile('/proc/'+pid+'/cmdline','utf8'),readFile('/proc/'+pid+'/stat','utf8'),stat('/proc/'+pid)]);
   const words=args.split('\0'),display=words.slice(1).find(word=>/^:\d+$/.test(word));
   if(words[0]?.split('/').at(-1)!=='Xvfb'||!display||info.uid!==uid||words.includes('-auth')||words[words.indexOf('-nolisten')+1]!=='tcp')continue;
   found.push({display,pid:Number(pid),start:text.slice(text.lastIndexOf(')')+2).split(' ')[19]!});
  }catch{}
 }
 // bb-sandbox-display records the display it started.
 const recorded=await readFile(join(process.env.BB_DATA_DIR||join(homedir(),'.bb'),'display'),'utf8').then(value=>value.trim(),()=>':99');
 return found.find(value=>value.display===recorded)??found.find(value=>value.display===':99')??found[0];
}
export async function sharedDisplay(signal:AbortSignal):Promise<Screen>{
 if(process.platform!=='linux')throw Error('Sandbox desktops need Linux');
 let xvfb=await sharedXvfb();
 if(!xvfb){
  await new Promise<void>(resolve=>{const child=spawn('bb-sandbox-display',['start'],{stdio:'ignore',signal,timeout:30000});child.once('error',()=>resolve());child.once('exit',()=>resolve());});
  signal.throwIfAborted();xvfb=await sharedXvfb();
 }
 if(!xvfb)throw Error('This sandbox has no desktop; start one with bb-sandbox-display start');
 return {display:xvfb.display,owners:[{pid:xvfb.pid,start:xvfb.start}]};
}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function listen(server:TcpServer){await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address();if(!address||typeof address==='string')throw Error('Cannot allocate a private desktop port');return address.port;}

// voxl streams H.264 over WebSockets from the X display. Every sandbox image ships it.
export async function findVoxl(){for(const directory of (process.env.PATH||'/usr/local/bin:/usr/bin').split(':')){const file=join(directory||'.','voxl');try{await access(file,constants.X_OK);return file;}catch{}}return null;}
// voxl's page loads these before it presents a token.
const voxlPublic=new Set(['/client.js','/worker.js','/audio.js','/mic.js','/favicon.ico','/inter.woff2']);
// voxl's page and worker pass ?token= on to every request; this moves the hash token there.
// It stays blank: voxl's own page shows the connecting state.
const startPage=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remote desktop</title><link rel="license" href="/licenses"><style>body{margin:0;height:100dvh;display:grid;place-items:center;background:#09090b;color:#9b9b9b;font:400 .875rem/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}</style><p id="status" role="status"></p><script src="/bb-desktop-start.js"></script></html>`;
const startScript=`const token=location.hash.slice(1);if(/^[A-Za-z0-9_-]{43}$/.test(token))location.replace('/?token='+token);else document.getElementById('status').textContent='Session ended';`;
type SharedDesktopOpen={id:string;viewOnly?:boolean;appOrigin?:string;threadTitle:string;token:string;notices:string;tunnel:{label:string;baseDomain:string}};
type DesktopOpen=SharedDesktopOpen&{target:DesktopTarget};
const frameAncestors=(appOrigin?:string)=>"frame-ancestors 'self' https://*.getbb.app"+(appOrigin?" "+appOrigin:"");
function secure(res:ServerResponse,policy:string){res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',policy);}
async function stop(child:ChildProcess|undefined){
 if(child?.pid&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(1000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
}

export class SandboxDesktopHost{
 private sessions=new Map<string,{port:number;expires:number;close:()=>Promise<void>}>();
 constructor(private onIdle?:()=>void){}
 async close(id:string){const session=this.sessions.get(id);if(session){await session.close();if(this.sessions.get(id)===session)this.sessions.delete(id);if(!this.sessions.size)this.onIdle?.();}}
 async dispose(){await Promise.all([...this.sessions.keys()].map(id=>this.close(id)));}
 async open(input:DesktopOpen,signal:AbortSignal){
  await this.close(input.id);await validateDesktop(input.target);signal.throwIfAborted();
  return this.stream(input,{display:input.target.display,authority:input.target.authority,owners:[input.target.owner,input.target.displayOwner]},signal,true);
 }
 async openShared(input:SharedDesktopOpen,signal:AbortSignal){
  await this.close(input.id);const screen=await sharedDisplay(signal);signal.throwIfAborted();
  // The sandbox desktop keeps its size: its windows and the agent's click
  // coordinates assume it. voxl scales it to fit the viewer instead.
  return this.stream(input,screen,signal,false);
 }
 private async stream(input:SharedDesktopOpen,screen:Screen,signal:AbortSignal,resize:boolean){
  const binary=await findVoxl();if(!binary)throw Error('This sandbox image has no voxl desktop viewer; rebuild the sandbox image');
  const password=randomBytes(24).toString('base64url'),reservation=tcpServer(),voxlPort=await listen(reservation);await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  let child:ChildProcess|undefined,server:ReturnType<typeof httpServer>|undefined,timer:ReturnType<typeof setInterval>|undefined,closed=false,closing:Promise<void>|undefined;
  const sockets=new Set<Duplex>();
  const close=()=>closing??=(async()=>{
   closed=true;if(timer)clearInterval(timer);for(const socket of sockets)socket.destroy();server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await stop(child);
  })();
  try{
   // The password stays out of argv, which other users can read in /proc.
   child=spawn(binary,['--addr=127.0.0.1','--port='+voxlPort,'--title='+input.threadTitle,'--audio-enabled=false','--microphone-enabled=false','--file-transfers=none','--enable-clipboard=in',...input.viewOnly?['--read-only=true']:resize?['--enable-resize=true']:[]],{stdio:'ignore',env:{PATH:process.env.PATH,HOME:process.env.HOME,DISPLAY:screen.display,...(screen.authority?{XAUTHORITY:screen.authority}:{}),VOXL_PASSWORD:password}});
   await new Promise<void>((resolve,reject)=>{child!.once('spawn',resolve);child!.once('error',reject);});
   const healthy=()=>new Promise<boolean>(resolve=>{const req=httpRequest({host:'127.0.0.1',port:voxlPort,path:'/healthz',timeout:200},res=>{res.resume();resolve(res.statusCode===200);});req.once('error',()=>resolve(false));req.once('timeout',()=>{req.destroy();resolve(false);});req.end();});
   let ready=false;
   for(let i=0;i<160&&!ready;i++){
    if(child.exitCode!==null||child.signalCode!==null)throw Error('voxl could not attach to this private display');
    ready=await healthy();if(!ready){await delay(50);signal.throwIfAborted();}
   }
   if(!ready)throw Error('voxl did not start');
   signal.throwIfAborted();
   const expires=Date.now()+15*60000;let port=0;
   const valid=(value:string|null|undefined)=>{const expected=Buffer.from(input.token),got=Buffer.from(value||'');return !closed&&Date.now()<expires&&got.length===expected.length&&timingSafeEqual(got,expected);};
   // Absent for same-origin GETs; browsers send it on WebSockets and writes.
   const sameSite=(origin:string|undefined)=>[`https://${input.tunnel.label}--${port}.${input.tunnel.baseDomain}`,`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(origin||'');
   // voxl checks Host and Origin itself; this server already checked both, so it speaks as a local program.
   const upstream=(headers:IncomingHttpHeaders)=>{const out={...headers};for(const name of ['host','origin','referer','cookie','authorization'])delete out[name];return {...out,host:'127.0.0.1:'+voxlPort,authorization:'Bearer '+password};};
   server=httpServer((req,res)=>{
    const url=new URL(req.url||'/','http://desktop'),page="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; "+frameAncestors(input.appOrigin);
    if(req.method==='GET'&&url.pathname==='/licenses'){secure(res,page);res.setHeader('Content-Type','text/plain; charset=utf-8');res.end(input.notices);return;}
    if(req.method==='GET'&&url.pathname==='/bb-desktop-start.js'){secure(res,page);res.setHeader('Content-Type','text/javascript');res.end(startScript);return;}
    if(req.method==='GET'&&url.pathname==='/'&&!url.searchParams.has('token')){secure(res,page);res.setHeader('Content-Type','text/html; charset=utf-8');res.end(startPage);return;}
    const token=url.searchParams.get('token')??req.headers.authorization?.replace(/^Bearer /,'');
    if(url.pathname.startsWith('/files/')||!(req.method==='GET'&&voxlPublic.has(url.pathname)||valid(token))||(req.method!=='GET'&&req.method!=='HEAD'&&!sameSite(req.headers.origin))){secure(res,page);res.writeHead(403);res.end('Session ended');return;}
    url.searchParams.delete('token');secure(res,frameAncestors(input.appOrigin));
    const forward=httpRequest({host:'127.0.0.1',port:voxlPort,method:req.method,path:url.pathname+url.search,headers:upstream(req.headers)},reply=>{const headers={...reply.headers};delete headers.connection;delete headers['keep-alive'];res.writeHead(reply.statusCode||502,headers);reply.pipe(res);});
    forward.once('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
    req.pipe(forward);
   });
   server.on('upgrade',(req,socket,head)=>{
    const url=new URL(req.url||'/','http://desktop');
    if(url.pathname!=='/ws'||!valid(url.searchParams.get('token'))||!sameSite(req.headers.origin)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    // voxl serves many viewers at once. The inline view and the side panel share one session,
    // and voxl reconnects a dropped viewer, so dropping the older one would make them fight.
    url.searchParams.delete('token');sockets.add(socket);
    const end=(...ends:Duplex[])=>()=>{for(const value of ends){value.destroy();sockets.delete(value);}};
    socket.once('error',end(socket));socket.once('close',end(socket));
    const forward=httpRequest({host:'127.0.0.1',port:voxlPort,path:url.pathname+url.search,headers:upstream(req.headers)});
    forward.once('upgrade',(reply,remote,remoteHead)=>{
     sockets.add(remote);const both=end(socket,remote);remote.once('error',both);remote.once('close',both);socket.once('close',both);
     if(socket.destroyed){both();return;}
     const lines=['HTTP/1.1 101 Switching Protocols'];for(let i=0;i<reply.rawHeaders.length;i+=2)lines.push(reply.rawHeaders[i]+': '+reply.rawHeaders[i+1]);
     socket.write(lines.join('\r\n')+'\r\n\r\n');if(remoteHead.length)socket.write(remoteHead);if(head.length)remote.write(head);
     remote.pipe(socket).pipe(remote);
    });
    forward.once('response',reply=>{reply.resume();socket.end(`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\nConnection: close\r\n\r\n`);});
    forward.once('error',end(socket));
    forward.end();
   });
   port=await listen(server);this.sessions.set(input.id,{port,expires,close});
   timer=setInterval(()=>{if(Date.now()>=expires||child!.exitCode!==null||child!.signalCode!==null)void this.close(input.id);else void Promise.all(screen.owners.map(processMatches)).then(alive=>{if(alive.some(v=>!v))void this.close(input.id);});},1000);timer.unref();
   return {port,expires};
  }catch(error){await close();throw error;}
 }
}
