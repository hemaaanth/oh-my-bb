// Groups GPT-Live transcript fragments into utterances. GPT-Live sends only
// `session.input_transcript.delta` and `session.output_transcript.delta`, with
// no event that ends a turn, so the app decides where one utterance ends.
// The phone sideband (server) and the call controller (voice) both use this.

export type Speaker = "user" | "agent";

/** One fragment as received. `startMs` and `endMs` are on the session timeline. */
export type TranscriptFragment = { speaker: Speaker; text: string; startMs?: number | null; endMs?: number | null };

/** One finished utterance. `at` is when its first fragment arrived. */
export type Utterance = { speaker: Speaker; text: string; at: number };

/** A pause longer than this starts a new utterance from the same speaker. */
export const UTTERANCE_GAP_MS = 2000;
/** With no new fragment for this long, the open utterance is written. */
export const UTTERANCE_IDLE_MS = 4000;

export const speechKind = (speaker: Speaker) => (speaker === "user" ? "speech.user" : "speech.agent");

type Open = { speaker: Speaker; text: string; at: number; lastEndMs: number | null; lastArrival: number };

type Options = {
  now?: () => number;
  gapMs?: number;
  /** 0 turns the idle flush off. */
  idleMs?: number;
};

export class TranscriptGrouper {
  private open: Open | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly gapMs: number;
  private readonly idleMs: number;

  constructor(
    private readonly emit: (utterance: Utterance) => void,
    options: Options = {},
  ) {
    this.now = options.now ?? Date.now;
    this.gapMs = options.gapMs ?? UTTERANCE_GAP_MS;
    this.idleMs = options.idleMs ?? UTTERANCE_IDLE_MS;
  }

  push(fragment: TranscriptFragment): void {
    if (fragment.text === "") return;
    const arrival = this.now();
    const startMs = finite(fragment.startMs);
    const endMs = finite(fragment.endMs);
    const open = this.open;
    if (open && (open.speaker !== fragment.speaker || this.isGap(open, startMs, arrival))) this.flush();
    if (this.open) {
      // Fragments are appended exactly as received: they carry their own spaces.
      this.open.text += fragment.text;
      this.open.lastEndMs = endMs ?? this.open.lastEndMs;
      this.open.lastArrival = arrival;
    } else {
      this.open = { speaker: fragment.speaker, text: fragment.text, at: arrival, lastEndMs: endMs, lastArrival: arrival };
    }
    this.armIdle();
  }

  /** The speaker of the utterance still open, if any. */
  get openSpeaker(): Speaker | null {
    return this.open?.speaker ?? null;
  }

  /** Write the open utterance, if any. Call it when the call ends. */
  flush(): void {
    this.clearIdle();
    const open = this.open;
    this.open = null;
    const text = open?.text.trim();
    if (open && text) this.emit({ speaker: open.speaker, text, at: open.at });
  }

  /** Stop the idle timer without writing. */
  dispose(): void {
    this.clearIdle();
    this.open = null;
  }

  // Session-timeline times win over arrival times, as the GPT-Live docs ask.
  private isGap(open: Open, startMs: number | null, arrival: number): boolean {
    if (startMs !== null && open.lastEndMs !== null) return startMs - open.lastEndMs > this.gapMs;
    return arrival - open.lastArrival > this.gapMs;
  }

  private armIdle(): void {
    if (this.idleMs <= 0) return;
    this.clearIdle();
    this.timer = setTimeout(() => this.flush(), this.idleMs);
  }

  private clearIdle(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
