// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCAL_KEYS } from "@/shared/constants.js";
import { GhostStore, locateTarget, type GhostPoint, type GhostSnapshot, type GhostTarget } from "./model.js";

function store(options: { found?: Record<string, GhostPoint | null>; reduced?: boolean; enabled?: boolean } = {}) {
  const frames: GhostSnapshot[] = [];
  const waits: number[] = [];
  const key = (target: GhostTarget) => (target.kind === "thread" ? target.threadId : target.kind);
  const ghost = new GhostStore({
    locate: (target) => options.found?.[key(target)] ?? null,
    wait: async (ms) => {
      waits.push(ms);
    },
    reducedMotion: () => options.reduced ?? false,
    enabled: () => options.enabled ?? true,
  });
  ghost.subscribe(() => frames.push(ghost.get()));
  return { ghost, frames, waits };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GhostStore", () => {
  it("enters from the pet on first show, then glides to the target", async () => {
    const f = store({ found: { pet: { x: 10, y: 500 }, a: { x: 40, y: 120 } } });
    expect(await f.ghost.point({ kind: "thread", threadId: "a" })).toBe(true);
    expect(f.frames.map((frame) => [frame.at, frame.moveMs])).toEqual([[{ x: 10, y: 500 }, 0], [{ x: 40, y: 120 }, 420]]);
    expect(f.waits).toEqual([34, 420]);
    // Once shown, the next target glides from where the ghost is.
    f.frames.length = 0;
    await f.ghost.point({ kind: "thread", threadId: "a" });
    expect(f.frames.map((frame) => frame.moveMs)).toEqual([420]);
  });

  it("jumps straight to the target with reduced motion", async () => {
    const f = store({ reduced: true, found: { pet: { x: 10, y: 500 }, a: { x: 40, y: 120 } } });
    await f.ghost.point({ kind: "thread", threadId: "a" });
    expect(f.frames.map((frame) => frame.moveMs)).toEqual([0]);
    expect(f.waits).toEqual([]);
  });

  it("counts each press so the ripple replays", async () => {
    const f = store({ found: { a: { x: 40, y: 120 } } });
    await f.ghost.point({ kind: "thread", threadId: "a" });
    await f.ghost.press();
    await f.ghost.press();
    expect(f.ghost.get().presses).toBe(2);
  });

  it("hides on an off-screen target and never presses there", async () => {
    const f = store({ found: { a: { x: 40, y: 120 } } });
    await f.ghost.point({ kind: "thread", threadId: "a" });
    expect(await f.ghost.point({ kind: "thread", threadId: "gone" })).toBe(false);
    expect(f.ghost.get().visible).toBe(false);
    await f.ghost.press();
    expect(f.ghost.get().presses).toBe(0);
  });

  it("hides after it sits idle", async () => {
    vi.useFakeTimers();
    const f = store({ reduced: true, found: { a: { x: 40, y: 120 } } });
    await f.ghost.point({ kind: "thread", threadId: "a" });
    vi.advanceTimersByTime(2500);
    expect(f.ghost.get().visible).toBe(true);
    vi.advanceTimersByTime(200);
    expect(f.ghost.get().visible).toBe(false);
  });

  it("hides on the user's own touch and counts it, so a pending send can stop", async () => {
    const f = store({ found: { a: { x: 40, y: 120 } } });
    await f.ghost.point({ kind: "thread", threadId: "a" });
    const before = f.ghost.touches();
    f.ghost.userTouched();
    expect(f.ghost.touches()).toBe(before + 1);
    expect(f.ghost.get().visible).toBe(false);
  });

  it("shows nothing on a device that turned it off", async () => {
    const f = store({ enabled: false, found: { a: { x: 1, y: 1 } } });
    expect(await f.ghost.point({ kind: "thread", threadId: "a" })).toBe(false);
    expect(f.frames).toHaveLength(0);
  });

  it("is on by default and off only when the device saved off", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: () => undefined, removeItem: () => undefined });
    Object.defineProperty(window, "localStorage", { configurable: true, value: globalThis.localStorage });
    const ghost = new GhostStore({ locate: () => ({ x: 1, y: 1 }), wait: async () => undefined, reducedMotion: () => true });
    expect(await ghost.point({ kind: "composer" })).toBe(true);
    values.set(LOCAL_KEYS.pointerGhost, "off");
    expect(await ghost.point({ kind: "composer" })).toBe(false);
  });
});

describe("locateTarget", () => {
  const rect = (left: number, top: number) => () =>
    ({ left, top, width: 200, height: 32, right: left + 200, bottom: top + 32, x: left, y: top, toJSON() {} }) as DOMRect;

  it("skips hidden overflow rows and off-screen sidebars", () => {
    document.body.innerHTML = `
      <div data-sidebar-overflow="true"><a id="hidden" data-sidebar-thread-id="thr_a"></a></div>
      <a id="row" data-sidebar-thread-id="thr_a"></a>
      <a id="offcanvas" data-sidebar-thread-id="thr_b"></a>`;
    document.getElementById("hidden")!.getBoundingClientRect = rect(0, 0);
    document.getElementById("row")!.getBoundingClientRect = rect(0, 100);
    // A mobile sidebar slid off screen to the left.
    document.getElementById("offcanvas")!.getBoundingClientRect = rect(-320, 100);
    expect(locateTarget({ kind: "thread", threadId: "thr_a" }, document)).toEqual({ x: 70, y: 116 });
    expect(locateTarget({ kind: "thread", threadId: "thr_b" }, document)).toBeNull();
    expect(locateTarget({ kind: "thread", threadId: "thr_missing" }, document)).toBeNull();
  });

  it("finds the pet and the composer by Dispatch's markers", () => {
    document.body.innerHTML = `
      <span id="pet" data-dispatch-pet></span>
      <form><textarea id="editor"></textarea><div><span data-dispatch-composer></span></div><button id="send" type="submit"></button></form>`;
    document.getElementById("pet")!.getBoundingClientRect = rect(0, 600);
    document.getElementById("editor")!.getBoundingClientRect = rect(300, 600);
    document.getElementById("send")!.getBoundingClientRect = rect(520, 600);
    expect(locateTarget({ kind: "pet" }, document)).toEqual({ x: 100, y: 616 });
    expect(locateTarget({ kind: "composer" }, document)).toEqual({ x: 370, y: 616 });
    expect(locateTarget({ kind: "send" }, document)).toEqual({ x: 620, y: 616 });
  });
});
