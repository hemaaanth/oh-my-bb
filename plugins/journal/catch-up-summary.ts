import { catchUpReason } from "./catch-up-rules";
import type { experimental_useSidebarThreads as useSidebarThreads } from "@get-bb/plugin-sdk/app";
type Thread = ReturnType<typeof useSidebarThreads>["threads"][number];
export type Work = { thread: Thread; entry?: { summary: string; workStatus: string | null; worked?: string | null }; project: string };
export type CatchUpItem = { work: Work; reason?: string };
export type CatchUpGroup = { project: string; items: CatchUpItem[] };
export type CatchUpSummary = { attention: CatchUpItem[]; active: CatchUpGroup[]; archive: CatchUpItem[] };

export function catchUpSummary(works: Work[], now: number): CatchUpSummary {
  const attention: CatchUpItem[] = [];
  const archive: CatchUpItem[] = [];
  const groups = new Map<string, CatchUpItem[]>();
  for (const work of works) {
    const reason = catchUpReason(work.thread, work.entry, now);
    if (reason.attention) attention.push({ work, reason: reason.attention });
    else if (reason.archive) archive.push({ work, reason: reason.archive });
    else {
      const items = groups.get(work.project);
      if (items) items.push({ work });
      else groups.set(work.project, [{ work }]);
    }
  }
  return {
    attention,
    active: [...groups].map(([project, items]) => ({ project, items })).sort((a, b) => b.items.length - a.items.length || a.project.localeCompare(b.project)),
    archive,
  };
}
