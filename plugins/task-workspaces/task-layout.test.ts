import { describe, expect, it } from "vitest";
import { byChatState, isOpenPersonalTask, masonry, organizeTasks, placeTask, printTimestamp, type ChatState, type Task } from "./task-layout";

describe("single Tasks screen", () => {
  it("uses existing provider priority for Now and Later and groups personal work by project", () => {
    const task = (id: string, priority: Task["refs"][number]["priority"], status: Task["status"], projectId: string, isMe = true): Task => ({
      id, identifier: id, title: id, status, projectId, threadIds: [],
      owner: { isMe }, refs: [{ priority, url: null }],
    });
    const tasks = [task("other", "urgent", "doing", "p1", false), task("later", "high", "todo", "p1"),
      task("now", "urgent", "doing", "p1"), task("backlog", null, "backlog", "p2"), task("finished", "urgent", "done", "p1")];
    const result = organizeTasks(tasks, new Map([["p1", "Alpha"], ["p2", "Beta"]]));
    expect(result.now.map((item) => item.id)).toEqual(["now"]);
    expect(result.later.map((item) => item.id)).toEqual(["later"]);
    // All tasks keeps only what Now and Later do not show.
    expect(result.columns.map((column) => [column.name, column.groups.map((group) => group.priority)]))
      .toEqual([["Beta", ["none"]], ["Alpha", []]]);
  });

  it("shows tasks with an open chat at the end of Later instead of All tasks", () => {
    const task = (id: string, priority: Task["refs"][number]["priority"], status: Task["status"], threadIds: string[] = []): Task => ({
      id, identifier: id, title: id, status, projectId: "p1", threadIds, owner: null, refs: [{ priority, url: null }],
    });
    const tasks = [task("idle", "low", "todo"), task("chatting", "low", "todo", ["t1"]), task("working", null, "doing", ["t2"]),
      task("closed", null, "todo", ["t3"]), task("later", "high", "todo", ["t4"]), task("now", "urgent", "todo", ["t5"])];
    const result = organizeTasks(tasks, new Map([["p1", "Alpha"]]), (item) => item.threadIds.some((id) => id !== "t3") ? "idle" : null);
    expect(result.now.map((item) => item.id)).toEqual(["now"]);
    expect(result.later.map((item) => item.id)).toEqual(["later", "working", "chatting"]);
    expect(result.columns[0]!.tasks.map((item) => item.id)).toEqual(["idle", "closed"]);
  });

  it("sorts Now and Later by chat state like the sidebar and keeps the arranged order within a state", () => {
    const task = (id: string, priority: "urgent" | "low" | "high", position: number | null): Task => ({
      id, identifier: id, title: id, status: "doing", projectId: null, threadIds: [], owner: null, position, refs: [{ priority, url: null }],
    });
    const states: Record<string, ChatState> = { idle: "idle", asks: "input", read: "unread", asksToo: "input", busy: "working", typed: "draft", chatting: "input" };
    const tasks = [task("idle", "urgent", 0), task("asks", "urgent", 1), task("quiet", "urgent", 2), task("read", "urgent", 3),
      task("asksToo", "urgent", 4), task("busy", "urgent", 5), task("typed", "urgent", 6), task("waiting", "high", 0), task("chatting", "low", null)];
    const result = organizeTasks(tasks, new Map(), (item) => states[item.id] ?? null);
    expect(result.now.map((item) => item.id)).toEqual(["asks", "asksToo", "read", "typed", "busy", "idle", "quiet"]);
    // A high task without a chat goes after a task whose chat needs input.
    expect(result.later.map((item) => item.id)).toEqual(["chatting", "waiting"]);
    expect(byChatState(["b", "a", "c"], (id) => id === "c" ? "unread" : null)).toEqual(["c", "b", "a"]);
  });

  it("sorts each priority group by stage and puts projectless work last", () => {
    const task = (id: string, status: Task["status"], projectId: string | null): Task => ({
      id, identifier: id, title: id, status, projectId, threadIds: [],
      owner: null, refs: [{ priority: "low", url: null }],
    });
    const result = organizeTasks([task("loose", "todo", null), task("queued", "backlog", "p1"), task("active", "doing", "p1")],
      new Map([["p1", "Zeta"]]));
    expect(result.columns.map((column) => column.name)).toEqual(["Zeta", "No project"]);
    expect(result.columns[0].groups[0].tasks.map((item) => item.id)).toEqual(["active", "queued"]);
  });

  it("keeps projects without open tasks as empty cards after the rest", () => {
    const task: Task = { id: "a", identifier: "a", title: "a", status: "todo", projectId: "p2",
      threadIds: [], owner: null, refs: [{ priority: "low", url: null }] };
    const result = organizeTasks([task, { ...task, id: "b", projectId: null }],
      new Map([["p1", "Alpha"], ["p2", "Zeta"], ["p3", "Beta"]]));
    expect(result.columns.map((column) => [column.name, column.tasks.length]))
      .toEqual([["Zeta", 1], ["No project", 1], ["Alpha", 0], ["Beta", 0]]);
    expect(result.columns[2].groups).toEqual([]);
  });

  it("deals masonry cards into the shortest column in order", () => {
    const heights = new Map([["a", 5], ["b", 1], ["c", 1], ["d", 3], ["e", 1]]);
    expect(masonry([...heights.keys()], 2, (id) => heights.get(id)!)).toEqual([["a", "e"], ["b", "c", "d"]]);
    expect(masonry(["a", "b"], 0, () => 1)).toEqual([["a", "b"]]);
  });

  it("keeps placed masonry cards in their column", () => {
    const placed = new Map([["a", 1], ["c", 0]]);
    expect(masonry(["a", "b", "c", "d"], 2, () => 1, (id) => placed.get(id))).toEqual([["b", "c"], ["a", "d"]]);
    expect(masonry(["a"], 1, () => 1, () => 4)).toEqual([["a"]]);
  });

  it("orders Now by arranged position and leaves unplaced tasks last", () => {
    const task = (id: string, position: number | null): Task => ({
      id, identifier: id, title: id, status: "todo", projectId: null, threadIds: [],
      owner: null, position, refs: [{ priority: "urgent", url: null }],
    });
    const result = organizeTasks([task("new", null), task("second", 1), task("first", 0)], new Map());
    expect(result.now.map((item) => item.id)).toEqual(["first", "second", "new"]);
  });

  it("keeps Linear tasks only when they are assigned to me", () => {
    const task = (provider: string, owner: Task["owner"]): Task => ({
      id: provider, identifier: provider, title: provider, status: "todo", projectId: null, threadIds: [],
      owner, refs: [{ provider, priority: null, url: null }],
    });
    expect(isOpenPersonalTask(task("linear", { isMe: true }))).toBe(true);
    expect(isOpenPersonalTask(task("linear", null))).toBe(false);
    expect(isOpenPersonalTask(task("linear", { isMe: false }))).toBe(false);
    expect(isOpenPersonalTask(task("akiflow", null))).toBe(true);
  });

  it("places a dragged task at an index counted without it", () => {
    expect(placeTask(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(placeTask(["a", "b"], "x", 1)).toEqual(["a", "x", "b"]);
    expect(placeTask(["a", "b"], "b", 0)).toEqual(["b", "a"]);
  });

  it("titles a receipt with the local date and hour", () => {
    expect(printTimestamp(new Date(2026, 9, 2, 15, 42))).toBe("OCT 2, 2026, 3PM");
    expect(printTimestamp(new Date(2026, 0, 9, 0, 5))).toBe("JAN 9, 2026, 12AM");
  });
});
