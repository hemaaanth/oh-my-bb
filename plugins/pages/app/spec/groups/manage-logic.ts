// Pure logic for the Manage group: days, board columns, PERT estimates, and the roadmap axis.
// Dates are whole days (days since 1970-01-01, UTC), so no timezone moves a due date.

const DAY_MS = 86_400_000;

// Ported from GenUI core/tracking.ts (Apache-2.0).
/** `yyyy-mm-dd` (or an ISO date-time) as a day number; null for anything else or an impossible date. */
export function parseDay(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/u.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.getTime() / DAY_MS;
}

/** The reader's calendar day at `now`, as a day number. */
export const localDay = (now: Date): number => Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS;

const utc = (day: number) => new Date(day * DAY_MS);
const SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const LONG = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const MONTH_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/** "Oct 10", with the year when it is not `today`'s year. */
export function formatDay(day: number, today: number): string {
  return (utc(day).getUTCFullYear() === utc(today).getUTCFullYear() ? SHORT : LONG).format(utc(day));
}

const slug = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/gu, "");

// ---------------------------------------------------------------------------
// Board

// Ported from GenUI core/tracking.ts (Apache-2.0): the known workflow and its aliases.
const WORKFLOW: [string, string][] = [["backlog", "Backlog"], ["todo", "Todo"], ["in_progress", "In progress"], ["in_review", "In review"], ["blocked", "Blocked"], ["done", "Done"], ["canceled", "Canceled"]];
const ALIASES: Record<string, string> = { to_do: "todo", not_started: "todo", doing: "in_progress", started: "in_progress", active: "in_progress", wip: "in_progress", progress: "in_progress", review: "in_review", code_review: "in_review", complete: "done", completed: "done", finished: "done", shipped: "done", cancelled: "canceled" };
const CLOSED = new Set(["done", "canceled"]);

/** A status as a column key: "In Progress", "in-progress", and "doing" are all `in_progress`. Blank is "". */
export function statusKey(value: unknown): string {
  const key = typeof value === "string" ? slug(value) : "";
  return ALIASES[key] ?? key;
}

export type BoardCard = { title: string; status?: string; owner?: string; tags?: string[]; due?: string; detail?: string };
export type BoardColumn<C> = { key: string; label: string; cards: C[]; closed: boolean };

/**
 * Cards in columns. With `columns` those show in that order (empty ones too) and other cards count as hidden.
 * Without, the known workflow order applies, unknown statuses follow as first seen, and "No status" goes last.
 */
export function boardColumns<C extends { status?: string }>(cards: C[], columns?: string[]): { columns: BoardColumn<C>[]; hidden: number } {
  const byKey = new Map<string, C[]>();
  const given = new Map<string, string>();
  for (const card of cards) {
    const key = statusKey(card.status);
    if (card.status && !given.has(key)) given.set(key, card.status);
    byKey.set(key, [...(byKey.get(key) ?? []), card]);
  }
  const known = new Map(WORKFLOW);
  const label = (key: string, text?: string) => text ?? known.get(key) ?? (key === "" ? "No status" : given.get(key) ?? key);
  const named = (columns ?? []).filter((column) => typeof column === "string" && statusKey(column) !== "");
  if (named.length > 0) {
    const shown = [...new Map(named.map((column) => [statusKey(column), column])).entries()].map(([key, text]) => ({ key, label: label(key, text), cards: byKey.get(key) ?? [], closed: CLOSED.has(key) }));
    return { columns: shown, hidden: cards.length - shown.reduce((sum, column) => sum + column.cards.length, 0) };
  }
  const order = [...WORKFLOW.map(([key]) => key)];
  const rank = (key: string) => (key === "" ? 10_000 : order.includes(key) ? order.indexOf(key) : 100 + [...byKey.keys()].indexOf(key));
  const keys = [...byKey.keys()].sort((a, b) => rank(a) - rank(b));
  return { columns: keys.map((key) => ({ key, label: label(key), cards: byKey.get(key)!, closed: CLOSED.has(key) })), hidden: 0 };
}

/** Card indexes per column key, top to bottom. */
export type BoardOrder = Record<string, number[]>;
export type BoardSlot = { list: string; index: number };

/**
 * The board after the reader's moves. The columns stay the ones the cards first made, so a column the last card left
 * stays open to move back to. Cards not in `order` keep their own column, after the ones that are. `lines` lists each
 * card off its own column; a new place in the same column is not a move.
 */
