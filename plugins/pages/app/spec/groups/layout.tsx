// Layout: how the parts of a UI sit together.
import { createContext, useContext, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { defineComponent, useIsStreaming } from "@openuidev/react-lang";
import { ChevronLeft, ChevronRight, X } from "../icons.generated.js";
import { z } from "zod";
import { Chevron, Reveal, childProps, focusRing, gaps, type Group } from "../kit.js";

const Stack = defineComponent({
  name: "Stack",
  props: z.object({ children: z.array(z.any()), direction: z.enum(["column", "row"]).optional(), gap: z.enum(["none", "s", "m", "l"]).optional() }),
  description: 'Layout. direction "column" (default) or "row"; rows wrap. gap "none"|"s"|"m"|"l", default "m".',
  component: ({ props, renderNode }) => <div className={`flex min-w-0 ${props.direction === "row" ? "flex-row flex-wrap items-end" : "flex-col"} ${gaps[props.gap ?? "m"]}`}>{renderNode(props.children)}</div>,
});

// A "card" inside a Card draws as a sunk tile, so frames never nest.
const CardDepth = createContext(0);
const cardFrame = { card: "rounded-md border border-border-hairline p-4", sunk: "rounded-md bg-muted p-3", clear: "" } as const;

const Card = defineComponent({
  name: "Card",
  props: z.object({ children: z.array(z.any()), title: z.string().optional(), variant: z.enum(["card", "sunk", "clear"]).optional() }),
  description: 'A framed group of parts with an optional title. variant "card" (default) has a hairline frame; "sunk" is a muted tile, good for options side by side; "clear" has no frame. A "card" inside another Card draws as "sunk". Cards in a Row or Grid share one height.',
  component: ({ props, renderNode }) => {
    const depth = useContext(CardDepth);
    const variant = props.variant === "sunk" || props.variant === "clear" ? props.variant : depth > 0 ? "sunk" : "card";
    return <CardDepth.Provider value={depth + 1}>
      <section className={`flex min-w-0 flex-1 flex-col gap-3 ${cardFrame[variant]}`}>{props.title ? <h3 className="m-0 font-semibold text-foreground">{props.title}</h3> : null}{renderNode(props.children)}</section>
    </CardDepth.Provider>;
  },
});

const Row = defineComponent({
  name: "Row",
  props: z.object({ children: z.array(z.any()), gap: z.enum(["none", "s", "m", "l"]).optional() }),
  description: 'Parts side by side in equal columns. Each column is at least 10rem wide, so a narrow screen wraps them. gap "none"|"s"|"m"|"l", default "l". For buttons or small items at their own width, use Stack with "row".',
  component: ({ props, renderNode }) => <div className={`flex min-w-0 flex-wrap items-stretch ${gaps[props.gap ?? "l"]}`}>
    {(props.children ?? []).map((child, i) => <div key={i} className="flex min-w-40 flex-1 flex-col">{renderNode(child)}</div>)}
  </div>,
});

/** The CSS grid columns for Grid: as many 10rem tiles as fit, or `columns` where each stays at least 8rem. */
// Ported from GenUI ui/components/layout.tsx Grid (Apache-2.0).
export function gridTemplate(columns: number | undefined): string {
  if (columns === undefined || !Number.isFinite(columns)) return "repeat(auto-fit,minmax(min(10rem,100%),1fr))";
  const n = Math.min(6, Math.max(1, Math.round(columns)));
  return `repeat(auto-fill,minmax(max(min(8rem,100%),calc((100% - ${n - 1} * 0.75rem) / ${n})),1fr))`;
}

const Grid = defineComponent({
  name: "Grid",
  props: z.object({ children: z.array(z.any()), columns: z.number().optional() }),
  description: "Tiles on an even grid. With no columns it fits as many tiles of about 10rem as there is room for. columns (1 to 6) asks for that many; a narrow screen shows fewer, each at least 8rem. Tiles in a row share one height.",
  component: ({ props, renderNode }) => <div className="grid min-w-0 gap-3" style={{ gridTemplateColumns: gridTemplate(props.columns) }}>
    {(props.children ?? []).map((child, i) => <div key={i} className="flex min-w-0 flex-col">{renderNode(child)}</div>)}
  </div>,
});

const arrow = `inline-flex size-7 cursor-pointer items-center justify-center rounded-md border border-input text-foreground hover:bg-state-hover disabled:cursor-default disabled:opacity-40 ${focusRing}`;

const Carousel = defineComponent({
  name: "Carousel",
  props: z.object({ items: z.array(z.any()), label: z.string().optional() }),
  description: "A row of slides that scrolls sideways, with previous and next buttons. Each item is one slide, often a Card or an Entity. Slides are about 16rem wide. label names the carousel for screen readers.",
  component: ({ props, renderNode }) => {
    const scroller = useRef<HTMLDivElement>(null);
    const [edge, setEdge] = useState({ start: true, end: true });
    const items = props.items ?? [];
    const measure = () => {
      const el = scroller.current;
      if (el) setEdge({ start: el.scrollLeft <= 1, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 });
    };
    useEffect(measure, [items.length]);
    const page = (dir: number) => { const el = scroller.current; el?.scrollBy?.({ left: dir * el.clientWidth * 0.9, behavior: "smooth" }); };
    return <div role="region" aria-roledescription="carousel" aria-label={props.label ?? "Carousel"} className="flex min-w-0 flex-col gap-2">
      <div ref={scroller} onScroll={measure} tabIndex={0} className={`flex min-w-0 snap-x snap-mandatory gap-3 overflow-x-auto rounded-sm pb-1 [scrollbar-width:thin] ${focusRing}`}>
        {items.map((item, i) => <div key={i} role="group" aria-roledescription="slide" aria-label={`${i + 1} of ${items.length}`} className="flex w-[min(16rem,85%)] shrink-0 snap-start flex-col">{renderNode(item)}</div>)}
      </div>
      {items.length > 1 ? <div className="flex justify-end gap-1.5">
        <button type="button" aria-label="Previous" disabled={edge.start} onClick={() => page(-1)} className={arrow}><ChevronLeft aria-hidden className="size-4" /></button>
        <button type="button" aria-label="Next" disabled={edge.end} onClick={() => page(1)} className={arrow}><ChevronRight aria-hidden className="size-4" /></button>
      </div> : null}
    </div>;
  },
});

const Details = defineComponent({
  name: "Details",
  props: z.object({ title: z.string(), children: z.array(z.any()), open: z.boolean().optional() }),
  description: "A collapsible section: the title shows, the content opens on click. Closed unless open is true. Use it for detail most readers skip.",
  component: function DetailsView({ props, renderNode }) {
    const [open, setOpen] = useState(props.open ?? false);
    return <div className="min-w-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={`flex w-fit max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-left font-medium text-foreground ${focusRing}`}><Chevron open={open} /><span className="min-w-0">{props.title}</span></button>
      <Reveal open={open} className="flex min-w-0 flex-col gap-3 pl-5 pt-2">{renderNode(props.children)}</Reveal>
    </div>;
  },
});

const Divider = defineComponent({
  name: "Divider",
  props: z.object({ label: z.string().optional() }),
  description: "A thin line between parts. With a label, the label sits in the middle of the line.",
  component: ({ props }) => props.label
    ? <div role="separator" aria-label={props.label} className="flex min-w-0 items-center gap-3 text-muted-foreground"><span className="h-px flex-1 bg-border-hairline" />{props.label}<span className="h-px flex-1 bg-border-hairline" /></div>
    : <hr className="m-0 h-px w-full shrink-0 border-0 bg-border-hairline" />,
});

const AccordionItem = defineComponent({
  name: "AccordionItem",
  props: z.object({ title: z.string(), children: z.array(z.any()) }),
  description: "One section of an Accordion: a title and its content.",
  component: ({ props, renderNode }) => <div className="flex min-w-0 flex-col gap-3">{renderNode(props.children)}</div>,
});

type ItemProps = { title: string; children: unknown[] };

const Accordion = defineComponent({
  name: "Accordion",
  props: z.object({ items: z.array(AccordionItem.ref) }),
  description: "Stacked sections where one opens at a time; the first starts open. Clicking an open title closes it. Up and down arrows move between titles. While the reply streams, the newest section opens until the reader clicks one.",
  component: ({ props, renderNode }) => {
    const items = (props.items ?? []).filter((item) => childProps<ItemProps>(item));
    const id = useId();
    const streaming = useIsStreaming();
    // A finished reply opens the first section; a streaming one follows the newest.
    const [open, setOpen] = useState<number | null>(items.length === 0 ? null : streaming ? items.length - 1 : 0);
    const touched = useRef(false);
    const seen = useRef(items.length);
    // Ported from OpenUI react-ui genui-lib/Accordion (MIT): a new item opens until the reader picks one.
    if (streaming && !touched.current && items.length > seen.current) setOpen(items.length - 1);
    seen.current = items.length;
    const toggle = (i: number) => { touched.current = true; setOpen(open === i ? null : i); };
    const list = useRef<HTMLDivElement>(null);
    const onKeyDown = (event: KeyboardEvent) => {
      const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>(":scope > div > h3 > button") ?? []);
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (!step || at < 0) return;
      event.preventDefault();
      buttons[(at + step + buttons.length) % buttons.length]?.focus();
    };
    return <div ref={list} onKeyDown={onKeyDown} className="flex min-w-0 flex-col border-t border-border-hairline">
      {items.map((item, i) => {
        const p = childProps<ItemProps>(item)!;
        const shown = open === i;
        return <div key={i} className="border-b border-border-hairline">
          <h3 className="m-0 text-[length:inherit] font-medium">
            <button type="button" id={`${id}-h${i}`} aria-expanded={shown} aria-controls={`${id}-p${i}`} onClick={() => toggle(i)} className={`flex w-full cursor-pointer items-center gap-1.5 rounded-sm py-2 text-left text-foreground ${focusRing}`}>
              <Chevron open={shown} /><span className="min-w-0 flex-1">{String(p.title ?? "")}</span>
            </button>
          </h3>
          <div id={`${id}-p${i}`} role="region" aria-labelledby={`${id}-h${i}`}><Reveal open={shown} className="pb-3 pl-5">{renderNode(item)}</Reveal></div>
        </div>;
      })}
    </div>;
  },
});

