#!/usr/bin/env node
// Offline Pi RPC fixture, adapted from BB's provider-pi fake. Never loads Pi or a model SDK.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { Socket } from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
if (args.includes("--version")) {
  process.stdout.write("1.2.0\n");
  process.exit(0);
}
if (args.includes("--help")) {
  process.stdout.write(process.env.FAKE_PI_HELP ?? (process.env.FAKE_PI_AUTO_HEMPI === "1" ? "  --role <role>\n  --optchat-profile <profile>\n" : "Pi CLI\n"));
  process.exit(Number(process.env.FAKE_PI_HELP_EXIT ?? 0));
}
const sessionFile = args.includes("--session") ? flag("--session") : undefined;
const logPath = process.env.FAKE_PI_PROCESS_LOG;
const launchLog = process.env.FAKE_PI_LAUNCH_LOG;
if (launchLog) appendFileSync(launchLog, JSON.stringify({ pid: process.pid, args }) + "\n");
if (logPath) appendFileSync(logPath, `spawn:${process.pid}\n`);
let profileBound = false;
process.on("exit", () => {
  if (profileBound && process.env.FAKE_PI_EXIT_FACT) writeMemory(process.env.FAKE_PI_EXIT_FACT);
  if (logPath) appendFileSync(logPath, `exit:${process.pid}\n`);
});
let attempt = 1;
if (process.env.FAKE_PI_ATTEMPT_FILE) {
  const file = process.env.FAKE_PI_ATTEMPT_FILE;
  attempt = existsSync(file) ? Number(readFileSync(file, "utf8")) + 1 : 1;
  writeFileSync(file, String(attempt));
}
const busyAttempts = Number(process.env.FAKE_PI_BUSY_ATTEMPTS ?? 0);
if (args.includes("--optchat-profile") && attempt <= busyAttempts) {
  process.stderr.write(`optchat: profile busy: ${flag("--optchat-profile")} (owner pid 123)\n`);
  process.exit(75);
}
if (process.env.FAKE_PI_STARTUP_EXIT) {
  const code = Number(process.env.FAKE_PI_STARTUP_EXIT);
  process.stderr.write(code === 73 ? "optchat: profile requires remote memory recovery; retained copy on remote-host; start a BB turn to recover\n" : code === 66 ? "optchat: profile not found: missing\n" : "optchat: import failed: invalid session\n");
  process.exit(code);
}
if (args.includes("--optchat-profile")) {
  const marker = join(dirname(memoryFile()), "remote-pending.json");
  if (existsSync(marker)) {
    const pending = JSON.parse(readFileSync(marker, "utf8"));
    process.stderr.write(`optchat: profile ${flag("--optchat-profile")} requires remote memory recovery. Retained copy: ${pending.directory} on ${pending.hostId}. Start a BB turn to recover.\n`);
    process.exit(73);
  }
}
if (sessionFile) {
  mkdirSync(dirname(sessionFile), { recursive: true });
  if (!existsSync(sessionFile)) writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: "fake", cwd: process.cwd() }) + "\n");
}
const gatewayModels = process.env.FAKE_PI_GATEWAY_MODELS === "1" ? [
  { provider: "openai-codex", id: "gpt-6-sol", name: "Direct Sol", reasoning: true, input: ["text"], contextWindow: 200000 },
  { provider: "openai-codex", id: "gpt-5.6-terra", name: "Direct Terra", reasoning: true, input: ["text"], contextWindow: 200000 },
  { provider: "model-gateway", id: "gpt-5.6-terra", name: "Gateway Terra", reasoning: true, input: ["text"], contextWindow: 200000 },
  { provider: "model-gateway", id: "gpt-6-sol", name: "Gateway Sol", reasoning: true, input: ["text"], contextWindow: 200000 },
  { provider: "model-gateway", id: "claude-fable-5", name: "Forbidden Gateway Claude", reasoning: true, input: ["text"], contextWindow: 200000 },
] : [];
const models = [
  { provider: "model-gateway", id: "gpt-fake", name: "Fake Gateway", reasoning: true, input: ["text"], contextWindow: 200000 },
  { provider: "model-gateway", id: "gpt-fake-mini", name: "Fake Gateway Mini", reasoning: false, input: ["text"], contextWindow: 32000 },
  { provider: "openai-codex", id: "gpt-fake", name: "Fake Codex", reasoning: true, input: ["text"], contextWindow: 200000 },
  { provider: "openai-codex", id: "gpt-fake-mini", name: "Fake Mini", reasoning: false, input: ["text"], contextWindow: 32000 },
  { provider: "anthropic", id: "forbidden-model", name: "Forbidden", reasoning: true, input: ["text"], contextWindow: 200000 },
  ...gatewayModels,
].filter((item) => process.env.FAKE_PI_NO_DIRECT_AUTH !== "1" || item.provider !== "openai-codex");
let model = args.includes("--model")
  ? models.find((item) => item.provider === flag("--provider") && (item.id === flag("--model") || flag("--model") === "gpt-")) ?? models.find((item) => item.provider === "anthropic")
  : models.find((item) => item.provider === flag("--provider")) ?? models[0];
