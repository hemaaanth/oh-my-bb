import {useCallback,useEffect,useRef,useState,useSyncExternalStore,type Ref,type RefObject} from 'react';
import {experimental_Icon as Icon,useRealtime,useRpc,type ExperimentalThreadActionTabProps,type PluginMessageDirectiveProps,type PluginThreadHeaderActionProps,useBbNavigate} from '@get-bb/plugin-sdk/app';
import type {sandboxDesktopRpcContract,SandboxDesktopView} from '../src/desktop-contract.js';

const focusRing='focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** A 24px icon button. The label is both the accessible name and the tooltip. */
function IconButton({label,icon,onClick,disabled}:{label:string;icon:string;onClick:()=>void;disabled?:boolean}){
  return <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className={`inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-50 ${focusRing}`}>
    <Icon name={icon} aria-hidden className="size-3.5"/>
  </button>;
}

/** A labelled header button for the control switch, so the mode is never a guess. */
function ModeButton({label,onClick,disabled,active}:{label:string;onClick:()=>void;disabled?:boolean;active?:boolean}){
  return <button type="button" disabled={disabled} onClick={onClick} className={`inline-flex h-6 shrink-0 cursor-pointer items-center rounded-md px-2 text-xs font-medium disabled:pointer-events-none disabled:opacity-50 ${active?'bg-foreground text-background hover:opacity-90':'text-foreground hover:bg-state-hover'} ${focusRing}`}>{label}</button>;
}

const validUrl=(url:string)=>{try{return new URL(url).protocol==='https:';}catch{return false;}};

// The last known view per thread. A remount or page reload starts from it, so the card keeps
// its shape instead of collapsing to "Loading…" and growing back.
const remembered=(threadId:string):SandboxDesktopView|null=>{
  try{const view=JSON.parse(sessionStorage.getItem('sandbox-desktop:'+threadId)||'null') as SandboxDesktopView|null;return view?.kind==='open'&&view.expires>Date.now()?view:null;}catch{return null;}
};
const remember=(threadId:string,view:SandboxDesktopView)=>{try{sessionStorage.setItem('sandbox-desktop:'+threadId,JSON.stringify(view));}catch{}};

// Which desktop views are on screen, per thread. The header opens the side panel only when no
// inline card is visible, and an inline card yields its stream to a visible side panel.
const visible=new Map<string,number>(),listeners=new Set<()=>void>();
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
const shown=(key:string)=>(visible.get(key)??0)>0;
const bump=(key:string,by:number)=>{visible.set(key,(visible.get(key)??0)+by);for(const listener of listeners)listener();};
function useOnScreen(ref:RefObject<HTMLElement|null>,key:string){
  useEffect(()=>{
    const element=ref.current;if(!element||typeof IntersectionObserver==='undefined')return;
    let on=false;const set=(next:boolean)=>{if(next!==on){on=next;bump(key,next?1:-1);}};
    const observer=new IntersectionObserver(entries=>set(entries.some(entry=>entry.isIntersecting)));observer.observe(element);
    return()=>{observer.disconnect();set(false);};
  },[ref,key]);
}
const useShown=(key:string)=>useSyncExternalStore(subscribe,()=>shown(key),()=>false);

type Frame={url:string;ready:boolean};
/** Stacks voxl frames. A new stream loads hidden under the old one and replaces it once it is drawing. */
function DesktopFrames({url,control,panel,frameRef,onPending}:{url:string|null;control:boolean;panel:boolean;frameRef:Ref<HTMLDivElement>;onPending:(pending:boolean)=>void}){
  const [frames,setFrames]=useState<Frame[]>(()=>url?[{url,ready:true}]:[]);
  useEffect(()=>{setFrames(list=>!url?[]:list.at(-1)?.url===url?list:[...list.filter(frame=>frame.ready).slice(-1),{url,ready:!list.some(frame=>frame.ready)}]);},[url]);
  const reveal=useCallback((url:string)=>setFrames(list=>list.some(frame=>frame.url===url)?[{url,ready:true}]:list),[]);
  const pending=frames.find(frame=>!frame.ready)?.url??null;
  // voxl has no cross-origin ready signal. Its page connects about a second after it loads.
  useEffect(()=>{onPending(!!pending);if(!pending)return;const timer=setTimeout(()=>reveal(pending),6000);return()=>clearTimeout(timer);},[pending,reveal,onPending]);
  if(!frames.length)return null;
  return <div ref={frameRef} className={`relative bg-black ${control?'outline outline-2 -outline-offset-2 outline-foreground/60':''}`} style={panel?{flex:1,minHeight:0}:{aspectRatio:'16 / 9',maxHeight:'70vh'}}>
    {frames.map(frame=><iframe key={frame.url} title="Sandbox desktop" src={frame.url} allow="clipboard-read; clipboard-write" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin"
      onLoad={frame.ready?undefined:()=>setTimeout(()=>reveal(frame.url),2000)}
      className={`absolute inset-0 block size-full border-0 bg-black ${frame.ready?'':'pointer-events-none opacity-0'}`}/>)}
  </div>;
}

