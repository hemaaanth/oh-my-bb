// Manage: plans, boards, roadmaps, decisions, estimates, and status.
import { useContext, useRef, useState } from "react";
import { defineComponent, useIsStreaming, useTriggerAction } from "@openuidev/react-lang";
import { z } from "zod";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Ellipsis } from "lucide-react";
import { PORTAL_SCOPE, menuContent, menuItem } from "../../ui.js";
import { ReadOnlyNote, SentContext, focusRing, useReadOnly, useSpill, type Group } from "../kit.js";
import { axisShare, boardColumns, estimateTask, estimateTotals, formatAmount, formatDay, localDay, parseDay, moveCards, placeCard, readRoadmap, statusKey, type BoardOrder, type RoadmapStatus } from "./manage-logic.js";
import { useBoardDrag } from "./board-drag.js";

/** Items that have their main field yet: while a reply streams, the last one may be half written. */
const ready = <T,>(items: T[] | undefined, key: keyof T): T[] => (Array.isArray(items) ? items.filter((item) => item && typeof item[key] === "string" && item[key] !== "") : []);
const texts = (items: unknown): string[] => (Array.isArray(items) ? items.filter((item): item is string => typeof item === "string" && item !== "") : []);

/**
 * Moves a card without a drag, for keyboards and touch. It shows on hover, like BB's other ⋯ menus,
 * and always where there is no hover. It lists only the other columns: the card is already in its own.
 */
