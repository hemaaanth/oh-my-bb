import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.useRealTimers());
async function worker() {
  vi.useFakeTimers();
  const handlers: Record<string, (...args: any[]) => unknown> = {};
  const listener = (name: string) => ({ addListener: (callback: (...args: any[]) => unknown) => { handlers[name] = callback; } });
  const getAll = vi.fn(async () => [{ name: "sid", value: "private" }]);
  const saved: Record<string, any> = { serverUrl: "https://bb.example.test", token: "paired-token" };
  const request = vi.fn(async () => ({ ok: true, json: async () => ({ cookies: 1, skippedPartitioned: 0 }) }));
  const chrome = {
    runtime: { onMessage: listener("message"), onStartup: listener("startup"), onInstalled: listener("installed"), openOptionsPage: vi.fn() },
    storage: { local: { get: vi.fn(async () => saved), set: vi.fn(async (values) => Object.assign(saved, values)) } },
    cookies: { getAll, onChanged: listener("change") },
    action: { onClicked: listener("click"), setBadgeText: vi.fn(), setTitle: vi.fn() },
    alarms: { create: vi.fn(), onAlarm: listener("alarm") },
  };
  runInNewContext((await readFile("browser-extension/background.js", "utf8")).replace('import { relayStatus } from "./relay.js";', "const relayStatus = () => 'connected';"), { chrome, setTimeout, fetch: request, AbortSignal });
  return { handlers, request, getAll, chrome, saved };
}
it("exports only the ordinary store, debounces changes, and refreshes every minute", async () => {
  const { handlers, request, getAll, chrome } = await worker();
  for (let i = 0; i < 20; i++) handlers.change({});
  await vi.advanceTimersByTimeAsync(1000);
  expect(getAll).toHaveBeenCalledWith({ storeId: "0" });
  expect(request).toHaveBeenCalledTimes(1);
  expect(chrome.alarms.create).toHaveBeenCalledWith("cookie-sync", { periodInMinutes: 1 });
  handlers.alarm({ name: "cookie-sync" }); await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(2);
});
it("retries failures on the next alarm and reports skipped partitions", async () => {
  const { handlers, request, chrome } = await worker();
  request.mockRejectedValueOnce(new Error("offline"));
  handlers.alarm({ name: "cookie-sync" }); await vi.advanceTimersByTimeAsync(0);
  expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: "!" });
  request.mockResolvedValueOnce({ ok: true, json: async () => ({ cookies: 5, skippedPartitioned: 2 }) });
  handlers.alarm({ name: "cookie-sync" }); await vi.advanceTimersByTimeAsync(0);
  expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: "P" });
});
it("never sends cookies when no connection exists", async () => {
  const { handlers, saved, request, chrome } = await worker();
  saved.token = "";

  handlers.alarm({ name: "cookie-sync" }); await vi.advanceTimersByTimeAsync(0);
  expect(request).not.toHaveBeenCalled();
});

it("reports real sync results without exposing credentials and clears the badge when export is off", async () => {
  const {handlers,saved,chrome,request} = await worker();
  handlers.alarm({name:"cookie-sync"}); await vi.advanceTimersByTimeAsync(0);
  expect(saved).toMatchObject({syncState:"synced",cookieCount:1});
  const respond = vi.fn();
  expect(handlers.message({type:"status"},null,respond)).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({paired:true,relay:"connected",cookieCount:1}));
  expect(JSON.stringify(respond.mock.calls)).not.toContain(saved.token);
  request.mockRejectedValueOnce(new Error("secret transport failure"));
  handlers.alarm({name:"cookie-sync"}); await vi.advanceTimersByTimeAsync(0);
  expect(saved.syncState).toBe("error");
  expect(saved.cookieCount).toBe(1);
  saved.cookieExport=false;
  handlers.alarm({name:"cookie-sync"}); await vi.advanceTimersByTimeAsync(0);
  expect(saved.syncState).toBe("off");
  expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({text:""});
});
