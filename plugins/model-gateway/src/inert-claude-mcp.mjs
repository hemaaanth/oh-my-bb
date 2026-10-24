// Adapted from pi-claude-code src/inert-mcp.mjs (MIT); see THIRD_PARTY.md.
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const manifest = process.argv[2];
if (!manifest) process.exit(2);
const tools = JSON.parse(await readFile(manifest, "utf8"));
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  let result = {};
  if (request.method === "initialize") result = {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "gateway-inert-tools", version: "1" },
  };
  else if (request.method === "tools/list") result = { tools };
  else if (request.method === "tools/call") result = {
    isError: true,
    content: [{ type: "text", text: "Denied: only the requesting harness executes tools." }],
  };
  if (request.id !== undefined)
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
