// Shared pieces for the spec components in groups/. Styles use only BB's tokens, so the UI reads like BB
// in chat and takes the hem.so theme on shared sites. Group files import from here, never from each other.
import { createContext, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useFormName, useIsStreaming, type DefinedComponent } from "@openuidev/react-lang";
import { ChevronRight } from "./icons.generated.js";
import { focusRing } from "../ui.js";
import { useHost } from "./host.js";
import { sourcedQuery } from "./source-metadata.js";

export { focusRing };

/** The one open/closed marker for every toggle: a chevron that turns down when open. */
export function Chevron({ open }: { open: boolean }) {
  return <ChevronRight aria-hidden className={`size-[1em] shrink-0 self-center text-muted-foreground transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-90" : ""}`} />;
}

/**
 * What a toggle shows. The space opens smoothly while the content fades in near the end, so a half-cut block never
 * shows; closing fades first, then shuts. The content mounts on first open and stays, inert, while closed.
 * The clip margin keeps focus rings visible when open.
 */
export function Reveal({ open, className, children }: { open: boolean; className?: string; children: ReactNode }) {
  const [seen, setSeen] = useState(open);
  if (open && !seen) setSeen(true);
  return <div inert={!open} className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr] delay-100"}`}>
    <div className={`min-h-0 min-w-0 overflow-clip transition-opacity motion-reduce:transition-none ${open ? "opacity-100 duration-150 delay-100 [overflow-clip-margin:4px]" : "opacity-0 duration-100"}`}><div className={className}>{seen ? children : null}</div></div>
  </div>;
}

/**
 * How far a block `extra` px too wide for its column spills to each side, given the free room there.
 * It centers when it can, and takes from the other side what one side lacks.
 */
export function spillSides(extra: number, roomLeft: number, roomRight: number): { left: number; right: number } {
  if (extra <= 0) return { left: 0, right: 0 };
  const left = Math.min(Math.max(0, roomLeft), extra / 2), right = Math.min(Math.max(0, roomRight), extra - left);
  return { left: Math.round(Math.min(Math.max(0, roomLeft), extra - right)), right: Math.round(right) };
}

const SPILL_PAD = 16;

/**
 * Margins that let a horizontal scroller grow past its column into empty space beside it, so its content fits
 * without a sideways scrollbar. It grows only inside the nearest ancestor that clips, so nothing is cut off.
 */
/** `count` is how many children the scroller has; a change measures again. */
export function useSpill(scroller: RefObject<HTMLElement | null>, count: number): CSSProperties | undefined {
  const [sides, setSides] = useState({ left: 0, right: 0 });
  useLayoutEffect(() => {
    const box = scroller.current, column = box?.parentElement;
    if (!box || !column || typeof ResizeObserver === "undefined") return;
    let view = column.parentElement;
    while (view && getComputedStyle(view).overflowX === "visible") view = view.parentElement;
    if (!view) return;
    const clip = view;
    const measure = () => {
      const col = column.getBoundingClientRect(), port = clip.getBoundingClientRect();
      const viewLeft = port.left + clip.clientLeft + SPILL_PAD, viewRight = port.left + clip.clientLeft + clip.clientWidth - SPILL_PAD;
      const first = box.firstElementChild?.getBoundingClientRect(), last = box.lastElementChild?.getBoundingClientRect();
      // The content's own width, not scrollWidth, which grows with the spill and would never let it shrink back.
      const next = spillSides(first && last ? last.right - first.left - col.width : 0, col.left - viewLeft, viewRight - col.right);
      setSides((now) => now.left === next.left && now.right === next.right ? now : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const el of [clip, column, ...Array.from(box.children)]) observer.observe(el);
    return () => observer.disconnect();
  }, [scroller, count]);
  return sides.left || sides.right ? { marginLeft: -sides.left, marginRight: -sides.right } : undefined;
}

/** One way to use a component, as a whole OpenUI Lang program. `tools` answers its Query calls in the gallery and tests. */
export type Example = { name: string; code: string; tools?: Record<string, unknown> };

/**
 * A component and how agents learn it. `summary` is the one-line index entry (a few words).
 * `part` marks a piece that only lives inside another component (Series, Tab); it needs no example of its own.
 */
export type Entry = { component: DefinedComponent<any>; summary: string; examples: Example[]; part?: boolean };

/** One group of the catalog: one file in groups/, one section of the gallery, one reference file `references/openui/<id>.md`. */
export type Group = { id: string; name: string; notes?: string[]; entries: Entry[] };

/** What this fence has sent: the clicked label per Form name. Buttons outside a Form share the key "". */
export type Sent = { sent: Record<string, string>; unlock: (form: string) => void };
export const SentContext = createContext<Sent>({ sent: {}, unlock: () => {} });

/** True where nothing can be sent to the thread: a published page or shared site. */
export const useReadOnly = (): boolean => !useHost().replies;

/** The read-only state of a component that sends to the thread, shown in place of its send controls. */
export function ReadOnlyNote() {
  return <p role="note" className="m-0 text-muted-foreground">Read-only here. Answers are sent from the chat in BB.</p>;
}

/** Fields lock while the reply streams, and inside a Form once it is sent or where it cannot be sent. */
export function useLocked(): boolean {
  const form = useFormName();
  const { sent } = useContext(SentContext);
  const readOnly = useReadOnly();
  return useIsStreaming() || (form !== undefined && (sent[form] !== undefined || readOnly));
}

export const gaps = { none: "gap-0", s: "gap-1.5", m: "gap-3", l: "gap-6" } as const;
export const toneBar = { info: "border-primary", success: "border-success", warning: "border-warning", danger: "border-destructive" } as const;
export const trendText = { neutral: "text-muted-foreground", up: "text-success", down: "text-destructive" } as const;
export const field = `w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-1.5 text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:outline-none disabled:opacity-60`;
// Series colours: BB has no chart palette, so series use its own theme colours, like pages do.
export const seriesColor = ["text-primary", "text-muted-foreground", "text-success", "text-warning", "text-destructive"] as const;

export function Label({ text, children }: { text?: string; children: ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-1">{text ? <span className="text-muted-foreground">{text}</span> : null}{children}</label>;
}

/** The props of a ref child (`Series(...)` inside `Chart([...])`), or undefined while it streams in. */
export function childProps<T>(node: unknown): Partial<T> | undefined {
  const props = (node as { props?: unknown } | null)?.props;
  return props && typeof props === "object" ? props as Partial<T> : undefined;
}

/** A Renderer toolProvider: tool name to an async call. */
export type Tools = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

/** The toolProvider for an example in the gallery and tests: its fixtures answer its Query calls. */
export function fixtureTools(fixtures: Record<string, unknown> | undefined): Tools {
  return Object.fromEntries(Object.entries(fixtures ?? {}).map(([name, value]) => [name, (args: Record<string, unknown>) => Promise.resolve(sourcedQuery(name, args, value))]));
}

