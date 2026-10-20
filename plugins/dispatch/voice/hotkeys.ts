// Keyboard shortcuts for the call (SPEC §6.6). A shortcut is stored as one
// canonical string: zero or more of Mod, Shift, Alt in that order, then one
// key. Mod is ⌘ on macOS and iOS and Ctrl elsewhere. The settings recorder
// writes these strings; this file reads them and matches key presses.

import { RESERVED_HOTKEYS } from "@/shared/constants.js";

export interface Hotkey {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** Upper-case letter or digit, punctuation, "Space", "Enter", "F5" and so on. */
  key: string;
}

const MODIFIERS: Record<string, "mod" | "shift" | "alt"> = {
  mod: "mod", cmd: "mod", command: "mod", meta: "mod", ctrl: "mod", control: "mod",
  shift: "shift",
  alt: "alt", option: "alt",
};
const NAMED_KEYS = ["Space", "Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"];
const PUNCTUATION = "`-=[]\;',./";

function canonicalKey(raw: string): string | null {
  if (raw === " ") return "Space";
  if (raw.length === 1) {
    const upper = raw.toUpperCase();
    return /^[A-Z0-9]$/.test(upper) || PUNCTUATION.includes(raw) ? upper : null;
  }
  const named = NAMED_KEYS.find((name) => name.toLowerCase() === raw.toLowerCase());
  if (named) return named;
  const fn = /^f([1-9]|1\d|2[0-4])$/i.exec(raw);
  return fn ? `F${fn[1]}` : null;
}

/**
 * Parse a shortcut string in any modifier order and spelling. Returns null
 * for strings with no key (modifier-only), an unknown key, or an unknown
 * modifier.
 */
export function parseHotkey(input: string): Hotkey | null {
  const pieces = input.split("+").map((piece) => piece.trim());
  const last = pieces.pop();
  if (!last) return null;
  const key = canonicalKey(last);
  if (key === null) return null;
  const held = { mod: false, shift: false, alt: false };
  for (const piece of pieces) {
    const modifier = MODIFIERS[piece.toLowerCase()];
    if (!modifier) return null;
    held[modifier] = true;
  }
  return { ...held, key };
}

export function formatHotkey(hotkey: Hotkey): string {
  return [hotkey.mod && "Mod", hotkey.shift && "Shift", hotkey.alt && "Alt", hotkey.key].filter(Boolean).join("+");
}

/** The canonical string, or null when the input is not a shortcut. */
export function canonicalHotkey(input: string): string | null {
  const hotkey = parseHotkey(input);
  return hotkey ? formatHotkey(hotkey) : null;
}

/** What owns a reserved combination ("the BB command palette"), or null. */
export function reservedBy(input: string): string | null {
  const combo = canonicalHotkey(input);
  return combo ? RESERVED_HOTKEYS[combo] ?? null : null;
}

export function isApplePlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod|ios/i.test(platform);
}

/** "⌘" on macOS and iOS, "Ctrl" elsewhere. */
export const modLabel = (platform: string) => (isApplePlatform(platform) ? "⌘" : "Ctrl");

/** "⌘⇧H" on a Mac, "Ctrl+Shift+H" elsewhere. */
export function hotkeyLabel(combo: string, platform: string): string {
  const hotkey = parseHotkey(combo);
  if (!hotkey) return combo;
  const apple = isApplePlatform(platform);
  const parts = [
    hotkey.mod && modLabel(platform),
    hotkey.shift && (apple ? "⇧" : "Shift"),
    hotkey.alt && (apple ? "⌥" : "Alt"),
    hotkey.key,
  ].filter(Boolean);
  return parts.join(apple ? "" : "+");
}

type KeyEventLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;

/** The key a press means, by physical key when it is a letter or digit (Alt and Shift change `key`). */
function pressedKey(event: KeyEventLike): string | null {
  const code = /^Key([A-Z])$/.exec(event.code ?? "") ?? /^Digit(\d)$/.exec(event.code ?? "");
  if (code) return code[1]!;
  return canonicalKey(event.key);
}

/**
 * Does this key press match the shortcut exactly? Mod is the ⌘ key on Apple
 * platforms and Ctrl elsewhere; the other one must be up.
 */
export function matchesKeydown(combo: string, event: KeyEventLike, platform: string): boolean {
  const hotkey = parseHotkey(combo);
  if (!hotkey) return false;
  const apple = isApplePlatform(platform);
  const mod = apple ? event.metaKey : event.ctrlKey;
  const other = apple ? event.ctrlKey : event.metaKey;
  if (other || mod !== hotkey.mod || event.shiftKey !== hotkey.shift || event.altKey !== hotkey.alt) return false;
  return pressedKey(event) === hotkey.key;
}
