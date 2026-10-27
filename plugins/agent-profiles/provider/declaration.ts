import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import { PI_NATIVE_ROOTS_DECLARATION } from "./native-roots.js";

export function hempiProviderDeclaration(): PluginProviderDeclaration {
  return {
    id: "hempi",
    displayName: "Hempi",
    family: "agents",
    icon: "Users",
    strings: {
      signInHint: "Run `pi` on the machine to sign in.",
      expiredHint: "Your Pi session expired. Run `pi`, then reload.",
      installUrl: "https://pi.dev",
      iconTint: { light: "#6D5DFB", dark: "#6D5DFB" },
    },
    // Hempi and Agents stay out of the model picker: agents are opened from the Bots tab, and Hempi
    // only supplies the real models behind them. BB lists an "installed" provider only where its
    // health probe reports it, and this bridge answers that probe as unsupported. Threads and model
    // lookups that name the provider still reach it. The `pi` update is left to BB's own Pi provider.
    experimental_visibility: "installed",
    maintenance: { health: true, usage: false, installation: false },
    env: { passthrough: ["BB_PI_BRIDGE_COMMAND", "BB_PI_BRIDGE_ARGS"] },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "checkpoint",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["full"],
      reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    },
    reasoningLevels: [
      { id: "none", label: "None" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      { id: "max", label: "Max" },
    ],
    ...PI_NATIVE_ROOTS_DECLARATION,
    composerActions: [],
  };
}
