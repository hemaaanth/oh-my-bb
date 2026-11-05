import { describe, expect, it } from "vitest";
import type { PluginSidebarProject, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  bucketForThread,
  focusGroup,
  hasUnseenFailure,
  sortFocusThreads,
  isCleanupCandidate,
  attentionWakeIds,
  followSelectedBucket,
  isThreadActive,
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


describe("focus working set", () => {
  it("surfaces completions and requests, while quiet running work stays current", () => {
    expect(focusGroup(thread(), "unread").key).toBe("attention");
    expect(focusGroup(thread(), "needs-input").key).toBe("attention");
    expect(focusGroup(thread(), "active").key).toBe("current");
    expect(focusGroup(thread({ isPinned: true }), "idle").key).toBe("current");
    expect(focusGroup(thread(), "idle").key).toBe("library");
    expect(focusGroup(thread({ lifecycleOwnerThreadId: "owner" }), "recent").key).toBe("library");
    expect(focusGroup(thread({ lifecycleOwnerThreadId: "owner" }), "unread").key).toBe("library");
    expect(focusGroup(thread({ lifecycleOwnerThreadId: "owner" }), "needs-input").key).toBe("attention");
    expect(focusGroup(thread({ queuedWork: "failed" }), "idle").key).toBe("attention");
  });

  it("only suggests old idle work without protected signals", () => {
    const now = 30 * 86_400_000;
    expect(isCleanupCandidate(thread(), "idle", now)).toBe(true);
    for (const patch of [{ isPinned: true }, { isUnread: true }, { queuedWork: "waiting" as const }, { isArchived: true }, { hasPendingInteraction: true }, { updatedAt: now }]) {
      expect(isCleanupCandidate(thread(patch), "idle", now)).toBe(false);
    }
    expect(isCleanupCandidate(thread(), "drafting", now)).toBe(false);
    expect(isCleanupCandidate(thread(), "active", now)).toBe(false);
    expect(isCleanupCandidate(thread({ activity: { ...thread().activity, backgroundCommands: 1 } }), "idle", now)).toBe(false);
  });

  it("wakes snoozed ancestors for child input but not routine background work", () => {
    const root = thread({ id: "root" });
    const child = thread({ id: "child", parentThreadId: "root", hasPendingInteraction: true });
    expect([...attentionWakeIds([root, child])]).toEqual(["child", "root"]);
    expect(attentionWakeIds([root, thread({ indicator: "runtime" }), thread({ isUnread: true })]).size).toBe(0);
    expect(attentionWakeIds([thread({ status: "error", latestAttentionAt: 200 })]).has("thr_1")).toBe(true);
  });
});

it("keeps Focus order stable through streaming updates and puts quiet agents last", () => {
  const rows = [thread({ id: "busy", updatedAt: 9999999, latestAttentionAt: 9999 }), thread({ id: "kept", isPinned: true }), thread({ id: "review", latestAttentionAt: 500 })];
  const statuses = new Map<string, import("./sidebar-model").ThreadStatusBucket>([["busy", "active"], ["kept", "idle"], ["review", "unread"]]);
  expect(sortFocusThreads(rows, statuses).map((row) => row.id)).toEqual(["review", "kept", "busy"]);
  expect(sortFocusThreads(rows.map((row) => ({ ...row, updatedAt: row.id === "kept" ? 999999999 : 0 })), statuses).map((row) => row.id)).toEqual(["review", "kept", "busy"]);
});

it("does not keep acknowledged child failures in Attention forever", () => {
  const old = thread({ status: "error", parentThreadId: "parent", latestAttentionAt: 100, lastReadAt: 200 });
  expect(hasUnseenFailure(old)).toBe(false);
  expect(focusGroup(old, "idle").key).toBe("library");
  expect(attentionWakeIds([old]).size).toBe(0);
  expect(hasUnseenFailure({ ...old, latestAttentionAt: 300 })).toBe(true);
  expect(hasUnseenFailure({ ...old, queuedWork: "failed" })).toBe(true);
  expect(focusGroup({ ...old, hasPendingInteraction: true }, "needs-input").key).toBe("attention");
});

it("keeps Focus status bands together even for pinned running threads", () => {
  const rows = [thread({ id: "running", isPinned: true }), thread({ id: "draft" }), thread({ id: "idle" }), thread({ id: "recent" })];
  const statuses = new Map<string, import("./sidebar-model").ThreadStatusBucket>([["running", "active"], ["draft", "drafting"], ["idle", "idle"], ["recent", "recent"]]);
  expect(sortFocusThreads(rows, statuses).map((row) => row.id)).toEqual(["draft", "idle", "recent", "running"]);
});
