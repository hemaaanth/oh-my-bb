import { coverageRow } from "./groups/dev-logic.js";
import { readCoverage, type CoverageFormat, type CoverageMetrics, type CoverageReport, type FileCoverage } from "./reports/coverage.js";
import type { Value } from "./reports/types.js";

export type CoverageMetric = keyof CoverageMetrics;
export type NativeCoverageReport = Omit<CoverageReport, "format"> & { format: CoverageFormat | "list" };
export type CoverageRead = { ok: true; report: NativeCoverageReport } | { ok: false; error: string };
const metrics: CoverageMetric[] = ["lines", "statements", "functions", "branches"];

/** Manual rows are an existing Pages contract; tool reports use the upstream readers. */
export function readCoverageInput(value: unknown, selected: CoverageMetric = "lines"): CoverageRead {
  if (!Array.isArray(value)) return readCoverage(value as Value);
  const files: FileCoverage[] = [];
  const total: Record<CoverageMetric, CoverageMetrics[CoverageMetric]> = { lines: null, statements: null, functions: null, branches: null };
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const rawPath = row.path ?? row.file ?? row.name;
    const path = typeof rawPath === "string" ? rawPath.trim() : typeof rawPath === "number" && Number.isFinite(rawPath) ? String(rawPath) : "";
    if (!path) continue;
    const picked = coverageRow(path, row, selected);
    if (!picked) continue;
    const ratios: Record<CoverageMetric, CoverageMetrics[CoverageMetric]> = { lines: null, statements: null, branches: null, functions: null };
    for (const metric of metrics) {
      if (metric !== selected && !Object.hasOwn(row, metric)) continue;
      const ratio = coverageRow(path, row, metric);
      if (!ratio) continue;
      ratios[metric] = { covered: ratio.covered, total: ratio.total };
      const sum = total[metric];
      total[metric] = { covered: (sum?.covered ?? 0) + ratio.covered, total: (sum?.total ?? 0) + ratio.total };
    }
    files.push({ path, ...ratios, missed: picked.total - picked.covered, uncovered: null });
  }
  return { ok: true, report: { format: "list", unit: selected === "statements" ? "statements" : "lines", total, files } };
}