export function moveCards<C extends { title: string; status?: string }>(columns: BoardColumn<C>[], cards: C[], order: BoardOrder): { columns: BoardColumn<C & { index: number }>[]; lines: string[] } {
  const where = new Map<number, string>();
  for (const column of columns) for (const index of order[column.key] ?? []) if (Number.isInteger(index) && index >= 0 && index < cards.length && !where.has(index)) where.set(index, column.key);
  cards.forEach((card, index) => { if (!where.has(index) && columns.some((column) => column.key === statusKey(card.status))) where.set(index, statusKey(card.status)); });
  const label = new Map(columns.map((column) => [column.key, column.label]));
  const lines = cards.flatMap((card, index) => { const key = where.get(index); const own = statusKey(card.status); return key === undefined || key === own ? [] : [`- ${card.title}: ${label.get(own) ?? card.status ?? "No status"} → ${label.get(key)}`]; });
  return { columns: columns.map((column) => ({ ...column, cards: [...where].filter(([, key]) => key === column.key).map(([index]) => ({ ...cards[index]!, index })) })), lines };
}

/** The order after putting card `index` at place `at` of column `key`, counted without the card itself. No `at` is the end. */
export function placeCard(order: BoardOrder, index: number, key: string, at = Infinity): BoardOrder {
  const next: BoardOrder = Object.fromEntries(Object.entries(order).map(([column, cards]) => [column, cards.filter((card) => card !== index)]));
  const list = next[key] ?? [];
  next[key] = [...list.slice(0, Math.max(0, at)), index, ...list.slice(Math.max(0, at))];
  return next;
}

/** Where a dragged card drops in a column: after every other card whose middle is above the pointer. */
export const slotIndex = (middles: number[], y: number): number => middles.filter((middle) => middle < y).length;

/** A column as shown during a drag: without the lifted card, and `null` at the slot when the slot is in this column. */
export function dropItems<T extends { index: number }>(cards: readonly T[], lifted: number, slot: number | null): Array<T | null> {
  const rest = cards.filter((card) => card.index !== lifted);
  return slot === null ? rest : [...rest.slice(0, slot), null, ...rest.slice(slot)];
}

// ---------------------------------------------------------------------------
// Estimate

export type EstimateTask = { task: string; low?: number; likely?: number; high?: number };
export type TaskEstimate = { error: string | null; low: number; likely: number; high: number; mean: number; sd: number };

/** z-scores of the standard normal distribution at 80% and 90%. */
const Z80 = 0.8416212335729143;
const Z90 = 1.2815515655446004;
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const AMOUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
export const formatAmount = (value: number): string => AMOUNT.format(value === 0 ? 0 : value);

// Ported from GenUI core/decisions.ts (Apache-2.0).
/** One task's PERT figures (mean (low + 4·likely + high) / 6, sd (high − low) / 6), or why it cannot be counted. */
export function estimateTask(task: EstimateTask): TaskEstimate {
  const low = num(task.low);
  const high = num(task.high);
  const fail = (error: string): TaskEstimate => ({ error, low: low ?? 0, likely: 0, high: high ?? 0, mean: 0, sd: 0 });
  if (low === null || high === null) return fail(low === null && high === null ? "needs low and high" : low === null ? "needs low" : "needs high");
  if (low < 0 || high < 0 || (num(task.likely) ?? 0) < 0) return fail("can't be negative");
  if (low > high) return fail(`low ${formatAmount(low)} is above high ${formatAmount(high)}`);
  const likely = num(task.likely) ?? (low + high) / 2;
  if (likely < low || likely > high) return fail(`likely ${formatAmount(likely)} is outside ${formatAmount(low)}–${formatAmount(high)}`);
  return { error: null, low, likely, high, mean: (low + 4 * likely + high) / 6, sd: (high - low) / 6 };
}

export type EstimateTotals = { count: number; excluded: number; low: number; likely: number; high: number; p50: number; p80: number; p90: number };

// Ported from GenUI core/decisions.ts (Apache-2.0).
/**
 * The total of the valid tasks. Taken as independent, means add and so do variances. The sum is close to normal,
 * so P(x) = mean + z(x)·σ. Few tasks can push the tail past the sum of the highs, so percentiles clamp to [Σlow, Σhigh].
 */
export function estimateTotals(estimates: TaskEstimate[]): EstimateTotals {
  const valid = estimates.filter((estimate) => estimate.error === null);
  const sum = (pick: (e: TaskEstimate) => number) => valid.reduce((total, e) => total + pick(e), 0);
  const [low, high, mean] = [sum((e) => e.low), sum((e) => e.high), sum((e) => e.mean)];
  const sd = Math.sqrt(sum((e) => e.sd * e.sd));
  const clamp = (value: number) => Math.min(high, Math.max(low, value));
  return { count: valid.length, excluded: estimates.length - valid.length, low, likely: sum((e) => e.likely), high, p50: clamp(mean), p80: clamp(mean + Z80 * sd), p90: clamp(mean + Z90 * sd) };
}

