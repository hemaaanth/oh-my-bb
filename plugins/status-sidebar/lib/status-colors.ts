import type { CSSProperties } from "react";
import type { ThreadStatusBucket } from "./sidebar-model";

const DRAFTING_STATUS_COLOR =
  "color-mix(in oklab, var(--warning-text) 62%, var(--destructive-text))";

export const STATUS_DESIGN: readonly {
  status: ThreadStatusBucket;
  label: string;
  className: string;
  style?: CSSProperties;
}[] = [
  {
    status: "needs-input",
    label: "waiting on you",
    className: "bg-warning/20 text-warning-text",
  },
  {
    status: "unread",
    label: "unread",
    className: "bg-success/20 text-success",
  },
  {
    status: "drafting",
    label: "drafting",
    className: "bg-warning/20",
    style: { color: DRAFTING_STATUS_COLOR },
  },
  {
    status: "active",
    label: "working",
    className: "bg-timeline-accent/20 text-timeline-accent",
  },
  {
    status: "idle",
    label: "idle",
    className: "bg-sidebar-foreground/10 text-sidebar-foreground",
  },
];

// Solid tones for sub-agent markers and the pill's dots, in the same colours
// as the status sections.
export const STATUS_MARKER: Record<
  ThreadStatusBucket,
  { className: string; style?: CSSProperties }
> = {
  "needs-input": { className: "text-warning-text" },
  unread: { className: "text-success" },
  drafting: { className: "", style: { color: DRAFTING_STATUS_COLOR } },
  active: { className: "text-timeline-accent" },
  idle: { className: "text-muted-foreground" },
  archived: { className: "text-muted-foreground/40" },
};
