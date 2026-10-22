// Authentication seeds are explicit, bounded data; never execute source-site code to install them.
const LIMIT = 2 * 1024 * 1024;
const canonical = value => JSON.stringify(value, function(_key, item) { return item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item; });
export function validateState(state) {
  const fail = () => { throw Error('Unsupported login storage. Use manual login.'); };
  if (!state || Buffer.byteLength(JSON.stringify(state)) > LIMIT) fail();
  if (!Array.isArray(state.cookies || []) || !Array.isArray(state.origins || []) || (state.origins || []).length > 16) fail();
  for (const cookie of state.cookies || []) if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string' || typeof cookie.domain !== 'string' || typeof cookie.path !== 'string') fail();
  const seen = new Set();
  for (const origin of state.origins || []) {
    let url; try { url = new URL(origin.origin); } catch { fail(); }
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin.origin || seen.has(origin.origin)) fail();
    seen.add(origin.origin);
    if (!Array.isArray(origin.localStorage || []) || (origin.localStorage || []).some(e => typeof e.name !== 'string' || typeof e.value !== 'string')) fail();
    if (!Array.isArray(origin.indexedDB || []) || (origin.indexedDB || []).length > 8) fail();
    const databases = new Set();
    for (const db of origin.indexedDB || []) {
      if (typeof db.name !== 'string' || !db.name || databases.has(db.name) || !Number.isSafeInteger(db.version) || db.version < 1 || !Array.isArray(db.stores) || db.stores.length > 32) fail();
      databases.add(db.name); const stores = new Set();
      for (const store of db.stores) {
        const path = p => p === null || typeof p === 'string' || Array.isArray(p) && p.every(k => typeof k === 'string');
        if (typeof store.name !== 'string' || stores.has(store.name) || !path(store.keyPath) || store.autoIncrement || !Array.isArray(store.entries) || store.entries.length > 1000 || !Array.isArray(store.indexes) || store.indexes.length > 32) fail();
        stores.add(store.name);
        for (const entry of store.entries) if (!entry || !Object.hasOwn(entry,'key') || !Object.hasOwn(entry,'value')) fail();
        for (const index of store.indexes) if (typeof index.name !== 'string' || !path(index.keyPath) || index.keyPath === null || typeof index.unique !== 'boolean' || typeof index.multiEntry !== 'boolean') fail();
      }
    }
  }
  if (!Array.isArray(state.accountChecks || []) || (state.accountChecks || []).length > 8) fail();
  for (const check of state.accountChecks || []) {
    let url; try { url = new URL(check.url); } catch { fail(); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || typeof check.selector !== 'string' || !check.selector || check.selector.length > 512 || typeof check.expected !== 'string' || !check.expected || check.expected.length > 512) fail();
  }
  return state;
}

// Serialized into the inert page. Only JSON values and string/number/array keys are portable.
export async function databaseState(mode, databases) {
  const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(Error('Login database operation failed')); });
  const done = t => new Promise((resolve, reject) => { t.oncomplete = resolve; t.onabort = t.onerror = () => reject(Error('Login database transaction failed')); });
  const portable = value => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return true;
    if (Array.isArray(value)) return value.every(portable);
    return !!value && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(portable);
  };
  const output = [];
  for (const spec of databases) {
    let db;
    const opening = indexedDB.open(spec.name, ...(mode === 'restore' ? [spec.version] : []));
    opening.onblocked = () => {}; // The enclosing CDP evaluation has a deadline.
    opening.onupgradeneeded = event => {
      db = opening.result;
      if (mode !== 'restore' || event.oldVersion !== 0) { opening.transaction.abort(); return; }
      for (const store of spec.stores) {
        const object = db.createObjectStore(store.name, { keyPath: store.keyPath });
        for (const index of store.indexes) object.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
      }
    };
    db = await request(opening);
    try {
      const captured = { name: db.name, version: db.version, stores: [] };
      if (mode === 'restore' && JSON.stringify([...db.objectStoreNames].sort()) !== JSON.stringify(spec.stores.map(s => s.name).sort())) throw Error('Login database schema differs');
      if (!db.objectStoreNames.length) { output.push(captured); continue; }
      const tx = db.transaction([...db.objectStoreNames], mode === 'restore' ? 'readwrite' : 'readonly'), finished = done(tx);
      // Handle rejection even when validation throws before awaiting the transaction.
      finished.catch(() => {});
      const reads = [];
      try {
      for (const name of db.objectStoreNames) {
        const store = tx.objectStore(name);
        if (store.autoIncrement) throw Error('Auto-increment login databases are unsupported');
        if (mode === 'restore') {
          const source = spec.stores.find(s => s.name === name);
          const indexes = [...store.indexNames].map(n => { const i = store.index(n); return {name:n,keyPath:i.keyPath,unique:i.unique,multiEntry:i.multiEntry}; });
          if (JSON.stringify(store.keyPath) !== JSON.stringify(source.keyPath) || indexes.length !== source.indexes.length || indexes.some(i=>!source.indexes.some(s=>s.name===i.name&&JSON.stringify(s.keyPath)===JSON.stringify(i.keyPath)&&s.unique===i.unique&&s.multiEntry===i.multiEntry))) throw Error('Login database schema differs');
          store.clear();
          for (const entry of source.entries) store.keyPath === null ? store.put(entry.value, entry.key) : store.put(entry.value);
        }
        // A limit+1 read detects oversize stores without unbounded getAll().
        const keys = request(store.getAllKeys(null, 1001)), values = request(store.getAll(null, 1001));
        reads.push(Promise.all([keys, values]).then(([keys, values]) => {
          if (keys.length > 1000 || !portable(keys) || !portable(values)) throw Error('Unsupported or oversized login database');
          captured.stores.push({name,keyPath:store.keyPath,autoIncrement:false,indexes:[...store.indexNames].map(n=>{const i=store.index(n);return {name:n,keyPath:i.keyPath,unique:i.unique,multiEntry:i.multiEntry};}),entries:keys.map((key,i)=>({key,value:values[i]}))});
        }));
      }
      await Promise.all(reads); await finished;
      } catch(error) { try { tx.abort(); } catch {} throw error; }
      if (JSON.stringify(captured).length > 2 * 1024 * 1024) throw Error('Login database is too large');
      output.push(captured);
    } finally { db.close(); }
  }
  return output;
}

