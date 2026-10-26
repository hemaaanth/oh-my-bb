// Pure helpers for the Dev group: units, benchmarks, coverage, versions, findings, logs, pipelines, traces, treemaps, waterfalls.

export const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
export const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : undefined;
export const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const items = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
// eslint-disable-next-line no-control-regex
export const stripAnsi = (line: string) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/gu, "");

// Ported from GenUI core/perf-units.ts (Apache-2.0).
const TIME: Record<string, number> = { ns: 1e-9, us: 1e-6, "µs": 1e-6, ms: 1e-3, s: 1, sec: 1, m: 60, min: 60, h: 3600 };
const BYTES: Record<string, number> = { b: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, gib: 1024 ** 3 };
type UnitKind = "time" | "bytes" | "rate" | "percent" | "count";

export function unitInfo(unit: string | null | undefined): { kind: UnitKind; factor: number; label: string } {
  const raw = (unit ?? "").trim(), lower = raw.toLowerCase();
  if (raw === "%") return { kind: "percent", factor: 1, label: "%" };
  if (Object.hasOwn(TIME, lower) && raw !== "M") return { kind: "time", factor: TIME[lower], label: raw };
  if (Object.hasOwn(BYTES, lower)) return { kind: "bytes", factor: BYTES[lower], label: raw };
  if (/\/s$|^ops|^hz$|^[rq]ps$/iu.test(raw)) return { kind: "rate", factor: 1, label: /^hz$/iu.test(raw) ? "ops/s" : raw };
  return { kind: "count", factor: 1, label: raw };
}

/** `value` to `digits` significant digits, grouped: 12,345 · 18.4 · 0.000123. */
export function significant(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const decimals = Math.min(6, Math.max(0, digits - 1 - Math.floor(Math.log10(Math.abs(value)))));
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: decimals }).format(Number(value.toFixed(decimals)));
}

const scale = (size: number, steps: [number, number, string][]): [number, string] => { const found = steps.find(([below]) => Math.abs(size) < below) ?? steps[steps.length - 1]; return [found[1], found[2]]; };
const TIME_STEPS: [number, number, string][] = [[1e-6, 1e-9, "ns"], [1e-3, 1e-6, "µs"], [1, 1e-3, "ms"], [120, 1, "s"], [7200, 60, "min"], [Infinity, 3600, "h"]];
const BYTE_STEPS: [number, number, string][] = [[1024, 1, "B"], [1024 ** 2, 1024, "KB"], [1024 ** 3, 1024 ** 2, "MB"], [1024 ** 4, 1024 ** 3, "GB"], [Infinity, 1024 ** 4, "TB"]];
const COUNT_STEPS: [number, number, string][] = [[1e4, 1, ""], [1e6, 1e3, "K"], [1e9, 1e6, "M"], [Infinity, 1e9, "B"]];

/** `value` in `unit` as a person reads it: 0.0277 ms → "27.7 µs", 349438 B → "341 KB", 36074 ops/s → "36.1K ops/s". */
export function formatAmount(value: number, unit?: string | null, digits = 3): string {
  if (!Number.isFinite(value)) return "—";
  const info = unitInfo(unit);
  const amount = value * info.factor;
  if (info.kind === "time") { const [divisor, label] = value === 0 ? [1e-3, "ms"] as [number, string] : scale(amount, TIME_STEPS); return `${significant(amount / divisor, digits)} ${label}`; }
  if (info.kind === "bytes") { const [divisor, label] = scale(amount, BYTE_STEPS); return `${label === "B" ? significant(Math.round(amount), 4) : significant(amount / divisor, digits)} ${label}`; }
  if (info.kind === "rate") { const [divisor, suffix] = scale(value, COUNT_STEPS); return `${significant(value / divisor, digits)}${suffix} ${info.label}`; }
  if (info.kind === "percent") return `${significant(value, digits)}%`;
  if (/^[$€£¥]$/u.test(info.label)) return `${value < 0 ? "-" : ""}${info.label}${significant(Math.abs(value), digits)}`;
  return info.label ? `${significant(value, digits)} ${info.label}` : significant(value, digits);
}

