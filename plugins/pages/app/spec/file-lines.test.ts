import { describe, expect, it } from "vitest";
import { snippetLines, snippetRangeError } from "./file-lines.js";

describe("source excerpt lines", () => {
  it("uses inclusive one-based lines and does not invent a final empty line", () => {
    expect(snippetLines("one\r\ntwo\r\nthree\r\n", 2, 99)).toEqual({ code: "two\nthree", error: null });
    expect(snippetLines("one\n", 2, null)).toMatchObject({ code: null });
    expect(snippetLines("", null, null)).toMatchObject({ code: null });
  });
  it("limits long excerpts from the requested line without changing their content", () => {
    const source = Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join("\n");
    const result = snippetLines(source, 10, null);
    expect(result.error).toBeNull();
    expect(result.code?.split("\n")).toEqual(Array.from({ length: 400 }, (_, index) => `line ${index + 10}`));
  });
  it("rejects reversed, fractional, and nonpositive ranges", () => {
    for (const [from, to] of [[5, 2], [0, 2], [1.5, 3], [1, -2]]) {
      expect(snippetRangeError(from, to)).toEqual(expect.any(String));
      expect(snippetLines("one\ntwo", from, to).code).toBeNull();
    }
  });
});
