// The live session (SPEC §11.1, §5.4). Builds the one session body both
// transports use, creates WebRTC sessions, accepts SIP sessions, and keeps
// one call per BB server. The phone path uses buildPhoneSessionBody,
// acceptSipSession, publishStop, and onCallStop.
import { CHANNELS, ENDPOINTS } from "../shared/constants.js";
import type { CallChannel, CallControlPayload, DeviceProfile, RpcOutput, RpcParsedInput, ToolContext } from "../shared/contract.js";
import type { ServerContext } from "./context.js";
import { appendTrace, endCall, insertCall, openCalls } from "./ledger.js";
import { readPreferences } from "./preferences.js";
import { assemblePrompts } from "./prompts/index.js";
import { isPresent } from "./settings.js";
import { toFunctionTools } from "./tools/catalog.js";
import { toolCatalog } from "./tools/index.js";

/** OpenAI error bodies in thrown messages are clipped to this. */
export const OPENAI_ERROR_MAX = 300;

export const NO_KEY_ERROR = "Dispatch needs an OpenAI API key. Add it in Dispatch settings, Setup.";
export const PHONE_BUSY_ERROR = "A phone call is in progress. End it before you start a call in the app.";

/**
 * The session description. Both endpoints take it under a `session` key and
 * reject a `session.type` field (checked against the live API, 2026-10-19).
 */
export type SessionBody = {
  model: string;
  instructions: string;
  audio: { output: { voice: string } };
  delegation: {
    type: "responses";
    responses: {
      model: string;
      instructions: string;
      tools: ReturnType<typeof toFunctionTools>;
      tool_choice: "auto";
      parallel_tool_calls: true;
    };
  };
};

/**
 * The session body for one call. The phone channel never has a screen, so
 * its catalog is built without app tools and its runtime says "phone".
 */
export async function buildSessionBody(
  ctx: ServerContext,
  input: { channel: CallChannel; device: DeviceProfile; context: ToolContext; now?: Date },
): Promise<SessionBody> {
  const context: ToolContext = { ...input.context, channel: input.channel };
  const [preferences, prompts, tools] = await Promise.all([
    readPreferences(ctx),
    assemblePrompts(ctx, { context, device: input.device, ...(input.now ? { now: input.now } : {}) }),
    toolCatalog(ctx, { mobile: context.mobile, canNavigate: context.canNavigate, channel: input.channel }),
  ]);
  return {
    model: preferences.voiceModel,
    instructions: prompts.voice.assembled,
    audio: { output: { voice: preferences.voice } },
    delegation: {
      type: "responses",
      responses: {
        model: preferences.reasoningModel,
        instructions: prompts.backend.assembled,
        tools: toFunctionTools(tools),
        tool_choice: "auto",
        parallel_tool_calls: true,
      },
    },
  };
}

/** The phone session body (SIP accept). Same shape, no transport. */
export function buildPhoneSessionBody(ctx: ServerContext, now?: Date): Promise<SessionBody> {
  return buildSessionBody(ctx, {
    channel: "phone",
    device: PHONE_DEVICE,
    context: { threadId: null, projectId: null, onNewThreadScreen: false, mobile: false, canNavigate: false, channel: "phone" },
    ...(now ? { now } : {}),
  });
}

/** The device profile a phone call row carries. */
export const PHONE_DEVICE: DeviceProfile = {
  platform: "phone",
  mobile: false,
  browser: "none",
  displayMode: "none",
  runtime: "sip",
  label: "Phone",
  deviceName: "Phone",
};

// ---------------------------------------------------------------------------
// OpenAI requests. The key goes only into the Authorization header.

async function openaiKey(ctx: ServerContext): Promise<string> {
  const values = await ctx.settings.get();
  if (!isPresent(values.openaiKey)) throw new Error(NO_KEY_ERROR);
  return values.openaiKey.trim();
}

async function failure(response: Response): Promise<Error> {
  const text = await response.text().catch(() => "");
  const body = text.trim().slice(0, OPENAI_ERROR_MAX);
  return new Error(`OpenAI ${response.status}${body ? `: ${body}` : ""}`);
}

type CreatedSession = { sdp: string; sessionId: string };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const asString = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * Read the answer SDP and the session id. The JSON reply carries the SDP in
 * `transport.sdp` (or `transport.answer.sdp`, or `sdp`); a plain SDP reply
 * carries the id in the Location header.
 */