const Modal = defineComponent({
  name: "Modal",
  props: z.object({ label: z.string(), children: z.array(z.any()), title: z.string().optional() }),
  description: "A button that opens a dialog with the children inside. label is the button text; title heads the dialog and defaults to label. Escape, the close button, or a click outside closes it. Use it for detail or a Form that should not take room in the reply.",
  component: ({ props, renderNode }) => {
    const dialog = useRef<HTMLDialogElement>(null);
    const id = useId();
    // jsdom and old browsers lack showModal; the open attribute still shows it.
    const show = () => { const el = dialog.current; if (!el) return; if (typeof el.showModal === "function") el.showModal(); else el.setAttribute("open", ""); };
    const close = () => { const el = dialog.current; if (typeof el?.close === "function") el.close(); else el?.removeAttribute("open"); };
    return <>
      <button type="button" aria-haspopup="dialog" onClick={show} className={`w-fit cursor-pointer rounded-md border border-input px-3 py-1.5 font-medium text-foreground hover:bg-state-hover ${focusRing}`}>{props.label}</button>
      <dialog ref={dialog} aria-labelledby={id} onClick={(event) => { if (event.target === event.currentTarget) close(); }} className="m-auto max-h-[min(85vh,48rem)] w-[min(32rem,calc(100vw-2rem))] overflow-y-auto rounded-md border border-border bg-background p-0 text-foreground backdrop:bg-black/40">
        <div className="flex min-w-0 flex-col gap-3 p-4">
          <div className="flex items-start gap-2">
            <h2 id={id} className="m-0 min-w-0 flex-1 text-[length:inherit] font-semibold">{props.title ?? props.label}</h2>
            <button type="button" aria-label="Close" onClick={close} className={`inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground ${focusRing}`}><X aria-hidden className="size-4" /></button>
          </div>
          {renderNode(props.children)}
        </div>
      </dialog>
    </>;
  },
});

