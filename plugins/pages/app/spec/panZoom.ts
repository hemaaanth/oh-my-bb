// Ported from ComicBit/bb-plugin-genui (Apache-2.0). See THIRD_PARTY.md.
import { useCallback, useEffect, useRef, useState } from "react";
import { NO_BB_SWIPE } from "./gpu/style.js";
import { clampView, FIT_VIEW, panBy, pinchView, placeImage, toggleZoom, wheelZoomFactor, zoomAround, type Placement, type Point, type View, type Size } from "./zoomMath.js";
/** The pane in client coordinates (as laid out, before any zoom) and the content's size at zoom 1. */
export interface PaneBox {
  readonly left: number;
  readonly top: number;
  readonly pane: Size;
  readonly content: Size;
}

interface PanZoomOptions {
  /** Where the pane and its content are now; null while there is nothing to zoom. */
  readonly measure: () => PaneBox | null;
  /** Draws the content at a placement (pane coordinates, scale per content pixel). */
  readonly draw: (placed: Placement, view: View) => void;
  /** Full screen, a plain wheel zooms; inline it scrolls the thread, and only a pinch or ⌘/Ctrl + wheel zooms. */
  readonly plainWheel: boolean;
  /** Double tap or double click zooms in at the point, or back to fit. */
  readonly doubleTap: boolean;
  /** A one-finger swipe while fitted (the viewer steps or closes on it). */
  readonly onSwipe?: (dx: number, dy: number) => void;
}

export interface PanZoom {
  readonly zoomed: boolean;
  readonly zoomBy: (factor: number) => void;
  readonly reset: () => void;
  /** Draws the current view again after the pane or the content changed size. */
  readonly redraw: () => void;
}

/** How far a press may travel and still be a tap. */
const TAP_SLOP_PX = 8;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 32;
const ZOOMED = 1.001;

type Gesture =
  | { readonly kind: "pinch"; readonly ids: readonly [number, number]; readonly from: readonly [Point, Point]; readonly start: View; readonly box: PaneBox }
  | { readonly kind: "pan"; readonly id: number; last: Point; readonly box: PaneBox }
  | { readonly kind: "press"; readonly id: number; readonly start: Point };

/** Safari's trackpad pinch on macOS: no ctrl+wheel, a scale on gesture events instead. */
interface GestureEvent extends UIEvent {
  readonly scale: number;
  readonly clientX: number;
  readonly clientY: number;
}

/**
 * Attributes that keep BB's mobile sidebar and side-panel swipes off an
 * element: BB's swipe recognizers skip touches that start inside them. Every
 * surface a finger drags or pinches needs them, or a sideways pan (or the
 * outer finger of a pinch) opens a panel instead.
 */


/**
 * Pan and zoom of `surface`'s content. The caller says where the pane is and
 * draws; the view lives here, in a ref, so a gesture draws every frame
 * without rendering React. `zoomed` is state, for touch-action and controls.
 */
