import { pageOperation } from './page-operations.js';

const sessions = new Map(), attached = new Set(), cancelled = new Set(), dialogs = new Map(), optOut = new Set();
export function relayStatus() { return socket?.readyState === WebSocket.OPEN ? 'connected' : socket?.readyState === WebSocket.CONNECTING ? 'connecting' : 'disconnected'; }
let socket, serial = Promise.resolve(), run, installation;
const leases = new Map(), managedGroups = new Map();
const save = () => chrome.storage.session.set({ threadSessions: Object.fromEntries(sessions),identityLeases:Object.fromEntries(leases) });

chrome.debugger.onDetach.addListener((source, reason) => { attached.delete(source.tabId); if (reason === 'canceled_by_user') cancelled.add(source.tabId); });
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === 'Page.javascriptDialogOpening') { dialogs.set(source.tabId, params); }
  if (method === 'Page.javascriptDialogClosed') dialogs.delete(source.tabId);
  if(method==='Page.screencastFrame')void chrome.debugger.sendCommand(source,'Page.screencastFrameAck',{sessionId:params.sessionId}).catch(()=>{});
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) { for (const state of [...sessions.values(),...managedGroups.values()]) if (state.grouped?.includes(id)) optOut.add(id); void chrome.storage.session.set({groupOptOut:[...optOut]}); }
});
chrome.tabs.onCreated.addListener(tab => {
  // An OAuth popup belongs to the thread whose owned tab opened it.
  for (const state of sessions.values()) if (state.owned.includes(tab.openerTabId)) { state.owned.push(tab.id); void save(); break; }
});

async function group(state, tabId, label) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.pinned || optOut.has(tabId) || tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && tab.groupId !== state.groupId) return;
  const groupId = await chrome.tabs.group({ tabIds: [tabId], ...(state.groupId !== undefined && tab.windowId === state.windowId ? { groupId: state.groupId } : {createProperties:{windowId:tab.windowId}}) });
  await chrome.tabGroups.update(groupId, { title: label.slice(0, 32), color: 'cyan' });
  if (tab.windowId === state.windowId) state.groupId = groupId;
  state.grouped = [...new Set([...(state.grouped || []), tabId])];
}
// Called only over an already verified managed browser's local CDP connection.
globalThis.__bbGroupTargets = async (targetIds, label) => {
  const targets = await chrome.debugger.getTargets();
  const ids = targets.filter(t => targetIds.includes(t.id)).map(t => t.tabId).filter(Number.isInteger);
  const windowId = ids.length ? (await chrome.tabs.get(ids[0])).windowId : undefined;
  if(!managedGroups.has(windowId)){const saved=await chrome.storage.session.get(['managedGroups','groupOptOut']);for(const id of saved.groupOptOut||[])optOut.add(id);for(const [key,state]of Object.entries(saved.managedGroups||{}))managedGroups.set(Number(key),state);}
  const state = managedGroups.get(windowId) || { owned: ids, grouped: [], windowId };
  managedGroups.set(windowId, state);
  for (const id of ids) await group(state, id, label);
  await chrome.storage.session.set({managedGroups:Object.fromEntries(managedGroups)});
  return { grouped: state.grouped.length };
};

