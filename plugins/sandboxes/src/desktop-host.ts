import {spawn,type ChildProcess} from 'node:child_process';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {access,readdir,readFile,stat,writeFile} from 'node:fs/promises';
import {createServer as httpServer,request as httpRequest,type ClientRequest,type IncomingHttpHeaders,type ServerResponse} from 'node:http';
import type {Duplex} from 'node:stream';
import {createServer as tcpServer,type Server as TcpServer} from 'node:net';
import {homedir} from 'node:os';
import {join} from 'node:path';
import type {DesktopTarget} from './desktop-contract.js';
import {ViewerLease,viewerPage,viewerScript} from './desktop-viewer.js';

export async function processMatches(owner:{pid:number;start:string}){
 try{const text=await readFile('/proc/'+owner.pid+'/stat','utf8'),fields=text.slice(text.lastIndexOf(')')+2).split(' ');return fields[0]!=='Z'&&fields[19]===owner.start;}catch{return false;}
}
export async function validateDesktop(target:DesktopTarget){
 if(process.platform!=='linux'||!await processMatches(target.owner)||!await processMatches(target.displayOwner))throw Error('Desktop session is no longer running');
 const [args,file,owner,app]=await Promise.all([readFile('/proc/'+target.displayOwner.pid+'/cmdline','utf8'),stat(target.authority),stat('/proc/'+target.displayOwner.pid),stat('/proc/'+target.owner.pid)]);
 const words=args.split('\0'),binary=words[0]?.split('/').at(-1);
 // Debian names TigerVNC's server Xtigervnc; Arch names it Xvnc.
 const tiger=(binary==='Xtigervnc'||binary==='Xvnc')&&!!target.vncSocket;
 if(tiger){const socket=await stat(target.vncSocket!);if(!socket.isSocket()||socket.uid!==owner.uid||(socket.mode&0o077)!==0||words[words.indexOf('-rfbunixpath')+1]!==target.vncSocket||words[words.indexOf('-rfbport')+1]!=='-1')throw Error('Only an owned private VNC socket can be shared');}
 if((!tiger&&(binary!=='Xvfb'||!!target.vncSocket))||!words.includes(target.display)||words[words.indexOf('-auth')+1]!==target.authority||owner.uid!==process.getuid?.()||app.uid!==owner.uid||file.uid!==owner.uid||words[words.indexOf('-nolisten')+1]!=='tcp'||!file.isFile()||(file.mode&0o077)!==0)throw Error('Only an owned private X display can be shared');
 if(tiger&&(words[words.indexOf('-geometry')+1]!=='1920x1080'||words[words.indexOf('-AcceptSetDesktopSize')+1]!=='0')||!tiger&&words[words.indexOf('-screen')+2]!=='1920x1080x24')throw Error('This desktop uses an old geometry. Drain and restart it at 1920x1080; it was not resized.');
}
type Screen={display:string;authority?:string;owners:{pid:number;start:string}[]};
// The sandbox's own Xvfb has no cookie: every process of the sandbox user draws on it.
// Displays with -auth are private and are shared only through validateDesktop.
async function sharedXvfb(){
 const uid=process.getuid?.(),found:{display:string;pid:number;start:string;geometry:string|undefined}[]=[];
 for(const pid of await readdir('/proc')){
  if(!/^\d+$/.test(pid))continue;
  try{
   const [args,text,info]=await Promise.all([readFile('/proc/'+pid+'/cmdline','utf8'),readFile('/proc/'+pid+'/stat','utf8'),stat('/proc/'+pid)]);
   const words=args.split('\0'),display=words.slice(1).find(word=>/^:\d+$/.test(word));
   if(words[0]?.split('/').at(-1)!=='Xvfb'||!display||info.uid!==uid||words.includes('-auth')||words[words.indexOf('-nolisten')+1]!=='tcp')continue;
   found.push({display,pid:Number(pid),start:text.slice(text.lastIndexOf(')')+2).split(' ')[19]!,geometry:words[words.indexOf('-screen')+2]});
  }catch{}
 }
 // bb-sandbox-display records the display it started.
 const recorded=await readFile(join(process.env.BB_DATA_DIR||join(homedir(),'.bb'),'display'),'utf8').then(value=>value.trim(),()=>':99');
 const selected=found.find(value=>value.display===recorded)??found.find(value=>value.display===':99')??found[0];
 if(selected&&selected.geometry!=='1920x1080x24')throw Error('This sandbox desktop uses an old geometry. Drain and restart it at 1920x1080; it was not resized.');
 return selected;
}
export async function sharedDisplay(signal:AbortSignal):Promise<Screen>{
 if(process.platform!=='linux')throw Error('Sandbox desktops need Linux');
 let xvfb=await sharedXvfb();
 if(!xvfb){
  await new Promise<void>(resolve=>{const child=spawn('bb-sandbox-display',['start'],{stdio:'ignore',signal,timeout:30000});child.once('error',()=>resolve());child.once('exit',()=>resolve());});
  signal.throwIfAborted();xvfb=await sharedXvfb();
 }
 if(!xvfb)throw Error('This sandbox has no desktop; start one with bb-sandbox-display start');
 await maximizeWindows(xvfb.display).catch(()=>{});
 return {display:xvfb.display,owners:[{pid:xvfb.pid,start:xvfb.start}]};
}
// Apps open at their own size and leave most of the 16:9 screen black.
// This openbox rule maximizes every normal window; dialogs keep their size.
export const maximizeRule='<application type="normal"><maximized>yes</maximized></application>';
export function openboxConfig(system:string|null){
 if(system?.includes('</applications>'))return system.replace('</applications>',maximizeRule+'</applications>');
 return '<?xml version="1.0" encoding="UTF-8"?><openbox_config xmlns="http://openbox.org/3.4/rc"><applications>'+maximizeRule+'</applications></openbox_config>';
}
async function maximizeWindows(display:string){
 const state=process.env.BB_DATA_DIR||join(homedir(),'.bb'),file=join(state,'openbox-rc.xml'),uid=process.getuid?.();
 for(const pid of await readdir('/proc')){
  if(!/^\d+$/.test(pid))continue;
  try{
   const [args,environ,info]=await Promise.all([readFile('/proc/'+pid+'/cmdline','utf8'),readFile('/proc/'+pid+'/environ','utf8'),stat('/proc/'+pid)]);
   const words=args.split('\0');
   // Already running with the rule.
   if(info.uid===uid&&words[0]?.split('/').at(-1)==='openbox'&&environ.split('\0').includes('DISPLAY='+display)&&words[words.indexOf('--config-file')+1]===file)return;
  }catch{}
 }
 await writeFile(file,openboxConfig(await readFile('/etc/xdg/openbox/rc.xml','utf8').catch(()=>null)),{mode:0o600});
 // --replace takes over from the running openbox and applies the rule to open windows too.
 const child=spawn('openbox',['--replace','--sm-disable','--config-file',file],{detached:true,stdio:'ignore',env:{...process.env,DISPLAY:display}});
 child.once('error',()=>{});child.unref();
 // bb-sandbox-display stop finds the window manager through this file.
 if(child.pid)await writeFile(join(state,'openbox-'+display.slice(1)+'.pid'),child.pid+'\n').catch(()=>{});
}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function listen(server:TcpServer){await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address();if(!address||typeof address==='string')throw Error('Cannot allocate a private desktop port');return address.port;}

