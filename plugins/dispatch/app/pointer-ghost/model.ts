// The pointer ghost: a display-only pointer that shows the agent switching
// threads, typing and sending during a call (SPEC §8). It is a picture, not an
// input device. It never dispatches clicks or keys, and its overlay ignores
// pointer events, so the user's own taps always land on the app. Every real
// action still runs through the BB SDK; the ghost only plays in front of it.
//
// Targets are found through BB's sidebar row attributes and Dispatch's own
// markers. Host DOM is not a stable plugin contract, so a missing target
// shows nothing.

import { pointerGhostEnabled } from "@/voice/local.js";

export type GhostTarget =
  | { kind: "thread"; threadId: string }
  | { kind: "composer" }
  | { kind: "send" }
  | { kind: "pet" };

export interface GhostPoint { x: number; y: number }

export interface GhostSnapshot {
  visible: boolean;
  /** Pointer tip in viewport pixels, or null when the target is off screen. */
  at: GhostPoint | null;
  /** Bumped on each press so the overlay replays its ripple. */
  presses: number;
  /** Glide duration to `at`; 0 jumps (reduced motion, first placement). */
  moveMs: number;
}

/** What the tool dispatcher drives. Tests pass a fake. */
export interface PointerGhost {
  /** Glide to a target. Resolves when the glide ends; true if the target is on screen. */
  point(target: GhostTarget): Promise<boolean>;
  /** Play a press at the current position. Display only: nothing is clicked. */
  press(): Promise<void>;
  hide(): void;
  /** How many times the user has touched the screen. A change means they took over. */
  touches(): number;
}

/** Marks the footer pet, where the ghost enters from. */
export const PET_MARKER = "data-dispatch-pet";
/** Marks the composer that holds Dispatch's call controls. */
export const COMPOSER_MARKER = "data-dispatch-composer";

const MOVE_MS = 420;
const PRESS_MS = 180;
/** One frame-ish gap so the browser paints the start point before the glide. */
const PLACE_MS = 34;
const IDLE_HIDE_MS = 2600;

type Locate = (target: GhostTarget) => GhostPoint | null;

interface GhostOptions {
  locate?: Locate;
  wait?: (ms: number) => Promise<void>;
  reducedMotion?: () => boolean;
  enabled?: () => boolean;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function cssString(value: string) {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

/** Visible, unobstructed, and centred inside the viewport. */
function onScreen(element: Element, root: Document): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const view = root.defaultView;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (!view || x < 0 || y < 0 || x > view.innerWidth || y > view.innerHeight) return false;
  // A drawer, dialog, or mobile backdrop on top means the user cannot see it.
  if (typeof root.elementFromPoint !== "function") return true;
  const hit = root.elementFromPoint(x, y);
  return !!hit && (hit === element || element.contains(hit));
}

function findThreadRow(threadId: string, root: Document): Element | null {
  const rows = root.querySelectorAll(`[data-sidebar-thread-id="${cssString(threadId)}"]`);
  for (const row of rows) {
    if (row.closest("[data-sidebar-overflow='true']")) continue;
    if (onScreen(row, root)) return row;
    // A row scrolled out of a visible sidebar comes into view the way a person
    // would scroll to it. Rows in a sidebar slid off screen (mobile) stay put.
    const rect = row.getBoundingClientRect();
    const view = root.defaultView;
    const x = rect.left + rect.width / 2;
    if (!view || rect.height <= 0 || x < 0 || x > view.innerWidth) continue;
    row.scrollIntoView?.({ block: "nearest" });
    if (onScreen(row, root)) return row;
  }
  return null;
}

/** The composer editor near Dispatch's composer marker. */
function findComposer(root: Document): Element | null {
  for (const marker of root.querySelectorAll(`[${COMPOSER_MARKER}]`)) {
    let node: Element | null = marker.parentElement;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      const editor = node.querySelector("[contenteditable='true'], textarea");
      if (editor && onScreen(editor, root)) return editor;
    }
  }
  return null;
}

/** The composer's send button, else the composer's trailing corner. */
function findSend(root: Document): GhostPoint | null {
  const editor = findComposer(root);
  if (!editor) return null;
  let node: Element | null = editor.parentElement;
  for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
    const button = node.querySelector("button[type='submit'], button[aria-label*='send' i]");
    if (button && onScreen(button, root)) {
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
  }
  const rect = editor.getBoundingClientRect();
  return { x: rect.right - 16, y: rect.bottom - 12 };
}

function findPet(root: Document): GhostPoint | null {
  for (const pet of root.querySelectorAll(`[${PET_MARKER}]`)) {
    if (!onScreen(pet, root)) continue;
    const rect = pet.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  return null;
}

/** Where the pointer tip goes for a target in the live document, or null. */
export function locateTarget(target: GhostTarget, root: Document | undefined = typeof document === "undefined" ? undefined : document): GhostPoint | null {
  if (!root) return null;
  if (target.kind === "send") return findSend(root);
  if (target.kind === "pet") return findPet(root);
  const element = target.kind === "thread" ? findThreadRow(target.threadId, root) : findComposer(root);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { x: rect.left + Math.min(rect.width * 0.35, 72), y: rect.top + rect.height / 2 };
}

export class GhostStore implements PointerGhost {
  private value: GhostSnapshot = { visible: false, at: null, presses: 0, moveMs: 0 };
  private listeners = new Set<() => void>();
  private idle: ReturnType<typeof setTimeout> | null = null;
  private touchCount = 0;
  private locate: Locate;
  private wait: (ms: number) => Promise<void>;
  private reducedMotion: () => boolean;
  private enabled: () => boolean;

  constructor(options: GhostOptions = {}) {
    this.locate = options.locate ?? ((target) => locateTarget(target));
    this.wait = options.wait ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.reducedMotion = options.reducedMotion ?? prefersReducedMotion;
    this.enabled = options.enabled ?? (() => typeof document !== "undefined" && pointerGhostEnabled());
  }

  readonly get = () => this.value;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(next: Partial<GhostSnapshot>) {
    this.value = { ...this.value, ...next };
    for (const listener of this.listeners) listener();
  }

  private armIdle() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.hide(), IDLE_HIDE_MS);
    (this.idle as { unref?: () => void }).unref?.();
  }

  async point(target: GhostTarget): Promise<boolean> {
    if (!this.enabled()) return false;
    const at = this.locate(target);
    if (!at) {
      this.hide();
      return false;
    }
    const glide = !this.reducedMotion();
    // Enter from the pet, so the first move reads as the agent reaching out.
    if (glide && (!this.value.visible || !this.value.at)) {
      const origin = this.locate({ kind: "pet" });
      if (origin) {
        this.set({ visible: true, at: origin, moveMs: 0 });
        await this.wait(PLACE_MS);
      }
    }
    this.set({ visible: true, at, moveMs: glide ? MOVE_MS : 0 });
    this.armIdle();
    if (glide) await this.wait(MOVE_MS);
    return true;
  }

  async press(): Promise<void> {
    if (!this.value.visible || !this.value.at) return;
    this.set({ presses: this.value.presses + 1 });
    this.armIdle();
    await this.wait(this.reducedMotion() ? 0 : PRESS_MS);
  }

  readonly touches = () => this.touchCount;

  /** The user touched the screen: they win, so the ghost gets out of the way. */
  userTouched() {
    this.touchCount++;
    this.hide();
  }

  hide() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (this.value.visible) this.set({ visible: false });
  }
}

export const pointerGhost = new GhostStore();