function MoveMenu({ title, columns, onMove }: { title: string; columns: { key: string; label: string }[]; onMove: (key: string) => void }) {
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button type="button" data-no-drag="" aria-label={`Move ${title}`} className={`absolute right-1 top-1 inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-state-hover hover:text-foreground focus-visible:opacity-100 group-hover/card:opacity-100 data-[state=open]:bg-state-hover data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100 ${focusRing}`}>
        <Ellipsis aria-hidden className="size-4" />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content {...PORTAL_SCOPE} align="end" sideOffset={4} collisionPadding={8} style={{ zIndex: 75 }} className={`min-w-40 max-w-[calc(100vw-16px)] ${menuContent}`}>
        <DropdownMenu.Label className="px-2 pb-1 pt-1.5 text-xs text-muted-foreground">Move to</DropdownMenu.Label>
        {columns.map((column) => <DropdownMenu.Item key={column.key} className={menuItem} onSelect={() => onMove(column.key)}>{column.label}</DropdownMenu.Item>)}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

const Board = defineComponent({
  name: "Board",
  props: z.object({
    cards: z.array(z.object({ title: z.string(), status: z.string().optional(), owner: z.string().optional(), tags: z.array(z.string()).optional(), due: z.string().optional(), detail: z.string().optional() })),
    columns: z.array(z.string()).optional(),
    name: z.string().optional(),
  }),
  description: 'Kanban columns of cards. Each card has a title and a status; cards with the same status share a column. Common statuses ("todo", "in progress", "in review", "blocked", "done") sort in workflow order, others follow as first seen. columns names the columns to show, in order, empty ones too. due is yyyy-mm-dd and shows red once past, unless the card is done. Give name to let the reader move cards (drag, or the ⋯ menu on each card) and send the moves to the thread as "- Card: From → To" lines. Without name it is read-only.',
  component: ({ props }) => {
    const trigger = useTriggerAction();
    const streaming = useIsStreaming();
    const { sent, unlock } = useContext(SentContext);
    const [order, setOrder] = useState<BoardOrder>({});
    const scroller = useRef<HTMLDivElement>(null);
    const cards = ready(props.cards, "title");
    const base = boardColumns(cards, texts(props.columns));
    const { columns, lines } = moveCards(base.columns, cards, order);
    const shown: BoardOrder = Object.fromEntries(columns.map((column) => [column.key, column.cards.map((card) => card.index)]));
    // Where moves cannot be sent, a named board reads like one without a name, plus the note.
    const readOnly = useReadOnly();
    const form = readOnly ? undefined : props.name;
    const locked = streaming || (form !== undefined && sent[form] !== undefined);
    const movable = form !== undefined && !locked;
    // Wide boards grow into the empty space beside the chat before they scroll sideways.
    // Cards sliding into place stick out for a moment; hiding the vertical overflow keeps scrollbars from flashing.
    const spill = useSpill(scroller, columns.length);
    const dnd = useBoardDrag({ lists: shown, scroller, onDrop: (index, slot) => setOrder(placeCard(shown, index, slot.list, slot.index)) });
    const today = localDay(new Date());
    // No text selection anywhere: a press and drag moves a card, it never selects text.
    return <div className="flex min-w-0 select-none flex-col gap-2 [-webkit-touch-callout:none]">
      <div ref={scroller} style={spill} className={`flex min-w-0 gap-4 overflow-x-auto overflow-y-hidden pb-1 ${dnd.dragging ? "pointer-events-none" : ""}`}>{columns.map((column) => <section key={column.key} ref={dnd.zoneRef(column.key)} aria-label={column.label} className="flex w-56 shrink-0 flex-col gap-2">
        <h4 className="m-0 flex justify-between gap-2 border-b border-border-hairline pb-1 font-medium text-muted-foreground"><span>{column.label}</span><span className="tabular-nums">{column.cards.length}</span></h4>
        <div ref={dnd.listRef(column.key)} className="relative flex min-h-8 flex-col gap-2">{dnd.items(column.key, column.cards).map((card) => {
          if (!card) return <div key="slot" aria-hidden data-flip="slot" style={{ height: dnd.height }} className="rounded-md bg-muted/60 shadow-[inset_0_1px_3px_rgb(0_0_0/0.45)]" />;
          const due = parseDay(card.due);
          const late = due !== null && due < today && !column.closed;
          const meta = [card.owner, ...texts(card.tags)].filter(Boolean);
          return <article key={card.index} aria-label={card.title} data-flip={String(card.index)} {...(movable ? dnd.handle(card.index) : {})} className={`group/card relative flex flex-col gap-1 rounded-md border bg-card p-2 ${movable ? "cursor-grab hover:bg-state-hover" : ""} ${column.key !== statusKey(card.status) ? "border-primary" : "border-border-hairline"}`}>
            <span className={`${movable ? "pr-6" : ""} ${column.closed ? "text-muted-foreground" : "text-foreground"}`}>{card.title}</span>
            {card.detail ? <span className="text-muted-foreground">{card.detail}</span> : null}
            {meta.length || due !== null ? <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">{meta.map((text, i) => <span key={i}>{text}</span>)}{due !== null ? <span className={late ? "text-destructive" : ""}>{late ? "Late · " : ""}{formatDay(due, today)}</span> : null}</span> : null}
            {movable && columns.length > 1 ? <MoveMenu title={card.title} columns={columns.filter((option) => option.key !== column.key)} onMove={(key) => setOrder(placeCard(shown, card.index, key))} /> : null}
          </article>;
        })}</div>
      </section>)}</div>
      {base.hidden > 0 ? <p className="m-0 text-muted-foreground">{base.hidden} {base.hidden === 1 ? "card is" : "cards are"} in other columns.</p> : null}
      {form !== undefined ? <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={locked || lines.length === 0} onClick={() => void trigger(["Moves on the board:", ...lines].join("\n"), form)} className={`w-fit cursor-pointer rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60 ${focusRing}`}>{lines.length ? `Send moves (${lines.length})` : "Send moves"}</button>
        {sent[form] !== undefined ? <p role="status" className="m-0 text-muted-foreground">Sent to the thread. <button type="button" onClick={() => unlock(form)} className={`cursor-pointer rounded-sm text-foreground underline underline-offset-2 ${focusRing}`}>Change</button></p> : lines.length === 0 ? <span className="text-muted-foreground">Drag cards to move them.</span> : null}
      </div> : readOnly && props.name !== undefined ? <ReadOnlyNote /> : null}
    </div>;
  },
});

const Decision = defineComponent({
  name: "Decision",
  props: z.object({
    question: z.string(),
    options: z.array(z.object({ name: z.string(), pros: z.array(z.string()).optional(), cons: z.array(z.string()).optional(), note: z.string().optional() })),
    recommend: z.string().optional(),
    name: z.string().optional(),
  }),
  description: 'Options for one decision, each with pros, cons, and a note. recommend is the name of the option you recommend; it is marked. Give name to let the reader choose: each option gets a Choose button that sends "<question>: <option>" to the thread, then locks. Without name it is read-only.',
  component: ({ props }) => {
    const trigger = useTriggerAction();
    const streaming = useIsStreaming();
    const { sent, unlock } = useContext(SentContext);
    // Where a choice cannot be sent, the options read like a Decision without a name, plus the note.
    const readOnly = useReadOnly();
    const form = readOnly ? undefined : props.name;
    const sentText = form ? sent[form] : undefined;
    const message = (option: string) => `${props.question}: ${option}`;
    return <div className="flex min-w-0 flex-col gap-3">
      <h3 className="m-0 font-semibold text-foreground">{props.question}</h3>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-4">{ready(props.options, "name").map((option) => {
        const recommended = option.name === props.recommend;
        const chosen = sentText === message(option.name);
        return <div key={option.name} className={`flex flex-col gap-1.5 border-l-2 pl-3 ${chosen || (recommended && sentText === undefined) ? "border-primary" : "border-border-hairline"}`}>
          <p className="m-0 flex flex-wrap items-baseline gap-x-2"><span className="font-semibold text-foreground">{option.name}</span>{recommended ? <span className="text-xs font-medium text-primary">Recommended</span> : null}</p>
          {option.note ? <p className="m-0 text-muted-foreground">{option.note}</p> : null}
          {texts(option.pros).length || texts(option.cons).length ? <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {texts(option.pros).map((pro, i) => <li key={`p${i}`} className="flex gap-2 text-foreground"><span aria-label="Pro" className="text-success">+</span>{pro}</li>)}
            {texts(option.cons).map((con, i) => <li key={`c${i}`} className="flex gap-2 text-foreground"><span aria-label="Con" className="text-destructive">−</span>{con}</li>)}
          </ul> : null}
          {form ? <button type="button" aria-pressed={sentText === undefined ? undefined : chosen} disabled={streaming || sentText !== undefined} onClick={() => void trigger(message(option.name), form)} className={`mt-1 inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-md px-3 py-1 font-medium ${chosen ? "disabled:cursor-default" : "disabled:opacity-60"} ${focusRing} ${chosen ? "bg-primary text-primary-foreground" : recommended ? "border border-primary text-primary hover:bg-state-hover" : "border border-input text-foreground hover:bg-state-hover"}`}>{chosen ? <><Check aria-hidden className="size-3.5" />Chosen</> : `Choose ${option.name}`}</button> : null}
        </div>;
      })}</div>
      {form && sentText !== undefined ? <p role="status" className="m-0 text-muted-foreground">Sent to the thread. <button type="button" onClick={() => unlock(form)} className={`cursor-pointer rounded-sm text-foreground underline underline-offset-2 ${focusRing}`}>Change</button></p> : null}
      {readOnly && props.name ? <ReadOnlyNote /> : null}
    </div>;
  },
});

