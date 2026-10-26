import type { WorkflowState } from "./afs";

export function replyPlaceholderFor(status: WorkflowState): string {
  if (status === "waiting-input") return "Answer…";
  if (status === "ready") return "Add feedback…";
  if (status === "approved" || status === "dismissed") return "Reopen…";
  return "Reply…";
}
