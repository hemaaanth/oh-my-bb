#!/usr/bin/env node
// @ts-check
// A fake `fx acp`: just enough ACP to test fx-acp. It logs every frame it
// receives to FAKE_FX_LOG. `FAKE_FX_REFUSE=1` makes it refuse the provider switch.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.FAKE_FX_LOG;
let provider = process.env.FAKE_FX_PROVIDER ?? "gateway";
const options = () => [
  {
    id: "provider",
    name: "Provider",
    type: "select",
    currentValue: provider,
    options: [
      { value: "gateway", name: "Vercel AI Gateway" },
      { value: "codex", name: "Codex subscription" },
      { value: "grok", name: "Grok subscription" },
    ],
  },
  { id: "model", name: "Model", type: "select", currentValue: "gpt-6-astra", options: [{ value: "gpt-6-astra", name: "GPT-6 Astra" }] },
];
/** @param {object} frame */
const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);

process.stderr.write(`fake fx started with ${process.argv.slice(2).join(" ")}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  if (log) appendFileSync(log, `${line}\n`);
  const frame = JSON.parse(line);
  const { id, method, params } = frame;
  if (method === "initialize") send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (method === "session/new") send({ id, result: { sessionId: "s1", configOptions: options() } });
  else if (method === "session/load") send({ id, result: { configOptions: options() } });
  else if (method === "session/set_config_option") {
    if (process.env.FAKE_FX_REFUSE === "1") return send({ id, error: { code: -32603, message: "not signed in" } });
    if (params.configId === "provider") provider = params.value;
    send({ id, result: { configOptions: options() } });
    send({ method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "config_option_update", configOptions: options() } } });
  } else if (method === "session/prompt") send({ id, result: { stopReason: "end_turn" } });
  else if (method === "exit") process.exit(Number(params.code));
});
