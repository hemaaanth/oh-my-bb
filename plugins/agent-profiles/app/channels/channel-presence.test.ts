import { describe, expect, it } from "vitest";
import { ChannelPresence } from "./channel-presence";

const immediately = () => Promise.resolve();

describe("channel presence", () => {
  it("treats unknown channels as present", async () => {
    const presence = new ChannelPresence();
    expect(presence.isMissing("a")).toBe(false);
    await expect(presence.stillExists("a", immediately)).resolves.toBe(true);
  });

  it("stops refreshes once a channel is known missing", async () => {
    const presence = new ChannelPresence();
    presence.markMissing("a");
    let yielded = false;
    await expect(
      presence.stillExists("a", async () => { yielded = true; }),
    ).resolves.toBe(false);
    expect(yielded).toBe(false);
    expect(presence.isMissing("b")).toBe(false);
  });

  it("waits for an in-flight room read before a side panel refreshes", async () => {
    const presence = new ChannelPresence();
    let finish!: () => void;
    const read = new Promise<void>((resolve) => { finish = resolve; });
    const verdict = presence.stillExists("a", async () => {
      // The channel view's realtime handler starts its read in the same event.
      presence.track("a", read.then(() => presence.markMissing("a")));
    });
    let settled = false;
    void verdict.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await expect(verdict).resolves.toBe(false);
  });

  it("lets a panel refresh after a failed read that did not report the channel missing", async () => {
    const presence = new ChannelPresence();
    const verdict = presence.stillExists("a", async () => {
      presence.track("a", Promise.reject(new Error("offline")));
    });
    await expect(verdict).resolves.toBe(true);
  });
});
