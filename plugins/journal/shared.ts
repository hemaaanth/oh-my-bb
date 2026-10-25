// Values both server.ts and app.tsx need. Kept free of zod and the SDK: a value
// import from server.ts would pull all of zod into the single app bundle.
export const CATEGORIES = ["bug-fix", "feature", "improvement", "research", "analysis", "operations", "content", "planning", "review", "project", "test"] as const;
export type JournalCategory = (typeof CATEGORIES)[number];

export const categoryLabels: Record<JournalCategory, string> = {
  "bug-fix": "Bug fix", feature: "Feature", improvement: "Improvement", research: "Research",
  analysis: "Analysis", operations: "Operations", content: "Content", planning: "Planning",
  review: "Review", project: "Project", test: "Test",
};
export const DEFAULT_WORK_TIME_ZONE = "America/New_York";
export const PREFERENCES_CHANGED = "journal-preferences-changed";
export const AI_BACKENDS = ["openrouter", "subscription"] as const;
export const GATEWAY_MODELS = ["gpt-6-luna", "gpt-5.6-luna"] as const;
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
function dateParts(timestamp: number, timeZone: string) {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    dateFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(timestamp).map(({ type, value }) => [type, Number(value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}
export function workDateStart(year: number, month: number, day: number, timeZone = DEFAULT_WORK_TIME_ZONE): number {
  const utc = Date.UTC(year, month - 1, day);
  let guess = utc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = dateParts(guess, timeZone);
    const offset = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - guess;
    const next = utc - offset;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}
export function localDayStart(timestamp: number, timeZone = DEFAULT_WORK_TIME_ZONE): number {
  const { year, month, day } = dateParts(timestamp, timeZone);
  return workDateStart(year, month, day, timeZone);
}
/** Hour of the day (0–23) in the work time zone. */
export function localHour(timestamp: number, timeZone = DEFAULT_WORK_TIME_ZONE): number {
  return dateParts(timestamp, timeZone).hour;
}
export function localWeekStart(timestamp: number, timeZone = DEFAULT_WORK_TIME_ZONE): number {
  const { year, month, day } = dateParts(timestamp, timeZone);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return workDateStart(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), timeZone);
}
export function addWorkDays(timestamp: number, amount: number, timeZone = DEFAULT_WORK_TIME_ZONE): number {
  const { year, month, day } = dateParts(timestamp, timeZone);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return workDateStart(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), timeZone);
}

/** Rebuilds per-block work from the journal_calendar RPC form, where each work day is sent once. */
export function unpackCalendar<Wire extends { blocks: Array<{ workKey: string | null }>; workDays: Record<string, unknown> }>({ blocks, workDays, ...activity }: Wire) {
  type Block = Omit<Wire["blocks"][number], "workKey"> & { work: Wire["workDays"][string] | null };
  return { ...activity, blocks: blocks.map(({ workKey, ...block }) => ({ ...block, work: workKey === null ? null : workDays[workKey] ?? null }) as Block) };
}
