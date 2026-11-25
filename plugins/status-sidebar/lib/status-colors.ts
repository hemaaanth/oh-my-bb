import type { CSSProperties } from "react";
import type { ThreadStatusBucket } from "./sidebar-model";

export type CanonicalTone =
  | "critical"
  | "attention"
  | "unread"
  | "active"
  | "review"
  | "draft"
  | "idle";

export interface ToneStyle {
  tone: CanonicalTone;
  label: string;
  pillClass: string;
  dotClass: string;
  borderClass: string;
  textClass: string;
}

/**
 * Single canonical color palette shared by section header count pills, row
 * glyphs/dots, and stage/status badges so they can never disagree.
 */
export const TONE_PALETTE: Record<CanonicalTone, ToneStyle> = {
  critical: {
    tone: "critical",
    label: "blocked or failed",
    pillClass: "bg-destructive/20 text-destructive-text",
    dotClass: "bg-destructive-text",
    borderClass: "border-destructive-text",
    textClass: "text-destructive-text",
  },
  attention: {
    tone: "attention",
    label: "needs you",
    pillClass: "bg-warning/20 text-warning-text",
    dotClass: "bg-warning-text",
    borderClass: "border-warning-text",
    textClass: "text-warning-text",
  },
  unread: {
    tone: "unread",
    label: "unread",
    pillClass: "bg-success/20 text-success",
    dotClass: "bg-success",
    borderClass: "border-success",
    textClass: "text-success",
  },
  active: {
    tone: "active",
    label: "working",
    pillClass: "bg-timeline-accent/20 text-timeline-accent",
    dotClass: "bg-timeline-accent",
    borderClass: "border-timeline-accent",
    textClass: "text-timeline-accent",
  },
  review: {
    tone: "review",
    label: "PR review",
    pillClass: "bg-purple-500/20 text-purple-300",
    dotClass: "bg-purple-400",
    borderClass: "border-purple-400",
    textClass: "text-purple-300",
  },
  draft: {
    tone: "draft",
    label: "draft",
    pillClass: "bg-orange-500/20 text-orange-400",
    dotClass: "bg-orange-400",
    borderClass: "border-orange-400",
    textClass: "text-orange-400",
  },
  idle: {
    tone: "idle",
    label: "idle",
    pillClass: "bg-sidebar-foreground/10 text-sidebar-foreground",
    dotClass: "bg-muted-foreground/35",
    borderClass: "border-muted-foreground/45",
    textClass: "text-muted-foreground",
  },
};

export const CANONICAL_TONE_ORDER: readonly CanonicalTone[] = [
  "critical",
  "attention",
  "unread",
  "active",
  "review",
  "draft",
  "idle",
];

// Non-Focus views (Status / Project / Workspace) derive from the same palette.
export const STATUS_DESIGN: readonly {
  status: ThreadStatusBucket;
  label: string;
  className: string;
  style?: CSSProperties;
}[] = [
  { status: "needs-input", label: "waiting on you", className: TONE_PALETTE.attention.pillClass },
  { status: "unread", label: "unread", className: TONE_PALETTE.unread.pillClass },
  { status: "drafting", label: "draft", className: TONE_PALETTE.draft.pillClass },
  { status: "active", label: "working", className: TONE_PALETTE.active.pillClass },
  { status: "recent", label: "recent", className: TONE_PALETTE.idle.pillClass },
  { status: "idle", label: "idle", className: TONE_PALETTE.idle.pillClass },
];

export const STATUS_MARKER: Record<
  ThreadStatusBucket,
  { className: string; style?: CSSProperties }
> = {
  "needs-input": { className: TONE_PALETTE.attention.textClass },
  unread: { className: TONE_PALETTE.unread.textClass },
  drafting: { className: TONE_PALETTE.draft.textClass },
  active: { className: TONE_PALETTE.active.textClass },
  recent: { className: "text-muted-foreground" },
  idle: { className: "text-muted-foreground" },
  archived: { className: "text-muted-foreground/40" },
};
