// Adapted from bb-plugins task-workspaces/task-drag.ts (MIT, Copyright (c) 2026 Hemanth).
// Board keeps the lift, the slot, FLIP, and the landing. Projects, the Later folder, and portal scope hooks are gone.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { dropItems, slotIndex, type BoardSlot } from "./manage-logic.js";
import { useAnimationsOff } from "../motion.js";

// The lifted card lands in document.body (or the shadow root a page block renders in), outside the plugin's
// scoped stylesheet, so it carries the scope itself.
const SCOPE = { "data-bb-portaled-overlay": "", "data-bb-plugin-root": "", "data-bb-plugin": "pages" };
const liftShadow = "0 0 0 1px var(--border), 0 18px 36px -10px rgb(0 0 0 / 0.35), 0 6px 14px -6px rgb(0 0 0 / 0.2)";
const ease = "cubic-bezier(0.2, 0.9, 0.3, 1)";
const canAnimate = () => typeof HTMLElement.prototype.animate === "function";

function homeOf(index: number, lists: Record<string, readonly number[]>): BoardSlot | null {
  for (const [list, cards] of Object.entries(lists)) {
    const at = cards.indexOf(index);
    if (at >= 0) return { list, index: at };
  }
  return null;
}

// Layout position inside the page, without any running FLIP transform.
function layoutRect(row: HTMLElement) {
  const list = row.offsetParent as HTMLElement | null;
  const box = list?.getBoundingClientRect() ?? { left: 0, top: 0 };
  return { left: box.left + (list?.clientLeft ?? 0) + row.offsetLeft, top: box.top + (list?.clientTop ?? 0) + row.offsetTop, width: row.offsetWidth, height: row.offsetHeight };
}

type Box = { left: number; top: number; width: number; height: number };
type Corners = [number, number, number, number];
type Spring = readonly [stiffness: number, damping: number];
type Motion = { value: number; velocity: number; spring: Spring };

// The card's mass travels first and goes a little past its place. The lift sinks a beat later, and the corners take the slot's shape.
const travel: Spring = [420, 25];
const sink: Spring = [300, 22];
const resize: Spring = [300, 26];
const sharpen: Spring = [900, 60];
const frameMs = 1000 / 60;
const px = (value: number) => `${value.toFixed(2)}px`;

// A damped bounce that starts with a kick: a squash, a small rebound, then rest.
function wobble(amount: number, time: number) {
  return time < 0 ? 0 : amount * Math.exp(-time / 120) * Math.sin(time * 0.028);
}

