import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LIVE_TARGET_HEARTBEAT_MS,
  LIVE_TARGET_TTL_MS,
} from "./lib/live-target";
import plugin from "./server";

async function makeHost() {
  const { bb, harness } = createFakePluginHost({ pluginId: "pinpoint" });
  await plugin(bb);
  return harness;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Pinpoint live target lifecycle", () => {
  it("registers readable timeline presentations for every agent tool", async () => {
    const harness = await makeHost();
    expect(
      Object.fromEntries(
        harness.inspection.registrations.agentTools.map(({ name, presentation }) => [
          name,
          presentation,
        ]),
      ),
    ).toEqual({
      pinpoint_list: {
        label: { pending: "Loading Pinpoint feedback", completed: "Loaded Pinpoint feedback" },
        icon: { glyph: "ListView" },
      },
      pinpoint_resolve: {
        label: { pending: "Updating Pinpoint feedback", completed: "Updated Pinpoint feedback" },
        icon: { glyph: "Target" },
      },
      pinpoint_show: {
        label: {
          pending: "Loading Pinpoint feedback details",
          completed: "Loaded Pinpoint feedback details",
        },
        icon: { glyph: "Eye" },
      },
    });
  });

  it("only exposes the currently mounted Pinpoint panel", async () => {
    const harness = await makeHost();
    const threadId = "thread-1";

    await harness.behavior.callRpc("setLiveTarget", {
      threadId,
      url: "https://first.example/",
      registrationId: "registration-1",
      observedShareId: null,
      observedRevision: null,
    });
    expect(
      await harness.behavior.callRpc("liveTarget", { threadId }),
    ).toEqual({ url: "https://first.example/" });

    await harness.behavior.callRpc("setLiveTarget", {
      threadId,
      url: "https://second.example/",
      registrationId: "registration-2",
      observedShareId: null,
      observedRevision: null,
    });
    await harness.behavior.callRpc("clearLiveTarget", {
      threadId,
      registrationId: "registration-1",
    });
    expect(
      await harness.behavior.callRpc("liveTarget", { threadId }),
    ).toEqual({ url: "https://second.example/" });

    await harness.behavior.callRpc("clearLiveTarget", {
      threadId,
      registrationId: "registration-2",
    });
    expect(
      await harness.behavior.callRpc("liveTarget", { threadId }),
    ).toEqual({ url: null });
  });

  it("moves an active owner panel for same-origin guest navigation", async () => {
    const harness = await makeHost();
    const threadId = "thread-1";
    await harness.behavior.callRpc("setLiveTarget", {
      threadId,
      url: "https://preview.example.test/",
      registrationId: "registration-1",
      observedShareId: null,
      observedRevision: null,
    });

    await expect(
      harness.behavior.callRpc("navigateLiveTarget", {
        threadId,
        url: "https://preview.example.test/settings",
        shareId: "share-1",
        revision: 1,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      harness.behavior.callRpc("liveTarget", { threadId }),
    ).resolves.toEqual({
      url: "https://preview.example.test/settings",
    });

    await harness.behavior.callRpc("navigateLiveTarget", {
      threadId,
      url: "https://preview.example.test/newer",
      shareId: "share-1",
      revision: 3,
    });
    await harness.behavior.callRpc("navigateLiveTarget", {
      threadId,
      url: "https://preview.example.test/stale",
      shareId: "share-1",
      revision: 2,
    });
    await harness.behavior.callRpc("setLiveTarget", {
      threadId,
      url: "https://preview.example.test/stale-owner",
      registrationId: "registration-1",
      observedShareId: "share-1",
      observedRevision: 1,
    });
    await expect(
      harness.behavior.callRpc("liveTarget", { threadId }),
    ).resolves.toEqual({
      url: "https://preview.example.test/newer",
    });

    await expect(
      harness.behavior.callRpc("navigateLiveTarget", {
        threadId,
        url: "https://example.com/escape",
        shareId: "share-1",
        revision: 2,
      }),
    ).rejects.toThrow("approved origin");
  });

  it("expires registrations when panel cleanup never runs", async () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const harness = await makeHost();
    await harness.behavior.callRpc("setLiveTarget", {
      threadId: "thread-1",
      url: "https://stale.example/",
      registrationId: "registration-stale",
      observedShareId: null,
      observedRevision: null,
    });

    nowSpy.mockReturnValue(now + LIVE_TARGET_TTL_MS - 1);
    expect(
      await harness.behavior.callRpc("liveTarget", { threadId: "thread-1" }),
    ).toEqual({ url: "https://stale.example/" });

    nowSpy.mockReturnValue(now + LIVE_TARGET_TTL_MS + 1);
    expect(
      await harness.behavior.callRpc("liveTarget", { threadId: "thread-1" }),
    ).toEqual({ url: null });
  });

  it("keeps a heartbeating panel live across missed renewals", async () => {
    // The TTL must outlast at least two missed heartbeats so a busy renderer
    // never drops a mounted panel's Review target.
    expect(LIVE_TARGET_TTL_MS).toBeGreaterThanOrEqual(
      LIVE_TARGET_HEARTBEAT_MS * 3,
    );
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const harness = await makeHost();
    const renew = () =>
      harness.behavior.callRpc("setLiveTarget", {
        threadId: "thread-1",
        url: "https://live.example/",
        registrationId: "registration-live",
        observedShareId: null,
        observedRevision: null,
      });
    await renew();
    nowSpy.mockReturnValue(now + LIVE_TARGET_HEARTBEAT_MS);
    await renew();
    nowSpy.mockReturnValue(
      now + LIVE_TARGET_HEARTBEAT_MS + LIVE_TARGET_TTL_MS - 1,
    );
    expect(
      await harness.behavior.callRpc("liveTarget", { threadId: "thread-1" }),
    ).toEqual({ url: "https://live.example/" });
  });
});
