import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { definePluginApp, ThreadChat, ThreadTitle, useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import type { CalendarActivity, rpcContract } from "./server";
import { addWorkDays, CATEGORIES, categoryLabels, DEFAULT_WORK_TIME_ZONE, localDayStart, PREFERENCES_CHANGED, unpackCalendar, type JournalCategory } from "./shared";
import { addDays, CHANGE_CHANNEL, DEFAULT_MERGE_GAP_MINUTES, formatDuration, MERGE_GAP_MINUTES, startOfDay, startOfWeek, type MergeGapMinutes } from "./calendar";
import { CalendarEmpty, CalendarLegend, CalendarStats, CalendarView, filterActivity, OTHER_COLOR, Segmented, Swatch, useColors, useRevealed, type CalendarFilters, type ColorMode, type Grouping } from "./calendar-view";
import { TimesheetView } from "./timesheet-view";
import { TracesView } from "./traces-view";
import { CatchUpOverlay } from "./catch-up";
import { ThreadBriefAction } from "./thread-brief";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePortalScopeProps } from "./lib/portal-scope";
import { IntegrationSettings, JournalSetup, MoreSettings, PreferencesSettings } from "./settings";
import "./app.css";

const REALTIME_REFETCH_DELAY_MS = 1_500;
type ReplayMode = "day" | "week" | "all";
type WorkStatus = "completed" | "in-progress" | "blocked" | "exploratory" | "unknown";
interface ActivityEntry {
  threadId: string; dayStart: number; firstActivityAt: number; lastActivityAt: number; messageCount: number;
  projectId: string; projectName: string; title: string; summary: string; outcome: string | null;
  category: JournalCategory; workStatus: WorkStatus | null; tags: string[]; aiModel: string | null;
  children: Array<{ threadId: string; title: string; summary: string; outcome: string | null }>;
  activeMs: number | null; turnCount: number | null; blockCount: number | null;
}
interface ReplayPeriod {
  start: number; end: number; activeThreads: number; workDays: number; messages: number;
  started: number; archived: number; restored: number; projects: Array<{ name: string; count: number }>;
  categories: Array<{ name: string; count: number }>; entries: ActivityEntry[]; total: number; narrative: string | null;
}

const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function readStored<T extends string | number>(key: string, options: readonly T[], fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return options.find((option) => String(option) === raw) ?? fallback;
  } catch {
    // Storage can be unavailable (private browsing, blocked cookies).
    return fallback;
  }
}
function useStored<T extends string | number>(key: string, options: readonly T[], fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState(() => readStored(key, options, fallback));
  const update = useCallback((next: T) => {
    setValue(next);
    try { window.localStorage.setItem(key, String(next)); } catch { /* Best effort only. */ }
  }, [key]);
  return [value, update];
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), intervalMs); return () => window.clearInterval(timer); }, [intervalMs]);
  return now;
}

/**
 * Responses by scope and key, kept across views and ranges so going back to
 * one is instant. A change marks a scope stale: stale entries still show at
 * once and refetch behind the scenes.
 */
const CACHE_LIMIT = 48;
const PREFETCH_IDLE_MS = 400;
const responseCache = new Map<string, { data: unknown; stale: boolean; request: number }>();
const pendingLoads = new Map<string, { request: number; task: Promise<unknown> }>();
let lastRequest = 0;
function loadShared<T>(cacheKey: string, load: () => Promise<T>, force: boolean): Promise<T> {
  const pending = pendingLoads.get(cacheKey);
  // A forced load starts over: a request already under way may predate the change.
  if (pending && !force) return pending.task as Promise<T>;
  const request = ++lastRequest;
  const task = load().then((data) => {
    // A slower, older request never replaces a newer answer.
    if ((responseCache.get(cacheKey)?.request ?? 0) < request) {
      responseCache.delete(cacheKey); responseCache.set(cacheKey, { data, stale: false, request });
      if (responseCache.size > CACHE_LIMIT) responseCache.delete(responseCache.keys().next().value!);
    }
    return data;
  }).finally(() => { if (pendingLoads.get(cacheKey)?.request === request) pendingLoads.delete(cacheKey); });
  pendingLoads.set(cacheKey, { request, task }); return task;
}
/** Loads in the background unless the answer is cached or on its way. */
function prefetch(scope: string, key: string, load: () => Promise<unknown>) {
  const cacheKey = `${scope}|${key}`;
  if (!responseCache.has(cacheKey) && !pendingLoads.has(cacheKey)) loadShared(cacheKey, load, false).catch(() => {});
}

