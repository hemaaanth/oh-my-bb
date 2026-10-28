import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { sandboxProviderValues, type SandboxProvider } from "../backend.js";

const outcomeBase = z.object({ schemaVersion: z.literal(1), jobId: z.string().uuid() }).strict();
const startedPreparationSchema = z.object({ jobId: outcomeBase.shape.jobId });
const preparationOutcomeV1Schema = z.union([
  outcomeBase.extend({ state: z.literal("running"), retryable: z.literal(false), reason: z.literal("in_progress") }),
  outcomeBase.extend({ state: z.literal("unknown"), retryable: z.literal(false), reason: z.enum(["job_unavailable", "completion_unconfirmed"]) }),
  outcomeBase.extend({ state: z.literal("complete"), ready: z.literal(true), retryable: z.literal(false), reason: z.literal("ready") }),
  outcomeBase.extend({ state: z.literal("complete"), ready: z.literal(false), retryable: z.literal(true), reason: z.literal("not_ready") }),
  outcomeBase.extend({ state: z.literal("failed"), retryable: z.literal(true), reason: z.enum(["before_remote_work", "not_ready"]) }),
]);
type SourceOutcome = z.infer<typeof preparationOutcomeV1Schema>;
export const nativeProjectPreparationSchema = z.object({
  state: z.enum(["not-required", "pending", "running", "ready", "not-ready", "failed", "unknown"]),
  jobId: z.string().nullable(),
  reason: z.string().nullable(),
  retryable: z.boolean().default(false),
  sourceVersion: z.literal(1).optional(),
});
type Observation = z.infer<typeof nativeProjectPreparationSchema>;
const legacyReason = "Legacy preparation has no versioned remote outcome evidence. Refresh the same job; do not replay setup.";
const unknown = (jobId: string | null, reason: string): Observation => ({ state: "unknown", jobId, reason, retryable: false });
const outcomeReasons: Record<SourceOutcome["reason"], string | null> = {
  ready: null,
  in_progress: "Credentials is still preparing this workspace.",
  job_unavailable: "Credentials no longer has this job. Its remote outcome is unknown; fresh retry is unavailable.",
  completion_unconfirmed: "Credentials cannot confirm remote completion. Catalog participation remains unconfirmed under its legacy contract; safe retry is unavailable.",
  before_remote_work: "Credentials confirms failure before remote work started. Explicit retry is available.",
  not_ready: "Credentials confirms not-ready with no unacknowledged operation. Explicit retry will run setup again.",
};
const observationFor = (outcome: SourceOutcome): Observation => ({
  state: outcome.state === "complete" ? outcome.ready ? "ready" : "not-ready" : outcome.state,
  jobId: outcome.jobId, reason: outcomeReasons[outcome.reason], retryable: outcome.retryable, sourceVersion: 1,
});
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
interface Target {
  environment: { id: string; projectId: string; hostId: string; path: string | null; status: string };
  host: { id: string; name: string; machineProviderId: string | null };
  vendor: SandboxProvider;
}

