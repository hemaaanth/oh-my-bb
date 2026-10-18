// Inputs: fields, buttons, and the Form that sends answers to the thread.
import { useContext, useEffect, useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { FormNameContext, action, defineComponent, reactive, useFormName, useGetFieldValue, useIsStreaming, useSetFieldValue, useStateField, useTriggerAction, type ActionPlan } from "@openuidev/react-lang";
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bell, Bookmark, Bug, Calendar, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleHelp, Clock, Code, Copy, Download, Ellipsis, ExternalLink, Eye, File, Filter,
  Folder, GitBranch, Heart, House, Info, Lightbulb, Link, Lock, Mail, Minus, Pause, Pencil, Play, Plus, RefreshCw, Rocket, Search, Send, Settings, Share, Sparkles, Star, ThumbsDown, ThumbsUp, Trash2, TriangleAlert, Upload, User, X, Zap,
  type LucideIcon,
} from "lucide-react";
import { z } from "zod";
import { Label, ReadOnlyNote, SentContext, field, focusRing, useLocked, useReadOnly, type Group } from "../kit.js";

/** A field's state. A Form sends what it holds itself, so a bound, preset, or shown value is copied into the Form too. */
function useField<V>(name: string, value: V, shown?: unknown) {
  const state = useStateField(name, value);
  const form = useFormName();
  const streaming = useIsStreaming();
  const getField = useGetFieldValue();
  const setField = useSetFieldValue();
  const current: unknown = state.value ?? shown;
  // Compared as JSON: a literal array prop is a new array on every render.
  const key = JSON.stringify(current);
  useEffect(() => {
    if (form === undefined || streaming || current === undefined) return;
    if (JSON.stringify(getField(form, name)) !== key) setField(form, undefined, name, current, false);
  }, [form, streaming, name, key]);
  return state;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : typeof value === "number" ? String(value) : undefined);
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export type Option = { value: string; label: string; detail?: string; icon?: string };

/** Options as strings or `{label, value?, detail?, icon?}`. Half-written or repeated entries are skipped. */
export function optionsOf(items: unknown): Option[] {
  if (!Array.isArray(items)) return [];
  const out: Option[] = [];
  for (const item of items) {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : { label: item } as Record<string, unknown>;
    const label = text(entry.label) ?? text(entry.title) ?? text(entry.value);
    const value = text(entry.value) ?? label;
    if (label === undefined || value === undefined || out.some((o) => o.value === value)) continue;
    out.push({ value, label, detail: text(entry.detail) ?? text(entry.description), icon: text(entry.icon) });
  }
  return out;
}

const option = z.union([z.string(), z.object({ label: z.string(), value: z.string().optional(), detail: z.string().optional() })]);
const options = z.array(option);
const optionsHelp = "options are strings or {label, value?, detail?}; value defaults to label and is what is sent";

/** Pick one option, or several in option order. */
function usePick<V>(name: string, list: Option[], multiple: boolean | undefined, value: V) {
  const state = useField(name, value);
  const current: unknown = state.value;
  const chosen = new Set<string>(Array.isArray(current) ? current : typeof current === "string" && current ? [current] : []);
  const pick = (picked: string) => {
    if (!multiple) return state.setValue(picked as never);
    const next = new Set(chosen);
    if (next.has(picked)) next.delete(picked); else next.add(picked);
    state.setValue(list.map((o) => o.value).filter((v) => next.has(v)) as never);
  };
  return { chosen, pick, locked: useLocked() };
}

/** A labelled group of controls. A <label> would forward clicks to its first button. */
function Titled({ label, name, role = "group", aside, children }: { label?: string; name: string; role?: string; aside?: ReactNode; children: ReactNode }) {
  return <div role={role} aria-label={label ?? name} className="flex min-w-0 flex-col gap-1">
    {label || aside ? <span className="flex items-baseline justify-between gap-3 text-muted-foreground"><span>{label}</span>{aside}</span> : null}
    {children}
  </div>;
}

const ICONS: Record<string, LucideIcon> = {
  arrowdown: ArrowDown, arrowleft: ArrowLeft, arrowright: ArrowRight, arrowup: ArrowUp, bell: Bell, bookmark: Bookmark, bug: Bug, calendar: Calendar, check: Check, chevrondown: ChevronDown, chevronleft: ChevronLeft,
  chevronright: ChevronRight, chevronup: ChevronUp, help: CircleHelp, clock: Clock, code: Code, copy: Copy, download: Download, more: Ellipsis, external: ExternalLink, eye: Eye, file: File, filter: Filter, folder: Folder,
  branch: GitBranch, heart: Heart, home: House, info: Info, idea: Lightbulb, link: Link, lock: Lock, mail: Mail, minus: Minus, pause: Pause, edit: Pencil, play: Play, plus: Plus, refresh: RefreshCw, rocket: Rocket,
  search: Search, send: Send, settings: Settings, share: Share, sparkles: Sparkles, star: Star, thumbsdown: ThumbsDown, thumbsup: ThumbsUp, trash: Trash2, warning: TriangleAlert, upload: Upload, user: User, close: X, zap: Zap,
};
const ICON_NAMES = Object.keys(ICONS).join(", ");
/** An allowed icon by name, ignoring case and dashes ("arrow-right", "ArrowRight"). */
const iconFor = (name: string | undefined): LucideIcon | undefined => (name ? ICONS[name.toLowerCase().replace(/[^a-z0-9]/g, "")] : undefined);

const Input = defineComponent({
  name: "Input",
  props: z.object({ name: z.string(), label: z.string().optional(), placeholder: z.string().optional(), value: reactive(z.string().optional()) }),
  description: "A one-line text field. Bind value to a $variable to use it elsewhere.",
  component: ({ props }) => {
    const state = useField(props.name, props.value);
    return <Label text={props.label}><input className={field} name={state.name} placeholder={props.placeholder} value={state.value ?? ""} disabled={useLocked()} onChange={(event) => state.setValue(event.target.value)} /></Label>;
  },
});

