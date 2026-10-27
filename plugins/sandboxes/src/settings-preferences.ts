import type { BbPluginApi, PluginSettingsValues } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { sandboxCredentialDescriptors, sandboxSettingDescriptors, sandboxIdleSleepOptions } from "./config.js";
import { sandboxSizeTierValues } from "./size-tiers.js";

export const sandboxPreferencesSchema = z.object({
  sshEnabled: z.boolean(),
  idleSleepAfter: z.enum(sandboxIdleSleepOptions),
  defaultSizeTier: z.enum(sandboxSizeTierValues),
  copyGitHubCliAuth: z.boolean(),
  browserUserAgent: z.string(),
  browserExitNode: z.string(),
  browserHomeEgressIp: z.string(),
  gitUsername: z.string(),
  browserTailscaleAuthKeyFile: z.string(),
  browserStateFile: z.string(),
}).strict();
export type SandboxPreferences = z.infer<typeof sandboxPreferencesSchema>;
export const sandboxPreferencesPatchSchema = z.object({ expectedRevision: z.number().int().nonnegative(), values: sandboxPreferencesSchema.partial() }).strict();
export const sandboxPreferencesViewSchema = z.object({ values: sandboxPreferencesSchema, revision: z.number().int().nonnegative(), migrationPending: z.boolean() });
export type SandboxPreferencesView = z.infer<typeof sandboxPreferencesViewSchema>;
const storedSchema = z.object({ values: sandboxPreferencesSchema.partial(), revision: z.number().int().nonnegative().default(0), layoutVersion: z.literal(2).optional(), receipt: z.object({ schemaVersion: z.literal(1), source: z.literal("native-settings"), completedAt: z.number() }).optional() });

/** Same-plugin one-generation migration; native secret identities stay native. */
export async function loadSandboxSettings(bb: BbPluginApi) {
  const { sshEnabled, idleSleepAfter, defaultSizeTier, copyGitHubCliAuth, browserUserAgent, browserExitNode, browserHomeEgressIp, gitUsername, browserTailscaleAuthKeyFile, browserStateFile, ...staticDescriptors } = sandboxSettingDescriptors;
  const credentials = bb.settings.define({ ...staticDescriptors, ...sandboxCredentialDescriptors });
  const legacyDescriptors = { sshEnabled, idleSleepAfter, defaultSizeTier, copyGitHubCliAuth, browserUserAgent, browserExitNode, browserHomeEgressIp, gitUsername, browserTailscaleAuthKeyFile, browserStateFile };
  const key = "preferences:v1";
  let stored = storedSchema.parse(await bb.storage.kv.get(key) ?? { values: {} });
  const migrationPending = stored.layoutVersion !== 2;
  const legacy = migrationPending ? bb.settings.define(legacyDescriptors) : null;
  if (legacy) {
    stored = { values: sandboxPreferencesSchema.parse({ ...await legacy.get(), ...stored.values }), revision: stored.revision + (stored.receipt ? 1 : 0), layoutVersion: 2, receipt: stored.receipt ?? { schemaVersion: 1, source: "native-settings", completedAt: Date.now() } };
    await bb.storage.kv.set(key, stored);
  }
  let current = sandboxPreferencesSchema.parse(stored.values);
  let revision = stored.revision;
  const receipt = stored.receipt;
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  let pending = Promise.resolve<unknown>(undefined);
  const view = (): SandboxPreferencesView => ({ values: current, revision, migrationPending });
  const update = (input: z.infer<typeof sandboxPreferencesPatchSchema>, legacyWrite = false) => {
    const patch = sandboxPreferencesPatchSchema.parse(input);
    const result = pending.then(async () => {
      if (!legacyWrite && patch.expectedRevision !== revision) throw new Error("Sandboxes preferences changed; reload before saving this draft");
      const next = sandboxPreferencesSchema.parse({ ...current, ...patch.values });
      if (Object.entries(patch.values).every(([name, value]) => current[name as keyof SandboxPreferences] === value)) return view();
      await bb.storage.kv.set(key, { values: next, revision: revision + 1, receipt, layoutVersion: 2 });
      current = next; revision++;
      changed(); bb.realtime.publish("sandbox-preferences", null);
      return view();
    });
    pending = result.catch(() => undefined);
    return result;
  };
  legacy?.onChange((next, previous) => {
    const values = Object.fromEntries(Object.entries(next).filter(([name, value]) => value !== previous[name as keyof typeof previous]));
    if (Object.keys(values).length) void update({ expectedRevision: revision, values }, true).catch(() => bb.log.error("Could not preserve native Sandboxes preferences; retry before finishing reload"));
  });
  credentials.onChange(changed);
  bb.onDispose(async () => { await pending; });
  return {
    get: async (): Promise<PluginSettingsValues<typeof sandboxSettingDescriptors> & PluginSettingsValues<typeof sandboxCredentialDescriptors>> => ({ ...await credentials.get(), ...current }),
    onChange: (listener: () => void) => { listeners.add(listener); },
    view,
    update,
  };
}