const Estimate = defineComponent({
  name: "Estimate",
  props: z.object({ tasks: z.array(z.object({ task: z.string(), low: z.number(), likely: z.number().optional(), high: z.number() })), unit: z.string().optional() }),
  description: 'Three-point estimates: per task the best case (low), the likely case, and the worst case (high), with a total. likely defaults to the midpoint. The total also shows P50, P80, and P90 from a PERT model (tasks taken as independent). unit is a short word like "d" (default), "h", "w", or "pts".',
  component: ({ props }) => {
    const unit = props.unit ?? "d";
    const streaming = useIsStreaming();
    const rows = ready(props.tasks, "task").map((task) => ({ task, estimate: estimateTask(task) }));
    const totals = estimateTotals(rows.map((row) => row.estimate));
    const scale = Math.max(1, ...rows.map((row) => row.estimate.high));
    const fmt = (value: number) => `${formatAmount(value)} ${unit}`;
    const cell = "px-2 py-1.5 text-right tabular-nums first:pl-0";
    return <div className="flex min-w-0 flex-col gap-2">
      <div className="min-w-0 overflow-x-auto"><table className="w-full border-collapse">
        <thead><tr className="text-muted-foreground">{["Task", "Best", "Likely", "Worst", ""].map((head, i) => <th key={i} className={`border-b border-border px-2 py-1.5 font-medium first:pl-0 ${i === 0 ? "text-left" : "text-right"}`}>{head}</th>)}</tr></thead>
        <tbody>{rows.map(({ task, estimate }, i) => <tr key={i} className="border-b border-border-hairline text-foreground">
          <td className="px-2 py-1.5 pl-0">{task.task}{estimate.error && !streaming ? <span className="block text-xs text-destructive">Not counted: {estimate.error}</span> : null}</td>
          {estimate.error ? <td colSpan={4} /> : <>
            <td className={cell}>{fmt(estimate.low)}</td><td className={cell}>{fmt(estimate.likely)}</td><td className={cell}>{fmt(estimate.high)}</td>
            <td className="w-28 px-2 py-1.5" aria-hidden="true"><span className="relative block h-1.5"><span className="absolute inset-y-0 rounded-sm bg-primary/30" style={{ left: `${(estimate.low / scale) * 100}%`, width: `${((estimate.high - estimate.low) / scale) * 100}%` }} /><span className="absolute -inset-y-0.5 w-0.5 bg-primary" style={{ left: `${(estimate.likely / scale) * 100}%` }} /></span></td>
          </>}
        </tr>)}</tbody>
        {totals.count > 0 ? <tfoot><tr className="font-semibold text-foreground"><td className="px-2 py-1.5 pl-0">Total</td><td className={cell}>{fmt(totals.low)}</td><td className={cell}>{fmt(totals.likely)}</td><td className={cell}>{fmt(totals.high)}</td><td /></tr></tfoot> : null}
      </table></div>
      {totals.count > 1 ? <p className="m-0 text-muted-foreground" title="PERT: the chance the total is at or under this value, with tasks taken as independent.">P50 <span className="tabular-nums text-foreground">{fmt(totals.p50)}</span> · P80 <span className="tabular-nums text-foreground">{fmt(totals.p80)}</span> · P90 <span className="tabular-nums text-foreground">{fmt(totals.p90)}</span></p> : null}
    </div>;
  },
});

