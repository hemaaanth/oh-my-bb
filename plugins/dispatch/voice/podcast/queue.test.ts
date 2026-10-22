import { describe, expect, it } from "vitest";
import { PodcastQueue, PodcastVad } from "./queue.js";
import type { PodcastSpeech } from "../../shared/podcast.js";
const speech = (id: string, updateId: string | null = null): PodcastSpeech => ({ id, updateId, projectId: "a", speaker: "A", text: id });
describe("Podcast speaking order", () => {
  it("cancels stale answers and keeps independent updates on interruption", () => {
    const queue = new PodcastQueue();
    queue.add([speech("answer"), speech("update", "event")]);
    const old = queue.generation; queue.interrupt();
    queue.add([speech("late-answer")], old);
    expect(queue.next()?.id).toBe("update"); expect(queue.length).toBe(1);
    queue.heard("update"); queue.add([speech("update", "event")]); expect(queue.next()).toBeNull();
  });
  it("prioritizes the user's answer and holds pending updates without deleting them", () => {
    const queue = new PodcastQueue(); queue.add([speech("update", "event"), speech("answer")]);
    expect(queue.next(true)?.id).toBe("answer"); queue.heard("answer");
    expect(queue.next(true)).toBeNull(); expect(queue.next(false)?.id).toBe("update");
  });
  it("removes queued presence for projects that no longer have open threads", () => {
    const queue = new PodcastQueue(); queue.add([speech("old-project", "event"), { ...speech("other"), projectId: "b" }]);
    queue.retainProjects(new Set(["b"])); expect(queue.next()?.projectId).toBe("b"); expect(queue.length).toBe(1);
  });
  it("deduplicates update redelivery and accepts a new answer after interruption", () => {
    const queue = new PodcastQueue(); queue.add([speech("update", "event")]); queue.interrupt();
    queue.add([speech("update", "event"), speech("new-answer")]);
    expect(queue.length).toBe(2); expect(queue.next()?.id).toBe("new-answer");
  });
});
describe("Podcast microphone turn detection", () => {
  it("ignores a transient click, starts on sustained speech, and commits only after a real pause", () => {
    const events: string[] = []; const vad = new PodcastVad(() => events.push("start"), () => events.push("commit"));
    vad.sample(0.2, 0); vad.sample(0, 50); expect(events).toEqual([]);
    vad.sample(0.1, 100); vad.sample(0.1, 150); expect(events).toEqual(["start"]);
    vad.sample(0, 800); expect(vad.speaking).toBe(true);
    vad.sample(0, 901); expect(events).toEqual(["start", "commit"]);
    vad.sample(0, 1800); expect(events).toHaveLength(2);
  });
});
