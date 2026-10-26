export type AnnotationMessageRole = "human" | "agent";

export interface AnnotationMessageView {
  role: AnnotationMessageRole;
  content: string;
  guest?: boolean;
  id?: string;
  ownerEdited?: boolean;
}

export function annotationConversation(input: {
  comment: string;
  authorRole?: AnnotationMessageRole;
  authoredByGuest?: boolean;
  ownerEdited?: boolean;
  thread: AnnotationMessageView[];
}): {
  authoredByAgent: boolean;
  messages: AnnotationMessageView[];
} {
  const first = input.thread[0];
  // Older agent-authored annotations predate authorRole. They stored the
  // opening agent comment as the first thread turn; human-authored notes only
  // began accumulating thread turns once an agent replied.
  const authoredByAgent = input.authorRole
    ? input.authorRole === "agent"
    : first?.role === "agent" && first.content === input.comment;

  const openingRole: AnnotationMessageRole = authoredByAgent ? "agent" : "human";
  const opening = input.comment.trim()
    ? [{ role: openingRole, content: input.comment, ...(input.authoredByGuest ? { guest: true } : {}), ...(input.ownerEdited ? { ownerEdited: true } : {}) }]
    : [];
  return {
    authoredByAgent,
    messages: authoredByAgent
      ? input.thread.length > 0
        ? input.thread
        : opening
      : [...opening, ...input.thread],
  };
}
