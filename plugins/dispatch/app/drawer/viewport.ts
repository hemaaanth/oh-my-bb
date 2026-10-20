// The drawer's height on a phone (SPEC §9.1). The on-screen keyboard shrinks
// the visual viewport but not the layout viewport, so a drawer sized to its
// tab would sit under the keyboard. This hook gives the room that is left
// below the element's top edge, or null where there is no visual viewport.
import { useEffect, useState, type RefObject } from "react";

export function roomBelow(top: number, viewport: { height: number; offsetTop: number }): number {
  return Math.max(0, Math.floor(viewport.height + viewport.offsetTop - top));
}

export function useVisualViewportRoom(ref: RefObject<HTMLElement | null>): number | null {
  const [room, setRoom] = useState<number | null>(null);
  useEffect(() => {
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = ref.current;
        if (!element) return;
        setRoom(roomBelow(element.getBoundingClientRect().top, viewport));
      });
    };
    measure();
    viewport.addEventListener("resize", measure);
    viewport.addEventListener("scroll", measure);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", measure);
      viewport.removeEventListener("scroll", measure);
    };
  }, [ref]);
  return room;
}