export async function importState(call, subscribe, raw) {
  const state = validateState(raw);
  const target = await call('Target.createTarget', { url: 'about:blank', background: true });
  let unsubscribe = () => {};
  try {
    const { sessionId } = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const page = (method, params = {}) => call(method, params, sessionId);
    let interceptError;
    unsubscribe = subscribe(message => {
      if (message.sessionId !== sessionId || message.method !== 'Fetch.requestPaused') return;
      void page('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }, { name: 'Content-Security-Policy', value: "default-src 'none'; script-src 'unsafe-eval'" }], body: Buffer.from('<!doctype html><title>Login storage import</title>').toString('base64') }).catch(() => { interceptError = Error('Login storage import was interrupted. Use manual login.'); });
    });
    await page('Page.enable');
    await page('Network.setBypassServiceWorker', { bypass: true });
    await page('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await page('DOMStorage.enable');
    for (const origin of state.origins || []) {
      const nav = await page('Page.navigate', { url: origin.origin });
      if (nav.errorText) throw Error('Cannot prepare login storage. Use manual login.');
      let ready = false;
      for (let i = 0; i < 50; i++) {
        const result = await page('Runtime.evaluate', {expression:'location.origin',returnByValue:true});
        if (result.result?.value === origin.origin) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!ready || interceptError) throw Error('Cannot prepare login storage. Use manual login.');
      const storageId = { securityOrigin: origin.origin, isLocalStorage: true };
      for (const item of origin.localStorage || []) await page('DOMStorage.setDOMStorageItem', { storageId, key: item.name, value: item.value });
      const stored = new Map((await page('DOMStorage.getDOMStorageItems', { storageId })).entries);
      if ((origin.localStorage || []).some(item => stored.get(item.name) !== item.value)) throw Error('Login storage verification failed. Use manual login.');
      if (origin.indexedDB?.length) {
        const result = await page('Runtime.evaluate', { expression: `(${databaseState.toString()})('restore',JSON.parse(${JSON.stringify(JSON.stringify(origin.indexedDB))}))`, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails || canonical(result.result?.value) !== canonical(origin.indexedDB)) throw Error('Login database verification failed. Use manual login.');
      }
    }
    if (interceptError) throw interceptError;
    // Apply cookies only after the selected storage passes verification.
    if (state.cookies?.length) await call('Storage.setCookies', {cookies:state.cookies.map(({expires,...cookie})=>({...cookie,...(expires>0?{expires}:{})}))});
    if (state.cookies?.length) {
      const stored = (await call('Storage.getCookies')).cookies;
      if (state.cookies.some(cookie => !stored.some(item => item.name === cookie.name && item.value === cookie.value && item.domain.replace(/^\./,'') === cookie.domain.replace(/^\./,'') && item.path === cookie.path && canonical(item.partitionKey) === canonical(cookie.partitionKey)))) throw Error('Login cookie verification failed. Use manual login.');
    }
  } finally { unsubscribe(); await call('Target.closeTarget', { targetId: target.targetId }); }
}

export async function verifyAccount(page, checks) {
  for (const check of checks || []) {
    const nav = await page('Page.navigate', { url: check.url });
    if (nav.errorText) throw Error('Cannot verify the signed-in account. Use manual login.');
    let matched = false;
    for (let i = 0; i < 50; i++) {
      const result = await page('Runtime.evaluate', { expression: `(()=>{const e=document.querySelector(${JSON.stringify(check.selector)});return location.origin===${JSON.stringify(new URL(check.url).origin)}&&!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility==='visible'&&e.innerText.trim()===${JSON.stringify(check.expected)}})()`, returnByValue: true });
      if (result.result?.value === true) { matched = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!matched) throw Error('Signed-in account could not be verified. Check the account or use manual login.');
  }
}
