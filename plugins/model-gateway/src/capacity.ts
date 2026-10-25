/** Volatile provider+model circuits. No timers or health requests. */
export class CapacityCircuits {
  private readonly states = new Map<string, { provider: string; model: string; failures: number; retryAt: number }>();

  get(provider: string, model: string | null) {
    return model === null ? undefined : this.states.get(JSON.stringify([provider, model]));
  }

  fail(provider: string, model: string, now: number) {
    const key = JSON.stringify([provider, model]);
    const failures = Math.min(5, (this.states.get(key)?.failures ?? 0) + 1);
    // Add up to 10% jitter, while keeping the absolute five-minute cap.
    const delay = Math.min(300_000, 30_000 * 2 ** (failures - 1) * (1 + Math.random() * 0.1));
    const state = { provider, model, failures, retryAt: now + Math.round(delay) };
    if (!this.states.has(key) && this.states.size >= 1024) this.states.delete(this.states.keys().next().value!);
    this.states.set(key, state);
    return state;
  }

  clear(provider: string, model: string | null) {
    if (model !== null) this.states.delete(JSON.stringify([provider, model]));
  }

  status() { return [...this.states.values()]; }
}
