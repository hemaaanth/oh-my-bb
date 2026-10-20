// Phone calls (SPEC §10). Dispatch only handles signalling: place the call at
// Twilio, accept the SIP session at OpenAI, and run the tool loop over the
// session's sideband WebSocket. OpenAI hosts the audio.
// Owned by P3. Adapted from the owner's telephony module; the session body,
// the ledger, and the tool executor come from the P1 core.
import { ENDPOINTS, GREETING_NOTICE, WEBHOOKS_PLUGIN_ID } from "../shared/constants.js";
import type { PhoneDialResult, ToolContext } from "../shared/contract.js";
import { TranscriptGrouper, speechKind } from "../shared/transcript.js";
import type { ServerContext } from "./context.js";
import { appendTrace, endCall, insertCall, openCalls } from "./ledger.js";
import { PHONE_DEVICE, acceptSipSession, buildPhoneSessionBody, onCallStop, publishStop } from "./live-session.js";
import { readSetupStatus } from "./readiness.js";
import { isPresent } from "./settings.js";
import { executeServerTool } from "./tools/index.js";

/** Twilio and OpenAI error bodies in results are clipped to this. */
export const BODY_CLIP = 300;
/** After a hang-up, wait this long for `session.closed` (final usage), then close the socket. */
export const HANGUP_GRACE_MS = 5000;

export const INCOMING_EVENT_TYPE = "live.transport.incoming";

/** The tool context a phone call runs with: no screen, no navigation. */
export const PHONE_TOOL_CONTEXT: ToolContext = {
  threadId: null,
  projectId: null,
  onNewThreadScreen: false,
  mobile: false,
  canNavigate: false,
  channel: "phone",
};