/** Stage-only observer. Credentials owns the job, preparation and cancellation. */
export function registerNativeProjectEnvironmentSync(
  bb: BbPluginApi,
  deps: { isPluginRunning: (pluginId: string) => Promise<boolean>; enabled?: () => Promise<boolean>; pollMs?: number },
) {
  const controller = new AbortController();
  bb.onDispose(() => controller.abort());
  const inFlight = new Map<string, { mode: "observe" | "retry" | "reconcile"; promise: Promise<Observation>; refresh: Promise<Observation> | undefined }>();
  const enabled = () => deps.enabled?.() ?? Promise.resolve(true);
  const resolve = async (thread: { id: string; environmentId: string | null }) => {
    if (thread.environmentId === null) return null;
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    const host = await bb.sdk.hosts.get({ hostId: environment.hostId });
    const vendor = sandboxProviderValues.find(value => host.machineProviderId === `sandbox-${value}`);
    return vendor ? { environment, host, vendor } : null;
  };
  const keyFor = ({ environment }: Target) => "project-preparation:v1:" + createHash("sha256")
    .update(JSON.stringify([environment.id, environment.projectId, environment.hostId, environment.path])).digest("hex");
  const read = async (key: string): Promise<Observation | null> => {
    const value = await bb.storage.kv.get(key);
    if (value === undefined) return null;
    const observation = nativeProjectPreparationSchema.parse(value);
    if (observation.sourceVersion === 1) return observation;
    if (observation.state === "failed" || observation.state === "not-ready" || observation.state === "ready") return {
      ...observation, state: observation.state === "not-ready" ? "not-ready" : "unknown", reason: legacyReason, retryable: false,
    };
    return observation.retryable ? { ...observation, retryable: false } : observation;
  };
  const save = async (key: string, observation: Observation) => {
    await bb.storage.kv.set(key, observation);
    return observation;
  };
  const sourceOutcome = async (jobId: string) => {
    const outcome = await bb.sdk.plugins.callRpc({
      pluginId: "project-environments", method: "preparationOutcomeV1", input: { jobId }, outputSchema: preparationOutcomeV1Schema,
    });
    if (outcome.jobId !== jobId) throw new Error("Credentials outcome refers to another job");
    return outcome;
  };
  const observe = (target: Target, mode: "observe" | "retry" | "reconcile" = "observe"): Promise<Observation> => {
    const key = keyFor(target);
    const current = inFlight.get(key);
    if (current) {
      // Refresh reads the same job once, without inheriting the polling lifetime.
      if (mode === "reconcile" && current.mode !== "reconcile") {
        if (controller.signal.aborted) return current.promise;
        current.refresh ??= (async (): Promise<Observation> => {
          const previous = await read(key);
          if (controller.signal.aborted) return unknown(previous?.jobId ?? null, "Local observer stopped; remote preparation was not cancelled");
          if (!previous?.jobId) throw new Error("No source-owned job identity to re-observe; do not replay setup");
          const jobId = previous.jobId;
          let result: Observation;
          try { result = observationFor(await sourceOutcome(jobId)); }
          catch { result = unknown(jobId, "A supported source outcome could not be read; refresh only observes the known job"); }
          if (controller.signal.aborted) return unknown(jobId, "Local observer stopped; remote preparation was not cancelled");
          const latest = await read(key);
          if (controller.signal.aborted) return unknown(jobId, "Local observer stopped; remote preparation was not cancelled");
          if (inFlight.get(key) !== current || latest?.jobId !== jobId) {
            return latest ?? unknown(null, "Preparation checkpoint is no longer available; do not replay setup");
          }
          return save(key, result);
        })().finally(() => { current.refresh = undefined; });
        return current.refresh;
      }
      if (mode === "retry" && current.mode !== "retry") return Promise.reject(new Error("Preparation is being observed; refresh before retrying"));
      return current.promise;
    }
    const pending = (async (): Promise<Observation> => {
      const previous = await read(key);
      controller.signal.throwIfAborted();
      if (mode === "retry" && (!previous?.jobId || previous.sourceVersion !== 1 || !previous.retryable || (previous.state !== "not-ready" && previous.state !== "failed"))) {
        throw new Error("Retry requires versioned source evidence; reconcile the known job first. Legacy or unknown outcomes never authorize replay.");
      }
      if (mode === "reconcile" && !previous?.jobId) throw new Error("No source-owned job identity to re-observe; do not replay setup");
      if (mode === "observe" && previous && previous.state !== "running") return previous;
      if (!await enabled()) return { state: "not-required", jobId: null, reason: "Credentials integration is off", retryable: false };
      const sourceRunning = await deps.isPluginRunning("project-environments");
      controller.signal.throwIfAborted();
      if (!sourceRunning) {
        const result: Observation = { state: "pending", jobId: previous?.jobId ?? null, reason: "Credentials is not running", retryable: false };
        return previous?.jobId ? save(key, result) : result;
      }
      let jobId = previous?.jobId ?? null;
      if (mode === "retry") {
        try {
          controller.signal.throwIfAborted();
          const fresh = await sourceOutcome(jobId!);
          if (controller.signal.aborted) return unknown(jobId, "Local observer stopped; remote preparation was not cancelled");
          if (!fresh.retryable) return save(key, observationFor(fresh));
        } catch {
          const result = unknown(jobId, "A supported Credentials outcome could not be read. Remote completion and retry authority are unconfirmed.");
          return controller.signal.aborted ? result : save(key, result);
        }
      }
      if (!previous || mode === "retry") {
        controller.signal.throwIfAborted();
        // Consume cached authority before start: a lost response never permits replay.
        await save(key, unknown(null, "Preparation start outcome is not yet known"));
        jobId = null;
        try {
          controller.signal.throwIfAborted();
          const job = await bb.sdk.plugins.callRpc({
            pluginId: "project-environments", method: "startPrepare",
            input: { projectId: target.environment.projectId, hostId: target.environment.hostId, workspacePath: target.environment.path, strict: false },
            outputSchema: startedPreparationSchema,
          });
          jobId = job.jobId;
          if (controller.signal.aborted) return unknown(jobId, "Local observer stopped; remote preparation was not cancelled");
          await save(key, { state: "running", jobId, reason: null, retryable: false });
        } catch {
          const result = unknown(jobId, controller.signal.aborted ? "Local observer stopped; remote preparation was not cancelled" : "Preparation start could not be acknowledged; do not replay setup.");
          return controller.signal.aborted ? result : save(key, result);
        }
      }
      if (!jobId) return save(key, unknown(null, "No source-owned job identity; fresh retry is unavailable"));
      const deadline = Date.now() + 45 * 60_000;
      while (!controller.signal.aborted && Date.now() < deadline) {
        try {
          const outcome = await sourceOutcome(jobId);
          if (controller.signal.aborted) return unknown(jobId, "Local observer stopped; remote preparation was not cancelled");
          const result = await save(key, observationFor(outcome));
          if (outcome.state !== "running" || mode === "reconcile") return result;
          await delay(deps.pollMs ?? 1_000, undefined, { signal: controller.signal });
        } catch {
          if (controller.signal.aborted) return unknown(jobId, "Local observer stopped; remote preparation was not cancelled");
          return save(key, unknown(jobId, "A supported Credentials outcome could not be read. Refresh only re-observes this job; it cannot authorize replay."));
        }
      }
      const result = unknown(jobId, controller.signal.aborted ? "Local observer stopped; remote preparation was not cancelled" : "Preparation observation timed out; remote stop is unconfirmed");
      return controller.signal.aborted ? result : save(key, result);
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, { mode, promise: pending, refresh: undefined });
    return pending;
  };
  const syncThread = async (thread: { id: string; environmentId: string | null }) => {
    const target = await resolve(thread);
    if (!target) return;
    const { host, environment, vendor } = target;
    if (!await enabled()) return;
    if (environment.status !== "ready" || environment.path === null) return;
    const result = await observe(target);
    if (result.state !== "ready") bb.log.warn(`Sandbox project preparation ${result.state}: ${result.reason ?? result.jobId ?? host.id}`);
  };
  for (const event of ["thread.created", "thread.active"] as const) bb.events.on(event, ({ thread }) => {
    void syncThread(thread).catch(error => { if (!controller.signal.aborted) bb.log.warn(`Could not observe sandbox preparation: ${message(error)}`); });
  });
  return {
    async status(threadId: string): Promise<Observation> {
      if (!await enabled()) return { state: "not-required", jobId: null, reason: "Credentials integration is off", retryable: false };
      const target = await resolve(await bb.sdk.threads.get({ threadId }));
      if (!target) return { state: "not-required", jobId: null, reason: null, retryable: false };
      return await read(keyFor(target)) ?? { state: "pending", jobId: null, reason: "Preparation has not been observed", retryable: false };
    },
    async retry(threadId: string): Promise<Observation> {
      if (!await enabled()) throw new Error("Enable Credentials under Sandboxes → Oh My BB first");
      const target = await resolve(await bb.sdk.threads.get({ threadId }));
      if (!target || target.environment.status !== "ready" || target.environment.path === null) throw new Error("A ready native sandbox checkout is required");
      return observe(target, "retry");
    },
    async reconcile(threadId: string): Promise<Observation> {
      if (!await enabled()) throw new Error("Enable Credentials under Sandboxes → Oh My BB first");
      const target = await resolve(await bb.sdk.threads.get({ threadId }));
      if (!target) throw new Error("A native sandbox checkout is required");
      return observe(target, "reconcile");
    },
  };
}
