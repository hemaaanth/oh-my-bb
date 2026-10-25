// CLI parsing and text output ported from Agent Calendar (server.ts) by charpeni/bb-plugins agent-calendar.
// https://github.com/charpeni/bb-plugins/tree/main/plugins/agent-calendar
// Copyright (c) charpeni. MIT License.
//
// `bb journal timesheet` and `bb journal log`. Times use the bb server's local zone.
import {
  addDays, DAY_MS, DEFAULT_MERGE_GAP_MINUTES, formatHours, isMergeGapMinutes, MERGE_GAP_MINUTES, startOfDay, startOfWeek,
  type ActivityBlock, type buildTimesheet, type MergeGapMinutes,
} from "./calendar";

export const CALENDAR_CLI_USAGE = [
  "  bb journal timesheet [--week this|last|YYYY-MM-DD] [--gap 15|30|60|120] [--json]",
  "  bb journal log [--day today|yesterday|YYYY-MM-DD | --week this|last|YYYY-MM-DD] [--gap 15|30|60|120] [--json]",
];

export const CALENDAR_CLI_HELP = [
  "Usage: bb journal timesheet|log [options]",
  "",
  "  timesheet   Agent hours per thread and day for a week",
  "  log         Chronological work blocks for a day or a week (default: today)",
  "",
  "Options:",
  "  --week this|last|YYYY-MM-DD   Week (Monday to Sunday) containing that date",
  "  --day today|yesterday|YYYY-MM-DD   One day (log only)",
  `  --gap ${MERGE_GAP_MINUTES.join("|")}   Merge turns of a thread separated by at most this many idle minutes (default ${DEFAULT_MERGE_GAP_MINUTES})`,
  "  --json                        Print machine-readable JSON",
  "",
  "Child threads and side chats count toward their root thread. Times use the bb server's local time zone.",
].join("\n");

export type CliRange = { from: number; to: number; label: string };
export type ParsedCalendarCli =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "run"; command: "timesheet" | "log"; range: CliRange; gap: MergeGapMinutes; json: boolean };

/** What the formatters need from a `journal_calendar` result. */
export type CalendarActivity = {
  projects: Array<{ id: string; name: string }>;
  threads: Array<{ id: string; projectId: string; title: string }>;
  blocks: Array<ActivityBlock & { childThreadIds: string[]; work: { dayStart: number; summary: string; outcome: string | null } | null }>;
};

/** Local midnight for `YYYY-MM-DD`, or null when it is not a real date. */
function parseLocalDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match.map(Number) as [number, number, number, number];
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date.getTime();
}

const dayLabel = (t: number) => new Date(t).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });

function weekRange(value: string, now: number): CliRange | null {
  const anchor = value === "this" ? now : value === "last" ? addDays(now, -7) : parseLocalDate(value);
  if (anchor === null) return null;
  const from = startOfWeek(anchor);
  return { from, to: addDays(from, 7), label: `${dayLabel(from)} – ${dayLabel(addDays(from, 6))}` };
}

function dayRange(value: string, now: number): CliRange | null {
  const anchor = value === "today" ? now : value === "yesterday" ? addDays(now, -1) : parseLocalDate(value);
  if (anchor === null) return null;
  const from = startOfDay(anchor);
  return { from, to: addDays(from, 1), label: dayLabel(from) };
}

/** Parses `timesheet|log [options]`; the first positional is the command. */
export function parseCalendarCliArgs(argv: readonly string[], now = Date.now()): ParsedCalendarCli {
  let json = false;
  let gap: MergeGapMinutes = DEFAULT_MERGE_GAP_MINUTES;
  let week: string | null = null;
  let day: string | null = null;
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const option = /^(--[a-z]+)(?:=(.*))?$/.exec(arg);
    const takeValue = () => option?.[2] ?? argv[++index];
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--json") json = true;
    else if (option?.[1] === "--week") week = takeValue() ?? "";
    else if (option?.[1] === "--day") day = takeValue() ?? "";
    else if (option?.[1] === "--gap") {
      const value = takeValue();
      const minutes = Number(value);
      if (!isMergeGapMinutes(minutes)) {
        return { kind: "error", message: `Invalid --gap value: ${value ?? "(missing)"} (expected ${MERGE_GAP_MINUTES.join(", ")})` };
      }
      gap = minutes;
    } else if (arg.startsWith("-")) return { kind: "error", message: `Unknown option: ${arg}` };
    else positional.push(arg);
  }

  const command = positional[0];
  if (positional.length > 1 || (command !== "timesheet" && command !== "log")) {
    return { kind: "error", message: `Unknown command: ${positional.join(" ")}` };
  }
  if (week !== null && day !== null) return { kind: "error", message: "Use either --week or --day, not both" };
  if (command === "timesheet" && day !== null) return { kind: "error", message: "timesheet covers a week; use --week" };

  let range: CliRange | null;
  if (day !== null) {
    range = dayRange(day, now);
    if (!range) return { kind: "error", message: `Invalid --day value: ${day || "(missing)"}` };
  } else if (week !== null || command === "timesheet") {
    range = weekRange(week ?? "this", now);
    if (!range) return { kind: "error", message: `Invalid --week value: ${week || "(missing)"}` };
  } else {
    range = dayRange("today", now);
  }
  return { kind: "run", command, range: range!, gap, json };
}

const MAX_CLI_ROWS = 80;
const MAX_CLI_BLOCKS = 200;
const MAX_CLI_BYTES = 60_000;
/** `--json` lists at most this many blocks and reports the rest as `truncatedBlocks`. */
export const MAX_CLI_JSON_BLOCKS = 500;

