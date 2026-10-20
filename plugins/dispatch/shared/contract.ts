// The wire contract between the Dispatch server and the app (CONTRACTS §3–§6).
// Owned by P0. Change it only together with CONTRACTS.md.
// The server validates every RPC against these schemas. The app imports the
// contract type for `useRpc` and the shared types below.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  AGENT_NAME_MAX,
  CALLS_PAGE,
  INSTRUCTIONS_HISTORY_DEFAULT,
  INSTRUCTIONS_LIMIT,
  SECRET_IDS,
  TRACE_PAGE,
  USAGE_DAYS,
  type SecretId,
} from "./constants.js";

export type { SecretId };

// ---------------------------------------------------------------------------
// Shared shapes (CONTRACTS §3)

export const channelSchema = z.enum(["app", "phone"]);
export type CallChannel = z.infer<typeof channelSchema>;

export const toolContextSchema = z.object({
  threadId: z.string().nullable(),
  projectId: z.string().nullable(),
  onNewThreadScreen: z.boolean(),
  mobile: z.boolean(),
  canNavigate: z.boolean(),
  channel: channelSchema,
  /** `false` keeps the thread off screen. */
  focus: z.boolean().optional(),
});
export type ToolContext = z.infer<typeof toolContextSchema>;

export const deviceProfileSchema = z.object({
  platform: z.string(),
  mobile: z.boolean(),
  browser: z.string(),
  displayMode: z.string(),
  runtime: z.enum(["browser", "pwa", "native-webview", "sip"]),
  label: z.string(),
});
export type DeviceProfile = z.infer<typeof deviceProfileSchema>;

export const presencePhaseSchema = z.enum(["connecting", "live", "muted", "idle"]);
export type PresencePhase = z.infer<typeof presencePhaseSchema>;

export const agentCommandSchema = z.enum(["stop", "mute", "unmute"]);
export type AgentCommand = z.infer<typeof agentCommandSchema>;

// ---------------------------------------------------------------------------
// Preferences (CONTRACTS §4.1)

export const petLookSchema = z.object({
  style: z.enum(["outline", "solid"]),
  /** "theme" or a hex color. */
  color: z.string(),
  roundness: z.number().min(0).max(100),
  followPointer: z.boolean(),
  antennaFlash: z.boolean(),
});
export type PetLook = z.infer<typeof petLookSchema>;

export const pluginAccessSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }),
  z.object({ mode: z.literal("none") }),
  z.object({ mode: z.literal("selected"), ids: z.array(z.string()) }),
]);
export type PluginAccess = z.infer<typeof pluginAccessSchema>;

export const preferencesSchema = z.object({
  agentName: z.string().min(1).max(AGENT_NAME_MAX),
  voice: z.string(),
  voiceModel: z.string(),
  reasoningModel: z.string(),
  announcements: z.boolean(),
  mobileDrawerBehavior: z.enum(["reuse", "new"]),
  pluginAccess: pluginAccessSchema,
  hotkeys: z.object({ toggle: z.string(), mute: z.string() }),
  pet: petLookSchema,
});
export type Preferences = z.infer<typeof preferencesSchema>;

/**
 * `preferencesWrite` input. Only the top-level shape is checked here: P1's
 * normaliser owns clamping, enum fallback, and dropping unknown fields, so
 * values inside may still be out of range at runtime.
 */
const preferencesPatchSchema = z.looseObject({
  agentName: z.string().optional(),
  voice: z.string().optional(),
  voiceModel: z.string().optional(),
  reasoningModel: z.string().optional(),
  announcements: z.boolean().optional(),
  mobileDrawerBehavior: z.string().optional(),
  pluginAccess: z.looseObject({ mode: z.string() }).optional(),
  hotkeys: z.looseObject({}).optional(),
  pet: z.looseObject({}).optional(),
}) as unknown as z.ZodType<Partial<Preferences>>;

// ---------------------------------------------------------------------------
// Setup (CONTRACTS §3.4). Booleans and labels only, never a setup value.

export const secretIdSchema = z.enum(SECRET_IDS);

