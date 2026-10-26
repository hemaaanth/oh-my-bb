// Package-local Clasi learning rules. No runtime dependency on Clasi.
// Keep validation and scope fixtures local so each package checks independently.
export const learningTopics = ["design", "copy"] as const;
export type LearningTopic = (typeof learningTopics)[number];

export interface ProposedLearning {
  topic: LearningTopic;
  logicalKey: string;
  text: string;
}

// ---------------------------------------------------------------------------
// safeKey — VERBATIM from clasi/server.ts:
//   z.string().min(1).max(80).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
// ---------------------------------------------------------------------------
export const SAFE_KEY_MAX = 80;
export const SAFE_KEY_REGEX = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

// ---------------------------------------------------------------------------
// safeText — VERBATIM from clasi/server.ts:
//   z.string().min(1).max(240).refine(isSafeText, …)
// ---------------------------------------------------------------------------
export const SAFE_TEXT_MAX = 240;

/** VERBATIM copy of clasi/server.ts isSafeText. */
export function isSafeText(value: string) {
  if (/\r|\n/.test(value)) return false;
  if (/(?:^|\s)(?:\/[^\s]+|[A-Za-z]:\\[^\s]+)/.test(value)) return false;
  return !/(?:BEGIN [A-Z ]*PRIVATE KEY|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|(?:password|token|secret)\s*[:=]\s*\S+)/i.test(value);
}

export type RuleCheck = { ok: true } | { ok: false; reason: string };

/** Same acceptance set as clasi's safeKey, with a human-readable reason. */
export function validateLearningKey(key: string): RuleCheck {
  if (key.length < 1) return { ok: false, reason: "logicalKey must not be empty" };
  if (key.length > SAFE_KEY_MAX) {
    return {
      ok: false,
      reason: `logicalKey exceeds ${SAFE_KEY_MAX} characters (got ${key.length})`,
    };
  }
  if (!SAFE_KEY_REGEX.test(key)) {
    return {
      ok: false,
      reason:
        "logicalKey must be lowercase alphanumeric segments joined by single '.', '_' or '-' (e.g. brand-voice or spacing.scale)",
    };
  }
  return { ok: true };
}

/** Same acceptance set as clasi's safeText, with a human-readable reason. */
export function validateLearningText(text: string): RuleCheck {
  if (text.length < 1) return { ok: false, reason: "learning text must not be empty" };
  if (text.length > SAFE_TEXT_MAX) {
    return {
      ok: false,
      reason: `learning text exceeds ${SAFE_TEXT_MAX} characters (got ${text.length})`,
    };
  }
  if (/\r|\n/.test(text)) {
    return { ok: false, reason: "learning text must be a single line" };
  }
  if (/(?:^|\s)(?:\/[^\s]+|[A-Za-z]:\\[^\s]+)/.test(text)) {
    return {
      ok: false,
      reason:
        "learning text must not contain file paths — generalize it (say what to prefer, not where)",
    };
  }
  if (!isSafeText(text)) {
    return {
      ok: false,
      reason: "learning text looks like it contains a secret or credential",
    };
  }
  return { ok: true };
}

/**
 * Full propose-time gate for one proposed learning. Passing this guarantees
 * clasi's strict saveContext schema will accept the same values later.
 */
export function validateProposedLearning(input: {
  topic: string;
  logicalKey: string;
  text: string;
}): RuleCheck {
  if (!(learningTopics as readonly string[]).includes(input.topic)) {
    return {
      ok: false,
      reason: `learning topic must be one of ${learningTopics.join("|")} (got "${input.topic}")`,
    };
  }
  const key = validateLearningKey(input.logicalKey);
  if (!key.ok) return key;
  return validateLearningText(input.text);
}

