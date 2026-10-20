// Another realm's call, as this realm sees it (SPEC §5.5). The call
// controller feeds it presence from other realms only, and only while it owns
// no call itself. A mirror that misses its heartbeats goes stale and drops.

import type { Presence } from "@/shared/contract.js";

export const STALE_MS = 15_000;

export interface Mirror {
  nonce: string;
  phase: Exclude<Presence["phase"], "idle">;
  startedAt: number | null;
}

export class PresenceMirror {
  private mirror: Mirror | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onChange: (mirror: Mirror | null) => void,
    private readonly staleMs = STALE_MS,
  ) {}

  get current() {
    return this.mirror;
  }

  apply(presence: Presence) {
    if (presence.phase === "idle") {
      // Only the call being shown can end it. A late idle from an older call
      // must not clear a newer one.
      if (this.mirror?.nonce === presence.nonce) this.clear();
      return;
    }
    const next: Mirror = { nonce: presence.nonce, phase: presence.phase, startedAt: presence.startedAt };
    const changed =
      !this.mirror || this.mirror.nonce !== next.nonce || this.mirror.phase !== next.phase || this.mirror.startedAt !== next.startedAt;
    this.mirror = next;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.clear(), this.staleMs);
    if (changed) this.onChange(next);
  }

  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.mirror) return;
    this.mirror = null;
    this.onChange(null);
  }
}
