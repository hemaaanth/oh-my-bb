import { describe, expect, it } from "vitest";
import { analyse, readTracks } from "./transcript.js";
import type { Value } from "./types.js";

function analysis(value: Value) {
  const read = readTracks(value);
  if (!read.ok) throw new Error(read.error);
  const result = analyse(read.tracks);
  if (!result) throw new Error("No transcript to compare.");
  return result;
}

describe("transcript comparison", () => {
  it("counts a substitution against the reference rather than the candidate length", () => {
    const result = analysis([{ name: "Reference", text: "we ship today" }, { name: "Candidate", text: "we ship tomorrow please" }]);
    expect(result.comparisons[0]?.counts).toMatchObject({ words: 3, hits: 2, substitutions: 1, insertions: 1, deletions: 0 });
    expect(result.comparisons[0]?.wer).toBeCloseTo(2 / 3);
  });

  it("does not invent a word error rate when the reference is empty", () => {
    const result = analysis([{ name: "Reference", text: "" }, { name: "Candidate", text: "hello" }]);
    expect(result.comparisons[0]?.wer).toBeNull();
    expect(result.comparisons[0]?.counts.insertions).toBe(1);
  });

  it("keeps subtitle word timing marked as an estimate and invalid recognizer times untimed", () => {
    const result = readTracks([{ name: "Captions", text: "WEBVTT\n\n00:01.000 --> 00:03.000\nHello there\n" }, { name: "Recognizer", words: [{ text: "Hello", start: 3, end: 1 }] }]);
    if (!result.ok) throw new Error(result.error);
    expect(result.tracks[0]?.words.map(word => word.timing)).toEqual(["segment", "segment"]);
    expect(result.tracks[1]?.words[0]).toMatchObject({ start: null, end: null, timing: "none" });
    expect(result.tracks[1]?.untimed).toBe(1);
  });
});
