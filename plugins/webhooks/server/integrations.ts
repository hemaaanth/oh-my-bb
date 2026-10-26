import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ActionSpec, IntegrationView } from "../contract.js";
import { AUTOMATIONS_PLUGIN_ID, TargetError, listReceivers } from "./actions.js";
import type { Store } from "./store.js";

const KEY = "enabled-integrations";

export interface Integrations {
  list(): Promise<IntegrationView[]>;
  check(action: ActionSpec): void;
  setEnabled(pluginId: string, enabled: boolean): Promise<void>;
}

/** Local preferences only at startup; discover other plugins on user request. */
export async function createIntegrations(bb: BbPluginApi, store: Store, changed: () => void): Promise<Integrations> {
  const stored = await bb.storage.kv.get<unknown>(KEY);
  // Upgrade without breaking saved hooks. Fresh installations opt in explicitly.
  let enabled = new Set(stored === undefined ? store.endpoints().flatMap((endpoint) => {
    const action = endpoint.config.action;
    return action.type === "plugin" ? [action.pluginId] : action.type === "automation" ? [AUTOMATIONS_PLUGIN_ID] : [];
  }) : z.array(z.string()).parse(stored));
  if (stored === undefined) await bb.storage.kv.set(KEY, [...enabled]);
  let saving = Promise.resolve();

  async function list(): Promise<IntegrationView[]> {
    const [installed, receivers] = await Promise.all([bb.sdk.plugins.list(), listReceivers(bb)]);
    return installed.plugins.flatMap((plugin): IntegrationView[] => {
      if (!plugin.enabled || !["running", "degraded", "needs-configuration"].includes(plugin.status)) return [];
      const receiver = receivers.find((entry) => entry.pluginId === plugin.id);
      if (receiver) return [{ ...receiver, kind: "receiver", enabled: enabled.has(plugin.id) }];
      if (plugin.id === AUTOMATIONS_PLUGIN_ID) {
        return [{ pluginId: plugin.id, name: plugin.name ?? plugin.id, description: plugin.description, kind: "automation", enabled: enabled.has(plugin.id) }];
      }
      return [];
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    list,
    check(action: ActionSpec) {
      const id = action.type === "plugin" ? action.pluginId : action.type === "automation" ? AUTOMATIONS_PLUGIN_ID : null;
      if (id && !enabled.has(id)) throw new TargetError(`Integration "${id}" is disabled. Enable it in Webhooks settings → Oh My BB.`);
    },
    setEnabled(pluginId: string, value: boolean) {
      const save = saving.then(async () => {
        if (value && !(await list()).some((entry) => entry.pluginId === pluginId)) {
          throw new TargetError(`Plugin "${pluginId}" is not available as a Webhooks integration. Install and enable it first.`);
        }
        const next = new Set(enabled);
        if (value) next.add(pluginId);
        else next.delete(pluginId);
        await bb.storage.kv.set(KEY, [...next]);
        enabled = next;
        changed();
      });
      // Serialize preference writes without preventing later changes after a failure.
      saving = save.catch(() => {});
      return save;
    },
  };
}