export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The JSON envelope: the range plus the threads and projects it mentions. */
export function describeActivity(activity: CalendarActivity, range: CliRange, gap: MergeGapMinutes) {
  const projectIds = new Set(activity.threads.map((thread) => thread.projectId));
  return {
    from: range.from, to: range.to, timeZone: serverTimeZone(), mergeGapMinutes: gap,
    projects: activity.projects.filter((project) => projectIds.has(project.id)), threads: activity.threads,
  };
}

/** Pretty JSON when it fits, compact otherwise; long lists are capped by the caller. */
export function boundedJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return text.length <= MAX_CLI_BYTES ? text : JSON.stringify(value);
}

function clip(text: string, width: number): string {
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, width - 1)}…`;
}

export function formatTimesheet(activity: CalendarActivity, range: CliRange, gap: MergeGapMinutes,
  boundaries: readonly number[], rows: ReturnType<typeof buildTimesheet>): string {
  const header = [
    `Agent time sheet · ${range.label} (${serverTimeZone()})`,
    `Turns merged across idle gaps up to ${gap}m · blocks rounded to quarter hours · hours in decimals`,
  ];
  if (rows.length === 0) return [...header, "", "No agent activity in this week."].join("\n");

  const threads = new Map(activity.threads.map((thread) => [thread.id, thread]));
  const projectNames = new Map(activity.projects.map((project) => [project.id, project.name]));
  const days = boundaries.slice(0, -1).map((t) => new Date(t).toLocaleDateString("en-US", { weekday: "short" }));
  const titleWidth = 44;
  const cell = (value: string) => value.padStart(6);
  const lines = [...header, "", `${"Thread".padEnd(titleWidth)}${days.map(cell).join("")}${cell("Total")}`];

  const byProject = new Map<string, typeof rows>();
  for (const row of rows) {
    const projectId = threads.get(row.threadId)?.projectId ?? "";
    byProject.set(projectId, [...(byProject.get(projectId) ?? []), row]);
  }
  let shown = 0;
  for (const [projectId, projectRows] of byProject) {
    if (shown >= MAX_CLI_ROWS) break;
    lines.push(projectNames.get(projectId) ?? projectId);
    for (const row of projectRows) {
      if (shown >= MAX_CLI_ROWS) break;
      const title = `  ${threads.get(row.threadId)?.title ?? row.threadId} (${row.threadId})`;
      lines.push(`${clip(title, titleWidth)}${row.dayMs.map((ms) => cell(formatHours(ms))).join("")}${cell(formatHours(row.totalMs))}`);
      shown += 1;
    }
  }
  if (rows.length > shown) lines.push(`  … ${rows.length - shown} more threads (use --json)`);

  const dayTotals = boundaries.slice(0, -1).map((_, day) => rows.reduce((sum, row) => sum + row.dayMs[day]!, 0));
  const total = dayTotals.reduce((sum, ms) => sum + ms, 0);
  const active = rows.reduce((sum, row) => sum + row.activeMs, 0);
  lines.push(
    `${"Total".padEnd(titleWidth)}${dayTotals.map((ms) => cell(formatHours(ms) || "0")).join("")}${cell(formatHours(total))}`,
    "",
    `${rows.length === 1 ? "1 thread" : `${rows.length} threads`} · ${formatHours(total)}h on the calendar · ${formatHours(active) || "0"}h of agent turns`,
  );
  return lines.join("\n");
}

export function formatLog(activity: CalendarActivity, range: CliRange, gap: MergeGapMinutes): string {
  const header = [
    `Agent activity · ${range.label} (${serverTimeZone()})`,
    `Turns merged across idle gaps up to ${gap}m · blocks rounded to quarter hours`,
  ];
  if (activity.blocks.length === 0) return [...header, "", "No agent activity."].join("\n");

  const threads = new Map(activity.threads.map((thread) => [thread.id, thread]));
  const projectNames = new Map(activity.projects.map((project) => [project.id, project.name]));
  const time = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const lines = [...header];
  const summarized = new Set<string>();
  let currentDay = -1;
  for (const block of activity.blocks.slice(0, MAX_CLI_BLOCKS)) {
    const day = startOfDay(block.start);
    if (day !== currentDay) {
      currentDay = day;
      lines.push("", new Date(day).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }));
    }
    const thread = threads.get(block.threadId);
    const project = thread ? (projectNames.get(thread.projectId) ?? thread.projectId) : "";
    const span = `${time(block.start)}–${block.end - day >= DAY_MS ? "24:00" : time(block.end)}`;
    const children = block.childThreadIds.length ? ` · +${block.childThreadIds.length} child${block.childThreadIds.length === 1 ? "" : "ren"}` : "";
    lines.push(`  ${span}  ${`${formatHours(block.end - block.start)}h`.padStart(6)}  ${clip(project, 22)}  ${thread?.title ?? block.threadId} (${block.threadId})${children}${block.ongoing ? " · running" : ""}`);
    // The day summary prints once per thread and work day, under its first block.
    // A provisional summary is often just the title; skip it then.
    const key = block.work ? `${block.threadId}:${block.work.dayStart}` : "";
    const text = block.work ? `${block.work.summary}${block.work.outcome ? ` — ${block.work.outcome}` : ""}`.replace(/\s+/g, " ").trim() : "";
    if (block.work?.summary && !summarized.has(key) && text.toLowerCase() !== thread?.title.trim().toLowerCase()) {
      summarized.add(key);
      lines.push(`                 ${text.length > 140 ? `${text.slice(0, 139)}…` : text}`);
    }
  }
  if (activity.blocks.length > MAX_CLI_BLOCKS) lines.push("", `… ${activity.blocks.length - MAX_CLI_BLOCKS} more blocks (use --json)`);
  return lines.join("\n");
}
