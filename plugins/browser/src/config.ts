import type { PluginSettingsValues } from "@get-bb/plugin-sdk";

export const browserSettingDescriptors = {
  homeRouting: { type: "boolean", label: "Route sandbox browsers through home", description: "Use the home Tailscale exit node for every sandbox. If it is unavailable, browsing stops; traffic never falls back to the sandbox IP.", default: false },
  sharePersonalLogins: { type: "boolean", label: "Share personal logins with sandbox browsers", description: "Seed new isolated browser sessions from your paired browser or authentication seed file, across all projects. Turning this off stops future sharing; existing sessions keep their logins.", default: false },
  browserUserAgent: { type: "string", label: "Browser user agent", default: "" },
  browserExitNode: { type: "string", label: "Home Tailscale exit node", default: "" },
  browserHomeEgressIp: { type: "string", label: "Required home public IPs", default: "" },
  browserTailscaleAuthKey: { type: "string", label: "Browser Tailscale key override", description: "Optional. Sandboxes integration uses its existing Tailscale enrollment key when this and the private key file are empty.", secret: true, default: "" },
  browserTailscaleAuthKeyFile: { type: "string", label: "Private enrollment key file", default: "" },
  browserStateFile: { type: "string", label: "Optional authentication seed file", default: "" },
  legacyLiveSync: { type: "boolean", label: "Legacy continuous cookie sync", description: "Compatibility mode. Isolated sessions receive a one-time seed and own later changes.", default: false },
  fastRunner: { type: "boolean", label: "Allow bounded fast tasks", description: "Off by default. Each task also requires --allow-model. Page observations are sent to the endpoint and model below; credentials stay on the BB server.", default: false },
  fastEndpoint: { type: "string", label: "Fast runner OpenAI-compatible HTTPS endpoint", default: "" },
  fastModel: { type: "string", label: "Fast runner provider/model", default: "" },
  fastApiKey: { type: "string", label: "Fast runner API key", secret: true, default: "" },
} as const;
export type BrowserSettings = PluginSettingsValues<typeof browserSettingDescriptors>;