export const setupStatusSchema = z.object({
  fields: z.record(secretIdSchema, z.boolean()),
  /** Missing items as labels. */
  voice: z.object({ ready: z.boolean(), missing: z.array(z.string()) }),
  phone: z.object({
    ready: z.boolean(),
    missing: z.array(z.string()),
    webhooksPlugin: z.enum(["present", "absent"]),
  }),
  /** The needs-configuration banner was set at this load. */
  needsConfiguration: z.boolean(),
  /** The key arrived after load and the reload has not happened yet. */
  reloadPending: z.boolean(),
  version: z.string(),
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;

// ---------------------------------------------------------------------------
// Instructions and prompt (CONTRACTS §3.5)

export const instructionRevisionSchema = z.object({
  id: z.number().int(),
  at: z.number(),
  author: z.enum(["user", "agent", "import"]),
  note: z.string(),
  body: z.string(),
});
export type InstructionRevision = z.infer<typeof instructionRevisionSchema>;

export const promptPartsSchema = z.object({
  builtIn: z.string(),
  runtime: z.string(),
  yours: z.string(),
  assembled: z.string(),
});
export type PromptParts = z.infer<typeof promptPartsSchema>;

// ---------------------------------------------------------------------------
// Ledger rows (CONTRACTS §4.2, as the app sees them)

export const callRowSchema = z.object({
  id: z.string(),
  openaiSessionId: z.string().nullable(),
  channel: channelSchema,
  nonce: z.string().nullable(),
  clientId: z.string().nullable(),
  device: deviceProfileSchema,
  threadId: z.string().nullable(),
  projectId: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  closeReason: z.string().nullable(),
  billedSeconds: z.number(),
  unclean: z.boolean(),
});
export type CallRow = z.infer<typeof callRowSchema>;

const payloadSchema = z.record(z.string(), z.unknown());

export const traceRowSchema = z.object({
  id: z.number().int(),
  callId: z.string(),
  at: z.number(),
  kind: z.string(),
  payload: payloadSchema.nullable(),
});
export type TraceRow = z.infer<typeof traceRowSchema>;

export const traceEventSchema = z.object({ kind: z.string(), at: z.number(), payload: payloadSchema.optional() });
export type TraceEvent = z.infer<typeof traceEventSchema>;

/** Server-written trace kinds (CONTRACTS §4.3). */
export const SERVER_TRACE_KINDS = [
  "call.started",
  "call.closed",
  "call.stopped",
  "call.failed",
  "tool.call",
  "tool.result",
  "usage.seconds",
  "error",
  "notice",
] as const;
/** Client-written trace kinds (CONTRACTS §4.3). Imports add `legacy.<old kind>`. */
export const CLIENT_TRACE_KINDS = [
  "speech.user",
  "speech.agent",
  "composer",
  "send",
  "thread.focus",
  "client.ready",
  "conn.state",
  "conn.ice",
  "conn.channel",
  "audio.input",
  "audio.output",
  "page.visibility",
  "mic.track",
  "mic.suspended",
  "mic.recovered",
  "call.suspended",
  "mute",
  "nav.suppressed",
] as const;
export type TraceKind = (typeof SERVER_TRACE_KINDS)[number] | (typeof CLIENT_TRACE_KINDS)[number];

// ---------------------------------------------------------------------------
// Import (CONTRACTS §6)

export const importReportSchema = z.object({
  dryRun: z.boolean(),
  preferences: z.object({ imported: z.array(z.string()), dropped: z.array(z.string()), defaulted: z.array(z.string()) }),
  /** "invalid": present in the old config but failed the format check, so not copied. */
  secrets: z.record(secretIdSchema, z.enum(["copied", "absent", "invalid"])),
  instructions: z.object({ imported: z.union([z.literal(0), z.literal(1)]) }),
  calls: z.number().int(),
  traceEvents: z.number().int(),
  /** 0 unless `includeLegacyUsage`. */
  legacyTokenRows: z.number().int(),
  /** Human lines, for example "Legacy token usage skipped." */
  skipped: z.array(z.string()),
});
export type ImportReport = z.infer<typeof importReportSchema>;
/** KV value under `import.handsfree`. Its presence blocks a second import. */
export type ImportMarker = { at: number; report: ImportReport };

// ---------------------------------------------------------------------------
// Tool catalog entries (CONTRACTS §2, §3.2)

export const toolSpecSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** JSON Schema object for the arguments. */
  parameters: z.record(z.string(), z.unknown()),
  runsOn: z.enum(["app", "server", "both"]),
});
export type ToolSpec = z.infer<typeof toolSpecSchema>;

// ---------------------------------------------------------------------------
// RPC contract (CONTRACTS §3). Private: the app and the CLI call it.

