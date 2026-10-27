import type { z } from "zod";
import type { Store } from "./store";
import { attachmentSchema, messageSchema } from "./contract";
import { parseArtifactDirectives } from "../../lib/artifact-directives";
import {
  channelContext,
  contextContent,
  defaultLimits,
  type ChannelContext,
} from "./workspace-contract";

/** Versioned channel knowledge and snapshots of agent documents. */
export class ChannelData {
  constructor(readonly store: Store) {}

  context(id: string): ChannelContext {
    this.store.room(id);
    const row = this.store.db
      .prepare("SELECT json FROM channel_context WHERE room_id = ?")
      .get(id) as { json: string } | undefined;
    return row
      ? channelContext.parse(JSON.parse(row.json))
      : { ...contextContent.parse({}), version: 0, updatedAt: 0 };
  }

  saveContext(
    id: string,
    input: z.infer<typeof contextContent>,
    version: number,
    actor: string,
  ) {
    return this.store.db.transaction(() => {
      const previous = this.context(id);
      if (previous.version !== version)
        throw new Error(
          "Channel context changed. Reload before saving; your draft is preserved.",
        );
      for (const attachmentId of input.attachmentIds) {
        const attachment = this.store.attachment(attachmentId);
        if (
          attachment.roomId !== id ||
          !attachment.path ||
          !this.store.db
            .prepare(
              "SELECT 1 FROM room_messages m, json_each(m.json, '$.attachments') a WHERE m.room_id = ? AND json_extract(a.value, '$.id') = ? LIMIT 1",
            )
            .get(id, attachmentId)
        )
          throw new Error("Choose a sent file from this channel.");
      }
      this.snapshot(
        `channel:${id}`,
        JSON.stringify(previous),
        "Previous version",
      );
      const next = {
        ...input,
        version: previous.version + 1,
        updatedAt: Date.now(),
      };
      this.store.db
        .prepare(
          "INSERT INTO channel_context VALUES (?, ?) ON CONFLICT(room_id) DO UPDATE SET json = excluded.json",
        )
        .run(id, JSON.stringify(next));
      this.snapshot(`channel:${id}`, JSON.stringify(next), actor);
      return next;
    })();
  }

  snapshot(scope: string, text: string, actor: string) {
    const previous = this.store.db
      .prepare(
        "SELECT text FROM document_revisions WHERE scope = ? ORDER BY id DESC LIMIT 1",
      )
      .get(scope) as { text: string } | undefined;
    if (previous?.text === text) return;
    this.store.db
      .prepare(
        "INSERT INTO document_revisions(scope, text, actor, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(scope, text, actor, Date.now());
  }

  revisions(scope: string, before = Number.MAX_SAFE_INTEGER) {
    return this.store.db
      .prepare(
        "SELECT id, text, actor, created_at AS createdAt FROM document_revisions WHERE scope = ? AND id < ? ORDER BY id DESC LIMIT 20",
      )
      .all(scope, before) as Array<{
      id: number;
      text: string;
      actor: string;
      createdAt: number;
    }>;
  }

  files(id: string, before?: string) {
    this.store.room(id);
    const rows = this.store.db
      .prepare(
        `SELECT a.json AS attachmentJson, m.json AS messageJson
         FROM attachments a
         JOIN room_messages m ON m.room_id = ?
         JOIN json_each(m.json, '$.attachments') sent
           ON json_extract(sent.value, '$.id') = a.id
         WHERE (? IS NULL OR a.rowid < (SELECT rowid FROM attachments WHERE id = ?))
         ORDER BY a.rowid DESC LIMIT 51`,
      )
      .all(id, before ?? null, before ?? null) as Array<{
      attachmentJson: string;
      messageJson: string;
    }>;
    const files = rows.slice(0, 50).map((row) => {
      const attachment = attachmentSchema.parse(JSON.parse(row.attachmentJson));
      const sent = messageSchema.parse(JSON.parse(row.messageJson));
      return {
        attachment,
        messageId: sent.id,
        agentId: sent.agentId,
        publisher: sent.speaker,
        createdAt: sent.createdAt,
      };
    });
    return {
      files,
      nextBefore:
        rows.length > 50 ? (files.at(-1)!.attachment.id as string) : null,
    };
  }

  artifactReferences(id: string) {
    this.store.room(id);
    const rows = this.store.db
      .prepare(
        `SELECT json FROM room_messages
         WHERE room_id = ?
           AND (instr(json_extract(json, '$.text'), '::page{') > 0
             OR instr(json_extract(json, '$.text'), '::artifact{') > 0)
           AND NOT (json_extract(json, '$.automationId') IS NOT NULL
             AND json_extract(json, '$.agentId') IS NULL)
         ORDER BY rowid DESC LIMIT 500`,
      )
      .all(id) as Array<{ json: string }>;
    const seen = new Set<string>();
    const references = [];
    for (const row of rows) {
      const sent = messageSchema.parse(JSON.parse(row.json));
      for (const segment of parseArtifactDirectives(sent.text)) {
        if (segment.kind !== "artifact") continue;
        const key = `${segment.reference.id}:${segment.reference.revision}`;
        if (seen.has(key)) continue;
        seen.add(key);
        references.push({
          ...segment.reference,
          messageId: sent.id,
          publisher: sent.speaker,
          createdAt: sent.createdAt,
        });
        if (references.length === 100) return references;
      }
    }
    return references;
  }

  usage(roomId?: string, agentId?: string) {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const limits =
      (agentId
        ? this.store.get(agentId).limits
        : roomId
          ? this.store.room(roomId).limits
          : undefined) ?? defaultLimits;
    const rows = this.store.db
      .prepare(
        `SELECT
           COALESCE(SUM(COALESCE(json_extract(json, '$.startedAt'), json_extract(json, '$.dispatchStartedAt')) IS NOT NULL), 0) AS turns,
           COALESCE(SUM(json_extract(json, '$.conversationKey') LIKE '%:fork:%' AND COALESCE(json_extract(json, '$.startedAt'), json_extract(json, '$.dispatchStartedAt')) IS NOT NULL), 0) AS forks,
           COALESCE(SUM(status IN ('running', 'dispatching', 'queued')), 0) AS active,
           COALESCE(SUM(status = 'error'), 0) AS errors
         FROM jobs
         WHERE COALESCE(json_extract(json, '$.startedAt'), json_extract(json, '$.dispatchStartedAt'), created_at) >= ?
         ${roomId ? "AND json_extract(json, '$.roomId') = ?" : ""}
         ${agentId ? "AND agent_id = ?" : ""}`,
      )
      .get(
        since,
        ...(roomId ? [roomId] : []),
        ...(agentId ? [agentId] : []),
      ) as {
      turns: number;
      forks: number;
      active: number;
      errors: number;
    };
    const routing = roomId
      ? (this.store.db
          .prepare(
            "SELECT COUNT(*) AS routingCalls, COALESCE(SUM(duration_ms), 0) AS routingMilliseconds FROM routing_usage WHERE room_id = ? AND created_at >= ?",
          )
          .get(roomId, since) as {
          routingCalls: number;
          routingMilliseconds: number;
        })
      : { routingCalls: 0, routingMilliseconds: 0 };
    return { ...rows, ...routing, since, limits };
  }
}
