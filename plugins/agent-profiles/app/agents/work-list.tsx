import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ChannelAgent, Job } from "../../server/channels/contract";
import { Button } from "@/components/ui/button";
import { channelWorkActivity } from "../shared/channel-work";

const activeStatuses: Partial<Record<Job["status"], true>> = {
  queued: true,
  dispatching: true,
  running: true,
};
const retryableStatuses: Partial<Record<Job["status"], true>> = {
  error: true,
  cancelled: true,
};

export function WorkList({
  jobs,
  agents,
  pendingJobId,
  onCancel,
  onRetry,
  canRetry,
}: {
  jobs: Job[];
  agents: ChannelAgent[];
  pendingJobId?: string | null;
  onCancel: (id: string) => void;
  onRetry?: (id: string) => void;
  canRetry?: (job: Job) => boolean;
}) {
  const navigate = useBbNavigate();
  const statusVisual = (job: Job) => {
    if (activeStatuses[job.status]) {
      return { icon: "Loading" as const, label: "Working", className: "animate-spin text-muted-foreground" };
    }
    if (job.status === "done") {
      return { icon: "Check" as const, label: "Done", className: "text-success" };
    }
    if (job.status === "error") {
      return { icon: "CircleX" as const, label: "Error", className: "text-destructive" };
    }
    return { icon: "Circle" as const, label: "Cancelled", className: "text-subtle-foreground" };
  };
  return (
    <div className="divide-y divide-border/60">
      {!jobs.length ? (
        <div className="flex min-w-0 items-center justify-center px-2 py-3 text-center text-sm text-muted-foreground">
          No activity yet.
        </div>
      ) : (
        jobs.map((job) => {
          const agent = agents.find((candidate) => candidate.id === job.agentId);
          const active = !!activeStatuses[job.status];
          const retryable = !!retryableStatuses[job.status] && !!onRetry;
          const retryAllowed = !canRetry || canRetry(job);
          const visual = statusVisual(job);
          return (
            <article
              className="group/work flex min-w-0 items-start gap-2.5 px-2 py-2"
              key={job.id}
            >
              <span role="img" aria-label={visual.label} className="mt-0.5 inline-flex shrink-0">
                <Icon name={visual.icon} className={`size-3.5 ${visual.className}`} aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 text-sm font-medium text-foreground">
                    {agent?.name ?? "Agent"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">
                    {active ? channelWorkActivity(job) : visual.label}
                  </span>
                  <time className="shrink-0 text-2xs text-subtle-foreground">
                    {new Intl.DateTimeFormat(undefined, {
                      dateStyle: "short",
                      timeStyle: "short",
                    }).format(job.createdAt)}
                  </time>
                </div>
                {job.taskTitle ? (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{job.taskTitle}</p>
                ) : null}
                {job.queueReason ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">{job.queueReason}</p>
                ) : null}
                {job.error ? (
                  <p role="alert" className="mt-0.5 text-xs text-destructive">{job.error}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                {job.threadId ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground"
                    aria-label={`View ${agent?.name ?? "agent"} work`}
                    onClick={() => navigate.toThread(job.threadId!)}
                  >
                    <Icon name="ExternalLink" className="size-3.5" />
                  </Button>
                ) : null}
                {active ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground"
                    aria-label={job.cancellationPending ? "Stopping work" : "Stop work"}
                    disabled={pendingJobId === job.id || !!job.cancellationPending}
                    onClick={() => onCancel(job.id)}
                  >
                    <Icon name="Square" className="size-3.5" />
                  </Button>
                ) : null}
                {retryable ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground"
                    aria-label="Retry work"
                    disabled={pendingJobId === job.id || !retryAllowed}
                    onClick={() => onRetry?.(job.id)}
                  >
                    <Icon name="RotateCcw" className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            </article>
          );
        })
      )}
    </div>
  );
}
