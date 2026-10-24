#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv;
const mcp = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
const tools = JSON.parse(await readFile(mcp.mcpServers.gateway.args[1], "utf8"));
const history = [];
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const frame = JSON.parse(line);
  history.push(frame.message);
  if (JSON.stringify(frame.message).includes("close-native-stdin")) {
    process.stdout.write(JSON.stringify({ type: "result", num_turns: 0, is_error: false }) + "\n");
    process.stdin.destroy();
    process.exit(0);
  }
  if (frame.shouldQuery === false) {
    process.stdout.write(JSON.stringify({ type: "result", num_turns: 0, is_error: JSON.stringify(frame.message).includes("reject-native-replay") }) + "\n");
    continue;
  }
  if (frame.type === "assistant") continue;
  const workerMarker = /worker-start-marker:([^"\s]+)/u.exec(JSON.stringify(frame.message))?.[1];
  if (workerMarker) writeFileSync(workerMarker, "started");
  if (JSON.stringify(frame.message).includes("stall-native-worker")) await new Promise(() => setInterval(() => {}, 1_000));
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.BB_MODEL_GATEWAY_TOKEN)
    throw new Error("Inherited credential entered the worker");
  if (JSON.stringify(frame.message).includes("verify-native-mcp")) {
    const server = mcp.mcpServers.gateway;
    if (server.env?.ELECTRON_RUN_AS_NODE !== "1") throw new Error("MCP subprocess is not configured as Node");
    const worker = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "ignore"] });
    let timeout;
    try {
      const reply = new Promise((resolve, reject) => {
        worker.once("error", reject);
        worker.once("exit", code => reject(new Error(`MCP subprocess exited before tools/list: ${code}`)));
        createInterface({ input: worker.stdout }).once("line", line => {
          try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
        });
      });
      worker.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
      const listed = await Promise.race([reply, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("MCP tools/list timed out")), 2_000); })]);
      if (JSON.stringify(listed.result?.tools) !== JSON.stringify(tools)) throw new Error("MCP tools/list did not return the inventory");
    } finally { clearTimeout(timeout); worker.kill(); }
  }
  const body = {
    model: args[args.indexOf("--model") + 1], stream: true,
    metadata: { user_id: JSON.stringify({ account_uuid: "", session_id: "22222222-2222-4222-8222-222222222222", device_id: "device-native" }) },
    messages: [...history.map(message => message.role === "assistant"
      ? { ...message, content: message.content.filter(block => block.type !== "thinking") }
      : message), { role: "system", content: [{ type: "text", text: "Native CLI envelope" }] }],
    system: [{ type: "text", text: "Native CLI system" }],
    thinking: { type: "adaptive" }, output_config: { effort: "medium" }, tool_choice: { type: "auto" },
    tools: JSON.stringify(frame.message).includes("omit-native-tools") ? [] : tools.map(tool => ({ name: `mcp__gateway__${tool.name}`, input_schema: tool.inputSchema })),
  };
  const marker = /descendant-marker:([^"\s]+)/u.exec(JSON.stringify(frame.message))?.[1];
  if (marker) {
    const descendant = spawn(process.execPath, ["-e", "const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),10)", marker], { stdio: "ignore" });
    writeFileSync(marker, `${descendant.pid}:started`);
  }
  const rejectedMarker = /reject-native-replay:([^"\s]+)/u.exec(JSON.stringify(history))?.[1];
  if (rejectedMarker) writeFileSync(rejectedMarker, "native-request-attempted");
  const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages?beta=true", {
    method: "POST", headers: { authorization: `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`, "content-type": "application/json", "x-app": "cli", "anthropic-beta": "claude-code-20250219" },
    body: JSON.stringify(body),
  });
  await response.arrayBuffer();
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: !response.ok, num_turns: 1 }) + "\n");
  break;
}
