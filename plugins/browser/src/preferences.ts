import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { browserSettingDescriptors, type BrowserSettings } from './config.js';

const KEY = 'browser.preferences';
export const PREFERENCES_CHANGED = 'browser-preferences';
export const preferencesSchema = z.object({
  sandboxesIntegration: z.boolean(),
  homeRouting: z.boolean(),
  sharePersonalLogins: z.boolean(),
  browserUserAgent: z.string(),
  browserExitNode: z.string(),
  browserHomeEgressIp: z.string(),
  fastRunner: z.boolean(),
  fastEndpoint: z.string(),
  fastModel: z.string(),
});
const patchSchema = preferencesSchema.partial().strict();
export type BrowserPreferences = z.infer<typeof preferencesSchema>;
export type BrowserPreferencesPatch = z.infer<typeof patchSchema>;
export type BrowserPreferencesView = { values: BrowserPreferences; migrationPending: boolean; fastApiKeyConfigured: boolean };
export const preferencesContract = defineRpcContract({
  browserPreferences: { input: z.null(), output: z.object({ values: preferencesSchema, migrationPending: z.boolean(), fastApiKeyConfigured: z.boolean() }) },
  updateBrowserPreferences: { input: patchSchema, output: z.object({ values: preferencesSchema, migrationPending: z.boolean(), fastApiKeyConfigured: z.boolean() }) },
});
export interface BrowserSettingsStore {
  migrationPending: boolean;
  get(): Promise<BrowserSettings>;
  set(patch: Partial<BrowserSettings>): Promise<void>;
  onChange(listener: () => void): void;
}

export async function loadBrowserSettings(bb: BbPluginApi): Promise<BrowserSettingsStore> {
  const { browserTailscaleAuthKey, browserTailscaleAuthKeyFile, browserStateFile, fastApiKey, ...legacyDescriptors } = browserSettingDescriptors;
  const credentials = bb.settings.define({ browserTailscaleAuthKey, browserTailscaleAuthKeyFile, browserStateFile, fastApiKey });
  let stored = await bb.storage.kv.get<unknown>(KEY);
  const migrationPending = stored === undefined;
  // Like Journal, read old native values for one generation, then retire their descriptors.
  const legacy = migrationPending ? bb.settings.define(legacyDescriptors) : null;
  if (legacy) {
    const saved = await legacy.get();
    stored = preferencesSchema.parse({ ...saved, sandboxesIntegration: saved.sandboxesIntegration ?? (saved.homeRouting || saved.sharePersonalLogins || !!await bb.storage.kv.get('migration-v1')) });
    await bb.storage.kv.set(KEY, stored);
  }
  let current = preferencesSchema.parse(stored);
  let pending: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  const update = (input: BrowserPreferencesPatch) => {
    const patch = patchSchema.parse(input);
    const task = pending.then(async () => {
      if ((patch.fastRunner === true || patch.fastEndpoint?.trim() || patch.fastModel?.trim()) && !(await credentials.get()).fastApiKey.trim()) throw new Error("Add a fast-task API key in Configuration first");
      const next = preferencesSchema.parse({ ...current, ...patch });
      await bb.storage.kv.set(KEY, next);
      current = next;
      changed();
      bb.realtime.publish(PREFERENCES_CHANGED, null);
      return next;
    });
    pending = task.catch(() => {});
    return task;
  };
  legacy?.onChange((next, previous) => {
    const patch = Object.fromEntries(Object.entries(next).filter(([key, value]) => Object.hasOwn(preferencesSchema.shape, key) && value !== undefined && value !== previous[key as keyof typeof previous]));
    if (Object.keys(patch).length) void update(patch).catch(() => bb.log.error('Browser could not save migrated preferences. Retry before reloading.'));
  });
  credentials.onChange(() => { changed(); bb.realtime.publish(PREFERENCES_CHANGED, null); });
  bb.onDispose(() => pending.then(() => {}));
  const view = async (): Promise<BrowserPreferencesView> => ({ values: current, migrationPending, fastApiKeyConfigured: !!(await credentials.get()).fastApiKey.trim() });
  bb.rpc.register(preferencesContract, {
    browserPreferences: view,
    updateBrowserPreferences: async patch => { await update(patch); return view(); },
  });
  return {
    migrationPending,
    get: async (): Promise<BrowserSettings> => ({ ...await credentials.get(), ...current }),
    set: async (patch: Partial<BrowserSettings>) => {
      const { browserTailscaleAuthKey, browserTailscaleAuthKeyFile, browserStateFile, fastApiKey, ...preferences } = patch;
      const secrets = Object.fromEntries(Object.entries({ browserTailscaleAuthKey, browserTailscaleAuthKeyFile, browserStateFile, fastApiKey }).filter(([, value]) => value !== undefined));
      if (Object.keys(secrets).length) await credentials.experimental_set(secrets);
      if (Object.keys(preferences).length) await update(preferences);
    },
    onChange: (listener: () => void) => { listeners.add(listener); },
  };
}