const ok = z.object({ ok: z.literal(true) });
const empty = z.object({});
const presenceSchema = z.object({
  nonce: z.string(),
  phase: presencePhaseSchema,
  startedAt: z.number().nullable(),
  clientId: z.string(),
  realmId: z.string(),
});
export type Presence = z.infer<typeof presenceSchema>;

const liveStatusSchema = z.object({
  live: z.boolean(),
  channel: channelSchema.nullable(),
  startedAt: z.number().nullable(),
  device: deviceProfileSchema.nullable(),
});
export type LiveStatus = z.infer<typeof liveStatusSchema>;

export const phoneDialResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("placed"), callSid: z.string().optional(), detail: z.string() }),
  /** Missing items as labels. No call was attempted. */
  z.object({ status: z.literal("not-ready"), missing: z.array(z.string()) }),
  z.object({ status: z.literal("error"), detail: z.string() }),
]);
export type PhoneDialResult = z.infer<typeof phoneDialResultSchema>;

const usageReportSchema = z.object({
  days: z.number().int(),
  usdPerMinute: z.number(),
  rateCheckedOn: z.string(),
  perDay: z.array(z.object({ day: z.string(), seconds: z.number(), usd: z.number(), calls: z.number().int() })),
  totalSeconds: z.number(),
  totalUsd: z.number(),
  legacyTokenRows: z.number().int(),
});
export type UsageReport = z.infer<typeof usageReportSchema>;

const pageCursor = z.string().optional();

export const rpcContract = defineRpcContract({
  // §3.1 Calls
  openCall: {
    input: z.object({
      sdp: z.string(),
      nonce: z.string(),
      clientId: z.string(),
      realmId: z.string(),
      device: deviceProfileSchema,
      context: toolContextSchema,
    }),
    output: z.object({ sdp: z.string(), sessionId: z.string(), callId: z.string() }),
  },
  endCallsEverywhere: {
    input: z.object({ nonce: z.string().optional(), reason: z.string().optional() }),
    output: z.object({ stopped: z.boolean() }),
  },
  announcePresence: { input: presenceSchema, output: ok },
  /** Call owners answer on the `presence` channel. */
  pollPresence: { input: empty, output: ok },
  relayCommand: {
    input: z.object({ command: agentCommandSchema, nonce: z.string().optional() }),
    output: ok,
  },
  phoneDial: { input: empty, output: phoneDialResultSchema },

  // §3.2 Tools
  toolCatalog: {
    input: z.object({ mobile: z.boolean(), canNavigate: z.boolean(), channel: channelSchema }),
    output: z.object({ tools: z.array(toolSpecSchema) }),
  },
  toolInvoke: {
    input: z.object({
      callId: z.string(),
      name: z.string(),
      args: z.record(z.string(), z.unknown()),
      context: toolContextSchema,
    }),
    output: z.object({ output: z.string(), status: z.enum(["success", "error"]) }),
  },

  // §3.3 Trace and ledger
  traceAppend: {
    input: z.object({ callId: z.string(), events: z.array(traceEventSchema) }),
    output: ok,
  },
  callsPage: {
    input: z.object({
      cursor: pageCursor,
      limit: z.number().int().min(1).max(CALLS_PAGE.max).default(CALLS_PAGE.default),
      channel: channelSchema.optional(),
    }),
    output: z.object({ calls: z.array(callRowSchema), nextCursor: z.string().nullable() }),
  },
  callTrace: {
    input: z.object({
      callId: z.string(),
      cursor: pageCursor,
      limit: z.number().int().min(1).max(TRACE_PAGE.max).default(TRACE_PAGE.default),
    }),
    output: z.object({ events: z.array(traceRowSchema), nextCursor: z.string().nullable() }),
  },
  usageReport: {
    input: z.object({ days: z.number().int().min(1).max(USAGE_DAYS.max).default(USAGE_DAYS.default) }),
    output: usageReportSchema,
  },
  liveStatus: { input: empty, output: liveStatusSchema },

  // §3.4 Settings and setup
  preferencesRead: { input: empty, output: preferencesSchema },
  preferencesWrite: { input: preferencesPatchSchema, output: preferencesSchema },
  preferencesReset: { input: empty, output: preferencesSchema },
  setupStatus: { input: empty, output: setupStatusSchema },
  pluginsWithCommands: {
    input: empty,
    output: z.object({
      plugins: z.array(z.object({ id: z.string(), name: z.string(), command: z.string(), summary: z.string() })),
    }),
  },

  // §3.5 Instructions and prompt
  instructionsRead: {
    input: empty,
    output: z.object({ current: instructionRevisionSchema.nullable(), limit: z.literal(INSTRUCTIONS_LIMIT) }),
  },
  instructionsWrite: {
    input: z.object({ body: z.string(), note: z.string().optional() }),
    output: instructionRevisionSchema,
  },
  instructionsHistory: {
    input: z.object({ limit: z.number().int().min(1).max(500).default(INSTRUCTIONS_HISTORY_DEFAULT) }),
    output: z.object({ revisions: z.array(instructionRevisionSchema) }),
  },
  instructionsRestore: { input: z.object({ id: z.number().int() }), output: instructionRevisionSchema },
  promptPreview: {
    input: z.object({ context: toolContextSchema.partial().optional() }),
    output: z.object({ voice: promptPartsSchema, backend: promptPartsSchema }),
  },

  // §3.6 Threads, drawer, import
  drawerResolveThreads: {
    input: z.object({ threadIds: z.array(z.string()) }),
    output: z.object({
      views: z.array(z.object({ id: z.string(), title: z.string(), projectId: z.string().nullable() })),
      missing: z.array(z.string()),
    }),
  },
  importHandsfree: {
    input: z.object({ dryRun: z.boolean(), includeLegacyUsage: z.boolean() }),
    output: importReportSchema,
  },
});
export type RpcContract = typeof rpcContract;

