import { describe, expect, it } from "vitest";
import type { TraceRow } from "../../shared/contract.js";
import { clip, filterItems, groupTrace, mergeRows, toolTitle } from "./trace.js";

let next = 1;
const row = (kind: string, payload: Record<string, unknown> | null = null, at = next * 1000): TraceRow => ({ id: next++, callId: "c1", at, kind, payload });

describe("groupTrace", () => {
  it("makes speech, notice and error rows", () => {
    const items = groupTrace([
      row("speech.user", { text: "hello" }),
      row("speech.agent", { text: "hi there" }),
      row("notice", { digest: "Thread A finished" }),
      row("error", { message: "boom" }),
      row("call.failed", { detail: "ICE failed" }),
    ]);
    expect(items.map((item) => item.type)).toEqual(["speech", "speech", "notice", "error", "error"]);
    expect(items[0]).toMatchObject({ who: "user", text: "hello" });
    expect(items[1]).toMatchObject({ who: "agent" });
    expect(items[2]).toMatchObject({ text: "Thread A finished" });
    expect(items[3]).toMatchObject({ text: "boom" });
    expect(items[4]).toMatchObject({ text: "ICE failed" });
  });

  it("joins a tool result to its call and sets the status", () => {
    const items = groupTrace([
      row("tool.call", { name: "read_thread", args: { thread_id: "t1" }, callId: "k1" }),
      row("tool.call", { name: "stop_thread", args: { thread_id: "t2" }, callId: "k2" }),
      row("tool.result", { name: "read_thread", callId: "k1", status: "ok", output: "done" }),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: "action", title: "Read a thread", status: "ok", output: "done", args: { thread_id: "t1" } });
    expect(items[1]).toMatchObject({ status: "running", output: null });
  });

  it("marks a failed result as an error and keeps a result with no call", () => {
    const items = groupTrace([row("tool.call", { name: "stop_thread", args: {}, callId: "k" }), row("tool.result", { name: "stop_thread", callId: "k", status: "error", output: "no" }), row("tool.result", { name: "archive_thread", callId: "lost", status: "ok", output: "x" })]);
    expect(items.map((item) => item.type === "action" && item.status)).toEqual(["error", "ok"]);
    expect(items[1]).toMatchObject({ title: "Archived a thread" });
  });

  it("shows a plugin command as the line the owner would type", () => {
    expect(toolTitle("run_plugin_command", { plugin_id: "linear", argv: ["issue", "list"] })).toBe("bb linear issue list");
    expect(toolTitle("run_plugin_command", { plugin_id: "linear" })).toBe("bb linear");
    expect(toolTitle("some_new_tool", {})).toBe("Some new tool");
  });

  it("turns send, composer and thread.focus into action rows", () => {
    const items = groupTrace([row("send", { threadId: "t" }), row("composer", { action: "set", length: 4 }), row("thread.focus", { threadId: "t", how: "navigate" })]);
    expect(items.map((item) => item.type)).toEqual(["action", "action", "action"]);
    expect(items.map((item) => item.type === "action" && item.title)).toEqual(["Sent the message", "Composer: set", "Opened a thread (navigate)"]);
  });

  it("collapses consecutive diagnostic events and starts a new group after another row", () => {
    const items = groupTrace([row("call.started"), row("conn.state", { state: "connected" }), row("client.ready", {}), row("speech.user", { text: "hi" }), row("mute", { muted: true }), row("usage.seconds", { seconds: 3 })]);
    expect(items.map((item) => item.type)).toEqual(["system", "speech", "system"]);
    expect(items[0]).toMatchObject({ type: "system", events: expect.arrayContaining([expect.objectContaining({ kind: "call.started" })]) });
    expect(items[0]!.type === "system" && items[0].events).toHaveLength(3);
    expect(items[2]!.type === "system" && items[2].events).toHaveLength(2);
  });
});

describe("filterItems", () => {
  const items = groupTrace([
    row("call.started"),
    row("speech.user", { text: "a" }),
    row("notice", { digest: "n" }),
    row("tool.call", { name: "read_thread", args: {}, callId: "a" }),
    row("tool.result", { name: "read_thread", callId: "a", status: "ok", output: "" }),
    row("tool.call", { name: "stop_thread", args: {}, callId: "b" }),
    row("tool.result", { name: "stop_thread", callId: "b", status: "error", output: "" }),
    row("error", { message: "bad" }),
  ]);

  it("filters by chip", () => {
    expect(filterItems(items, "all")).toHaveLength(items.length);
    expect(filterItems(items, "talk").map((item) => item.type)).toEqual(["speech", "notice"]);
    expect(filterItems(items, "actions").map((item) => item.type)).toEqual(["action", "action"]);
    expect(filterItems(items, "errors").map((item) => item.type)).toEqual(["action", "error"]);
  });
});

describe("mergeRows", () => {
  it("appends, replaces by id and keeps time order", () => {
    const a = row("speech.user", { text: "1" }, 10);
    const b = row("speech.agent", { text: "2" }, 30);
    const c = row("speech.user", { text: "3" }, 20);
    const merged = mergeRows([a, b], [c, { ...b, payload: { text: "2 again" } }]);
    expect(merged.map((r) => r.id)).toEqual([a.id, c.id, b.id]);
    expect(merged[2]!.payload).toEqual({ text: "2 again" });
  });
});

describe("clip", () => {
  it("leaves short text and cuts long text with a note", () => {
    expect(clip("short", 10)).toBe("short");
    expect(clip("x".repeat(15), 10)).toBe(`${"x".repeat(10)}… (5 more characters)`);
  });
});