const stepStatuses = ["todo", "doing", "done", "blocked", "skipped"] as const;
type StepStatus = (typeof stepStatuses)[number];
const stepMark: Record<StepStatus, string> = {
  todo: "border-input text-muted-foreground",
  doing: "border-primary text-primary",
  done: "border-success bg-success text-background",
  blocked: "border-destructive text-destructive",
  skipped: "border-border-hairline text-muted-foreground",
};

const Plan = defineComponent({
  name: "Plan",
  props: z.object({ steps: z.array(z.object({ step: z.string(), status: z.enum(stepStatuses).optional(), owner: z.string().optional(), due: z.string().optional(), detail: z.string().optional() })) }),
  description: 'Ordered steps with an owner and a status each. status "todo" (default), "doing", "done", "blocked", or "skipped". due is yyyy-mm-dd or short text like "Fri". A line on top counts done and blocked steps.',
  component: ({ props }) => {
    const steps = ready(props.steps, "step");
    const done = steps.filter((step) => step.status === "done").length;
    const blocked = steps.filter((step) => step.status === "blocked").length;
    const today = localDay(new Date());
    return <div className="flex min-w-0 flex-col gap-2">
      <p className="m-0 text-muted-foreground">{done} of {steps.length} done{blocked ? <span className="text-destructive"> · {blocked} blocked</span> : null}</p>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">{steps.map((step, i) => {
        const status = step.status ?? "todo";
        const day = parseDay(step.due);
        return <li key={i} className="flex gap-2.5">
          <span aria-label={status} className={`grid size-5 shrink-0 place-items-center rounded-full border text-xs tabular-nums ${stepMark[status]}`}>{status === "done" ? "✓" : status === "blocked" ? "!" : i + 1}</span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className={status === "skipped" ? "text-muted-foreground line-through" : "text-foreground"}>{step.step}</span>
              {step.owner || step.due ? <span className="text-muted-foreground">{[step.owner, day !== null ? formatDay(day, today) : step.due].filter(Boolean).join(" · ")}</span> : null}
            </span>
            {step.detail ? <span className="text-muted-foreground">{step.detail}</span> : null}
          </span>
        </li>;
      })}</ol>
    </div>;
  },
});

