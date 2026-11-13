// Which user messages are answers sent from a Pages card. BB keeps no plugin origin on a message,
// and it strips hidden parts from what plugins can read back. So the send records the visible text
// in this thread's plugin metadata, and the header above each user message matches its preview
// and its send time. Time keeps a short answer such as "Yes" from matching every "Yes".

/** The source card of one reply: its fence key, when the answer was sent, and what the header quotes. */
export type Reply = { source: string; at: number; quote?: string };

type OutlineItem = { id: string; preview: string };

/** The part of the SDK this needs. Plugin metadata calls are bound to Pages by the host. */
export type ReplyThreads = {
  getPluginMetadata(args: { threadId: string }): Promise<Record<string, unknown>>;
  updatePluginMetadata(args: { threadId: string; set: Record<string, Reply> }): Promise<unknown>;
  conversationOutline(args: { threadId: string; role: "user" }): Promise<{ items: OutlineItem[] }>;
};

const PREFIX = "pages-reply:";
const PREVIEW_MAX = 200;

/** BB's outline preview of a message: whitespace collapsed, trimmed, at most 200 characters. */
export function previewOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= PREVIEW_MAX ? flat : flat.slice(0, PREVIEW_MAX).trimEnd();
}

/** A short FNV-1a hash of a message's preview. */
function previewHash(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of previewOf(text)) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** The metadata key for one reply: its preview hash and send time. Older keys have no time. */
export const replyKey = (text: string, at: number): string => `${PREFIX}${previewHash(text)}:${at}`;

/** Save that `text` was sent from the card `source`, before it is sent. */
export function recordReply(threads: ReplyThreads, threadId: string, text: string, source: string, quote?: string): Promise<unknown> {
  const at = Date.now();
  const reply: Reply = quote ? { source, at, quote } : { source, at };
  // A host without the call throws at once; a promise keeps that from stopping the send.
  return Promise.resolve().then(() => threads.updatePluginMetadata({ threadId, set: { [replyKey(text, at)]: reply } }));
}

function asReply(value: unknown): Reply | null {
  const reply = value as Partial<Reply> | null;
  if (!reply || typeof reply.source !== "string" || typeof reply.at !== "number") return null;
  return typeof reply.quote === "string" ? { source: reply.source, at: reply.at, quote: reply.quote } : { source: reply.source, at: reply.at };
}

/** What one load of a thread knows: the user message ids it saw, and the replies whose text each id has. */
export type ThreadReplies = { seen: Set<string>; replies: Map<string, Reply[]> };

/** Read a thread's replies. Skips the outline when the thread has none. */
export async function loadReplies(threads: ReplyThreads, threadId: string): Promise<ThreadReplies> {
  const metadata = await threads.getPluginMetadata({ threadId });
  const records = new Map<string, Reply[]>();
  for (const [key, value] of Object.entries(metadata ?? {})) {
    const reply = key.startsWith(PREFIX) ? asReply(value) : null;
    const hash = key.slice(PREFIX.length).split(":")[0];
    if (reply) records.set(hash, [...(records.get(hash) ?? []), reply]);
  }
  if (records.size === 0) return { seen: new Set(), replies: new Map() };
  const { items } = await threads.conversationOutline({ threadId, role: "user" });
  const replies = new Map<string, Reply[]>();
  for (const item of items) {
    const found = records.get(previewHash(item.preview));
    if (found) replies.set(item.id, found);
  }
  return { seen: new Set(items.map((item) => item.id)), replies };
}

/** How far a message's time may be from its record's: 2 min early for clock skew, 15 min late for a queued send. */
const EARLY_MS = 2 * 60_000;
const LATE_MS = 15 * 60_000;

/** The record sent nearest to a message created at `createdAt`, within the window. */
export function nearest(replies: Reply[] | undefined, createdAt: number): Reply | null {
  let best: Reply | null = null;
  for (const reply of replies ?? []) {
    const delay = createdAt - reply.at;
    if (delay < -EARLY_MS || delay > LATE_MS) continue;
    if (!best || Math.abs(delay) < Math.abs(createdAt - best.at)) best = reply;
  }
  return best;
}

const REFRESH_MS = 1500;
const cache = new Map<string, { at: number; load: Promise<ThreadReplies> }>();

/**
 * The reply for one message, or null. All headers of a thread share one load. A message sent in the
 * last minute that the load has not seen loads again, at most every 1.5 s, and once more a little later.
 */
export async function replyFor(threads: ReplyThreads, threadId: string, messageId: string, createdAt: number): Promise<Reply | null> {
  const get = (fresh: boolean) => {
    const hit = cache.get(threadId);
    if (hit && !(fresh && Date.now() - hit.at > REFRESH_MS)) return hit.load;
    const load = loadReplies(threads, threadId);
    cache.set(threadId, { at: Date.now(), load });
    load.catch(() => cache.delete(threadId));
    return load;
  };
  let known = await get(false);
  const recent = Date.now() - createdAt < 60_000;
  for (let tries = 0; recent && !known.seen.has(messageId) && tries < 2; tries++) {
    if (tries > 0) await new Promise((done) => setTimeout(done, REFRESH_MS + 100));
    known = await get(true);
  }
  return nearest(known.replies.get(messageId), createdAt);
}

/** Test seam: forget every cached load. */
export function clearReplyCache(): void {
  cache.clear();
}
