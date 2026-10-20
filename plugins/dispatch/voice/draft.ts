// Composer text for the voice tools set_composer_text and append_composer_text
// (SPEC §6.2). Both keep the @mention pills whose text is still in the draft,
// moved to their new offsets, and drop the rest.
import type { ComposerDraftSnapshot } from "@get-bb/plugin-sdk/app";

type Mention = ComposerDraftSnapshot["mentions"][number];

const WORD = /[\p{L}\p{N}_-]/u;

/**
 * Replace the draft text. A mention survives when its rendered text appears
 * unchanged in the new text, not extended by more word characters ("@alice"
 * inside "@alicex" is gone), and not overlapping a mention already kept.
 * Attachments are kept as they are. Mentions come back sorted by offset.
 */
export function replaceComposerText(draft: ComposerDraftSnapshot, text: string): ComposerDraftSnapshot {
  const mentions: Mention[] = [];
  for (const mention of draft.mentions) {
    const content = draft.text.slice(mention.from, mention.to);
    if (!content) continue;
    let from = text.indexOf(content);
    while (from >= 0) {
      const to = from + content.length;
      const extendsName = WORD.test(content.at(-1)!) && WORD.test(text[to] ?? "");
      if (!extendsName && !mentions.some((kept) => from < kept.to && to > kept.from)) {
        mentions.push({ ...mention, from, to });
        break;
      }
      from = text.indexOf(content, from + 1);
    }
  }
  return { ...draft, text, mentions: mentions.sort((a, b) => a.from - b.from) };
}

/**
 * Add text after the draft. A space separates them, or a newline when the
 * added text has several lines, unless the draft is empty or already ends
 * with whitespace. The draft is a prefix of the result, so every mention
 * stays where it is.
 */
export function appendComposerText(draft: ComposerDraftSnapshot, text: string): ComposerDraftSnapshot {
  const separator = draft.text === "" || /\s$/u.test(draft.text) ? "" : text.includes("\n") ? "\n" : " ";
  return { ...draft, text: draft.text + separator + text, mentions: [...draft.mentions].sort((a, b) => a.from - b.from) };
}