/**
 * Data for one key. A cached key shows at once. An unseen key keeps showing the
 * last data, marked stale, until its own response lands, so switching never
 * flashes a skeleton. Realtime signals are not replayed, so it refetches after a reconnect.
 */
function useSnapshot<T>(scope: string, key: string | null, load: () => Promise<T>) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const shown = useRef<{ key: string; data: T } | null>(null);
  const currentKey = useRef(key); currentKey.current = key;
  const latestLoad = useRef(load); latestLoad.current = load;
  const fetchKey = useCallback((force: boolean) => {
    if (key === null) return;
    const entry = responseCache.get(`${scope}|${key}`);
    if (!force && entry && !entry.stale) return;
    loadShared(`${scope}|${key}`, latestLoad.current, force).then(() => {
      if (currentKey.current === key) { setError(null); rerender(); }
    }, (cause: unknown) => { if (currentKey.current === key) setError({ key, message: errorMessage(cause) }); });
  }, [scope, key]);
  useEffect(() => fetchKey(false), [fetchKey]);
  /** Marks every key in the scope stale and refetches this one. */
  const refresh = useCallback(() => {
    for (const [cacheKey, entry] of responseCache) if (cacheKey.startsWith(`${scope}|`)) entry.stale = true;
    fetchKey(true);
  }, [scope, fetchKey]);
  const connection = useRealtimeConnectionState();
  const connectedBefore = useRef(false);
  useEffect(() => {
    if (connection !== "connected") return;
    if (connectedBefore.current) refresh();
    connectedBefore.current = true;
  }, [connection, refresh]);
  const entry = key === null ? undefined : responseCache.get(`${scope}|${key}`);
  if (key !== null && entry) shown.current = { key, data: entry.data as T };
  return { data: shown.current?.data ?? null, isStale: shown.current !== null && shown.current.key !== key, error: error?.key === key ? error.message : null, refresh };
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => { const timer = window.setTimeout(() => setSettled(value), delayMs); return () => window.clearTimeout(timer); }, [value, delayMs]);
  return settled;
}

// One enrichment can land several journal-changed signals within a moment
// (thread entry, then narrative); coalesce them into one refetch.
function useDebouncedRealtime(channel: string, handler: () => void) {
  const latest = useRef(handler); latest.current = handler;
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useRealtime(channel, useCallback(() => {
    window.clearTimeout(timer.current); timer.current = window.setTimeout(() => latest.current(), REALTIME_REFETCH_DELAY_MS);
  }, []));
}

function PanelHeader() {
  const rpc = useRpc<typeof rpcContract>(); const [syncing, setSyncing] = useState(false);
  return <Button size="sm" variant="outline" className="size-8 px-0 sm:h-8 sm:w-auto sm:px-3" disabled={syncing} onClick={() => {
    setSyncing(true); rpc.call("journal_sync").then((result) => toast.success(`Synced ${result.threads} threads`), (error: unknown) => toast.error(error instanceof Error ? error.message : String(error))).finally(() => setSyncing(false));
  }} aria-label="Sync journal"><Icon name="ArrowReloadHorizontal" className={syncing ? "size-4 animate-spin" : "size-4"} /><span className="hidden sm:inline">{syncing ? "Syncing…" : "Sync"}</span></Button>;
}

