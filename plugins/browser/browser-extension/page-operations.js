// Observations contain untrusted page content. Handles identify observed DOM nodes, not selectors.
export function observePage(delta = false) {
  const old = globalThis.__bbObservation;
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.visibility !== 'hidden' && s.display !== 'none'; };
  const nodes = [...document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="checkbox"],[role="option"],[contenteditable="true"]')].filter(visible).slice(0, 120);
  const describe = el => ({ tag: el.tagName.toLowerCase(), type: el.type || el.getAttribute('role') || '', name: (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 160), value: el.type === 'password' ? undefined : String(el.value ?? '').slice(0, 160), checked: !!el.checked, disabled: !!el.disabled, options: el.tagName === 'SELECT' ? [...el.options].slice(0, 40).map(o => ({ value: o.value, text: o.text })) : undefined });
  const readContext = () => {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT); const parts = []; let text, count = 0, length = 0;
    while ((text = walker.nextNode()) && count++ < 4000 && length < 5000) { if (!text.textContent.trim() || !visible(text.parentElement)) continue; const range = document.createRange(); range.selectNodeContents(text); const r = range.getBoundingClientRect(); if (r.bottom <= 0 || r.top >= innerHeight) continue; const value = text.textContent.replace(/\s+/g, ' ').trim(); parts.push(value); length += value.length; }
    return parts.join(' ').slice(0, 5000);
  };
  const context = readContext();
  const revision = crypto.randomUUID();
  const rows = nodes.map((el, index) => ({ id: 'e' + index, ...describe(el) }));
  const semantic = JSON.stringify({ url: location.href, context, rows });
  globalThis.__bbObservation = { revision, nodes, describe, visible, readContext, semantic, context, url: location.href, rows, consumed: false, document };
  if (delta && old && old.document === document) {
    const changed = rows.filter((row, index) => JSON.stringify(row) !== JSON.stringify(old.rows[index]));
    const diff = { kind: 'delta', baseRevision: old.revision, revision, url: location.href, text: old.context === context ? undefined : context, changed, removed: old.rows.slice(rows.length).map(row => row.id), unchanged: rows.length - changed.length };
    if (JSON.stringify(diff).length < JSON.stringify(rows).length + context.length) return diff;
  }
  return { kind: 'full', revision, url: location.href, title: document.title, text: context, controls: rows, truncated: nodes.length === 120 };
}

