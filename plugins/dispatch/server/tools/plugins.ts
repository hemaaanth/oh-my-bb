// Which plugin commands the agent may run (SPEC §12.6). Owned by P1.
import { PLUGIN_ID } from "../../shared/constants.js";
import type { PluginAccess } from "../../shared/contract.js";
import type { ServerContext } from "../context.js";

type Sdk = ServerContext["bb"]["sdk"];
export type PluginRow = Awaited<ReturnType<Sdk["plugins"]["list"]>>["plugins"][number];

export type CommandPlugin = { id: string; name: string; command: string; summary: string };

/** Enabled, running, has a CLI command, and is not Dispatch itself. */
export function hasUsableCommand(plugin: PluginRow): boolean {
  return plugin.enabled && plugin.status === "running" && plugin.cliCommand !== null && plugin.id !== PLUGIN_ID;
}

export function allowedByAccess(id: string, access: PluginAccess): boolean {
  if (access.mode === "all") return true;
  if (access.mode === "none") return false;
  return access.ids.includes(id);
}

const toCommandPlugin = (plugin: PluginRow): CommandPlugin => ({
  id: plugin.id,
  name: plugin.name ?? plugin.id,
  command: plugin.cliCommand?.name ?? "",
  summary: plugin.cliCommand?.summary ?? "",
});

/** Every plugin that could be offered, before the access setting. Sorted by name. */
export function commandPlugins(plugins: readonly PluginRow[]): CommandPlugin[] {
  return plugins
    .filter(hasUsableCommand)
    .map(toCommandPlugin)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The plugins the agent may run under the access setting. */
export function exposedPlugins(plugins: readonly PluginRow[], access: PluginAccess): CommandPlugin[] {
  return commandPlugins(plugins).filter((plugin) => allowedByAccess(plugin.id, access));
}

/** Read the plugin list. A failure means no plugin commands, never a broken session. */
export async function listPlugins(ctx: ServerContext): Promise<PluginRow[]> {
  try {
    return (await ctx.bb.sdk.plugins.list()).plugins;
  } catch (error) {
    ctx.bb.log.warn(`Dispatch could not list plugins: ${error instanceof Error ? error.message : "unknown error"}`);
    return [];
  }
}
