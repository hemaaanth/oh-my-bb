// Shortcut rows with a recorder (SPEC §12.5, §6.6). "Change" listens for the
// next key press. A reserved or unusable combination is refused with a reason.
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { Note, Row } from "./layout.js";
import { checkHotkey, formatHotkey, hotkeyKeys } from "./hotkey.js";

const isMac = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "OS"]);

/** The key a press names. Alt changes `key` on a Mac, so letters and digits come from `code`. */
function keyOf(event: KeyboardEvent): string {
  const letter = /^Key([A-Z])$/.exec(event.code);
  if (letter?.[1]) return letter[1];
  const digit = /^Digit(\d)$/.exec(event.code);
  if (digit?.[1]) return digit[1];
  return event.key;
}

export function Keys({ combo }: { combo: string }) {
  return (
    <span className="inline-flex gap-1" aria-label={hotkeyKeys(combo, isMac()).join(" ")}>
      {hotkeyKeys(combo, isMac()).map((key, index) => (
        <kbd key={`${key}-${index}`} className="rounded border border-input bg-state-hover px-1.5 py-0.5 text-xs font-medium text-foreground">
          {key}
        </kbd>
      ))}
    </span>
  );
}

export function ShortcutRow({
  label,
  help,
  combo,
  defaultCombo,
  otherCombo,
  onSave,
}: {
  label: string;
  help: string;
  combo: string;
  defaultCombo: string;
  /** The other action's shortcut. Two actions cannot share one. */
  otherCombo: string;
  onSave: (combo: string) => Promise<boolean>;
}) {
  const [recording, setRecording] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      if (MODIFIER_KEYS.has(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        setRecording(false);
        setRefusal(null);
        return;
      }
      const raw = formatHotkey({ mod: event.ctrlKey || event.metaKey, shift: event.shiftKey, alt: event.altKey, key: keyOf(event) });
      const verdict = raw === null ? ({ ok: false, reason: "That key cannot be a shortcut." } as const) : checkHotkey(raw);
      if (!verdict.ok) return setRefusal(verdict.reason);
      if (verdict.combo === otherCombo) return setRefusal("The other shortcut already uses that combination.");
      setRefusal(null);
      setRecording(false);
      void onSave(verdict.combo);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, otherCombo, onSave]);

  return (
    <Row label={label} help={help}>
      <div className="flex flex-wrap items-center gap-2">
        {recording ? <span className="text-sm text-muted-foreground">Press the new keys…</span> : <Keys combo={combo} />}
        {recording ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRecording(false);
              setRefusal(null);
            }}
          >
            Cancel
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setRecording(true)}>
            Change
          </Button>
        )}
        {combo !== defaultCombo ? <Button variant="ghost" size="sm" disabled={recording} onClick={() => void onSave(defaultCombo)}>
          Reset to default
        </Button> : null}
      </div>
      {refusal ? <Note tone="error">{refusal}</Note> : null}
    </Row>
  );
}
