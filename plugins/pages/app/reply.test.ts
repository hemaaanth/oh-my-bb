import { afterEach, describe, expect, it, vi } from "vitest";
import { clearReplyCache, loadReplies, nearest, previewOf, recordReply, replyFor, replyKey, type ReplyThreads } from "./reply.js";

function fakeThreads(items: { id: string; preview: string }[]) {
  const metadata: Record<string, unknown> = {};
  const threads = {
    getPluginMetadata: vi.fn(async () => ({ ...metadata })),
    updatePluginMetadata: vi.fn(async ({ set }: { set: Record<string, unknown> }) => Object.assign(metadata, set)),
    conversationOutline: vi.fn(async () => ({ items })),
  } satisfies ReplyThreads;
  return { threads, metadata, items };
}

afterEach(() => { clearReplyCache(); vi.useRealTimers(); });

describe("reply records", () => {
  it("matches BB's outline preview: collapsed whitespace, 200 characters", () => {
    expect(previewOf("  Pick one:\n- size:  large ")).toBe("Pick one: - size: large");
    expect(previewOf(`${"a".repeat(199)} b`)).toBe("a".repeat(199));
    expect(replyKey("Pick one:\n- size: large", 1)).toBe(replyKey("Pick one: - size: large", 1));
    expect(replyKey("yes", 1)).not.toBe(replyKey("no", 1));
  });

  it("finds the user message a card sent, and only that one", async () => {
    const { threads } = fakeThreads([{ id: "m1", preview: "Plan: B" }, { id: "m2", preview: "hello" }]);
    await recordReply(threads, "t", "Plan:   B", "a1#openui-lang#0", "Which plan?");
    const { replies } = await loadReplies(threads, "t");
    expect(replies.get("m1")).toEqual([{ source: "a1#openui-lang#0", at: expect.any(Number), quote: "Which plan?" }]);
    expect(replies.has("m2")).toBe(false);
  });

  it("skips the outline when the thread has no replies", async () => {
    const { threads } = fakeThreads([{ id: "m1", preview: "hi" }]);
    await loadReplies(threads, "t");
    expect(threads.conversationOutline).not.toHaveBeenCalled();
  });

  it("shares one load across a thread's headers, and reloads for a just-sent message", async () => {
    const { threads, items } = fakeThreads([{ id: "m1", preview: "old" }]);
    await recordReply(threads, "t", "new answer", "src");
    const now = Date.now();
    await Promise.all([replyFor(threads, "t", "m1", now), replyFor(threads, "t", "m1", now)]);
    expect(threads.getPluginMetadata).toHaveBeenCalledTimes(1);
    items.push({ id: "m2", preview: "new answer" });
    vi.useFakeTimers({ now: now + 2000 });
    expect(await replyFor(threads, "t", "m2", now + 2000)).toEqual({ source: "src", at: expect.any(Number) });
    expect(threads.getPluginMetadata).toHaveBeenCalledTimes(2);
  });

  it("does not reload for an old message it has not seen", async () => {
    const { threads } = fakeThreads([]);
    await recordReply(threads, "t", "x", "src");
    expect(await replyFor(threads, "t", "gone", 0)).toBeNull();
    expect(threads.getPluginMetadata).toHaveBeenCalledTimes(1);
  });

  it("matches a short answer only to the record sent near it", () => {
    const at = 1_000_000_000;
    const replies = [{ source: "first", at }, { source: "second", at: at + 10 * 60_000 }];
    expect(nearest(replies, at + 1000)?.source).toBe("first");
    expect(nearest(replies, at + 9 * 60_000)?.source).toBe("second");
    // A typed "Yes" an hour later, or long before, is not a card's reply.
    expect(nearest(replies, at + 60 * 60_000)).toBeNull();
    expect(nearest(replies, at - 5 * 60_000)).toBeNull();
  });
});
