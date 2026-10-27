import { describe, expect, it } from "vitest";
import {
  clearSentDraft,
  emptyDraft,
  prepareSend,
  readDraft,
} from "./draft";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("channel composer draft", () => {
  it("reuses request identity after remount and changes it after an edit", () => {
    const storage = memoryStorage();
    const first = prepareSend(storage, "draft", crypto.randomUUID(), {
      ...emptyDraft(),
      text: "My message",
    });
    const retry = prepareSend(
      storage,
      "draft",
      first.payload.id,
      readDraft(storage, "draft"),
    );
    const edited = prepareSend(storage, "draft", first.payload.id, {
      ...retry.draft,
      text: "A new message",
    });

    expect(retry.payload).toEqual(first.payload);
    expect(edited.payload.requestId).not.toBe(first.payload.requestId);
  });

  it("does not clear text entered by a newer composer mount", () => {
    const storage = memoryStorage();
    const sent = prepareSend(storage, "draft", crypto.randomUUID(), {
      ...emptyDraft(),
      text: "First message",
    });
    storage.setItem(
      "draft",
      JSON.stringify({ ...sent.draft, text: "New unsent draft" }),
    );

    expect(clearSentDraft(storage, "draft", sent.draft)).toBe(false);
    expect(readDraft(storage, "draft").text).toBe("New unsent draft");

    storage.setItem("draft", JSON.stringify(sent.draft));
    expect(clearSentDraft(storage, "draft", sent.draft)).toBe(true);
    expect(readDraft(storage, "draft").text).toBe("");
  });
});
