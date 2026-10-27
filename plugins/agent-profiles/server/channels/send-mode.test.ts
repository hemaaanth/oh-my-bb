import { describe, expect, it } from "vitest";
import {
  clearSentDraft,
  emptyDraft,
  prepareSend,
} from "../../app/shared/draft";
import { parseSendMode } from "../../app/shared/send-mode";

describe("channel send modes", () => {
  it("strips only a leading command and rejects conflicting modes", () => {
    expect(parseSendMode(" /fork @atlas Quick question? ")).toEqual({
      mode: "fork",
      text: "@atlas Quick question?",
    });
    expect(parseSendMode("/queue @atlas next")).toEqual({
      mode: "followup",
      text: "@atlas next",
    });
    expect(parseSendMode("/follow-up next")).toEqual({
      mode: "followup",
      text: "next",
    });
    expect(parseSendMode("Explain /fork please").mode).toBe("auto");
    expect(parseSendMode("/forklift status").mode).toBe("auto");
    expect(parseSendMode("/fork", "fork").text).toBe("");
    expect(() => parseSendMode("/fork hi", "steer")).toThrow(/conflicts/);
  });

  it("includes the mode in retry identity and preserves a changed draft", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    };
    const first = prepareSend(storage, "draft", "room", {
      ...emptyDraft(),
      text: "Question",
    });
    const retry = prepareSend(storage, "draft", "room", first.draft);
    expect(first.payload.requestId).toBe(retry.payload.requestId);

    const fork = prepareSend(storage, "draft", "room", {
      ...first.draft,
      sendMode: "fork",
    });
    expect(first.payload.requestId).not.toBe(fork.payload.requestId);
    expect(clearSentDraft(storage, "draft", first.draft)).toBe(false);
    expect(fork.payload.sendMode).toBe("fork");
  });
});