// "What": the range, grouping, color and filters sit on top and apply to every view.
// "How": the views below only change the presentation.
const VIEWS = ["calendar", "timesheet", "activity", "traces"] as const;
type View = typeof VIEWS[number];
const RANGES = ["day", "3days", "week", "all"] as const;
type RangeKind = typeof RANGES[number];
const RANGE_DAYS: Record<Exclude<RangeKind, "all">, number> = { day: 1, "3days": 3, week: 7 };
const rangeTitleFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const dayTitleFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
// One tab row used to mix ranges and views; carry a saved choice over.
const LEGACY_VIEW_KEY = "journal.calendar.view";
const LEGACY_VIEWS: Record<string, [View, RangeKind]> = {
  day: ["calendar", "day"], "3days": ["calendar", "3days"], week: ["calendar", "week"], timesheet: ["timesheet", "week"], all: ["activity", "all"], activity: ["traces", "day"],
};
function legacyChoice(): [View, RangeKind] | undefined {
  try { return LEGACY_VIEWS[window.localStorage.getItem(LEGACY_VIEW_KEY) ?? ""]; } catch { return undefined; }
}

/** The viewer-local range: 3 days ends on the selected day, a week starts on Monday. All time reads the selected week for colors. */
function calendarRange(kind: RangeKind, day: number) {
  if (kind === "day") return { from: day, to: addDays(day, 1) };
  if (kind === "3days") return { from: addDays(day, -2), to: addDays(day, 1) };
  const from = startOfWeek(day); return { from, to: addDays(from, 7) };
}

// The work zone keys the Activity request; remembering it saves a second fetch on open.
const ZONE_KEY = "journal.workTimeZone";
let knownProjects: Array<{ id: string; name: string; count: number }> = [];
function readZone() {
  try { return window.localStorage.getItem(ZONE_KEY) ?? DEFAULT_WORK_TIME_ZONE; } catch { return DEFAULT_WORK_TIME_ZONE; }
}