const roadmapStatuses = ["done", "active", "planned", "at-risk", "blocked"] as const;
const barColor: Record<RoadmapStatus, string> = { done: "bg-success", active: "bg-primary", planned: "bg-muted-foreground/40", "at-risk": "bg-warning", blocked: "bg-destructive" };
const statusLabel: Record<RoadmapStatus, string> = { done: "Done", active: "Active", planned: "Planned", "at-risk": "At risk", blocked: "Blocked" };

const Roadmap = defineComponent({
  name: "Roadmap",
  props: z.object({
    items: z.array(z.object({ title: z.string(), start: z.string(), end: z.string().optional(), lane: z.string().optional(), status: z.enum(roadmapStatuses).optional(), milestone: z.boolean().optional() })),
    today: z.string().optional(),
  }),
  description: 'Items on a time axis, grouped by lane. Dates are yyyy-mm-dd; end is the last day. An item with no end, or with milestone true, is a milestone on its start day. status "done", "active", "planned", "at-risk", or "blocked"; without one, an item is active when today is inside it, else planned. The axis reads in days, weeks, or months by span. today defaults to the reader\'s date.',
  component: ({ props }) => {
    const streaming = useIsStreaming();
    const today = parseDay(props.today) ?? localDay(new Date());
    const map = readRoadmap(ready(props.items, "title"), today);
    const left = (day: number) => `${axisShare(day, map) * 100}%`;
    const every = Math.ceil(map.ticks.length / 8);
    const showToday = today >= map.from && today < map.to;
    const used = roadmapStatuses.filter((status) => map.lanes.some((lane) => lane.items.some((item) => item.status === status)));
    const todayLine = showToday ? <span aria-hidden="true" className="absolute inset-y-0 w-px bg-destructive/60" style={{ left: left(today + 0.5) }} /> : null;
    return <div className="flex min-w-0 flex-col gap-2">
      <div className="grid min-w-0 grid-cols-[minmax(5rem,9rem)_minmax(12rem,1fr)] overflow-x-auto">
        <span />
        <div aria-hidden="true" className="relative h-5 border-b border-border-hairline text-xs text-muted-foreground">{map.ticks.map((tick, i) => i % every === 0 || tick.major ? <span key={tick.day} className={`absolute bottom-0 border-l pl-1 ${tick.major ? "border-border" : "border-border-hairline"}`} style={{ left: left(tick.day) }}>{tick.label}</span> : null)}</div>
        {map.lanes.map((lane) => <div key={lane.name} className="contents">
          {lane.name ? <><span className="pt-2 font-medium text-muted-foreground">{lane.name}</span><div className="relative">{todayLine}</div></> : null}
          {lane.items.map((item, i) => {
            const range = item.milestone ? formatDay(item.start, today) : `${formatDay(item.start, today)} – ${formatDay(item.end, today)}`;
            return <div key={i} className="contents">
              <span className={`truncate py-1 pr-2 ${item.late ? "text-destructive" : "text-foreground"}`} title={item.title}>{item.title}</span>
              <div className="relative h-7" role="img" aria-label={`${item.title}: ${range}, ${statusLabel[item.status]}${item.late ? ", late" : ""}`} title={`${range} · ${statusLabel[item.status]}${item.late ? " · late" : ""}`}>
                {todayLine}
                {item.milestone
                  ? <span className={`absolute top-2 size-2.5 -translate-x-1/2 rotate-45 ${barColor[item.status]}`} style={{ left: left(item.start + 0.5) }} />
                  : <span className={`absolute top-2 h-3 min-w-1 rounded-sm ${barColor[item.status]}`} style={{ left: left(item.start), width: `${((item.end + 1 - item.start) / (map.to - map.from)) * 100}%` }} />}
              </div>
            </div>;
          })}
        </div>)}
      </div>
      {used.length || showToday ? <p className="m-0 flex flex-wrap gap-x-3 text-xs text-muted-foreground">{used.map((status) => <span key={status} className="inline-flex items-center gap-1"><span className={`size-2 rounded-sm ${barColor[status]}`} />{statusLabel[status]}</span>)}{showToday ? <span className="inline-flex items-center gap-1"><span className="h-2.5 w-px bg-destructive/60" />Today</span> : null}</p> : null}
      {map.skipped > 0 && !streaming ? <p className="m-0 text-muted-foreground">{map.skipped} {map.skipped === 1 ? "item has" : "items have"} no usable dates (yyyy-mm-dd).</p> : null}
    </div>;
  },
});

