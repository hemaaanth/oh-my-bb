import { describe, expect, it } from "vitest";
import { canonicalHotkey, hotkeyLabel, matchesKeydown, modLabel, parseHotkey, reservedBy } from "./hotkeys.js";

const press = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = {}, code = "") => ({
  key, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods,
});

describe("shortcut strings", () => {
  it("parses into the canonical form", () => {
    expect(canonicalHotkey("Mod+Shift+H")).toBe("Mod+Shift+H");
    expect(canonicalHotkey("mod+shift+h")).toBe("Mod+Shift+H");
    expect(canonicalHotkey("Cmd+Option+space")).toBe("Mod+Alt+Space");
    expect(canonicalHotkey("Ctrl+f5")).toBe("Mod+F5");
  });

  it("orders modifiers Mod, Shift, Alt", () => {
    expect(canonicalHotkey("Alt+Shift+Mod+U")).toBe("Mod+Shift+Alt+U");
    expect(canonicalHotkey("Shift+Alt+K")).toBe("Shift+Alt+K");
  });

  it("rejects modifier-only and unknown strings", () => {
    expect(parseHotkey("Mod+Shift")).toBeNull();
    expect(parseHotkey("Mod+Shift+")).toBeNull();
    expect(parseHotkey("")).toBeNull();
    expect(parseHotkey("Hyper+H")).toBeNull();
    expect(parseHotkey("Mod+Volume")).toBeNull();
  });

  it("refuses the combinations BB reserves, naming the owner", () => {
    expect(reservedBy("Mod+Shift+P")).toBe("the BB command palette");
    expect(reservedBy("shift+mod+m")).toBe("the BB model picker");
    expect(reservedBy("Mod+Shift+H")).toBeNull();
  });

  it("maps Mod to ⌘ on Apple platforms and Ctrl elsewhere", () => {
    expect(modLabel("macOS")).toBe("⌘");
    expect(modLabel("iOS")).toBe("⌘");
    expect(modLabel("MacIntel")).toBe("⌘");
    expect(modLabel("Windows")).toBe("Ctrl");
    expect(modLabel("Linux")).toBe("Ctrl");
    expect(hotkeyLabel("Mod+Shift+H", "macOS")).toBe("⌘⇧H");
    expect(hotkeyLabel("Mod+Shift+H", "Windows")).toBe("Ctrl+Shift+H");
  });
});

describe("matchesKeydown", () => {
  it("matches the key and every modifier exactly", () => {
    expect(matchesKeydown("Mod+Shift+H", press("H", { metaKey: true, shiftKey: true }, "KeyH"), "macOS")).toBe(true);
    expect(matchesKeydown("Mod+Shift+H", press("H", { ctrlKey: true, shiftKey: true }, "KeyH"), "Windows")).toBe(true);
    // Ctrl is not Mod on a Mac, and ⌘ is not Mod elsewhere.
    expect(matchesKeydown("Mod+Shift+H", press("H", { ctrlKey: true, shiftKey: true }, "KeyH"), "macOS")).toBe(false);
    expect(matchesKeydown("Mod+Shift+H", press("H", { metaKey: true, shiftKey: true }, "KeyH"), "Linux")).toBe(false);
    // An extra or a missing modifier does not match.
    expect(matchesKeydown("Mod+Shift+H", press("H", { metaKey: true, shiftKey: true, altKey: true }, "KeyH"), "macOS")).toBe(false);
    expect(matchesKeydown("Mod+Shift+H", press("h", { metaKey: true }, "KeyH"), "macOS")).toBe(false);
    expect(matchesKeydown("Mod+Shift+H", press("J", { metaKey: true, shiftKey: true }, "KeyJ"), "macOS")).toBe(false);
  });

  it("reads letters by physical key when Alt changes the character", () => {
    expect(matchesKeydown("Mod+Alt+U", press("¨", { metaKey: true, altKey: true }, "KeyU"), "macOS")).toBe(true);
    expect(matchesKeydown("Mod+Space", press(" ", { ctrlKey: true }, "Space"), "Windows")).toBe(true);
  });
});
