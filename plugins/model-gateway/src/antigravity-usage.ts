import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { antigravityUsageSnapshotSchema } from "./contracts.js";

const exec = promisify(execFile);
const fraction = z.number().min(0).max(1);
const usageReport = z.object({
  status: z.literal("SUCCESS"),
  command: z.object({
    name: z.literal("usage"),
    data: z.object({
      groups: z.array(z.object({
        name: z.string(),
        buckets: z.array(z.object({
          window: z.string(), remaining_fraction: fraction.optional(), reset_time: z.string().optional(),
        })),
      })),
    }),
  }),
});

export function parseAntigravityUsageReport(value: unknown, observedAt: number) {
  const { command } = usageReport.parse(value);
  const groups = command.data.groups.flatMap(({ name, buckets }) => {
    const weekly = buckets.find((bucket) => bucket.window === "weekly" && bucket.remaining_fraction !== undefined);
    if (weekly?.remaining_fraction === undefined) return [];
    const resetAt = Date.parse(weekly.reset_time ?? "");
    return [{ name, weeklyUtilization: 1 - weekly.remaining_fraction, resetAt: Number.isFinite(resetAt) ? resetAt : undefined }];
  });
  // The CLI report has no plan identifier.
  return antigravityUsageSnapshotSchema.parse({ plan: "Weekly quota", observedAt, groups, source: "agy" });
}

export async function readAntigravityUsage(signal?: AbortSignal) {
  const { stdout } = await exec("agy", ["-p", "/usage", "--output-format", "json", "--print-timeout", "12s"], {
    signal, timeout: 15_000, maxBuffer: 256_000,
  });
  return parseAntigravityUsageReport(JSON.parse(stdout), Date.now());
}
