import { describe, expect, it } from "vitest";
import type { PluginSidebarProject, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  bucketForThread,
  followSelectedBucket,
  groupByEnvironment,
  isThreadActive,
  moveThreadGroup,
  moveThreadIds,
  needsInput,
  sortThreads,
  sortThreadsByStatus,
  statusForThread,
} from "./sidebar-model";

function thread(overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id: "thr_1",
    projectId: "proj_1",
    title: "A thread",
    titleFallback: null,
    displayTitle: "A thread",
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    href: "/threads/thr_1",
    isHidden: false,
    environment: null,
    host: null,
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    latestAttentionAt: 100,
    ...overrides,
  };
}

describe("status projection", () => {
  it("puts pending questions ahead of active work", () => {
    const pending = thread({
      hasPendingInteraction: true,
      indicator: "runtime",
    });
    expect(needsInput(pending)).toBe(true);
    expect(isThreadActive(pending)).toBe(true);
    expect(bucketForThread(pending)).toBe("needs-input");
  });


  it("separates unread finished work from read idle work", () => {
    expect(bucketForThread(thread({ isUnread: true }))).toBe("unread");
    expect(bucketForThread(thread())).toBe("idle");
  });

  it("shows an unsent draft below live work and above unread or idle", () => {
    expect(statusForThread(thread(), true)).toBe("drafting");
    expect(statusForThread(thread({ isUnread: true }), true)).toBe("drafting");
    expect(
      statusForThread(thread({ indicator: "runtime" }), true),
    ).toBe("active");
    expect(
      statusForThread(thread({ hasPendingInteraction: true }), true),
    ).toBe("needs-input");
  });

  it("lets active work and pending questions override unread", () => {
    expect(
      bucketForThread(thread({ isUnread: true, indicator: "runtime" })),
    ).toBe("active");
    expect(
      bucketForThread(thread({ isUnread: true, hasPendingInteraction: true })),
    ).toBe("needs-input");
  });

  it("keeps archived threads out of every live bucket", () => {
    const archived = thread({
      isArchived: true,
      hasPendingInteraction: true,
      indicator: "runtime",
    });
    expect(bucketForThread(archived)).toBe("archived");
  });

  it("places pinned live threads in one top-level bucket without losing status", () => {
    const pinnedQuestion = thread({
      isPinned: true,
      hasPendingInteraction: true,
    });
    expect(statusForThread(pinnedQuestion)).toBe("needs-input");
    expect(bucketForThread(pinnedQuestion)).toBe("pinned");
    expect(
      bucketForThread(thread({ isPinned: true, isArchived: true })),
    ).toBe("archived");
  });
});

describe("selected thread lane", () => {
  it("holds completion and read transitions until navigation, but follows a reply", () => {
    expect(followSelectedBucket("active", "unread")).toBe("active");
    expect(followSelectedBucket("active", "idle")).toBe("active");
    expect(followSelectedBucket("unread", "idle")).toBe("unread");
    expect(followSelectedBucket("unread", "active")).toBe("active");
  });

  it("follows archival immediately", () => {
    expect(followSelectedBucket("unread", "archived")).toBe("archived");
  });

  it("enters and leaves the draft lane immediately", () => {
    expect(followSelectedBucket("idle", "drafting")).toBe("drafting");
    expect(followSelectedBucket("drafting", "idle")).toBe("idle");
    expect(followSelectedBucket("drafting", "unread")).toBe("unread");
  });
});