// ---------------------------------------------------------------------------
// Roadmap

export type RoadmapStatus = "done" | "active" | "planned" | "at-risk" | "blocked";
export type RoadmapInput = { title: string; lane?: string; start?: string; end?: string; status?: RoadmapStatus; milestone?: boolean };
export type RoadmapItem = { title: string; lane: string; start: number; end: number; status: RoadmapStatus; milestone: boolean; late: boolean };
export type RoadmapTick = { day: number; label: string; major: boolean };
export type Roadmap = { lanes: { name: string; items: RoadmapItem[] }[]; from: number; to: number; ticks: RoadmapTick[]; today: number; skipped: number };

const mondayOf = (day: number) => day - ((utc(day).getUTCDay() + 6) % 7);
const monthStart = (day: number, add = 0) => { const date = utc(day); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + add, 1) / DAY_MS; };

// Ported from GenUI core/tracking.ts (Apache-2.0).
/** The axis for days lo..hi (hi exclusive): days up to a month, weeks up to half a year, then months. */
export function roadmapAxis(lo: number, hi: number, today: number): Pick<Roadmap, "from" | "to" | "ticks"> {
  // Today joins the axis when it is near the plan, so its line has a place.
  const span = Math.max(1, hi - lo);
  if (today >= lo - span * 0.3 && today < lo) lo = today;
  if (today >= hi && today < hi + span * 0.3) hi = today + 1;
  const ticks: RoadmapTick[] = [];
  let from: number;
  let to: number;
  if (hi - lo <= 31) {
    from = lo;
    to = hi;
    for (let day = from; day < to; day += 1) {
      const first = utc(day).getUTCDate() === 1;
      ticks.push({ day, label: first || day === from ? SHORT.format(utc(day)) : String(utc(day).getUTCDate()), major: first });
    }
  } else if (hi - lo <= 182) {
    from = mondayOf(lo);
    to = mondayOf(hi - 1) + 7;
    let month = -1;
    for (let day = from; day < to; day += 7) {
      const newMonth = utc(day).getUTCMonth() !== month;
      month = utc(day).getUTCMonth();
      ticks.push({ day, label: newMonth ? SHORT.format(utc(day)) : String(utc(day).getUTCDate()), major: newMonth && day !== from });
    }
  } else {
    from = monthStart(lo);
    to = monthStart(hi - 1, 1);
    for (let day = from; day < to; day = monthStart(day, 1)) {
      const january = utc(day).getUTCMonth() === 0;
      ticks.push({ day, label: (january || day === from ? MONTH_YEAR : MONTH).format(utc(day)), major: january });
    }
  }
  return { from, to, ticks };
}

/**
 * A roadmap from items with `yyyy-mm-dd` dates. A milestone (or an item with no end) sits on its start day.
 * Without a status an item is active when today is inside it, else planned. Items with no usable dates are skipped.
 */
export function readRoadmap(items: RoadmapInput[], today: number): Roadmap {
  const read: RoadmapItem[] = [];
  for (const item of items) {
    const start = parseDay(item?.start);
    if (!item?.title || start === null) continue;
    const milestone = item.milestone === true || item.end === undefined;
    const end = milestone ? start : parseDay(item.end);
    if (end === null || end < start) continue;
    const status = item.status ?? (today >= start && today <= end && !milestone ? "active" : "planned");
    read.push({ title: item.title, lane: item.lane ?? "", start, end, status, milestone, late: status !== "done" && end < today });
  }
  const lanes: Roadmap["lanes"] = [];
  for (const item of read) {
    const lane = lanes.find((entry) => entry.name === item.lane);
    if (lane) lane.items.push(item); else lanes.push({ name: item.lane, items: [item] });
  }
  if (read.length === 0) return { lanes, from: today, to: today + 1, ticks: [], today, skipped: items.length };
  const axis = roadmapAxis(Math.min(...read.map((item) => item.start)), Math.max(...read.map((item) => item.end)) + 1, today);
  return { lanes, ...axis, today, skipped: items.length - read.length };
}

/** A share of the axis, 0–1, for the start of a day. */
export const axisShare = (day: number, axis: Pick<Roadmap, "from" | "to">): number => (day - axis.from) / (axis.to - axis.from);
