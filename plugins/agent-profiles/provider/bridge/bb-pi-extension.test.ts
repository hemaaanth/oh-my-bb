import { StringDecoder } from "node:string_decoder";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { BB_PI_EXTENSION_SOURCE } from "./bb-pi-extension.js";

it("restores host tools after an existing Hempi session resets its saved tool list", async () => {
  const handlers = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
  const registered: string[] = [];
  let active = ["prospecting_outreach_ledger"];
  const pi = {
    registerTool: (tool: { name: string }) => { registered.push(tool.name); },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
    on: (name: string, handler: (event: unknown, context: unknown) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  };
  const source = BB_PI_EXTENSION_SOURCE
    .replace(/^import .*;$/gm, "")
    .replace("export default function bbExtension", "function bbExtension");
  const extension = runInNewContext(`${source}\nbbExtension`, {
    process: { env: { PI_BB_TOOLS_FILE: "/tools.json" } },
    readFileSync: () => JSON.stringify([
      { name: "prospecting_outreach_ledger" },
      { name: "prospecting_edit_draft" },
    ]),
    writeSync: (_fd: number, _buffer: Buffer, _offset: number, length: number) => length,
    Socket: class { on() { return this; } unref() {} },
    StringDecoder,
    Type: { Object: () => ({}) },
    Buffer,
  }) as (api: typeof pi) => void;
  extension(pi);
  expect(registered).toContain("prospecting_edit_draft");

  for (const handler of handlers.get("session_start") ?? []) await handler({}, {});
  expect(active).toContain("prospecting_edit_draft");
  active = ["prospecting_outreach_ledger"]; // Hempi loads the older session baseline.
  for (const handler of handlers.get("before_agent_start") ?? []) await handler({}, {});
  expect(active).toContain("prospecting_edit_draft");
  expect(active.filter((name) => name === "prospecting_edit_draft")).toHaveLength(1);
});
