import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptGrouper, UTTERANCE_IDLE_MS, speechKind, type Utterance } from "./transcript.js";

afterEach(() => {
  vi.useRealTimers();
});

function grouper(options: ConstructorParameters<typeof TranscriptGrouper>[1] = {}) {
  const out: Utterance[] = [];
  let clock = 1000;
  const group = new TranscriptGrouper((utterance) => out.push(utterance), { now: () => clock, idleMs: 0, ...options });
  return { out, group, tick: (ms: number) => (clock += ms) };
}

describe("TranscriptGrouper", () => {
  it("appends fragments as received and flushes on a speaker change", () => {
    const { out, group } = grouper();
    group.push({ speaker: "user", text: "Start a ", startMs: 0, endMs: 300 });
    group.push({ speaker: "user", text: "thread", startMs: 300, endMs: 600 });
    expect(out).toEqual([]);
    expect(group.openSpeaker).toBe("user");
    group.push({ speaker: "agent", text: "Done.", startMs: 900, endMs: 1200 });
    expect(out).toEqual([{ speaker: "user", text: "Start a thread", at: 1000 }]);
    group.flush();
    expect(out.map((utterance) => utterance.text)).toEqual(["Start a thread", "Done."]);
    expect(group.openSpeaker).toBeNull();
  });

  it("splits one speaker on a session-timeline gap", () => {
    const { out, group } = grouper();
    group.push({ speaker: "agent", text: "One.", startMs: 0, endMs: 500 });
    group.push({ speaker: "agent", text: "Two.", startMs: 3000, endMs: 3500 });
    group.flush();
    expect(out.map((utterance) => utterance.text)).toEqual(["One.", "Two."]);
  });

  it("falls back to arrival times when fragments carry no times", () => {
    const { out, group, tick } = grouper();
    group.push({ speaker: "user", text: "Hi" });
    tick(500);
    group.push({ speaker: "user", text: " there" });
    tick(5000);
    group.push({ speaker: "user", text: "Again" });
    group.flush();
    expect(out.map((utterance) => utterance.text)).toEqual(["Hi there", "Again"]);
  });

  it("writes the open utterance after an idle period", () => {
    vi.useFakeTimers();
    const out: Utterance[] = [];
    const group = new TranscriptGrouper((utterance) => out.push(utterance));
    group.push({ speaker: "agent", text: "Still here." });
    vi.advanceTimersByTime(UTTERANCE_IDLE_MS - 1);
    expect(out).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(out.map((utterance) => utterance.text)).toEqual(["Still here."]);
  });

  it("skips empty and blank utterances, and dispose writes nothing", () => {
    const { out, group } = grouper();
    group.push({ speaker: "user", text: "" });
    group.push({ speaker: "user", text: "   " });
    group.flush();
    group.push({ speaker: "agent", text: "Lost" });
    group.dispose();
    group.flush();
    expect(out).toEqual([]);
  });

  it("names the trace kinds", () => {
    expect(speechKind("user")).toBe("speech.user");
    expect(speechKind("agent")).toBe("speech.agent");
  });
});
