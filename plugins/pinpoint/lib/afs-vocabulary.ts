// Zod-free AFS vocabulary: the state/intent/severity/kind lists and the tiny
// read-time helpers over them. ./afs re-exports all of it and builds its
// schemas from these lists; the frontend imports from here directly so the app
// bundle does not pull in zod's full (non-tree-shakable) classic build.

export const workflowStates = [
  "open",
  "dispatched",
  "waiting-input",
  "ready",
  "approved",
  "dismissed",
] as const;
export type WorkflowState = (typeof workflowStates)[number];

export const annotationIntents = ["fix", "change", "question", "approve"] as const;
export const annotationSeverities = ["blocking", "important", "suggestion"] as const;
export const annotationKinds = [
  "feedback",
  "placement",
  "rearrange",
  "text-edit",
] as const;

export type AnnotationIntent = (typeof annotationIntents)[number];
export type AnnotationSeverity = (typeof annotationSeverities)[number];

// Read-time defaults (not a migration): rows captured before intent/severity
// existed — and agent comments that never set them — read as fix/suggestion.
export function intentOf(a: { intent?: AnnotationIntent }): AnnotationIntent {
  return a.intent === "change" ? "fix" : (a.intent ?? "fix");
}

export function severityOf(a: {
  severity?: AnnotationSeverity;
}): AnnotationSeverity {
  return a.severity ?? "suggestion";
}

/** Items the agent should act on: not yet resolved, not blocked on the user. */
export function isAgentInboxState(state: WorkflowState): boolean {
  return state === "open" || state === "dispatched";
}

/** Items blocked on the user: ready for review or awaiting an answer. */
export function isUserInboxState(state: WorkflowState): boolean {
  return state === "ready" || state === "waiting-input";
}
