// Ported from ComicBit/bb-plugin-genui (Apache-2.0). See THIRD_PARTY.md.
import { useEffect, useState, type RefObject } from "react";
import { useAnimationsOff } from "./motion.js";
const tourStep = (count: number) => Math.min(1500, Math.max(300, 6000 / Math.max(1, count - 1)));
interface Tour {
  /** Whether the tour runs at all: asked for, and motion allowed. */
  readonly active: boolean;
  /** How many stops, in tour order, have their pins down. */
  readonly shown: number;
  readonly started: boolean;
  readonly paused: boolean;
  readonly done: boolean;
  /** Bumped by replay, so the pins mount (and drop) again. */
  readonly epoch: number;
  /** When (performance.now()) the newest pin dropped on its own; a seek doesn't count. */
  readonly droppedAt: number;
  readonly toggle: () => void;
  readonly replay: () => void;
  /** Shows the stops up to `position` and carries on from there. */
  readonly seek: (position: number) => void;
}

/**
 * Drops `count` pins one by one at tourStep's pace, starting once `target`
 * (the map) is mostly on screen. Only the pins move: the camera and the page
 * stay where the user left them. Pauses while the page is hidden; reduced
 * motion or the Animations setting off shows every pin at once.
 */
export function useTour(wanted: boolean, count: number, target: RefObject<HTMLElement | null>): Tour {
  const animationsOff = useAnimationsOff();
  // The system setting has no hook; it's read again on every render.
  const active = wanted && count > 0 && !animationsOff;
  const [started, setStarted] = useState(false);
  const [shown, setShown] = useState(0);
  const [paused, setPaused] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [droppedAt, setDroppedAt] = useState(Number.NEGATIVE_INFINITY);
  const [hidden, setHidden] = useState(() => document.visibilityState === "hidden");

  useEffect(() => {
    const update = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    const element = target.current;
    if (!active || started || element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setStarted(true);
        setShown(1);
        setDroppedAt(performance.now());
      },
      { threshold: 0.6 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, started, target]);

  const running = active && started && !paused && !hidden && shown < count;
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => {
      setShown((current) => current + 1);
      setDroppedAt(performance.now());
    }, tourStep(count));
    return () => clearTimeout(timer);
  }, [running, shown, count]);

  return {
    active,
    shown: active ? shown : count,
    started,
    paused,
    done: shown >= count,
    epoch,
    droppedAt,
    toggle: () => setPaused((current) => !current),
    replay: () => {
      setStarted(true);
      setShown(1);
      setPaused(false);
      setEpoch((current) => current + 1);
      setDroppedAt(performance.now());
    },
    seek: (position) => {
      setStarted(true);
      setShown(position + 1);
    },
  };
}
