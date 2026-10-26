// Ported from ComicBit/bb-plugin-genui (Apache-2.0). See THIRD_PARTY.md.
// Where a block's full-screen view goes when BB shows threads side by side
// or stacked: over the pane holding the block, not the whole window. Read
// from BB's split markup (`data-split-pane-id`); if BB renames it, views
// cover the whole window again, as they do with one pane.
import { type RefObject, useLayoutEffect, useState } from "react";

const PANE = "[data-split-pane-id]";

/** A rectangle in client coordinates (CSS px), as `position: fixed` places it. */
export interface Bounds {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The BB pane holding `anchor` while `active`, kept current as the
 * pane is resized or the window changes. Outside BB, null fills the window.
 */
export function usePaneBounds(anchor: RefObject<Element | null>, active: boolean): Bounds | null {
  const [bounds, setBounds] = useState<Bounds | null>(null);
  useLayoutEffect(() => {
    const pane = active ? anchor.current?.closest(PANE) : null;
    if (pane == null) {
      setBounds(null);
      return;
    }
    const measure = () => {
      const { top, left, width, height } = pane.getBoundingClientRect();
      setBounds((last) => (last?.top === top && last.left === left && last.width === width && last.height === height ? last : { top, left, width, height }));
    };
    measure();
    // A pane moves when the sidebar or a neighbour is resized, and then resizes too.
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [anchor, active]);
  return bounds;
}