/** Ticks from `min` to past `max` at a 1, 2 or 5 × 10ⁿ step. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (max <= min) max = min + (min === 0 ? 1 : Math.abs(min));
  const raw = (max - min) / count, power = 10 ** Math.floor(Math.log10(raw)), fraction = raw / power;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
  const ticks: number[] = [];
  for (let tick = Math.floor(min / step + 1e-9) * step; ticks.length < 50; tick += step) {
    ticks.push(Number(tick.toPrecision(12)));
    if (tick >= max - step * 1e-9) break;
  }
  return ticks;
}

// Ported from GenUI core/benchmark.ts (Apache-2.0).
export const NOISE_PERCENT = 1;
export type Verdict = "better" | "worse" | "same";
export type BenchRow = { name: string; before: number | null; after: number; unit: string; better: "lower" | "higher"; noise: number | null };

export function verdictOf(before: number, after: number, better: "lower" | "higher", noise: number | null): Verdict {
  const delta = after - before;
  if (delta === 0 || (before !== 0 && Math.abs(delta / before) * 100 < NOISE_PERCENT) || (noise !== null && Math.abs(delta) <= noise)) return "same";
  return (delta < 0) === (better === "lower") ? "better" : "worse";
}

export function verdictWords(rows: readonly BenchRow[]): { better: string; worse: string } {
  const kinds = new Set(rows.map((row) => `${unitInfo(row.unit).kind}:${row.better}`));
  const only = kinds.size === 1 ? [...kinds][0] : "";
  return only === "time:lower" || only === "rate:higher" ? { better: "faster", worse: "slower" } : only === "bytes:lower" ? { better: "smaller", worse: "larger" } : { better: "better", worse: "worse" };
}

/** Rows from [{name, before?, after | value | mean, unit?, better?, noise?}] or hyperfine's `--export-json` ({results: [{command, mean, stddev}]}, in seconds). */
export function readBenchmark(input: unknown, unit?: string): BenchRow[] {
  const hyperfine = record(input)?.results;
  if (Array.isArray(hyperfine)) return items(hyperfine).flatMap((run) => {
    const name = text(run.command) ?? text(run.name), mean = number(run.mean);
    return name && mean !== undefined ? [{ name, before: null, after: mean, unit: "s", better: "lower" as const, noise: number(run.stddev) ?? null }] : [];
  });
  return items(input).flatMap((row) => {
    const name = text(row.name) ?? text(row.label), after = number(row.after) ?? number(row.value) ?? number(row.mean) ?? number(row.hz);
    if (!name || after === undefined) return [];
    const rowUnit = text(row.unit) ?? (row.hz !== undefined && row.after === undefined && row.value === undefined && row.mean === undefined ? "ops/s" : unit ?? "");
    const kind = unitInfo(rowUnit).kind;
    const better = row.better === "higher" || row.better === "lower" ? row.better : kind === "rate" || /fps|throughput|ops|score|accuracy|hit|speed/iu.test(`${name} ${rowUnit}`) ? "higher" : "lower";
    return [{ name, before: number(row.before) ?? number(row.baseline) ?? null, after, unit: rowUnit, better, noise: number(row.noise) ?? number(row.stddev) ?? null }];
  });
}

// Ported from GenUI core/coverage.ts (Apache-2.0).
export const coverageTone = (pct: number) => pct >= 80 ? "good" : pct >= 60 ? "warn" : "bad";

/** Never 100% while a line is missed, never 0% while one is covered. */
export function formatPercent(covered: number, total: number): string {
  if (total <= 0) return "—";
  const pct = (covered / total) * 100;
  if (covered < total && pct >= 99.95) return "99.9%";
  if (covered > 0 && pct < 0.05) return "<0.1%";
  return `${pct.toFixed(pct === 100 || pct === 0 ? 0 : 1)}%`;
}

export type CoverageRow = { path: string; covered: number; total: number; pct: number };
const metric = (value: unknown): { covered: number; total: number } | null => {
  const item = record(value);
  if (!item) return null;
  const covered = number(item.covered) ?? number(item.hit), total = number(item.total) ?? number(item.found);
  if (covered !== undefined && total !== undefined) return { covered, total };
  const pct = number(item.pct);
  return pct !== undefined ? { covered: pct, total: 100 } : null;
};
export const coverageRow = (path: string, value: unknown, kind: string): CoverageRow | null => {
  const item = record(value);
  const pick = metric(item?.[kind]) ?? metric(item?.lines) ?? metric(item?.statements) ?? metric(item);
  return pick ? { path, ...pick, pct: pick.total > 0 ? (pick.covered / pick.total) * 100 : 100 } : null;
};

