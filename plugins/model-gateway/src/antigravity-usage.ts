import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** agy logs "OAuth: authenticated successfully as <email>" when it signs in. */
export function antigravityEmailFromLog(log: string): string | undefined {
  const email = /authenticated successfully as (\S+@\S+)/u.exec(log)?.[1];
  return email !== undefined && z.string().email().safeParse(email).success ? email : undefined;
}

export function parseAntigravityUsageReport(value: unknown, observedAt: number, email?: string) {
  const { command } = usageReport.parse(value);
  const groups = command.data.groups.flatMap(({ name, buckets }) => {
    const bucket = (window: string) => buckets.find((candidate) => candidate.window === window && candidate.remaining_fraction !== undefined);
    const time = (value: string | undefined) => { const at = Date.parse(value ?? ""); return Number.isFinite(at) ? at : undefined; };
    const weekly = bucket("weekly");
    if (weekly?.remaining_fraction === undefined) return [];
    const fiveHour = bucket("five_hour");
    return [{
      name, weeklyUtilization: 1 - weekly.remaining_fraction, resetAt: time(weekly.reset_time),
      ...(fiveHour?.remaining_fraction === undefined ? {} : {
        fiveHourUtilization: 1 - fiveHour.remaining_fraction, fiveHourResetAt: time(fiveHour.reset_time),
      }),
    }];
  });
  // The CLI report has no plan identifier.
  return antigravityUsageSnapshotSchema.parse({ observedAt, groups, source: "agy", ...(email === undefined ? {} : { email }) });
}

export async function readAntigravityUsage(signal?: AbortSignal) {
  // A private log file gives the signed-in email; the usage report omits it.
  const directory = await mkdtemp(join(tmpdir(), "model-gateway-agy-"));
  const logFile = join(directory, "agy.log");
  try {
    const { stdout } = await exec("agy", ["-p", "/usage", "--output-format", "json", "--print-timeout", "12s", "--log-file", logFile], {
      signal, timeout: 15_000, maxBuffer: 256_000,
    });
    const email = antigravityEmailFromLog(await readFile(logFile, "utf8").catch(() => ""));
    return parseAntigravityUsageReport(JSON.parse(stdout), Date.now(), email);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
