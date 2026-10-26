// Consent event + direct clasi write for an approved learning (U8 / R12).
//
// Pure db-in/db-out with the two bb dependencies (plugins.callRpc,
// projects.get) INJECTED, so the whole approve-with-consent flow — including
// the exact saveContext payload — is unit-testable without a live host.
// server.ts wires the real bb.sdk in and adds the realtime publish.
//
// Invariants this module enforces:
//   * consent is only ever recorded for a row that carries a proposal (AE4:
//     approve without opt-in never reaches this module at all);
//   * the write only runs after a consent event, and sends the VERBATIM text
//     the user approved;
//   * `learningWrite: saved` is only written after a successful call — any
//     error (clasi absent, validation, transport) records `failed` with the
//     error, and the write can be re-attempted (retry-learning).
import type DatabaseNamespace from "better-sqlite3";
import { z } from "zod";

import { type LearningTopic } from "./clasi-rules";
import { deriveClasiProjectScope, type ClasiScopeRef } from "./clasi-scope";
import {
  annotationFor,
  getAnnotationRow,
  patchPinpoint,
  type AnnotationRow,
} from "./store";

type Database = DatabaseNamespace.Database;

/** Default priority for consented learnings written to clasi. */
export const LEARNING_PRIORITY = 50;

/** Minimal saveContext output shape (clasi returns the full context record). */
export const savedContextSchema = z.looseObject({ id: z.string() });

/** All-JSON type alias (not an interface) so it satisfies the SDK's JsonValue. */
export type ClasiSaveContextInput = {
  scope: ClasiScopeRef;
  logicalKey: string;
  kind: "preference";
  value: string;
  priority: number;
  topic: LearningTopic;
  provenance: string;
  consentRef: string;
};

/** The bb.sdk.plugins.callRpc-shaped dependency (injected for tests). */
export type LearningCallRpc = (args: {
  pluginId: "clasi";
  method: "saveContext";
  input: ClasiSaveContextInput;
  outputSchema: typeof savedContextSchema;
}) => Promise<unknown>;

export interface LearningWriteDeps {
  isEnabled: () => Promise<boolean>;
  callRpc: LearningCallRpc;
  /** bb.sdk.projects.get, narrowed to the fields the scope derivation needs. */
  getProject: (
    projectId: string,
  ) => Promise<{ id: string; gitRemoteUrl: string | null }>;
}

export type ConsentResult =
  | { ok: true; row: AnnotationRow }
  | { ok: false; error: string };

/**
 * Record the consent event: the user approved WITH the explicit learning
 * opt-in. Stores the verbatim proposal text they saw — the later write sends
 * exactly this string, even if the payload were to change in between.
 */
export function recordLearningConsent(
  db: Database,
  id: string,
  approvedProposal: { text: string; topic: LearningTopic; logicalKey: string } | undefined,
  now = Date.now(),
): ConsentResult {
  const row = getAnnotationRow(db, id);
  if (!row) return { ok: false, error: `no such annotation: ${id}` };
  const proposal = annotationFor(row).pinpoint.proposedLearning;
  if (!proposal) {
    return { ok: false, error: `${id} has no proposed learning to consent to` };
  }
  if (row.review_state !== "approved") {
    return { ok: false, error: "Approve the fix before consenting to its learning." };
  }
  if (!approvedProposal || approvedProposal.text !== proposal.text ||
      approvedProposal.topic !== proposal.topic ||
      approvedProposal.logicalKey !== proposal.logicalKey) {
    return { ok: false, error: "The proposed learning changed. Review its exact text before approving." };
  }
  return {
    ok: true,
    row: patchPinpoint(db, row, {
      learningConsent: { approvedAt: now, ...approvedProposal },
    }),
  };
}

export type LearningWriteResult =
  | { ok: true; row: AnnotationRow }
  | { ok: false; error: string; row: AnnotationRow | null };

/**
 * Perform (or re-attempt) the direct clasi write for a consented learning.
 * Never runs without a stored consent event. Marks `learningWrite` saved on
 * success, failed (with the error) otherwise — the card renders that state.
 */
export async function performLearningWrite(
  db: Database,
  id: string,
  deps: LearningWriteDeps,
  now = Date.now(),
): Promise<LearningWriteResult> {
  const row = getAnnotationRow(db, id);
  if (!row) return { ok: false, error: `no such annotation: ${id}`, row: null };
  const pinpoint = annotationFor(row).pinpoint;
  const proposal = pinpoint.proposedLearning;
  const consent = pinpoint.learningConsent;
  if (row.review_state !== "approved" || !proposal || !consent) {
    return {
      ok: false,
      error: `${id} has no consented learning to write`,
      row,
    };
  }
  function currentConsentedRow(): AnnotationRow | null {
    const current = getAnnotationRow(db, id);
    if (!current || current.review_state !== "approved") return null;
    const state = annotationFor(current).pinpoint;
    return state.learningConsent?.approvedAt === consent!.approvedAt &&
      state.learningConsent?.text === consent!.text &&
      state.learningConsent?.topic === consent!.topic &&
      state.learningConsent?.logicalKey === consent!.logicalKey &&
      state.proposedLearning?.text === proposal!.text &&
      state.proposedLearning?.topic === proposal!.topic &&
      state.proposedLearning?.logicalKey === proposal!.logicalKey
      ? current : null;
  }
  try {
    if (pinpoint.learningWrite?.state === "saved") return { ok: true, row };
    if (!consent.topic || !consent.logicalKey) {
      throw new Error("This older consent has no complete proposal snapshot. Reopen the item and approve the exact learning again.");
    }
    if (consent.text !== proposal.text ||
        consent.topic !== proposal.topic ||
        consent.logicalKey !== proposal.logicalKey) {
      throw new Error("The learning no longer matches the approved proposal.");
    }
    if (!await deps.isEnabled()) throw new Error("Enable Clasi learning in Settings → Pinpoint → Oh My BB.");
    // Clasi keys project scope by canonical-git-remote hash; the derivation
    // is vendored (parity-tested) in clasi-rules.ts. Like clasi, a project
    // without a remote falls back to {type:"project", id: projectId}.
    const project = await deps.getProject(row.project_id);
    const scope = deriveClasiProjectScope(project);
    // Recheck after async scope lookup. Disabling must also stop retries in flight.
    if (!await deps.isEnabled()) throw new Error("Clasi learning is disabled.");
    if (!currentConsentedRow()) throw new Error("The approved learning changed while preparing its save.");
    await deps.callRpc({
      pluginId: "clasi",
      method: "saveContext",
      input: {
        scope,
        logicalKey: proposal.logicalKey,
        kind: "preference",
        // The verbatim text the user approved (from the consent event).
        value: consent.text,
        priority: LEARNING_PRIORITY,
        topic: proposal.topic,
        provenance: row.thread_id,
        consentRef: `pinpoint:${id}`,
      },
      outputSchema: savedContextSchema,
    });
    const current = currentConsentedRow();
    return current ? {
      ok: true,
      row: patchPinpoint(db, current, { learningWrite: { state: "saved", at: now } }),
    } : { ok: false, error: "The item changed during the save. Its newer state was preserved.", row: getAnnotationRow(db, id) };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    const current = currentConsentedRow();
    return {
      ok: false,
      error,
      row: current
        ? patchPinpoint(db, current, { learningWrite: { state: "failed", error } })
        : getAnnotationRow(db, id),
    };
  }
}
