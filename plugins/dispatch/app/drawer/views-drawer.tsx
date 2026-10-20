// The mobile drawer (SPEC §9.2). One component serves the console's Views tab
// and the thread panel's Views action. It lists the window's thread views in
// a native select, shows how many there are, closes the active one, and draws
// the active thread with BB's ThreadChat. While mounted and on screen it is
// the drawer the tools use, so they do not open another one.
import { Component, useEffect, useRef, type ReactNode } from "react";
import { ThreadChat } from "@get-bb/plugin-sdk/app";
import { drawerViews, useDrawerViews } from "@/voice/drawer-views.js";
import { useAgentName } from "@/voice/preferences.js";
import { useVisualViewportRoom } from "./viewport.js";

/** On screen: the page is visible and the element takes up room. */
function onScreen(element: HTMLElement | null): boolean {
  if (!element || typeof document === "undefined" || document.visibilityState !== "visible") return false;
  return element.getClientRects().length > 0;
}

/** A crashed view shows a short line and a close action, and the drawer stays up. */
export class ViewBoundary extends Component<{ onClose(): void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-4 text-sm text-muted-foreground">
        <span>This view stopped working.</span>
        <button type="button" className="text-foreground underline underline-offset-4" onClick={this.props.onClose}>
          Close view
        </button>
      </div>
    );
  }
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function ViewsDrawer() {
  const { views, activeId } = useDrawerViews();
  const name = useAgentName();
  const root = useRef<HTMLDivElement | null>(null);
  const room = useVisualViewportRoom(root);

  useEffect(() => drawerViews.registerPresenter({ visible: () => onScreen(root.current) }), []);

  const active = views.find((view) => view.id === activeId) ?? null;
  return (
    <div
      ref={root}
      data-dispatch-drawer=""
      className="flex h-full min-h-0 flex-col"
      style={room === null ? undefined : { maxHeight: room }}
    >
      {active ? (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5">
            <select
              aria-label="Thread views"
              className="min-w-0 flex-1 truncate rounded-md border border-input bg-transparent px-2 py-1 text-sm"
              value={active.id}
              onChange={(event) => drawerViews.select(event.target.value)}
            >
              {views.map((view) => (
                <option key={view.id} value={view.id}>
                  {view.title}
                </option>
              ))}
            </select>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground" aria-label={`${views.length} views`}>
              {views.length}
            </span>
            <button
              type="button"
              aria-label="Close this view"
              title="Close this view"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground"
              onClick={() => drawerViews.close(active.id)}
            >
              <CloseGlyph />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <ViewBoundary key={active.id} onClose={() => drawerViews.close(active.id)}>
              <ThreadChat threadId={active.id} variant="compact" className="h-full" />
            </ViewBoundary>
          </div>
        </>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">Ask {name} to show a thread here.</p>
      )}
    </div>
  );
}
