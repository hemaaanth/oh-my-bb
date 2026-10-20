// Preferences (CONTRACTS §4.1, SPEC §12.8). One KV value, normalised on every
// read and write. Owned by P1.
import { checkHotkey } from "../app/settings/hotkey.js";
import {
  AGENT_NAME_MAX,
  CHANNELS,
  DEFAULT_AGENT_NAME,
  KV_KEYS,
  MEMORY_RETENTION_DAYS,
  REASONING_MODELS,
  VOICES,
  VOICE_MODELS,
  defaultPreferences,
} from "../shared/constants.js";
import type { PetLook, PluginAccess, Preferences } from "../shared/contract.js";
import type { ServerContext } from "./context.js";

type Loose = Record<string, unknown>;

const isObject = (value: unknown): value is Loose => typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf = <T extends string>(options: readonly T[], value: unknown, fallback: T): T =>
  typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : fallback;
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

/** Trimmed, at most 24 characters, the default when empty (SPEC §1.1). */
export function normaliseAgentName(value: unknown, fallback: string = DEFAULT_AGENT_NAME): string {
  if (typeof value !== "string") return fallback;
  const name = value.trim().slice(0, AGENT_NAME_MAX).trim();
  return name === "" ? DEFAULT_AGENT_NAME : name;
}

/** A zone Intl knows, or "" for the server's zone. */
export function normaliseTimeZone(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const zone = value.trim();
  if (zone === "") return "";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return fallback;
  }
}

function normaliseRetention(value: unknown, fallback: number): number {
  return typeof value === "number" && (MEMORY_RETENTION_DAYS as readonly number[]).includes(value) ? value : fallback;
}

function normaliseAccess(value: unknown, fallback: PluginAccess): PluginAccess {
  if (!isObject(value)) return fallback;
  if (value.mode === "all" || value.mode === "none") return { mode: value.mode };
  if (value.mode !== "selected" || !Array.isArray(value.ids)) return fallback;
  const ids = value.ids.filter((id): id is string => typeof id === "string").map((id) => id.trim());
  return { mode: "selected", ids: [...new Set(ids.filter((id) => id !== ""))] };
}

function normaliseHotkeys(value: unknown, fallback: Preferences["hotkeys"]): Preferences["hotkeys"] {
  const raw = isObject(value) ? value : {};
  const pick = (input: unknown, previous: string): string => {
    if (typeof input !== "string") return previous;
    const check = checkHotkey(input);
    return check.ok ? check.combo : previous;
  };
  const toggle = pick(raw.toggle, fallback.toggle);
  const mute = pick(raw.mute, fallback.mute);
  if (toggle !== mute) return { toggle, mute };
  // Two actions cannot share a combination (P4 change 7). Keep the toggle.
  const defaults = defaultPreferences().hotkeys;
  return { toggle, mute: fallback.mute !== toggle ? fallback.mute : defaults.mute !== toggle ? defaults.mute : defaults.toggle };
}

function normaliseColor(value: unknown, fallback: string): string {
  if (value === "theme") return "theme";
  if (typeof value !== "string") return fallback;
  const hex = value.trim().toLowerCase();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(hex) ? hex : fallback;
}

function normalisePet(value: unknown, fallback: PetLook): PetLook {
  const raw = isObject(value) ? value : {};
  const roundness =
    typeof raw.roundness === "number" && Number.isFinite(raw.roundness)
      ? Math.round(Math.min(100, Math.max(0, raw.roundness)))
      : fallback.roundness;
  return {
    style: oneOf(["outline", "solid"], raw.style, fallback.style),
    color: normaliseColor(raw.color, fallback.color),
    roundness,
    followPointer: bool(raw.followPointer, fallback.followPointer),
    antennaFlash: bool(raw.antennaFlash, fallback.antennaFlash),
  };
}

/**
 * Build a full, valid Preferences object. Unknown fields are dropped. A field
 * that is missing or invalid keeps the value from `fallback`.
 */
export function normalisePreferences(raw: unknown, fallback: Preferences = defaultPreferences()): Preferences {
  const input = isObject(raw) ? raw : {};
  return {
    agentName: normaliseAgentName(input.agentName, fallback.agentName),
    voice: oneOf(VOICES, input.voice, fallback.voice as (typeof VOICES)[number]),
    voiceModel: oneOf(VOICE_MODELS, input.voiceModel, fallback.voiceModel as (typeof VOICE_MODELS)[number]),
    reasoningModel: oneOf(REASONING_MODELS, input.reasoningModel, fallback.reasoningModel as (typeof REASONING_MODELS)[number]),
    announcements: bool(input.announcements, fallback.announcements),
    mobileDrawerBehavior: oneOf(["reuse", "new"], input.mobileDrawerBehavior, fallback.mobileDrawerBehavior),
    callMemory: bool(input.callMemory, fallback.callMemory),
    memoryRetentionDays: normaliseRetention(input.memoryRetentionDays, fallback.memoryRetentionDays),
    homeTimeZone: normaliseTimeZone(input.homeTimeZone, fallback.homeTimeZone),
    pluginAccess: normaliseAccess(input.pluginAccess, fallback.pluginAccess),
    hotkeys: normaliseHotkeys(input.hotkeys, fallback.hotkeys),
    pet: normalisePet(input.pet, fallback.pet),
  };
}

export async function readPreferences(ctx: ServerContext): Promise<Preferences> {
  const stored = await ctx.bb.storage.kv.get<unknown>(KV_KEYS.preferences);
  // A stored value that went bad falls back to the defaults field by field.
  return normalisePreferences(stored ?? {});
}

async function save(ctx: ServerContext, next: Preferences): Promise<Preferences> {
  await ctx.bb.storage.kv.set(KV_KEYS.preferences, next);
  ctx.bb.realtime.publish(CHANNELS.preferencesUpdated, next);
  return next;
}

/** Merge a patch onto the saved preferences. Invalid values keep the saved value. */
export async function writePreferences(ctx: ServerContext, patch: unknown): Promise<Preferences> {
  const current = await readPreferences(ctx);
  const raw = isObject(patch) ? patch : {};
  const merged = {
    ...current,
    ...raw,
    hotkeys: { ...current.hotkeys, ...(isObject(raw.hotkeys) ? raw.hotkeys : {}) },
    pet: { ...current.pet, ...(isObject(raw.pet) ? raw.pet : {}) },
  };
  return save(ctx, normalisePreferences(merged, current));
}

/** Back to the defaults. Setup values and instructions are not touched. */
export async function resetPreferences(ctx: ServerContext): Promise<Preferences> {
  return save(ctx, defaultPreferences());
}
