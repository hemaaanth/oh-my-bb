// Shortcut strings (SPEC §6.6). Pure, no DOM: the recorder, the import and
// the tests all read this one parser. A shortcut is "Mod", "Shift" and "Alt" in
// that order, then one key.
import { RESERVED_HOTKEYS } from "../../shared/constants.js";

const MODIFIERS = ["Mod", "Shift", "Alt"] as const;
const MODIFIER_ALIASES: Record<string, (typeof MODIFIERS)[number]> = {
  mod: "Mod",
  cmd: "Mod",
  command: "Mod",
  meta: "Mod",
  ctrl: "Mod",
  control: "Mod",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
};
const NAMED_KEYS = new Set([
  "Space",
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
const PUNCTUATION = "`-=[]\\;',./";

/** The canonical spelling of one key name, or null when it is not a usable key. */
function canonicalKey(raw: string): string | null {
  if (raw === " ") return "Space";
  if (raw.length === 1) {
    const upper = raw.toUpperCase();
    return /^[A-Z0-9]$/.test(upper) || PUNCTUATION.includes(raw) ? upper : null;
  }
  const lower = raw.toLowerCase();
  for (const name of NAMED_KEYS) if (name.toLowerCase() === lower) return name;
  const fn = /^f([1-9]|1\d|2[0-4])$/.exec(lower);
  return fn ? `F${fn[1]}` : null;
}

/** Build the canonical string from a key and the modifiers held with it. */
export function formatHotkey(parts: { mod: boolean; shift: boolean; alt: boolean; key: string }): string | null {
  const key = canonicalKey(parts.key);
  if (key === null) return null;
  const held = [parts.mod && "Mod", parts.shift && "Shift", parts.alt && "Alt"].filter(Boolean);
  return [...held, key].join("+");
}

export type HotkeyCheck = { ok: true; combo: string } | { ok: false; reason: string };

/**
 * Validate a stored or typed shortcut and return its canonical form. A usable
 * shortcut holds Mod or Alt, so it can never swallow plain typing. Combinations
 * BB already uses are refused with the name of their owner.
 */
export function checkHotkey(input: string): HotkeyCheck {
  const pieces = input.split("+");
  const key = pieces.pop();
  if (key === undefined || key === "") return { ok: false, reason: "Press a key together with Ctrl, ⌘ or Alt." };
  const held = new Set<string>();
  for (const piece of pieces) {
    const modifier = MODIFIER_ALIASES[piece.trim().toLowerCase()];
    if (!modifier) return { ok: false, reason: "That is not a shortcut." };
    held.add(modifier);
  }
  const combo = formatHotkey({ mod: held.has("Mod"), shift: held.has("Shift"), alt: held.has("Alt"), key });
  if (combo === null) return { ok: false, reason: "That key cannot be a shortcut." };
  if (!held.has("Mod") && !held.has("Alt")) return { ok: false, reason: "Hold Ctrl, ⌘ or Alt together with the key." };
  const owner = RESERVED_HOTKEYS[combo];
  if (owner) return { ok: false, reason: `${prettyHotkey(combo)} belongs to ${owner}. Pick another combination.` };
  return { ok: true, combo };
}

/** Key caps for display, for example ["⌘", "⇧", "H"] on a Mac and ["Ctrl", "Shift", "H"] elsewhere. */
export function hotkeyKeys(combo: string, mac: boolean): string[] {
  return combo.split("+").map((piece) => {
    if (piece === "Mod") return mac ? "⌘" : "Ctrl";
    if (piece === "Shift") return mac ? "⇧" : "Shift";
    if (piece === "Alt") return mac ? "⌥" : "Alt";
    return piece;
  });
}

export function prettyHotkey(combo: string, mac = false): string {
  return hotkeyKeys(combo, mac).join(mac ? "" : "+");
}
