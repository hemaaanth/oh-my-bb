import type { ComposerDraftSnapshot } from "@get-bb/plugin-sdk/app";
import { describe, expect, it } from "vitest";
import { appendComposerText, replaceComposerText } from "./draft.js";

const draft: ComposerDraftSnapshot = {
  text: "Read @repo and @thread",
  mentions: [
    { kind: "project", projectId: "p1", from: 5, to: 10, label: "@repo" },
    { kind: "thread", threadId: "t1", from: 15, to: 22, label: "@thread" },
  ],
  attachments: [{ type: "localFile", name: "notes.txt", path: "notes.txt", sourceProjectId: "p1" }],
};
const ranges = (next: ComposerDraftSnapshot) => next.mentions.map(({ from, to }) => [from, to]);

describe("replaceComposerText", () => {
  it("keeps uploads and moves kept mentions past Unicode text", () => {
    const next = replaceComposerText(draft, "😀 Check @repo");
    expect(next.mentions).toEqual([{ ...draft.mentions[0], from: 9, to: 14 }]);
    expect(next.attachments).toBe(draft.attachments);
    expect(draft.text).toBe("Read @repo and @thread");
  });

  it("drops removed mentions and never makes a pill from spoken @text", () => {
    expect(replaceComposerText(draft, "An unrelated @someone").mentions).toEqual([]);
  });

  it("keeps reordered mentions, sorted by offset, but drops one extended by word characters", () => {
    expect(ranges(replaceComposerText(draft, "@thread then @repo"))).toEqual([[0, 7], [13, 18]]);
    expect(replaceComposerText(draft, "@repository").mentions).toEqual([]);
  });

  it("matches the rendered text, not the pill's label", () => {
    const named = { ...draft, mentions: [{ ...draft.mentions[0]!, label: "Repository" }] };
    expect(ranges(replaceComposerText(named, "Check @repo"))).toEqual([[6, 11]]);
  });

  it("keeps repeated labels as separate pills that do not overlap", () => {
    const repeated = { ...draft, text: "Read @repo and @repo", mentions: [draft.mentions[0]!, { ...draft.mentions[0]!, from: 15, to: 20 }] };
    expect(ranges(replaceComposerText(repeated, "@repo @repo"))).toEqual([[0, 5], [6, 11]]);
  });

  it("drops a mention that could only overlap one already kept", () => {
    const spaced: ComposerDraftSnapshot = {
      text: "@a b | b @c",
      mentions: [
        { kind: "project", projectId: "p1", from: 0, to: 4, label: "A" },
        { kind: "project", projectId: "p2", from: 7, to: 11, label: "C" },
      ],
      attachments: [],
    };
    expect(ranges(replaceComposerText(spaced, "@a b @c"))).toEqual([[0, 4]]);
  });
});

describe("appendComposerText", () => {
  it("adds a space when the draft ends with a word", () => {
    const next = appendComposerText(draft, "please");
    expect(next.text).toBe("Read @repo and @thread please");
    expect(ranges(next)).toEqual([[5, 10], [15, 22]]);
    expect(next.attachments).toBe(draft.attachments);
  });

  it("adds a newline before several lines", () => {
    expect(appendComposerText(draft, "one\ntwo").text).toBe("Read @repo and @thread\none\ntwo");
  });

  it("adds nothing when the draft is empty or ends with whitespace", () => {
    expect(appendComposerText({ ...draft, text: "", mentions: [] }, "hi").text).toBe("hi");
    expect(appendComposerText({ ...draft, text: "Read @repo " }, "now").text).toBe("Read @repo now");
  });

  it("keeps mentions where they are, even when the same text appears earlier", () => {
    const later: ComposerDraftSnapshot = {
      text: "@repo vs @repo",
      mentions: [{ kind: "project", projectId: "p1", from: 9, to: 14, label: "@repo" }],
      attachments: [],
    };
    expect(ranges(appendComposerText(later, "ok"))).toEqual([[9, 14]]);
  });
});
