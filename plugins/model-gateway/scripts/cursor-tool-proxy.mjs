#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [toolsPath, callPath] = process.argv.slice(2);
if (!toolsPath || !callPath) process.exit(2);
const tools = JSON.parse(await readFile(toolsPath, "utf8"));
const lines = createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

lines.on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "model-gateway-tools", version: "1" },
    });
  } else if (message.method === "tools/list") {
    reply(message.id, { tools });
  } else if (message.method === "tools/call") {
    await writeFile(callPath, JSON.stringify({
      name: message.params?.name,
      arguments: message.params?.arguments ?? {},
    }), { mode: 0o600 });
    // The Gateway ends this process after returning the call to its client.
  } else if (message.id !== undefined) {
    reply(message.id, {});
  }
});
