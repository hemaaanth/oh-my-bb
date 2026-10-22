import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * The model route of a thread, read from the Model Gateway plugin's
 * `thread.route` RPC so the machine popover can show it. Gateway owns the
 * data; this is a one-way, optional read.
 */
export const modelRouteSchema = z.object({
  /** The harness chain in plain names (`Claude Max → ChatGPT`). */
  chain: z.array(z.string()),
  /** The chain step serving the thread; above 0 means a fallback. */
  chainIndex: z.number().int(),
  accountLabel: z.string().nullable(),
  model: z.string().nullable(),
  stickyUntil: z.number().nullable(),
  /** The model Jev auto picked, or null. */
  autoModel: z.string().nullable(),
  /** Why Jev chose it (`jev 0.82`), or null. */
  auto: z.string().nullable(),
  fallbackCause: z.object({
    upstreamLabel: z.string(),
    category: z.string(),
    status: z.number(),
    message: z.string(),
    at: z.number(),
  }).nullable(),
});

export type ModelRoute = z.infer<typeof modelRouteSchema>;

/** Null when Model Gateway is missing, disabled, or never routed the thread. */
export async function readModelRoute(bb: BbPluginApi, threadId: string): Promise<ModelRoute | null> {
  try {
    return await bb.sdk.plugins.callRpc({
      pluginId: "model-gateway",
      method: "thread.route",
      input: { threadId },
      outputSchema: modelRouteSchema.nullable(),
    });
  } catch (cause) {
    bb.log.debug(`Model Gateway route unavailable for ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return null;
  }
}
