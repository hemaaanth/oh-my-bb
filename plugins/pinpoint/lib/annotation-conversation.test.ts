import { describe, expect, it } from "vitest";
import { annotationConversation } from "./annotation-conversation";

describe("Pinpoint annotation conversation projection", () => {
  it("keeps the original human note ahead of an agent response", () => {
    expect(
      annotationConversation({
        comment: "Make this heading clearer",
        thread: [{ role: "agent", content: "Updated the heading" }],
      }),
    ).toEqual({
      authoredByAgent: false,
      messages: [
        { role: "human", content: "Make this heading clearer" },
        { role: "agent", content: "Updated the heading" },
      ],
    });
  });
  it("does not invent a human message for an empty comment", () => {
    expect(
      annotationConversation({
        comment: "",
        thread: [{ role: "agent", content: "Handled the text edit" }],
      }),
    ).toEqual({
      authoredByAgent: false,
      messages: [{ role: "agent", content: "Handled the text edit" }],
    });
  });


  it("does not duplicate an agent-authored opening note", () => {
    expect(
      annotationConversation({
        comment: "This spacing looks inconsistent",
        authorRole: "agent",
        thread: [
          { role: "agent", content: "This spacing looks inconsistent" },
          { role: "human", content: "Please tighten it" },
        ],
      }).messages,
    ).toEqual([
      { role: "agent", content: "This spacing looks inconsistent" },
      { role: "human", content: "Please tighten it" },
    ]);
  });
});
