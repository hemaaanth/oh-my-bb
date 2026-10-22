import { spawn } from "node:child_process";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { browserHandoffHostContract, browserThreadControl } from "./browser-handoff.js";
import { browserSyncHostContract, syncBrowserCookies, provisionBrowser } from "./browser-sync.js";
import { browserViewerHostContract } from "./viewer-contract.js";
import { browserTaskHostContract } from "./fast.js";

function run(threadId: string, argv: string[], signal: AbortSignal, maxBytes: number) {
  const { promise, resolve } = Promise.withResolvers<{ ok: boolean; data: string }>();
  const child = spawn("bb-browser", argv, { env: { ...process.env, BB_THREAD_ID: threadId }, stdio: ["ignore", "pipe", "ignore"], signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; if (output.length > maxBytes) child.kill(); });
  child.once("error", () => resolve({ ok: false, data: "" }));
  child.once("close", code => resolve({ ok: code === 0 && output.length <= maxBytes, data: code === 0 ? output.trim() : "" }));
  return promise;
}
export default experimental_defineHostEntry({
  contract: { ...browserHandoffHostContract, ...browserSyncHostContract, ...browserViewerHostContract, ...browserTaskHostContract },
  handlers: {
    browserThreadControl: (input, context) => browserThreadControl(input, context.signal),
    provisionBrowser: (input, context) => provisionBrowser(input.payload, context.signal),
    syncBrowserCookies: (input, context) => syncBrowserCookies(input.state, context.signal),
    browserDesktopTarget:async(input,context)=>{const result=await run(input.threadId,["thread","desktop",...(input.watch?["--watch"]:[])],context.signal,8192);if(!result.ok)return null;return JSON.parse(result.data);},
    browserViewerControl: (input, context) => run(input.threadId, ["thread", "viewer", JSON.stringify(input.action)], context.signal, 8 * 1024 * 1024),
    browserTaskStep: (input, context) => run(input.threadId, input.action.operation === "observe" ? ["observe"] : ["act", JSON.stringify(input.action)], context.signal, 128 * 1024),
  },
});
