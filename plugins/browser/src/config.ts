import type { PluginSettingsValues } from "@get-bb/plugin-sdk";

export const browserSettingDescriptors = {
  // No default distinguishes saved opt-outs from older installations.
  sandboxesIntegration: { type: "boolean", label: "Enable Sandboxes integration", description: "Adds managed provisioning and private desktop handoff." },
  homeRouting: { type: "boolean", label: "Route sandbox browsers through home", description: "Stops browsing if the home route is unavailable.", default: false },
  sharePersonalLogins: { type: "boolean", label: "Share personal logins with sandbox browsers", description: "New sessions only. Turning off does not sign out existing sessions.", default: false },
  browserUserAgent: { type: "string", label: "Browser user agent", default: "" },
  browserExitNode: { type: "string", label: "Home Tailscale exit node", default: "" },
  browserHomeEgressIp: { type: "string", label: "Required home public IPs", default: "" },
  browserTailscaleAuthKey: { type: "string", label: "Browser Tailscale key override", description: "Falls back to the key file, then the Sandboxes key.", secret: true, default: "" },
  browserTailscaleAuthKeyFile: { type: "string", label: "Private enrollment key file", default: "" },
  browserStateFile: { type: "string", label: "Optional authentication seed file", default: "" },
  legacyLiveSync: { type: "boolean", label: "Legacy continuous cookie sync", description: "Keeps cookies updated in legacy sessions.", default: false },
  fastRunner: { type: "boolean", label: "Allow bounded fast tasks", description: "Requires --allow-model. Sends page content to your configured model.", default: false },
  fastEndpoint: { type: "string", label: "Fast runner OpenAI-compatible HTTPS endpoint", default: "" },
  fastModel: { type: "string", label: "Fast runner provider/model", default: "" },
  fastApiKey: { type: "string", label: "Fast runner API key", secret: true, default: "" },
} as const;
export type BrowserSettings = PluginSettingsValues<typeof browserSettingDescriptors>;
