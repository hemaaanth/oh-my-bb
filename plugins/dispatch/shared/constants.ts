// Fixed values that the server, the voice runtime, and the app all read.
// Owned by P0. Add a constant here only when two packages need it.
import type { Preferences } from "./contract.js";

export const PLUGIN_ID = "dispatch";
/** Equals `version` in package.json. A test keeps them in step. */
export const DISPATCH_VERSION = "0.1.1";
export const CLI_COMMAND = "dispatch";

/** Setup values, in the order the host form shows them (CONTRACTS §7). */
export const SECRET_IDS = [
  "openaiKey",
  "twilioSid",
  "twilioToken",
  "twilioCallerNumber",
  "yourPhoneNumber",
  "openaiSipProject",
] as const;
export type SecretId = (typeof SECRET_IDS)[number];

/** Host form labels. The mode prefix groups the flat form. Readiness reports these, never ids. */
export const SETUP_LABELS: Readonly<Record<SecretId, string>> = {
  openaiKey: "In-app voice — OpenAI API key",
  twilioSid: "Phone calls — Twilio Account SID",
  twilioToken: "Phone calls — Twilio Auth Token",
  twilioCallerNumber: "Phone calls — Twilio caller number",
  yourPhoneNumber: "Phone calls — your phone number",
  openaiSipProject: "Phone calls — OpenAI project id for SIP",
};
export const VOICE_SECRET_IDS = ["openaiKey"] as const satisfies readonly SecretId[];
/** Phone calls need every setup value, the OpenAI key included. */
export const PHONE_SECRET_IDS = SECRET_IDS;
/** Readiness lists this after the field labels when the Webhooks plugin is absent. */
export const WEBHOOK_ROUTE_LABEL = "webhook route";

export const AGENT_NAME_MAX = 24;
export const INSTRUCTIONS_LIMIT = 4000;
export const INSTRUCTIONS_HISTORY_DEFAULT = 50;
export const TOOL_OUTPUT_TRACE_MAX = 4000;
export const CALLS_PAGE = { default: 50, max: 100 } as const;
export const TRACE_PAGE = { default: 200, max: 500 } as const;
export const USAGE_DAYS = { default: 30, max: 365 } as const;
export const LIST_THREADS = { default: 15, max: 100 } as const;

/**
 * GPT-Live voices. P0 assumption: the spec says "twelve" and names only
 * "gleam". P1 checks this list against the OpenAI docs and corrects it here.
 */
export const VOICES = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "gleam",
  "marin",
  "nova",
  "sage",
  "shimmer",
  "verse",
] as const;
export const VOICE_MODELS = ["gpt-live-1"] as const;
/** The first entry is the default, shown as "recommended". */
export const REASONING_MODELS = ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"] as const;

export const DEFAULT_AGENT_NAME = "Juno";

/** Preference defaults (CONTRACTS §4.1). Returns a fresh object each call. */
export const defaultPreferences = (): Preferences => ({
  agentName: DEFAULT_AGENT_NAME,
  voice: "gleam",
  voiceModel: "gpt-live-1",
  reasoningModel: "gpt-5.6-terra",
  announcements: true,
  mobileDrawerBehavior: "reuse",
  pluginAccess: { mode: "all" },
  hotkeys: { toggle: "Mod+Shift+H", mute: "Mod+Shift+U" },
  pet: { style: "outline", color: "theme", roundness: 50, followPointer: true, antennaFlash: false },
});

/** GPT-Live audio price. Reasoning tokens are billed separately and not counted. */
export const LIVE_USD_PER_MINUTE = 0.05;
export const LIVE_RATE_CHECKED_ON = "2026-10-19";

export const OPENAI_API = "https://api.openai.com/v1";
export const ENDPOINTS = {
  liveSessions: `${OPENAI_API}/live/sessions`,
  acceptSession: (sessionId: string) => `${OPENAI_API}/live/sessions/${encodeURIComponent(sessionId)}/accept`,
  hangupSession: (sessionId: string) => `${OPENAI_API}/live/sessions/${encodeURIComponent(sessionId)}/hangup`,
  attachSession: (sessionId: string) => `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`,
  twilioCalls: (accountSid: string) =>
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`,
  sipTarget: (project: string) => `sip:${project}@sip.api.openai.com;transport=tls;secure=true`,
} as const;

/** Sent as a system notice when a call connects, so the owner hears it is ready. */
export const GREETING_NOTICE =
  "The call just connected. Greet the owner in one short, casual sentence and ask what they want to work on. Do not call tools first.";

/** The Webhooks plugin from oh-my-bb, an optional partner for phone calls. */
export const WEBHOOKS_PLUGIN_ID = "webhooks";

/** Plugin KV keys (CONTRACTS §4.1). */
export const KV_KEYS = {
  preferences: "preferences",
  schemaVersion: "schema.version",
} as const;
export const SCHEMA_VERSION = 1;

/** The only localStorage keys Dispatch uses (CONTRACTS §4.4). */
export const LOCAL_KEYS = {
  clientId: "dispatch.client-id",
  audio: "dispatch.audio",
  pointerGhost: "dispatch.pointer-ghost",
} as const;

/** Realtime channel names (CONTRACTS §5). Payload types are in contract.ts. */
export const CHANNELS = {
  callControl: "call-control",
  presence: "presence",
  presencePing: "presence-ping",
  agentCommand: "agent-command",
  threadNotice: "thread-notice",
  traceTail: "trace-tail",
  preferencesUpdated: "preferences-updated",
  instructionsUpdated: "instructions-updated",
  setupUpdated: "setup-updated",
} as const;

/** Shortcuts BB already uses. The recorder refuses them and names the owner. */
export const RESERVED_HOTKEYS: Readonly<Record<string, string>> = {
  "Mod+Shift+P": "the BB command palette",
  "Mod+Shift+M": "the BB model picker",
};

export const PET_MOODS = [
  "asleep",
  "waking",
  "awake",
  "listening",
  "talking",
  "looking",
  "reading",
  "searching",
  "typing",
  "sending",
  "working",
  "done",
  "failed",
] as const;
export type PetMood = (typeof PET_MOODS)[number];
