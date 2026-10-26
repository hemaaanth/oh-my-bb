// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { ChatHeaderMenu, type SidebarThread } from "./task-chats";

const thread: SidebarThread = {
  id: "t1", projectId: "p1", title: "Chat", titleFallback: null, displayTitle: "Chat",
  parentThreadId: null, lifecycleOwnerThreadId: null, sourceThreadId: null,
  sectionId: null, originKind: null, originPluginId: null, providerId: "codex",
  status: "idle", runtimeStatus: "idle", queuedWork: "none", hasPendingInteraction: false,
  activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
  indicator: "none", indicatorLabel: null, isUnread: true, isPinned: false, pinnedAt: null,
  pinSortKey: null, isArchived: false, archivedAt: null, href: "/threads/t1", isHidden: false,
  environment: null, host: null, createdAt: 1, updatedAt: 1, lastReadAt: null, latestAttentionAt: 0,
};

afterEach(cleanup);

describe("task chat native menu", () => {
  it.each(["archive", "delete"])("uses BB's %s action instead of bypassing confirmations", async (id) => {
    const calls: string[] = [];
    const slot = renderSlot({ component: ChatHeaderMenu }, {
      threadId: thread.id, thread, onOpen: () => {}, children: <button>Chat header</button>,
    }, {
      threadActions: (target) => [{
        key: `bb--core/${id}`, pluginId: "bb--core", group: "4_lifecycle",
        action: { label: id, icon: "Archive", run: async () => { calls.push(target.id); } },
      }],
    });
    fireEvent.contextMenu(slot.getByText("Chat header"));
    fireEvent.click(await slot.findByRole("menuitem", { name: id }));
    expect(calls).toEqual([thread.id]);
    expect(slot.inspection.sdkCalls).toEqual([]);
  });

  it("keeps open and detach actions beside native menu entries", async () => {
    const calls: string[] = [];
    const slot = renderSlot({ component: ChatHeaderMenu }, {
      threadId: thread.id, thread,
      onOpen: () => { calls.push("open"); }, onUnattach: () => { calls.push("detach"); },
      children: <button>Chat header</button>,
    });
    fireEvent.contextMenu(slot.getByText("Chat header"));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Open chat" }));
    fireEvent.contextMenu(slot.getByText("Chat header"));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Detach from task" }));
    expect(calls).toEqual(["open", "detach"]);
  });

  it("does not show destructive actions for a missing thread", () => {
    const slot = renderSlot({ component: ChatHeaderMenu }, {
      threadId: "missing", thread: undefined, onOpen: () => {}, children: <button>Chat header</button>,
    });
    fireEvent.contextMenu(slot.getByText("Chat header"));
    expect(slot.queryByRole("menuitem")).toBeNull();
  });
});
