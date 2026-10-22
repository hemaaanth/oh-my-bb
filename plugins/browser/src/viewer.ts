import { randomBytes, createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { viewerAction, browserViewerHostContract } from "./viewer-contract.js";

export function registerViewer(bb: BbPluginApi) {
  const client = bb.hosts.experimental_client({ contract: browserViewerHostContract });
  const grants = new Map<string, { threadId: string; hostId: string; expires: number; busy: boolean }>();
  const hash = (token: string) => createHash("sha256").update(token).digest("hex");
  const revoke = (threadId: string) => { for (const [key, grant] of grants) if (grant.threadId === threadId) grants.delete(key); };
  const issue = (threadId: string, hostId: string) => {
    revoke(threadId); const token = randomBytes(32).toString("base64url");
    grants.set(hash(token), { threadId, hostId, expires: Date.now() + 15 * 60_000, busy: false });
    return `${bb.server.experimental_appUrl || bb.server.loopbackBaseUrl}/api/v1/plugins/browser/http/viewer?token=${token}`;
  };
  const grantFor = (token: string) => { const key = hash(token); const grant = grants.get(key); if (!grant || grant.expires < Date.now()) { grants.delete(key); return null; } return grant; };
  bb.onDispose(() => grants.clear());
  bb.http.route("GET", "/viewer", c => {
    const token = c.req.query("token") || "";
    if (!grantFor(token)) return c.text("Browser handoff viewer expired. Reopen it from the waiting BB card.", 403);
    c.header("Cache-Control", "no-store"); c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'self'");
    return c.html(`<!doctype html><meta name="viewport" content="width=device-width"><title>Private Browser handoff</title><style>body{margin:0;background:#171717;color:#eee;font:14px system-ui}header{padding:12px}img{display:block;max-width:100%;outline:none}input{width:70%;margin:8px}button{padding:6px}</style><header>Private session. Automation is paused. Finish with Done or Cancel in BB. <span id="status"></span><label> Page <select id="tabs" aria-label="Session page"></select></label><span id="dialog" hidden><span id="dialog-message"></span><input id="prompt" aria-label="Dialog prompt response" autocomplete="off"><button id="accept">Accept</button><button id="dismiss">Dismiss</button></span><small>Page and JavaScript-dialog controls only. OS file pickers and browser-chrome challenges need a host desktop; no foreground fallback.</small></header><img id="screen" tabindex="0" alt="Browser session"><form id="input"><input id="text" autocomplete="off" type="password" aria-label="Type into focused browser field"><button>Type</button></form><script>
const token=${JSON.stringify(token)},screen=document.querySelector('#screen'),status=document.querySelector('#status');let stopped=false,chain=Promise.resolve();history.replaceState(null,'',location.pathname);
const reconnect=document.createElement('button');reconnect.textContent='Reconnect';reconnect.hidden=true;document.querySelector('header').append(reconnect);reconnect.onclick=()=>{reconnect.hidden=true;stopped=false;chain=Promise.resolve();frame()};
async function send(action){const r=await fetch('./viewer-control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,action})});if(!r.ok)throw Error(r.status===403?'Viewer expired':'Session unavailable');return r.json()}
function input(action){if(stopped)return;chain=chain.then(()=>stopped?undefined:send(action)).catch(e=>{status.textContent=e.message+'; inspect before repeating input';stopped=true;reconnect.hidden=e.message==='Viewer expired'})}
async function frame(){if(stopped)return;try{const r=await(chain=chain.then(()=>send({type:'frame'})));if(r.data)screen.src='data:image/png;base64,'+r.data;const tabs=document.querySelector('#tabs');tabs.replaceChildren(...(r.tabs||[]).map(t=>{const option=document.createElement('option');option.value=t.id;option.textContent=t.title||t.url;return option}));tabs.parentElement.hidden=!!r.desktop;if(r.current)tabs.value=r.current;document.querySelector('#dialog').hidden=!r.dialog;document.querySelector('#dialog-message').textContent=r.dialog?.message||'';document.querySelector('#prompt').hidden=r.dialog?.type!=='prompt';document.querySelector('small').textContent=r.desktop?'Private session desktop: browser chrome, dialogs and popups. No host-desktop access.':'Page controls only. Browser-chrome and OS dialogs are not exposed in regular-profile or scratch headless sessions.';status.textContent='Connected'}catch(e){status.textContent=e.message;stopped=true;reconnect.hidden=e.message==='Viewer expired'}if(!stopped)setTimeout(frame,500)}
for(const [event,type] of [['mousedown','down'],['mouseup','up']])screen.addEventListener(event,e=>{e.preventDefault();const r=screen.getBoundingClientRect();input({type:'pointer',event:type,x:(e.clientX-r.left)*screen.naturalWidth/r.width,y:(e.clientY-r.top)*screen.naturalHeight/r.height});screen.focus()});
document.querySelector('#tabs').onchange=e=>input({type:'tab',target:e.target.value});for(const [id,accept]of [['accept',true],['dismiss',false]])document.querySelector('#'+id).onclick=()=>input({type:'dialog',accept,promptText:document.querySelector('#prompt').value});screen.addEventListener('wheel',e=>{e.preventDefault();input({type:'scroll',deltaY:Math.max(-1000,Math.min(1000,e.deltaY))})},{passive:false});
screen.addEventListener('keydown',e=>{e.preventDefault();const modifiers=['Control','Alt','Shift','Meta'].filter(key=>e.getModifierState(key));input(e.key.length===1&&!e.ctrlKey&&!e.altKey&&!e.metaKey?{type:'text',text:e.key}:{type:'key',key:e.key,modifiers})});document.querySelector('#input').onsubmit=e=>{e.preventDefault();const t=document.querySelector('#text');input({type:'text',text:t.value});t.value=''};frame();
</script>`);
  });
  bb.http.route("POST", "/viewer-control", async c => {
    const length = Number(c.req.header("content-length") || 0);
    if(length > 8192)return c.json({error:"Viewer input too large"},413);
    const reader=c.req.raw.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
    if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192){await reader.cancel();return c.json({error:"Viewer input too large"},413);}chunks.push(value);}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{return c.json({error:"Invalid viewer input"},400);}
    const grant = typeof body?.token === "string" ? grantFor(body.token) : null;
    const action = viewerAction.safeParse(body?.action);
    if (!grant) return c.json({ error: "Viewer expired" }, 403);
    if (!action.success) return c.json({ error: "Invalid viewer action" }, 400);
    if (grant.busy) return c.json({ error: "Viewer input busy" }, 409);
    grant.busy = true;
    try {
      const result = await client.call("browserViewerControl", { threadId: grant.threadId, action: action.data }, { hostId: grant.hostId, timeoutMs: 30_000, signal: AbortSignal.timeout(30_000) });
      if (!result.ok) return c.json({ error: "Session unavailable; no fallback browser was opened" }, 503);
      return c.json(action.data.type === "frame" ? JSON.parse(result.data) : { ok: true });
    } finally { grant.busy = false; }
  });
  return { issue, revoke };
}