/** Total and per-file coverage from Istanbul's coverage-summary.json or [{path, covered, total} | {path, pct}]. Lowest first; shared path prefix cut. */
export function readCoverage(input: unknown, kind = "lines"): { total: CoverageRow | null; files: CoverageRow[] } {
  const summary = record(input);
  const rows = Array.isArray(input) ? items(input).flatMap((item) => { const path = text(item.path) ?? text(item.file) ?? text(item.name); const row = path ? coverageRow(path, item, kind) : null; return row ? [row] : []; })
    : summary ? Object.entries(summary).flatMap(([path, value]) => { const row = path !== "total" ? coverageRow(path, value, kind) : null; return row ? [row] : []; }) : [];
  const given = summary && !Array.isArray(input) ? coverageRow("Total", summary.total, kind) : null;
  const covered = rows.reduce((sum, row) => sum + row.covered, 0), total = rows.reduce((sum, row) => sum + row.total, 0);
  const prefix = commonDir(rows.map((row) => row.path));
  return { total: given ?? (rows.length ? { path: "Total", covered, total, pct: total > 0 ? (covered / total) * 100 : 100 } : null), files: rows.map((row) => ({ ...row, path: row.path.slice(prefix.length) || row.path })).sort((a, b) => a.pct - b.pct || a.path.localeCompare(b.path)) };
}

function commonDir(paths: readonly string[]): string {
  if (paths.length < 2) return paths[0]?.includes("/") ? paths[0].slice(0, paths[0].lastIndexOf("/") + 1) : "";
  let prefix = paths[0];
  for (const path of paths) while (!path.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix.slice(0, prefix.lastIndexOf("/") + 1);
}

// Ported from GenUI core/dependencies.ts (Apache-2.0).
export type Bump = "major" | "minor" | "patch" | "prerelease";
export function parseVersion(value: string): { release: number[]; pre: string } | null {
  const match = /^\s*[v=^~]?(\d+(?:\.\d+)*)(?:[-.]?([0-9a-z][0-9a-z.-]*))?(?:\+[0-9a-z.-]+)?\s*$/iu.exec(value);
  return match ? { release: match[1].split(".").map(Number), pre: (match[2] ?? "").toLowerCase() } : null;
}

export function versionBump(from: string, to: string): Bump | null {
  const x = parseVersion(from), y = parseVersion(to);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.release.length, y.release.length); i++) if ((x.release[i] ?? 0) !== (y.release[i] ?? 0)) return i === 0 ? "major" : i === 1 ? "minor" : "patch";
  return x.pre !== y.pre ? "prerelease" : null;
}

/** `to` cut where it starts to differ from `from`, at a field boundary: 4.17.15 → 4.18.1 is ["4.", "18.1"]. */
export function splitChange(from: string, to: string): [string, string] {
  let at = 0;
  while (at < from.length && at < to.length && from[at] === to[at]) at++;
  if (at === to.length && at === from.length) return [to, ""];
  const cut = Math.max(to.lastIndexOf(".", at - 1), to.lastIndexOf("-", at - 1)) + 1;
  return [to.slice(0, cut), to.slice(cut)];
}

export type Outdated = { name: string; current: string; wanted?: string; latest: string; type?: string; bump: Bump | null };

/** Packages from [{name, current, wanted?, latest, type?}] or `npm outdated --json` ({name: {current, wanted, latest, type}}). Major first. */
export function readDependencies(input: unknown): Outdated[] {
  const rows = Array.isArray(input) ? items(input) : Object.entries(record(input) ?? {}).flatMap(([name, value]) => { const item = record(value); return item ? [{ name, ...item } as Record<string, unknown>] : []; });
  const order: (Bump | null)[] = ["major", "minor", "patch", "prerelease", null];
  return rows.flatMap((row) => {
    const name = text(row.name) ?? text(row.package), current = text(row.current) ?? text(row.version) ?? "", latest = text(row.latest) ?? text(row.wanted) ?? "";
    return name && latest ? [{ name, current, wanted: text(row.wanted), latest, type: text(row.type) ?? text(row.dependencyType), bump: current ? versionBump(current, latest) : null }] : [];
  }).sort((a, b) => order.indexOf(a.bump) - order.indexOf(b.bump) || a.name.localeCompare(b.name));
}

