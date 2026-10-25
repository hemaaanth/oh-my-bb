import type { experimental_useSidebarThreads as useSidebarThreads } from "@get-bb/plugin-sdk/app";

type Thread = ReturnType<typeof useSidebarThreads>["threads"][number];
type Entry = { workStatus: string | null };
export function catchUpReason(thread: Thread, entry: Entry | undefined, now: number): { attention?: string; archive?: string } {
  if (thread.hasPendingInteraction) return { attention: "Needs your input" };
  if (thread.status === "error" || thread.queuedWork === "failed") return { attention: "Agent failed" };
  if (entry?.workStatus === "blocked") return { attention: "Work is blocked" };
  if (thread.isUnread) return { attention: "Unread update" };
  if (thread.status !== "idle" || thread.isPinned || thread.queuedWork !== "none" || Object.values(thread.activity).some(Boolean)) return {};
  return {};
}