const TextArea = defineComponent({
  name: "TextArea",
  props: z.object({ name: z.string(), label: z.string().optional(), placeholder: z.string().optional(), value: reactive(z.string().optional()) }),
  description: "A text field for a few lines or more. The reader can drag it taller.",
  component: ({ props }) => {
    const state = useField(props.name, props.value);
    return <Label text={props.label}><textarea className={`${field} min-h-16 resize-y`} rows={3} name={state.name} placeholder={props.placeholder} value={state.value ?? ""} disabled={useLocked()} onChange={(event) => state.setValue(event.target.value)} /></Label>;
  },
});

// Ported from GenUI ui/components/fieldLogic.ts (Apache-2.0).
/** Decimal places a number is written with: 0.25 → 2, 1e-7 → 7, 3 → 0. */
export function decimals(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const [mantissa = "", exponent = "0"] = String(value).split("e");
  return Math.max(0, (mantissa.split(".")[1]?.length ?? 0) - Number(exponent));
}

export type StepRange = { min: number | null; max: number | null; step: number };

/** A missing or non-positive step is 1; max never sits below min. */
export function stepRange(min: unknown, max: unknown, step: unknown): StepRange {
  const low = finite(min), high = finite(max), size = finite(step);
  return { min: low, max: high === null || low === null ? high : Math.max(low, high), step: size !== null && size > 0 ? size : 1 };
}

const clamp = (value: number, range: StepRange) => Math.min(range.max ?? Infinity, Math.max(range.min ?? -Infinity, value));

/** `value` moved by `count` steps, rounded so 0.1 + 0.2 lands on 0.3, then clamped. ±Infinity jumps to a bound, or stays without one. */
export function stepBy(value: number, count: number, range: StepRange): number {
  const precision = Math.min(10, Math.max(decimals(range.step), decimals(range.min ?? 0), decimals(range.max ?? 0), decimals(value)));
  const moved = clamp(Number((value + count * range.step).toFixed(precision)), range);
  return Number.isFinite(moved) ? moved : value;
}

/** What a Stepper shows: the state, else min, else 0, inside the range. */
export const stepperValue = (state: unknown, range: StepRange): number => clamp(finite(state) ?? range.min ?? 0, range);

const STEP_KEYS: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10, Home: -Infinity, End: Infinity };

const Slider = defineComponent({
  name: "Slider",
  props: z.object({ name: z.string(), min: z.number(), max: z.number(), step: z.number().optional(), label: z.string().optional(), value: reactive(z.number().optional()) }),
  description: "A number slider. Bind value to a $variable to drive other components live.",
  component: ({ props }) => {
    const state = useField(props.name, props.value, props.min);
    const value = state.value ?? props.min;
    return <Label text={props.label}>
      <span className="flex items-center gap-3">
        <input type="range" className="min-w-0 flex-1 accent-primary" name={state.name} min={props.min} max={props.max} step={props.step ?? 1} value={value} disabled={useLocked()} onChange={(event) => state.setValue(Number(event.target.value))} />
        <span className="w-12 text-right tabular-nums text-foreground">{value}</span>
      </span>
    </Label>;
  },
});

const Stepper = defineComponent({
  name: "Stepper",
  props: z.object({ name: z.string(), label: z.string().optional(), min: z.number().optional(), max: z.number().optional(), step: z.number().optional(), value: reactive(z.number().optional()) }),
  description: "A whole or decimal number with - and + buttons, for counts and small amounts. step defaults to 1; it starts at value, else min, else 0. Arrow keys step, Page Up/Down step by 10.",
  component: ({ props }) => {
    const range = stepRange(props.min, props.max, props.step);
    const state = useField(props.name, props.value, stepperValue(undefined, range));
    const value = stepperValue(state.value, range);
    const locked = useLocked();
    const move = (count: number) => state.setValue(stepBy(value, count, range));
    const onKey = (event: KeyboardEvent) => {
      const count = STEP_KEYS[event.key];
      if (count === undefined || locked) return;
      event.preventDefault();
      move(count);
    };
    const button = `inline-flex w-8 cursor-pointer items-center justify-center text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:cursor-default disabled:opacity-40 ${focusRing}`;
    return <Titled label={props.label} name={props.name}>
      <span className="inline-flex w-fit items-stretch rounded-md border border-input bg-background">
        <button type="button" aria-label="Decrease" disabled={locked || value <= (range.min ?? -Infinity)} onClick={() => move(-1)} className={`${button} rounded-l-md`}><Minus className="size-3.5" aria-hidden /></button>
        <span role="spinbutton" tabIndex={locked ? -1 : 0} aria-label={props.label ?? props.name} aria-valuenow={value} aria-valuemin={range.min ?? undefined} aria-valuemax={range.max ?? undefined} aria-disabled={locked || undefined} onKeyDown={onKey} className={`min-w-12 border-x border-input px-2 py-1.5 text-center tabular-nums text-foreground ${focusRing}`}>{value}</span>
        <button type="button" aria-label="Increase" disabled={locked || value >= (range.max ?? Infinity)} onClick={() => move(1)} className={`${button} rounded-r-md`}><Plus className="size-3.5" aria-hidden /></button>
      </span>
    </Titled>;
  },
});

/** A real calendar date in yyyy-mm-dd, else null (what a native date input accepts). Ported from GenUI fieldLogic.ts (Apache-2.0). */
export function isoDate(value: unknown): string | null {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value as string : null;
}

const DateInput = defineComponent({
  name: "DateInput",
  props: z.object({ name: z.string(), label: z.string().optional(), min: z.string().optional(), max: z.string().optional(), value: reactive(z.string().optional()) }),
  description: "A date picker. value, min, and max are yyyy-mm-dd dates, and the answer is sent the same way.",
  component: ({ props }) => {
    const state = useField(props.name, props.value);
    return <Label text={props.label}><input type="date" className={`${field} w-fit`} name={state.name} min={isoDate(props.min) ?? undefined} max={isoDate(props.max) ?? undefined} value={isoDate(state.value) ?? ""} disabled={useLocked()} onChange={(event) => state.setValue(event.target.value)} /></Label>;
  },
});

