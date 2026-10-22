import { relayStatus } from "./relay.js";
let timer;
let pending = false;
let dirty = false;

async function sync() {
  dirty = true;
  if (pending) return;
  pending = true;
  dirty = false;
  try {
    const { serverUrl, token, cookieExport } = await chrome.storage.local.get(["serverUrl", "token", "cookieExport"]);
    if (!serverUrl || !token) {
      chrome.action.setBadgeText({ text: "?" });
      chrome.action.setTitle({ title: "BB Browser · Not paired" });
      await chrome.storage.local.set({syncState:"unpaired"});
      return;
    }
    if (cookieExport === false) {
      await chrome.storage.local.set({syncState:"off"});
      chrome.action.setBadgeText({text:""});
      chrome.action.setTitle({title:"BB Browser · Cookie export off"});
      return;
    }
    await chrome.storage.local.set({syncState:"syncing"});
    const cookies = await chrome.cookies.getAll({ storeId: "0" });
    const response = await fetch(`${serverUrl}/api/v1/plugins/browser/http/cookie-sync/snapshot`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      credentials: "omit", redirect: "error", signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ cookies }),
    });
    if (!response.ok) throw new Error("Sync failed");
    const result = await response.json();
    await chrome.storage.local.set({syncState:"synced",lastSyncAt:Date.now(),cookieCount:result.cookies,skippedPartitioned:result.skippedPartitioned || 0});
    chrome.action.setBadgeText({ text: result.skippedPartitioned ? "P" : "" });
    chrome.action.setTitle({ title: `BB: synced ${result.cookies} cookies; skipped ${result.skippedPartitioned || 0} partitioned cookies` });
  } catch {
    await chrome.storage.local.set({syncState:"error"});
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setTitle({ title: "BB cookie sync failed; check the connection in extension options" });
  } finally {
    pending = false;
    if (dirty) schedule();
  }
}

function schedule() {
  dirty = true;
  if (!timer) timer = setTimeout(() => { timer = undefined; void sync(); }, 1000);
}

chrome.cookies.onChanged.addListener(schedule);
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "cookie-sync") void sync(); });
chrome.runtime.onStartup.addListener(() => void sync());
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") void chrome.runtime.openOptionsPage();
  void chrome.storage.local.get(["token", "cookieExport"]).then(saved => { if (saved.cookieExport === undefined) return chrome.storage.local.set({cookieExport:!!saved.token}); });
  void sync();
});
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === "sync") { void sync().then(() => respond({ok:true}), () => respond({ok:false})); return true; }
  if (message?.type === "status") {
    void chrome.storage.local.get(["token","cookieExport","syncState","lastSyncAt","cookieCount","skippedPartitioned"]).then(saved => respond({
      paired:!!saved.token, cookieExport:saved.cookieExport !== false, relay:relayStatus(), syncState:pending ? "syncing" : saved.syncState,
      lastSyncAt:saved.lastSyncAt || null, cookieCount:saved.cookieCount || 0, skippedPartitioned:saved.skippedPartitioned || 0,
    }));
    return true;
  }
});
chrome.alarms.create("cookie-sync", { periodInMinutes: 1 });