const Tab = defineComponent({
  name: "Tab",
  props: z.object({ label: z.string(), children: z.array(z.any()) }),
  description: "One tab of Tabs: a label and its content.",
  component: ({ props, renderNode }) => <div className="flex min-w-0 flex-col gap-3">{renderNode(props.children)}</div>,
});

const Tabs = defineComponent({
  name: "Tabs",
  props: z.object({ tabs: z.array(Tab.ref) }),
  description: "Switch between a few views of related content. The first tab shows first.",
  component: ({ props, renderNode }) => {
    const [active, setActive] = useState(0);
    const list = useRef<HTMLDivElement>(null);
    const tabs = props.tabs.filter((tab) => tab && typeof tab === "object") as Array<{ props?: { label?: unknown } }>;
    const current = Math.min(active, Math.max(0, tabs.length - 1));
    // Arrow keys move between tabs, as the ARIA tabs pattern expects.
    const onKeyDown = (event: KeyboardEvent) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step || tabs.length === 0) return;
      event.preventDefault();
      const next = (current + step + tabs.length) % tabs.length;
      setActive(next);
      list.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
    };
    return <div className="flex min-w-0 flex-col gap-3">
      <div ref={list} role="tablist" onKeyDown={onKeyDown} className="flex flex-wrap gap-4 border-b border-border-hairline">
        {tabs.map((tab, i) => <button key={i} type="button" role="tab" aria-selected={i === current} tabIndex={i === current ? 0 : -1} onClick={() => setActive(i)} className={`-mb-px cursor-pointer border-b-2 pb-1.5 ${focusRing} ${i === current ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{String(tab.props?.label ?? "")}</button>)}
      </div>
      <div role="tabpanel">{renderNode(tabs[current])}</div>
    </div>;
  },
});

export const group: Group = {
  id: "layout",
  name: "Layout",
  entries: [
    { component: Stack, summary: "column or row of parts", examples: [
      { name: "Column", code: `root = Stack([Text("First"), Text("Second")])` },
      { name: "Row", code: `root = Stack([Text("Left"), Text("Right")], "row", "l")` },
    ] },
    { component: Card, summary: "framed group with a title", examples: [
      { name: "Card", code: `root = Card([Text("Two blockers remain before the release."), Stack([Badge("In review", "info"), Badge("Due Fri")], "row", "s")], "Release 2.4")` },
      { name: "Nested", code: `root = Card([Row([Card([Text("Ship Friday with the known bug.")], "Ship"), Card([Text("Wait a week for the fix.")], "Wait")])], "Two options")` },
      { name: "Variants", code: `root = Stack([Card([Text("A hairline frame.")], "Card"), Card([Text("A muted tile.")], "Sunk", "sunk"), Card([Text("No frame, only spacing.")], "Clear", "clear")])` },
    ] },
    { component: Row, summary: "equal columns that wrap", examples: [
      { name: "Three columns", code: `root = Row([Card([Text("Postgres")], "Database", "sunk"), Card([Text("Redis")], "Cache", "sunk"), Card([Text("S3")], "Files", "sunk")])` },
    ] },
    { component: Grid, summary: "even grid of tiles", examples: [
      { name: "Fit to width", code: `root = Grid([Stat("Users", 1240), Stat("Teams", 86), Stat("Seats", 3100), Stat("Churn", "2.1%"), Stat("NPS", 48)])` },
      { name: "Two columns", code: `root = Grid([Card([Text("Faster builds.")], "Pro", "sunk"), Card([Text("A smaller bundle.")], "Pro", "sunk"), Card([Text("A new config format.")], "Con", "sunk"), Card([Text("One more plugin to keep.")], "Con", "sunk")], 2)` },
    ] },
    { component: Carousel, summary: "slides that scroll sideways", examples: [
      { name: "Cards", code: `root = Carousel([Card([Text("Kyoto, 3 nights")], "Day 1-3", "sunk"), Card([Text("Nara, day trip")], "Day 4", "sunk"), Card([Text("Osaka, 2 nights")], "Day 5-6", "sunk"), Card([Text("Fly home")], "Day 7", "sunk")], "Trip plan")` },
    ] },
    { component: Details, summary: "collapsible section", examples: [
      { name: "Closed and open", code: `root = Stack([Details("Why this works", [Text("The cache holds the last good build, so a retry is cheap.")]), Details("Steps", [List(["Clear the cache", "Run the build", "Check the logs"], true)], true)])` },
    ] },
    { component: Divider, summary: "thin line between parts", examples: [
      { name: "Plain and labelled", code: `root = Stack([Text("Above the line."), Divider(), Text("Below the line."), Divider("or"), Text("Another way.")])` },
    ] },
    { component: Accordion, summary: "sections, one open at a time", examples: [
      { name: "FAQ", code: `root = Accordion([AccordionItem("What is included?", [Text("Hosting, backups, and email support.")]), AccordionItem("Can I cancel?", [Text("Yes, any time. You keep access to the end of the month.")]), AccordionItem("Is there a free tier?", [Text("Yes, for one project.")])])` },
    ] },
    { component: AccordionItem, summary: "one section of Accordion", part: true, examples: [] },
    { component: Modal, summary: "button that opens a dialog", examples: [
      { name: "Details in a dialog", code: `root = Modal("See the full log", [Text("The build failed at step 4 of 6."), Code("text", "error: cannot find module 'zod'")], "Build log")` },
      { name: "Form in a dialog", code: `root = Modal("Change the plan", [Form("plan", [Choice("tier", ["Free", "Pro", "Team"], "Tier")], [Button("Save")])])` },
    ] },
    { component: Tabs, summary: "switch between views", examples: [
      { name: "Two tabs", code: `root = Tabs([Tab("Summary", [Text("Shipped on time.")]), Tab("Notes", [Text("Docs follow next week.", "muted")])])` },
    ] },
    { component: Tab, summary: "one tab of Tabs", part: true, examples: [] },
  ],
};

