// Readiness (SPEC §2.3, §2.5). One computed object from the settings handle
// and the plugin list. Owned by P1. P3 reads `readSetupStatus` before dialling.
import {
  CHANNELS,
  PLUGIN_ID,
  SECRET_IDS,
  SETUP_LABELS,
  VOICE_SECRET_IDS,
  WEBHOOKS_PLUGIN_ID,
  WEBHOOK_ROUTE_LABEL,
} from "../shared/constants.js";
import type { SetupStatus } from "../shared/contract.js";
import type { ServerContext } from "./context.js";
import { liveStatus } from "./ledger.js";
import { isPresent, type SetupValues } from "./settings.js";

/** Wait this long after the key arrives before the self-reload (SPEC §2.5). */
export const RELOAD_DELAY_MS = 500;

type ReadinessState = { reloadPending: boolean; timer: ReturnType<typeof setTimeout> | null; disposed: boolean };
const states = new WeakMap<ServerContext, ReadinessState>();

function stateOf(ctx: ServerContext): ReadinessState {
  let state = states.get(ctx);
  if (!state) {
    state = { reloadPending: false, timer: null, disposed: false };
    states.set(ctx, state);
  }
  return state;
}

/** Present when BB lists the Webhooks plugin and it is enabled. Any failure counts as absent. */
export async function webhooksPluginState(ctx: ServerContext): Promise<"present" | "absent"> {
  try {
    const { plugins } = await ctx.bb.sdk.plugins.list();
    return plugins.some((plugin) => plugin.id === WEBHOOKS_PLUGIN_ID && plugin.enabled) ? "present" : "absent";
  } catch {
    return "absent";
  }
}

/** Pure part of readiness: booleans and labels from the setup values. */
export function computeSetupStatus(
  values: SetupValues,
  extra: { webhooksPlugin: "present" | "absent"; needsConfiguration: boolean; reloadPending: boolean; version: string },
): SetupStatus {
  const fields = Object.fromEntries(SECRET_IDS.map((id) => [id, isPresent(values[id])])) as SetupStatus["fields"];
  const voiceMissing = VOICE_SECRET_IDS.filter((id) => !fields[id]).map((id) => SETUP_LABELS[id]);
  const phoneMissing = SECRET_IDS.filter((id) => !fields[id]).map((id) => SETUP_LABELS[id]);
  if (extra.webhooksPlugin === "absent") phoneMissing.push(WEBHOOK_ROUTE_LABEL);
  return {
    fields,
    voice: { ready: voiceMissing.length === 0, missing: voiceMissing },
    phone: { ready: phoneMissing.length === 0, missing: phoneMissing, webhooksPlugin: extra.webhooksPlugin },
    needsConfiguration: extra.needsConfiguration,
    reloadPending: extra.reloadPending,
    version: extra.version,
  };
}

/** The `setupStatus` RPC body. Never holds a setup value. */
export async function readSetupStatus(ctx: ServerContext, values?: SetupValues): Promise<SetupStatus> {
  const current = values ?? (await ctx.settings.get());
  return computeSetupStatus(current, {
    webhooksPlugin: await webhooksPluginState(ctx),
    needsConfiguration: ctx.needsConfiguration,
    reloadPending: stateOf(ctx).reloadPending,
    version: ctx.version,
  });
}

async function publishSetup(ctx: ServerContext, values?: SetupValues): Promise<void> {
  const state = stateOf(ctx);
  if (state.disposed) return;
  const status = await readSetupStatus(ctx, values);
  if (state.disposed) return;
  ctx.bb.realtime.publish(CHANNELS.setupUpdated, status);
}

function publishSafely(ctx: ServerContext, values?: SetupValues): void {
  publishSetup(ctx, values).catch((error: unknown) => {
    ctx.bb.log.warn(`Dispatch could not publish readiness: ${error instanceof Error ? error.message : "unknown error"}`);
  });
}

/** Mark the reload as pending and tell open settings pages. */
function fallBackToManualReload(ctx: ServerContext, why: string): void {
  stateOf(ctx).reloadPending = true;
  ctx.bb.log.info(`Dispatch did not reload itself (${why}). Settings show "Reload to apply".`);
  publishSafely(ctx);
}

async function reloadAfterKey(ctx: ServerContext): Promise<void> {
  const state = stateOf(ctx);
  state.timer = null;
  if (state.disposed) return;
  // The key may have been removed again while the timer waited.
  if (!isPresent((await ctx.settings.get()).openaiKey)) return;
  if (liveStatus(ctx).live) {
    fallBackToManualReload(ctx, "a call is live");
    return;
  }
  try {
    await ctx.bb.sdk.plugins.reload({ pluginId: PLUGIN_ID });
  } catch (error) {
    if (state.disposed) return;
    fallBackToManualReload(ctx, error instanceof Error ? error.message : "the reload failed");
  }
}

/**
 * Publish readiness once at load and after every settings change. When the
 * banner was set at this load and the key arrives, reload so the banner clears.
 */
export function registerReadiness(ctx: ServerContext): void {
  const state = stateOf(ctx);
  publishSafely(ctx);

  ctx.settings.onChange((next, prev) => {
    if (state.disposed) return;
    publishSafely(ctx, next);
    const keyArrived = !isPresent(prev.openaiKey) && isPresent(next.openaiKey);
    if (!ctx.needsConfiguration || !keyArrived || state.timer) return;
    // Defer so the host write or RPC that saved the key returns first.
    state.timer = setTimeout(() => {
      reloadAfterKey(ctx).catch((error: unknown) => {
        fallBackToManualReload(ctx, error instanceof Error ? error.message : "the reload failed");
      });
    }, RELOAD_DELAY_MS);
  });

  ctx.bb.onDispose(() => {
    state.disposed = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  });
}
