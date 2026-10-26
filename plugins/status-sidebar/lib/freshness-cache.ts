/**
 * Shares one in-flight or recent lookup per key across every sidebar window.
 * An entry is reused while it started no more than `maxAgeMs` ago, so a
 * caller that must see state newer than some event (a turn that just ended)
 * asks for a small age, and a routine refresh accepts an older one.
 */
export interface FreshnessCache<Value> {
  get(key: string, maxAgeMs: number): Promise<Value> | undefined;
  set(key: string, value: Promise<Value>): void;
  /** Drops entries that started more than `maxAgeMs` ago. */
  prune(maxAgeMs: number): void;
}

export function createFreshnessCache<Value>(
  now: () => number = () => Date.now(),
): FreshnessCache<Value> {
  const entries = new Map<string, { startedAt: number; value: Promise<Value> }>();
  return {
    get(key, maxAgeMs) {
      const entry = entries.get(key);
      if (!entry || now() - entry.startedAt > maxAgeMs) return undefined;
      return entry.value;
    },
    set(key, value) {
      const entry = { startedAt: now(), value };
      entries.set(key, entry);
      // A failed lookup is never served again.
      value.catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
      });
    },
    prune(maxAgeMs) {
      const cutoff = now() - maxAgeMs;
      for (const [key, entry] of entries) {
        if (entry.startedAt < cutoff) entries.delete(key);
      }
    },
  };
}