/** Keyframes, one per frame, for a lifted card that lands in `to` and melts into it. */
function landing(from: Box & { tilt: number; scale: number; radius: number; shadow: number; velocity: { x: number; y: number } }, to: Box, corners: Corners) {
  const motion = (value: number, spring: Spring, velocity = 0): Motion => ({ value, velocity, spring });
  const fling = (speed: number) => Math.max(-2000, Math.min(2000, speed));
  const x = motion(from.left - to.left, travel, fling(from.velocity.x));
  const y = motion(from.top - to.top, travel, fling(from.velocity.y));
  const turn = motion(from.tilt, travel);
  const lift = motion(1, sink);
  const width = motion(from.width - to.width, resize);
  const height = motion(from.height - to.height, resize);
  const radii = corners.map((corner) => motion(from.radius - corner, sharpen));
  const all = [x, y, turn, lift, width, height, ...radii];
  const frames = { overlay: [] as Keyframe[], surface: [] as Keyframe[], shadow: [] as Keyframe[], content: [] as Keyframe[] };
  let impact: number | undefined;
  let push = 0;
  let settle: number | undefined;
  let time = 0;
  for (; ; time += frameMs) {
    // The card touches down once it is over its place and has mostly sunk. It squashes, and the cards beside it give way.
    if (impact === undefined && Math.hypot(x.value, y.value) < 1.5 && lift.value < 0.35) {
      impact = time;
      push = Math.min(2, 0.6 + (Math.hypot(x.velocity, y.velocity) + Math.abs(lift.velocity) * 30) / 400);
    }
    const squash = impact === undefined ? 0 : wobble(push, time - impact);
    // Like a drop, the corners round out first and then take the slot's shape.
    const drop = Math.min(time / 125, (1 - Math.min(1, time / 460)) ** 3) * 0.6;
    const w = to.width + width.value;
    const h = to.height + height.value;
    const radius = radii.map((corner, index) => {
      const base = Math.max(0, corners[index]! + corner.value);
      return px(base + (Math.min(w, h) / 2 - base) * drop);
    }).join(" ");
    frames.overlay.push({
      transform: `translate3d(${px(to.left + x.value)}, ${px(to.top + y.value)}, 0) rotate(${turn.value.toFixed(3)}deg) scale(${(1 + (from.scale - 1) * lift.value).toFixed(5)})`,
      width: px(w), height: px(h),
    });
    const shape = { top: px(squash), bottom: px(squash), left: px(-squash * 2), right: px(-squash * 2), borderRadius: radius };
    frames.surface.push(shape);
    frames.shadow.push({ ...shape, opacity: from.shadow * Math.max(0, Math.min(1, lift.value)) });
    frames.content.push({ borderRadius: radius });
    // The real card can take over under the lifted one once it covers the slot.
    const placed = Math.abs(x.value) < 0.5 && Math.abs(y.value) < 0.5 && Math.abs(width.value) < 0.5 && Math.abs(height.value) < 0.5 && Math.abs(turn.value) < 0.1;
    settle = placed ? settle ?? time : undefined;
    const still = all.every((part) => Math.abs(part.value) < 0.05 && Math.abs(part.velocity) < 1) && Math.abs(squash) < 0.05 && !drop;
    if ((still && time >= 460 && (impact === undefined || time - impact > 200)) || time > 1200) break;
    for (let step = 0; step < 4; step++) {
      for (const part of all) {
        part.velocity += (-part.spring[0] * part.value - part.spring[1] * part.velocity) * (frameMs / 4000);
        part.value += part.velocity * (frameMs / 4000);
      }
    }
  }
  const rest = { top: "0px", bottom: "0px", left: "0px", right: "0px", borderRadius: corners.map(px).join(" ") };
  frames.overlay.push({ transform: `translate3d(${px(to.left)}, ${px(to.top)}, 0) rotate(0deg) scale(1)`, width: px(to.width), height: px(to.height) });
  frames.surface.push(rest);
  frames.shadow.push({ ...rest, opacity: 0 });
  frames.content.push({ borderRadius: rest.borderRadius });
  return { frames, duration: time + frameMs, settle: settle ?? time, impact, push };
}

// The cards beside a landing give way a little and spring back, like a surface taking a drop.
function nudge(slot: HTMLElement, push: number, delay: number) {
  const rows = [[slot.previousElementSibling, -1], [slot.nextElementSibling, 1],
    [slot.previousElementSibling?.previousElementSibling, -0.45], [slot.nextElementSibling?.nextElementSibling, 0.45]] as const;
  for (const [row, share] of rows) {
    if (!(row instanceof HTMLElement) || !row.dataset.flip) continue;
    const frames: Keyframe[] = [];
    for (let time = 0; time < 100 || push * Math.exp(-time / 120) > 0.03; time += frameMs) frames.push({ transform: `translateY(${px(wobble(push * share, time))})` });
    frames.push({ transform: "translateY(0px)" });
    row.animate(frames, { duration: (frames.length - 1) * frameMs, delay: delay + (Math.abs(share) < 1 ? 40 : 0), easing: "linear", composite: "add" });
  }
}

function ownCorners(element: HTMLElement): Corners {
  const style = getComputedStyle(element);
  return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map((value) => parseFloat(value) || 0) as Corners;
}

