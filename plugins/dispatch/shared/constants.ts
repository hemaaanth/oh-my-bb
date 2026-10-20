// Fixed values that the server, the voice runtime, and the app all read.
// Owned by P0. Add a constant here only when two packages need it.
import type { Preferences } from "./contract.js";

export const PLUGIN_ID = "dispatch";
/** Equals `version` in package.json. A test keeps them in step. */
export const DISPATCH_VERSION = "0.2.0";
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

/** A voice the picker lists. `region` and `presentation` are null where the docs give none. */
export type VoiceOption = {
  name: string;
  label: string;
  language: string | null;
  region: string | null;
  presentation: "Feminine" | "Masculine" | null;
  group: (typeof VOICE_GROUPS)[number];
};
export const VOICE_GROUPS = ["GPT-Live", "Realtime (unconfirmed)"] as const;
const live = (name: string, language: string | null, region: string | null, presentation: VoiceOption["presentation"]): VoiceOption => ({
  name,
  label: name.charAt(0).toUpperCase() + name.slice(1),
  language,
  region,
  presentation,
  group: "GPT-Live",
});
const realtime = (name: string): VoiceOption => ({ ...live(name, null, null, null), group: "Realtime (unconfirmed)" });
/**
 * GPT-Live voices from the OpenAI voice table (checked 2026-10-20), then the
 * GPT-Live default `marin`. The Realtime voices are not in the GPT-Live table;
 * the picker lists them apart because GPT-Live may refuse them.
 */
export const VOICE_OPTIONS: readonly VoiceOption[] = [
  live("quartz", "English", "Australian", "Feminine"),
  live("ripple", "English", "Australian", "Masculine"),
  live("vesper", "English", "British", "Masculine"),
  live("willow", "English", "Irish", "Feminine"),
  live("stone", "English", "Irish", "Masculine"),
  live("gleam", "English", "North American", "Feminine"),
  live("meridian", "English", "North American", "Masculine"),
  live("bossa", "Portuguese", "Brazilian", "Feminine"),
  live("tempo", "Portuguese", "Brazilian", "Masculine"),
  live("beacon", "English", "Filipino", "Masculine"),
  live("delta", "English", "Southern U.S.", "Feminine"),
  live("cinder", "English", "Southern U.S.", "Masculine"),
  live("nuri", "German", null, "Feminine"),
  live("juni", "German", null, "Feminine"),
  live("flitz", "German", null, "Masculine"),
  live("brise", "French", null, "Feminine"),
  live("sillage", "French", null, "Masculine"),
  live("nira", "Hindi", null, "Feminine"),
  live("harema", "Japanese", null, "Feminine"),
  live("shida", "Japanese", null, "Masculine"),
  live("noeul", "Korean", null, "Feminine"),
  live("marin", null, null, null),
  ...["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "cedar"].map(realtime),
];
export const VOICE_NAMES: readonly string[] = VOICE_OPTIONS.map((voice) => voice.name);
/** Custom voice ids from `POST /v1/audio/voices` start with this. */
export const CUSTOM_VOICE_PREFIX = "voice_";
export const CUSTOM_VOICE_NAME_MAX = 60;
export const CUSTOM_VOICE_PROMPT_MAX = 1000;
/** The example description from the OpenAI prompt-to-voice docs. */
export const CUSTOM_VOICE_EXAMPLE =
  "A calm, reassuring adult voice for a customer support assistant. Speak with an American English accent, a mid-range pitch, a smooth, warm tone, and a steady, conversational pace.";

/** Voice style choices. GPT-Live has no speed or tone fields, so each choice is a sentence in the instructions. */
export const VOICE_STYLE_CHOICES = {
  pace: ["slower", "natural", "faster", "brisk"],
  energy: ["calm", "neutral", "warm", "upbeat"],
  expressiveness: ["flat", "balanced", "expressive"],
  length: ["terse", "balanced", "chatty"],
  backchannels: ["few", "moderate", "frequent"],
} as const;
export const VOICE_STYLE_NOTES_MAX = 500;

/** Voice samples: one short client-mode session per new voice and style. */
export const VOICE_SAMPLE = {
  text: "Quick update: the thread Fix the header finished. It changed two files, and all the tests pass. Do you want me to open it?",
  /** Hard stop for one sample session. */
  capMs: 15_000,
  /** The agent has finished speaking when no audio arrives for this long. */
  quietMs: 1_500,
  /** Wait this long for session.closed before the socket is released anyway. */
  closeMs: 2_000,
  /** Samples kept in the plugin database. The oldest used go first. */
  cacheBytes: 8 * 1024 * 1024,
  rate: 24_000,
} as const;

export const VOICE_MODELS = ["gpt-live-1"] as const;
/** The first entry is the default, shown as "recommended". */
export const REASONING_MODELS = ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"] as const;

export const DEFAULT_AGENT_NAME = "Juno";

/** Days a call's transcript and summary are kept. 0 keeps them forever. */
export const MEMORY_RETENTION_DAYS = [30, 90, 365, 0] as const;
export const DEFAULT_MEMORY_RETENTION_DAYS = 90;
/** Size limits for call memory. */
export const CALL_MEMORY = {
  titleMax: 80,
  summaryMax: 600,
  topicsMax: 8,
  /** The "# Recent calls" prompt section, in characters. */
  promptMax: 1500,
  promptCalls: 5,
  recallDefault: 5,
  recallMax: 20,
  /** Calls without a summary retried on load, newest first. */
  retryMax: 10,
  /** The transcript and tool trace sent to the summary model, in characters. */
  inputMax: 24000,
  /** read.calls window, in days. */
  readMaxDays: 62,
} as const;

/** Preference defaults (CONTRACTS §4.1). Returns a fresh object each call. */
export const defaultPreferences = (): Preferences => ({
  agentName: DEFAULT_AGENT_NAME,
  voice: "gleam",
  voiceModel: "gpt-live-1",
  reasoningModel: "gpt-5.6-terra",
  announcements: true,
  mobileDrawerBehavior: "reuse",
  callMemory: true,
  memoryRetentionDays: DEFAULT_MEMORY_RETENTION_DAYS,
  homeTimeZone: "",
  pluginAccess: { mode: "all" },
  hotkeys: { toggle: "Mod+Shift+H", mute: "Mod+Shift+U" },
  pet: { style: "outline", color: "theme", roundness: 50, followPointer: true, antennaFlash: false },
  voiceStyle: { pace: "natural", energy: "neutral", expressiveness: "balanced", length: "balanced", backchannels: "moderate", notes: "" },
  customVoices: [],
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
  responses: `${OPENAI_API}/responses`,
  sipTarget: (project: string) => `sip:${project}@sip.api.openai.com;transport=tls;secure=true`,
  voices: `${OPENAI_API}/audio/voices`,
  liveSocket: "wss://api.openai.com/v1/live/sessions",
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
