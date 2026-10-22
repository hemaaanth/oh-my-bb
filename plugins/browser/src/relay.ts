import { randomUUID } from "node:crypto";
import type { BbPluginApi, ExperimentalPluginWebSocket } from "@get-bb/plugin-sdk";
import type { BrowserCookieConnection } from "./browser-cookie-connection.js";
import { browserExtensionOrigin } from "./browser-extension-download.js";
import type { BrowserSettings } from "./config.js";
import { fastTask } from "./fast.js";

export function registerRelay(bb: BbPluginApi, cookies: BrowserCookieConnection, settings: () => Promise<BrowserSettings>,network?:(threadId:string,held:boolean)=>Promise<unknown>) {
  let socket: ExperimentalPluginWebSocket | null = null;
  let identity: { installation: string; run: string } | null = null;
  let pairedToken = "";
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const fail = () => { socket = null; identity = null; for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error("Browser relay disconnected; inspect before retrying a mutation")); } pending.clear(); };
  bb.onDispose(() => { socket?.close(); fail(); });
  bb.http.experimental_websocket("/relay", context => {
    let authenticated = false;
    const timer = setTimeout(() => connection?.close(1008, "Pairing required"), 5000);
    let connection: ExperimentalPluginWebSocket | undefined;
    return {
      onOpen(s) { connection = s; },
      async onMessage(s, data) {
        try {
          if (typeof data !== "string" || data.length > 8 * 1024 * 1024) throw new Error("Invalid relay message");
          const message = JSON.parse(data);
          if (!authenticated) {
            if (context.headers.get("origin") !== await browserExtensionOrigin() || !await cookies.authorized(String(message.token ?? ""))) throw new Error("Pairing required");
            if (!/^[a-zA-Z0-9_-]{8,128}$/.test(message.installation) || !/^[a-zA-Z0-9_-]{8,128}$/.test(message.run) || message.protocol !== 1) throw new Error("Update BB Browser extension");
            socket?.close(1000, "Connection replaced"); fail(); socket = s; pairedToken = message.token; identity = { installation: message.installation, run: message.run }; authenticated = true; clearTimeout(timer); return;
          }
          if (socket !== s) throw new Error("Stale browser connection");
          const job = pending.get(message.id);
          if (job) { clearTimeout(job.timer); pending.delete(message.id); message.error ? job.reject(new Error(String(message.error).slice(0, 500))) : job.resolve(message.result); }
        } catch { s.close(1008, "Invalid or unauthorized relay"); }
      },
      onClose(s) { clearTimeout(timer); if (socket === s) fail(); },
    };
  }, { auth: "none" });
  bb.cli.register({ name: "browser-runtime", summary: "Internal bb-browser transport; use bb-browser", run: async (argv, context) => {
    try {
      const threadId = context.threadId;
      if (!threadId || !/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) throw new Error("bb-browser relay requires its BB thread context");
      if (argv.length !== 1 || argv[0].length > 256 * 1024) throw new Error("Invalid browser command");
      const request = JSON.parse(Buffer.from(argv[0], "base64url").toString("utf8"));
      if (!Array.isArray(request.argv) || request.argv.some((value: unknown) => typeof value !== "string")) throw new Error("Invalid command arguments");
      if(request.argv[0]==='network'){
        if(request.argv.length!==2||!['ensure','release'].includes(request.argv[1])||!network)throw Error('Sandbox network integration unavailable');
        return {exitCode:0,stdout:JSON.stringify(await network(threadId,request.argv[1]==='ensure'))+'\n'};
      }
      if (request.argv[0] === "fast") {
        if (request.argv[1] !== "--allow-model") throw new Error("Fast tasks require explicit --allow-model for this task");
        return { exitCode: 0, stdout: JSON.stringify(await fastTask(bb, await settings(), threadId, JSON.parse(request.argv.slice(2).join(" ")))) + "\n" };
      }
      if (!socket || !identity || !await cookies.authorized(pairedToken)) { socket?.close(); fail(); throw new Error("Paired browser relay unavailable or revoked. Open the updated extension in the selected regular profile."); }
      const pinned = await bb.storage.kv.get(`relay:${threadId}`);
      const key = `${identity.installation}:${identity.run}`;
      if (pinned && pinned !== key && request.argv[0] !== "close") throw new Error("Browser restarted or profile changed. Close this thread's stale relay session before opening another; no tab was selected.");
      await bb.storage.kv.set(`relay:${threadId}`, key);
      const id = randomUUID();
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Browser relay operation deadline (30s); inspect state before retrying")); }, 30_000);
      pending.set(id, { resolve, reject, timer });
      const thread = await bb.sdk.threads.get({threadId}).catch(() => null);
      socket.send(JSON.stringify({ id, threadId, label:thread?.title || threadId, argv: request.argv, deadline: Date.now() + 29_000 }));
      const result = await promise;
      if (request.argv[0] === "close") await bb.storage.kv.delete(`relay:${threadId}`);
      return { exitCode: 0, stdout: JSON.stringify(result) + "\n" };
    } catch (error) { return { exitCode: 1, stderr: `${error instanceof Error ? error.message : "Browser relay failed"}\n` }; }
  } });
}
