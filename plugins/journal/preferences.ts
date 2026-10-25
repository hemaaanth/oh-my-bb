import type { BbPluginApi, PluginSettingDescriptors } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { AI_BACKENDS, DEFAULT_WORK_TIME_ZONE, GATEWAY_MODELS, PREFERENCES_CHANGED } from "./shared";

export const DEFAULT_OPENROUTER_MODEL = "google/gemini-3.1-flash-lite-preview";
const PREFERENCES_KEY = "journal.preferences";
const timeZoneSchema = z.string().refine((value) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
}, "Enter an IANA timezone such as America/New_York");

export const preferencesSchema = z.object({
  aiBackend: z.enum(AI_BACKENDS),
  gatewayModel: z.enum(GATEWAY_MODELS),
  openRouterModel: z.string(),
  intelligenceEnabled: z.boolean(),
  automaticDailyBudgetUsd: z.number().finite().min(0).max(100),
  workTimeZone: timeZoneSchema,
  showDispatchCalls: z.boolean(),
});
export const preferencesPatchSchema = preferencesSchema.partial().strict();
export type JournalPreferences = z.infer<typeof preferencesSchema>;
export type JournalPreferencesPatch = z.infer<typeof preferencesPatchSchema>;
export interface JournalPreferencesView { values: JournalPreferences; migrationPending: boolean }

// The SDK reads old native values only while their descriptors are registered.
// Register them for the import generation only; the next load has a key-only form.
const LEGACY_SETTINGS = {
  aiBackend: { type: "select", label: "AI backend", options: [...AI_BACKENDS], default: "openrouter" },
  gatewayModel: { type: "select", label: "Subscription model", options: [...GATEWAY_MODELS], default: GATEWAY_MODELS[0] },
  openRouterModel: { type: "string", label: "OpenRouter model", default: DEFAULT_OPENROUTER_MODEL },
  intelligenceEnabled: { type: "boolean", label: "Intelligent summaries", default: true },
  automaticDailyBudgetUsd: { type: "number", label: "Automatic AI budget (USD/day)", default: 0.50,
    experimental_schema: z.number().finite().min(0).max(100) },
  workTimeZone: { type: "string", label: "Work day timezone", default: DEFAULT_WORK_TIME_ZONE,
    experimental_schema: timeZoneSchema },
  showDispatchCalls: { type: "boolean", label: "Show Dispatch calls", default: false },
} as const satisfies PluginSettingDescriptors;

export async function loadPreferences(bb: BbPluginApi, changed: (next: JournalPreferences, previous: JournalPreferences) => void) {
  let stored = await bb.storage.kv.get<unknown>(PREFERENCES_KEY);
  const migrationPending = stored === undefined;
  const legacy = migrationPending ? bb.settings.define(LEGACY_SETTINGS) : null;
  if (legacy) {
    stored = preferencesSchema.parse(await legacy.get());
    await bb.storage.kv.set(PREFERENCES_KEY, stored);
  }
  let current = preferencesSchema.parse(stored);
  let pending: Promise<unknown> = Promise.resolve();
  const update = (input: JournalPreferencesPatch) => {
    const patch = preferencesPatchSchema.parse(input);
    const task = pending.then(async () => {
      const next = preferencesSchema.parse({ ...current, ...patch });
      await bb.storage.kv.set(PREFERENCES_KEY, next);
      const previous = current;
      current = next;
      changed(next, previous);
      bb.realtime.publish(PREFERENCES_CHANGED, next);
      return next;
    });
    pending = task.catch(() => {});
    return task;
  };
  // Preserve native edits made before the one-time finishing reload as well.
  legacy?.onChange((next, previous) => {
    const after = preferencesSchema.parse(next); const before = preferencesSchema.parse(previous);
    const patch = Object.fromEntries(Object.entries(after).filter(([key, value]) => value !== before[key as keyof JournalPreferences]));
    if (Object.keys(patch).length) void update(patch).catch(() => bb.log.error("Journal could not persist migrated preferences. Retry the settings change before reloading."));
  });
  bb.onDispose(() => pending.then(() => {}));
  return { get: () => current, update, migrationPending };
}