let streaming = false;
let leafId = null;
let hold;
let run = 0;
let autoCompactionEnabled = true;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const channel = (message) => writeSync(3, JSON.stringify(message) + "\n");
const respond = (command, data) => send({ id: command.id, type: "response", command: command.type, success: true, ...(data === undefined ? {} : { data }) });
const fromBridge = new Socket({ fd: 4, readable: true, writable: false });
fromBridge.on("error", () => undefined);
createInterface({ input: fromBridge }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.kind !== "request") return;
  if (message.method === "leaf") channel({ kind: "reply", id: message.id, result: { leafId } });
  if (message.method === "model-scope") channel({ kind: "reply", id: message.id, result: { scopedModelIds: [] } });
  if (message.method === "fork") {
    let rows = readFileSync(message.sourceFile, "utf8").trim().split("\n").map((row) => JSON.parse(row));
    if (message.checkpointId) {
      const end = rows.findIndex((row) => row.id === message.checkpointId);
      if (end < 0) {
        channel({ kind: "reply", id: message.id, error: "Checkpoint not found" });
        return;
      }
      rows = rows.slice(0, end + 1);
    }
    rows[0].cwd = message.cwd;
    mkdirSync(dirname(message.targetFile), { recursive: true });
    writeFileSync(message.targetFile, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    channel({ kind: "reply", id: message.id, result: { sessionFile: message.targetFile } });
  }
});
channel({ kind: "ready" });
if (args.includes("--optchat-instructions")) {
  const directory = dirname(memoryFile());
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "AGENTS.md"), readFileSync(flag("--optchat-instructions")));
}
profileBound = args.includes("--optchat-profile");
if (args.includes("--optchat-profile")) send({ type: "extension_ui_request", id: "bound", method: "notify", message: `OptChat ${flag("--optchat-profile")}` });

function memoryFile() {
  const home = process.env.OPTCHAT_HOME, root = process.env.FAKE_PI_TEST_ROOT;
  // A remote turn's home is a short link to the working copy, so compare real paths.
  const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
  if (!home || !root || !real(home).startsWith(`${real(root)}${sep}`) || !args.includes("--optchat-profile")) throw new Error("Fake memory requires an isolated test home and profile.");
  return join(home, "profiles", flag("--optchat-profile"), "fake-memory-fact.txt");
}
function writeMemory(text) { const path = memoryFile(); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }

async function prompt(command) {
  if (command.message === "/handled") {
    send({ type: "extension_ui_request", id: "notice", method: "notify", message: "Command handled" });
    send({ type: "extension_ui_request", id: "warning", method: "notify", message: "Command warned", notifyType: "warning" });
    for (let i = 0; i < 2; i++) send({ type: "extension_ui_request", id: `status-${i}`, method: "setStatus", statusKey: "memory", statusText: "Memory ready" });
    respond(command, { disposition: "handled" });
    return;
  }
  respond(command, { disposition: "started" });
  streaming = true;
  if (command.message === "/long" && autoCompactionEnabled) {
    send({ type: "compaction_start", reason: "threshold" });
    send({ type: "compaction_end", reason: "threshold", aborted: false });
  }
  run++;
  send({ type: "agent_start" });
  if (command.message === "/hold") {
    const deferred = Promise.withResolvers();
    hold = deferred.resolve;
    await deferred.promise;
  }
  let text = command.message;
  if (text.startsWith("/remember ")) { writeMemory(text.slice(10)); text = "Remembered."; }
  else if (text === "/recall") { const path = memoryFile(); text = existsSync(path) ? readFileSync(path, "utf8") : "No memory fact."; }
  const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", provider: model.provider, model: model.id };
  send({ type: "message_start", message });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
  send({ type: "message_end", message });
  leafId = `leaf-${process.pid}-${run}`;
  if (sessionFile) appendFileSync(sessionFile, JSON.stringify({ type: "message", id: leafId, message }) + "\n");
  channel({ kind: "agent-end-leaf", leafId });
  send({ type: "agent_end", messages: [message] });
  if (command.message === "/delayed-settle") {
    if (process.env.FAKE_PI_END_MARKER) writeFileSync(process.env.FAKE_PI_END_MARKER, String(process.pid));
    await delay(200);
    if (process.env.FAKE_PI_SETTLED_MARKER) writeFileSync(process.env.FAKE_PI_SETTLED_MARKER, String(process.pid));
  }
  streaming = false;
  send({ type: "agent_settled" });
}

async function handle(command) {
  switch (command.type) {
    case "get_state": respond(command, { model, isStreaming: streaming, isCompacting: false, autoCompactionEnabled, sessionFile }); return;
    case "get_available_models": respond(command, { models }); return;
    case "get_session_stats": respond(command, { contextUsage: { tokens: 100, contextWindow: model.contextWindow } }); return;
    case "set_auto_compaction":
      if (process.env.FAKE_PI_IGNORE_AUTO_COMPACTION !== "1") autoCompactionEnabled = command.enabled;
      if (process.env.FAKE_PI_COMMAND_LOG) appendFileSync(process.env.FAKE_PI_COMMAND_LOG, JSON.stringify({ type: command.type, enabled: command.enabled }) + "\n");
      respond(command); return;
    case "set_model": model = models.find((item) => item.provider === command.provider && item.id === command.modelId) ?? model; respond(command, model); return;
    case "prompt": await prompt(command); return;
    case "abort": hold?.(); hold = undefined; respond(command); return;
    default: send({ id: command.id, type: "response", command: command.type, success: false, error: `Unknown command ${command.type}` });
  }
}
createInterface({ input: process.stdin }).on("line", (line) => {
  void handle(JSON.parse(line)).catch((error) => { process.stderr.write(String(error)); process.exit(1); });
}).on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
