import {useCallback,useEffect,useState} from 'react';
import {useRealtime,useRpc,type ExperimentalThreadActionTabProps,type PluginMessageDirectiveProps} from '@get-bb/plugin-sdk/app';
import type {sandboxDesktopRpcContract,SandboxDesktopView} from '../src/desktop-contract.js';
import {Button} from './ui/button';

function DesktopFrame({url,panel}:{url:string;panel:boolean}){
  let valid=false;
  try{valid=new URL(url).protocol==='https:';}catch{}
  if(!valid)return null;
  return <iframe title="Sandbox desktop" src={url} allow="fullscreen; clipboard-read; clipboard-write" allowFullScreen referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin" style={panel?{display:'block',width:'100%',flex:1,minHeight:0,border:0}:{display:'block',width:'100%',height:'min(60vh, 560px)',minHeight:280,border:0}}/>;
}

/** The sandbox's own display. The same view backs the inline directive and the side panel. */
function SandboxDesktop({threadId,panel}:{threadId:string;panel:boolean}){
  const rpc=useRpc<typeof sandboxDesktopRpcContract>();
  const [view,setView]=useState<SandboxDesktopView|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const refresh=useCallback(()=>{void rpc.call('getSandboxDesktop',{threadId}).then(setView).catch(()=>setView({kind:'closed'}));},[rpc,threadId]);
  useEffect(refresh,[refresh]);useRealtime('sandbox-desktop:'+threadId,refresh);
  const change=async(open:boolean,viewOnly=false)=>{
    setBusy(true);setError(null);
    try{if(open)setView(await rpc.call('openSandboxDesktop',{threadId,viewOnly}));else{await rpc.call('closeSandboxDesktop',{threadId});setView({kind:'closed'});}}
    catch(cause){setError(cause instanceof Error&&cause.message?cause.message:'Couldn’t open the desktop.');}finally{setBusy(false);}
  };
  const body=view===null?<p className="text-xs text-muted-foreground">Loading desktop…</p>:view.kind==='open'?<>
    <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
      <span className="mr-auto">{view.viewOnly?'View only · ':''}Closes at {new Date(view.expires).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</span>
      <a href={view.url} target="_blank" rel="noreferrer">Open separately</a>
      <Button size="sm" variant="ghost" disabled={busy} onClick={()=>void change(false)}>Close view</Button>
    </div>
    <DesktopFrame url={view.url} panel={panel}/>
  </>:<div className="flex gap-2">
    <Button size="sm" variant="ghost" disabled={busy} onClick={()=>void change(true)}>{busy?'Opening…':'Show desktop'}</Button>
    <Button size="sm" variant="ghost" disabled={busy} onClick={()=>void change(true,true)}>View only</Button>
  </div>;
  return <div className={panel?'flex h-full flex-col gap-2 p-2 text-sm':'space-y-2 text-sm'}>
    {body}
    {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}

export function SandboxDesktopDirective({message}:PluginMessageDirectiveProps){return <SandboxDesktop threadId={message.threadId} panel={false}/>;}
export function SandboxDesktopPanel({threadId}:ExperimentalThreadActionTabProps){return <SandboxDesktop threadId={threadId} panel/>;}