async function claimLeases(keys,threadId) {
  const now=Date.now();for(const [key,lease]of leases)if(lease.expires<=now)leases.delete(key);
  for(const key of keys){const lease=leases.get(key);if(lease&&lease.threadId!==threadId)throw Error('Shared account/origin leased by another thread; use an isolated session or wait for its bounded lease');}
  if(leases.size+keys.filter(key=>!leases.has(key)).length>256)throw Error('Browser identity lease capacity reached');
  for(const key of keys)leases.set(key,{threadId,expires:now+15*60*1000});await save();
}
async function debuggerCommand(tabId,method,params,deadline,ownedWindow) {
  if(['Target.activateTarget','Page.bringToFront','Browser.setWindowBounds','Browser.close','Target.closeTarget','Target.createTarget'].includes(method))throw Error('Foreground or browser-global operation refused');
  const remaining=method==='Page.stopScreencast'?5000:Math.min(method==='Page.startScreencast'?5000:15000,deadline-Date.now());
  if(remaining<=0)throw Error(method+' deadline; inspect uncertain mutations before retrying');
  if(method==='Page.captureScreenshot'&&!params.captureBeyondViewport&&ownedWindow!==undefined){
    const tab=await chrome.tabs.get(tabId);if(tab.windowId!==ownedWindow||!tab.active)throw Error('Viewport capture needs the selected tab in its owned window; BB will not activate or move a tab');
    const image=await chrome.tabs.captureVisibleTab(ownedWindow,{format:'png'}),after=await chrome.tabs.get(tabId);
    if(!after.active||after.windowId!==ownedWindow)throw Error('Tab changed during capture; image discarded');
    if(!image.startsWith('data:image/png;base64,'))throw Error('Browser returned an invalid screenshot');return {data:image.slice(22)};
  }
  const {promise,resolve,reject}=Promise.withResolvers();const timer=setTimeout(()=>reject(Error(method+' deadline; inspect uncertain mutations before retrying')),remaining);
  chrome.debugger.sendCommand({tabId},method,params).then(resolve,reject);
  try{return await promise;}finally{clearTimeout(timer);}
}
async function execute(request) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.threadId) || !Array.isArray(request.argv)) throw Error('Invalid thread command');
  const [command, ...args] = request.argv;
  if (Date.now() > request.deadline) throw Error('Command expired before input');
  let state = sessions.get(request.threadId);
  if (!state) { state = { owned: [], borrowed: [], grouped: [], paused: false, label: request.label || request.threadId }; sessions.set(request.threadId, state); }
  const viewerAction=command==='thread'&&args[0]==='viewer'?JSON.parse(args.slice(1).join(' ')||'{}'):null;
  const selected=viewerAction?.type==='tab'?Number(viewerAction.target):command==='tab'&&args[0]==='borrow'?Number(args[1]):command==='tab'&&/^\d+$/.test(args[0]||'')?Number(args[0]):state.current;
  if(selected!==state.current&&!(command==='tab'&&args[0]==='borrow')&&![...state.owned,...state.borrowed].includes(selected))throw Error('Target does not belong to this thread');
  const needsLease=command!=='close'&&command!=='doctor'&&command!=='identity'&&!(command==='tab'&&['discover','list'].includes(args[0]))&&!(command==='thread'&&['label','resume','discard','show'].includes(args[0]));
  if(needsLease){
    const url=['open','goto','navigate'].includes(command)?args[0]:command==='tab'&&args[0]==='new'?args[1]:selected?(await chrome.tabs.get(selected)).url:null;
    const keys=[];if(url&&/^https?:/.test(url))keys.push('origin:'+new URL(url).hostname);if(state.account)keys.push('account:'+state.account);
    await claimLeases(keys,request.threadId);
  }
  if (command === 'thread') {
    if (args[0] === 'pause') state.paused = true;
    else if (args[0] === 'resume') state.paused = false;
    else if (args[0] === 'show') return { ok: true, message: 'Open the regular profile manually; BB never activates it.' };
    else if (args[0] === 'label') { state.label = args[1] || request.threadId; for (const id of state.owned) await group(state, id, state.label); }
    else if (args[0] === 'discard') { state.paused = false; return execute({ ...request, argv: ['close', '--all'] }); }
    else if (args[0] === 'viewer') {
      if (!state.paused || ![...state.owned, ...state.borrowed].includes(selected)) throw Error('Viewer expired or target is not owned');
      if(viewerAction.type==='tab'){state.current=selected;await save();return {selected:String(selected)};}
      if(cancelled.has(state.current))throw Error('Debugger attachment cancelled by user');
      if (!attached.has(state.current)) { await chrome.debugger.attach({tabId:state.current},'1.3'); attached.add(state.current); }
      const call=(method,params={})=>debuggerCommand(state.current,method,params,request.deadline,state.owned.includes(state.current)?state.windowId:undefined);
      const result=await pageOperation(call, ['viewer',JSON.stringify(viewerAction)], {owned:state.owned.includes(state.current),dialog:dialogs.get(state.current)||null});
      if(viewerAction.type==='frame'){
        const tabs=[];for(const id of [...state.owned,...state.borrowed])try{const t=await chrome.tabs.get(id);tabs.push({id:String(id),title:t.title,url:t.url});}catch{}
        return {...result,tabs,current:String(state.current),dialog:dialogs.get(state.current)||null};
      }
      return result;
    }
    else throw Error('Unsupported relay thread control');
    await save(); return { ok: true };
  }
  if (command === 'close') {
    if (state.paused) return { ok: true, held: true };
    // Discovery never creates ownership. Borrowed personal tabs are detached, never closed.
    for (const id of [...state.owned]) { try { await chrome.tabs.remove(id); } catch { try { await chrome.tabs.get(id); throw Error('Owned tab remains open'); } catch (error) { if (error.message === 'Owned tab remains open') throw error; } } state.owned = state.owned.filter(value => value !== id); await save(); }
    for (const id of state.borrowed) if (attached.has(id)) await chrome.debugger.detach({ tabId: id }).catch(() => {});
    for (const [key, lease] of leases) if (lease.threadId === request.threadId) leases.delete(key);
    sessions.delete(request.threadId); await save(); return { ok: true };
  }
  if (state.paused) throw Error('This thread is paused for manual input');
  if(request.deadline-Date.now()<1000)throw Error('Operation deadline reached; no input sent');
  if (command === 'doctor') return { connected: true, protocol: 1, installation, run, host: 'regular profile (desktop compute)', authentication: 'shared regular-profile storage', owned: state.owned.length, borrowed: state.borrowed.length, ownedWindow:state.windowId,targetWindow:state.current?(await chrome.tabs.get(state.current)).windowId:null,dialog: dialogs.get(state.current) || null,debuggerTarget:attached.has(state.current)?await chrome.debugger.sendCommand({tabId:state.current},'Target.getTargetInfo'):null };
  if (command === 'identity' && args[0] === 'lease') {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(args[1] || '')) throw Error('Use identity lease <account-name> [comma-separated-domains]');
    const domains=(args[2]||'').split(',').filter(Boolean);if(domains.length>64)throw Error('At most 64 account domains are allowed');
    await claimLeases(['account:'+args[1],...domains.map(domain=>'origin:'+new URL('https://'+domain).hostname)],request.threadId);
    state.account = args[1]; await save(); return {leased:args[1],expiresInSeconds:900};
  }
  if (command === 'tab' && args[0] === 'borrow') {
    const id = Number(args[1]); if (!Number.isSafeInteger(id)) throw Error('Explicit tab ID required to borrow a personal tab');
    if ([...sessions.entries()].some(([thread, s]) => thread !== request.threadId && [...s.owned, ...s.borrowed].includes(id))) throw Error('Tab is leased by another thread');
    await chrome.tabs.get(id); state.borrowed.push(id); state.current = id; await save(); return { borrowed: id, authentication: 'shared regular profile' };
  }
  if (command === 'tab' && args[0] === 'list') {
    const tabs = []; for (const id of [...state.owned, ...state.borrowed]) { try { const t = await chrome.tabs.get(id); tabs.push({ id, title: t.title, url: t.url, owned: state.owned.includes(id) }); } catch {} } return { tabs };
  }
  if (command === 'tab' && args[0] === 'discover') return { tabs: (await chrome.tabs.query({})).map(t => ({ id: t.id, title: t.title, url: t.url })), notice: 'Discovery does not claim or group tabs. Borrow only with explicit user intent.' };
  if (command === 'tab' && args[0] && args[0] !== 'new') {
    const id = Number(args[0]); if (![...state.owned, ...state.borrowed].includes(id)) throw Error('Target does not belong to this thread'); state.current = id; await save(); return { selected: id };
  }
  if (!state.current || command === 'tab' && args[0] === 'new') {
    let tab;
    try {
      if (!state.windowId) { const window = await chrome.windows.create({ url: 'about:blank', focused: false, type: 'normal' }); state.windowId = window.id; tab = window.tabs[0]; }
      else tab = await chrome.tabs.create({ windowId: state.windowId, url: 'about:blank', active: false });
      if (Date.now() > request.deadline || socket?.readyState !== WebSocket.OPEN) { await chrome.tabs.remove(tab.id); throw Error('Late open cleaned up; no ownerless tab retained'); }
      state.owned.push(tab.id); state.current = tab.id; await save(); await group(state, tab.id, state.label); await save();
    } catch (error) { if (tab && !state.owned.includes(tab.id)) await chrome.tabs.remove(tab.id).catch(() => {}); throw error; }
  }
  const id = state.current;
  if (![...state.owned, ...state.borrowed].includes(id)) throw Error('Unauthorized target');
  if (cancelled.has(id)) throw Error('Debugger attachment cancelled by user; explicit new session required');
  if (!attached.has(id)) { await chrome.debugger.attach({ tabId: id }, '1.3'); attached.add(id); }
  const call=(method,params={})=>debuggerCommand(id,method,params,request.deadline,state.owned.includes(id)?state.windowId:undefined);
  await call('Page.enable');
  // Remove an old decorator without changing any website-owned title content.
  if (state.owned.includes(id)) await call('Runtime.evaluate', { expression: "{const old=globalThis.__bbBrowserThreadTitle;if(old){old.observer.disconnect();if(document.title.startsWith(old.prefix))document.title=document.title.slice(old.prefix.length);delete globalThis.__bbBrowserThreadTitle;}}" });
  return pageOperation(call, command === 'tab' ? ['open', args[1] || 'about:blank'] : request.argv, { owned: state.owned.includes(id), dialog: dialogs.get(id) || null });
}

