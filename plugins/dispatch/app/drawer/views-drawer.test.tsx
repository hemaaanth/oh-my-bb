// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import { drawerViews } from "@/voice/drawer-views.js";
import { ViewBoundary, ViewsDrawer } from "./views-drawer.js";
import { roomBelow } from "./viewport.js";

const view = (id: string, title = id) => ({ id, title, projectId: null });

afterEach(() => drawerViews.clear());

describe("views drawer", () => {
  it("shows one line when empty", () => {
    const drawer = renderSlot({ component: ViewsDrawer }, {});
    try {
      expect(drawer.container.textContent).toBe("Ask Juno to show a thread here.");
    } finally {
      drawer.unmount();
    }
  });

  it("lists views, counts them, switches, and closes the active one", async () => {
    drawerViews.open([view("t1", "First"), view("t2", "Second")], "new", "reuse");
    const drawer = renderSlot({ component: ViewsDrawer }, {});
    try {
      const select = drawer.getByLabelText("Thread views") as HTMLSelectElement;
      expect([...select.options].map((option) => option.textContent)).toEqual(["First", "Second"]);
      expect(select.value).toBe("t2");
      expect(drawer.getByLabelText("2 views").textContent).toBe("2");
      expect(drawer.getByTestId("bb-thread-chat").getAttribute("data-thread-id")).toBe("t2");
      await act(async () => fireEvent.change(select, { target: { value: "t1" } }));
      expect(drawer.getByTestId("bb-thread-chat").getAttribute("data-thread-id")).toBe("t1");
      await act(async () => fireEvent.click(drawer.getByLabelText("Close this view")));
      expect(drawerViews.state.views.map((entry) => entry.id)).toEqual(["t2"]);
      expect(drawer.getByTestId("bb-thread-chat").getAttribute("data-thread-id")).toBe("t2");
    } finally {
      drawer.unmount();
    }
  });

  it("registers as a presenter while mounted", () => {
    expect(drawerViews.isPresented()).toBe(false);
    const drawer = renderSlot({ component: ViewsDrawer }, {});
    const root = drawer.container.querySelector<HTMLElement>("[data-dispatch-drawer]")!;
    // jsdom lays nothing out: with no boxes the drawer is mounted but not on screen.
    expect(drawerViews.isPresented()).toBe(false);
    root.getClientRects = () => [new DOMRect(0, 0, 300, 400)] as unknown as DOMRectList;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    expect(drawerViews.isPresented()).toBe(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    expect(drawerViews.isPresented()).toBe(false);
    delete (document as { visibilityState?: unknown }).visibilityState;
    drawer.unmount();
    expect(drawerViews.isPresented()).toBe(false);
  });

  it("a crashed view shows a message and a close action", () => {
    let closed = 0;
    const Crash = () => {
      throw new Error("boom");
    };
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const view = render(
        <ViewBoundary onClose={() => closed++}>
          <Crash />
        </ViewBoundary>,
      );
      expect(view.getByRole("alert").textContent).toContain("This view stopped working.");
      fireEvent.click(view.getByText("Close view"));
      expect(closed).toBe(1);
    } finally {
      console.error = quiet;
    }
  });

  it("sizes to the room above the keyboard", () => {
    expect(roomBelow(100, { height: 500, offsetTop: 0 })).toBe(400);
    expect(roomBelow(100, { height: 300, offsetTop: 40 })).toBe(240);
    expect(roomBelow(900, { height: 300, offsetTop: 0 })).toBe(0);
  });
});
