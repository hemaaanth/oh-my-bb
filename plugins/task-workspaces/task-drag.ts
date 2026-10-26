import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { usePortalScopeProps } from "./lib/portal-scope";

export type DropList = "urgent" | "high";
export type DropSlot = { list: DropList; index: number };
// A drop goes into a slot in Now or Later, or onto a project card in All tasks.
type Target = (DropSlot & { header: boolean }) | { project: string };
const sameTarget = (left: Target | null, right: Target | null) => left === right || (left !== null && right !== null && ("project" in left
  ? "project" in right && left.project === right.project
  : !("project" in right) && left.list === right.list && left.index === right.index && left.header === right.header));

const dropLists: DropList[] = ["urgent", "high"];
const liftShadow = "0 0 0 1px var(--border), 0 18px 36px -10px rgb(0 0 0 / 0.35), 0 6px 14px -6px rgb(0 0 0 / 0.2)";
const ease = "cubic-bezier(0.2, 0.9, 0.3, 1)";

function homeOf(taskId: string, lists: Record<DropList, ReadonlyArray<{ id: string }>>): DropSlot | null {
  for (const list of dropLists) {
    const index = lists[list].findIndex((task) => task.id === taskId);
    if (index >= 0) return { list, index };
  }
  return null;
}

// Layout position inside the page, without any running FLIP transform.
function layoutRect(row: HTMLElement) {
  const list = row.offsetParent as HTMLElement;
  const box = list.getBoundingClientRect();
  return { left: box.left + list.clientLeft + row.offsetLeft, top: box.top + list.clientTop + row.offsetTop, width: row.offsetWidth, height: row.offsetHeight };
}

type Box = { left: number; top: number; width: number; height: number };
type Corners = [number, number, number, number];
type Spring = readonly [stiffness: number, damping: number];
type Motion = { value: number; velocity: number; spring: Spring };

