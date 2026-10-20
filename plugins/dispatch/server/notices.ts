// Thread notices (SPEC §15). When a thread finishes or fails, publish a short
// notice. The app decides whether to speak it. P3 listens with onThreadNotice
// to speak it on a phone call. Owned by P1.
import { CHANNELS } from "../shared/constants.js";
import type { ThreadNoticePayload } from "../shared/contract.js";
import type { ServerContext } from "./context.js";
import { threadTitle } from "./tools/live.js";
import { threadOutcome } from "./tools/outcome.js";

/** Notice detail is compacted to about this many characters. */
export const NOTICE_DETAIL_TARGET = 600;
/** A sentence end earlier than this share of the target is too short to cut at. */
const MIN_CUT_SHARE = 0.5;

/**
 * Collapse whitespace and cut near the target at a sentence end. Without a
 * usable sentence end, cut at a word and add an ellipsis.
 */
export function compactDetail(text: string, target: number = NOTICE_DETAIL_TARGET): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= target) return flat;
  const window = flat.slice(0, target + 1);
  let cut = -1;
  for (const match of window.matchAll(/[.!?](?=\s|$)/g)) cut = match.index + 1;
  if (cut >= target * MIN_CUT_SHARE) return flat.slice(0, cut);
  const space = window.lastIndexOf(" ", target - 1);
  return `${flat.slice(0, space > 0 ? space : target - 1).trimEnd()}…`;
}

type NoticeListener = (notice: ThreadNoticePayload) => void;
const listeners = new Set<NoticeListener>();

/** Listen for notices on the server. Returns the unsubscribe function. */
export function onThreadNotice(listener: NoticeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type NoticeThread = { id: string; projectId: string | null; visibility: string; title: string | null; titleFallback: string | null };

/**
 * Hidden threads are skipped. Threads Dispatch started are the user's work,
 * so they are noticed like any other.
 */
const skipped = (thread: NoticeThread): boolean => thread.visibility === "hidden";

async function publishNotice(ctx: ServerContext, kind: ThreadNoticePayload["kind"], thread: NoticeThread, detail: string): Promise<void> {
  const notice: ThreadNoticePayload = {
    kind,
    threadId: thread.id,
    title: threadTitle(thread),
    detail: compactDetail(detail),
    projectId: thread.projectId,
  };
  ctx.bb.realtime.publish(CHANNELS.threadNotice, notice);
  for (const listener of listeners) {
    try {
      listener(notice);
    } catch {
      // One listener must not block the others.
    }
  }
}

async function outcomeSummary(ctx: ServerContext, threadId: string, errorsOnly: boolean): Promise<string | null> {
  try {
    return (await threadOutcome(ctx, threadId, { errorsOnly }))?.summary ?? null;
  } catch {
    return null;
  }
}

export async function noticeForIdle(ctx: ServerContext, thread: NoticeThread, lastAssistantText: string | null): Promise<void> {
  if (skipped(thread)) return;
  const text = lastAssistantText?.trim() || (await outcomeSummary(ctx, thread.id, false)) || "The thread finished.";
  await publishNotice(ctx, "finished", thread, text);
}

export async function noticeForFailure(ctx: ServerContext, thread: NoticeThread, error: string | null): Promise<void> {
  if (skipped(thread)) return;
  const text = (await outcomeSummary(ctx, thread.id, true)) || error?.trim() || "The thread failed.";
  await publishNotice(ctx, "failed", thread, text);
}

export function registerNotices(ctx: ServerContext): void {
  const report = (error: unknown) =>
    ctx.bb.log.warn(`Dispatch could not publish a thread notice: ${error instanceof Error ? error.message : "unknown error"}`);
  ctx.bb.events.on("thread.idle", (payload) => {
    noticeForIdle(ctx, payload.thread, payload.lastAssistantText).catch(report);
  });
  ctx.bb.events.on("thread.failed", (payload) => {
    noticeForFailure(ctx, payload.thread, payload.error).catch(report);
  });
}
