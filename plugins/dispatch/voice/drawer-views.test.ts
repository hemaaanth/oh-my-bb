import { describe, expect, it } from "vitest";
import { DrawerViews } from "./drawer-views.js";

const view = (id: string) => ({ id, title: `Thread ${id}`, projectId: "p" });
const ids = (drawer: DrawerViews) => drawer.state.views.map((v) => v.id);

describe("DrawerViews", () => {
  it("adds the first view even with reuse", () => {
    const drawer = new DrawerViews();
    drawer.open([view("a")], "reuse", "reuse");
    expect(drawer.state).toMatchObject({ activeId: "a" });
    expect(ids(drawer)).toEqual(["a"]);
  });

  it("replaces the active view with reuse", () => {
    const drawer = new DrawerViews();
    drawer.open([view("a"), view("b")], "new", "reuse");
    drawer.select("a");
    drawer.open([view("c")], "reuse", "new");
    expect(ids(drawer)).toEqual(["c", "b"]);
    expect(drawer.state.activeId).toBe("c");
  });

  it("adds a view with new", () => {
    const drawer = new DrawerViews();
    drawer.open([view("a")], "new", "reuse");
    drawer.open([view("b")], "new", "reuse");
    expect(ids(drawer)).toEqual(["a", "b"]);
    expect(drawer.state.activeId).toBe("b");
  });

  it("follows the saved behavior with auto", () => {
    const reuse = new DrawerViews();
    reuse.open([view("a")], "auto", "reuse");
    reuse.open([view("b")], "auto", "reuse");
    expect(ids(reuse)).toEqual(["b"]);
    const added = new DrawerViews();
    added.open([view("a")], "auto", "new");
    added.open([view("b")], "auto", "new");
    expect(ids(added)).toEqual(["a", "b"]);
  });

  it("adds the missing views of a batch and selects the last, even with reuse", () => {
    const drawer = new DrawerViews();
    drawer.open([view("a")], "reuse", "reuse");
    drawer.open([view("b"), view("a"), view("c")], "reuse", "reuse");
    expect(ids(drawer)).toEqual(["a", "b", "c"]);
    expect(drawer.state.activeId).toBe("c");
  });

  it("selects an existing view instead of adding a duplicate", () => {
    const drawer = new DrawerViews();
    drawer.open([view("a"), view("b")], "new", "new");
    drawer.open([view("a")], "reuse", "reuse");
    expect(ids(drawer)).toEqual(["a", "b"]);
    expect(drawer.state.activeId).toBe("a");
  });

  it("selects a neighbour on close, and clear empties", () => {
    const drawer = new DrawerViews();
    drawer.open([view("a"), view("b"), view("c")], "new", "new");
    drawer.select("b");
    expect(drawer.close()).toBe(true);
    expect(ids(drawer)).toEqual(["a", "c"]);
    expect(drawer.state.activeId).toBe("c");
    drawer.close("c");
    expect(drawer.state.activeId).toBe("a");
    // Closing a view that is not active keeps the active one.
    drawer.open([view("d")], "new", "new");
    drawer.close("a");
    expect(drawer.state).toMatchObject({ activeId: "d" });
    expect(drawer.close("missing")).toBe(false);
    drawer.clear();
    expect(drawer.state).toEqual({ views: [], activeId: null });
    expect(drawer.select("d")).toBe(false);
  });

  it("knows whether a drawer is on screen", () => {
    const drawer = new DrawerViews();
    expect(drawer.isPresented()).toBe(false);
    let visible = false;
    const unregister = drawer.registerPresenter({ visible: () => visible });
    expect(drawer.isPresented()).toBe(false);
    visible = true;
    expect(drawer.isPresented()).toBe(true);
    unregister();
    expect(drawer.isPresented()).toBe(false);
  });
});
