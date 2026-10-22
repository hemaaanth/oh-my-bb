const server = document.querySelector("#server");
const code = document.querySelector("#code");
const status = document.querySelector("#status");
const submit = document.querySelector('button[type="submit"]');
const cookieExport = document.querySelector("#export");
if (cookieExport) {
  chrome.storage.local.get("cookieExport").then(saved => { cookieExport.checked = saved.cookieExport === true; });
  cookieExport.addEventListener("change", async () => { await chrome.storage.local.set({cookieExport:cookieExport.checked}); await chrome.runtime.sendMessage({type:"sync"}); });
}

chrome.storage.local.get(["serverUrl", "token"]).then((saved) => {
  server.value = saved.serverUrl || "";
  status.textContent = saved.token ? "Paired. Open the extension popup for live status." : "Not connected.";
});

document.querySelector("#pair").addEventListener("submit", async (event) => {
  event.preventDefault();
  submit.disabled = true;
  status.textContent = "Connecting…";
  try {
    const url = new URL(server.value.trim());
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("Use the BB server's base address.");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Use HTTPS, or HTTP on localhost for BB on this computer.");
    const serverUrl = url.origin;
    const response = await fetch(`${serverUrl}/api/v1/plugins/browser/http/cookie-sync/pair`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "omit", redirect: "error", signal: AbortSignal.timeout(15000), body: JSON.stringify({ code: code.value.trim() }),
    });
    if (!response.ok) throw new Error("Pairing failed. Generate a new code in BB and check the address.");
    const result = await response.json();
    if (typeof result.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.token)) throw new Error("BB returned an invalid connection.");
    await chrome.storage.local.set({ serverUrl, token: result.token, cookieExport: false });
    if (cookieExport) cookieExport.checked = false;
    code.value = "";
    await chrome.runtime.sendMessage({ type: "sync" });
    status.textContent = "Connected. Relay uses this profile. Cookie export is off until explicitly enabled.";
  } catch (error) {
    status.textContent = error instanceof TypeError ? "Could not reach BB. Check its address and connection." : error.message;
  } finally { submit.disabled = false; }
});

document.querySelector("#disconnect").addEventListener("click", async () => {
  await chrome.storage.local.remove(["serverUrl", "token", "lastSyncAt", "cookieCount", "skippedPartitioned", "syncState"]);
  await chrome.storage.local.set({cookieExport:false});
  if (cookieExport) cookieExport.checked = false;
  code.value = "";
  status.textContent = "Disconnected on this browser. You can also revoke the connection in BB Settings.";
});
