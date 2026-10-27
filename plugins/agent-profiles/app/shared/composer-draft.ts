import type { ComposerDraftSnapshot } from "@get-bb/plugin-sdk/app";

// This stays in the app session. The New thread draft itself is never cleared.
const offers = new Map<string, ComposerDraftSnapshot>();
const listeners = new Set<() => void>();

export function offerDmDraft(threadId: string, draft: ComposerDraftSnapshot) {
  if (!draft.text.trim() && !draft.mentions.length && !draft.attachments.length) return;
  offers.set(threadId, draft);
  for (const listener of listeners) listener();
}

export function dmDraftOffer(threadId: string) {
  return offers.get(threadId);
}

export function subscribeDmDraftOffers(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function discardDmDraftOffer(threadId: string) {
  offers.delete(threadId);
  for (const listener of listeners) listener();
}
