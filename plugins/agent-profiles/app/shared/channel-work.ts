import type { Job } from "../../server/channels/contract";

export function channelWorkActivity(
  job: Pick<Job, "status" | "cancellationPending" | "queueReason" | "queuePosition" | "activitySnippet">,
) {
  if (job.cancellationPending) return "Stopping…";
  if (job.status === "queued") {
    return job.queueReason
      ? `${job.queueReason}${job.queuePosition ? ` · Position ${job.queuePosition}` : ""}`
      : "Waiting to start…";
  }
  if (job.status === "dispatching") return "Preparing response…";
  return job.activitySnippet ?? "Working…";
}

export const isActiveJob = (job: Job) =>
  !!job.cancellationPending || ["queued", "dispatching", "running"].includes(job.status);

export function channelWork(jobs: Job[]): Job[] {
  const priority = (job: Job) => job.status === "running" ? 0 : job.status === "dispatching" ? 1 : 2;
  const sorted = jobs
    .filter(isActiveJob)
    .sort((left, right) => priority(left) - priority(right) || left.createdAt - right.createdAt);
  const seen = new Set<string>();
  return sorted.filter((job) => {
    const session = `${job.agentId}:${job.conversationKey}`;
    if (seen.has(session)) return false;
    seen.add(session);
    return true;
  });
}