const health = ["on-track", "at-risk", "off-track", "blocked", "done"] as const;
const healthText: Record<(typeof health)[number], [string, string]> = { "on-track": ["On track", "text-success"], "at-risk": ["At risk", "text-warning"], "off-track": ["Off track", "text-destructive"], blocked: ["Blocked", "text-destructive"], done: ["Done", "text-success"] };

const Status = defineComponent({
  name: "Status",
  props: z.object({ state: z.enum(health), summary: z.string().optional(), highlights: z.array(z.string()).optional(), risks: z.array(z.string()).optional(), next: z.array(z.string()).optional() }),
  description: 'A status report: the overall state, a one-line summary, then highlights, risks, and next steps as short lists. state "on-track", "at-risk", "off-track", "blocked", or "done". Empty lists are left out.',
  component: ({ props }) => {
    const [label, color] = healthText[props.state] ?? ["", "text-muted-foreground"];
    const sections = ([["Highlights", props.highlights], ["Risks", props.risks], ["Next", props.next]] as const).map(([title, items]) => [title, texts(items)] as const).filter(([, items]) => items.length > 0);
    return <div className="flex min-w-0 flex-col gap-3">
      <p className="m-0"><span className={`font-semibold ${color}`}>● {label}</span>{props.summary ? <span className="text-foreground"> · {props.summary}</span> : null}</p>
      {sections.length ? <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-4">{sections.map(([title, items]) => <section key={title} aria-label={title} className="flex flex-col gap-1">
        <h4 className="m-0 font-medium text-muted-foreground">{title}</h4>
        <ul className="m-0 flex flex-col gap-0.5 pl-4 text-foreground">{items.map((item, i) => <li key={i}>{item}</li>)}</ul>
      </section>)}</div> : null}
    </div>;
  },
});

