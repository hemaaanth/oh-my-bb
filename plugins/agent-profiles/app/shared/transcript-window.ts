import type { Reaction, RoomMessage } from "../../server/channels/contract";

export const TRANSCRIPT_PAGE_SIZE = 50;
export const TRANSCRIPT_WINDOW_SIZE = 150;
export type TranscriptPage = {
  messages: RoomMessage[];
  parents: RoomMessage[];
  reactions: Reaction[];
  hasOlder: boolean;
  hasNewer: boolean;
};

/** Keep only a contiguous, bounded window as the reader moves through history. */
export function extendTranscript(
  current: TranscriptPage,
  page: TranscriptPage,
  direction: "older" | "newer",
): TranscriptPage {
  const combined = direction === "older"
    ? [...page.messages, ...current.messages]
    : [...current.messages, ...page.messages];
  const unique = [...new Map(combined.map((message) => [message.id, message])).values()];
  const messages = direction === "older"
    ? unique.slice(0, TRANSCRIPT_WINDOW_SIZE)
    : unique.slice(-TRANSCRIPT_WINDOW_SIZE);
  const ids = new Set(messages.map((message) => message.id));
  const parentIds = new Set(messages.map((message) => message.replyTo));
  const refreshed = new Set(page.messages.map((message) => message.id));
  return {
    messages,
    parents: [...new Map([...current.parents, ...page.parents].map((message) => [message.id, message])).values()]
      .filter((message) => parentIds.has(message.id)),
    reactions: [
      ...current.reactions.filter((reaction) => !refreshed.has(reaction.messageId)),
      ...page.reactions,
    ].filter((reaction) => ids.has(reaction.messageId)),
    hasOlder: direction === "older"
      ? page.hasOlder
      : current.hasOlder || unique.length > messages.length,
    hasNewer: direction === "newer"
      ? page.hasNewer
      : current.hasNewer || unique.length > messages.length,
  };
}
