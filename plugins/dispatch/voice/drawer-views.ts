// The mobile drawer's list of thread views (SPEC §9). It lives in memory per
// window and is lost on reload. A view's id is its thread id, so reopening a
// thread finds its view instead of adding a second one.

import { createStore, useStore, type Store } from "./store.js";

export interface DrawerView {
  id: string;
  title: string;
  projectId: string | null;
}

export interface DrawerState {
  views: DrawerView[];
  activeId: string | null;
}

export type Disposition = "auto" | "reuse" | "new";
export type DrawerBehavior = "reuse" | "new";

/** A mounted drawer. `visible` is false while its tab or panel is hidden. */
export interface DrawerPresenter {
  visible(): boolean;
}

export class DrawerViews {
  readonly store: Store<DrawerState> = createStore<DrawerState>({ views: [], activeId: null });
  private presenters = new Set<DrawerPresenter>();

  get state() {
    return this.store.get();
  }

  /**
   * Show threads in the drawer. `auto` follows the saved behavior. Reuse with
   * one thread replaces the active view; new, or several threads, add the
   * missing views. The last thread asked for becomes active.
   */
  open(views: readonly DrawerView[], disposition: Disposition, behavior: DrawerBehavior): DrawerState {
    if (views.length === 0) return this.state;
    const mode = disposition === "auto" ? behavior : disposition;
    const { views: current, activeId } = this.state;
    const last = views[views.length - 1]!;
    let next: DrawerView[];
    if (current.some((view) => view.id === last.id) && views.length === 1) {
      // Reopening selects the view that is already there.
      next = current.map((view) => (view.id === last.id ? last : view));
    } else if (mode === "reuse" && views.length === 1 && activeId !== null) {
      next = current.map((view) => (view.id === activeId ? last : view));
    } else {
      next = [...current];
      for (const view of views) {
        const at = next.findIndex((existing) => existing.id === view.id);
        if (at === -1) next.push(view);
        else next[at] = view;
      }
    }
    this.store.set({ views: next, activeId: last.id });
    return this.state;
  }

  select(id: string): boolean {
    if (!this.state.views.some((view) => view.id === id)) return false;
    this.store.set({ ...this.state, activeId: id });
    return true;
  }

  /** Close one view (the active one by default). The neighbour becomes active. */
  close(id = this.state.activeId): boolean {
    const { views, activeId } = this.state;
    const at = views.findIndex((view) => view.id === id);
    if (at === -1) return false;
    const next = views.filter((_, index) => index !== at);
    const neighbour = next[Math.min(at, next.length - 1)] ?? null;
    this.store.set({ views: next, activeId: activeId === id ? neighbour?.id ?? null : activeId });
    return true;
  }

  clear() {
    this.store.set({ views: [], activeId: null });
  }

  /** A drawer component calls this on mount and the disposer on unmount. */
  registerPresenter(presenter: DrawerPresenter): () => void {
    this.presenters.add(presenter);
    return () => {
      this.presenters.delete(presenter);
    };
  }

  /** Is a drawer on screen now? If not, the caller opens one. */
  isPresented(): boolean {
    return [...this.presenters].some((presenter) => presenter.visible());
  }
}

export const drawerViews = new DrawerViews();

export const useDrawerViews = () => useStore(drawerViews.store);
