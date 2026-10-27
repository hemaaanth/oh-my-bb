import { describe, expect, it, vi } from "vitest";
import { wrapMarkdown } from "./markdown-commands";
import { applyTextareaEdit, syncTextareaValue, type EditableTextarea } from "./markdown-textarea";

/** A textarea stand-in that records input events and assignments. */
class FakeTextarea implements EditableTextarea {
  selectionStart = 0;
  selectionEnd = 0;
  inputs = 0;
  #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  get value() {
    return this.#value;
  }
  set value(next: string) {
    this.#value = next;
    this.selectionStart = this.selectionEnd = next.length;
  }
  setSelectionRange(start: number | null, end: number | null) {
    this.selectionStart = start ?? 0;
    this.selectionEnd = end ?? this.selectionStart;
  }
  setRangeText(insert: string, start?: number, end?: number) {
    this.#value = this.#value.slice(0, start) + insert + this.#value.slice(end);
  }
  dispatchEvent(event: Event) {
    if (event.type === "input") this.inputs += 1;
    return true;
  }
  focus() {}
  /** What the browser does for execCommand("insertText"): replace the selection and fire input. */
  insertText(text: string) {
    this.#value = this.#value.slice(0, this.selectionStart) + text + this.#value.slice(this.selectionEnd);
    this.inputs += 1;
    return true;
  }
}

const bold = wrapMarkdown("**", "bold text");

describe("applyTextareaEdit", () => {
  it("inserts through execCommand so the edit lands on the native undo stack", () => {
    const textarea = new FakeTextarea("a word b");
    textarea.setSelectionRange(2, 6);
    const execCommand = vi.fn((command: string, _ui?: boolean, text?: string) =>
      command === "insertText" ? textarea.insertText(text ?? "") : false,
    );
    applyTextareaEdit(textarea, bold({ text: textarea.value, start: 2, end: 6 }), { execCommand });
    expect(execCommand).toHaveBeenCalledWith("insertText", false, "**word**");
    expect(textarea.value).toBe("a **word** b");
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([4, 8]);
    expect(textarea.inputs).toBe(1);
  });

  it("deletes through execCommand when an edit only removes text", () => {
    const textarea = new FakeTextarea("a **** b");
    const execCommand = vi.fn((command: string) => {
      if (command !== "delete") return false;
      return textarea.insertText("");
    });
    applyTextareaEdit(textarea, bold({ text: textarea.value, start: 4, end: 4 }), { execCommand });
    expect(execCommand).toHaveBeenCalledWith("delete", false, "");
    expect(textarea.value).toBe("a  b");
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 2]);
  });

  it("falls back to setRangeText and an input event when execCommand is unavailable", () => {
    const textarea = new FakeTextarea("a word b");
    applyTextareaEdit(textarea, bold({ text: textarea.value, start: 2, end: 6 }), { execCommand: () => false });
    expect(textarea.value).toBe("a **word** b");
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([4, 8]);
    expect(textarea.inputs).toBe(1);

    const detached = new FakeTextarea("x");
    applyTextareaEdit(detached, bold({ text: "x", start: 1, end: 1 }), undefined);
    expect(detached.value).toBe("x**bold text**");
  });
});

describe("syncTextareaValue", () => {
  it("shows an external value without firing input and keeps the selection", () => {
    const textarea = new FakeTextarea("draft text");
    textarea.setSelectionRange(2, 5);
    expect(syncTextareaValue(textarea, "saved text from elsewhere")).toBe(true);
    expect(textarea.value).toBe("saved text from elsewhere");
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 5]);
    expect(textarea.inputs).toBe(0);
  });

  it("clamps the selection to a shorter value", () => {
    const textarea = new FakeTextarea("a longer draft");
    textarea.setSelectionRange(4, 12);
    syncTextareaValue(textarea, "short");
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([4, 5]);
  });

  it("leaves the textarea alone when the value already matches", () => {
    const textarea = new FakeTextarea("same");
    textarea.setSelectionRange(1, 2);
    expect(syncTextareaValue(textarea, "same")).toBe(false);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([1, 2]);
  });
});