describe("environment grouping", () => {
  it("groups threads from the same project and environment", () => {
    const environment = {
      id: "env_1",
      name: "ignored",
      branchName: "ignored",
      providerId: null,
      path: null,
      isWorktree: true,
      workspaceDisplayKind: "managed-worktree" as const,
    };
    const groups = groupByEnvironment([
      thread({ id: "a", environment }),
      thread({ id: "b", environment }),
      thread({ id: "c", projectId: "proj_2", environment }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.threads.map((item) => item.id)).toEqual(["a", "b"]);
    expect(groups[0]?.grouped).toBe(true);
    expect(groups[1]?.grouped).toBe(false);
  });
});

describe("manual ordering", () => {
  it("sorts project threads by live status without pinned placement", () => {
    const threads = [
      thread({ id: "pinned-idle", isPinned: true }),
      thread({ id: "active", indicator: "runtime" }),
      thread({ id: "drafting" }),
      thread({ id: "later-unread", isUnread: true }),
      thread({ id: "question", hasPendingInteraction: true }),
      thread({ id: "archived", isArchived: true }),
    ];
    const statuses = new Map(
      threads.map((item) => [item.id, statusForThread(item)]),
    );
    statuses.set("drafting", "drafting");

    expect(
      sortThreadsByStatus(
        threads,
        new Map(),
        statuses,
      ).map((item) => item.id),
    ).toEqual([
      "later-unread",
      "drafting",
      "question",
      "pinned-idle",
      "active",
      "archived",
    ]);
  });

  it("uses persisted order across status sorts and keeps new threads above it", () => {
    const ordered = sortThreads(
      "idle",
      [
        thread({ id: "new", updatedAt: 300 }),
        thread({ id: "a", updatedAt: 100 }),
        thread({ id: "b", updatedAt: 200 }),
      ],
      new Map([
        ["a", 1],
        ["b", 0],
      ]),
    );
    expect(ordered.map((item) => item.id)).toEqual(["new", "b", "a"]);
  });

  it("moves one thread before or after another", () => {
    expect(moveThreadIds(["a", "b", "c"], "c", "a", "before")).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(moveThreadIds(["a", "b", "c"], "a", "b", "after")).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("moves a grouped worktree as one contiguous block", () => {
    expect(
      moveThreadGroup(
        ["a1", "a2", "b1", "c1"],
        ["a1", "a2"],
        ["c1"],
        "after",
      ),
    ).toEqual(["b1", "c1", "a1", "a2"]);
  });

  it("ranks pinned threads by attention status before manual order", () => {
    const threads = [
      thread({ id: "idle", isPinned: true }),
      thread({ id: "active", isPinned: true, indicator: "runtime" }),
      thread({ id: "unread", isPinned: true, isUnread: true }),
      thread({ id: "question", isPinned: true, hasPendingInteraction: true }),
    ];
    const statuses = new Map(
      threads.map((item) => [item.id, statusForThread(item)]),
    );
    const sorted = sortThreads(
      "pinned",
      threads,
      new Map([
        ["idle", 0],
        ["active", 1],
        ["unread", 2],
        ["question", 3],
      ]),
      statuses,
    );
    expect(sorted.map((item) => item.id)).toEqual([
      "question",
      "unread",
      "idle",
      "active",
    ]);
  });


});

describe("focus buckets", () => {
  const now = 1_000_000_000;

  it("keeps delegated unread chatter out of Unread while retaining parent attention", () => {
    expect(statusForThread(thread({ isUnread: true, parentThreadId: "parent", updatedAt: now }), false, 3, now)).toBe("recent");
    expect(statusForThread(thread({ isUnread: true, lifecycleOwnerThreadId: "parent", updatedAt: now }), false, 3, now)).toBe("recent");
    expect(statusForThread(thread({ isUnread: true, updatedAt: now }), false, 3, now)).toBe("unread");
    expect(statusForThread(thread({ parentThreadId: "parent", hasPendingInteraction: true }), false, 3, now)).toBe("needs-input");
  });

  it("does not treat an idle background command as active agent work", () => {
    const command = thread({ indicator: "background-command", activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 1, planMode: 0, goals: 0 } });
    expect(isThreadActive(command)).toBe(false);
    expect(isThreadActive({ ...command, status: "active" })).toBe(true);
    expect(isThreadActive({ ...command, activity: { ...command.activity, backgroundAgents: 1 } })).toBe(true);
  });

  it("places read work within the chosen recent window before idle", () => {
    expect(statusForThread(thread({ updatedAt: now - 2 * 3_600_000 }), false, 3, now)).toBe("recent");
    expect(statusForThread(thread({ updatedAt: now - 4 * 3_600_000 }), false, 3, now)).toBe("idle");
    expect(statusForThread(thread({ updatedAt: now - 4 * 3_600_000 }), false, 6, now)).toBe("recent");
  });
});
