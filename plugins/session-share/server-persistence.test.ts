import { createServer } from "node:http";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";

const tunnel = vi.hoisted(() => ({
  start: vi.fn(async () => ({
    publicUrl: "https://share.example.test",
    reachable: Promise.resolve(),
    closed: new Promise<void>(() => undefined),
    stop: async () => undefined,
  })),
}));

vi.mock("./tunnel.js", () => ({ startCloudflareTunnel: tunnel.start }));

import plugin from "./server.js";

async function availablePort(): Promise<number> {
  const server = createServer();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once("listening", resolve);
  server.once("error", reject);
  server.listen(0, "127.0.0.1");
  await promise;
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a test port");
  }
  const port = address.port;
  await new Promise<void>((closed) => server.close(() => closed()));
  return port;
}

describe("persistent session shares", () => {
  it("restores the same custom URL, path, and access code after reload", async () => {
    const port = await availablePort();
    let instance: FakePluginHost = createFakePluginHost({
      pluginId: "session-share",
      settings: {
        cloudflaredPath: "cloudflared",
        viewerPort: String(port),
        customHostname: "share.example.test",
        tunnelToken: "test-token",
      },
      sdk: {
        projects: {
          get: async ({ projectId }) => ({
            id: projectId,
            name: "Example project",
            kind: "standard",
            gitRemoteUrl: null,
            sources: [],
            createdAt: 1,
            updatedAt: 1,
          }),
        },
        threads: {
          get: async ({ threadId }) =>
            makeThreadResponse({
              id: threadId,
              title: "Durable session",
              environmentId: null,
            }),
        },
      },
    });

    try {
      await plugin(instance.bb);
      const { share } = (await instance.harness.behavior.callRpc("start", {
        threadId: "thr_durable",
        durationMinutes: 0,
        mode: "view",
        tunnelMode: "custom",
      })) as {
        share: {
          id: string;
          publicUrl: string;
          localUrl: string;
          accessCode: string;
          expiresAt: number | null;
        };
      };
      expect(share.expiresAt).toBeNull();

      instance = await instance.harness.lifecycle.reload(plugin);
      expect(
        await instance.harness.behavior.callRpc("list", null),
      ).toEqual({
        shares: [
          expect.objectContaining({
            id: share.id,
            publicUrl: share.publicUrl,
            accessCode: share.accessCode,
            ready: false,
          }),
        ],
      });

      const service = instance.harness.behavior.runService("restore-shares");
      await vi.waitFor(async () => {
        const result = (await instance.harness.behavior.callRpc(
          "list",
          null,
        )) as { shares: Array<{ id: string; ready: boolean }> };
        expect(result.shares).toEqual([
          expect.objectContaining({ id: share.id, ready: true }),
        ]);
      });
      service.controller.abort();
      await service.done;

      const restored = (await instance.harness.behavior.callRpc(
        "list",
        null,
      )) as {
        shares: Array<{ publicUrl: string; accessCode: string }>;
      };
      expect(restored.shares[0]).toMatchObject({
        publicUrl: share.publicUrl,
        accessCode: share.accessCode,
      });
      const restoredStatus = (await instance.harness.behavior.callRpc(
        "status",
        { threadId: "thr_durable" },
      )) as { share: { localUrl: string } };
      // The header indicator's share-only lookup matches the full status.
      expect(
        await instance.harness.behavior.callRpc("share", {
          threadId: "thr_durable",
        }),
      ).toEqual({ share: restoredStatus.share });
      expect(
        await instance.harness.behavior.callRpc("share", {
          threadId: "thr_other",
        }),
      ).toEqual({ share: null });
      // Restoring publishes the signals the frontend refreshes on.
      expect(
        instance.harness.inspection.realtimeSignals.filter(
          (signal) => signal.channel === "session-share",
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              shareId: share.id,
              threadId: "thr_durable",
            }),
          }),
        ]),
      );
      const unlock = await fetch(
        `${restoredStatus.share.localUrl}api/unlock`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accessCode: share.accessCode }),
        },
      );
      expect(unlock.status).toBe(200);
    } finally {
      await instance.harness.lifecycle.dispose();
    }
  });
  it("runs standalone without probing Pinpoint during startup or View status", async () => {
    const instance = createFakePluginHost({ pluginId: "session-share", settings: { cloudflaredPath: process.execPath } });
    try {
      await plugin(instance.bb);
      const service = instance.harness.behavior.runService("restore-shares");
      const result = await instance.harness.behavior.callRpc("status", { threadId: "thr_standalone" });
      service.controller.abort();
      await service.done;
      expect(result).toMatchObject({ share: null, cloudflaredAvailable: true, pinpointTargetUrl: null });
      expect(instance.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    } finally {
      await instance.harness.lifecycle.dispose();
    }
  });
  it("keeps a year-long share active beyond the platform timer limit and expires it on time", async () => {
    const port = await availablePort();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const instance = createFakePluginHost({
      pluginId: "session-share",
      settings: { viewerPort: String(port) },
      sdk: {
        threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId, environmentId: null }) },
        projects: { get: async ({ projectId }) => ({ id: projectId, name: "Synthetic", kind: "standard", gitRemoteUrl: null, sources: [], createdAt: 1, updatedAt: 1 }) },
      },
    });
    try {
      await plugin(instance.bb);
      await instance.harness.behavior.callRpc("start", { threadId: "thr_long", durationMinutes: 525_600, mode: "view", tunnelMode: "quick" });
      await vi.advanceTimersByTimeAsync(2_147_483_647 + 1);
      expect(await instance.harness.behavior.callRpc("share", { threadId: "thr_long" })).toMatchObject({ share: { threadId: "thr_long" } });
      await vi.advanceTimersByTimeAsync(525_600 * 60_000 - 2_147_483_647);
      expect(await instance.harness.behavior.callRpc("list", null)).toEqual({ shares: [] });
    } finally {
      await instance.harness.lifecycle.dispose();
      vi.useRealTimers();
    }
  });
});
