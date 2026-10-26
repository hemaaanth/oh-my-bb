import { useSyncExternalStore, type ReactNode } from "react";
import { useHost } from "./host.js";
const query = "(prefers-reduced-motion: reduce)";
const subscribe = (changed: () => void) => {
  if (typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(query);
  media.addEventListener("change", changed);
  return () => media.removeEventListener("change", changed);
};
export const reducedMotion = (): boolean => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
export function useAnimationsOff(): boolean {
  const reduced = useSyncExternalStore(subscribe, reducedMotion, () => false);
  return useHost().animations === false || reduced;
}

/** One scope for CSS motion; JavaScript renderers use the same preference. */
export function MotionBoundary({ children }: { children: ReactNode }) {
  const off = useAnimationsOff();
  return <div data-pages-motion={off ? "off" : "on"} className={off ? "contents [&_*]:transition-none! [&_*]:animate-none! [&_*]:scroll-auto!" : "contents"}>{children}</div>;
}