export function guardPage(action) {
  const o = globalThis.__bbObservation;
  if (!o || o.consumed || action.revision !== o.revision || o.document !== document) throw Error('Observation expired or already consumed; observe again');
  const index = /^e(\d+)$/.exec(action.target || '')?.[1];
  const node = index === undefined ? null : o.nodes[Number(index)];
  if (!node?.isConnected || !o.visible(node)) throw Error('Observed target no longer exists or is not visible');
  if (o.nodes.some(el => !el.isConnected)) throw Error('Observed controls were replaced; observe again');
  const rows = o.nodes.map((el, i) => ({ id: 'e' + i, ...o.describe(el) }));
  const context = o.readContext();
  if (JSON.stringify({ url: location.href, context, rows }) !== o.semantic) {const changed=rows.filter((row,index)=>JSON.stringify(row)!==JSON.stringify(o.rows[index])).map(row=>row.id);throw Error('Page changed; observe again (url='+String(location.href!==o.url)+', visible text='+String(context!==o.context)+', controls='+changed.join(',')+')');}
  if (node.disabled || node.getAttribute('aria-disabled') === 'true') throw Error('Observed control is disabled');
  const rect = node.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  const top = document.elementFromPoint(x, y);
  if (!top || !(node === top || node.contains(top))) throw Error('Observed target is covered; inspect before acting');
  if (!['click', 'fill', 'select', 'check'].includes(action.operation)) throw Error('Unsupported guarded operation');
  if (action.operation === 'fill' && !node.matches('input:not([type=password]):not([type=checkbox]):not([type=radio]),textarea,[contenteditable=true]')) throw Error('Not an observed text control; password entry needs manual handoff');
  if (action.operation === 'select' && (node.tagName !== 'SELECT' || !o.rows[Number(index)].options.some(option => option.value === action.value))) throw Error('Option was not observed');
  if (action.operation === 'check' && !node.matches('input[type=checkbox],input[type=radio]')) throw Error('Not a checkable control');
  o.consumed = true; // Consume before any input; uncertain transport results must never replay it.
  if (action.operation === 'fill') {
    node.focus({ preventScroll: true });
    if (node.isContentEditable) node.textContent = String(action.value ?? '');
    else { const setter = Object.getOwnPropertyDescriptor(node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set; setter.call(node, String(action.value ?? '')); }
    node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (action.operation === 'select') { node.value = action.value; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); }
  else if (action.operation === 'check') { if (node.checked !== !!action.value) node.click(); }
  else node.click();
  return { performed: action.operation, target: action.target, consumed: true, verify: 'Take a fresh observation and check the requested outcome' };
}

export async function pageOperation(call, argv, { owned = true, dialog = null } = {}) {
  const [command, ...args] = argv;
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.text + ': ' + (result.exceptionDetails.exception?.description || 'page evaluation failed'));
    return result.result?.value;
  };
  if (owned && command !== 'dialog' && !dialog) await call('Emulation.setFocusEmulationEnabled', { enabled: true });
  if (command === 'viewer') {
    const action = JSON.parse(args.join(' '));
    if (action.type === 'frame') return dialog?{data:'',dialog}:pageOperation(call, ['screenshot'], {owned:false});
    if(action.type==='scroll'){if(!Number.isFinite(action.deltaY)||Math.abs(action.deltaY)>1000)throw Error('Invalid viewer scroll');return call('Input.dispatchMouseEvent',{type:'mouseWheel',x:100,y:100,deltaX:0,deltaY:action.deltaY});}
    if(action.type==='dialog'){if(!dialog)throw Error('No pending JavaScript dialog');return call('Page.handleJavaScriptDialog',{accept:!!action.accept,promptText:String(action.promptText||'').slice(0,4096)});}
    if (action.type === 'text') return call('Input.insertText', {text:String(action.text || '').slice(0,4096)});
    if (action.type === 'key') {if(action.modifiers?.length)throw Error('Keyboard shortcuts require a private desktop viewer');return pageOperation(call, ['press',String(action.key || '').slice(0,40)], {owned:false});}
    if (action.type !== 'pointer' || !['up','down','move'].includes(action.event) || !Number.isFinite(action.x) || !Number.isFinite(action.y) || action.x < 0 || action.x > 16384 || action.y < 0 || action.y > 16384) throw Error('Invalid viewer input');
    return call('Input.dispatchMouseEvent', {type:action.event === 'move' ? 'mouseMoved' : action.event === 'up' ? 'mouseReleased' : 'mousePressed',x:action.x,y:action.y,button:'left',clickCount:1});
  }
  if (command === 'observe') return evaluate('(' + observePage + ')(' + JSON.stringify(args.includes('--delta')) + ')');
  if (command === 'act') return evaluate('(' + guardPage + ')(' + JSON.stringify(JSON.parse(args.join(' '))) + ')');
  if (command === 'eval') return evaluate(args.join(' '));
  if (command === 'snapshot' || command === 'read') {
    if (command === 'read') return evaluate('document.body.innerText.slice(0,32000)');
    const result = await call('Accessibility.getFullAXTree');
    return result.nodes.filter(n => !n.ignored).slice(0, 500).map(n => ({ role: n.role?.value, name: n.name?.value, value: n.role?.value === 'textbox' && n.properties?.some(p => p.name === 'protected' && p.value?.value) ? undefined : n.value?.value }));
  }
  if (['open', 'goto', 'navigate'].includes(command)) {
    const url = new URL(args[0]); if (!['http:', 'https:', 'about:', 'data:'].includes(url.protocol)) throw Error('Unsupported navigation scheme');
    const result = await call('Page.navigate', { url: url.href }); if (result.errorText) throw Error(result.errorText); return { url: url.href };
  }
  if (command === 'reload') return call('Page.reload');
  if (command === 'dialog') {
    if (!args[0] || args[0] === 'inspect') return { pending: dialog };
    if (!['accept', 'dismiss'].includes(args[0])) throw Error('Use dialog inspect|accept|dismiss [prompt text]');
    if (!dialog) throw Error('No pending JavaScript dialog');
    return call('Page.handleJavaScriptDialog', { accept: args[0] === 'accept', promptText: args[1] || '' });
  }
  if (command === 'screenshot') {
    // OMP whileDrawing technique (MIT; see THIRD-PARTY-NOTICES): no activation or visibility override.
    const scaleIndex = args.indexOf('--scale');
    const scale = scaleIndex < 0 ? 1 : Number(args[scaleIndex + 1]);
    if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw Error('Screenshot scale must be between 1 and 4');
    const full = args.includes('--full');
    if (full && scaleIndex >= 0) throw Error('Screenshot scale cannot be combined with full-page capture');
    try {
      await call('Page.startScreencast',{format:'jpeg',quality:1,maxWidth:1,maxHeight:1});
      const options = {format:'png',captureBeyondViewport:full};
      if (scale !== 1) {
        const metrics = await call('Page.getLayoutMetrics');
        const viewport = metrics.cssVisualViewport || metrics.visualViewport;
        if (!viewport?.clientWidth || !viewport?.clientHeight) throw Error('Screenshot viewport is unavailable');
        options.clip = {x:0,y:0,width:viewport.clientWidth,height:viewport.clientHeight,scale};
      }
      return await call('Page.captureScreenshot',options);
    }
    finally{await call('Page.stopScreencast').catch(()=>{});}
  }
  if (command === 'press' || command === 'key') { await call('Input.dispatchKeyEvent', { type: 'keyDown', key: args[0] }); await call('Input.dispatchKeyEvent', { type: 'keyUp', key: args[0] }); return { key: args[0] }; }
  if (command === 'scroll') return call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 100, y: 100, deltaX: 0, deltaY: (args[0] === 'up' ? -1 : 1) * Math.min(Number(args[1]) || 500, 10000) });
  if (['click', 'fill', 'type', 'hover', 'check', 'uncheck', 'select', 'focus'].includes(command)) {
    const selector = args[0];
    const point = await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw Error('No matching control'); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); const top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); if(!r.width||!r.height||!(top===e||e.contains(top))) throw Error('Control is hidden or covered'); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    if (command === 'hover') return call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    if (command === 'fill' || command === 'type') { await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus({preventScroll:true})`); if (command === 'fill') await evaluate(`document.querySelector(${JSON.stringify(selector)}).value=''`); return call('Input.insertText', { text: args[1] || '' }); }
    if (command === 'focus') return evaluate(`document.querySelector(${JSON.stringify(selector)}).focus({preventScroll:true})`);
    if (command === 'select') return evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(args[1])};e.dispatchEvent(new Event('change',{bubbles:true}));return e.value;})()`);
    if (command === 'check' || command === 'uncheck') { const checked = await evaluate(`document.querySelector(${JSON.stringify(selector)}).checked`); if (checked === (command === 'check')) return { checked }; }
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }); return { clicked: true };
  }
  throw Error('Unsupported relay command; use observe/act, snapshot, eval, screenshot, navigation or an isolated session for the general agent-browser engine');
}