// The color behind a card: its own background, or the first one behind it.
function paintOf(element: HTMLElement | null) {
  for (; element; element = element.parentElement) {
    const color = getComputedStyle(element).backgroundColor;
    if (color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") return color;
  }
  return "transparent";
}

/**
 * Pointer drag for Board cards, by card index. The card lifts and follows the pointer. A recessed slot opens at the
 * exact drop place in the column under the pointer, and the other cards slide around it. With reduced motion the card
 * still follows the pointer, but nothing slides or springs: the drop is instant.
 */
export function useBoardDrag(options: {
  lists: Record<string, readonly number[]>;
  scroller: RefObject<HTMLElement | null>;
  onDrop: (index: number, slot: BoardSlot) => void;
}) {
  const animationsOff = useAnimationsOff();
  const latest = useRef(options);
  latest.current = options;
  const [drag, setDrag] = useState<{ index: number; height: number; target: BoardSlot | null } | null>(null);
  const zones = useRef(new Map<string, HTMLElement>());
  const lists = useRef(new Map<string, HTMLElement>());
  const [refs] = useState(() => ({ zone: new Map<string, (el: HTMLElement | null) => void>(), list: new Map<string, (el: HTMLElement | null) => void>() }));
  const refFor = (kind: "zone" | "list", key: string) => {
    let ref = refs[kind].get(key);
    if (!ref) {
      const store = kind === "zone" ? zones : lists;
      ref = (el: HTMLElement | null) => { if (el) store.current.set(key, el); else store.current.delete(key); };
      refs[kind].set(key, ref);
    }
    return ref;
  };
  const abort = useRef<(() => void) | null>(null);
  // A landed card that is still settling over its place. A new drag clears it at once.
  const leftover = useRef<HTMLElement | null>(null);
  useEffect(() => () => { abort.current?.(); leftover.current?.remove(); }, []);
  // Safari lets a touch stop the page from scrolling only if a blocking touch listener was there when the touch began.
  useEffect(() => {
    const scroller = options.scroller.current;
    const keep = () => undefined;
    scroller?.addEventListener("touchmove", keep, { passive: false });
    return () => scroller?.removeEventListener("touchmove", keep);
  }, [options.scroller]);

  // FLIP: a card whose layout moved starts at its old place and slides to the new one.
  const positions = useRef(new WeakMap<HTMLElement, Map<string, number>>());
  useLayoutEffect(() => {
    const animate = canAnimate() && !animationsOff;
    for (const element of lists.current.values()) {
      const before = positions.current.get(element);
      const after = new Map<string, number>();
      for (const row of Array.from(element.querySelectorAll<HTMLElement>(":scope > [data-flip]"))) {
        const key = row.dataset.flip!;
        after.set(key, row.offsetTop);
        if (!animate) continue;
        const old = before?.get(key);
        if (old === undefined) {
          if (key === "slot") row.animate({ opacity: [0, 1] }, { duration: 140 });
          continue;
        }
        // A card that kept its place keeps any motion it has, such as the give after a landing.
        if (old === row.offsetTop) continue;
        const shown = old + new DOMMatrixReadOnly(getComputedStyle(row).transform).m42 - row.offsetTop;
        if (Math.abs(shown) < 0.5) continue;
        for (const animation of row.getAnimations()) animation.cancel();
        row.animate({ transform: [`translateY(${shown}px)`, "translateY(0)"] }, { duration: 200, easing: ease });
      }
      positions.current.set(element, after);
    }
  });

  // The column under the pointer picks the list; the cards' middles above the pointer pick the place.
  function hitTest(x: number, y: number, index: number): BoardSlot | null {
    for (const [list, zone] of zones.current) {
      // Each column reaches halfway into the gap beside it, so there is no dead band.
      const box = zone.getBoundingClientRect();
      if (x < box.left - 8 || x > box.right + 8 || y < box.top - 16 || y > box.bottom + 16) continue;
      const rows = Array.from(lists.current.get(list)?.querySelectorAll<HTMLElement>(":scope > [data-flip]") ?? []).filter((row) => row.dataset.flip !== "slot" && row.dataset.flip !== String(index));
      return { list, index: slotIndex(rows.map((row) => { const rect = layoutRect(row); return rect.top + rect.height / 2; }), y) };
    }
    return null;
  }

  function start(index: number, event: ReactPointerEvent<HTMLElement>) {
    const source = event.currentTarget;
    if (abort.current || event.button !== 0 || !event.isPrimary || !source.contains(event.target as Node) || (event.target as Element).closest("[data-no-drag]")) return;
    const touch = event.pointerType === "touch";
    const reduced = animationsOff;
    const origin = { x: event.clientX, y: event.clientY };
    const pointer = { ...origin };
    let overlay: HTMLDivElement | null = null;
    let shadow: HTMLDivElement;
    let surface: HTMLDivElement;
    let content: HTMLDivElement;
    let grab = { x: 0, y: 0 };
    let size = { width: 0, height: 0 };
    let at = { x: 0, y: 0 };
    let target: BoardSlot | null = null;
    let frame = 0;
    let settling: number | undefined;
    let liftedAt = 0;
    let lastX = origin.x;
    let velocity = 0;
    let tilt = 0;
    let scale = 1;
    // Pointer speed in px per second. A card that is thrown lands with that momentum.
    let fling = { x: 0, y: 0 };
    let last = { ...origin, time: 0 };
    let ended = false;
    let handedOff = false;
    // Touch waits for a long press, so a swipe still scrolls the page.
    const hold = touch ? window.setTimeout(() => { navigator.vibrate?.(8); lift(); }, 250) : undefined;

    const move = (moved: PointerEvent) => {
      if (moved.pointerId !== event.pointerId) return;
      pointer.x = moved.clientX;
      pointer.y = moved.clientY;
      if (overlay) return;
      const distance = Math.hypot(pointer.x - origin.x, pointer.y - origin.y);
      if (touch && distance > 8) release();
      else if (!touch && distance > 4) lift();
    };
    const up = (released: PointerEvent) => {
      if (released.pointerId !== event.pointerId) return;
      release();
      if (!overlay) return;
      // The pointer up after a drag must not also click what is under it.
      const swallow = (click: Event) => { click.stopPropagation(); click.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      if (released.type === "pointerup") aim();
      drop(released.type === "pointerup" ? target : null);
    };
    const key = (pressed: KeyboardEvent) => {
      if (pressed.key !== "Escape" || !overlay) return;
      pressed.preventDefault();
      release();
      drop(null);
    };
    const touchMove = (moved: TouchEvent) => { if (overlay) moved.preventDefault(); };
    const contextMenu = (opened: Event) => opened.preventDefault();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key, true);
    if (touch) {
      // The card leaves the page when it lifts, and touch events stay with the element the touch began on.
      // They never reach window again, so the card itself must stop the page from scrolling.
      source.addEventListener("touchmove", touchMove, { passive: false });
      window.addEventListener("contextmenu", contextMenu);
    }
    abort.current = () => { release(); finish(); };

    function release() {
      window.clearTimeout(hold);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key, true);
      source.removeEventListener("touchmove", touchMove);
      window.removeEventListener("contextmenu", contextMenu);
      if (!overlay) abort.current = null;
    }

    function lift() {
      if (overlay) return;
      window.clearTimeout(hold);
      leftover.current?.remove();
      leftover.current = null;
      const rect = source.getBoundingClientRect();
      grab = { x: origin.x - rect.left, y: origin.y - rect.top };
      size = { width: rect.width, height: rect.height };
      at = { x: rect.left, y: rect.top };
      overlay = document.createElement("div");
      for (const [name, value] of Object.entries(SCOPE)) overlay.setAttribute(name, value);
      overlay.setAttribute("aria-hidden", "true");
      overlay.inert = true;
      overlay.className = "pointer-events-none fixed left-0 top-0 z-50 select-none text-sm text-foreground";
      Object.assign(overlay.style, {
        width: `${rect.width}px`, height: `${rect.height}px`,
        transformOrigin: `${grab.x}px ${grab.y}px`, transform: `translate3d(${rect.left}px, ${rect.top}px, 0)`, willChange: "transform",
      });
      // The card has three layers: its shadow, its surface, and the card on top.
      // Only the surface goes soft when the card lands, so the text stays crisp.
      // The layers keep the card's own corners, so the clipped top layer never cuts the card's border.
      const corners = ownCorners(source).map((corner) => `${corner}px`).join(" ");
      const layer = (className: string) => {
        const element = document.createElement("div");
        element.className = `absolute inset-0 ${className}`;
        element.style.borderRadius = corners;
        return element;
      };
      shadow = layer("");
      surface = layer("bg-popover");
      content = layer("overflow-hidden");
      Object.assign(shadow.style, { boxShadow: liftShadow, opacity: "0", transition: reduced ? "" : "opacity 160ms ease-out" });
      const clone = source.cloneNode(true) as HTMLElement;
      clone.removeAttribute("data-flip");
      Object.assign(clone.style, { opacity: "1", background: "transparent", height: "100%" });
      content.append(clone);
      overlay.append(shadow, surface, content);
      const home = source.getRootNode();
      (home instanceof ShadowRoot ? home : document.body).append(overlay);
      overlay.getBoundingClientRect();
      shadow.style.opacity = "1";
      document.documentElement.style.cursor = "grabbing";
      document.documentElement.style.userSelect = "none";
      window.getSelection()?.removeAllRanges();
      liftedAt = performance.now();
      setDrag({ index, height: rect.height, target: null });
      frame = requestAnimationFrame(tick);
    }

    function tick(time: number) {
      // Near the board's left or right edge, the board scrolls toward the pointer.
      const scroller = latest.current.scroller.current;
      if (scroller && scroller.scrollWidth > scroller.clientWidth) {
        const box = scroller.getBoundingClientRect();
        const edge = Math.min(48, box.width / 6);
        const depth = pointer.x < box.left + edge ? pointer.x - box.left - edge : pointer.x > box.right - edge ? pointer.x - box.right + edge : 0;
        if (depth) scroller.scrollLeft += Math.sign(depth) * 16 * Math.min(1, Math.abs(depth) / edge) ** 2;
      }
      // The card leans into horizontal motion and settles back when the pointer rests.
      // A wide card leans less, so its far end never swings more than about 12px.
      velocity = velocity * 0.7 + (pointer.x - lastX) * 0.3;
      lastX = pointer.x;
      const lean = reduced ? 0 : Math.min(3, (Math.atan(12 / size.width) * 180) / Math.PI);
      tilt += (Math.max(-lean, Math.min(lean, velocity * 0.3)) - tilt) * 0.18;
      const elapsed = time - last.time;
      if (last.time && elapsed > 0) {
        fling = { x: fling.x * 0.6 + ((pointer.x - last.x) / elapsed) * 400, y: fling.y * 0.6 + ((pointer.y - last.y) / elapsed) * 400 };
      }
      last = { ...pointer, time };
      const grow = reduced ? 1 : Math.min(1, (time - liftedAt) / 160);
      scale = 1 + 0.025 * (1 - (1 - grow) ** 3);
      at = { x: pointer.x - grab.x, y: pointer.y - grab.y };
      overlay!.style.transform = `translate3d(${at.x}px, ${at.y}px, 0) rotate(${tilt.toFixed(2)}deg) scale(${scale.toFixed(4)})`;
      aim();
      frame = requestAnimationFrame(tick);
    }

    function aim() {
      const next = hitTest(pointer.x, pointer.y, index);
      if (next === target || (next && target && next.list === target.list && next.index === target.index)) return;
      target = next;
      setDrag({ index, height: size.height, target });
    }

    function drop(to: BoardSlot | null) {
      if (ended || !overlay) return;
      ended = true;
      cancelAnimationFrame(frame);
      document.documentElement.style.cursor = "";
      document.documentElement.style.userSelect = "";
      const home = homeOf(index, latest.current.lists);
      const moved = to !== null && !(home?.list === to.list && home.index === to.index);
      if (moved) latest.current.onDrop(index, to);
      // Commit the final slot now, so the card can fly into its measured place.
      flushSync(() => setDrag({ index, height: size.height, target: moved ? to : null }));
      if (reduced || !canAnimate()) { handOff(); finish(); return; }
      const slot = Array.from(lists.current.values()).map((list) => list.querySelector<HTMLElement>(':scope > [data-flip="slot"]')).find(Boolean);
      if (slot) land(slot);
      else fade();
    }

    // The card lands in its slot like a drop of jelly. It overshoots a little, its corners take the slot's shape,
    // its shadow sinks away, and the cards beside it give way. Then the real card takes over.
    function land(place: HTMLElement) {
      const card = overlay!;
      const to = layoutRect(place);
      const plan = landing({
        left: at.x, top: at.y, ...size, tilt, scale, velocity: fling,
        radius: parseFloat(getComputedStyle(surface).borderTopLeftRadius) || 0, shadow: parseFloat(getComputedStyle(shadow).opacity) || 1,
      }, to, ownCorners(place));
      const timing = { duration: plan.duration, easing: "linear", fill: "forwards" } as const;
      shadow.style.transition = "";
      const running = [
        card.animate(plan.frames.overlay, timing),
        surface.animate(plan.frames.surface, timing),
        shadow.animate(plan.frames.shadow, timing),
        content.animate(plan.frames.content, timing),
        surface.animate({ backgroundColor: [getComputedStyle(surface).backgroundColor, paintOf(source)] }, { duration: plan.settle, easing: "ease-out", fill: "forwards" }),
      ];
      if (plan.push) nudge(place, plan.push, plan.impact!);
      settling = window.setTimeout(handOff, plan.settle);
      void Promise.all(running.map((animation) => animation.finished)).catch(() => undefined).then(() => {
        handOff();
        // The settled card looks the same as the card under it, so it can fade out unseen.
        return card.animate({ opacity: [1, 0] }, { duration: 120, easing: "ease-out", fill: "forwards" }).finished;
      }).catch(() => undefined).then(finish);
    }

    // With nowhere to land, the card fades where it is.
    function fade() {
      overlay!.animate({ opacity: [1, 0] }, { duration: 220, easing: ease, fill: "forwards" }).finished.catch(() => undefined).then(() => { handOff(); finish(); });
    }

    // The real card replaces the slot under the lifted one in the same frame, so nothing blinks.
    // The board takes the pointer again while the card finishes settling on top.
    function handOff() {
      if (handedOff) return;
      handedOff = true;
      window.clearTimeout(settling);
      abort.current = null;
      leftover.current = overlay;
      flushSync(() => setDrag(null));
    }

    function finish() {
      overlay?.remove();
      if (leftover.current === overlay) leftover.current = null;
      overlay = null;
      if (handedOff) return;
      handedOff = true;
      ended = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(settling);
      document.documentElement.style.cursor = "";
      document.documentElement.style.userSelect = "";
      abort.current = null;
      setDrag(null);
    }
  }

  const home = drag ? homeOf(drag.index, options.lists) : null;
  // The slot sits at the drop target. Away from every column it goes back home, which means "cancel".
  const slot = drag ? drag.target ?? home : null;
  return {
    dragging: drag !== null,
    /** The lifted card's height, for the slot. */
    height: drag?.height ?? 0,
    zoneRef: (key: string) => refFor("zone", key),
    listRef: (key: string) => refFor("list", key),
    handle: (index: number) => ({ onPointerDown: (event: ReactPointerEvent<HTMLElement>) => start(index, event) }),
    /** A column as shown during a drag: without the lifted card, with `null` where the slot goes. */
    items: <T extends { index: number }>(list: string, cards: readonly T[]): Array<T | null> => (drag ? dropItems(cards, drag.index, slot?.list === list ? slot.index : null) : [...cards]),
  };
}
