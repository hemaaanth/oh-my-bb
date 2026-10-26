import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configurePublicPinpoint,
  publishPublicPinpointState,
  useRpc,
} from "./public-sdk";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public Pinpoint navigation", () => {
  it("rejects guest learning approval and retries before any network write", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    configurePublicPinpoint({
      isolationVersion: 1, screenshotUploadUrl: "./screenshot-upload",
      permissions: { capture: true, reply: true, delete: true },
      threadId: "thread-1", target: "https://preview.example.test/",
      proxyBase: "./proxy", stateUrl: "./state", feedbackUrl: "./feedback",
      navigationUrl: "./navigation", screenshotUrl: "./screenshot", csrf: "synthetic-csrf",
    });
    await expect(useRpc().call("update", { id: "pin-1", action: "approve", learning: true })).rejects.toThrow("cannot authorize");
    await expect(useRpc().call("update", { id: "pin-1", action: "retry-learning" })).rejects.toThrow("cannot authorize");
    for (const action of ["approve", "dismiss", "redispatch"]) {
      await expect(useRpc().call("update", { id: "pin-1", action })).rejects.toThrow("owner");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts guest navigation through the share CSRF boundary", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ navigation: { revision: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    configurePublicPinpoint({
      isolationVersion: 1, screenshotUploadUrl: "./api/screenshot-upload",
      permissions: { capture: true, reply: true, delete: true },
      threadId: "thread-1",
      target: "https://preview.example.test/",
      proxyBase: "./proxy",
      stateUrl: "./api/state",
      feedbackUrl: "./api/feedback",
      navigationUrl: "./api/navigation",
      screenshotUrl: "./api/pinpoint-screenshot",
      csrf: "csrf-1",
    });

    await useRpc().call("setLiveTarget", {
      threadId: "thread-1",
      url: "https://preview.example.test/",
      registrationId: "guest-panel",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await useRpc().call("setLiveTarget", {
      threadId: "thread-1",
      url: "https://preview.example.test/settings",
      registrationId: "guest-panel",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "./api/navigation",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-share-csrf": "csrf-1",
        },
        body: JSON.stringify({
          url: "https://preview.example.test/settings",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    await useRpc().call("setLiveTarget", {
      threadId: "thread-1",
      url: "https://preview.example.test/settings",
      registrationId: "guest-panel",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    publishPublicPinpointState({
      share: { id: "share-1" },
      navigation: {
        url: "https://preview.example.test/owner-page",
        revision: 2,
      },
      pinpointRows: [],
    });
    await useRpc().call("setLiveTarget", {
      threadId: "thread-1",
      url: "https://preview.example.test/owner-page",
      registrationId: "guest-panel",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