/** Star count: a whole number from 1 to 10, default 5. Ported from GenUI fieldLogic.ts (Apache-2.0). */
export const ratingMax = (max: unknown): number => (finite(max) === null ? 5 : Math.min(10, Math.max(1, Math.round(max as number))));

const Rating = defineComponent({
  name: "Rating",
  props: z.object({ name: z.string(), label: z.string().optional(), max: z.number().optional(), value: reactive(z.number().optional()) }),
  description: "Stars from 1 to max (default 5, at most 10). 0 means not rated yet. Picking the current star again clears it.",
  component: ({ props }) => {
    const state = useField(props.name, props.value);
    const max = ratingMax(props.max);
    const value = Math.min(max, Math.max(0, Math.round(finite(state.value) ?? 0)));
    const [hover, setHover] = useState(0);
    const locked = useLocked();
    const shown = locked ? value : hover || value;
    return <Titled label={props.label} name={props.name} aside={<span className="tabular-nums">{value ? `${value} of ${max}` : "Not rated"}</span>}>
      <span className="flex w-fit" onMouseLeave={() => setHover(0)}>{Array.from({ length: max }, (_, index) => index + 1).map((star) => (
        <button key={star} type="button" aria-label={`${star} of ${max}`} aria-pressed={star === value} disabled={locked} onMouseEnter={() => setHover(star)} onFocus={() => setHover(0)} onClick={() => state.setValue(star === value ? 0 : star)}
          className={`cursor-pointer rounded-sm p-0.5 disabled:cursor-default ${focusRing} ${star <= shown ? "text-warning" : "text-muted-foreground"}`}><Star className={`size-5 ${star <= shown ? "fill-current" : ""}`} aria-hidden /></button>
      ))}</span>
    </Titled>;
  },
});

const Toggle = defineComponent({
  name: "Toggle",
  props: z.object({ name: z.string(), label: z.string(), value: reactive(z.boolean().optional()) }),
  description: "An on/off switch.",
  component: ({ props }) => {
    const state = useField(props.name, props.value);
    const on = state.value === true;
    return <button type="button" role="switch" aria-checked={on} disabled={useLocked()} onClick={() => state.setValue(!on)} className={`inline-flex w-fit cursor-pointer items-center gap-2 rounded-md text-foreground disabled:opacity-60 ${focusRing}`}>
      <span className={`relative h-4 w-7 rounded-full transition-colors ${on ? "bg-primary" : "bg-muted"}`}><span className={`absolute top-0.5 size-3 rounded-full bg-background transition-[left] ${on ? "left-3.5" : "left-0.5"}`} /></span>
      {props.label}
    </button>;
  },
});

const Choice = defineComponent({
  name: "Choice",
  props: z.object({ name: z.string(), options, label: z.string().optional(), multiple: z.boolean().optional(), value: reactive(z.union([z.string(), z.array(z.string())]).optional()) }),
  description: `Pick one option, or several with multiple true. Shown as pills, so keep options short; ${optionsHelp}. For options that need a line of detail use Radio or CheckBoxGroup; for a long list use Select.`,
  component: ({ props }) => {
    const list = optionsOf(props.options);
    const { chosen, pick, locked } = usePick(props.name, list, props.multiple, props.value);
    return <Titled label={props.label} name={props.name}>
      <div className="flex flex-wrap gap-1.5">{list.map((o) => <button key={o.value} type="button" title={o.detail} aria-pressed={chosen.has(o.value)} disabled={locked} onClick={() => pick(o.value)} className={`cursor-pointer rounded-md border px-2.5 py-1 disabled:opacity-60 ${focusRing} ${chosen.has(o.value) ? "border-primary bg-primary text-primary-foreground" : "border-input text-foreground hover:bg-state-hover"}`}>{o.label}</button>)}</div>
    </Titled>;
  },
});

/** Radio buttons or checkboxes in a column, each with an optional line of detail. */
function OptionList({ name, label, items, multiple, value, checklist }: { name: string; label?: string; items: unknown; multiple?: boolean; value: unknown; checklist?: boolean }) {
  const list = optionsOf(items);
  const { chosen, pick, locked } = usePick(name, list, multiple, value);
  const group = useId();
  const done = list.filter((o) => chosen.has(o.value)).length;
  return <Titled label={label} name={name} role={multiple ? "group" : "radiogroup"} aside={checklist && list.length ? <span className="tabular-nums">{done} of {list.length} done</span> : null}>
    <div className="flex flex-col gap-1.5">{list.map((o) => (
      <label key={o.value} className="flex w-fit cursor-pointer items-start gap-2 text-foreground">
        <input type={multiple ? "checkbox" : "radio"} name={group} className={`mt-1 shrink-0 accent-primary disabled:opacity-60 ${focusRing}`} checked={chosen.has(o.value)} disabled={locked} onChange={() => pick(o.value)} />
        <span className="flex min-w-0 flex-col"><span className={checklist && chosen.has(o.value) ? "text-muted-foreground line-through" : ""}>{o.label}</span>{o.detail ? <span className="text-muted-foreground">{o.detail}</span> : null}</span>
      </label>
    ))}</div>
  </Titled>;
}

const Radio = defineComponent({
  name: "Radio",
  props: z.object({ name: z.string(), options, label: z.string().optional(), value: reactive(z.string().optional()) }),
  description: `Pick exactly one option from a short column of radio buttons; ${optionsHelp}, and detail shows under the option. Arrow keys move the pick.`,
  component: ({ props }) => <OptionList name={props.name} label={props.label} items={props.options} value={props.value} />,
});

const CheckBoxGroup = defineComponent({
  name: "CheckBoxGroup",
  props: z.object({ name: z.string(), options, label: z.string().optional(), value: reactive(z.array(z.string()).optional()) }),
  description: `Tick any number of options in a column of checkboxes; ${optionsHelp}. The ticked values are sent in option order.`,
  component: ({ props }) => <OptionList name={props.name} label={props.label} items={props.options} value={props.value} multiple />,
});

