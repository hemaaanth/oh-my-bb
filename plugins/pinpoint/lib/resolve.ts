// The ONE structured resolve handler (KTD3): both the pinpoint_resolve tool
// and the `bb pinpoint ready|ask|reject` CLI route through applyResolveOutcome,
// so the two surfaces cannot diverge in validation or resulting state. All
// bb side effects (realtime publish, project checks) stay with the caller.
import { readFileSync } from "node:fs";

import type DatabaseNamespace from "better-sqlite3";

import {
  scopeBreadths,
  scopeTargets,
  type ResolutionScope,
  type ScopeBreadth,
  type ScopeTarget,
} from "./afs";
import {
  learningTopics,
  validateProposedLearning,
  type ProposedLearning,
} from "./clasi-rules";
import { LEARNING_FLAG_SYNTAX, SCOPE_FLAG_SYNTAX } from "./commands";
import {
  annotationFor,
  dismissAnnotation,
  getAnnotationRow,
  questionAnnotation,
  resolveAnnotation,
  type AnnotationRow,
} from "./store";

type Database = DatabaseNamespace.Database;

// ---------------------------------------------------------------------------
// Receipts (KTD6): agent-asserted diffs, capped, warned-not-blocked.
// ---------------------------------------------------------------------------
export const RECEIPT_MAX_CHARS = 64 * 1024;
export const RECEIPT_TRUNCATION_MARKER = "…[truncated]";

export function capReceipt(text: string): string {
  if (text.length <= RECEIPT_MAX_CHARS) return text;
  return text.slice(0, RECEIPT_MAX_CHARS) + RECEIPT_TRUNCATION_MARKER;
}

/** Recorded when the agent resolves without classifying its change. */
export const INFERRED_SCOPE: ResolutionScope = {
  breadth: "instance",
  target: "element",
  declared: false,
};

export type ResolveOutcome = "ready" | "question" | "reject";
export const resolveOutcomes = ["ready", "question", "reject"] as const;

export interface ResolveOutcomeInput {
  id: string;
  outcome: ResolveOutcome;
  /** ready: what changed. reject: why not. */
  summary?: string;
  /** question outcome only — required there. */
  question?: string;
  /** ready outcome only. */
  scope?: { breadth: ScopeBreadth; target: ScopeTarget };
  /** ready outcome only — the diff the agent asserts it applied. */
  receipt?: string;
  /**
   * ready outcome only — ONE proposed generalized design/copy learning
   * (R12). Validated here at propose time; an invalid proposal is DROPPED
   * (the resolution still applies) and the reason rides `learningRejected`.
   */
  proposedLearning?: ProposedLearning;
}

export type ResolveOutcomeResult =
  | {
      ok: true;
      row: AnnotationRow;
      message: string;
      /** Set when a proposed learning failed validation and was dropped. */
      learningRejected?: string;
    }
  | { ok: false; error: string };

