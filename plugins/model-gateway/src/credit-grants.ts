/** Approval bounds requests, not dollars. Grants are deliberately revoked on reload. */
export class CreditGrants {
  private readonly grants = new Map<string, Map<string, { accountId: string; expiresAt: number; remaining: number }>>();
  private readonly busy = new Set<string>();
  private readonly offers = new Map<string, Set<string>>();
  constructor(private readonly now: () => number = Date.now) {}

  offer(threadId: string, accountId: string): boolean {
    const ids = this.offers.get(threadId) ?? new Set<string>();
    const fresh = !ids.has(accountId);
    ids.add(accountId);
    this.offers.delete(threadId);
    this.offers.set(threadId, ids);
    if (this.offers.size > 1000) this.offers.delete(this.offers.keys().next().value!);
    return fresh;
  }

  grant(threadId: string, accountId: string) {
    if (this.busy.has(threadId)) throw new Error("Wait for the current API request to finish before changing approval.");
    const accounts = this.grants.get(threadId) ?? new Map();
    accounts.delete(accountId);
    accounts.set(accountId, { accountId, expiresAt: this.now() + 15 * 60_000, remaining: 10 });
    this.grants.delete(threadId);
    this.grants.set(threadId, accounts);
    if (this.grants.size > 1000) this.grants.delete(this.grants.keys().next().value!);
    return this.status(threadId);
  }

  status(threadId: string) {
    const grant = [...(this.grants.get(threadId)?.values() ?? [])].reverse().find((entry) => entry.expiresAt > this.now() && entry.remaining > 0);
    return {
      offered: [...(this.offers.get(threadId) ?? [])],
      grant: grant && grant.expiresAt > this.now() && grant.remaining > 0
        ? { accountId: grant.accountId, expiresAt: grant.expiresAt, remaining: grant.remaining } : null,
    };
  }

  acquire(threadId: string | null, accountId: string): (() => void) | null {
    const grant = threadId === null ? undefined : this.grants.get(threadId)?.get(accountId);
    if (!grant || grant.accountId !== accountId || grant.expiresAt <= this.now() || grant.remaining <= 0 || this.busy.has(threadId!)) return null;
    grant.remaining--;
    this.busy.add(threadId!);
    return () => { this.busy.delete(threadId!); };
  }

  clearOffers(threadId: string) { this.offers.delete(threadId); }

  revoke(threadId: string) { this.grants.delete(threadId); }
}

export class CreditApprovalRequired extends Error {}