// Ported from GenUI core/findings.ts (Apache-2.0).
export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];
const SEVERITY_WORDS: Record<string, Severity> = { critical: "critical", blocker: "critical", fatal: "critical", high: "high", error: "high", major: "high", medium: "medium", moderate: "medium", warning: "medium", warn: "medium", low: "low", minor: "low", note: "low", info: "info", none: "info", hint: "info" };
export const severityOf = (value: unknown): Severity => SEVERITY_WORDS[String(value ?? "").trim().toLowerCase()] ?? "info";

export type Finding = { severity: Severity; title: string; file?: string; line?: number; rule?: string; detail?: string; code?: string };

/** Findings from [{severity, title | message, file?, line?, rule?, detail?, code?}] or SARIF ({runs: [{results}]}). Most severe first, then by file and line. */
export function readFindings(input: unknown): Finding[] {
  const runs = record(input)?.runs;
  const found: Finding[] = Array.isArray(runs) ? items(runs).flatMap((run) => items(run.results).flatMap((result) => {
    const location = record(record(items(result.locations)[0])?.physicalLocation);
    const title = text(record(result.message)?.text) ?? text(result.message);
    return title ? [{ severity: severityOf(result.level ?? "warning"), title, file: text(record(location?.artifactLocation)?.uri), line: number(record(location?.region)?.startLine), rule: text(result.ruleId), detail: undefined, code: text(record(record(location?.region)?.snippet)?.text) }] : [];
  })) : items(input).flatMap((item) => {
    const title = text(item.title) ?? text(item.message) ?? text(item.description);
    return title ? [{ severity: severityOf(item.severity ?? item.level), title, file: text(item.file) ?? text(item.path), line: number(item.line), rule: text(item.rule) ?? text(item.ruleId), detail: text(item.detail), code: text(item.code) ?? text(item.snippet) }] : [];
  });
  return found.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0));
}

// Ported from GenUI core/logs.ts (Apache-2.0).
export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
const LEVEL_WORDS: Record<string, LogLevel> = { fatal: "fatal", panic: "fatal", crit: "fatal", critical: "fatal", emerg: "fatal", alert: "fatal", error: "error", err: "error", fail: "error", warn: "warn", warning: "warn", info: "info", notice: "info", log: "info", debug: "debug", verbose: "debug", trace: "trace", silly: "trace" };

/** A level word, or a pino/bunyan (10…60) or syslog (0…7) number. */
export function levelOf(value: unknown): LogLevel | null {
  if (typeof value === "number") return value >= 10 ? (value >= 60 ? "fatal" : value >= 50 ? "error" : value >= 40 ? "warn" : value >= 30 ? "info" : value >= 20 ? "debug" : "trace")
    : (["fatal", "fatal", "fatal", "error", "warn", "info", "info", "debug"] as const)[value] ?? null;
  return typeof value === "string" ? LEVEL_WORDS[value.trim().toLowerCase()] ?? null : null;
}