/** The sandbox's own display. The same view backs the inline directive and the side panel. */
function SandboxDesktop({threadId,panel}:{threadId:string;panel:boolean}){
  const rpc=useRpc<typeof sandboxDesktopRpcContract>();
  const [view,setViewState]=useState<SandboxDesktopView|null>(()=>remembered(threadId)),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[pending,setPending]=useState(false);
  const setView=useCallback((next:SandboxDesktopView)=>{remember(threadId,next);setViewState(next);},[threadId]);
  const frame=useRef<HTMLDivElement>(null),root=useRef<HTMLDivElement>(null);
  useOnScreen(root,(panel?'panel:':'inline:')+threadId);
  const panelShown=useShown('panel:'+threadId),yielded=!panel&&panelShown;
  const refresh=useCallback(()=>{void rpc.call('getSandboxDesktop',{threadId}).then(setView).catch(()=>setView({kind:'closed'}));},[rpc,threadId,setView]);
  useEffect(refresh,[refresh]);useRealtime('sandbox-desktop:'+threadId,refresh);
  // Opening always starts in watch mode. Control is a separate, explicit step.
  const change=async(open:boolean,viewOnly=true)=>{
    setBusy(true);setError(null);
    try{if(open)setView(await rpc.call('openSandboxDesktop',{threadId,viewOnly}));else{await rpc.call('closeSandboxDesktop',{threadId});setView({kind:'closed'});}}
    catch(cause){setError(cause instanceof Error&&cause.message?cause.message:'Couldn’t open the desktop.');}finally{setBusy(false);}
  };
  const open=view?.kind==='open'&&validUrl(view.url)?view:null;
  const until=open?' · until '+new Date(open.expires).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'';
  const status=error?<span role="alert" className="min-w-0 truncate text-destructive" title={error}>{error}</span>
    :view===null?<span className="text-muted-foreground">Loading…</span>
    :busy||pending?<span className="text-muted-foreground">{open?'Switching…':'Opening…'}</span>
    :open&&yielded?<span className="min-w-0 truncate text-muted-foreground">Showing in the side panel</span>
    :open?.viewOnly?<span className="min-w-0 truncate tabular-nums text-muted-foreground">Watching{until}</span>
    :open?<span className="min-w-0 truncate tabular-nums font-medium text-foreground">You’re in control{until}</span>
    :<span className="text-muted-foreground">Closed</span>;
  const actions=open?<>
    {open.viewOnly
      ?<ModeButton label="Take control" disabled={busy} onClick={()=>void change(true,false)}/>
      :<ModeButton label="Stop control" active disabled={busy} onClick={()=>void change(true,true)}/>}
    <IconButton label="Fullscreen" icon="Maximize2" onClick={()=>void frame.current?.requestFullscreen?.().catch(()=>{})}/>
    <IconButton label="Open in new tab" icon="ExternalLink" onClick={()=>window.open(open.url,'_blank','noopener,noreferrer')}/>
    <IconButton label="Close view" icon="X" disabled={busy} onClick={()=>void change(false)}/>
  </>:view===null?null:<IconButton label="Show desktop" icon="Play" disabled={busy} onClick={()=>void change(true)}/>;
  const header=<div className={`flex h-8 shrink-0 items-center gap-1.5 pl-3 pr-1 text-xs ${open&&!yielded?'border-b border-border':''}`}>
    <Icon name="ComputerCloud" aria-hidden className="size-3.5 shrink-0 text-muted-foreground"/>
    <span className="shrink-0 font-medium text-foreground">Sandbox desktop</span>
    <span className="flex min-w-0 flex-1 items-center">{status}</span>
    <span className="ml-1 flex shrink-0 items-center gap-0.5">{actions}</span>
  </div>;
  // The desktop keeps a fixed 16:9 size; voxl scales it to fit and centers it.
  // The header owns fullscreen. Without the fullscreen permission voxl hides its own button.
  const body=<DesktopFrames url={yielded?null:open?.url??null} control={!!open&&!open.viewOnly} panel={panel} frameRef={frame} onPending={setPending}/>;
  return panel
    ?<div ref={root} className="flex h-full flex-col text-sm">{header}{body}</div>
    :<div ref={root} className="my-2 overflow-hidden rounded-lg border border-border bg-background text-sm">{header}{body}</div>;
}

// The agent's view must show even when its reply leaves out the directive, so a view the
// agent opens also opens the side panel once, unless an inline card is already on screen.
const seenKey=(threadId:string)=>'sandbox-desktop-seen:'+threadId;
export function SandboxDesktopHeaderAction({threadId,isCompactViewport}:PluginThreadHeaderActionProps){
  const rpc=useRpc<typeof sandboxDesktopRpcContract>(),navigate=useBbNavigate();
  const openPanel=useCallback(()=>navigate.openThreadPanel({actionId:'desktop'}),[navigate]);
  const [view,setView]=useState<SandboxDesktopView|null>(null);
  const refresh=useCallback(()=>{void rpc.call('getSandboxDesktop',{threadId}).then(setView).catch(()=>setView(null));},[rpc,threadId]);
  useEffect(refresh,[refresh]);useRealtime('sandbox-desktop:'+threadId,refresh);
  const open=view?.kind==='open'&&validUrl(view.url)?view:null;
  useEffect(()=>{
    if(!open?.agent)return;
    let seen:string|null=null;try{seen=sessionStorage.getItem(seenKey(threadId));}catch{}
    if(seen===open.url)return;
    try{sessionStorage.setItem(seenKey(threadId),open.url);}catch{}
    if(!shown('inline:'+threadId)&&!shown('panel:'+threadId))openPanel();
  },[open?.agent,open?.url,threadId,openPanel]);
  if(!open)return null;
  return <button type="button" title="Show the sandbox desktop" aria-label="Show the sandbox desktop" onClick={()=>openPanel()} className={`inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground ${focusRing}`}>
    <Icon name="ComputerCloud" aria-hidden className="size-3.5"/>
    {isCompactViewport?null:<span>{open.viewOnly?'Desktop':'Desktop · You’re in control'}</span>}
  </button>;
}

export function SandboxDesktopDirective({message}:PluginMessageDirectiveProps){return <SandboxDesktop threadId={message.threadId} panel={false}/>;}
export function SandboxDesktopPanel({threadId}:ExperimentalThreadActionTabProps){return <SandboxDesktop threadId={threadId} panel/>;}
