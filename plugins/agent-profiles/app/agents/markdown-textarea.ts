import { applyMarkdownEdit, type MarkdownEdit } from "./markdown-commands";

/** The slice of HTMLTextAreaElement the editor helpers use. */
export type EditableTextarea = Pick<
  HTMLTextAreaElement,
  "value" | "selectionStart" | "selectionEnd" | "setSelectionRange" | "setRangeText" | "dispatchEvent" | "focus"
>;
type CommandDocument = Pick<Document, "execCommand">;

/**
 * Apply a toolbar edit as native input so the browser's undo stack records it.
 * `insertText` keeps Ctrl+Z working; when the command is unavailable the edit
 * falls back to setRangeText plus a synthetic input event.
 */
export function applyTextareaEdit(
  textarea: EditableTextarea,
  edit: MarkdownEdit,
  doc: CommandDocument | undefined = globalThis.document,
): void {
  const expected = applyMarkdownEdit(textarea.value, edit);
  textarea.focus();
  textarea.setSelectionRange(edit.from, edit.to);
  if (edit.from !== edit.to || edit.insert) {
    let applied = false;
    try {
      applied = doc?.execCommand(edit.insert ? "insertText" : "delete", false, edit.insert) ?? false;
    } catch {
      applied = false;
    }
    if (!applied && textarea.value !== expected) {
      textarea.setRangeText(edit.insert, edit.from, edit.to, "end");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
}

/**
 * Show a value that changed outside the editor. Assigning `value` does not
 * fire input events, so onChange stays quiet; the selection is kept where it
 * still fits. Returns whether the textarea changed.
 */
export function syncTextareaValue(textarea: EditableTextarea, value: string): boolean {
  if (textarea.value === value) return false;
  const { selectionStart, selectionEnd } = textarea;
  textarea.value = value;
  textarea.setSelectionRange(Math.min(selectionStart, value.length), Math.min(selectionEnd, value.length));
  return true;
}
