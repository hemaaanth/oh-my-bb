import { readBenchmark as readNative, type BenchRow } from "./groups/dev-logic.js";
import { readBenchmark, type BenchmarkRead, type Comparison, type Context, type Run } from "./reports/benchmark.js";
import type { Value } from "./reports/types.js";

export interface ManualBenchmarkRow extends BenchRow {
  comparable: boolean;
  contextBefore: Context | null;
  contextAfter: Context | null;
  partial: readonly string[];
  note: string | null;
  samples: readonly number[];
  beforeSamples: readonly number[];
  min: number | null;
  max: number | null;
  median: number | null;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const numeric = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

/** Compatibility rows only when the richer reader would change native values, units, direction, or missing baselines. */
export function manualBenchmarks(value: unknown, unit?: string, parsed?: BenchmarkRead): ManualBenchmarkRow[] | null {
  if (!Array.isArray(value) || value.some(item => {
    const metrics = record(item).metrics;
    return metrics !== null && typeof metrics === "object" && !Array.isArray(metrics);
  })) return null;
  const rows = value.flatMap((item, index) => {
    const raw = record(item);
    const native = readNative([item], unit)[0];
    const parsed = readBenchmark([item] as Value[], unit ?? null);
    const comparison: Comparison | undefined = parsed.ok && parsed.report.kind === "compare" ? parsed.report.rows[0] : undefined;
    const run: Run | undefined = parsed.ok && parsed.report.kind === "runs" ? parsed.report.groups[0]?.runs[0] : undefined;
    const row = native ? { ...native, before: native.before ?? comparison?.before ?? null } : comparison ? { name: comparison.name, before: comparison.before, after: comparison.after, unit: comparison.unit ?? "", better: comparison.better, noise: comparison.noise } : run ? { name: typeof raw.name === "string" ? raw.name : `Run ${index + 1}`, before: null, after: run.mean, unit: unit ?? "ms", better: "lower" as const, noise: run.stddev } : null;
    if (!row) return [];
    const samples = comparison?.afterSamples ?? run?.times ?? (Array.isArray(raw.times) ? raw.times.flatMap(value => numeric(value) ?? []) : []);
    return [{ ...row, comparable: comparison?.comparable ?? true, contextBefore: comparison?.contextBefore ?? null, contextAfter: comparison?.contextAfter ?? null, partial: comparison?.comparability?.oneSided.map(condition => condition.key) ?? [], note: comparison?.note ?? (typeof raw.note === "string" ? raw.note : null), samples, beforeSamples: comparison?.beforeSamples ?? [], min: numeric(raw.min) ?? (samples.length ? Math.min(...samples) : null), max: numeric(raw.max) ?? (samples.length ? Math.max(...samples) : null), median: numeric(raw.median) }];
  });
  const read = parsed ?? readBenchmark(value as Value[], unit ?? null);
  if (read.ok && read.report.kind === "compare" && rows.length > 0) {
    const comparisons = read.report.rows;
    if (comparisons.length === rows.length && rows.every((row, index) => {
      const comparison = comparisons[index]!;
      return row.name === comparison.name && row.before === comparison.before && row.after === comparison.after && row.unit === (comparison.unit ?? "") && row.better === comparison.better && row.noise === comparison.noise;
    })) return null;
  }
  return rows;
}
