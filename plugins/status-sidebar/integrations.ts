import type { BbPluginApi, PluginSettingDescriptors } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { INTEGRATIONS_CHANGED_CHANNEL } from "./shared";

const INTEGRATIONS_KEY = "status-sidebar.integrations";
export const integrationsSchema = z.object({
  agentsIntegration: z.boolean(),
  projectsIntegration: z.boolean(),
  tasksIntegration: z.boolean(),
}).strict();
export const integrationsPatchSchema = integrationsSchema.partial().strict();
export const integrationsViewSchema = z.object({ values: integrationsSchema, migrationPending: z.boolean() }).strict();
export type IntegrationPreferences = z.infer<typeof integrationsSchema>;
export type IntegrationPatch = z.infer<typeof integrationsPatchSchema>;
export type IntegrationView = z.infer<typeof integrationsViewSchema>;
export const DEFAULT_INTEGRATIONS: IntegrationPreferences = { agentsIntegration: false, projectsIntegration: false, tasksIntegration: false };

// Native settings can be read only while registered. Import once, then remove their editors on the next load.
const LEGACY_SETTINGS = {
  agentsIntegration: { type: "boolean", label: "Agents", default: false },
  projectsIntegration: { type: "boolean", label: "Projects", default: false },
  tasksIntegration: { type: "boolean", label: "Tasks", default: false },
} as const satisfies PluginSettingDescriptors;

export async function loadIntegrations(bb: BbPluginApi, changed: (next: IntegrationPreferences) => void) {
  let stored = await bb.storage.kv.get<unknown>(INTEGRATIONS_KEY);
  const migrationPending = stored === undefined;
  const legacy = migrationPending ? bb.settings.define(LEGACY_SETTINGS) : null;
  if (legacy) {
    stored = integrationsSchema.parse(await legacy.get());
    await bb.storage.kv.set(INTEGRATIONS_KEY, stored);
  }
  let current = integrationsSchema.parse(stored);
  let pending: Promise<unknown> = Promise.resolve();
  const update = (input: IntegrationPatch) => {
    const patch = integrationsPatchSchema.parse(input);
    const task = pending.then(async () => {
      const next = integrationsSchema.parse({ ...current, ...patch });
      await bb.storage.kv.set(INTEGRATIONS_KEY, next);
      current = next;
      changed(next);
      bb.realtime.publish(INTEGRATIONS_CHANGED_CHANNEL, null);
      return next;
    });
    pending = task.catch(() => {});
    return task;
  };
  legacy?.onChange((next, previous) => {
    const after = integrationsSchema.parse(next);
    const before = integrationsSchema.parse(previous);
    const patch = Object.fromEntries(Object.entries(after).filter(([key, value]) => value !== before[key as keyof IntegrationPreferences]));
    if (Object.keys(patch).length) void update(patch).catch(() => bb.log.error("Status Sidebar could not save migrated integration preferences. Retry before reloading."));
  });
  bb.onDispose(() => pending.then(() => {}));
  return { get: () => current, update, migrationPending };
}
