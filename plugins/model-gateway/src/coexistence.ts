// New in the gateway: plan decision 8.1 (S5). While the core Account Pooler
// plugin is installed and enabled, the gateway must not contribute env or
// claim provider health for the providers the Pooler routes, since only one
// plugin's contributeEnv entries win a name collision (first-loaded plugin),
// and the Pooler's own env entries must not be shadowed or duplicated.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const ACCOUNT_POOL_PLUGIN_ID = "account-pool";
export const ACCOUNT_POOL_BLOCKED_LABEL =
  "Gateway: blocked by Account Pooler routing";
export const ACCOUNT_POOL_BLOCKED_STATUS_MESSAGE =
  "The Account Pooler plugin is installed and enabled. Disable it to route through the Model Gateway instead.";

export async function isAccountPoolRouting(
  bb: Pick<BbPluginApi, "sdk">,
): Promise<boolean> {
  const installed = await bb.sdk.plugins.list();
  return installed.plugins.some(
    (plugin) => plugin.id === ACCOUNT_POOL_PLUGIN_ID && plugin.enabled,
  );
}