const LEVEL_PATTERNS: [RegExp, (match: RegExpExecArray) => LogLevel | null][] = [
  [/\blevel=["']?(\w+)/iu, (m) => levelOf(m[1])],
  [/\[(fatal|error|err|warn(?:ing)?|info|debug|trace)\]/iu, (m) => levelOf(m[1])],
  [/(?:^|[\s|:])(FATAL|ERROR|ERR|WARN(?:ING)?|INFO|DEBUG|TRACE)(?=[\s:|\]]|$)/u, (m) => levelOf(m[1])],
  [/\berror(?:\[\w+\])?:|\berror TS\d+|^\s*(?:\w*Error|panic|Traceback|FAIL|✗|×)\b/u, () => "error"],
  [/\bwarning(?:\[\w+\])?:|^\s*(?:Warning|DeprecationWarning)\b/u, () => "warn"],
];

export function textLevel(line: string): LogLevel | null {
  for (const [pattern, read] of LEVEL_PATTERNS) { const match = pattern.exec(line); if (match) return read(match); }
  return null;
}

export type LogLine = { text: string; level: LogLevel | null; time?: string; count: number; number: number };

/** Lines from log text or [string | {level, msg | message, time}] (JSON lines too). Indented lines keep the level above them; repeats fold into one line with a count. */
export function readLogs(input: unknown): LogLine[] {
  const raw: unknown[] = typeof input === "string" ? input.replace(/\r\n?/gu, "\n").replace(/\n$/u, "").split("\n") : Array.isArray(input) ? input : [];
  const lines: LogLine[] = [];
  let last: LogLevel | null = null;
  raw.forEach((entry, index) => {
    let item = record(entry);
    if (!item && typeof entry === "string" && entry.trimStart().startsWith("{")) try { item = record(JSON.parse(entry)); } catch { /* plain text */ }
    const body = stripAnsi(item ? text(item.msg) ?? text(item.message) ?? JSON.stringify(item) : String(entry ?? ""));
    const time = item ? (text(item.time) ?? text(item.timestamp) ?? (typeof item.time === "number" ? new Date(item.time).toISOString() : undefined)) : undefined;
    const level = item ? levelOf(item.level ?? item.severity ?? item.lvl) ?? textLevel(body) : textLevel(body) ?? (/^\s+\S/u.test(body) && last !== null ? last : null);
    if (body.trim() !== "" || item) last = level;
    const prev = lines[lines.length - 1];
    if (prev && prev.text === body && prev.level === level && body.trim() !== "") prev.count++;
    else lines.push({ text: body, level, time, count: 1, number: index + 1 });
  });
  return lines;
}

/** Splits text around http(s) links. */
export function findLinks(line: string): { text: string; url?: string }[] {
  const parts: { text: string; url?: string }[] = [];
  let at = 0;
  for (const match of line.matchAll(/https?:\/\/[^\s"'<>)\]]+[^\s"'<>)\].,;:!?]/gu)) {
    if (match.index > at) parts.push({ text: line.slice(at, match.index) });
    parts.push({ text: match[0], url: match[0] });
    at = match.index + match[0].length;
  }
  if (at < line.length || !parts.length) parts.push({ text: line.slice(at) });
  return parts;
}

// Ported from GenUI core/pipeline.ts (Apache-2.0).
export type PipelineStatus = "failure" | "in_progress" | "queued" | "cancelled" | "success" | "skipped" | "neutral";
const STATUS_ORDER: PipelineStatus[] = ["failure", "in_progress", "queued", "cancelled", "success", "neutral", "skipped"];
const STATUS_WORDS: Record<string, PipelineStatus> = Object.fromEntries(Object.entries({
  success: "success succeeded successful passed pass ok done complete completed green",
  failure: "failure failed fail failing error errored broken red timedout timeout startupfailure actionrequired",
  in_progress: "inprogress running active started building deploying",
  queued: "queued pending waiting requested scheduled expected blocked",
  cancelled: "cancelled canceled cancel aborted stopped",
  skipped: "skipped skipping skip",
  neutral: "neutral stale",
} as Record<PipelineStatus, string>).flatMap(([status, words]) => words.split(" ").map((word) => [word, status as PipelineStatus])));

export function pipelineStatus(value: unknown): PipelineStatus | null {
  if (typeof value === "boolean") return value ? "success" : "failure";
  return typeof value === "string" ? STATUS_WORDS[value.trim().toLowerCase().replace(/[\s_-]+/gu, "")] ?? null : null;
}

/** A gh run, job or step: `status` until it completes, then its `conclusion`. */
function jobStatus(item: Record<string, unknown>): PipelineStatus {
  const state = text(item.status)?.toLowerCase();
  if (item.conclusion !== undefined && (state === "completed" || state === undefined)) return pipelineStatus(item.conclusion) ?? (state === "completed" ? "neutral" : "queued");
  return pipelineStatus(item.status ?? item.state ?? item.result) ?? "queued";
}

export function overallStatus(statuses: readonly PipelineStatus[]): PipelineStatus {
  if (!statuses.length) return "neutral";
  const has = (status: PipelineStatus) => statuses.includes(status);
  if (has("failure")) return "failure";
  if (has("in_progress")) return "in_progress";
  if (has("queued")) return statuses.every((status) => status === "queued") || !has("success") ? "queued" : "in_progress";
  if (has("cancelled")) return "cancelled";
  if (has("success")) return "success";
  return statuses.every((status) => status === "skipped") ? "skipped" : "neutral";
}

export function formatElapsed(ms: number): string {
  if (!(ms > 0)) return "0s";
  if (ms < 1000) return ms < 950 ? "<1s" : "1s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export type Job = { name: string; status: PipelineStatus; ms?: number; stage?: string; url?: string; steps: Job[] };
const elapsed = (item: Record<string, unknown>) => {
  const ms = number(item.ms) ?? number(item.duration);
  if (ms !== undefined) return ms;
  const start = Date.parse(String(item.startedAt ?? item.started_at ?? "")), end = Date.parse(String(item.completedAt ?? item.completed_at ?? ""));
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
};

/** Jobs from [{name, status, ms?, stage?, steps?}] or `gh run view --json jobs` ({jobs: [{name, status, conclusion, startedAt, completedAt, steps}]}). Failures first within a stage. */
export function readPipeline(input: unknown): Job[] {
  const read = (value: unknown): Job[] => items(Array.isArray(value) ? value : record(value)?.jobs).flatMap((item) => {
    const name = text(item.name) ?? text(item.title);
    return name ? [{ name, status: jobStatus(item), ms: elapsed(item), stage: text(item.stage), url: text(item.url) ?? text(item.html_url), steps: read(item.steps) }] : [];
  });
  return read(input);
}

export function byStage(jobs: readonly Job[]): { stage: string; jobs: Job[]; status: PipelineStatus }[] {
  const stages = new Map<string, Job[]>();
  for (const job of jobs) stages.set(job.stage ?? "", [...(stages.get(job.stage ?? "") ?? []), job]);
  return [...stages].map(([stage, list]) => ({ stage, status: overallStatus(list.map((job) => job.status)), jobs: list.map((job, index) => ({ job, index })).sort((a, b) => STATUS_ORDER.indexOf(a.job.status) - STATUS_ORDER.indexOf(b.job.status) || a.index - b.index).map(({ job }) => job) }));
}

// Ported in part from GenUI core/stack-trace.ts (Apache-2.0): JavaScript, Python and JVM traces.
export type Frame = { fn?: string; file?: string; line?: number; column?: number; app: boolean; code?: string };
export type TraceSection = { type: string; message: string; frames: Frame[]; cause: boolean };
const LIBRARY = /node_modules|^node:|^internal\/|\(native\)|\[native code\]|site-packages|dist-packages|^<frozen |^(?:java|javax|jdk|sun|kotlin|scala)\.|^(?:org\.junit|org\.springframework)\./u;
const V8_FRAME = /^at\s+(?:(.+?)\s+\()?((?:file:\/\/|https?:\/\/)?[^()]+?):(\d+)(?::(\d+))?\)?$/u;
const AT_SIGN = /^([^\s@]*)@(.+?):(\d+)(?::(\d+))?$/u;
const JVM_FRAME = /^at\s+([\w$.<>/-]+)\(([^:)]*)(?::(\d+))?\)$/u;
const PY_FRAME = /^\s*File "([^"]+)", line (\d+)(?:, in (.+))?$/u;

/** `TypeError: x is not a function` → type and message; a line without a type is all message. */
export function splitHeader(line: string): { type: string; message: string } {
  const match = /^([\w$.]*(?:Error|Exception|Panic|Warning|Interrupt|Exit|Fault)|[A-Z][\w$.]*):\s?([\s\S]*)$/u.exec(line.trim());
  return match ? { type: match[1], message: match[2] } : { type: "", message: line.trim() };
}

/** Sections (an error and its causes) from a trace's text or {name, message, stack}. Python's innermost frame comes first, like the others. */
export function readTrace(input: unknown): TraceSection[] {
  const item = record(input);
  const raw = typeof input === "string" ? input : item ? (text(item.stack) ?? [text(item.name), text(item.message)].filter(Boolean).join(": ")) : "";
  const lines = stripAnsi(raw).replace(/\r\n?/gu, "\n").split("\n");
  const sections: TraceSection[] = [];
  const open = (header: string, cause: boolean) => { const section: TraceSection = { ...splitHeader(header), frames: [], cause }; sections.push(section); return section; };
  if (/^\s*Traceback \(most recent call last\):\s*$/mu.test(raw)) {
    let frames: Frame[] = [];
    for (let i = 0; i < lines.length; i++) {
      const match = PY_FRAME.exec(lines[i]);
      if (match) { const code = lines[i + 1]?.trim() && !PY_FRAME.test(lines[i + 1]) && !/^\S/u.test(lines[i + 1]) ? lines[++i].trim() : undefined; frames.push({ file: match[1], line: Number(match[2]), fn: match[3], app: !LIBRARY.test(match[1]), code }); continue; }
      if (/^Traceback/u.test(lines[i]) || !lines[i].trim() || /^\s/u.test(lines[i])) continue;
      if (/^(?:During handling|The above exception)/u.test(lines[i])) continue;
      const section = open(lines[i], false);
      section.frames = frames.reverse();
      frames = [];
    }
    // Python prints the cause first; show the error raised last on top.
    sections.reverse().forEach((section, index) => { section.cause = index > 0; });
    return sections;
  }
  for (const line of lines) {
    const body = line.trim().replace(/,$/u, "");
    if (!body) continue;
    const v8 = V8_FRAME.exec(body), jvm = v8 ? null : JVM_FRAME.exec(body), at = v8 || jvm || body.includes(" ") ? null : AT_SIGN.exec(body);
    if (v8 || jvm || at) {
      const target = sections[sections.length - 1] ?? open("", false);
      const file = v8 ? v8[2].replace(/^file:\/\//u, "") : jvm ? jvm[2] : at![2];
      const fn = v8 ? v8[1] : jvm ? jvm[1] : at![1] || undefined;
      target.frames.push({ fn, file, line: Number((v8 ?? jvm ?? at)![3]) || undefined, column: Number((v8 ?? at)?.[4]) || undefined, app: !LIBRARY.test(jvm ? fn ?? "" : file) });
      continue;
    }
    const cause = /^(?:\[cause\]:|Caused by:)\s*(.*)$/u.exec(body);
    if (cause) { open(cause[1].replace(/\s*\{$/u, ""), true); continue; }
    if (/^\.\.\. \d+ (?:more|lines? matching)/u.test(body) || /^[\]}]$/u.test(body)) continue;
    const last = sections[sections.length - 1];
    if (last && !last.frames.length) last.message += `${last.message ? "\n" : ""}${body}`;
    else open(body.replace(/^Uncaught (?:\(in promise\) )?/u, ""), sections.length > 0);
  }
  return sections;
}

/** App frames as they are; each run of library frames as one folded row unless unfolded. */
export function frameRows(frames: readonly Frame[], unfolded: ReadonlySet<number>): ({ frame: Frame; index: number } | { folded: number; at: number })[] {
  const rows: ({ frame: Frame; index: number } | { folded: number; at: number })[] = [];
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].app || unfolded.has(i) || !frames.some((frame) => frame.app)) { rows.push({ frame: frames[i], index: i }); continue; }
    let end = i;
    while (end + 1 < frames.length && !frames[end + 1].app) end++;
    if (end === i) rows.push({ frame: frames[i], index: i });
    else rows.push({ folded: end - i + 1, at: i });
    i = end;
  }
  return rows;
}

