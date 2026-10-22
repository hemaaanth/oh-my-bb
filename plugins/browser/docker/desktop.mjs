import { spawnSync } from 'node:child_process';

export async function prepareDesktop(record){
  const version=await(await fetch('http://127.0.0.1:'+record.port+'/json/version',{signal:AbortSignal.timeout(5000)})).json();
  const endpoint=new URL(version.webSocketDebuggerUrl);if(!['127.0.0.1','localhost'].includes(endpoint.hostname))throw Error('Nonlocal desktop debugger refused');
  const socket=new WebSocket(endpoint),pending=new Map();let next=0;
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error('Desktop handoff preparation timed out'));},5000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
  socket.onmessage=event=>{const message=JSON.parse(event.data),job=pending.get(message.id);if(job){clearTimeout(job.timer);pending.delete(message.id);message.error?job.reject(Error(message.error.message)):job.resolve(message.result);}};
  try{const pages=(await call('Target.getTargets')).targetInfos.filter(target=>target.type==='page');
    if(pages[0]){const {windowId}=await call('Browser.getWindowForTarget',{targetId:pages[0].targetId});await call('Browser.setWindowBounds',{windowId,bounds:{windowState:'maximized'}});}
    for(const target of pages){
    const {sessionId}=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
    try{await call('Page.setInterceptFileChooserDialog',{enabled:false},sessionId);}finally{await call('Target.detachFromTarget',{sessionId});}
  }}finally{socket.close();}
}

// This display belongs to one isolated session. Never use the host's DISPLAY.
export function desktopOperation(display, action) {
  if (!/^:\d+$/.test(display?.name || '') || !display.authority) throw Error('Private session display unavailable');
  const env = {...process.env, DISPLAY:display.name, XAUTHORITY:display.authority, WAYLAND_DISPLAY:''};
  const run = (binary, args, input) => {
    const result=spawnSync(binary,args,{env,input,timeout:10000,maxBuffer:8*1024*1024});
    if(result.error||result.status!==0)throw Error('Private desktop '+binary+' failed; no host-desktop fallback');
    return result.stdout;
  };
  if(action.type==='frame')return {data:run('import',['-silent','-window','root','png:-']).toString('base64'),desktop:true,tabs:[],dialog:null};
  if(action.type==='pointer'){
    const [width,height]=run('xdotool',['getdisplaygeometry']).toString().trim().split(/\s+/).map(Number);
    if(!width||!height||!['down','up','move'].includes(action.event)||!Number.isFinite(action.x)||!Number.isFinite(action.y)||action.x<0||action.x>=width||action.y<0||action.y>=height)throw Error('Invalid private desktop pointer');
    run('xdotool',['mousemove','--sync',String(Math.round(action.x)),String(Math.round(action.y)),...(action.event==='move'?[]:[action.event==='down'?'mousedown':'mouseup','1'])]);
  }else if(action.type==='text'){
    if(typeof action.text!=='string'||action.text.length>4096)throw Error('Invalid private desktop text');
    run('xdotool',['type','--clearmodifiers','--delay','0','--file','-'],action.text);
  }else if(action.type==='key'){
    const names={Enter:'Return',Backspace:'BackSpace',Tab:'Tab',Escape:'Escape',ArrowLeft:'Left',ArrowRight:'Right',ArrowUp:'Up',ArrowDown:'Down',Delete:'Delete',Home:'Home',End:'End',PageUp:'Prior',PageDown:'Next',Shift:'Shift_L',Control:'Control_L',Alt:'Alt_L',Meta:'Super_L'};
    const key=names[action.key]||(/^[a-zA-Z0-9]$/.test(action.key||'')?action.key:null);
    if(!key)throw Error('Unsupported private desktop key');
    const modifiers={Control:'ctrl',Alt:'alt',Shift:'shift',Meta:'super'},selected=action.modifiers||[];
    if(!Array.isArray(selected)||selected.length>4||selected.some(key=>!Object.hasOwn(modifiers,key)))throw Error('Invalid private desktop modifiers');
    run('xdotool',['key','--clearmodifiers',[...selected.filter(modifier=>modifier!==action.key).map(modifier=>modifiers[modifier]),key].join('+')]);
  }else if(action.type==='scroll'){
    if(!Number.isFinite(action.deltaY)||Math.abs(action.deltaY)>1000)throw Error('Invalid private desktop scroll');
    if(action.deltaY)run('xdotool',['click','--repeat',String(Math.max(1,Math.round(Math.abs(action.deltaY)/100))),'--delay','30',action.deltaY<0?'4':'5']);
  }else throw Error('Use the private desktop controls to select tabs and native dialogs');
  return {ok:true};
}