const Checklist = defineComponent({
  name: "Checklist",
  props: z.object({ name: z.string(), items: options, label: z.string().optional(), value: reactive(z.array(z.string()).optional()) }),
  description: "A to-do list the reader ticks off, with an \"n of m done\" count. items are strings or {label, value?, detail?}; value lists the items already done. Done items are sent.",
  component: ({ props }) => <OptionList name={props.name} label={props.label} items={props.items} value={props.value} multiple checklist />,
});

const Select = defineComponent({
  name: "Select",
  props: z.object({ name: z.string(), options, label: z.string().optional(), placeholder: z.string().optional(), value: reactive(z.string().optional()) }),
  description: `Pick one option from a dropdown, good for long lists; ${optionsHelp}. placeholder shows until a pick, default "Choose…".`,
  component: ({ props }) => {
    const state = useField(props.name, props.value);
    const list = optionsOf(props.options);
    const value = typeof state.value === "string" && list.some((o) => o.value === state.value) ? state.value : "";
    return <Label text={props.label}>
      <select className={`${field} w-fit max-w-full`} name={state.name} value={value} disabled={useLocked()} onChange={(event) => state.setValue(event.target.value)}>
        <option value="" disabled>{props.placeholder ?? "Choose…"}</option>
        {list.map((o) => <option key={o.value} value={o.value}>{o.detail ? `${o.label} - ${o.detail}` : o.label}</option>)}
      </select>
    </Label>;
  },
});

const OptionCards = defineComponent({
  name: "OptionCards",
  props: z.object({
    name: z.string(),
    options: z.array(z.union([z.string(), z.object({ label: z.string(), value: z.string().optional(), detail: z.string().optional(), icon: z.string().optional() })])),
    label: z.string().optional(),
    multiple: z.boolean().optional(),
    value: reactive(z.union([z.string(), z.array(z.string())]).optional()),
  }),
  description: `Pick one of a few rich options shown as cards side by side, or several with multiple true. options are {label, value?, detail?, icon?}; value defaults to label. icon is one of: ${ICON_NAMES}.`,
  component: ({ props }) => {
    const list = optionsOf(props.options);
    const { chosen, pick, locked } = usePick(props.name, list, props.multiple, props.value);
    return <Titled label={props.label} name={props.name}>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">{list.map((o) => {
        const Icon = iconFor(o.icon);
        const on = chosen.has(o.value);
        return <button key={o.value} type="button" aria-pressed={on} disabled={locked} onClick={() => pick(o.value)} className={`flex cursor-pointer flex-col items-start gap-1 rounded-md border p-3 text-left disabled:cursor-default ${locked && !on ? "opacity-60" : ""} ${focusRing} ${on ? "border-primary ring-1 ring-primary" : "border-border-hairline hover:bg-state-hover"}`}>
          <span className="flex w-full items-center gap-2 font-medium text-foreground">{Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : null}<span className="min-w-0 flex-1">{o.label}</span>{on ? <Check className="size-4 shrink-0 text-primary" aria-hidden /> : null}</span>
          {o.detail ? <span className="text-muted-foreground">{o.detail}</span> : null}
        </button>;
      })}</div>
    </Titled>;
  },
});

export type Swatch = { value: string; name?: string };

