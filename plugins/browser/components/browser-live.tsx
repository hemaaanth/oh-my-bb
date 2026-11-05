import {useCallback,useEffect,useRef,useState,type Ref} from 'react';
import {experimental_Icon as Icon,useRealtime,useRpc,type PluginMessageDirectiveProps} from '@get-bb/plugin-sdk/app';
import type {browserHandoffRpcContract, BrowserLiveState} from '../src/browser-handoff-contract';

const focusRing='focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Pass frameRef when the caller has its own fullscreen button; voxl then hides its inner one. */
export function BrowserFrame({url,frameRef}:{url:string;frameRef?:Ref<HTMLIFrameElement>}){
  let valid=false;
  try{const parsed=new URL(url,location.href);valid=parsed.protocol==='https:'||parsed.origin===location.origin;}catch{}
  if(!valid)return null;
  return <iframe ref={frameRef} title="Browser session" src={url} {...frameRef?{}:{allow:'fullscreen',allowFullScreen:true}} referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin" className="block w-full border-0 bg-black" style={{aspectRatio:'16 / 9',maxHeight:'70vh',minHeight:280}}/>;
}
/** A 24px icon button. The label is both the accessible name and the tooltip. */
function IconButton({label,icon,onClick,disabled}:{label:string;icon:string;onClick:()=>void;disabled?:boolean}){
  return <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className={`inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-50 ${focusRing}`}>
    <Icon name={icon} aria-hidden className="size-3.5"/>
  </button>;
}

export function BrowserLive({message}:PluginMessageDirectiveProps){
  const threadId=message.threadId,rpc=useRpc<typeof browserHandoffRpcContract>();
  const [view,setView]=useState<BrowserLiveState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  // Closing an idle thread's view also closes its browser, so there is nothing left to reopen.
  const [closedHere,setClosedHere]=useState(false);
  const frame=useRef<HTMLIFrameElement>(null);
  const refresh=useCallback(()=>{void rpc.call('getBrowserView',{threadId}).then(setView).catch(()=>setError('Couldn’t load the live view.'));},[rpc,threadId]);
  useEffect(refresh,[refresh]);useRealtime('browser-view:'+threadId,refresh);
  const change=async(open:boolean)=>{
    setBusy(true);setError(null);
    try{if(open)setView(await rpc.call('openBrowserView',{threadId}));else{await rpc.call('closeBrowserView',{threadId});setView({kind:'closed'});setClosedHere(true);}}
    catch{setError(open?'The browser isn’t running. Ask the agent to open it again.':'Couldn’t close the view.');}finally{setBusy(false);}
  };
  const watching=view?.kind==='watch'&&view.url?view.url:null;
  const status=error?<span role="alert" className="min-w-0 truncate text-destructive" title={error}>{error}</span>
    :view===null?<span className="text-muted-foreground">Loading…</span>
    :watching?<span className="text-muted-foreground">View only</span>
    :view.kind==='local'?<span className="min-w-0 truncate text-muted-foreground">This browser is local. Browser handoffs will notify you here.</span>
    :view.kind==='handoff'?<span className="min-w-0 truncate text-muted-foreground">Use the browser handoff in this chat.</span>
    :busy?<span className="text-muted-foreground">Opening…</span>:<span className="text-muted-foreground">Closed</span>;
  const actions=watching?<>
    <IconButton label="Fullscreen" icon="Maximize2" onClick={()=>void frame.current?.requestFullscreen?.().catch(()=>{})}/>
    <IconButton label="Open in new tab" icon="ExternalLink" onClick={()=>window.open(watching,'_blank','noopener,noreferrer')}/>
    <IconButton label="Close view" icon="X" disabled={busy} onClick={()=>void change(false)}/>
  </>:view?.kind==='closed'&&!closedHere?<IconButton label="Show live browser" icon="Eye" disabled={busy} onClick={()=>void change(true)}/>:null;
  return <div className="my-2 overflow-hidden rounded-lg border border-border bg-background text-sm">
    <div className={`flex h-8 items-center gap-1.5 pl-3 pr-1 text-xs ${watching?'border-b border-border':''}`}>
      <Icon name="Globe" aria-hidden className="size-3.5 shrink-0 text-muted-foreground"/>
      <span className="shrink-0 font-medium text-foreground">Live browser</span>
      <span className="flex min-w-0 flex-1 items-center">{status}</span>
      <span className="ml-1 flex shrink-0 items-center gap-0.5">{actions}</span>
    </div>
    {watching?<BrowserFrame url={watching} frameRef={frame}/>:null}
  </div>;
}