// Springs in the spirit of liquid-gooey. The card's mass travels first and goes a little past its place.
// The lift sinks a beat later, and the corners take the row's shape.
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
function landing(from: Box & { tilt: number; scale: number; radius: number; shadow: number; velocity: { x: number; y: number } }, to: Box, corners: Corners, reduced: boolean) {
  const motion = (value: number, spring: Spring, velocity = 0): Motion => ({ value, velocity, spring });
  const fling = (speed: number) => reduced ? 0 : Math.max(-2000, Math.min(2000, speed));
  const x = motion(from.left - to.left, reduced ? sharpen : travel, fling(from.velocity.x));
  const y = motion(from.top - to.top, reduced ? sharpen : travel, fling(from.velocity.y));
  const turn = motion(from.tilt, reduced ? sharpen : travel);
  const lift = motion(1, reduced ? sharpen : sink);
  const width = motion(from.width - to.width, reduced ? sharpen : resize);
  const height = motion(from.height - to.height, reduced ? sharpen : resize);
  const radii = corners.map((corner) => motion(from.radius - corner, sharpen));
  const all = [x, y, turn, lift, width, height, ...radii];
  const frames = { overlay: [] as Keyframe[], surface: [] as Keyframe[], shadow: [] as Keyframe[], content: [] as Keyframe[] };
  let impact: number | undefined;
  let push = 0;
  let settle: number | undefined;
  let time = 0;
  for (; ; time += frameMs) {
    // The card touches down once it is over its place and has mostly sunk. It squashes, and the rows beside it give way.
    if (impact === undefined && Math.hypot(x.value, y.value) < 1.5 && lift.value < 0.35) {
      impact = time;
      push = reduced ? 0 : Math.min(2, 0.6 + (Math.hypot(x.velocity, y.velocity) + Math.abs(lift.velocity) * 30) / 400);
    }
    const squash = impact === undefined ? 0 : wobble(push, time - impact);
    // Like a drop, the corners round out first and then take the row's shape.
    const drop = reduced ? 0 : Math.min(time / 125, (1 - Math.min(1, time / 460)) ** 3) * 0.6;
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
    // The real row can take over under the card once the card covers it.
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

// The rows beside a landing give way a little and spring back, like a surface taking a drop.
function nudge(slot: HTMLElement, push: number, delay: number) {
  const rows = [[slot.previousElementSibling, -1], [slot.nextElementSibling, 1],
    [slot.previousElementSibling?.previousElementSibling, -0.45], [slot.nextElementSibling?.nextElementSibling, 0.45]] as const;
  for (const [row, share] of rows) {
    if (!(row instanceof HTMLElement) || !(row.dataset.flip || row.dataset.task)) continue;
    const frames: Keyframe[] = [];
    for (let time = 0; time < 100 || push * Math.exp(-time / 120) > 0.03; time += frameMs) frames.push({ transform: `translateY(${px(wobble(push * share, time))})` });
    frames.push({ transform: "translateY(0px)" });
    row.animate(frames, { duration: (frames.length - 1) * frameMs, delay: delay + (Math.abs(share) < 1 ? 40 : 0), easing: "linear", composite: "add" });
  }
}

// A row in a list shows the list's inner corners at the ends and square corners between.
function listCorners(row: HTMLElement): Corners {
  const list = getComputedStyle(row.parentElement!);
  const inner = (radius: string, border: string) => Math.max(0, parseFloat(radius) - parseFloat(border));
  const first = !row.previousElementSibling;
  const last = !row.nextElementSibling;
  return [
    first ? inner(list.borderTopLeftRadius, list.borderTopWidth) : 0,
    first ? inner(list.borderTopRightRadius, list.borderTopWidth) : 0,
    last ? inner(list.borderBottomRightRadius, list.borderBottomWidth) : 0,
    last ? inner(list.borderBottomLeftRadius, list.borderBottomWidth) : 0,
  ];
}

function ownCorners(element: HTMLElement): Corners {
  const style = getComputedStyle(element);
  return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map(parseFloat) as Corners;
}

// The color behind a row: its own background, or the first one behind it.
function paintOf(element: HTMLElement | null) {
  for (; element; element = element.parentElement) {
    const color = getComputedStyle(element).backgroundColor;
    if (color !== "transparent" && color !== "rgba(0, 0, 0, 0)") return color;
  }
  return "transparent";
}

/**
 * Pointer drag for Now, Later, and the project cards. The row lifts into a card that follows the pointer.
 * In Now and Later a recessed slot opens at the exact drop index, and the other rows slide around it.
 * Over another project card the card lights up, and the task moves to that project.
 */
export function useTaskDrag<T extends { id: string }>(options: {
  lists: Record<DropList, readonly T[]>;
  laterOpen: boolean;
  openLater: () => void;
  scroller: RefObject<HTMLElement | null>;
  onDrop: (task: T, slot: DropSlot) => void;
  projectOf: (task: T) => string;
  onMove: (task: T, projectId: string) => void;
}) {
  const scope = usePortalScopeProps();
  const latest = useRef({ ...options, scope });
  latest.current = { ...options, scope };
  // `landing` is set once the task is dropped on a project card and the lifted card flies to its new row.
  const [drag, setDrag] = useState<{ task: T; target: Target | null; landing?: boolean } | null>(null);
  const zones = useRef<Partial<Record<DropList, HTMLElement | null>>>({});
  const lists = useRef<Partial<Record<DropList, HTMLElement | null>>>({});
  const cards = useRef(new Map<string, HTMLElement>());
  const [refs] = useState(() => ({
    zone: { urgent: (el: HTMLElement | null) => { zones.current.urgent = el; }, high: (el: HTMLElement | null) => { zones.current.high = el; } },
    list: { urgent: (el: HTMLElement | null) => { lists.current.urgent = el; }, high: (el: HTMLElement | null) => { lists.current.high = el; } },
    cards: new Map<string, (el: HTMLElement | null) => void>(),
  }));
  const cardRef = (projectId: string) => {
    let ref = refs.cards.get(projectId);
    if (!ref) {
      ref = (el: HTMLElement | null) => { if (el) cards.current.set(projectId, el); else cards.current.delete(projectId); };
      refs.cards.set(projectId, ref);
    }
    return ref;
  };
  const abort = useRef<(() => void) | null>(null);
  // A landed card that is still settling over its row. A new drag clears it at once.
  const leftover = useRef<HTMLElement | null>(null);
  useEffect(() => () => { abort.current?.(); leftover.current?.remove(); }, []);
  // Safari lets a touch stop the page from scrolling only if a blocking touch listener was there when the touch began.
  useEffect(() => {
    const scroller = options.scroller.current;
    const keep = () => undefined;
    scroller?.addEventListener("touchmove", keep, { passive: false });
    return () => scroller?.removeEventListener("touchmove", keep);
  }, [options.scroller]);

  // FLIP: a row whose layout moved starts at its old place and slides to the new one.
  const positions = useRef(new WeakMap<HTMLElement, Map<string, number>>());
  useLayoutEffect(() => {
    for (const list of dropLists) {
      const element = lists.current[list];
      if (!element) continue;
      const before = positions.current.get(element);
      const after = new Map<string, number>();
      for (const row of Array.from(element.querySelectorAll<HTMLElement>(":scope > [data-flip]"))) {
        const key = row.dataset.flip!;
        after.set(key, row.offsetTop);
        const old = before?.get(key);
        if (old === undefined) {
          if (key === "slot") row.animate({ opacity: [0, 1] }, { duration: 140 });
          continue;
        }
        // A row that kept its place keeps any motion it has, such as the give after a landing.
        if (old === row.offsetTop) continue;
        const shown = old + new DOMMatrixReadOnly(getComputedStyle(row).transform).m42 - row.offsetTop;
        if (Math.abs(shown) < 0.5) continue;
        for (const animation of row.getAnimations()) animation.cancel();
        row.animate({ transform: [`translateY(${shown}px)`, "translateY(0)"] }, { duration: 200, easing: ease });
      }
      positions.current.set(element, after);
    }
  });

  function hitTest(x: number, y: number, taskId: string): Target | null {
    for (const list of dropLists) {
      const zone = zones.current[list];
      if (!zone) continue;
      // Each zone reaches halfway into the gap between sections, so there is no dead band.
      const box = zone.getBoundingClientRect();
      if (y < box.top - 16 || y > box.bottom + 16) continue;
      if (list === "high" && !latest.current.laterOpen) return { list, index: 0, header: true };
      const element = lists.current[list];
      let index = 0;
      for (const row of Array.from(element?.querySelectorAll<HTMLElement>(":scope > [data-flip]") ?? [])) {
        if (row.dataset.flip === "slot" || row.dataset.flip === taskId) continue;
        const rect = layoutRect(row);
        if (rect.top + rect.height / 2 < y) index++;
      }
      return { list, index, header: false };
    }
    // Each card reaches halfway into the gaps around it.
    for (const [project, card] of cards.current) {
      const box = card.getBoundingClientRect();
      if (x >= box.left - 6 && x <= box.right + 6 && y >= box.top - 6 && y <= box.bottom + 6) return { project };
    }
    return null;
  }

  function start(task: T, event: ReactPointerEvent<HTMLElement>) {
    const source = event.currentTarget;
    // Portaled menus bubble React events to their row, so only presses inside the row count.
    if (abort.current || event.button !== 0 || !event.isPrimary || !source.contains(event.target as Node) || (event.target as Element).closest("[data-no-drag]")) return;
    const touch = event.pointerType === "touch";
    const origin = { x: event.clientX, y: event.clientY };
    const pointer = { ...origin };
    let overlay: HTMLDivElement | null = null;
    let shadow: HTMLDivElement;
    let surface: HTMLDivElement;
    let content: HTMLDivElement;
    let grab = { x: 0, y: 0 };
    let size = { width: 0, height: 0 };
    let at = { x: 0, y: 0 };
    let target: Target | null = null;
    let frame = 0;
    let spring: number | undefined;
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
      // The pointer up after a drag must not also open the task under it.
      const swallow = (click: Event) => { click.stopPropagation(); click.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      drop(released.type === "pointerup" ? target : null);
    };
    const key = (pressed: KeyboardEvent) => {
      if (pressed.key !== "Escape" || !overlay) return;
      pressed.preventDefault();
      drop(null);
    };
    const touchMove = (moved: TouchEvent) => { if (overlay) moved.preventDefault(); };
    const contextMenu = (opened: Event) => opened.preventDefault();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key, true);
    if (touch) {
      // The row leaves the page when it lifts, and touch events stay with the element the touch began on.
      // They never reach window again, so the row itself must stop the page from scrolling.
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
      for (const [name, value] of Object.entries(latest.current.scope)) overlay.setAttribute(name, value);
      overlay.setAttribute("aria-hidden", "true");
      overlay.inert = true;
      overlay.className = "pointer-events-none fixed left-0 top-0 z-50 text-foreground";
      Object.assign(overlay.style, {
        width: `${rect.width}px`, height: `${rect.height}px`,
        transformOrigin: `${grab.x}px ${grab.y}px`, transform: `translate3d(${rect.left}px, ${rect.top}px, 0)`, willChange: "transform",
      });
      // The card has three layers: its shadow, its surface, and the row on top.
      // Only the surface goes soft when the card lands, so the text stays crisp.
      const layer = (className: string) => {
        const element = document.createElement("div");
        element.className = `absolute inset-0 rounded-lg ${className}`;
        return element;
      };
      shadow = layer("");
      surface = layer("bg-popover");
      content = layer("overflow-hidden");
      Object.assign(shadow.style, { boxShadow: liftShadow, opacity: "0", transition: "opacity 160ms ease-out" });
      const clone = source.cloneNode(true) as HTMLElement;
      clone.removeAttribute("data-flip");
      Object.assign(clone.style, { opacity: "1", background: "transparent" });
      content.append(clone);
      overlay.append(shadow, surface, content);
      document.body.append(overlay);
      overlay.getBoundingClientRect();
      shadow.style.opacity = "1";
      document.documentElement.style.cursor = "grabbing";
      document.documentElement.style.userSelect = "none";
      window.getSelection()?.removeAllRanges();
      liftedAt = performance.now();
      setDrag({ task, target: null });
      frame = requestAnimationFrame(tick);
    }

    function tick(time: number) {
      const scroller = latest.current.scroller.current;
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        const edge = Math.min(72, box.height / 4);
        const depth = pointer.y < box.top + edge ? pointer.y - box.top - edge : pointer.y > box.bottom - edge ? pointer.y - box.bottom + edge : 0;
        if (depth) scroller.scrollTop += Math.sign(depth) * 20 * Math.min(1, Math.abs(depth) / edge) ** 2;
      }
      // The card leans into horizontal motion and settles back when the pointer rests.
      // A wide card leans less, so its far end never swings more than about 12px.
      velocity = velocity * 0.7 + (pointer.x - lastX) * 0.3;
      lastX = pointer.x;
      const lean = Math.min(3, (Math.atan(12 / size.width) * 180) / Math.PI);
      tilt += (Math.max(-lean, Math.min(lean, velocity * 0.3)) - tilt) * 0.18;
      const elapsed = time - last.time;
      if (last.time && elapsed > 0) {
        fling = { x: fling.x * 0.6 + ((pointer.x - last.x) / elapsed) * 400, y: fling.y * 0.6 + ((pointer.y - last.y) / elapsed) * 400 };
      }
      last = { ...pointer, time };
      const grow = Math.min(1, (time - liftedAt) / 160);
      scale = 1 + 0.025 * (1 - (1 - grow) ** 3);
      at = { x: pointer.x - grab.x, y: pointer.y - grab.y };
      overlay!.style.transform = `translate3d(${at.x}px, ${at.y}px, 0) rotate(${tilt.toFixed(2)}deg) scale(${scale.toFixed(4)})`;
      aim();
      frame = requestAnimationFrame(tick);
    }

    function aim() {
      const next = hitTest(pointer.x, pointer.y, task.id);
      // Holding over a closed Later opens it, like a spring-loaded folder.
      if (next && "header" in next && next.header) spring ??= window.setTimeout(() => latest.current.openLater(), 500);
      else { window.clearTimeout(spring); spring = undefined; }
      if (sameTarget(next, target)) return;
      target = next;
      setDrag({ task, target });
    }

    function drop(to: Target | null) {
      if (ended || !overlay) return;
      ended = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(spring);
      document.documentElement.style.cursor = "";
      document.documentElement.style.userSelect = "";
      if (to && "project" in to && to.project !== latest.current.projectOf(task)) {
        latest.current.onMove(task, to.project);
        // Show the task in its new card now, so the card can fly into its row there.
        flushSync(() => setDrag({ task, target: to, landing: true }));
        const card = cards.current.get(to.project);
        const place = card?.querySelector<HTMLElement>(`[data-task="${CSS.escape(task.id)}"]`);
        if (place) land(place, false);
        else fade(card?.querySelector("h3")?.getBoundingClientRect());
        return;
      }
      const slotTo = to && !("project" in to) ? to : null;
      const home = homeOf(task.id, latest.current.lists);
      const moved = slotTo !== null && !(home?.list === slotTo.list && home.index === slotTo.index);
      if (moved) latest.current.onDrop(task, { list: slotTo.list, index: slotTo.index });
      // Commit the final slot now, so the card can fly into its measured place.
      flushSync(() => setDrag({ task, target: moved ? slotTo : null }));
      const header = moved && slotTo.header ? zones.current.high?.getBoundingClientRect() : undefined;
      const slot = header ? undefined : dropLists.map((list) => lists.current[list]?.querySelector<HTMLElement>(':scope > [data-flip="slot"]')).find(Boolean);
      const back = !moved && !slot && source.isConnected ? source : undefined;
      if (slot || back) land(slot ?? back!, Boolean(slot));
      else fade(header);
    }

    // The card lands in its row like a drop of jelly. It overshoots a little, its corners take the
    // row's shape, its shadow sinks away, and the rows beside it give way. Then the real row takes over.
    function land(place: HTMLElement, inList: boolean) {
      const card = overlay!;
      const to = inList ? { ...layoutRect(place), height: place.clientHeight } : place.getBoundingClientRect();
      const plan = landing({
        left: at.x, top: at.y, ...size, tilt, scale, velocity: fling,
        radius: parseFloat(getComputedStyle(surface).borderTopLeftRadius), shadow: parseFloat(getComputedStyle(shadow).opacity),
      }, to, inList ? listCorners(place) : ownCorners(place), matchMedia("(prefers-reduced-motion: reduce)").matches);
      const timing = { duration: plan.duration, easing: "linear", fill: "forwards" } as const;
      shadow.style.transition = "";
      const running = [
        card.animate(plan.frames.overlay, timing),
        surface.animate(plan.frames.surface, timing),
        shadow.animate(plan.frames.shadow, timing),
        content.animate(plan.frames.content, timing),
        surface.animate({ backgroundColor: [getComputedStyle(surface).backgroundColor, paintOf(place)] }, { duration: plan.settle, easing: "ease-out", fill: "forwards" }),
      ];
      if (plan.push) nudge(place, plan.push, plan.impact!);
      // A row of another shape takes over the card's face as it flies, so no text reflows on the way.
      if (!inList && place !== source) {
        const before = content.firstElementChild as HTMLElement;
        const face = place.cloneNode(true) as HTMLElement;
        face.removeAttribute("data-task");
        Object.assign(before.style, { width: `${size.width}px` });
        Object.assign(face.style, { position: "absolute", left: "0", top: "0", width: `${to.width}px`, height: `${to.height}px`, opacity: "1", background: "transparent" });
        content.append(face);
        before.animate({ opacity: [1, 0] }, { duration: 180, easing: "ease-out", fill: "forwards" });
        face.animate({ opacity: [0, 1] }, { duration: 180, easing: "ease-out", fill: "forwards" });
      }
      settling = window.setTimeout(handOff, plan.settle);
      void Promise.all(running.map((animation) => animation.finished)).catch(() => undefined).then(() => {
        handOff();
        // The settled card looks the same as the row under it, so it can fade out unseen.
        return card.animate({ opacity: [1, 0] }, { duration: 120, easing: "ease-out", fill: "forwards" }).finished;
      }).catch(() => undefined).then(finish);
    }

    // Over a closed Later or a folded card the card shrinks into its header. With nowhere to go it fades where it is.
    function fade(header: DOMRect | undefined) {
      const card = overlay!;
      const end = header ? `translate3d(${header.left}px, ${header.top}px, 0) rotate(0deg) scale(0.9)` : card.style.transform;
      card.animate([{ transform: card.style.transform, opacity: 1 }, { transform: end, opacity: 0 }], { duration: 220, easing: ease, fill: "forwards" })
        .finished.catch(() => undefined).then(() => { handOff(); finish(); });
    }

    // The real row replaces the slot under the card in the same frame, so nothing blinks.
    // The page takes the pointer again while the card finishes settling on top.
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
      overlay = null;
      if (handedOff) return;
      handedOff = true;
      ended = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(spring);
      window.clearTimeout(settling);
      document.documentElement.style.cursor = "";
      document.documentElement.style.userSelect = "";
      abort.current = null;
      setDrag(null);
    }
  }

  const home = drag ? homeOf(drag.task.id, options.lists) : null;
  const target = drag?.target ?? null;
  const overProject = target && "project" in target && drag && target.project !== options.projectOf(drag.task) ? target.project : null;
  // The slot sits at the drop target. Away from every list it goes back home, which means "cancel".
  // Over the closed Later header or a project card it also stays home: the header or card lights up,
  // and nothing shifts under the pointer.
  const slot = !drag ? null : target && !("project" in target) && !target.header ? target : home;
  return {
    draggingId: drag?.task.id ?? null,
    /** The dragged task has moved to another project, and the lifted card is flying to its new row. */
    landing: drag?.landing ?? false,
    overLaterHeader: target !== null && "header" in target && target.header,
    overProject,
    zoneRef: refs.zone,
    listRef: refs.list,
    cardRef,
    handle: (task: T) => ({ onPointerDown: (event: ReactPointerEvent<HTMLElement>) => start(task, event) }),
    /** The list as shown during a drag: without the lifted task, with `null` where the slot goes. */
    items: (list: DropList, tasks: readonly T[]): Array<T | null> => {
      if (!drag || drag.landing) return [...tasks];
      const rest = tasks.filter((task) => task.id !== drag.task.id);
      return slot?.list === list ? [...rest.slice(0, slot.index), null, ...rest.slice(slot.index)] : rest;
    },
  };
}
