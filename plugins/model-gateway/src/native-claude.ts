// Native Claude Code request construction for Gateway-owned OAuth accounts.
// History replay and inert MCP inventory adapted from pi-claude-code (MIT); see THIRD_PARTY.md.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const MAX_REQUEST = 8 * 1024 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const MAX_FRAME = 1024 * 1024;
const TIMEOUT_MS = 60_000;
const MCP_PREFIX = "mcp__gateway__";
const MAX_WORKERS = 4;
const MAX_WAITING = 16;
let activeWorkers = 0;
const waitingWorkers: Array<() => void> = [];

async function admit(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  if (activeWorkers >= MAX_WORKERS) {
    if (waitingWorkers.length >= MAX_WAITING) throw new NativeClaudeError("Claude CLI worker capacity is exhausted.");
    await new Promise<void>((resolve, reject) => {
      const wake = () => { signal.removeEventListener("abort", abort); resolve(); };
      const abort = () => {
        waitingWorkers.splice(waitingWorkers.indexOf(wake), 1);
        reject(signal.reason);
      };
      waitingWorkers.push(wake);
      signal.addEventListener("abort", abort, { once: true });
    });
  } else activeWorkers++;
  return () => {
    const next = waitingWorkers.shift();
    if (next) next(); else activeWorkers--;
  };
}

type Rec = Record<string, unknown>;
const record = (value: unknown): value is Rec =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class NativeClaudeError extends Error {}

export interface NativeClaudeInput {
  body: Uint8Array;
  model: string;
  streaming: boolean;
  signal: AbortSignal;
  command?: string;
}

export interface NativeClaudeRequest {
  body: Uint8Array;
  headers: Headers;
  names: ReadonlyMap<string, string>;
}

function prepareHistory(payload: Rec) {
  if (!Array.isArray(payload.messages) || payload.messages.length === 0)
    throw new NativeClaudeError("Claude history must contain messages.");
  if (payload.tools !== undefined && !Array.isArray(payload.tools))
    throw new NativeClaudeError("Claude tools must be an array.");
  const names = new Map<string, string>();
  const reverse = new Map<string, string>();
  const manifest = (payload.tools ?? []).map((tool: unknown, index: number) => {
    if (!record(tool) || typeof tool.name !== "string" || !record(tool.input_schema) || names.has(tool.name))
      throw new NativeClaudeError("Claude tool name/schema is unsupported or duplicated.");
    const mapped = `${MCP_PREFIX}tool_${index}`;
    names.set(tool.name, mapped);
    reverse.set(mapped, tool.name);
    return { name: `tool_${index}`, description: typeof tool.description === "string" ? tool.description : "", inputSchema: tool.input_schema };
  });
  const history = payload.messages.map((message: unknown) => {
    if (!record(message) || (message.role !== "user" && message.role !== "assistant") || !Array.isArray(message.content))
      throw new NativeClaudeError("Claude history has an unsupported message.");
    return { role: message.role, content: message.content.map((block: unknown) => {
      if (!record(block) || block.type !== "tool_use") return block;
      const name = names.get(String(block.name));
      if (!name) throw new NativeClaudeError(`Historical Claude tool ${String(block.name)} is not declared.`);
      return { ...block, name };
    }) };
  });
  if (history.at(-1)?.role !== "user")
    throw new NativeClaudeError("Claude history must end with a user or tool result.");
  const frames = history.map((message, index) => ({
    type: message.role, message,
    ...(message.role === "user" && index < history.length - 1 ? { shouldQuery: false } : {}),
  }));
  return { history, frames, manifest, names, reverse };
}

function kill(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  if (process.platform !== "win32") {
    // MCP descendants inherit the CLI's dedicated process group, even if its leader exited.
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* Group already gone. */ }
  } else if (child.exitCode === null) child.kill("SIGKILL");
}

