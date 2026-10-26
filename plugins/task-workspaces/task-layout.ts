export type Task = {
  id: string;
  identifier: string;
  title: string;
  status: "triage" | "backlog" | "todo" | "doing" | "blocked" | "review" | "done" | "cancelled";
  projectId: string | null;
  effectiveProjectId?: string | null;
  threadIds: string[];
  owner: { isMe: boolean } | null;
  position?: number | null;
  refs: Array<{ provider?: string; priority: "urgent" | "high" | "medium" | "low" | null; url: string | null }>;
};

export const statusLabels: Record<Task["status"], string> = {
  triage: "Triage", backlog: "Backlog", todo: "Todo", doing: "In progress", blocked: "Blocked", review: "In review", done: "Done", cancelled: "Cancelled",
};

const priorities = ["urgent", "high", "medium", "low", "none"] as const;
const stages = ["doing", "review", "blocked", "todo", "backlog", "triage"] as const;

export function taskPriority(task: Task): typeof priorities[number] {
  return priorities.find((priority) => priority !== "none" && task.refs.some((ref) => ref.priority === priority)) ?? "none";
}

// Now and Later follow the order the user arranged. Tasks without a place go last, in server order.
export function byPosition(left: { position?: number | null }, right: { position?: number | null }) {
  return (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER);
}

// The sidebar's order for chats: needs input, unread, unsent draft, working, then idle.
export const chatOrder = ["input", "unread", "draft", "working", "idle"] as const;
export type ChatState = typeof chatOrder[number];

/**
 * Puts items with the most urgent chat first, like the sidebar. Items without an open chat go last.
 * Items in the same state keep their order.
 */
export function byChatState<T>(items: readonly T[], state: (item: T) => ChatState | null) {
  const rank = (item: T) => { const value = state(item); return value ? chatOrder.indexOf(value) : chatOrder.length; };
  return [...items].sort((left, right) => rank(left) - rank(right));
}

// The receipt title, such as "OCT 2, 2026, 3PM", in the machine's time zone.
export function printTimestamp(date: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", hour12: true,
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.month?.toUpperCase()} ${parts.day}, ${parts.year}, ${parts.hour}${parts.dayPeriod?.toUpperCase()}`;
}

/** Moves one task into a Now or Later order at an index counted without that task. */
export function placeTask(ids: readonly string[], taskId: string, index: number) {
  const rest = ids.filter((id) => id !== taskId);
  return [...rest.slice(0, index), taskId, ...rest.slice(index)];
}

// Linear names the assignee, so a Linear task is mine only when it is assigned to me.
export function isOpenPersonalTask(task: Pick<Task, "status" | "owner" | "refs">) {
  const mine = task.refs.some((ref) => ref.provider === "linear") ? task.owner?.isMe === true : !task.owner || task.owner.isMe;
  return task.status !== "done" && task.status !== "cancelled" && mine;
}

const byStage = (left: Task, right: Task) => stages.indexOf(left.status as typeof stages[number]) - stages.indexOf(right.status as typeof stages[number]);

// Now holds urgent tasks and Later holds high ones, each in the order the user arranged.
// A task with an open chat is being worked on, so it shows at the end of Later even without high priority.
// Like the sidebar, both lists then sort by chat state. `chatState` gives a task's most urgent open chat, or null.
// All tasks keeps only the tasks that show nowhere above.
export function organizeTasks(tasks: Task[], projectNames: ReadonlyMap<string, string>, chatState: (task: Task) => ChatState | null = () => null) {
  const personal = tasks.filter(isOpenPersonalTask);
  const now = byChatState(personal.filter((task) => taskPriority(task) === "urgent").sort(byPosition), chatState);
  const later = byChatState([
    ...personal.filter((task) => taskPriority(task) === "high").sort(byPosition),
    ...personal.filter((task) => taskPriority(task) !== "urgent" && taskPriority(task) !== "high" && chatState(task) !== null).sort(byStage),
  ], chatState);
  const above = new Set([...now, ...later]);
  const byProject = new Map<string, Task[]>();
  for (const task of personal) {
    if (above.has(task)) continue;
    const key = task.effectiveProjectId ?? task.projectId ?? "";
    const group = byProject.get(key);
    if (group) group.push(task);
    else byProject.set(key, [task]);
  }
  // Projects without tasks here still get a card, so a task can be added to them. They go last.
  for (const id of projectNames.keys()) if (!byProject.has(id)) byProject.set(id, []);
  const rank = (column: { id: string; tasks: Task[] }) => !column.tasks.length ? 2 : column.id ? 0 : 1;
  const columns = [...byProject].map(([id, projectTasks]) => ({
    id,
    name: id ? projectNames.get(id) ?? "Unknown project" : "No project",
    tasks: projectTasks,
    groups: priorities
      .map((priority) => ({ priority, tasks: projectTasks.filter((task) => taskPriority(task) === priority).sort(byStage) }))
      .filter((group) => group.tasks.length),
  })).sort((left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name));
  return { personal, now, later, columns };
}

/**
 * Deals items into columns. Each item goes to the shortest column, so reading order stays roughly left to right.
 * An item that `placed` already puts in a column stays there, so one change does not reshuffle every column.
 */
export function masonry<T>(items: readonly T[], count: number, height: (item: T) => number, placed: (item: T) => number | undefined = () => undefined) {
  const columns = Array.from({ length: Math.max(1, count) }, () => ({ items: [] as T[], height: 0 }));
  for (const item of items) {
    const kept = placed(item);
    const column = kept !== undefined && kept < columns.length ? columns[kept]! : columns.reduce((best, next) => next.height < best.height ? next : best);
    column.items.push(item);
    column.height += height(item);
  }
  return columns.map((column) => column.items);
}
