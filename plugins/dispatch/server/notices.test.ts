import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { CHANNELS } from "../shared/constants.js";
import type { ThreadNoticePayload } from "../shared/contract.js";
import { loadPlugin, published, type Stubs } from "./core-test-host.js";
import { NOTICE_DETAIL_TARGET, compactDetail, onThreadNotice } from "./notices.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const events = { threads: { events: { list: async () => [{ type: "provider/error", data: { message: "The build broke." } }] } } } as unknown as Stubs;

describe("thread notices", () => {
  it("publishes a finished notice with the last assistant text", async () => {
    const { harness } = await loadPlugin(undefined, events);
    const heard: ThreadNoticePayload[] = [];
    const stop = onThreadNotice((notice) => heard.push(notice));
    const thread = makeThreadResponse({ id: "thr_a", title: "Fix the header", projectId: "proj_a" });
    await harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: "Done.  The header   is fixed." });
    await flush();
    stop();
    const notice = { kind: "finished", threadId: "thr_a", title: "Fix the header", detail: "Done. The header is fixed.", projectId: "proj_a" };
    expect(published(harness, CHANNELS.threadNotice)).toEqual([notice]);
    expect(heard).toEqual([notice]);
  });

  it("publishes a failed notice from the outcome summary", async () => {
    const { harness } = await loadPlugin(undefined, events);
    await harness.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "thr_b" }), error: "fallback" });
    await flush();
    expect(published(harness, CHANNELS.threadNotice)).toMatchObject([{ kind: "failed", threadId: "thr_b", detail: "The build broke." }]);
  });

  it("skips hidden threads", async () => {
    const { harness } = await loadPlugin(undefined, events);
    await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ visibility: "hidden" }), lastAssistantText: "Secret." });
    await flush();
    expect(published(harness, CHANNELS.threadNotice)).toEqual([]);
  });

  it("compacts detail at a sentence end near 600 characters", () => {
    const sentence = "This sentence is exactly fifty characters long ok. ";
    const long = sentence.repeat(20);
    const compacted = compactDetail(long);
    expect(compacted.length).toBeLessThanOrEqual(NOTICE_DETAIL_TARGET);
    expect(compacted.length).toBeGreaterThan(NOTICE_DETAIL_TARGET - sentence.length);
    expect(compacted.endsWith(".")).toBe(true);
    const words = compactDetail("word ".repeat(300));
    expect(words.endsWith("…")).toBe(true);
    expect(words.length).toBeLessThanOrEqual(NOTICE_DETAIL_TARGET);
  });
});