/** CLI constructs one Messages request; Gateway sends it only after CLI is gone. */
export async function prepareNativeClaude(input: NativeClaudeInput): Promise<NativeClaudeRequest> {
  input.signal.throwIfAborted();
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(input.body)); }
  catch { throw new NativeClaudeError("Invalid translated Claude request."); }
  if (!record(payload) || payload.model !== input.model)
    throw new NativeClaudeError("Claude request model does not match the selected route.");
  const { history, frames, manifest, names, reverse } = prepareHistory(payload);
  const root = await mkdtemp(join(tmpdir(), "gateway-claude-"));
  const token = randomBytes(32).toString("base64url");
  const path = `/turn/${randomBytes(32).toString("base64url")}/v1/messages`;
  let resolveCapture!: (value: NativeClaudeRequest) => void;
  let rejectCapture!: (error: Error) => void;
  const capturedRequest = new Promise<NativeClaudeRequest>((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
  });
  void capturedRequest.catch(() => {});
  let child: ChildProcess | undefined;
  let server: Server | undefined;
  let release: (() => void) | undefined;
  const workerAbort = new AbortController();
  const sockets = new Set<Socket>();
  const stop = () => {
    workerAbort.abort(new NativeClaudeError("Claude Code request was interrupted."));
    kill(child);
    for (const socket of sockets) socket.destroy();
    server?.closeAllConnections?.();
    rejectCapture(new NativeClaudeError("Claude Code request was interrupted."));
  };
  const timer = setTimeout(stop, TIMEOUT_MS);
  input.signal.addEventListener("abort", stop, { once: true });
  if (input.signal.aborted) stop();
  try {
    await mkdir(join(root, "config"), { mode: 0o700 });
    await writeFile(join(root, "tools.json"), JSON.stringify(manifest), { mode: 0o600 });
    if (payload.system !== undefined && typeof payload.system !== "string")
      throw new NativeClaudeError("Claude system prompt is unsupported.");
    await writeFile(join(root, "system.md"), payload.system ?? "", { mode: 0o600 });
    if (process.platform === "win32") throw new NativeClaudeError("Native Claude CLI requires process-group cleanup, unavailable on Windows.");
    release = await admit(workerAbort.signal);
    server = createServer((req, res) => {
      void (async () => {
        if (req.method !== "POST" || req.url?.split("?", 1)[0] !== path || req.headers.origin || req.headers.authorization !== `Bearer ${token}` || captured) {
          res.writeHead(403).end(); return;
        }
        captured = true;
        try {
          let size = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_REQUEST) throw new NativeClaudeError("Claude request exceeded the transport limit.");
            chunks.push(chunk);
          }
          const native: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!record(native) || native.model !== input.model || !Array.isArray(native.messages))
            throw new NativeClaudeError("Claude CLI sent an invalid model or history.");
          const assistants = history.filter(message => message.role === "assistant");
          const nativeAssistants = native.messages.filter((message: unknown) => record(message) && message.role === "assistant");
          if (assistants.length !== nativeAssistants.length)
            throw new NativeClaudeError("Claude CLI changed assistant history boundaries.");
          let index = 0;
          native.messages = native.messages.map((message: unknown) =>
            record(message) && message.role === "assistant" ? { ...message, content: assistants[index++]!.content } : message,
          );
          // Keep the CLI's native message/system envelope, but never inherit
          // generation defaults that contradict the translated request.
          for (const key of ["max_tokens", "speed", "thinking", "output_config", "temperature", "top_p", "tool_choice"]) {
            if (!(key in payload)) { if (key !== "max_tokens") delete native[key]; continue; }
            native[key] = key === "tool_choice" && record(payload[key]) && payload[key].type === "tool"
              ? { ...payload[key], name: names.get(String(payload[key].name)) ?? "" } : payload[key];
          }
          if (record(native.tool_choice) && native.tool_choice.type === "tool" && !native.tool_choice.name)
            throw new NativeClaudeError("Claude tool choice is not in the inventory.");
          native.stream = input.streaming;
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers))
            if (typeof value === "string" && !["host", "authorization", "content-length", "connection", "accept-encoding"].includes(key))
              headers.set(key, value);
          headers.set("content-type", "application/json");
          headers.set("accept", input.streaming ? "text/event-stream" : "application/json");
          resolveCapture({ body: new TextEncoder().encode(JSON.stringify(native)), headers, names: reverse });
        } catch (error) {
          rejectCapture(error instanceof Error ? error : new NativeClaudeError("Invalid Claude CLI request."));
        } finally {
          if (!res.destroyed && !res.headersSent) res.writeHead(503).end();
        }
      })();
    });
    let captured = false;
    server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new NativeClaudeError("Could not bind Claude relay.");
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: root, TMPDIR: root, LANG: "C.UTF-8",
      CLAUDE_CONFIG_DIR: join(root, "config"),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}/turn/${path.split("/")[2]}`,
      ANTHROPIC_AUTH_TOKEN: token,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_RETRIES: "0",
      DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
      DISABLE_AUTO_COMPACT: "1", ENABLE_TOOL_SEARCH: "false",
    };
    const mcp = { mcpServers: { gateway: { command: process.execPath, args: [fileURLToPath(new URL("../src/inert-claude-mcp.mjs", import.meta.url)), join(root, "tools.json")] } } };
    child = spawn(input.command ?? "claude", ["-p", "--model", input.model, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "", "--system-prompt-file", join(root, "system.md"), "--settings", '{"disableAllHooks":true}', "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--max-turns", "1", "--permission-mode", "dontAsk", "--no-session-persistence", "--mcp-config", JSON.stringify(mcp)], { cwd: root, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<void>((resolve, reject) => {
      child!.once("error", () => reject(new NativeClaudeError("Claude Code CLI is unavailable. Install it on the Gateway host.")));
      child!.once("exit", () => resolve());
    });
    void exited.catch(() => {});
    if (!child.pid) await exited;
    child.stdin?.on("error", () => rejectCapture(new NativeClaudeError("Claude Code closed stdin during history replay.")));
    let output = 0;
    for (const pipe of [child.stdout, child.stderr]) pipe?.on("data", (chunk: Buffer) => {
      output += chunk.length;
      if (output > MAX_OUTPUT) { rejectCapture(new NativeClaudeError("Claude Code output exceeded the transport limit.")); stop(); }
    });
    const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    const acknowledgements: Array<{ resolve: () => void; reject: (error: NativeClaudeError) => void }> = [];
    reader.on("line", line => {
      if (line.length > MAX_FRAME) { rejectCapture(new NativeClaudeError("Claude Code frame exceeded the transport limit.")); stop(); return; }
      try {
        const event = JSON.parse(line);
        if (event.type === "result" && acknowledgements.length > 0) {
          const ack = acknowledgements.shift()!;
          if (event.num_turns === 0 && !event.is_error) ack.resolve();
          else ack.reject(new NativeClaudeError("Claude Code rejected history replay."));
        }
      } catch { rejectCapture(new NativeClaudeError("Invalid Claude Code output.")); stop(); }
    });
    for (const frame of frames) {
      input.signal.throwIfAborted();
      if (!child.stdin?.writable) throw new NativeClaudeError("Claude Code closed during history replay.");
      let resolveAck!: () => void;
      let rejectAck!: (error: NativeClaudeError) => void;
      const ack = "shouldQuery" in frame ? new Promise<void>((resolve, reject) => { resolveAck = resolve; rejectAck = reject; }) : null;
      if (ack) acknowledgements.push({ resolve: resolveAck, reject: rejectAck });
      await Promise.race([
        new Promise<void>((resolve, reject) => child!.stdin!.write(JSON.stringify(frame) + "\n", error => error ? reject(new NativeClaudeError("Claude Code closed stdin during history replay.")) : resolve())),
        capturedRequest,
        exited.then(() => { throw new NativeClaudeError("Claude Code exited during history replay."); }),
      ]);
      if (ack) await Promise.race([ack, capturedRequest, exited.then(() => { throw new NativeClaudeError("Claude Code exited during history replay."); })]);
    }
    child.stdin?.end();
    const native = await Promise.race([capturedRequest, exited.then(() => { throw new NativeClaudeError("Claude Code did not submit a Messages request."); })]);
    input.signal.throwIfAborted();
    return native;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", stop);
    stop();
    child?.stdin?.destroy();
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    if (child && child.exitCode === null && child.signalCode === null) await Promise.race([
      new Promise<void>(resolve => child!.once("exit", () => resolve())),
      new Promise<void>(resolve => setTimeout(resolve, 1_000)),
    ]);
    await new Promise<void>(resolve => { if (!server?.listening) resolve(); else server.close(() => resolve()); });
    release?.();
    await rm(root, { recursive: true, force: true });
  }
}

/** CLI emits an empty account_uuid for a relay token; preserve session/device IDs. */
export function bindNativeAccount(body: Uint8Array, accountUuid: string | null): Uint8Array {
  if (accountUuid === null) return body;
  const payload: unknown = JSON.parse(new TextDecoder().decode(body));
  if (!record(payload) || !record(payload.metadata) || typeof payload.metadata.user_id !== "string")
    throw new NativeClaudeError("Claude CLI metadata lacks account identity.");
  let user: unknown;
  try { user = JSON.parse(payload.metadata.user_id); }
  catch { throw new NativeClaudeError("Claude CLI metadata user_id is invalid."); }
  if (!record(user) || typeof user.account_uuid !== "string")
    throw new NativeClaudeError("Claude CLI metadata lacks account identity.");
  return new TextEncoder().encode(JSON.stringify({
    ...payload,
    metadata: { ...payload.metadata, user_id: JSON.stringify({ ...user, account_uuid: accountUuid }) },
  }));
}

/** Renames only native MCP tool calls. Streaming stays incremental with bounded frames. */
export function remapNativeResponse(response: Response, names: ReadonlyMap<string, string>): Response {
  if (!response.ok || names.size === 0) return response;
  if (response.headers.get("content-type")?.includes("text/event-stream") && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = "";
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          while (true) {
            const match = /\r?\n\r?\n/u.exec(pending);
            if (match) {
              if (match.index > MAX_FRAME) throw new NativeClaudeError("Claude response frame exceeded the transport limit.");
              const frame = pending.slice(0, match.index);
              pending = pending.slice(match.index + match[0].length);
              const lines = frame.split(/\r?\n/u);
              const dataIndex = lines.findIndex(line => line.startsWith("data:"));
              if (dataIndex >= 0) {
                const event = JSON.parse(lines[dataIndex]!.slice(5)) as unknown;
                if (record(event) && event.type === "content_block_start" && record(event.content_block) && event.content_block.type === "tool_use") {
                  const original = names.get(String(event.content_block.name));
                  if (!original) throw new NativeClaudeError("Claude returned a tool outside the current inventory.");
                  event.content_block = { ...event.content_block, name: original };
                  lines[dataIndex] = `data: ${JSON.stringify(event)}`;
                }
              }
              controller.enqueue(encoder.encode(lines.join("\n") + "\n\n"));
              return;
            }
            if (pending.length > MAX_FRAME) throw new NativeClaudeError("Claude response frame exceeded the transport limit.");
            const { value, done } = await reader.read();
            if (done) {
              pending += decoder.decode();
              if (pending.trim()) controller.enqueue(encoder.encode(pending));
              controller.close();
              return;
            }
            pending += decoder.decode(value, { stream: true });
          }
        } catch (error) { controller.error(error); await reader.cancel().catch(() => undefined); }
      },
      async cancel() { await reader.cancel().catch(() => undefined); },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  }
  if (!response.body) return response;
  const transformed = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const data = await response.json() as unknown;
        if (record(data) && Array.isArray(data.content)) data.content = data.content.map((block: unknown) => {
          if (!record(block) || block.type !== "tool_use") return block;
          const original = names.get(String(block.name));
          if (!original) throw new NativeClaudeError("Claude returned a tool outside the current inventory.");
          return { ...block, name: original };
        });
        controller.enqueue(new TextEncoder().encode(JSON.stringify(data)));
        controller.close();
      } catch (error) { controller.error(error); }
    },
  });
  return new Response(transformed, { status: response.status, headers: response.headers });
}
