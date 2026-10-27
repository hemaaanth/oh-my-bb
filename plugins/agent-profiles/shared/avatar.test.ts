import { describe, expect, it } from "vitest";
import { avatarIconName, providerAvatarIconName } from "./avatar";

describe("agent avatar icons", () => {
  it.each(["🖊", "🖊️", "🖊️️"])("normalizes emoji presentation selectors in %s", (avatar) => {
    expect(avatarIconName(avatar)).toBe("agent-emoji-1f58a");
    expect(providerAvatarIconName(avatar)).toBe("agent-profiles/agent-emoji-1f58a");
  });

  it.each([
    ["🤖", "agent-emoji-1f916"],
    ["🌐", "agent-emoji-1f310"],
    ["☀️", "agent-emoji-2600"],
    ["🚀", "agent-emoji-1f680"],
  ])("uses the canonical name for known emoji %s", (avatar, name) => {
    expect(avatarIconName(avatar)).toBe(name);
  });

  it.each(["", "agent", "__proto__", "1", " 🤖", "🤖🤖", "👩‍💻", "🇮🇳", "👍🏽", "\u{10ffff}"])("falls back for unsupported free-text avatar %s", (avatar) => {
    expect(avatarIconName(avatar)).toBe("Bot");
    expect(providerAvatarIconName(avatar)).toBe("Bot");
  });

  it("keeps unsupported provider artwork generic even when an app icon exists", () => {
    expect(avatarIconName("🚀")).toBe("agent-emoji-1f680");
    expect(providerAvatarIconName("🚀")).toBe("Bot");
  });
});
