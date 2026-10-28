import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { FleetMatch } from "./fleet-query";
export const FLEET_CHANNEL = "traces-fleet";

export type FleetView = "explorer" | "metrics";
export type FleetMode = "events" | "spans";
export type FleetStatus = "running" | "cancelling" | "complete" | "cancelled" | "error" | "schema-mismatch";
export interface FleetRow extends Omit<FleetMatch, "projectName"> {
  id: string; seq: number; at: number; turnId: string | null; itemId: string | null; name: string;
}
export interface FleetFacet { value: string; count: number }
export interface FleetHistogramBin { from: number; to: number; count: number; errors: number }
export interface FleetToolStats { name: string; count: number; measured: number; unknown: number; p50Ms: number | null; p95Ms: number | null; partial: boolean }
export interface FleetErrorStats { category: string; count: number }
export interface FleetTtft { provider: string; hour: number; count: number; p50Ms: number | null; partial: boolean }
export interface FleetSpawn { threadId: string; provider: string; parentThreadId: string | null; children: number; lastActivityAt: number }
export interface FleetMetrics {
  turns: number; toolCalls: number; failedTools: number; errorRate: number | null;
  toolP50Ms: number | null; toolP95Ms: number | null; toolLatencyPartial: boolean;
  providerRetries: number; modelFallbacks: number; activeThreads: number;
  slowTools: FleetToolStats[]; slowProviders: FleetToolStats[];
  errors: FleetErrorStats[]; errorProviders: FleetErrorStats[]; errorTools: FleetErrorStats[];
  ttft: FleetTtft[]; spawnTree: FleetSpawn[];
  tokenUsage: null; tokenCoverage: { threadsWithSnapshot: number; threadsWithoutSnapshot: number; reason: string };
}
export interface FleetLimitReason { code: "thread-cap" | "event-cap" | "thread-event-cap" | "payload" | "rows" | "samples" | "live-reservoir";
  count: number; detail: string }
export interface FleetSnapshot {
  jobId: string; view: FleetView; mode: FleetMode; query: string; since: string; status: FleetStatus; error: string | null;
  from: number; to: number; startedAt: number; updatedAt: number; completedAt: number | null;
  scannedThreads: number; totalThreads: number; scannedEvents: number; matchedEvents: number;
  rows: FleetRow[]; rowsTruncated: number; histogram: FleetHistogramBin[];
  facets: Record<string, FleetFacet[]>; metrics: FleetMetrics;
  freshness: "scanning" | "snapshot" | "live-since-completion" | "cancelled" | "unavailable";
  liveSince: number | null; lastLiveEventAt: number | null; liveEnabled: boolean; limited: boolean; retries: number;
  limitReasons: FleetLimitReason[];
}

const startInput = z.object({ query: z.string().max(512), since: z.string().max(4), view: z.enum(["explorer", "metrics"]), mode: z.enum(["events", "spans"]) }).strict();
const jobInput = z.object({ jobId: z.string().regex(/^scan_[a-z0-9]+$/) }).strict();
const detailInput = z.object({ threadId: z.string().regex(/^thr_[a-z0-9]+$/), seq: z.number().int().positive(), reveal: z.boolean().default(false) }).strict();

export const fleetContract = defineRpcContract({
  traces_fleet_start: { input: startInput, output: z.custom<FleetSnapshot>() },
  traces_fleet_status: { input: jobInput, output: z.custom<FleetSnapshot>() },
  traces_fleet_cancel: { input: jobInput, output: z.custom<FleetSnapshot>() },
  traces_fleet_detail: { input: detailInput, output: z.object({ threadId: z.string(), seq: z.number(), type: z.string(), at: z.number(),
    input: z.string().nullable(), output: z.string().nullable(), inputSize: z.number().nullable(), outputSize: z.number().nullable() }).strict() },
});
