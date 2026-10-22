import {useCallback,useEffect,useState} from 'react';
import {useRealtime,useRpc,type PluginMessageDirectiveProps} from '@get-bb/plugin-sdk/app';
import {browserHandoffRpcContract,type BrowserLiveState} from '../src/browser-handoff-contract';
import {Button} from './ui/button';

export function BrowserFrame({url}:{url:string}){
  let valid=false;
  try{const parsed=new URL(url,location.href);valid=parsed.protocol==='https:'||parsed.origin===location.origin;}catch{}
  if(!valid)return null;
  return <iframe title="Browser session" src={url} allow="fullscreen" allowFullScreen referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin" style={{display:'block',width:'100%',height:'min(60vh, 560px)',minHeight:280,border:0}}/>;
}
export function BrowserLive({message}:PluginMessageDirectiveProps){
  const threadId=message.threadId,rpc=useRpc<typeof browserHandoffRpcContract>();
  const [view,setView]=useState<BrowserLiveState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(false);
  const refresh=useCallback(()=>{void rpc.call('getBrowserView',{threadId}).then(setView).catch(()=>setError(true));},[rpc,threadId]);
  useEffect(refresh,[refresh]);useRealtime('browser-view:'+threadId,refresh);
  const change=async(open:boolean)=>{
    setBusy(true);setError(false);
    try{if(open)setView(await rpc.call('openBrowserView',{threadId}));else{await rpc.call('closeBrowserView',{threadId});setView({kind:'closed'});}}
    catch{setError(true);}finally{setBusy(false);}
  };
  return <div className="space-y-2 text-sm">
    {view===null&&!error?<p className="text-xs text-muted-foreground">Loading browser…</p>:view?.kind==='watch'&&view.url?<>
      <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground"><a href={view.url} target="_blank" rel="noreferrer">Open separately</a><Button size="sm" variant="ghost" disabled={busy} onClick={()=>void change(false)}>Close view</Button></div>
      <BrowserFrame url={view.url}/>
    </>:view?.kind==='local'?<p>This browser is local. Browser handoffs will notify you here.</p>:view?.kind==='handoff'?<p>Use the browser handoff in this chat.</p>:<Button size="sm" variant="ghost" disabled={busy} onClick={()=>void change(true)}>Show live browser</Button>}
    {error&&<p role="alert" className="text-xs text-destructive">Couldn’t open the view. Check that this thread’s sandbox browser is running.</p>}
  </div>;
}