function JournalPanel() {
  const rpc = useRpc<typeof rpcContract>(); const navigate = useBbNavigate();
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const threadOpener = useRef<HTMLElement | null>(null);
  const openThread = useCallback((threadId: string) => {
    threadOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpenThreadId(threadId);
  }, []);
  const portalScope = usePortalScopeProps();
  const [timeZone, setTimeZone] = useState(readZone);
  const legacy = useMemo(legacyChoice, []);
  const [view, setView] = useStored<View>("journal.view", VIEWS, legacy?.[0] ?? "calendar");
  const [storedRange, setRange] = useStored<RangeKind>("journal.range", RANGES, legacy?.[1] ?? "day");
  const [gap, setGap] = useStored<MergeGapMinutes>("journal.calendar.gap", MERGE_GAP_MINUTES, DEFAULT_MERGE_GAP_MINUTES);
  const [grouping, setGrouping] = useStored<Grouping>("journal.calendar.grouping", ["thread", "project"], "thread");
  const [colorMode, setColorMode] = useStored<ColorMode>("journal.calendar.color", ["project", "work"], "project");
  const [day, setDay] = useState(() => startOfDay(Date.now()));
  const [projects, setProjects] = useState(knownProjects);
  const [query, setQuery] = useState(""); const [category, setCategory] = useState<JournalCategory | "all">("all"); const [projectId, setProjectId] = useState("all");
  const now = useNow(30_000);
  const refreshContext = useCallback(() => {
    rpc.call("journal_intelligence_status", null).then((status) => {
      setTimeZone(status.workTimeZone);
      try { window.localStorage.setItem(ZONE_KEY, status.workTimeZone); } catch { /* Best effort only. */ }
    }, () => {});
    rpc.call("journal_list", { query: "", category: null, projectId: null, eventType: null, includeChildren: false, limit: 1, offset: 0 })
      .then((list) => { knownProjects = list.projects; setProjects(list.projects); }, () => {});
  }, [rpc]);
  useEffect(refreshContext, [refreshContext]); useDebouncedRealtime("journal-changed", refreshContext);
  useRealtime(PREFERENCES_CHANGED, refreshContext);

  // Only Activity reaches back to all time; the time views need a bounded range.
  const rangeKind: RangeKind = storedRange === "all" && view !== "activity" ? "week" : storedRange;
  const chooseView = (next: View) => { setView(next); if (next !== "activity" && storedRange === "all") setRange("week"); };
  const range = useMemo(() => calendarRange(rangeKind, day), [rangeKind, day]);
  const loadCalendar = useCallback((from: number, to: number, mergeGapMinutes: MergeGapMinutes) => () =>
    rpc.call("journal_calendar", { from, to, mergeGapMinutes }).then((wire): CalendarActivity => unpackCalendar(wire)), [rpc]);
  const loadTraces = useCallback((from: number, to: number) => () => rpc.call("journal_traces", { from, to }), [rpc]);
  // Every view needs the calendar: its blocks, or at least the project colors.
  const calendar = useSnapshot("calendar", `${range.from}:${range.to}:${gap}`, loadCalendar(range.from, range.to, gap));
  useRealtime(CHANGE_CHANNEL, calendar.refresh);
  // Running blocks grow with the clock.
  useEffect(() => {
    if (rangeKind === "all" || Date.now() >= range.to) return;
    const timer = window.setInterval(calendar.refresh, 60_000); return () => window.clearInterval(timer);
  }, [rangeKind, range.to, calendar.refresh]);

  const traces = useSnapshot("traces", view === "traces" ? `${range.from}:${range.to}` : null, loadTraces(range.from, range.to));
  useDebouncedRealtime("journal-feed", traces.refresh);

  // Activity covers the work days the range touches. Typing settles before it refetches.
  const replayQuery = useDebounced(query, 200);
  const replayInputFor = useCallback((kind: RangeKind, from: number, to: number) => {
    const filters = { query: replayQuery, category: category === "all" ? null : category, projectId: projectId === "all" ? null : projectId, limit: 1_000, offset: 0 };
    if (kind === "all") return { ...filters, start: 0, end: addWorkDays(localDayStart(Date.now(), timeZone), 1, timeZone), mode: "all" as const, narrative: true };
    const start = localDayStart(from, timeZone); const end = addWorkDays(localDayStart(to - 1, timeZone), 1, timeZone);
    return { ...filters, start, end, mode: kind === "day" ? "day" as const : "week" as const, narrative: kind !== "3days" };
  }, [replayQuery, category, projectId, timeZone]);
  const replayInput = view === "activity" ? replayInputFor(rangeKind, range.from, range.to) : null;
  const replay = useSnapshot("replay", replayInput && JSON.stringify(replayInput), () => rpc.call("journal_replay", replayInput!));
  useDebouncedRealtime("journal-changed", replay.refresh);

  /** Starts loading what a view needs for a range, so the click that follows lands on cached data. */
  const prefetchView = (target: View, kind: RangeKind, targetDay: number, targetGap = gap) => {
    const next = calendarRange(kind === "all" && target !== "activity" ? "week" : kind, targetDay);
    if (next.from > Date.now()) return;
    prefetch("calendar", `${next.from}:${next.to}:${targetGap}`, loadCalendar(next.from, next.to, targetGap));
    if (target === "traces") prefetch("traces", `${next.from}:${next.to}`, loadTraces(next.from, next.to));
    // Activity can start an AI narrative, so it only loads on a hover, never while idle.
    if (target === "activity") {
      const input = replayInputFor(kind, next.from, next.to);
      prefetch("replay", JSON.stringify(input), () => rpc.call("journal_replay", input));
    }
  };
  const latestPrefetch = useRef(prefetchView); latestPrefetch.current = prefetchView;
  // Once the shown range has loaded, warm the ranges either side and the Traces spans.
  const settled = calendar.data !== null && !calendar.isStale;
  useEffect(() => {
    if (!settled || rangeKind === "all") return;
    const timer = window.setTimeout(() => {
      const prefetchIdle = latestPrefetch.current; const step = RANGE_DAYS[rangeKind];
      prefetchIdle("calendar", rangeKind, addDays(day, -step)); prefetchIdle("calendar", rangeKind, addDays(day, step));
      prefetch("traces", `${range.from}:${range.to}`, loadTraces(range.from, range.to));
    }, PREFETCH_IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [settled, rangeKind, day, range, loadTraces]);

  const colors = useColors(calendar.data);
  const filters = useMemo<CalendarFilters>(() => ({ query, category, projectId }), [query, category, projectId]);
  const visible = useMemo(() => calendar.data && filterActivity(calendar.data, filters), [calendar.data, filters]);
  const setWorkCategory = (threadId: string, next: JournalCategory) => {
    rpc.call("journal_set_category", { threadId, category: next }).then(() => { calendar.refresh(); replay.refresh(); }, (cause: unknown) => toast.error(errorMessage(cause)));
  };
  // Calls arrive with the calendar only while "Show Dispatch calls" is on; a click shows its new state until the refetch lands.
  const [callsPending, setCallsPending] = useState<boolean | null>(null);
  useEffect(() => setCallsPending(null), [calendar.data]);
  const showCalls = callsPending ?? calendar.data?.calls !== undefined;
  const toggleCalls = () => {
    const enabled = !showCalls; setCallsPending(enabled);
    rpc.call("journal_set_show_calls", { enabled }).then(() => calendar.refresh(), (cause: unknown) => { setCallsPending(null); toast.error(errorMessage(cause)); });
  };
  const dayCount = rangeKind === "all" ? 7 : RANGE_DAYS[rangeKind];
  const selectDay = (dayStart: number) => { setDay(dayStart); setRange("day"); chooseView("calendar"); };
  const rangeTitle = rangeKind === "all" ? "Every recorded work day" : rangeKind === "day" ? dayTitleFormat.format(range.from) : rangeTitleFormat.formatRange(range.from, range.to - 1);
  const active = view === "activity" ? replay : view === "traces" ? traces : calendar;
  const timeViewReady = visible !== null && (view !== "traces" || traces.data !== null);

  // Vertical padding sits inside the scroller, so sticky headers stick flush to its top.
  // The calendar and time sheet need a wider canvas for day columns. Text views match Settings.
  return <div className="journal-panel min-h-0 flex-1 overflow-y-auto"><div className={`mx-auto w-full space-y-4 px-4 py-4 ${view === "calendar" || view === "timesheet" ? "max-w-7xl" : "max-w-[760px]"}`}>
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Range" value={rangeKind} onChange={setRange} onHover={(kind) => prefetchView(view, kind, day)}
          options={RANGES.filter((kind) => kind !== "all" || view === "activity").map((kind) => ({ value: kind, label: rangeLabels[kind] }))} />
        {rangeKind !== "all" ? <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" className="h-8" onPointerEnter={() => prefetchView(view, rangeKind, startOfDay(Date.now()))} onClick={() => setDay(startOfDay(Date.now()))}>Today</Button>
          <Button size="sm" variant="ghost" className="size-8 px-0" onPointerEnter={() => prefetchView(view, rangeKind, addDays(day, -dayCount))} onClick={() => setDay(addDays(day, -dayCount))} aria-label="Earlier"><Icon name="ArrowLeft" className="size-4" /></Button>
          <Button size="sm" variant="ghost" className="size-8 px-0" onPointerEnter={() => prefetchView(view, rangeKind, addDays(day, dayCount))} onClick={() => setDay(addDays(day, dayCount))} aria-label="Later"><Icon name="ArrowRight" className="size-4" /></Button>
        </div> : null}
        <h2 className="ml-1 text-sm font-semibold tabular-nums">{rangeTitle}</h2>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Segmented label="Group by" value={grouping} onChange={setGrouping} options={[{ value: "thread", label: "Threads" }, { value: "project", label: "Projects" }]} />
          <Segmented label="Color" title="Color by project or by work type" value={colorMode} onChange={setColorMode} options={[{ value: "project", label: "Project" }, { value: "work", label: "Work type" }]} />
        </div>
      </div>
      <div className="journal-filters flex flex-wrap gap-2"><div className="relative min-w-0 basis-full flex-1"><Icon name="Search" className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input aria-label="Search threads and summaries" className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search threads and summaries" /></div>
        <FilterSelect label="Project" value={projectId} onChange={setProjectId} items={[{ value: "all", label: "All projects" }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} />
        <FilterSelect label="Work type" value={category} onChange={(value) => setCategory(value as JournalCategory | "all")} items={[{ value: "all", label: "All work types" }, ...CATEGORIES.map((value) => ({ value, label: categoryLabels[value] }))]} /></div>
    </section>
    <div className="flex min-h-9 flex-wrap items-center gap-3">
      <Tabs value={view} onValueChange={(value) => chooseView(value as View)}><TabsList className="h-auto gap-4 rounded-none bg-transparent p-0">
        {VIEWS.map((value) => <TabsTrigger key={value} value={value} onPointerEnter={() => prefetchView(value, value !== "activity" && storedRange === "all" ? "week" : storedRange, day)} className="rounded-none border-b-2 border-transparent px-0.5 pb-1.5 pt-1 data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none">{viewLabels[value]}</TabsTrigger>)}
      </TabsList></Tabs>
      <div className="ml-auto flex items-center gap-2">
        {active.isStale ? <span className="text-xs text-muted-foreground">Loading…</span> : null}
        {view === "calendar" || view === "traces" ? <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2.5" aria-pressed={showCalls} aria-label="Show Dispatch calls" onClick={toggleCalls}>
          <Icon name="Call" />Calls</Button> : null}
        {view === "calendar" || view === "timesheet" ? <Segmented label="Merge gap" title="Merge agent turns separated by at most this many idle minutes. Blocks round out to quarter hours; child threads and side chats count toward their root thread." value={gap} onChange={setGap}
          onHover={(next) => prefetchView(view, rangeKind, day, next)}
          options={MERGE_GAP_MINUTES.map((minutes) => ({ value: minutes, label: minutes < 60 ? `${minutes}m` : `${minutes / 60}h` }))} /> : null}
      </div>
    </div>
    {view === "activity" ? <ActivityCard mode={rangeKind === "all" ? "all" : rangeKind === "day" ? "day" : "week"} period={replay.data} stale={replay.isStale} error={replay.error}
      grouping={grouping} colorMode={colorMode} colors={colors} timeZone={timeZone} onOpenThread={openThread} onSetCategory={setWorkCategory} />
      : (active.error && !active.data) ? <CalendarEmpty>{active.error}</CalendarEmpty>
      : !timeViewReady ? <Skeleton className="h-[32rem] w-full" />
      : <div className={`space-y-3 transition-opacity ${active.isStale ? "opacity-60" : ""}`}>
        {view === "calendar" ? <>
          <CalendarView activity={visible} grouping={grouping} gap={gap} colorMode={colorMode} colors={colors}
            rangeStart={range.from} dayCount={dayCount} now={now} onOpen={openThread} onSelectDay={selectDay} onSetCategory={setWorkCategory} />
          <CalendarLegend activity={visible} colorMode={colorMode} colors={colors} />
        </> : view === "timesheet" ? <>
          <CalendarStats activity={visible} />
          <TimesheetView activity={visible} rangeStart={range.from} dayCount={dayCount} grouping={grouping} colorMode={colorMode} colors={colors}
            now={now} onOpen={openThread} onSelectDay={selectDay} />
        </>
        : <TracesView activity={visible} events={traces.data?.events ?? []} grouping={grouping} colorMode={colorMode} colors={colors} multiDay={dayCount > 1} now={now} onOpen={openThread} />}
      </div>}
  </div>
    <Dialog.Root open={openThreadId !== null} onOpenChange={(open) => { if (!open) setOpenThreadId(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay {...portalScope} className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px]" />
        <Dialog.Content {...portalScope} onCloseAutoFocus={(event) => { if (threadOpener.current?.isConnected) { event.preventDefault(); threadOpener.current.focus(); } }} className="journal-dialog fixed left-1/2 top-1/2 z-50 flex h-[min(88dvh,60rem)] w-[min(96vw,39rem)] flex-col overflow-hidden rounded-md border border-border bg-background shadow-2xl">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
            <Dialog.Title className="min-w-0 flex-1 truncate text-sm font-medium">{openThreadId ? <ThreadTitle threadId={openThreadId} /> : "Chat"}</Dialog.Title>
            <Dialog.Description className="sr-only">Chat preview. Close to return to the journal.</Dialog.Description>
            <Button size="icon" variant="ghost" aria-label="Open full thread" onClick={() => { if (openThreadId) { navigate.toThread(openThreadId); setOpenThreadId(null); } }}><Icon name="ArrowRight" className="size-4" /></Button>
            <Dialog.Close asChild><Button size="icon" variant="ghost" aria-label="Close chat"><span aria-hidden="true" className="text-lg">×</span></Button></Dialog.Close>
          </header>
          <div className="min-h-0 flex-1">{openThreadId ? <ThreadChat key={openThreadId} threadId={openThreadId} variant="compact" layout="contained" /> : null}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div>;
}
const rangeLabels: Record<RangeKind, string> = { day: "Day", "3days": "3 days", week: "Week", all: "All time" };
const viewLabels: Record<View, string> = { calendar: "Calendar", timesheet: "Time sheet", activity: "Activity", traces: "Traces" };

/** The enriched view: what the work was, one entry per thread and work day. */
function ActivityCard(props: {
  mode: ReplayMode; period: ReplayPeriod | null; stale: boolean; error: string | null; grouping: Grouping; colorMode: ColorMode; colors: ReturnType<typeof useColors>;
  timeZone: string; onOpenThread: (id: string) => void; onSetCategory: (id: string, category: JournalCategory) => void;
}) {
  const period = props.period;
  if (props.error && !period) return <CalendarEmpty>{props.error}</CalendarEmpty>;
  if (period === null) return <section className="rounded-md border border-border bg-surface-recessed/70"><ReplaySkeleton /></section>;
  const colorOf = (entry: ActivityEntry) => props.colorMode === "work" ? props.colors.categoryColor(entry.category) : props.colors.projects.get(entry.projectId)?.color ?? OTHER_COLOR;
  return <section className={`overflow-hidden rounded-md border border-border bg-surface-recessed/70 transition-opacity ${props.stale ? "opacity-60" : ""}`}>
    <div className="space-y-2 border-b border-border p-3">
      <p className="text-sm leading-6 text-foreground">{period.narrative ?? fallbackNarrative(period)}</p>
      {period.narrative ? <p className="text-xs text-muted-foreground">{period.activeThreads} active threads · {period.workDays} work entries · {period.messages} messages · {period.started} created · {period.archived} archived</p> : null}
    </div>
    <ActivityList mode={props.mode} grouping={props.grouping} entries={period.entries} total={period.total} timeZone={props.timeZone} colorOf={colorOf}
      projectColor={(id) => props.colors.projects.get(id)?.color ?? OTHER_COLOR} onOpenThread={props.onOpenThread} onSetCategory={props.onSetCategory} />
  </section>;
}

function ActivityList({ mode, grouping, entries, total, timeZone, colorOf, projectColor, onOpenThread, onSetCategory }: {
  mode: ReplayMode; grouping: Grouping; entries: ActivityEntry[]; total: number; timeZone: string; colorOf: (entry: ActivityEntry) => string; projectColor: (projectId: string) => string;
  onOpenThread: (id: string) => void; onSetCategory: (id: string, category: JournalCategory) => void;
}) {
  const revealed = useRevealed(entries.length, 25);
  if (entries.length === 0) return <EmptyState message="No work matches this range and these filters." />;
  // Days stay in order; by project, each day's entries gather under their project.
  const days: Array<{ dayStart: number; groups: Array<{ projectId: string; projectName: string; entries: ActivityEntry[] }> }> = [];
  for (const entry of entries.slice(0, revealed)) {
    let dayGroup = days[days.length - 1];
    if (dayGroup?.dayStart !== entry.dayStart) { dayGroup = { dayStart: entry.dayStart, groups: [] }; days.push(dayGroup); }
    const key = grouping === "project" ? entry.projectId : "";
    let group = dayGroup.groups.find((item) => item.projectId === key);
    if (!group) { group = { projectId: key, projectName: entry.projectName, entries: [] }; dayGroup.groups.push(group); }
    group.entries.push(entry);
  }
  return <div>{days.map((dayGroup) => <div key={dayGroup.dayStart}>
    {mode !== "day" ? <div className="border-b border-border bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground">{new Date(dayGroup.dayStart).toLocaleDateString([], { timeZone, weekday: "long", month: "long", day: "numeric", year: mode === "all" ? "numeric" : undefined })}</div> : null}
    {dayGroup.groups.map((group) => <div key={group.projectId}>
      {grouping === "project" ? <div className="flex items-center gap-2 border-b border-border px-4 py-1.5 text-xs font-medium"><Swatch color={projectColor(group.projectId)} />{group.projectName} · {group.entries.length}</div> : null}
      <ul>{group.entries.map((entry) => <li key={`${entry.threadId}:${entry.dayStart}`} className="border-b border-border px-4 py-3 last:border-b-0">
        <div className="journal-entry flex items-start gap-3"><span className="mt-1.5"><Swatch color={colorOf(entry)} /></span>
          <button className="min-w-0 flex-1 text-left" onClick={() => onOpenThread(entry.threadId)}><span className="block text-sm font-medium hover:underline">{entry.summary}</span>{entry.outcome && entry.outcome !== entry.summary ? <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{entry.outcome}</span> : null}<span className="mt-1 block text-xs text-muted-foreground">{grouping === "project" ? "" : `${entry.projectName} · `}{entry.messageCount} messages{entry.activeMs ? ` · ${formatDuration(entry.activeMs) || "<1m"} agent time` : ""}</span></button>
          <Select value={entry.category} onValueChange={(value) => { if (CATEGORIES.includes(value as JournalCategory)) onSetCategory(entry.threadId, value as JournalCategory); }}>
            <SelectTrigger aria-label="Work type" className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{CATEGORIES.map((value) => <SelectItem key={value} value={value} className="text-xs">{categoryLabels[value]}</SelectItem>)}</SelectContent></Select></div>
        <ChildThreads items={entry.children} onOpenThread={onOpenThread} /></li>)}</ul>
    </div>)}
  </div>)}{total > entries.length ? <p className="p-3 text-center text-xs text-muted-foreground">Showing {entries.length} of {total} entries.</p> : null}</div>;
}

function ChildThreads({ items, onOpenThread }: { items: ActivityEntry["children"]; onOpenThread: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return <div className="mt-2 pl-4"><button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
    <Icon name="ChevronDown" className={`size-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />{items.length} child {items.length === 1 ? "thread" : "threads"}</button>
    {open ? items.map((child) => <button key={child.threadId} className="mt-1.5 block max-w-full truncate pl-4 text-left text-xs text-muted-foreground hover:underline" onClick={() => onOpenThread(child.threadId)}>
      ↳ {child.title}{child.outcome ? ` · ${child.outcome}` : ""}
    </button>) : null}</div>;
}

function FilterSelect({ label, value, onChange, items }: { label: string; value: string; onChange: (value: string) => void; items: Array<{ value: string; label: string }> }) {
  return <Select value={value} onValueChange={(next) => { if (items.some((item) => item.value === next)) onChange(next); }}><SelectTrigger aria-label={label} className="min-w-0 flex-1 basis-0"><SelectValue /></SelectTrigger>
    <SelectContent>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select>;
}
function fallbackNarrative(period: ReplayPeriod) { return period.activeThreads === 0 ? "No work activity was recorded in this period." : `${period.activeThreads} active ${period.activeThreads === 1 ? "thread" : "threads"} across ${period.projects.length} ${period.projects.length === 1 ? "project" : "projects"}. ${period.started} started and ${period.archived} archived.`; }
function EmptyState({ message }: { message: string }) { return <div className="flex items-center justify-center px-6 py-12 text-center"><p className="max-w-md text-sm text-muted-foreground">{message}</p></div>; }
function ReplaySkeleton() { return <div className="space-y-4 p-4"><Skeleton className="h-4 w-4/5" /><Skeleton className="h-8 w-2/3" /><Skeleton className="h-10 w-full" /><Skeleton className="h-72 w-full" /></div>; }

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "preferences", component: PreferencesSettings });
  app.slots.settingsSection({ id: "more", component: MoreSettings });
  app.slots.settingsSection({ id: "oh-my-bb", component: IntegrationSettings });
  app.experimental_sidebarFooter.register({
    kind: "action",
    id: "catch-up",
    label: "Catch me up",
    icon: "journal/journal",
    onActivate: () => { window.dispatchEvent(new Event("journal:open-catch-up")); },
  });
  app.slots.experimental_appOverlay({ id: "catch-up", component: CatchUpOverlay });
  app.slots.experimental_threadHeaderAction({ id: "thread-brief", title: "Journal briefing", component: ThreadBriefAction });
  app.slots.navPanel({ id: "journal", title: "Journal", icon: "journal/journal", path: "journal", component: ({ subPath }) => subPath === "setup" ? <JournalSetup /> : <JournalPanel />, headerContent: PanelHeader });
});
