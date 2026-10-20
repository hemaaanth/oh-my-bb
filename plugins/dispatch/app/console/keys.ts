// Escape closes the transcript. A key press inside a field belongs to the
// field, so an input, a textarea, a select or an editable element is skipped.
import { useEffect } from "react";
import { useLatest } from "../settings/data.js";

export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
}

export function useEscape(enabled: boolean, onEscape: () => void) {
  const latest = useLatest(onEscape);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (isEditable(event.target)) return;
      latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, latest]);
}
