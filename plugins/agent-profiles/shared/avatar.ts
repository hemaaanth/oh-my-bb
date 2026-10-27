import { avatarEmojis, providerAvatarEmojis } from "./avatar-data";

export { avatarEmojis } from "./avatar-data";

const iconNames = new Map(avatarEmojis.map((emoji) => [
  emoji.replaceAll("\uFE0F", ""),
  `agent-emoji-${emoji.codePointAt(0)!.toString(16)}`,
]));

/** App icons cover known single-codepoint emoji; free text and sequences use Bot. */
export function avatarIconName(avatar: string): string {
  return iconNames.get(avatar.replaceAll("\uFE0F", "")) ?? "Bot";
}

const providerIcons: Record<string, true> = Object.fromEntries(providerAvatarEmojis.map((emoji) => [avatarIconName(emoji), true]));

/** Provider icons must survive without the app bundle, so use declared SVGs only. */
export function providerAvatarIconName(avatar: string): string {
  const name = avatarIconName(avatar);
  return Object.hasOwn(providerIcons, name) ? `agent-profiles/${name}` : "Bot";
}
