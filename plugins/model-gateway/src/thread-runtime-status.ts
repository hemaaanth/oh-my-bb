import type { ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { harnessSchema } from "./chain.js";
import type { ThreadRouteStore } from "./upstreams/store.js";

const STALE_AFTER_MS = 30 * 60 * 1_000;
const EXPIRES_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;
const identifierSchema = z.string().min(1).max(256);
const modelIdSchema = identifierSchema.regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u);
const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fallbackCauseSchema = z.object({
  category: z.enum(["transport", "authentication", "rate-limit", "availability"]),
  status: z.number().int().min(0).max(599),
  observedAt: timestampSchema,
}).strict();
const routeSchema = z.object({
  harness: harnessSchema.nullable(),
  model: modelIdSchema.nullable(),
  requestedModel: modelIdSchema.nullable(),
  autoModel: modelIdSchema.nullable(),
  fallback: z.enum(["primary", "fallback", "unknown"]),
  fallbackCause: fallbackCauseSchema.nullable(),
}).strict();
const base = {
  schemaVersion: z.literal(1),
  threadId: identifierSchema,
  readAt: timestampSchema,
  configuredRouting: z.object({ status: z.literal("not-evaluated") }).strict(),
};

export const threadRuntimeStatusV1InputSchema = z.object({ threadId: identifierSchema }).strict();
export const threadRuntimeStatusV1OutputSchema = z.discriminatedUnion("availability", [
  z.object({ ...base, availability: z.literal("observed"), observedAt: timestampSchema,
    stale: z.boolean(), route: routeSchema }).strict(),
  z.object({ ...base, availability: z.literal("missing"), observedAt: z.null(),
    stale: z.null(), route: z.null() }).strict(),
  z.object({ ...base, availability: z.literal("expired"), observedAt: timestampSchema,
    stale: z.literal(true), route: z.null() }).strict(),
]);
export type ThreadRuntimeStatusV1 = z.infer<typeof threadRuntimeStatusV1OutputSchema>;

function identifier(value: string | null | undefined): string | null {
  const parsed = modelIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** One exact-thread SELECT. Never resolve accounts, current chains, or live runtime state. */
export function createThreadRuntimeStatusHandlers(routes: ThreadRouteStore, now: () => number) {
  return {
    threadRuntimeStatusV1(
      { threadId }: z.infer<typeof threadRuntimeStatusV1InputSchema>,
      context?: ExperimentalPluginRpcHandlerContext,
    ): ThreadRuntimeStatusV1 {
      const caller = context?.experimental_caller;
      if (caller?.kind !== "client" && !(caller?.kind === "plugin" && caller.pluginId === "machine"))
        throw new Error("Forbidden: thread runtime status requires a client or the Machine plugin.");
      const readAt = now();
      const common = { schemaVersion: 1 as const, threadId, readAt,
        configuredRouting: { status: "not-evaluated" as const } };
      const route = routes.get(threadId);
      if (route === null)
        return { ...common, availability: "missing", observedAt: null, stale: null, route: null };
      const observedAt = route.usedAt;
      const age = readAt - observedAt;
      if (age > EXPIRES_AFTER_MS)
        return { ...common, availability: "expired", observedAt, stale: true, route: null };
      const harness = harnessSchema.safeParse(route.harness);
      const cause = route.fallbackCause;
      const fallbackCause = fallbackCauseSchema.safeParse(cause === null ? null : {
        category: cause.category, status: cause.status, observedAt: cause.at,
      });
      return {
        ...common, availability: "observed", observedAt,
        // A future observation means clock skew, not evidence of freshness.
        stale: age < 0 || age >= STALE_AFTER_MS,
        route: {
          harness: harness.success ? harness.data : null,
          model: identifier(route.model), requestedModel: identifier(route.requestedModel),
          autoModel: identifier(route.autoModel),
          fallback: route.reason === "primary" ? "primary"
            : route.reason === "fallback" || route.reason === "primary exhausted" ? "fallback" : "unknown",
          fallbackCause: fallbackCause.success ? fallbackCause.data : null,
        },
      };
    },
  };
}