export const MAX_TILES = 24, MIN_SHARE = 0.004;
export type Tile = { name: string; value: number; group?: string; more?: number };

/** The largest items, the tail folded into one "N more" tile: at most `max`, none under MIN_SHARE of the total. */
export function visibleTiles(tiles: readonly Tile[], max = MAX_TILES): Tile[] {
  const sorted = tiles.filter((tile) => tile.value > 0).sort((a, b) => b.value - a.value);
  const total = sorted.reduce((sum, tile) => sum + tile.value, 0);
  let keep = sorted.findIndex((tile, index) => index >= max || tile.value / total < MIN_SHARE);
  if (keep === -1 || sorted.length - keep < 2) return sorted;
  if (keep === max) keep--;
  const rest = sorted.slice(keep);
  return [...sorted.slice(0, keep), { name: `${rest.length} more`, value: rest.reduce((sum, tile) => sum + tile.value, 0), group: sorted[0]?.group, more: rest.length }];
}

/** Tiles from [{name | path, value | size, group?}] or {name: size}. */
export function readTiles(input: unknown): Tile[] {
  if (!Array.isArray(input)) return Object.entries(record(input) ?? {}).flatMap(([name, value]) => { const size = number(value); return size !== undefined && size > 0 ? [{ name, value: size }] : []; });
  return items(input).flatMap((item) => {
    const name = text(item.name) ?? text(item.path) ?? text(item.label), value = number(item.value) ?? number(item.size) ?? number(item.bytes);
    return name && value !== undefined && value > 0 ? [{ name, value, group: text(item.group) }] : [];
  });
}