export const group: Group = {
  id: "manage",
  name: "Manage",
  entries: [
    { component: Board, summary: "kanban columns of cards", examples: [
      { name: "By status", code: `root = Board([{title: "Pricing page copy", status: "todo", owner: "Ana", tags: ["web"]}, {title: "Billing webhooks", status: "in progress", owner: "Raj", due: "2026-10-12"}, {title: "Invoice PDF", status: "in review", owner: "Ana"}, {title: "Tax rules", status: "blocked", detail: "Waiting on legal"}, {title: "Stripe keys", status: "done", owner: "Raj"}])` },
      { name: "Fixed columns", code: `root = Board([{title: "Draft post", status: "Writing"}, {title: "Pick images", status: "Writing"}, {title: "Launch email", status: "Scheduled", due: "2026-11-02"}], ["Ideas", "Writing", "Scheduled", "Sent"])` },
      { name: "Reader moves cards", code: `root = Board([{title: "Dark mode", status: "Backlog"}, {title: "CSV export", status: "Backlog", tags: ["data"]}, {title: "SSO", status: "Next"}, {title: "Audit log", status: "Next"}, {title: "Faster search", status: "Now", owner: "Ana"}], ["Backlog", "Next", "Now"], "priorities")` },
    ] },
    { component: Decision, summary: "options with pros, cons, a pick", examples: [
      { name: "Read-only", code: `root = Decision("Which queue?", [{name: "BullMQ", pros: ["Mature", "Redis we already run"], cons: ["Another Redis load"]}, {name: "SQS", pros: ["No servers"], cons: ["AWS lock-in", "Slower local dev"]}, {name: "Postgres queue", note: "pg-boss on the main DB", pros: ["No new service"], cons: ["Load on the main DB"]}], "BullMQ")` },
      { name: "Reader picks", code: `root = Decision("Launch date?", [{name: "Nov 4", pros: ["Before the conference"], cons: ["Tight QA"]}, {name: "Nov 18", pros: ["Full QA week"], cons: ["Misses the conference"]}], "Nov 18", "launch-date")` },
    ] },
    { component: Estimate, summary: "best, likely, worst with a total", examples: [
      { name: "Days", code: `root = Estimate([{task: "API", low: 2, likely: 3, high: 6}, {task: "UI", low: 3, likely: 4, high: 8}, {task: "Migration", low: 1, high: 4}, {task: "QA", low: 1, likely: 2, high: 3}])` },
      { name: "Points, one invalid", code: `root = Estimate([{task: "Search", low: 3, likely: 5, high: 8}, {task: "Filters", low: 5, likely: 2, high: 8}], "pts")` },
    ] },
    { component: Plan, summary: "ordered steps with owners and status", examples: [
      { name: "In progress", code: `root = Plan([{step: "Freeze the schema", status: "done", owner: "Raj"}, {step: "Backfill old rows", status: "doing", owner: "Ana", due: "2026-10-20", detail: "About 2M rows, in batches"}, {step: "Switch reads", status: "blocked", owner: "Raj", detail: "Needs the backfill"}, {step: "Drop the old table", owner: "Ana", due: "Fri"}, {step: "Load test", status: "skipped"}])` },
    ] },
    { component: Roadmap, summary: "items on a time axis by lane", examples: [
      { name: "Weeks, by lane", code: `root = Roadmap([{title: "Auth rework", lane: "Platform", start: "2026-10-01", end: "2026-10-24", status: "done"}, {title: "Rate limits", lane: "Platform", start: "2026-10-20", end: "2026-11-14", status: "at-risk"}, {title: "New editor", lane: "Product", start: "2026-10-12", end: "2026-11-28"}, {title: "Beta", lane: "Product", start: "2026-11-30", milestone: true}, {title: "Pricing", lane: "Growth", start: "2026-11-02", end: "2026-11-20", status: "blocked"}], "2026-10-28")` },
      { name: "Months", code: `root = Roadmap([{title: "Research", start: "2026-01-05", end: "2026-02-27", status: "done"}, {title: "Build", start: "2026-03-02", end: "2026-07-31", status: "active"}, {title: "Launch", start: "2026-08-15"}], "2026-05-10")` },
    ] },
    { component: Status, summary: "status report", examples: [
      { name: "At risk", code: `root = Status("at-risk", "Launch may slip a week.", ["Billing is live in staging", "Docs are done"], ["Tax rules still with legal", "One QA engineer out"], ["Decide the date on Monday", "Start the load test"])` },
      { name: "On track", code: `root = Status("on-track", "All three milestones met.")` },
    ] },
  ],
};
