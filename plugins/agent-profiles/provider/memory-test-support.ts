import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { memoryHostContract, type MemoryHostContract } from "./memory-contract";
import { AgentMemoryHost } from "./memory-host";
import { createAgentMemoryService } from "../server/agent-memory";
import type { MemoryHostClient } from "../server/agent-memory";
import type { z } from "zod";
import type { PluginRpcResult } from "@get-bb/plugin-sdk";

type Input<K extends keyof MemoryHostContract> = z.input<MemoryHostContract[K]["input"]>;
type Output<K extends keyof MemoryHostContract> = PluginRpcResult<MemoryHostContract[K]>;
const methods = {
  memoryState: "state", memoryAcquire: "acquire", memoryPage: "page", memoryRead: "read", memoryRunning: "running", memoryReceive: "receive", memoryReceivePage: "receivePage", memoryWrite: "write", memoryCommit: "commit", memoryRelease: "release", memoryRemote: "remote", memoryRemotePage: "remotePage", memoryRemoteRead: "remoteRead", memoryRemoteDelete: "remoteDelete",
} as const;
export async function startMemoryFixture(root: string) {
  for (const name of ["HOME", "OPTCHAT_HOME", "PI_CODING_AGENT_DIR"] as const) if (!process.env[name] || !resolve(process.env[name]!).startsWith(`${resolve(root)}/`)) throw new Error(`Memory fixture requires isolated ${name}.`);
  if (process.env.PATH !== join(root, "empty-bin")) throw new Error("Memory fixture PATH must exclude real Pi.");
  // Match BB's layout: each plugin gets sibling host-data and bridge-data dirs per daemon.
  const hostIds = ["primary", "remote", "remote2"] as const;
  const dataDirs = Object.fromEntries(hostIds.map((id) => [id, join(root, id, "bridge-data")])) as Record<typeof hostIds[number], string>;
  const hostDataDirs = Object.fromEntries(hostIds.map((id) => [id, join(root, id, "host-data")])) as Record<typeof hostIds[number], string>;
  const hosts = new Map(Object.entries(hostDataDirs).map(([id, dataDir]) => [id, new AgentMemoryHost(dataDir)]));
  const offline = new Set<string>(), logs: string[] = [];
  let beforeCall: ((method: keyof MemoryHostContract, hostId: string) => Promise<void> | void) | undefined;
  let failWrite = false, dropCommitReply = false;
  const client: MemoryHostClient = {
    async call<K extends keyof MemoryHostContract>(method: K, input: Input<K>, options: { hostId: string }): Promise<Output<K>> {
      if (offline.has(options.hostId)) throw new Error(`Host ${options.hostId} is offline.`);
      await beforeCall?.(method, options.hostId);
      const host = hosts.get(options.hostId);
      if (!host) throw new Error("Unknown test host.");
      const parsed = memoryHostContract[method].input.parse(input);
      let result: unknown;
      if (method === "memoryAcquire") result = await host.acquire(memoryHostContract.memoryAcquire.input.parse(parsed), () => ({ dispose: async () => undefined }));
      else {
        const handler = host[methods[method]] as (input: never) => unknown;
        result = await handler.call(host, parsed as never);
      }
      return memoryHostContract[method].output.parse(result) as Output<K>;
    },
  };
  const service = createAgentMemoryService({ host: client, primaryHostId: async () => "primary", info: (message) => logs.push(message) });
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8"), input = JSON.parse(text);
      if (failWrite && input.action === "write") { failWrite = false; response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: false, error: { message: "Injected copy-back failure" } })); return; }
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
      const result = await service.handle(new Request("http://memory.test/memory", { method: "POST", headers, body: text }));
      if (dropCommitReply && input.action === "commit") { dropCommitReply = false; request.socket.destroy(); return; }
      const responseHeaders: Record<string, string> = {};
      result.headers.forEach((value, key) => { responseHeaders[key] = value; });
      response.writeHead(result.status, responseHeaders); response.end(await result.text());
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ ok: false, error: { message: String(error) } })); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/memory`;
  return {
    client, service, hosts, offline, dataDirs, hostDataDirs, logs, url,
    set beforeCall(value: typeof beforeCall) { beforeCall = value; },
    failNextWrite() { failWrite = true; },
    loseNextCommitReply() { dropCommitReply = true; },
    async env(threadId: string, agent: string, hostId = "primary") {
      const cap = await service.issue({ threadId, profile: `agent-${agent}`, instructions: "Test agent persona.", hostId });
      return { AGENT_MEMORY_URL: url, AGENT_MEMORY_KEY: cap.key, AGENT_MEMORY_SECRET: cap.secret, AGENT_MEMORY_MODE: cap.mode, AGENT_MEMORY_PROFILE: cap.profile };
    },
    async close() { service.dispose(); await Promise.all([...hosts.values()].map((host) => host.dispose())); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}