// Ported in part from GenUI core/waterfall.ts (Apache-2.0).
export type Span = { name: string; start: number; duration: number; depth: number; failed: boolean; detail?: string };

/** Spans in ms from 0 from [{name, start, duration | end, depth?, failed?}] (in `unit`), a HAR ({log: {entries}}) or Chrome trace events ([{name, ph: "X", ts, dur}], in µs). */
export function readWaterfall(input: unknown, unit = "ms"): Span[] {
  const entries = record(record(input)?.log)?.entries;
  const traceEvents = record(input)?.traceEvents ?? input;
  let spans: Span[];
  if (Array.isArray(entries)) spans = items(entries).flatMap((entry) => {
    const start = Date.parse(String(entry.startedDateTime ?? "")), duration = number(entry.time), url = text(record(entry.request)?.url), status = number(record(entry.response)?.status) ?? 0;
    return Number.isFinite(start) && duration !== undefined && url ? [{ name: requestLabel(url), start, duration, depth: 0, failed: status >= 400 || status === 0, detail: `${text(record(entry.request)?.method) ?? "GET"} ${status || "failed"}` }] : [];
  });
  else if (Array.isArray(traceEvents) && items(traceEvents).some((event) => event.ph === "X")) spans = items(traceEvents).flatMap((event) => {
    const name = text(event.name), ts = number(event.ts), dur = number(event.dur);
    return event.ph === "X" && name && ts !== undefined && dur !== undefined ? [{ name, start: ts / 1000, duration: dur / 1000, depth: 0, failed: false }] : [];
  });
  else {
    const factor = (unitInfo(unit).kind === "time" ? unitInfo(unit).factor : 1e-3) * 1000;
    spans = items(input).flatMap((item) => {
      const name = text(item.name) ?? text(item.label), start = number(item.start) ?? 0, end = number(item.end), duration = number(item.duration) ?? number(item.ms) ?? (end !== undefined ? end - start : undefined);
      return name && duration !== undefined && duration >= 0 ? [{ name, start: start * factor, duration: duration * factor, depth: Math.max(0, Math.min(8, Math.round(number(item.depth) ?? 0))), failed: item.failed === true || pipelineStatus(item.status) === "failure", detail: text(item.detail) }] : [];
    });
  }
  const zero = Math.min(...spans.map((span) => span.start));
  return spans.map((span) => ({ ...span, start: span.start - zero }));
}