export function usePanZoom(surface: HTMLElement | null, options: PanZoomOptions): PanZoom {
  const latest = useRef(options);
  latest.current = options;
  const view = useRef<View>(FIT_VIEW);
  const [zoomed, setZoomed] = useState(false);

  const show = useCallback((next: View, box: PaneBox | null = latest.current.measure()) => {
    if (box === null) return;
    const shown = clampView(next, box.pane, box.content);
    view.current = shown;
    latest.current.draw(placeImage(shown, box.pane, box.content), shown);
    setZoomed(shown.zoom > ZOOMED);
  }, []);

  const zoomBy = useCallback(
    (factor: number) => {
      const box = latest.current.measure();
      if (box !== null) show(zoomAround(view.current, factor, { x: box.pane.width / 2, y: box.pane.height / 2 }, box.pane, box.content), box);
    },
    [show],
  );
  const reset = useCallback(() => show(FIT_VIEW), [show]);
  const redraw = useCallback(() => show(view.current), [show]);

  useEffect(() => {
    if (surface === null) return;
    let gesture: Gesture | null = null;
    let travel = 0;
    // A drag or pinch ends in a click the content must not take as a tap.
    let swallowClick = false;
    let lastTap: { readonly time: number; readonly at: Point } | null = null;
    let mouse: { readonly id: number; last: Point; readonly box: PaneBox } | null = null;
    let safari: { readonly start: View; readonly scale: number } | null = null;
    // Browsers follow a double tap with a dblclick of their own, which would toggle the zoom back.
    let touchedAt = Number.NEGATIVE_INFINITY;

    const local = (box: PaneBox, point: Point): Point => ({ x: point.x - box.left, y: point.y - box.top });
    const fingers = (event: TouchEvent) =>
      [...event.touches]
        .filter((touch) => touch.target instanceof Node && surface.contains(touch.target))
        .map((touch) => ({ id: touch.identifier, x: touch.clientX, y: touch.clientY }));

    const begin = (list: readonly { id: number; x: number; y: number }[]) => {
      const box = latest.current.measure();
      if (box === null || list.length === 0) {
        gesture = null;
        return;
      }
      if (list.length >= 2) {
        const [a, b] = list as [{ id: number; x: number; y: number }, { id: number; x: number; y: number }];
        gesture = { kind: "pinch", ids: [a.id, b.id], from: [local(box, a), local(box, b)], start: view.current, box };
      } else if (view.current.zoom > ZOOMED) {
        gesture = { kind: "pan", id: list[0]!.id, last: list[0]!, box };
      } else {
        gesture = { kind: "press", id: list[0]!.id, start: list[0]! };
      }
    };

    const onTouchStart = (event: TouchEvent) => {
      const list = fingers(event);
      if (list.length === 1) {
        // A new press: whatever the last gesture swallowed (a touch drag ends without a click) is over.
        travel = 0;
        swallowClick = false;
      }
      // Two fingers are ours: no page zoom, no scroll under them.
      if (list.length >= 2 && event.cancelable) event.preventDefault();
      begin(list);
    };

    const onTouchMove = (event: TouchEvent) => {
      const current = gesture;
      if (current === null) return;
      const list = fingers(event);
      if (current.kind === "pinch") {
        const a = list.find((finger) => finger.id === current.ids[0]);
        const b = list.find((finger) => finger.id === current.ids[1]);
        if (a === undefined || b === undefined) return;
        if (event.cancelable) event.preventDefault();
        travel += TAP_SLOP_PX;
        show(pinchView(current.start, current.from, [local(current.box, a), local(current.box, b)], current.box.pane, current.box.content), current.box);
        return;
      }
      const finger = list.find((candidate) => candidate.id === current.id);
      if (finger === undefined) return;
      if (current.kind === "pan") {
        if (event.cancelable) event.preventDefault();
        travel += Math.hypot(finger.x - current.last.x, finger.y - current.last.y);
        show(panBy(view.current, finger.x - current.last.x, finger.y - current.last.y, current.box.pane, current.box.content), current.box);
        current.last = finger;
      } else {
        travel = Math.max(travel, Math.hypot(finger.x - current.start.x, finger.y - current.start.y));
      }
    };

    const onTouchEnd = (event: TouchEvent) => {
      touchedAt = event.timeStamp;
      const current = gesture;
      const list = fingers(event);
      if (list.length > 0) {
        // A pinch that lost a finger carries on as a pan of the one left.
        if (current?.kind === "pinch") begin(list.slice(0, 1));
        return;
      }
      gesture = null;
      const ended = event.changedTouches[0];
      if (current === null || ended === undefined) return;
      const at = { x: ended.clientX, y: ended.clientY };
      if (travel >= TAP_SLOP_PX || current.kind === "pinch") {
        swallowClick = current.kind !== "press";
        lastTap = null;
        if (current.kind === "press" && event.type === "touchend") latest.current.onSwipe?.(at.x - current.start.x, at.y - current.start.y);
        return;
      }
      if (!latest.current.doubleTap) return;
      const now = event.timeStamp;
      if (lastTap !== null && now - lastTap.time < DOUBLE_TAP_MS && Math.hypot(at.x - lastTap.at.x, at.y - lastTap.at.y) < DOUBLE_TAP_PX) {
        lastTap = null;
        const box = latest.current.measure();
        if (box !== null) show(toggleZoom(view.current, local(box, at), box.pane, box.content), box);
        return;
      }
      lastTap = { time: now, at };
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      swallowClick = false;
      if (event.button !== 0 || view.current.zoom <= ZOOMED) return;
      const box = latest.current.measure();
      if (box === null) return;
      travel = 0;
      mouse = { id: event.pointerId, last: { x: event.clientX, y: event.clientY }, box };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (mouse === null || mouse.id !== event.pointerId) return;
      const dx = event.clientX - mouse.last.x;
      const dy = event.clientY - mouse.last.y;
      travel += Math.hypot(dx, dy);
      // Captured only once it is a drag, so a plain click still reaches what is under it.
      if (travel >= TAP_SLOP_PX && !surface.hasPointerCapture(event.pointerId)) surface.setPointerCapture(event.pointerId);
      mouse.last = { x: event.clientX, y: event.clientY };
      show(panBy(view.current, dx, dy, mouse.box.pane, mouse.box.content), mouse.box);
    };
    const onPointerEnd = (event: PointerEvent) => {
      if (mouse === null || mouse.id !== event.pointerId) return;
      mouse = null;
      if (travel >= TAP_SLOP_PX) swallowClick = true;
    };

    const onClick = (event: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.preventDefault();
      event.stopPropagation();
    };

    const onDoubleClick = (event: MouseEvent) => {
      if (!latest.current.doubleTap || event.timeStamp - touchedAt < 1000) return;
      const box = latest.current.measure();
      if (box === null) return;
      event.preventDefault();
      show(toggleZoom(view.current, local(box, { x: event.clientX, y: event.clientY }), box.pane, box.content), box);
    };

    const onWheel = (event: WheelEvent) => {
      const box = latest.current.measure();
      if (box === null) return;
      const at = local(box, { x: event.clientX, y: event.clientY });
      if (event.ctrlKey || event.metaKey || latest.current.plainWheel) {
        event.preventDefault();
        show(zoomAround(view.current, wheelZoomFactor(event.deltaY, event.deltaMode, box.pane.height), at, box.pane, box.content), box);
        return;
      }
      if (view.current.zoom <= ZOOMED) return;
      const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.pane.height : 1;
      const next = panBy(view.current, -event.deltaX * lines, -event.deltaY * lines, box.pane, box.content);
      // At an edge the page scrolls on, as everywhere else in the conversation.
      if (Math.abs(next.cx - view.current.cx) < 1e-6 && Math.abs(next.cy - view.current.cy) < 1e-6) return;
      event.preventDefault();
      show(next, box);
    };

    // iOS sends these with its touches (the touch pinch zooms); desktop Safari only these.
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      safari = gesture === null ? { start: view.current, scale: (event as GestureEvent).scale || 1 } : null;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const box = latest.current.measure();
      if (safari === null || gesture !== null || box === null) return;
      const { scale, clientX, clientY } = event as GestureEvent;
      show(zoomAround(safari.start, scale / safari.scale, local(box, { x: clientX, y: clientY }), box.pane, box.content), box);
    };

    const touch = { passive: false } as const;
    for (const [name, value] of Object.entries(NO_BB_SWIPE)) surface.setAttribute(name, value);
    surface.addEventListener("touchstart", onTouchStart, touch);
    surface.addEventListener("touchmove", onTouchMove, touch);
    surface.addEventListener("touchend", onTouchEnd);
    surface.addEventListener("touchcancel", onTouchEnd);
    surface.addEventListener("pointerdown", onPointerDown);
    surface.addEventListener("pointermove", onPointerMove);
    surface.addEventListener("pointerup", onPointerEnd);
    surface.addEventListener("pointercancel", onPointerEnd);
    surface.addEventListener("click", onClick, true);
    surface.addEventListener("dblclick", onDoubleClick);
    surface.addEventListener("wheel", onWheel, touch);
    surface.addEventListener("gesturestart", onGestureStart, touch);
    surface.addEventListener("gesturechange", onGestureChange, touch);
    return () => {
      surface.removeEventListener("touchstart", onTouchStart);
      surface.removeEventListener("touchmove", onTouchMove);
      surface.removeEventListener("touchend", onTouchEnd);
      surface.removeEventListener("touchcancel", onTouchEnd);
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", onPointerEnd);
      surface.removeEventListener("pointercancel", onPointerEnd);
      surface.removeEventListener("click", onClick, true);
      surface.removeEventListener("dblclick", onDoubleClick);
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("gesturestart", onGestureStart);
      surface.removeEventListener("gesturechange", onGestureChange);
      for (const name of Object.keys(NO_BB_SWIPE)) surface.removeAttribute(name);
    };
  }, [surface, show]);

  return { zoomed, zoomBy, reset, redraw };
}