export async function parseCreatedSession(response: Response): Promise<CreatedSession> {
  const type = response.headers.get("content-type") ?? "";
  const location = response.headers.get("location");
  const idFromLocation = location ? (location.split("/").filter(Boolean).pop() ?? null) : null;
  let sdp: string | null = null;
  let sessionId: string | null = null;
  if (type.includes("application/sdp")) {
    sdp = asString(await response.text());
  } else {
    const json = asRecord(await response.json().catch(() => null));
    const transport = asRecord(json?.transport);
    sdp = asString(transport?.sdp) ?? asString(asRecord(transport?.answer)?.sdp) ?? asString(json?.sdp);
    sessionId = asString(json?.id) ?? asString(asRecord(json?.session)?.id);
  }
  sessionId ??= idFromLocation;
  if (!sdp) throw new Error("OpenAI did not return an answer for the call.");
  if (!sessionId) throw new Error("OpenAI did not return a session id for the call.");
  return { sdp, sessionId };
}

/** Create a WebRTC live session from the app's SDP offer. */
export async function createWebRtcSession(ctx: ServerContext, body: SessionBody, offerSdp: string): Promise<CreatedSession> {
  const key = await openaiKey(ctx);
  const response = await fetch(ENDPOINTS.liveSessions, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ session: body, transport: { type: "webrtc", sdp: offerSdp } }),
  });
  if (!response.ok) throw await failure(response);
  return parseCreatedSession(response);
}

/**
 * Accept an incoming SIP session (the phone path). Like the create
 * endpoint, it wants the body under a `session` key. SIP negotiates the
 * audio, so no transport goes in. Throws on a non-2xx reply.
 */
export async function acceptSipSession(ctx: ServerContext, sessionId: string, body: SessionBody): Promise<void> {
  const key = await openaiKey(ctx);
  const response = await fetch(ENDPOINTS.acceptSession(sessionId), {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ session: body }),
  });
  if (!response.ok) throw await failure(response);
}

// ---------------------------------------------------------------------------
// One call everywhere (SPEC §5.4)

type StopListener = (payload: CallControlPayload) => void;
const stopListeners = new Set<StopListener>();

/**
 * Listen for stop controls this server publishes. P3 uses it to hang up the
 * phone. Returns the unsubscribe function.
 */
export function onCallStop(listener: StopListener): () => void {
  stopListeners.add(listener);
  return () => stopListeners.delete(listener);
}

/**
 * Publish a stop control. Every realm whose call has a different nonce stops;
 * a null nonce stops everything.
 */
export function publishStop(ctx: ServerContext, payload: CallControlPayload): void {
  try {
    ctx.bb.realtime.publish(CHANNELS.callControl, payload);
  } catch (error) {
    ctx.bb.log.warn(`Dispatch could not publish the stop control: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  for (const listener of stopListeners) {
    try {
      listener(payload);
    } catch {
      // A listener failure must not block the stop.
    }
  }
}

/** Start an in-app call: stop the others, create the session, record the row. */
export async function openCall(ctx: ServerContext, input: RpcParsedInput<"openCall">): Promise<RpcOutput<"openCall">> {
  await openaiKey(ctx);
  const open = openCalls(ctx);
  if (open.some((call) => call.channel === "phone")) throw new Error(PHONE_BUSY_ERROR);

  publishStop(ctx, { action: "stop", nonce: input.nonce, reason: "replaced" });
  for (const call of open) {
    if (call.nonce !== input.nonce) endCall(ctx, call.id, { reason: "replaced" });
  }

  const context: ToolContext = { ...input.context, channel: "app" };
  const body = await buildSessionBody(ctx, { channel: "app", device: input.device, context });
  const created = await createWebRtcSession(ctx, body, input.sdp);
  const callId = insertCall(ctx, {
    channel: "app",
    device: input.device,
    openaiSessionId: created.sessionId,
    nonce: input.nonce,
    clientId: input.clientId,
    threadId: context.threadId,
    projectId: context.projectId,
  });
  appendTrace(ctx, callId, [
    {
      kind: "call.started",
      at: Date.now(),
      payload: {
        channel: "app",
        sessionId: created.sessionId,
        voiceModel: body.model,
        reasoningModel: body.delegation.responses.model,
        voice: body.audio.output.voice,
        tools: body.delegation.responses.tools.length,
        device: input.device.label,
      },
    },
  ]);
  return { sdp: created.sdp, sessionId: created.sessionId, callId };
}

/**
 * Stop calls. Without a nonce every open call ends and every realm stops.
 * With a nonce only that call's rows end, and the control still reaches
 * every realm so a frozen owner stops when it thaws.
 */
export function endCallsEverywhere(ctx: ServerContext, input: RpcParsedInput<"endCallsEverywhere">): RpcOutput<"endCallsEverywhere"> {
  const reason = input.reason?.trim() || "stopped";
  const open = openCalls(ctx);
  const targets = input.nonce ? open.filter((call) => call.nonce === input.nonce) : open;
  let stopped = false;
  for (const call of targets) {
    if (endCall(ctx, call.id, { reason })) {
      stopped = true;
      appendTrace(ctx, call.id, [{ kind: "call.stopped", at: Date.now(), payload: { reason } }]);
    }
  }
  publishStop(ctx, { action: "stop", nonce: null, reason });
  return { stopped };
}
