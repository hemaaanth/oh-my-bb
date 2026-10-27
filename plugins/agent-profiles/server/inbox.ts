import type Database from "better-sqlite3";

/** The DM's next turn shows at most this many reports. Older unread ones are counted. */
export const INBOX_SHOWN = 20;
const REQUEST_CHARS = 600;
const REPLY_CHARS = 1_500;

export type InboxSource = "task" | "channel";

export interface InboxReport {
  profileId: string;
  source: InboxSource;
  threadId: string;
  /** Where the work happened: a task title or a channel name. */
  place: string;
  request: string;
  reply: string;
}

type Row = {
  id: number;
  source: InboxSource;
  threadId: string;
  place: string;
  request: string;
  reply: string;
  createdAt: number;
};

/**
 * Full agents do work outside their DM: delegated tasks, sequence steps, and
 * channel turns. Each finished turn leaves one report here. The DM's next turn
 * receives the unread reports, so the agent remembers that work as its own.
 * Thin agents never write here; they stay stateless.
 */
export interface AgentInbox {
  record(report: InboxReport): void;
  /** Text for the DM's next turn, or null. The reports stay unread until `settle`. */
  take(profileId: string, dmThreadId: string): string | null;
  /** The DM turn finished. Mark the reports it received as read. */
  settle(dmThreadId: string): void;
  /** The DM turn failed. Its reports stay unread for the next turn. */
  release(dmThreadId: string): void;
}

function clip(text: string, limit: number) {
  const value = text.trim().replace(/\s+\n/gu, "\n");
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
}

function stamp(ms: number) {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function line(row: Row) {
  const where = row.source === "channel"
    ? `In the #${row.place} channel (@thread:${row.threadId})`
    : `In your task "${row.place}" (@thread:${row.threadId})`;
  const asked = row.source === "channel" ? "The message to you was" : "You were asked";
  const answered = row.source === "channel" ? "You replied" : "You answered";
  return `- ${stamp(row.createdAt)} UTC. ${where}. ${asked}:\n  > ${clip(row.request, REQUEST_CHARS).replace(/\n/gu, "\n  > ")}\n  ${answered}:\n  > ${clip(row.reply, REPLY_CHARS).replace(/\n/gu, "\n  > ")}`;
}

export function formatInbox(rows: readonly Row[], older: number) {
  return [
    "[Your work outside this DM since your last turn]",
    "You did this work yourself in other threads and channels. Remember it as your own. Use it when it is relevant. Do not recite it back.",
    "",
    ...(older ? [`(${older} older report${older === 1 ? "" : "s"} not shown.)`] : []),
    ...rows.map(line),
  ].join("\n");
}

export function createAgentInbox(db: Database.Database, now: () => number = Date.now): AgentInbox {
  const latest = db.prepare(`SELECT reply FROM agent_inbox WHERE thread_id = ? ORDER BY id DESC LIMIT 1`);
  const insert = db.prepare(`INSERT INTO agent_inbox
    (profile_id, source, thread_id, place, request, reply, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const unread = db.prepare(`SELECT id, source, thread_id AS threadId, place, request, reply,
    created_at AS createdAt FROM agent_inbox
    WHERE profile_id = ? AND delivered_at IS NULL ORDER BY id DESC LIMIT ?`);
  const unreadCount = db.prepare(`SELECT count(*) AS count FROM agent_inbox
    WHERE profile_id = ? AND delivered_at IS NULL`);
  const markRead = db.prepare(`UPDATE agent_inbox SET delivered_at = ?
    WHERE profile_id = ? AND id <= ? AND delivered_at IS NULL`);
  // One DM turn at a time per thread, so one held delivery per DM thread.
  const held = new Map<string, { profileId: string; maxId: number }>();
  return {
    record(report) {
      const reply = report.reply.trim();
      if (!reply) return;
      // A replayed idle event for the same turn must not add a second report.
      const last = latest.get(report.threadId) as { reply: string } | undefined;
      if (last?.reply === reply) return;
      insert.run(report.profileId, report.source, report.threadId,
        clip(report.place, 120) || "untitled", report.request.trim(), reply, now());
    },
    take(profileId, dmThreadId) {
      const rows = (unread.all(profileId, INBOX_SHOWN) as Row[]).reverse();
      if (!rows.length) {
        held.delete(dmThreadId);
        return null;
      }
      const total = (unreadCount.get(profileId) as { count: number }).count;
      held.set(dmThreadId, { profileId, maxId: rows.at(-1)!.id });
      return formatInbox(rows, total - rows.length);
    },
    settle(dmThreadId) {
      const delivery = held.get(dmThreadId);
      if (!delivery) return;
      held.delete(dmThreadId);
      markRead.run(now(), delivery.profileId, delivery.maxId);
    },
    release(dmThreadId) {
      held.delete(dmThreadId);
    },
  };
}
