const health = document.querySelector('#health'), dot = document.querySelector('#dot');
const sync = document.querySelector('#sync'), detail = document.querySelector('#detail');
async function refresh() {
  try {
    const state = await chrome.runtime.sendMessage({type:'status'});
    const exporting = state.paired && state.cookieExport;
    document.querySelector('#relay').textContent = state.relay === 'connected' ? 'Connected' : state.relay === 'connecting' ? 'Connecting…' : state.paired ? 'Disconnected' : 'Not paired';
    document.querySelector('#export').textContent = exporting ? state.syncState === 'syncing' ? 'Syncing…' : state.syncState === 'error' ? 'Sync failed' : 'On · every minute' : 'Off';
    document.querySelector('#last').textContent = state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}) : 'Never';
    sync.disabled = !exporting || state.syncState === 'syncing';
    const failed = state.paired && (state.relay === 'disconnected' || exporting && state.syncState === 'error');
    health.textContent = !state.paired ? 'Not paired' : failed ? 'Needs attention' : state.relay === 'connecting' ? 'Connecting…' : 'Connected to BB';
    dot.dataset.tone = failed ? 'warn' : state.relay === 'connected' ? 'good' : '';
    detail.textContent = !state.paired ? 'Pair in Settings for relay or cookie export. Managed tab groups work without pairing.' : failed ? 'Check that BB is running and this connection is still paired.' : exporting && state.lastSyncAt ? `${state.cookieCount || 0} cookies exported${state.skippedPartitioned ? ` · ${state.skippedPartitioned} partitioned cookies skipped` : ''}.` : 'Cookie export is optional. Manage it in Settings.';
  } catch {
    health.textContent = 'Extension unavailable'; dot.dataset.tone = 'warn'; sync.disabled = true;
    detail.textContent = 'Reload the extension in brave://extensions.';
  }
}
sync.addEventListener('click', async () => {
  sync.disabled = true;
  try { await chrome.runtime.sendMessage({type:'sync'}); } catch {} finally { await refresh(); }
});
document.querySelector('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
void refresh();
setInterval(refresh, 2000);