const clip = (text: string): string => text.trim().slice(0, BODY_CLIP);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function safeJsonParse(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** TwiML that bridges the answered phone leg into OpenAI over SIP. */
export function buildDialSipTwiml(projectId: string): string {
  // OpenAI takes SIP over TLS only. With plain SIP, OpenAI never sees the call
  // and the person on the phone hears silence. GPT-Live also requires SRTP
  // media (`secure=true`); without it, accept fails with srtp_required and the
  // call hangs up on answer (seen 2026-10-19).
  const target = escapeXml(ENDPOINTS.sipTarget(projectId));
  // answerOnBridge keeps the ringback going until OpenAI picks up.
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial answerOnBridge="true"><Sip>${target}</Sip></Dial></Response>`;
}

// ---------------------------------------------------------------------------
// Dial (SPEC §10.2)

/**
 * Place the outbound call. Never throws for setup or network problems: a
 * missing setup value, a network failure, and a Twilio refusal all come back
 * as a result.
 */
export async function placeCall(ctx: ServerContext): Promise<PhoneDialResult> {
  const values = await ctx.settings.get();
  const status = await readSetupStatus(ctx, values);
  if (!status.phone.ready) return { status: "not-ready", missing: status.phone.missing };

  // One call at a time (SPEC §5.4). An app call ends before the phone rings.
  publishStop(ctx, { action: "stop", nonce: null, reason: "replaced" });

  const sid = values.twilioSid!.trim();
  const to = values.yourPhoneNumber!.trim();
  const form = new URLSearchParams({
    To: to,
    From: values.twilioCallerNumber!.trim(),
    Twiml: buildDialSipTwiml(values.openaiSipProject!.trim()),
  });
  let response: Response;
  try {
    response = await fetch(ENDPOINTS.twilioCalls(sid), {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${values.twilioToken!.trim()}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch (error) {
    return { status: "error", detail: `Twilio request failed: ${messageOf(error)}` };
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) return { status: "error", detail: `Twilio ${response.status}: ${clip(text)}` };
  const callSid = safeJsonParse(text).sid;
  const sidText = typeof callSid === "string" ? callSid : undefined;
  return {
    status: "placed",
    detail: `Calling ${to}${sidText ? ` (Twilio call ${sidText})` : ""}. Answer to talk to the agent.`,
    ...(sidText ? { callSid: sidText } : {}),
  };
}

// ---------------------------------------------------------------------------
// Receive (SPEC §10.3)

/** End a SIP session from our side. Best effort: the hang-up may already have happened. */
async function hangUpSession(ctx: ServerContext, sessionId: string): Promise<void> {
  try {
    const key = (await ctx.settings.get()).openaiKey;
    if (!isPresent(key)) return;
    await fetch(ENDPOINTS.hangupSession(sessionId), {
      method: "POST",
      headers: { Authorization: `Bearer ${key.trim()}` },
    });
  } catch (error) {
    ctx.bb.log.warn(`Dispatch could not hang up phone session ${sessionId}: ${messageOf(error)}`);
  }
}

/**
 * Answer one incoming SIP session: accept it, record the call, and run the
 * tool loop detached. Returns quickly. An accept failure is recorded as a
 * `call.failed` row.
 */
export async function receiveCall(ctx: ServerContext, sessionId: string): Promise<{ accepted: boolean }> {
  const open = openCalls(ctx);
  // OpenAI can deliver the same webhook twice. The session is answered once.
  if (open.some((call) => call.openaiSessionId === sessionId)) return { accepted: true };
  if (open.some((call) => call.channel === "phone")) {
    ctx.bb.log.warn("Dispatch ignored an incoming phone session because a phone call is already live.");
    return { accepted: false };
  }

  // An app call must not run next to the phone call (SPEC §5.4).
  publishStop(ctx, { action: "stop", nonce: null, reason: "replaced" });
  for (const call of open) endCall(ctx, call.id, { reason: "replaced" });

  let failure: string | null = null;
  try {
    await acceptSipSession(ctx, sessionId, await buildPhoneSessionBody(ctx));
  } catch (error) {
    failure = messageOf(error);
  }

  const callId = insertCall(ctx, { channel: "phone", device: PHONE_DEVICE, openaiSessionId: sessionId });
  if (failure !== null) {
    ctx.bb.log.warn(`Dispatch could not accept phone session ${sessionId}: ${failure}`);
    appendTrace(ctx, callId, [{ kind: "call.failed", at: Date.now(), payload: { detail: failure } }]);
    return { accepted: false };
  }
  appendTrace(ctx, callId, [
    { kind: "call.started", at: Date.now(), payload: { channel: "phone", sessionId, device: PHONE_DEVICE.label } },
  ]);
  ctx.bb.log.info(`Dispatch answered phone session ${sessionId}.`);
  void runSideband(ctx, callId, sessionId).catch((error: unknown) => {
    ctx.bb.log.error(`Dispatch sideband loop ended: ${messageOf(error)}`);
  });
  return { accepted: true };
}

// ---------------------------------------------------------------------------
// Sideband tool loop (SPEC §10.5)

/**
 * OpenAI hosts the audio. Here we record the transcript and run the backend's
 * function calls. A
 * finished function call arrives inside `response.event`; its result goes
 * back as `response.item.create`. Calls run one at a time. One
 * `response.create` follows the last output of a batch, or GPT-Live rejects
 * the continue. Resolves when the socket is gone.
 */
export async function runSideband(ctx: ServerContext, callId: string, sessionId: string): Promise<void> {
  const key = ((await ctx.settings.get()).openaiKey ?? "").trim();
  // The plugin host's WebSocket is undici's, which takes a { headers } init.
  const ws = new WebSocket(ENDPOINTS.attachSession(sessionId), { headers: { Authorization: `Bearer ${key}` } } as never);
  const trace = (kind: string, payload?: Record<string, unknown>) =>
    appendTrace(ctx, callId, [{ kind, at: Date.now(), ...(payload ? { payload } : {}) }]);
  const send = (event: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  };

  let pending = 0;
  let chain: Promise<void> = Promise.resolve();
  let closed = false;
  let hungUp = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  // Transcript fragments become one speech.user or speech.agent row per utterance.
  const transcript = new TranscriptGrouper((utterance) => {
    appendTrace(ctx, callId, [{ kind: speechKind(utterance.speaker), at: utterance.at, payload: { text: utterance.text } }]);
  });

  // A stop control (an app call starts, or `bb dispatch stop`) hangs up the phone.
  const unsubscribe = onCallStop((payload) => {
    if (closed || hungUp) return;
    hungUp = true;
    // Write the last words before the call ends, so its summary sees them.
    transcript.flush();
    if (endCall(ctx, callId, { reason: payload.reason })) trace("call.stopped", { reason: payload.reason });
    void hangUpSession(ctx, sessionId);
    // `session.closed` may still bring the final usage. Do not wait for ever.
    graceTimer = setTimeout(() => ws.close(), HANGUP_GRACE_MS);
  });

  // Speak first, so the person on the phone knows the call is ready.
  ws.addEventListener("open", () => {
    send({ type: "response.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: GREETING_NOTICE }] } });
    send({ type: "response.create" });
  });

  ws.addEventListener("message", (event: MessageEvent) => {
    const message = safeJsonParse(typeof event.data === "string" ? event.data : "");
    const usage = message.usage as Record<string, unknown> | undefined;
    const seconds = typeof usage?.seconds === "number" ? usage.seconds : undefined;

    if (message.type === "session.usage.updated" && seconds !== undefined) {
      trace("usage.seconds", { seconds });
      return;
    }
    if (message.type === "session.input_transcript.delta" || message.type === "session.output_transcript.delta") {
      if (typeof message.delta !== "string") return;
      transcript.push({
        speaker: message.type === "session.input_transcript.delta" ? "user" : "agent",
        text: message.delta,
        startMs: typeof message.start_ms === "number" ? message.start_ms : null,
        endMs: typeof message.end_ms === "number" ? message.end_ms : null,
      });
      return;
    }
    if (message.type === "session.closed") {
      closed = true;
      transcript.flush();
      const reason = typeof message.reason === "string" && message.reason !== "" ? message.reason : "closed";
      trace("call.closed", { reason, ...(seconds !== undefined ? { seconds } : {}) });
      if (!hungUp) trace("call.stopped", { reason });
      ctx.bb.log.info(`Dispatch phone call ended (${reason}${seconds !== undefined ? `, ${seconds} s` : ""}).`);
      ws.close();
      return;
    }
    if (message.type === "error") {
      const detail = (message.error as { message?: unknown } | undefined)?.message;
      trace("error", { message: typeof detail === "string" ? detail : "live error" });
      return;
    }
    if (message.type !== "response.event" || hungUp) return;
    const inner = message.event as Record<string, unknown> | undefined;
    if (inner?.type !== "response.output_item.done") return;
    const item = inner.item as Record<string, unknown> | undefined;
    if (item?.type !== "function_call") return;
    const name = typeof item.name === "string" ? item.name : null;
    const toolCallId = typeof item.call_id === "string" ? item.call_id : null;
    if (!name || !toolCallId) return;
    const args = typeof item.arguments === "string" ? safeJsonParse(item.arguments) : {};

    pending += 1;
    chain = chain
      // executeServerTool traces the call and the result, and never throws.
      .then(() => executeServerTool(ctx, { callId, name, args, context: PHONE_TOOL_CONTEXT }))
      // Every call needs an output before the backend can continue.
      .catch((error: unknown) => ({ output: `Error: ${messageOf(error)}`, status: "error" as const }))
      .then((result) => {
        send({ type: "response.item.create", item: { type: "function_call_output", call_id: toolCallId, output: result.output } });
      })
      .finally(() => {
        pending -= 1;
        if (pending === 0) send({ type: "response.create" });
      });
  });

  await new Promise<void>((resolve) => {
    ws.addEventListener("close", () => resolve());
    ws.addEventListener("error", () => resolve());
  });
  unsubscribe();
  if (graceTimer) clearTimeout(graceTimer);
  transcript.flush();
  if (!closed && !hungUp) {
    // The call may still be up at OpenAI, but Dispatch can no longer see it or run its tools.
    trace("call.stopped", { unclean: true, reason: "connection lost" });
    ctx.bb.log.warn(`Dispatch lost the sideband for phone session ${sessionId} before it closed.`);
  }
}

// ---------------------------------------------------------------------------
// Caller policy (SPEC §10.4)

export type Caller = { kind: "plugin"; pluginId: string } | { kind: "client" };

/**
 * The Webhooks plugin has already checked the OpenAI signature. Its calls and
 * local clients are trusted. Any other plugin is logged, and the payload must
 * still be a well-formed event.
 */
export function noteCaller(ctx: ServerContext, caller: Caller): void {
  if (caller.kind === "client" || caller.pluginId === WEBHOOKS_PLUGIN_ID) return;
  ctx.bb.log.warn(`Dispatch received a webhook delivery from plugin "${caller.pluginId}", not the Webhooks plugin.`);
}
