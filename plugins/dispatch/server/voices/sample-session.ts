// One short client-mode GPT-Live session over a WebSocket that asks the voice
// to say a sample line, and collects the PCM16 audio it sends back. It never
// touches the calls ledger, the one-call lock, or usage totals.
import { ENDPOINTS, VOICE_SAMPLE } from "../../shared/constants.js";
import { OPENAI_ERROR_MAX } from "../live-session.js";

export const SAMPLE_SILENT_ERROR = "The voice did not speak. Try again.";

/** The `session` of the `session.start` event. No delegation means client mode. */
export type SampleSessionConfig = {
  model: string;
  instructions: string;
  input: Array<{ type: "message"; role: "developer"; content: Array<{ type: "input_text"; text: string }> }>;
  audio: { format: { type: "audio/pcm"; rate: number }; output: { voice: string | { id: string } } };
};

export type SampleTiming = { capMs: number; quietMs: number; closeMs: number };

/** 100 ms of silence. GPT-Live wants input audio running while it speaks first. */
const SILENCE_MS = 100;
const SILENCE = Buffer.alloc((VOICE_SAMPLE.rate * 2 * SILENCE_MS) / 1000).toString("base64");

const parse = (data: unknown): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(typeof data === "string" ? data : "");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/**
 * Run the session and return the raw audio. It ends when the voice has been
 * quiet for `quietMs` after it started speaking, at `session.closed`, or at
 * `capMs`. It always sends `session.close` and waits up to `closeMs` for
 * `session.closed` before it releases the socket.
 */
export function recordSample(input: {
  apiKey: string;
  session: SampleSessionConfig;
  /** Sent once through session.commentary.append after session.started. */
  speak: string;
  timing?: Partial<SampleTiming>;
}): Promise<Uint8Array> {
  const timing: SampleTiming = {
    capMs: input.timing?.capMs ?? VOICE_SAMPLE.capMs,
    quietMs: input.timing?.quietMs ?? VOICE_SAMPLE.quietMs,
    closeMs: input.timing?.closeMs ?? VOICE_SAMPLE.closeMs,
  };
  const socket = new WebSocket(ENDPOINTS.liveSocket, { headers: { Authorization: `Bearer ${input.apiKey}` } } as never);
  const chunks: Buffer[] = [];
  let started = false;
  let closed = false;
  let finishing = false;
  let settled = false;
  let problem: string | null = null;
  let pump: ReturnType<typeof setInterval> | undefined;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let closeWait: ReturnType<typeof setTimeout> | undefined;

  return new Promise<Uint8Array>((resolve, reject) => {
    const send = (event: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      clearInterval(pump);
      clearTimeout(quiet);
      clearTimeout(cap);
      clearTimeout(closeWait);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      const audio = Buffer.concat(chunks);
      if (audio.length > 0) resolve(new Uint8Array(audio));
      else reject(new Error(problem ?? SAMPLE_SILENT_ERROR));
    };
    const finish = () => {
      if (finishing) return;
      finishing = true;
      clearInterval(pump);
      clearTimeout(quiet);
      clearTimeout(cap);
      if (!started || closed || socket.readyState !== WebSocket.OPEN) return settle();
      // The session.closed handler below settles; this timer covers a lost event.
      send({ type: "session.close" });
      closeWait = setTimeout(settle, timing.closeMs);
    };
    const cap = setTimeout(finish, timing.capMs);

    socket.addEventListener("open", () => send({ type: "session.start", event_id: "sample_start", session: input.session }));
    socket.addEventListener("message", (event: MessageEvent) => {
      const message = parse(event.data);
      if (message.type === "session.started") {
        started = true;
        send({ type: "session.commentary.append", event_id: "sample_say", delegation_id: null, content: input.speak });
        pump = setInterval(() => send({ type: "session.input_audio.append", audio: SILENCE }), SILENCE_MS);
      } else if (message.type === "session.output_audio.delta" && typeof message.delta === "string") {
        chunks.push(Buffer.from(message.delta, "base64"));
        clearTimeout(quiet);
        quiet = setTimeout(finish, timing.quietMs);
      } else if (message.type === "error") {
        const error = message.error as { message?: unknown } | undefined;
        const text = typeof error?.message === "string" ? error.message : "the session failed";
        problem = `OpenAI: ${text.slice(0, OPENAI_ERROR_MAX)}`;
        // Before the session starts an error is final. Later ones are rejected commands.
        if (!started) finish();
      } else if (message.type === "session.closed") {
        closed = true;
        if (finishing) settle();
        else finish();
      }
    });
    socket.addEventListener("close", () => {
      closed = true;
      finishing = true;
      settle();
    });
    socket.addEventListener("error", () => {
      problem ??= "Dispatch could not reach OpenAI for the sample.";
      closed = true;
      finishing = true;
      settle();
    });
  });
}
