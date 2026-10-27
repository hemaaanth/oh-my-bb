/**
 * What this window knows about channel existence, shared by every mounted view.
 *
 * Channel ids are UUIDs and a deleted channel never comes back, so once the
 * server reports one missing, views stop polling and refetching it.
 */
export const MISSING_CHANNEL_ERROR = "Channel not found";

export class ChannelPresence {
  private missing = new Set<string>();
  private checks = new Map<string, Promise<boolean>>();

  isMissing(id: string) {
    return this.missing.has(id);
  }

  markMissing(id: string) {
    this.missing.add(id);
  }

  /** Record an in-flight room read so side panels can wait for its verdict. */
  track(id: string, read: Promise<unknown>) {
    const check = read.then(() => !this.missing.has(id), () => !this.missing.has(id));
    this.checks.set(id, check);
    void check.finally(() => {
      if (this.checks.get(id) === check) this.checks.delete(id);
    });
    return check;
  }

  /**
   * Resolve after any room read started by the same realtime event, then
   * report whether the channel still exists. Realtime subscribers run in
   * mount order (children first), so yield a task before looking.
   */
  async stillExists(id: string, yieldToOthers: () => Promise<void> = nextTask) {
    if (this.missing.has(id)) return false;
    await yieldToOthers();
    const check = this.checks.get(id);
    if (check) await check;
    return !this.missing.has(id);
  }
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export const channelPresence = new ChannelPresence();
