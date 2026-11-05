import {useCallback,useEffect,useRef,useState} from 'react';
import {experimental_Icon as Icon,useRealtime,useRpc,type ExperimentalThreadActionTabProps,type PluginMessageDirectiveProps} from '@get-bb/plugin-sdk/app';
import type {sandboxDesktopRpcContract,SandboxDesktopView} from '../src/desktop-contract.js';

const focusRing='focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** A 24px icon button. The label is both the accessible name and the tooltip. */
function IconButton({label,icon,onClick,disabled}:{label:string;icon:string;onClick:()=>void;disabled?:boolean}){
  return <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className={`inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-50 ${focusRing}`}>
    <Icon name={icon} aria-hidden className="size-3.5"/>
  </button>;
}

const validUrl=(url:string)=>{try{return new URL(url).protocol==='https:';}catch{return false;}};

/** The sandbox's own display. The same view backs the inline directive and the side panel. */
function SandboxDesktop({threadId,panel}:{threadId:string;panel:boolean}){
  const rpc=useRpc<typeof sandboxDesktopRpcContract>();
  const [view,setView]=useState<SandboxDesktopView|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const frame=useRef<HTMLIFrameElement>(null);
  const refresh=useCallback(()=>{void rpc.call('getSandboxDesktop',{threadId}).then(setView).catch(()=>setView({kind:'closed'}));},[rpc,threadId]);
  useEffect(refresh,[refresh]);useRealtime('sandbox-desktop:'+threadId,refresh);
  const change=async(open:boolean,viewOnly=false)=>{
    setBusy(true);setError(null);
    try{if(open)setView(await rpc.call('openSandboxDesktop',{threadId,viewOnly}));else{await rpc.call('closeSandboxDesktop',{threadId});setView({kind:'closed'});}}
    catch(cause){setError(cause instanceof Error&&cause.message?cause.message:'Couldn’t open the desktop.');}finally{setBusy(false);}
  };
  const open=view?.kind==='open'&&validUrl(view.url)?view:null;
  const status=error?<span role="alert" className="min-w-0 truncate text-destructive" title={error}>{error}</span>
    :view===null?<span className="text-muted-foreground">Loading…</span>
    :open?<span className="min-w-0 truncate tabular-nums text-muted-foreground">{open.viewOnly?'View only · ':''}until {new Date(open.expires).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</span>
    :busy?<span className="text-muted-foreground">Opening…</span>:<span className="text-muted-foreground">Closed</span>;
  const actions=open?<>
    <IconButton label="Fullscreen" icon="Maximize2" onClick={()=>void frame.current?.requestFullscreen?.().catch(()=>{})}/>
    <IconButton label="Open in new tab" icon="ExternalLink" onClick={()=>window.open(open.url,'_blank','noopener,noreferrer')}/>
    <IconButton label="Close view" icon="X" disabled={busy} onClick={()=>void change(false)}/>
  </>:view===null?null:<>
    <IconButton label="Watch (view only)" icon="Eye" disabled={busy} onClick={()=>void change(true,true)}/>
    <IconButton label="Show desktop" icon="Play" disabled={busy} onClick={()=>void change(true)}/>
  </>;
  const header=<div className={`flex h-8 shrink-0 items-center gap-1.5 pl-3 pr-1 text-xs ${open?'border-b border-border':''}`}>
    <Icon name="ComputerCloud" aria-hidden className="size-3.5 shrink-0 text-muted-foreground"/>
    <span className="shrink-0 font-medium text-foreground">Sandbox desktop</span>
    <span className="flex min-w-0 flex-1 items-center">{status}</span>
    <span className="ml-1 flex shrink-0 items-center gap-0.5">{actions}</span>
  </div>;
  // The desktop keeps a fixed 16:9 size; voxl scales it to fit and centers it.
  const body=open?<iframe ref={frame} title="Sandbox desktop" src={open.url} allow="fullscreen; clipboard-read; clipboard-write" allowFullScreen referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin"
    className="block w-full border-0 bg-black" style={panel?{flex:1,minHeight:0}:{aspectRatio:'16 / 9',maxHeight:'70vh'}}/>:null;
  return panel
    ?<div className="flex h-full flex-col text-sm">{header}{body}</div>
    :<div className="my-2 overflow-hidden rounded-lg border border-border bg-background text-sm">{header}{body}</div>;
}

export function SandboxDesktopDirective({message}:PluginMessageDirectiveProps){return <SandboxDesktop threadId={message.threadId} panel={false}/>;}
export function SandboxDesktopPanel({threadId}:ExperimentalThreadActionTabProps){return <SandboxDesktop threadId={threadId} panel/>;}
