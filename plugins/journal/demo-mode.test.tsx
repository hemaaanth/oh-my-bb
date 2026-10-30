// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { CalendarLegend, CalendarView, type Activity, type useColors } from "./calendar-view";
import { TimesheetView } from "./timesheet-view";

const start = new Date(2026, 9, 5).getTime();
const hour = 3_600_000;
const activity: Activity = {
  from: start, to: start + 24 * hour, mergeGapMinutes: 30, generatedAt: start, syncedAt: start,
  workTimeZone: "America/New_York", projects: [{ id: "p", name: "Private project" }], colorOrder: ["p"],
  threads: [{ id: "t", projectId: "p", title: "Private thread", status: "idle", archived: false, parentThreadId: null, rootThreadId: "t", category: "feature" }],
  blocks: [{ threadId: "t", start: start + 9 * hour, end: start + 10 * hour, activeMs: hour, turnCount: 1, ongoing: false, childThreadIds: [], work: null }],
  turns: [],
};
const colors: ReturnType<typeof useColors> = { projects: new Map([["p", { id: "p", name: "Private project", color: "#123456", order: 0 }]]), categoryColor: () => "#898781", call: "#a335c0" };
const common = { activity, colors, grouping: "thread" as const, colorMode: "project" as const, rangeStart: start, dayCount: 1, now: start, onOpen: () => {}, onSelectDay: () => {} };
const marked = (element: Element) => expect(element.closest("[data-bb-demo-sensitive]")).not.toBeNull();

describe("Demo Mode privacy markers", () => {
  it("marks calendar names, accessible labels and hover details", async () => {
    const view = renderSlot({ component: CalendarView }, { ...common, gap: 30, onSetCategory: () => {} });
    const block = screen.getByRole("button", { name: /Private thread, Private project/ });
    marked(block);
    marked(screen.getByText("Private thread"));
    fireEvent.mouseEnter(block);
    const popover = await screen.findByRole("dialog", { name: "Private thread" });
    marked(popover);
    marked(popover.querySelector("p")!);
    view.lifecycle.unmount();
  });
  it("marks time sheet names and hover titles while leaving hours visible", () => {
    const view = renderSlot({ component: TimesheetView }, common);
    marked(screen.getByText("Private project"));
    marked(screen.getByRole("button", { name: "Private thread" }));
    for (const value of screen.getAllByText("1")) expect(value.closest("[data-bb-demo-sensitive]")).toBeNull();
    view.lifecycle.unmount();
  });
  it("marks project legend names but leaves standard work types readable", () => {
    const view = renderSlot({ component: CalendarLegend }, { activity, colors, colorMode: "project" });
    marked(screen.getByText("Private project"));
    view.lifecycle.unmount();
    const work = renderSlot({ component: CalendarLegend }, { activity, colors, colorMode: "work" });
    expect(screen.getByText("Feature").closest("[data-bb-demo-sensitive]")).toBeNull();
    work.lifecycle.unmount();
  });
});
