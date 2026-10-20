// Trace events for the ledger (SPEC §5.8). Events wait in a short queue and go
// to `traceAppend` in order, one request at a time. A failed request is tried
// once more and then dropped, so the trace never holds up the call.
//
// Events recorded before the server returns the call id wait for `attach`.
// The server skips unknown call ids, so a call that never got an id drops them.

import type { TraceEvent } from "@/shared/contract.js";

export type TraceSend = (callId: string, events: TraceEvent[]) => Promise<unknown>;

interface Item {
  callId: string | null;
  event: TraceEvent;
}

export class TraceQueue {
  private queue: Item[] = [];
  private callId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly send: TraceSend,
    private readonly delayMs = 500,
  ) {}

  /** A new call starts. Events left over from a call without an id are dropped. */
  begin() {
    this.callId = null;
    this.queue = this.queue.filter((item) => item.callId !== null);
  }

  attach(callId: string) {
    this.callId = callId;
    for (const item of this.queue) if (item.callId === null) item.callId = callId;
    this.schedule();
  }

  record(kind: string, payload?: Record<string, unknown>, at = Date.now()) {
    this.queue.push({ callId: this.callId, event: payload === undefined ? { kind, at } : { kind, at, payload } });
    if (this.callId) this.schedule();
  }

  /** The call ended. Send what is queued; later events have no call. */
  end(): Promise<void> {
    const done = this.flush();
    this.callId = null;
    this.queue = [];
    return done;
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ready = this.queue.filter((item) => item.callId !== null);
    this.queue = this.queue.filter((item) => item.callId === null);
    const batches: Array<{ callId: string; events: TraceEvent[] }> = [];
    for (const item of ready) {
      const last = batches.at(-1);
      if (last && last.callId === item.callId) last.events.push(item.event);
      else batches.push({ callId: item.callId as string, events: [item.event] });
    }
    if (batches.length === 0) return this.chain;
    this.chain = this.chain.then(async () => {
      for (const batch of batches) await this.deliver(batch.callId, batch.events);
    });
    return this.chain;
  }

  private schedule() {
    if (this.timer || this.queue.length === 0) return;
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  private async deliver(callId: string, events: TraceEvent[]) {
    try {
      await this.send(callId, events);
    } catch {
      try {
        await this.send(callId, events);
      } catch {
        // Dropped after one retry (SPEC §5.8).
      }
    }
  }
}