/** Whether a string is a CSS colour. jsdom has no CSS.supports, so tests fall back to a pattern. */
export const isColor = (value: string): boolean => (typeof CSS !== "undefined" && typeof CSS.supports === "function" ? CSS.supports("color", value) : /^(#[0-9a-f]{3,8}|(rgba?|hsla?|oklch|oklab|lab|lch|color)\(.+\)|[a-z]+)$/i.test(value));

/** Swatch colours: CSS colour strings or {value, name?}. Unreadable colours are returned apart, to show the reader. Ported from GenUI choose-logic.ts (Apache-2.0). */
export function swatchColors(colors: unknown, check = isColor): { colors: Swatch[]; invalid: string[] } {
  const valid: Swatch[] = [];
  const invalid: string[] = [];
  for (const item of Array.isArray(colors) ? colors : []) {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : { value: item } as Record<string, unknown>;
    const value = typeof entry.value === "string" ? entry.value.trim() : "";
    if (value === "") continue;
    if (check(value) && !valid.some((s) => s.value.toLowerCase() === value.toLowerCase())) valid.push({ value, name: text(entry.name) });
    else if (!check(value)) invalid.push(value);
  }
  return { colors: valid, invalid };
}

const Swatches = defineComponent({
  name: "Swatches",
  props: z.object({ name: z.string(), colors: z.array(z.union([z.string(), z.object({ value: z.string(), name: z.string().optional() })])), label: z.string().optional(), value: reactive(z.string().optional()) }),
  description: "Pick one colour from a row of chips. colors are CSS colours (\"#2563eb\", \"oklch(0.7 0.1 200)\") or {value, name?}; the chosen value is sent.",
  component: ({ props }) => {
    const state = useField(props.name, props.value);
    const { colors, invalid } = swatchColors(props.colors);
    const locked = useLocked();
    const current = colors.find((s) => typeof state.value === "string" && s.value.toLowerCase() === state.value.trim().toLowerCase());
    return <Titled label={props.label} name={props.name}>
      <div className="flex flex-wrap gap-2">{colors.map((s) => (
        <button key={s.value} type="button" aria-label={s.name ?? s.value} title={s.name ? `${s.name} ${s.value}` : s.value} aria-pressed={s === current} disabled={locked} onClick={() => state.setValue(s.value)}
          className={`size-7 cursor-pointer rounded-md border border-border-hairline disabled:cursor-default ${locked && s !== current ? "opacity-60" : ""} ${focusRing} ${s === current ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""}`} style={{ backgroundColor: s.value }} />
      ))}</div>
      {current ? <span className="text-foreground">{current.name ? `${current.name} ` : ""}<span className="font-mono text-muted-foreground">{current.value}</span></span> : null}
      {invalid.length ? <span className="text-muted-foreground">Not a colour: {invalid.join(", ")}</span> : null}
    </Titled>;
  },
});

// Ported from GenUI ui/components/fieldLogic.ts (Apache-2.0).
/** Why `draft` cannot join `items` (ignoring the entry at `except`, the one being edited), or null if it can. */
export function itemProblem(items: readonly string[], draft: string, except = -1): "empty" | "duplicate" | null {
  const item = draft.trim();
  if (item === "") return "empty";
  return items.some((existing, index) => index !== except && existing === item) ? "duplicate" : null;
}

/** `items` with entry `index` replaced by the trimmed draft; null when invalid or unchanged. */
export function replaceItem(items: readonly string[], index: number, draft: string): string[] | null {
  if (index < 0 || index >= items.length || itemProblem(items, draft, index) !== null || items[index] === draft.trim()) return null;
  return items.map((existing, position) => (position === index ? draft.trim() : existing));
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

const ListEditor = defineComponent({
  name: "ListEditor",
  props: z.object({ name: z.string(), label: z.string().optional(), placeholder: z.string().optional(), value: reactive(z.array(z.string()).optional()) }),
  description: "A list the reader grows, edits in place, and trims, such as names or tags. value is the starting list. Repeats are refused.",
  component: ({ props }) => {
    const state = useField(props.name, props.value);
    const items = strings(state.value);
    const [draft, setDraft] = useState("");
    const locked = useLocked();
    const problem = draft === "" ? null : itemProblem(items, draft);
    const add = () => { if (itemProblem(items, draft) === null) { state.setValue([...items, draft.trim()]); setDraft(""); } };
    return <Titled label={props.label} name={props.name}>
      {items.map((item, index) => (
        <span key={`${index}:${item}`} className="flex items-center gap-1.5">
          <input className={field} aria-label={`Item ${index + 1}`} defaultValue={item} disabled={locked}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            onBlur={(event) => { const next = replaceItem(items, index, event.target.value); if (next) state.setValue(next); else event.target.value = item; }} />
          <button type="button" aria-label={`Remove ${item}`} disabled={locked} onClick={() => state.setValue(items.filter((_, position) => position !== index))} className={`inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-40 ${focusRing}`}><X className="size-3.5" aria-hidden /></button>
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <input className={field} aria-label={`Add to ${props.label ?? props.name}`} placeholder={props.placeholder ?? "Add an item"} value={draft} disabled={locked} aria-invalid={problem === "duplicate" || undefined}
          onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
        <button type="button" aria-label="Add" disabled={locked || problem !== null || draft === ""} onClick={add} className={`inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-input text-foreground hover:bg-state-hover disabled:cursor-default disabled:opacity-40 ${focusRing}`}><Plus className="size-3.5" aria-hidden /></button>
      </span>
      {problem === "duplicate" ? <span role="status" className="text-muted-foreground">Already in the list</span> : null}
    </Titled>;
  },
});

// Ported from GenUI ui/components/choose-logic.ts (Apache-2.0).
export type Column = { key: string; label: string; type: "text" | "number" | "boolean" };
export type Row = Record<string, unknown>;

/** Columns as keys or {key, label?, type?}. A column without a type takes the kind of its first filled cell. */
export function tableColumns(columns: unknown, rows: readonly Row[]): Column[] {
  const out: Column[] = [];
  for (const item of Array.isArray(columns) ? columns : []) {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : { key: item } as Record<string, unknown>;
    const key = text(entry.key);
    if (key === undefined || out.some((c) => c.key === key)) continue;
    const filled = rows.map((row) => row[key]).find((cell) => cell !== null && cell !== undefined && cell !== "");
    const type = entry.type === "text" || entry.type === "number" || entry.type === "boolean" ? entry.type : typeof filled === "number" ? "number" : typeof filled === "boolean" ? "boolean" : "text";
    out.push({ key, label: text(entry.label) ?? key.charAt(0).toUpperCase() + key.slice(1), type });
  }
  return out;
}

/** A new row with every column present. Numbers start empty (null). */
export const blankRow = (columns: readonly Column[]): Row => Object.fromEntries(columns.map((c) => [c.key, c.type === "boolean" ? false : c.type === "number" ? null : ""]));

/**
 * A typed number: 12, -3.5, 1,234.5 (comma grouping) or 3,5 (a decimal comma). "" is null (an empty cell);
 * anything unreadable, including a half-typed "-" or "1.", is undefined so the cell keeps the draft.
 */
export function parseNumberInput(input: string): number | null | undefined {
  const compact = input.trim().replace(/[\s  ']/g, "");
  if (compact === "") return null;
  const normalized = compact.includes(".") ? compact.replace(/,/g, "")
    : /^-?\d{1,3}(,\d{3})+$/.test(compact) && !/^-?0,/.test(compact) ? compact.replace(/,/g, "") : compact.replace(",", ".");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(normalized) || normalized.endsWith(".")) return undefined;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : undefined;
}

const rowsOf = (value: unknown): Row[] => (Array.isArray(value) ? value.filter((row): row is Row => !!row && typeof row === "object" && !Array.isArray(row)) : []);

function NumberCell({ value, label, disabled, onChange }: { value: unknown; label: string; disabled: boolean; onChange: (value: number | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return <input className={`${field} text-right tabular-nums`} inputMode="decimal" aria-label={label} disabled={disabled} value={draft ?? (typeof value === "number" ? String(value) : "")}
    onChange={(event) => { setDraft(event.target.value); const parsed = parseNumberInput(event.target.value); if (parsed !== undefined) onChange(parsed); }} onBlur={() => setDraft(null)} />;
}

const EditableTable = defineComponent({
  name: "EditableTable",
  props: z.object({
    name: z.string(),
    columns: z.array(z.union([z.string(), z.object({ key: z.string(), label: z.string().optional(), type: z.enum(["text", "number", "boolean"]).optional() })])),
    label: z.string().optional(),
    rows: z.array(z.record(z.string(), z.any())).optional(),
  }),
  description: 'A small table the reader edits: change cells, add rows, remove rows. columns are keys or {key, label?, type?}; type "text", "number", or "boolean" (a checkbox), else the kind of the first filled cell. rows are the starting rows. The rows are sent as JSON.',
  component: ({ props }) => {
    const form = useFormName();
    const getField = useGetFieldValue();
    const setField = useSetFieldValue();
    // Rows are objects, so the Form holds them as one JSON text that reads well in the sent message.
    const [edited, setEdited] = useState<Row[] | null>(() => {
      const held = form === undefined ? undefined : getField(form, props.name);
      try { return typeof held === "string" ? rowsOf(JSON.parse(held)) : null; } catch { return null; }
    });
    const rows = edited ?? rowsOf(props.rows);
    const columns = tableColumns(props.columns, rows);
    const locked = useLocked();
    const streaming = useIsStreaming();
    const json = JSON.stringify(rows);
    useEffect(() => {
      if (form !== undefined && !streaming && getField(form, props.name) !== json) setField(form, undefined, props.name, json, false);
    }, [form, streaming, props.name, json]);
    const setCell = (index: number, key: string, value: unknown) => setEdited(rows.map((row, position) => (position === index ? { ...row, [key]: value } : row)));
    const cellText = (value: unknown) => (value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value));
    return <Titled label={props.label} name={props.name}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead><tr className="border-b border-border-hairline text-left text-muted-foreground">{columns.map((c) => <th key={c.key} scope="col" className={`px-1 py-1 font-normal ${c.type === "number" ? "text-right" : ""}`}>{c.label}</th>)}<th className="w-8"><span className="sr-only">Remove</span></th></tr></thead>
          <tbody>{rows.map((row, index) => (
            <tr key={index} className="border-b border-border-hairline">
              {columns.map((c) => {
                const label = `${c.label}, row ${index + 1}`;
                return <td key={c.key} className="px-1 py-1">{
                  c.type === "boolean" ? <input type="checkbox" aria-label={label} className={`accent-primary ${focusRing}`} checked={row[c.key] === true} disabled={locked} onChange={(event) => setCell(index, c.key, event.target.checked)} />
                  : c.type === "number" ? <NumberCell label={label} value={row[c.key]} disabled={locked} onChange={(value) => setCell(index, c.key, value)} />
                  : <input className={field} aria-label={label} value={cellText(row[c.key])} disabled={locked} onChange={(event) => setCell(index, c.key, event.target.value)} />
                }</td>;
              })}
              <td className="px-1 py-1"><button type="button" aria-label={`Remove row ${index + 1}`} disabled={locked} onClick={() => setEdited(rows.filter((_, position) => position !== index))} className={`inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-40 ${focusRing}`}><X className="size-3.5" aria-hidden /></button></td>
            </tr>
          ))}</tbody>
        </table>
        {rows.length === 0 ? <p className="m-0 py-2 text-muted-foreground">No rows yet</p> : null}
      </div>
      {columns.length ? <button type="button" disabled={locked} onClick={() => setEdited([...rows, blankRow(columns)])} className={`inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-md px-1 py-1 text-foreground hover:bg-state-hover disabled:opacity-60 ${focusRing}`}><Plus className="size-3.5" aria-hidden />Add row</button> : null}
    </Titled>;
  },
});

/**
 * Sends `label` (and the Form's answers) to the thread. The clicked control stays solid once sent; its siblings dim.
 * Where nothing can be sent, only a control with its own action stays live.
 */
function useSend(label: string, own?: boolean, hasAction?: boolean) {
  const trigger = useTriggerAction();
  const form = useFormName();
  const key = own ? undefined : form;
  const sentLabel = useContext(SentContext).sent[key ?? ""];
  const readOnly = useReadOnly() && !hasAction;
  const disabled = useIsStreaming() || sentLabel !== undefined || readOnly;
  return { chosen: sentLabel === label, sent: sentLabel !== undefined, disabled, send: (plan?: ActionPlan) => void trigger(label, key, plan) };
}

const buttonStyle = {
  primary: "bg-primary text-primary-foreground hover:opacity-90",
  secondary: "border border-input text-foreground hover:bg-state-hover",
  ghost: "text-muted-foreground hover:bg-state-hover hover:text-foreground",
} as const;

const Button = defineComponent({
  name: "Button",
  props: z.object({ label: z.string(), action: action().optional(), variant: z.enum(["primary", "secondary"]).optional() }),
  description: 'A button. With no action it sends its label (and its Form answers) to the assistant, then locks. variant "primary" (default) or "secondary".',
  component: ({ props }) => {
    const { chosen, sent, disabled, send } = useSend(props.label, false, props.action !== undefined);
    return <button type="button" aria-pressed={sent ? chosen : undefined} disabled={disabled} onClick={() => send(props.action as ActionPlan | undefined)} className={`w-fit cursor-pointer rounded-md px-3 py-1.5 font-medium ${chosen ? "disabled:cursor-default" : "disabled:opacity-60"} ${focusRing} ${buttonStyle[props.variant ?? "primary"]}`}>{props.label}</button>;
  },
});

const IconButton = defineComponent({
  name: "IconButton",
  props: z.object({ label: z.string(), icon: z.string(), action: action().optional(), variant: z.enum(["primary", "secondary", "ghost"]).optional() }),
  description: `A square button that shows only an icon; label is its tooltip and screen reader name, and is what it sends, like Button. variant "secondary" (default, hairline frame), "primary" (solid), or "ghost" (no frame). icon is one of: ${ICON_NAMES}. An unknown icon shows the label instead.`,
  component: ({ props }) => {
    const { chosen, sent, disabled, send } = useSend(props.label, false, props.action !== undefined);
    const Icon = iconFor(props.icon);
    return <button type="button" aria-label={props.label} title={props.label} aria-pressed={sent ? chosen : undefined} disabled={disabled} onClick={() => send(props.action as ActionPlan | undefined)}
      className={`inline-flex h-8 min-w-8 w-fit cursor-pointer items-center justify-center rounded-md ${Icon ? "" : "px-2"} ${chosen ? "disabled:cursor-default" : "disabled:opacity-60"} ${focusRing} ${buttonStyle[props.variant ?? "secondary"]}`}>{Icon ? <Icon className="size-4" aria-hidden /> : props.label}</button>;
  },
});

/** Follow-up prompts: trimmed text, repeats dropped. Ported from GenUI choose-logic.ts (Apache-2.0). */
export function followUpPrompts(prompts: unknown): string[] {
  const out: string[] = [];
  for (const item of Array.isArray(prompts) ? prompts : []) {
    const prompt = text(item);
    if (prompt !== undefined && !out.includes(prompt)) out.push(prompt);
  }
  return out;
}

function FollowUp({ prompt }: { prompt: string }) {
  // Own: a prompt is sent alone, even inside a Form.
  const { chosen, sent, disabled, send } = useSend(prompt, true);
  return <button type="button" aria-pressed={sent ? chosen : undefined} disabled={disabled} onClick={() => send()} className={`flex w-full cursor-pointer items-center gap-2 border-t border-border-hairline py-1.5 text-left text-foreground hover:text-primary disabled:cursor-default ${sent && !chosen ? "opacity-60" : ""} ${chosen ? "font-medium" : ""} ${focusRing}`}>
    <span className="min-w-0 flex-1">{prompt}</span>{chosen ? <Check className="size-4 shrink-0" aria-hidden /> : <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
  </button>;
}

const FollowUps = defineComponent({
  name: "FollowUps",
  props: z.object({ prompts: z.array(z.string()), label: z.string().optional() }),
  description: "Suggested next questions, at the end of a reply. Each prompt is a row the reader clicks to send its text to the thread as their next message. Keep 2 to 4 short prompts. label is a heading above them.",
  component: ({ props }) => {
    const prompts = followUpPrompts(props.prompts);
    const readOnly = useReadOnly();
    return <div role="group" aria-label={props.label ?? "Follow-ups"} className="flex flex-col">
      {props.label ? <span className="pb-1 text-muted-foreground">{props.label}</span> : null}
      {prompts.map((prompt) => <FollowUp key={prompt} prompt={prompt} />)}
      {readOnly && prompts.length ? <div className="border-t border-border-hairline pt-1.5"><ReadOnlyNote /></div> : null}
    </div>;
  },
});

function SentLine({ form }: { form: string }) {
  const { sent, unlock } = useContext(SentContext);
  if (useReadOnly()) return <ReadOnlyNote />;
  if (sent[form] === undefined) return null;
  return <p role="status" className="m-0 text-muted-foreground">Sent to the thread. <button type="button" onClick={() => unlock(form)} className={`cursor-pointer rounded-sm text-foreground underline underline-offset-2 ${focusRing}`}>Edit answers</button></p>;
}

const Form = defineComponent({
  name: "Form",
  props: z.object({ name: z.string(), fields: z.array(z.any()), buttons: z.array(z.union([Button.ref, IconButton.ref])) }),
  description: "Groups fields so a Button sends all their answers to the assistant in one message. A sent Form locks until the reader picks Edit answers.",
  component: ({ props, renderNode }) => <FormNameContext.Provider value={props.name}>
    <div role="form" aria-label={props.name} className="flex flex-col gap-3">{renderNode(props.fields)}<div className="flex flex-wrap items-center gap-2">{renderNode(props.buttons)}</div><SentLine form={props.name} /></div>
  </FormNameContext.Provider>,
});

export const group: Group = {
  id: "inputs",
  name: "Inputs",
  notes: [
    "Every field takes its name first. Inside a Form, a Button sends each field as a \"- name: value\" line; lists are joined with commas.",
    "Bind a field's value to a $variable to read it elsewhere live; a bound or preset value inside a Form is sent too.",
    "Choice for a few short options, Radio or CheckBoxGroup when options need detail, Select for long lists, OptionCards for a few rich options.",
  ],
  entries: [
    { component: Input, summary: "one-line text field", examples: [
      { name: "With label", code: `root = Input("title", "Title", "Name the release")` },
      { name: "Bound", code: `$name = "Ada"\nroot = Stack([Input("name", "Name", null, $name), Text("Hello, " + $name, "muted")])` },
    ] },
    { component: TextArea, summary: "multi-line text field", examples: [
      { name: "Notes", code: `root = TextArea("notes", "Anything else?", "Context, constraints, links")` },
      { name: "Preset", code: `root = TextArea("summary", "Summary", null, "Ship the beta to 5% of users on Monday.\\nRoll back if errors pass 1%.")` },
    ] },
    { component: Slider, summary: "number slider", examples: [
      { name: "Drives a Text", code: `$budget = 40\nroot = Stack([Slider("budget", 0, 100, 5, "Budget", $budget), Text("Budget: " + $budget + "%", "muted")])` },
    ] },
    { component: Stepper, summary: "number with - and +", examples: [
      { name: "Count", code: `root = Stepper("seats", "Seats", 1, 20, 1, 3)` },
      { name: "Decimals, bound", code: `$ratio = 1.5\nroot = Stack([Stepper("ratio", "Ratio", 0, 3, 0.25, $ratio), Text("Ratio " + $ratio, "muted")])` },
      { name: "No bounds", code: `root = Stepper("offset", "Offset")` },
    ] },
    { component: DateInput, summary: "date picker", examples: [
      { name: "Range", code: `root = DateInput("launch", "Launch date", "2026-11-01", "2026-12-31", "2026-11-18")` },
      { name: "Empty", code: `root = DateInput("due", "Due")` },
    ] },
    { component: Rating, summary: "stars", examples: [
      { name: "Rated", code: `root = Rating("quality", "How good was the answer?", 5, 4)` },
      { name: "Ten, unrated", code: `root = Rating("likely", "How likely are you to recommend us?", 10)` },
    ] },
    { component: Toggle, summary: "on/off switch", examples: [{ name: "Toggle", code: `root = Toggle("notify", "Notify me")` }] },
    { component: Choice, summary: "pick one or several, as pills", examples: [
      { name: "One", code: `root = Choice("channel", ["Email", "Ads", "Social"], "Channel")` },
      { name: "Several", code: `root = Choice("days", ["Mon", "Tue", "Wed", "Thu", "Fri"], "Days", true, ["Mon", "Wed"])` },
    ] },
    { component: Radio, summary: "pick one, with detail", examples: [
      { name: "With detail", code: `root = Radio("plan", [{label: "Starter", detail: "One project, community support"}, {label: "Team", detail: "Ten projects, email support"}, {label: "Business", value: "biz", detail: "Unlimited, SSO, a named contact"}], "Plan", "Team")` },
      { name: "Plain", code: `root = Radio("size", ["Small", "Medium", "Large"], "Size")` },
    ] },
    { component: CheckBoxGroup, summary: "tick several, with detail", examples: [
      { name: "With detail", code: `root = CheckBoxGroup("checks", [{label: "Unit tests", detail: "vitest, about 40s"}, {label: "Type check"}, {label: "End-to-end", detail: "Playwright, about 6 min"}], "Run before merge", ["Unit tests", "Type check"])` },
    ] },
    { component: Checklist, summary: "to-do list to tick off", examples: [
      { name: "Launch", code: `root = Checklist("launch", ["Freeze the branch", "Run the migration", {label: "Flip the flag", detail: "billing.v2 to 100%"}, "Post in #releases"], "Launch steps", ["Freeze the branch"])` },
      { name: "Empty", code: `root = Checklist("todo", [], "Nothing to do")` },
    ] },
    { component: Select, summary: "dropdown for long lists", examples: [
      { name: "Region", code: `root = Select("region", ["us-east-1", "us-west-2", "eu-west-1", "eu-central-1", "ap-southeast-1", "ap-northeast-1"], "Region", "Pick a region")` },
      { name: "Labels and preset", code: `root = Select("tz", [{label: "London", value: "Europe/London"}, {label: "New York", value: "America/New_York"}, {label: "Tokyo", value: "Asia/Tokyo", detail: "UTC+9"}], "Time zone", null, "America/New_York")` },
    ] },
    { component: OptionCards, summary: "pick one of a few rich options", examples: [
      { name: "One", code: `root = OptionCards("approach", [{label: "Patch", icon: "zap", detail: "Fix the query in place. Fast, keeps the debt."}, {label: "Refactor", icon: "code", detail: "Move reads to the cache layer. Two days."}, {label: "Rewrite", icon: "rocket", detail: "New service. A sprint, cleanest result."}], "How should we fix it?", false, "Refactor")` },
      { name: "Several", code: `root = OptionCards("extras", [{label: "Dark mode"}, {label: "Export to CSV", detail: "From any table"}, {label: "Slack alerts", icon: "bell"}], "Add to the next release", true)` },
    ] },
    { component: Swatches, summary: "colour pick", examples: [
      { name: "Named", code: `root = Swatches("accent", [{value: "#2563eb", name: "Blue"}, {value: "#16a34a", name: "Green"}, {value: "#d97706", name: "Amber"}, {value: "#dc2626", name: "Red"}, {value: "#7c3aed", name: "Violet"}], "Accent colour", "#16a34a")` },
      { name: "Plain CSS", code: `root = Swatches("bg", ["white", "oklch(0.95 0.02 90)", "#0f172a"], "Background")` },
    ] },
    { component: ListEditor, summary: "editable list of strings", examples: [
      { name: "Tags", code: `root = ListEditor("tags", "Tags", "Add a tag", ["billing", "urgent"])` },
      { name: "Empty", code: `root = ListEditor("reviewers", "Reviewers", "Name or handle")` },
    ] },
    { component: EditableTable, summary: "small table to edit", examples: [
      { name: "Typed columns", code: `root = EditableTable("order", [{key: "item"}, {key: "qty", label: "Qty", type: "number"}, {key: "gift", label: "Gift wrap", type: "boolean"}], "Order", [{item: "Tea", qty: 2, gift: false}, {item: "Mug", qty: 1, gift: true}])` },
      { name: "Empty", code: `root = EditableTable("guests", ["name", "email"], "Guests")` },
    ] },
    { component: Button, summary: "send or act", examples: [
      { name: "Variants", code: `root = Stack([Button("Ship it"), Button("Not yet", null, "secondary")], "row", "s")` },
    ] },
    { component: IconButton, summary: "icon-only button", examples: [
      { name: "Variants", code: `root = Stack([IconButton("Like", "thumbs-up", null, "primary"), IconButton("Retry", "refresh"), IconButton("More", "more", null, "ghost"), IconButton("Unknown icon", "kraken")], "row", "s")` },
    ] },
    { component: FollowUps, summary: "suggested next prompts", examples: [
      { name: "Prompts", code: `root = FollowUps(["Show the slowest queries", "Compare with last week", "Draft the incident note"], "Next")` },
    ] },
    { component: Form, summary: "fields sent as one answer", examples: [
      { name: "Form", code: `root = Form("launch", [Choice("channel", ["Email", "Ads"], "Channel"), Slider("budget", 0, 100, 5, "Budget"), Input("note", "Note")], [Button("Approve"), Button("Hold", null, "secondary")])` },
      { name: "Many fields", code: `root = Form("intake", [Radio("kind", ["Bug", "Feature", "Question"], "Kind"), DateInput("due", "Needed by"), Stepper("people", "People affected", 1, 1000), Rating("pain", "How painful?"), CheckBoxGroup("areas", ["API", "Web", "Mobile"], "Areas"), TextArea("details", "Details")], [Button("Send"), IconButton("Discard", "trash", null, "ghost")])` },
    ] },
  ],
};