/**
 * The method the Webhooks plugin calls. It is in its own contract because it
 * is the only discoverable method. The input is exactly what the Webhooks
 * plugin sends for a "plugin" action: verified, and reduced to the fields the
 * endpoint declares. Treat every field as untrusted data.
 */
export const RECEIVE_METHOD = "webhooks_receive";
/** Field names the Webhooks endpoint must declare (see docs/phone-calls.md). */
export const RECEIVE_FIELDS = { eventType: "type", sessionId: "session_id" } as const;
export const receiveContract = defineRpcContract({
  [RECEIVE_METHOD]: {
    input: z.object({
      endpointId: z.string(),
      endpointName: z.string(),
      deliveryId: z.string(),
      receivedAt: z.string(),
      idempotencyKey: z.string(),
      fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    }),
    output: z.object({ handled: z.boolean(), accepted: z.boolean().optional() }),
  },
});
export type ReceiveContract = typeof receiveContract;

export type RpcMethod = keyof RpcContract;
export type ReceiveMethod = keyof ReceiveContract;
/** Every RPC method name, in CONTRACTS order. */
export const METHOD_NAMES = Object.keys(rpcContract) as RpcMethod[];

type AnyContract = RpcContract & ReceiveContract;
/** What a caller sends. Fields with defaults are optional. */
export type RpcInput<M extends keyof AnyContract> = z.input<AnyContract[M]["input"]>;
/** What a handler receives, after defaults. */
export type RpcParsedInput<M extends keyof AnyContract> = z.output<AnyContract[M]["input"]>;
export type RpcOutput<M extends keyof AnyContract> = z.output<AnyContract[M]["output"]>;

// ---------------------------------------------------------------------------
// CLI JSON output (CONTRACTS §8). `usage --json` is RpcOutput<"usageReport">.

export type StatusJson = SetupStatus & { live: LiveStatus };
export type LiveJson = {
  threads: Array<{ id: string; title: string; status: string; projectName: string; machineName: string; since: number }>;
};

// ---------------------------------------------------------------------------
// Realtime payloads (CONTRACTS §5). Channel names are in constants.ts.

export type CallControlPayload = { action: "stop"; nonce: string | null; reason: string };
export type AgentCommandPayload = { command: AgentCommand; nonce: string | null };
export type ThreadNoticePayload = {
  kind: "finished" | "failed";
  threadId: string;
  title: string;
  detail: string;
  projectId: string | null;
};
export type TraceTailPayload = { callId: string; events: TraceRow[] };

export type RealtimePayloads = {
  "call-control": CallControlPayload;
  presence: Presence;
  "presence-ping": Record<string, never>;
  "agent-command": AgentCommandPayload;
  "thread-notice": ThreadNoticePayload;
  "trace-tail": TraceTailPayload;
  "preferences-updated": Preferences;
  "instructions-updated": InstructionRevision;
  "setup-updated": SetupStatus;
};
export type RealtimeChannel = keyof RealtimePayloads;