export function applyResolveOutcome(
  db: Database,
  input: ResolveOutcomeInput,
  now = Date.now(),
): ResolveOutcomeResult {
  const { id, outcome } = input;
  // Conditional validation first, so an invalid combination never mutates.
  if (outcome !== "ready" && (input.scope || input.receipt !== undefined)) {
    return {
      ok: false,
      error: `scope and receipt are only valid with outcome "ready" (got outcome "${outcome}")`,
    };
  }
  if (outcome !== "ready" && input.proposedLearning !== undefined) {
    return {
      ok: false,
      error: `a proposed learning is only valid with outcome "ready" (got outcome "${outcome}")`,
    };
  }
  if (outcome !== "question" && input.question !== undefined) {
    return {
      ok: false,
      error: `question text is only valid with outcome "question" (got outcome "${outcome}")`,
    };
  }
  switch (outcome) {
    case "question": {
      const question = input.question?.trim();
      if (!question) {
        return {
          ok: false,
          error: `outcome "question" requires question text — what do you need the user to answer?`,
        };
      }
      const result = questionAnnotation(db, id, question, now);
      if (!result.ok) return result;
      return {
        ok: true,
        row: result.row,
        message: `Asked the user about ${id}; it is now waiting for their input. Their reply will come back to you — do not re-resolve until it does.`,
      };
    }
    case "reject": {
      const result = dismissAnnotation(db, id, input.summary, now);
      if (!result.ok) return result;
      return { ok: true, row: result.row, message: `Rejected ${id}.` };
    }
    case "ready": {
      const row = getAnnotationRow(db, id);
      if (!row) return { ok: false, error: `no such annotation: ${id}` };
      const scope: ResolutionScope = input.scope
        ? { breadth: input.scope.breadth, target: input.scope.target, declared: true }
        : INFERRED_SCOPE;
      const receipt =
        input.receipt !== undefined ? capReceipt(input.receipt) : undefined;
      // Anchored pick + a receipt that never mentions the data-pp id: the
      // asserted diff may not touch the pinned element. Warn, never block.
      const receiptAnchorWarning =
        annotationFor(row).pinpoint.anchored === true &&
        receipt !== undefined &&
        !receipt.includes(id)
          ? true
          : undefined;
      // Proposed learning (R12/AE3): validated NOW, against the vendored
      // clasi rules, so an approved learning can never fail validation after
      // consent. Invalid → the resolution still applies, but the proposal is
      // dropped and the reason is returned for the agent to see.
      let proposedLearning: ProposedLearning | undefined;
      let learningRejected: string | undefined;
      if (input.proposedLearning !== undefined) {
        const check = validateProposedLearning(input.proposedLearning);
        if (check.ok) proposedLearning = input.proposedLearning;
        else learningRejected = check.reason;
      }
      const result = resolveAnnotation(
        db,
        id,
        input.summary,
        { scope, receipt, receiptAnchorWarning, proposedLearning },
        now,
      );
      if (!result.ok) return result;
      return {
        ok: true,
        row: result.row,
        message: `Marked ${id} ready for review.`,
        ...(learningRejected !== undefined ? { learningRejected } : {}),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// CLI flag helpers (kept here so the CLI surface stays a thin adapter).
// ---------------------------------------------------------------------------
export type ScopeFlagResult =
  | { ok: true; scope: { breadth: ScopeBreadth; target: ScopeTarget } }
  | { ok: false; error: string };

/** Parse `--scope breadth:target` (e.g. `pattern:component`). */
export function parseScopeFlag(raw: string): ScopeFlagResult {
  const [breadth, target, ...extra] = raw.split(":").map((p) => p.trim());
  if (
    extra.length === 0 &&
    (scopeBreadths as readonly string[]).includes(breadth ?? "") &&
    (scopeTargets as readonly string[]).includes(target ?? "")
  ) {
    return {
      ok: true,
      scope: { breadth: breadth as ScopeBreadth, target: target as ScopeTarget },
    };
  }
  return {
    ok: false,
    error: `invalid --scope "${raw}": expected ${SCOPE_FLAG_SYNTAX}, e.g. pattern:component`,
  };
}

export type LearningFlagResult =
  | { ok: true; learning: ProposedLearning }
  | { ok: false; error: string };

/**
 * Parse `--learning "topic:logical-key:text"` (text may itself contain
 * colons). Shape only — content validation runs in applyResolveOutcome, the
 * same path the tool uses, so the two surfaces cannot diverge.
 */
export function parseLearningFlag(raw: string): LearningFlagResult {
  const match = /^([^:]+):([^:]+):([\s\S]+)$/.exec(raw);
  const topic = match?.[1]?.trim() ?? "";
  if (!match || !(learningTopics as readonly string[]).includes(topic)) {
    return {
      ok: false,
      error: `invalid --learning "${raw}": expected ${LEARNING_FLAG_SYNTAX}, e.g. design:spacing-scale:Use a four pixel spacing scale.`,
    };
  }
  return {
    ok: true,
    learning: {
      topic: topic as ProposedLearning["topic"],
      logicalKey: match[2]!.trim(),
      text: match[3]!.trim(),
    },
  };
}

export type ReceiptFileResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

export function readReceiptFile(path: string): ReceiptFileResult {
  try {
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch (cause) {
    return {
      ok: false,
      error: `cannot read --receipt-file ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}
