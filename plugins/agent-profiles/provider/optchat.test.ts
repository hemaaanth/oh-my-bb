import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { memoryBusyError, parseHempiOptions, prepareOptchatBinding } from "./optchat.js";

const agent = {
  threadId: "thr_task", agentId: "00000000-0000-4000-8000-000000000001", agent: "engineer", agentName: "Engineer",
  instructions: "Be precise.", modelMode: "level", level: "medium", providerId: "codex", model: "gpt-6-sol", reasoningLevel: "medium",
};

it("binds memory only when the run carries the DM's memory key", () => {
  const dir = mkdtempSync(join(tmpdir(), "optchat-"));
  const task = prepareOptchatBinding(parseHempiOptions(agent), join(dir, "s.jsonl"), dir);
  expect(task.args).toEqual([]);
  expect(task.label).toBe("Engineer");
  const dm = prepareOptchatBinding(parseHempiOptions({ ...agent, memoryKey: "agent-engineer" }), join(dir, "s.jsonl"), dir);
  expect(dm.args.slice(0, 3)).toEqual(["--optchat-profile", "agent-engineer", "--optchat-create"]);
  expect(dm.args).toContain("--optchat-instructions");
});

it("fails a busy profile at once with a clear message", () => {
  const error = memoryBusyError("Engineer", new Error("profile busy"));
  expect(error.message).toContain("Engineer's memory is held by another process");
  expect(error.cause).toBeInstanceOf(Error);
});