async function connect() {
  const { serverUrl, token } = await chrome.storage.local.get(['serverUrl', 'token']);
  if (!serverUrl || !token || [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket?.readyState)) return;
  const url = new URL('/api/v1/plugins/browser/http/relay', serverUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const connection = new WebSocket(url);
  socket = connection;
  connection.onopen = () => connection.send(JSON.stringify({ token, installation, run, protocol: 1 }));
  connection.onmessage = event => { const request = JSON.parse(event.data); serial = serial.then(async () => { try { const result = await execute(request); if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ id: request.id, result })); } catch (error) { if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ id: request.id, error: error.message })); } }); };
  connection.onclose = () => { if (socket !== connection) return; for (const id of attached) void chrome.debugger.detach({ tabId: id }).catch(() => {}); attached.clear(); };
}
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'cookie-sync') void connect(); });
chrome.runtime.onMessage.addListener(message => { if (message?.type === 'sync') void connect(); });
async function initialize() {
  const local = await chrome.storage.local.get('browserInstallation'), session = await chrome.storage.session.get(['browserRun','threadSessions','identityLeases','groupOptOut']);
  installation = local.browserInstallation || crypto.randomUUID(); run = session.browserRun || crypto.randomUUID();
  await chrome.storage.local.set({browserInstallation:installation}); await chrome.storage.session.set({browserRun:run});
  for (const [id,state] of Object.entries(session.threadSessions || {})) sessions.set(id,state);
  for (const [key,lease] of Object.entries(session.identityLeases || {})) if(lease.expires>Date.now())leases.set(key,lease);
  for(const id of session.groupOptOut||[])optOut.add(id);
  await connect();
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.token || changes.serverUrl)) {
    for (const id of attached) void chrome.debugger.detach({tabId:id}).catch(() => {});
    attached.clear(); socket?.close(); socket = undefined; void initialization.then(connect);
  }
});
const initialization=initialize();
void initialization;
