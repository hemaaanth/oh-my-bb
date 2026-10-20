import { describe, expect, it } from "vitest";
import { checkHotkey, formatHotkey, hotkeyKeys, prettyHotkey } from "./hotkey.js";

describe("checkHotkey", () => {
  it("returns the canonical spelling", () => {
    expect(checkHotkey("mod+shift+k")).toEqual({ ok: true, combo: "Mod+Shift+K" });
    expect(checkHotkey("Ctrl+alt+space")).toEqual({ ok: true, combo: "Mod+Alt+Space" });
    expect(checkHotkey("cmd+f5")).toEqual({ ok: true, combo: "Mod+F5" });
  });

  it("refuses combinations BB already uses, and names the owner", () => {
    const palette = checkHotkey("Mod+Shift+P");
    expect(palette.ok).toBe(false);
    if (!palette.ok) expect(palette.reason).toContain("command palette");
    const models = checkHotkey("ctrl+shift+m");
    expect(models.ok).toBe(false);
    if (!models.ok) expect(models.reason).toContain("model picker");
  });

  it("refuses a key without Mod or Alt", () => {
    expect(checkHotkey("K").ok).toBe(false);
    expect(checkHotkey("Shift+K").ok).toBe(false);
  });

  it("refuses unknown keys and modifiers", () => {
    expect(checkHotkey("Mod+").ok).toBe(false);
    expect(checkHotkey("Mod+Banana").ok).toBe(false);
    expect(checkHotkey("Hyper+K").ok).toBe(false);
    expect(checkHotkey("Mod+F25").ok).toBe(false);
  });
});

describe("formatHotkey and display", () => {
  it("orders modifiers and uppercases letters", () => {
    expect(formatHotkey({ mod: true, shift: true, alt: true, key: "j" })).toBe("Mod+Shift+Alt+J");
    expect(formatHotkey({ mod: true, shift: false, alt: false, key: " " })).toBe("Mod+Space");
    expect(formatHotkey({ mod: true, shift: false, alt: false, key: "Dead" })).toBeNull();
  });

  it("shows key caps per platform", () => {
    expect(hotkeyKeys("Mod+Shift+K", true)).toEqual(["⌘", "⇧", "K"]);
    expect(prettyHotkey("Mod+Shift+K")).toBe("Ctrl+Shift+K");
    expect(prettyHotkey("Mod+Alt+K", true)).toBe("⌘⌥K");
  });
});
