// "Your instructions" revisions (SPEC §11.5). The latest row is the current
// text. The built-in prompt is never written here. Owned by P1.
import { CHANNELS, INSTRUCTIONS_HISTORY_DEFAULT, INSTRUCTIONS_LIMIT } from "../shared/constants.js";
import type { InstructionRevision } from "../shared/contract.js";
import type { ServerContext } from "./context.js";
import { containsBuiltIn } from "./prompts/built-in.js";

type Author = InstructionRevision["author"];
type RevisionRow = { id: number; at: number; author: Author; note: string; body: string };

const COLUMNS = "id, at, author, note, body";

/** Throws a one-line reason when the body cannot be saved. */
export function checkInstructionsBody(body: string): void {
  if (body.length > INSTRUCTIONS_LIMIT) {
    throw new Error(
      `Your instructions can be at most ${INSTRUCTIONS_LIMIT.toLocaleString("en-US")} characters. This text has ${body.length.toLocaleString("en-US")}.`,
    );
  }
  if (containsBuiltIn(body)) {
    throw new Error("That text contains the built-in prompt. Save only your own instructions; the built-in prompt stays in place.");
  }
}

export function latestRevision(ctx: ServerContext): InstructionRevision | null {
  const row = ctx.db.prepare(`SELECT ${COLUMNS} FROM instruction_revisions ORDER BY id DESC LIMIT 1`).get() as RevisionRow | undefined;
  return row ?? null;
}

/** The current "Your instructions" text, empty when none was saved. */
export function currentInstructions(ctx: ServerContext): string {
  return latestRevision(ctx)?.body ?? "";
}

export function revisionHistory(ctx: ServerContext, limit: number = INSTRUCTIONS_HISTORY_DEFAULT): InstructionRevision[] {
  return ctx.db.prepare(`SELECT ${COLUMNS} FROM instruction_revisions ORDER BY id DESC LIMIT ?`).all(limit) as RevisionRow[];
}

/** Store a new revision and tell open settings pages. */
export function writeRevision(ctx: ServerContext, input: { body: string; author: Author; note: string; at?: number }): InstructionRevision {
  const body = input.body.trim();
  checkInstructionsBody(body);
  const at = input.at ?? Date.now();
  const result = ctx.db
    .prepare("INSERT INTO instruction_revisions (at, author, note, body) VALUES (?, ?, ?, ?)")
    .run(at, input.author, input.note, body);
  const revision: InstructionRevision = { id: Number(result.lastInsertRowid), at, author: input.author, note: input.note, body };
  ctx.bb.realtime.publish(CHANNELS.instructionsUpdated, revision);
  return revision;
}

/** `instructionsWrite` from the Agent settings section. */
export function writeFromSettings(ctx: ServerContext, body: string, note?: string): InstructionRevision {
  const trimmed = note?.trim();
  return writeRevision(ctx, { body, author: "user", note: trimmed ? trimmed : "edited in settings" });
}

/** Copy an old body into a new revision. */
export function restoreRevision(ctx: ServerContext, id: number): InstructionRevision {
  const row = ctx.db.prepare(`SELECT ${COLUMNS} FROM instruction_revisions WHERE id = ?`).get(id) as RevisionRow | undefined;
  if (!row) throw new Error(`There is no instruction revision ${id}.`);
  return writeRevision(ctx, { body: row.body, author: "user", note: `restored revision ${id}` });
}
