// Thread notices for the live call (SPEC §15, frontend side). Notices that
// arrive close together wait for a short window and become one digest. The
// call controller decides when to speak it: never while a response is running.

import type { ThreadNoticePayload } from "@/shared/contract.js";

export const NOTICE_WINDOW_MS = 3000;

/** The out-of-band text the model reads. One line per thread. */
export function noticeDigest(notices: readonly ThreadNoticePayload[]): string {
  const lines = notices.map((notice) => {
    const title = notice.title.trim() || "Untitled thread";
    const what = notice.kind === "failed" ? "failed" : "finished";
    const detail = notice.detail.trim();
    return `- "${title}" (thread ${notice.threadId}) ${what}.${detail ? ` Detail: ${detail}` : ""}`;
  });
  return [
    "System notice, not from the user. Thread updates:",
    ...lines,
    "Read each thread before you speak. Then say one short line per thread, by its title.",
  ].join("\n");
}

export class NoticeBatcher {
  private pending: ThreadNoticePayload[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deliver: (digest: string) => void,
    private readonly windowMs = NOTICE_WINDOW_MS,
  ) {}

  add(notice: ThreadNoticePayload) {
    // A second notice for the same thread replaces the first.
    this.pending = [...this.pending.filter((item) => item.threadId !== notice.threadId), notice];
    this.timer ??= setTimeout(() => this.flush(), this.windowMs);
  }

  /** The call ended. Nothing is spoken. */
  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
  }

  private flush() {
    this.timer = null;
    const notices = this.pending;
    this.pending = [];
    if (notices.length > 0) this.deliver(noticeDigest(notices));
  }
}