// voxl streams H.264 over WebSockets from the X display. Every sandbox image ships it.
// cargo install puts voxl in ~/.cargo/bin, which a host daemon's PATH may lack.
export async function findVoxl(){for(const directory of [...(process.env.PATH||'/usr/local/bin:/usr/bin').split(':'),join(homedir(),'.cargo','bin')]){const file=join(directory||'.','voxl');try{await access(file,constants.X_OK);return file;}catch{}}return null;}
// voxl's page loads these before it presents a token.
const voxlPublic=new Set(['/client.js','/worker.js','/audio.js','/mic.js','/favicon.ico','/inter.woff2']);
type SharedDesktopOpen={id:string;viewOnly?:boolean;appOrigin?:string;appOrigins?:string[];threadTitle:string;token:string;notices:string;tunnel:{label:string;baseDomain:string}};
type DesktopOpen=SharedDesktopOpen&{target:DesktopTarget};
const frameAncestors=(origins:readonly string[])=>"frame-ancestors 'self'"+origins.map(origin=>" "+origin).join('');
function secure(res:ServerResponse,policy:string){res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',policy);}
async function stop(child:ChildProcess|undefined){
 if(child?.pid&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(1000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
}

export class SandboxDesktopHost{
 private sessions=new Map<string,{port:number;expires:number;close:()=>Promise<void>}>();
 private operations=new Map<string,Promise<unknown>>();
 private disposed=false;
 private serialize<T>(id:string,action:()=>Promise<T>){
  const job=(this.operations.get(id)??Promise.resolve()).catch(()=>{}).then(action);
  this.operations.set(id,job);
  void job.finally(()=>{if(this.operations.get(id)===job)this.operations.delete(id);}).catch(()=>{});
  return job;
 }
 constructor(private onIdle?:()=>void){}
 private async closeNow(id:string){const session=this.sessions.get(id);if(session){await session.close();if(this.sessions.get(id)===session)this.sessions.delete(id);if(!this.sessions.size)this.onIdle?.();}}
 close(id:string){return this.serialize(id,()=>this.closeNow(id));}
 async dispose(){this.disposed=true;await Promise.allSettled([...this.operations.values()]);await Promise.all([...this.sessions.keys()].map(id=>this.close(id)));}
 open(input:DesktopOpen,signal:AbortSignal){return this.serialize(input.id,async()=>{
  if(this.disposed)throw Error('Desktop host closed');
  await this.closeNow(input.id);await validateDesktop(input.target);signal.throwIfAborted();
  return this.stream(input,{display:input.target.display,authority:input.target.authority,owners:[input.target.owner,input.target.displayOwner]},signal);
 });}
 openShared(input:SharedDesktopOpen,signal:AbortSignal){return this.serialize(input.id,async()=>{
  if(this.disposed)throw Error('Desktop host closed');
  await this.closeNow(input.id);const screen=await sharedDisplay(signal);signal.throwIfAborted();
  return this.stream(input,screen,signal);
 });}
 private async stream(input:SharedDesktopOpen,screen:Screen,signal:AbortSignal){
  const binary=await findVoxl();if(!binary)throw Error('This host has no voxl desktop viewer; rebuild the sandbox image, or run cargo install voxl on a local host');
  const appOrigins=input.appOrigins??(input.appOrigin?[input.appOrigin]:[]);
  const password=randomBytes(24).toString('base64url'),reservation=tcpServer(),voxlPort=await listen(reservation);await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  let child:ChildProcess|undefined,server:ReturnType<typeof httpServer>|undefined,timer:ReturnType<typeof setInterval>|undefined,closed=false,closing:Promise<void>|undefined;
  const sockets=new Set<Duplex>();
  const lease=new ViewerLease();
  const close=()=>closing??=(async()=>{
   closed=true;lease.revoke();clearInterval(timer);for(const socket of sockets)socket.destroy();server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await stop(child);
  })();
  try{
   // The password stays out of argv, which other users can read in /proc.
   child=spawn(binary,['--addr=127.0.0.1','--port='+voxlPort,'--title='+input.threadTitle,'--audio-enabled=false','--microphone-enabled=false','--file-transfers=none','--enable-clipboard=in','--enable-resize=false',...input.viewOnly?['--read-only=true']:[]],{stdio:'ignore',env:{PATH:process.env.PATH,HOME:process.env.HOME,DISPLAY:screen.display,...(screen.authority?{XAUTHORITY:screen.authority}:{}),VOXL_PASSWORD:password}});
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
   server=httpServer(async(req,res)=>{
    const url=new URL(req.url||'/','http://desktop'),page="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; "+frameAncestors(appOrigins);
    secure(res,page);
    if(req.method==='GET'&&url.pathname==='/licenses'){res.setHeader('Content-Type','text/plain; charset=utf-8');res.end(input.notices);return;}
    if(req.method==='GET'&&url.pathname==='/bb-desktop-start.js'){res.setHeader('Content-Type','text/javascript');res.end(viewerScript(appOrigins));return;}
    if(req.method==='GET'&&url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(viewerPage);return;}
    const token=url.searchParams.get('token')??req.headers.authorization?.replace(/^Bearer /,'');
    if(url.pathname==='/viewer-lease'){
     if(req.method!=='POST'||!valid(token)||!sameSite(req.headers.origin)||req.headers['content-type']!=='application/json'){res.writeHead(403);res.end();return;}
     let size=0;const chunks:Buffer[]=[];
     try{
      for await(const chunk of req){size+=chunk.length;if(size>2048){res.writeHead(413);res.end();return;}chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['action','lease','takeover','ticket'].includes(key))||typeof body.action!=='string'||body.lease!=null&&(typeof body.lease!=='string'||body.lease.length!==43)||body.takeover!==undefined&&typeof body.takeover!=='boolean'||body.ticket!==undefined&&(typeof body.ticket!=='string'||body.ticket.length!==43))throw Error('Invalid lease request');
      // Authentication and expiry can change while the request body is arriving.
      if(!valid(token)){res.writeHead(403);res.end();return;}
      let result;
      if(body.action==='acquire')result={lease:lease.acquire(body.takeover===true,body.ticket)};
      else if(body.action==='status')result={current:lease.owns(body.lease)};
      else if(body.action==='transfer')result={ticket:lease.transfer(body.lease,expires),expires};
      else if(body.action==='release'){lease.release(body.lease);result={ok:true};}
      else throw Error('Invalid lease action');
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
     }catch{if(!res.headersSent)res.writeHead(400);res.end();}
     return;
    }
    if(req.method!=='GET'||url.pathname.startsWith('/files/')||!(voxlPublic.has(url.pathname)||valid(token)&&lease.owns(url.searchParams.get('lease')))){res.writeHead(403);res.end('Session ended');return;}
    if(url.pathname==='/view')url.pathname='/';
    url.searchParams.delete('token');url.searchParams.delete('lease');secure(res,frameAncestors(appOrigins));
    const forward=httpRequest({host:'127.0.0.1',port:voxlPort,method:'GET',path:url.pathname+url.search,headers:upstream(req.headers)},reply=>{const headers={...reply.headers};delete headers.connection;delete headers['keep-alive'];res.writeHead(reply.statusCode||502,headers);reply.pipe(res);});
    forward.once('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(forward);
   });
   server.on('upgrade',(req,socket,head)=>{
    const url=new URL(req.url||'/','http://desktop'),secret=url.searchParams.get('lease');
    const deny=()=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    if(url.pathname!=='/ws'||!valid(url.searchParams.get('token'))||!sameSite(req.headers.origin)||!lease.owns(secret)){deny();return;}
    let remote:Duplex|undefined,forward:ClientRequest|undefined;
    const end=()=>{forward?.destroy();socket.destroy();sockets.delete(socket);if(remote){remote.destroy();sockets.delete(remote);}reservation?.done();};
    const reservation=lease.reserve(secret,end);if(!reservation){deny();return;}
    url.searchParams.delete('token');url.searchParams.delete('lease');sockets.add(socket);
    socket.once('error',end);socket.once('close',end);
    forward=httpRequest({host:'127.0.0.1',port:voxlPort,path:url.pathname+url.search,headers:upstream(req.headers)});
    forward.once('upgrade',(reply,upstreamSocket,remoteHead)=>{
     remote=upstreamSocket;
     // A transfer or cancellation during the upstream handshake cannot resurrect a retired pair.
     if(!reservation.current()||socket.destroyed||!valid(input.token)){end();return;}
     sockets.add(remote);remote.once('error',end);remote.once('close',end);
     const lines=['HTTP/1.1 101 Switching Protocols'];for(let i=0;i<reply.rawHeaders.length;i+=2)lines.push(reply.rawHeaders[i]+': '+reply.rawHeaders[i+1]);
     socket.write(lines.join('\r\n')+'\r\n\r\n');if(remoteHead.length)socket.write(remoteHead);if(head.length)remote.write(head);
     remote.pipe(socket).pipe(remote);
    });
    forward.once('response',reply=>{reply.resume();end();});forward.once('error',end);forward.end();
   });
   port=await listen(server);signal.throwIfAborted();const session={port,expires,close};this.sessions.set(input.id,session);
   const retire=()=>{void this.serialize(input.id,async()=>{if(this.sessions.get(input.id)===session)await this.closeNow(input.id);});};
   timer=setInterval(()=>{if(Date.now()>=expires||child!.exitCode!==null||child!.signalCode!==null)retire();else void Promise.all(screen.owners.map(processMatches)).then(alive=>{if(alive.some(v=>!v))retire();});},1000);timer.unref();
   return {port,expires};
  }catch(error){await close();throw error;}
 }
}