/** A request URL as a short label: its path and query, or the host when it is the root. */
export function requestLabel(url: string): string {
  try { const parsed = new URL(url); const path = parsed.pathname + parsed.search; return path === "/" ? parsed.host : path.length > 60 ? `${path.slice(0, 57)}…` : path; } catch { return url; }
}

// Group colours, in the order groups first appear: accent, positive, warning, negative, muted in BB.
const GROUP_COLORS = [0, 2, 3, 4, 1];

type TreemapPoint = { id?: string; parent?: string; name: string; value?: number; colorIndex: number };

/** Treemap points: each group a parent with its largest 12 items inside, or the largest 24 items when there is one group. */
export function treemapPoints(tiles: readonly Tile[]): TreemapPoint[] {
  const named = [...new Set(tiles.map((tile) => tile.group ?? ""))];
  if (named.length < 2) return visibleTiles(tiles).map((tile) => ({ name: tile.name, value: tile.value, colorIndex: GROUP_COLORS[0]! }));
  const groups = visibleTiles(named.map((name) => ({ name, value: tiles.filter((tile) => (tile.group ?? "") === name).reduce((sum, tile) => sum + tile.value, 0), group: name })), 12);
  return groups.flatMap((group, i): TreemapPoint[] => {
    const colorIndex = GROUP_COLORS[Math.max(0, named.indexOf(group.group ?? "")) % GROUP_COLORS.length]!;
    if (group.more) return [{ name: group.name, value: group.value, colorIndex }];
    const id = `group-${i}`;
    return [{ id, name: group.name || "Other", colorIndex }, ...visibleTiles(tiles.filter((tile) => (tile.group ?? "") === group.name), 12).map((tile) => ({ parent: id, name: tile.name, value: tile.value, colorIndex }))];
  });
}
