import { useEffect, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { ChannelAgent, Job } from "../../server/channels/contract";
import { IconActionTooltip } from "../shared/channel-controls";

export type QueuedMessageAction = "steer" | "fork" | "delete";

// A job that leaves the queue within this window (e.g. the agent is just
// finishing its previous turn) never shows, so the list does not flash.
const SHOW_AFTER_MS = 1_500;

const ACTION_BUTTON_CLASS =
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";

const withoutLeadingMention = (text: string, handle?: string) =>
  handle
    ? text.replace(new RegExp(`^\\s*@${handle.replace(/^@/u, "")}\\b[:,]?\\s*`, "iu"), "")
    : text;

export function QueuedMessagesList({
  jobs,
  agents,
  processing,
  onAction,
}: {
  jobs: Job[];
  agents: ChannelAgent[];
  processing: { jobId: string; action: QueuedMessageAction } | null;
  onAction: (job: Job, action: QueuedMessageAction) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const youngest = Math.max(0, ...jobs.map((job) => job.createdAt));
  useEffect(() => {
    const wait = youngest + SHOW_AFTER_MS - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [youngest]);
  const visible = jobs.filter(
    (job) => processing?.jobId === job.id || Math.max(now, Date.now()) - job.createdAt >= SHOW_AFTER_MS,
  );
  if (!visible.length) return null;
  return (
    <section
      aria-label="Queued messages"
      className="flex max-h-40 min-h-0 flex-col overflow-hidden border border-border bg-surface-raised-solid shadow-lift"
    >
      <ul className="min-h-0 overflow-y-auto px-3">
        {visible.map((job) => {
          const agent = agents.find((candidate) => candidate.id === job.agentId);
          const busy = processing?.jobId === job.id;
          const text = withoutLeadingMention(job.taskTitle || job.text || "Queued message", agent?.handle);
          const reason = `${job.queueReason ?? "Waiting for this agent's current turn"}${job.queuePosition ? ` · Position ${job.queuePosition}` : ""}`;
          return (
            <li key={job.id} className="flex h-7 min-w-0 items-center gap-1.5 text-xs">
              {busy ? (
                <Icon name="Spinner" className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <Icon name="Clock" className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="shrink-0 font-medium text-foreground/85">{agent?.name ?? "Agent"}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={`${text}\n${reason}`}>
                {text}
              </span>
              <IconActionTooltip label="Send now">
                <button
                  type="button"
                  className={ACTION_BUTTON_CLASS}
                  aria-label="Send now"
                  disabled={!!processing || !job.queueCanSteer}
                  onClick={() => onAction(job, "steer")}
                >
                  <Icon name="Sent" className="size-3.5" />
                </button>
              </IconActionTooltip>
              <IconActionTooltip label="Answer in parallel">
                <button
                  type="button"
                  className={ACTION_BUTTON_CLASS}
                  aria-label="Answer in parallel"
                  disabled={!!processing || !job.queueCanFork}
                  onClick={() => onAction(job, "fork")}
                >
                  <Icon name="Fork" className="size-3.5" />
                </button>
              </IconActionTooltip>
              <IconActionTooltip label="Delete">
                <button
                  type="button"
                  className={`${ACTION_BUTTON_CLASS} hover:text-destructive`}
                  aria-label={`Delete queued message for ${agent?.name ?? "agent"}`}
                  disabled={!!processing}
                  onClick={() => onAction(job, "delete")}
                >
                  <Icon name="Trash2" className="size-3.5" />
                </button>
              </IconActionTooltip>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
