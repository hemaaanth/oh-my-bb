import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGuestServer,
  formatExpiryLabel,
  type GuestServerHandle,
  type GuestShareRegistration,
} from "./guest-server.js";
import type { ShareStatus } from "./contract.js";
import { PREVIEW_ERROR_HEADERS } from "./preview-contract.js";

const handles: GuestServerHandle[] = [];
const guestStateSchema = z.object({
  messages: z.array(z.object({ text: z.string() })),
  csrfToken: z.string(),
  proxyToken: z.string(),
});

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

function shareStatus(
  id: string,
  mode: "view" | "review",
): ShareStatus {
  const now = Date.now();
  return {
    id,
    threadId: `thr_${id}`,
    title: `Shared ${id}`,
    mode,
    tunnelMode: "quick",
    publicUrl: `https://example.trycloudflare.com/s/${id}/`,
    localUrl: `http://127.0.0.1/s/${id}/`,
    accessCode: `${id}-code-1234`,
    previewUrl: mode === "review" ? "http://127.0.0.1:3000/" : null,
    ready: true,
    startedAt: now,
    expiresAt: now + 60_000,
  };
}

function registration(
  status: ShareStatus,
  feedback = vi.fn(async () => undefined),
): GuestShareRegistration {
  const { accessCode, localUrl: _localUrl, ...publicShare } = status;
  return {
    id: status.id,
    projectName: `Project ${status.id}`,
    accessCode,
    expiresAt: status.expiresAt,
    reviewEnabled: status.mode === "review",
    previewUrl: status.previewUrl,
    getState: async () => ({
      share: publicShare,
      thread: { status: "idle" },
      messages: [
        {
          id: `message-${status.id}`,
          role: "assistant",
          text: status.title,
          html: `<p>${status.title}</p>`,
          createdAt: 1,
        },
      ],
      maxSeq: 1,
      pinpointRows: [],
      navigation:
        status.previewUrl === null
          ? null
          : { url: status.previewUrl, revision: 0 },
      proxyError: null,
    }),
    submitFeedback: feedback,
  };
}

function shareUrl(server: GuestServerHandle, shareId: string): string {
  return `${server.localUrl}/s/${shareId}/`;
}

async function unlock(
  server: GuestServerHandle,
  shareId: string,
  accessCode: string,
) {
  return fetch(`${shareUrl(server, shareId)}api/unlock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessCode }),
  });
}

describe("guest server", () => {
  it("isolates concurrent shares by unguessable path, code, and cookie", async () => {
    const server = await createGuestServer({ port: 0, log: vi.fn() });
    handles.push(server);
    const first = shareStatus("share_first", "view");
    const second = shareStatus("share_second", "view");
    await server.addShare(registration(first));
    await server.addShare(registration(second));

    const firstPage = await fetch(shareUrl(server, first.id));
    expect(firstPage.status).toBe(200);
    expect(firstPage.headers.get("content-security-policy")).toContain(
      "script-src 'self' 'unsafe-inline'",
    );
    const pageHead = await fetch(shareUrl(server, first.id), { method: "HEAD" });
    expect(pageHead.status).toBe(200);
    expect(pageHead.headers.get("content-type")).toContain("text/html");
    expect(Number(pageHead.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await pageHead.text()).toBe("");
    const openGraphImage = await fetch(`${shareUrl(server, first.id)}og.png`);
    expect(openGraphImage.status).toBe(200);
    expect(openGraphImage.headers.get("content-type")).toBe("image/png");
    expect(
      Buffer.from(await openGraphImage.arrayBuffer())
        .subarray(1, 4)
        .toString(),
    ).toBe("PNG");
    const imageHead = await fetch(`${shareUrl(server, first.id)}og.png`, {
      method: "HEAD",
    });
    expect(imageHead.status).toBe(200);
    expect(imageHead.headers.get("content-type")).toBe("image/png");
    expect(imageHead.headers.get("content-length")).toBe(
      openGraphImage.headers.get("content-length"),
    );
    const favicon = await fetch(`${server.localUrl}/favicon-32x32-dark.png`);
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("content-type")).toBe("image/png");
    const landing = await fetch(`${server.localUrl}/`);
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain("AI chat session sharing");
    expect((await unlock(server, first.id, second.accessCode)).status).toBe(401);

    const firstUnlock = await unlock(server, first.id, first.accessCode);
    expect(firstUnlock.status).toBe(200);
    const firstCookie = firstUnlock.headers.get("set-cookie")!.split(";", 1)[0]!;
    const firstState = await fetch(`${shareUrl(server, first.id)}api/state`, {
      headers: { cookie: firstCookie },
    });
    expect(firstState.status).toBe(200);
    const firstStateBody = guestStateSchema.parse(await firstState.json());
    expect(firstStateBody.messages[0]?.text).toBe("Shared share_first");

    expect(
      (
        await fetch(`${shareUrl(server, second.id)}api/state`, {
          headers: { cookie: firstCookie },
        })
      ).status,
    ).toBe(401);

    const secondUnlock = await unlock(server, second.id, second.accessCode);
    expect(secondUnlock.status).toBe(200);
    server.removeShare(first.id);
    const unavailable = await fetch(shareUrl(server, first.id));
    expect(unavailable.status).toBe(404);
    expect(unavailable.headers.get("content-type")).toContain("text/html");
    const unavailableHead = await fetch(shareUrl(server, first.id), {
      method: "HEAD",
    });
    expect(unavailableHead.status).toBe(404);
    expect(unavailableHead.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${shareUrl(server, first.id)}og.png`)).status).toBe(404);
    expect((await fetch(shareUrl(server, second.id))).status).toBe(200);
  });

  it("serves a full unavailable page for an expired share", async () => {
    const server = await createGuestServer({ port: 0, log: vi.fn() });
    handles.push(server);
    const expired = shareStatus("share_expired", "view");
    expired.expiresAt = Date.now() - 1;
    await server.addShare(registration(expired));

    const response = await fetch(shareUrl(server, expired.id));
    expect(response.status).toBe(410);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${shareUrl(server, expired.id)}og.png`)).status).toBe(410);
  });

  it("formats expiry as a compact relative duration", () => {
    const now = Date.now();
    expect(formatExpiryLabel(now + 48 * 60_000, now)).toBe(
      "Session expires in 48 min",
    );
    expect(formatExpiryLabel(now + 90 * 60_000, now)).toBe(
      "Session expires in 1.5 hr",
    );
    expect(formatExpiryLabel(null, now)).toBe("Shared until revoked");
  });

  it("accepts persisted access credentials after a viewer restart", async () => {
    const firstServer = await createGuestServer({ port: 0, log: vi.fn() });
    handles.push(firstServer);
    const status = shareStatus("share_persisted", "view");
    status.expiresAt = null;
    const firstRegistration = registration(status);
    const credentials = await firstServer.addShare(firstRegistration);
    expect((await unlock(firstServer, status.id, status.accessCode)).status).toBe(
      200,
    );
    await firstServer.close();
    handles.splice(handles.indexOf(firstServer), 1);

    const restoredServer = await createGuestServer({ port: 0, log: vi.fn() });
    handles.push(restoredServer);
    const { accessCode: _accessCode, ...restoredRegistration } =
      firstRegistration;
    await restoredServer.addShare({
      ...restoredRegistration,
      accessCredentials: credentials,
    });

    expect(
      (await unlock(restoredServer, status.id, status.accessCode)).status,
    ).toBe(200);
  });

  it("requires a review share and CSRF-bound session for feedback", async () => {
    const server = await createGuestServer({ port: 0, log: vi.fn() });
    handles.push(server);
    const feedback = vi.fn(async () => undefined);
    const navigate = vi.fn(async (url: string) => ({
      url,
      revision: 1,
    }));
    const proxyRequest = vi.fn(async (request: { route: string }) => {
      if (request.route === "pinpoint-controller.js")
        return {
          status: 200,
          contentType: "text/javascript; charset=utf-8",
          body: Buffer.from("window.PinpointPublicReview = {};"),
        };
      if (request.route === "pinpoint-styles.css")
        return {
          status: 200,
          contentType: "text/css; charset=utf-8",
          body: Buffer.from(".pinpoint { color: white; }"),
        };
      return {
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: Buffer.from("<html>preview</html>"),
        isolationVersion: 1 as const,
        headers: { ...PREVIEW_ERROR_HEADERS },
      };
    });
    const review = shareStatus("share_review", "review");
    await server.addShare({
      ...registration(review, feedback),
      proxyRequest,
      navigate,
      loadScreenshot: async () => ({ mime: "image/png", data: "cGl4ZWxz" }),
    });

    const pageResponse = await fetch(shareUrl(server, review.id));
    expect(pageResponse.headers.get("content-security-policy")).toContain(
      "style-src 'self' 'unsafe-inline'",
    );

    const controllerResponse = await fetch(
      `${shareUrl(server, review.id)}pinpoint-controller.js`,
    );
    expect(controllerResponse.status).toBe(200);
    expect(controllerResponse.headers.get("content-type")).toContain(
      "text/javascript",
    );

    const stylesResponse = await fetch(
      `${shareUrl(server, review.id)}pinpoint-styles.css`,
    );
    expect(stylesResponse.headers.get("content-type")).toContain("text/css");

    const unlocked = await unlock(server, review.id, review.accessCode);
    const cookie = unlocked.headers.get("set-cookie")!.split(";", 1)[0]!;
    const stateResponse = await fetch(`${shareUrl(server, review.id)}api/state`, {
      headers: { cookie },
    });
    const state = guestStateSchema.parse(await stateResponse.json());
    const screenshotResponse = await fetch(
      `${shareUrl(server, review.id)}api/pinpoint-screenshot?id=pp_1&kind=element`,
      { headers: { cookie } },
    );
    expect(await screenshotResponse.json()).toEqual({
      shot: { mime: "image/png", data: "cGl4ZWxz" },
    });

    expect(
      (
        await fetch(`${shareUrl(server, review.id)}api/navigation`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ url: "http://127.0.0.1:3000/settings" }),
        })
      ).status,
    ).toBe(403);
    const navigated = await fetch(
      `${shareUrl(server, review.id)}api/navigation`,
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "x-share-csrf": state.csrfToken,
        },
        body: JSON.stringify({ url: "http://127.0.0.1:3000/settings" }),
      },
    );
    expect(navigated.status).toBe(200);
    expect(await navigated.json()).toEqual({
      navigation: {
        url: "http://127.0.0.1:3000/settings",
        revision: 1,
      },
    });
    expect(navigate).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/settings",
    );

    const previewUrl =
      `${shareUrl(server, review.id)}sandbox/${state.proxyToken}/proxy` +
      `?u=${encodeURIComponent(review.previewUrl!)}`;
    const previewResponse = await fetch(previewUrl);
    expect(await previewResponse.text()).toBe("<html>preview</html>");
    expect(previewResponse.headers.get("access-control-allow-origin")).toBe(
      "*",
    );
    expect(
      (
        await fetch(
          `${shareUrl(server, review.id)}sandbox/wrong-token/proxy?u=${encodeURIComponent(review.previewUrl!)}`,
        )
      ).status,
    ).toBe(401);
    const otherReview = shareStatus("share_other_review", "review");
    await server.addShare({
      ...registration(otherReview),
      proxyRequest,
    });
    expect(
      (
        await fetch(
          `${shareUrl(server, otherReview.id)}sandbox/${state.proxyToken}/proxy?u=${encodeURIComponent(otherReview.previewUrl!)}`,
        )
      ).status,
    ).toBe(401);

    expect(
      (
        await fetch(`${shareUrl(server, review.id)}api/feedback`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ comment: "Tighten this copy" }),
        })
      ).status,
    ).toBe(403);

    const submitted = await fetch(`${shareUrl(server, review.id)}api/feedback`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-share-csrf": state.csrfToken,
      },
      body: JSON.stringify({
        comment: "Tighten this copy",
        messageId: "m2",
        selectedText: "Current copy",
      }),
    });
    expect(submitted.status).toBe(200);
  });
  it("denies owner-only actions, cross-origin writes and expired guest sessions", async () => {
    const server = await createGuestServer({ port: 0, log: vi.fn() });
    handles.push(server);
    const feedback = vi.fn(async () => undefined);
    const status = { ...shareStatus("share_permissions", "review"), expiresAt: null };
    await server.addShare(registration(status, feedback));
    const response = await unlock(server, status.id, status.accessCode);
    const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    const state = guestStateSchema.parse(await (await fetch(`${shareUrl(server, status.id)}api/state`, { headers: { cookie } })).json());
    const headers = { cookie, "content-type": "application/json", "x-share-csrf": state.csrfToken };
    for (const intent of [
      { id: "pp_shared", action: "approve" },
      { id: "pp_shared", action: "dismiss" },
      { id: "pp_shared", action: "redispatch" },
      { id: "pp_shared", action: "retry-learning" },
      { id: "pp_shared", action: "reply", learning: true },
    ]) {
      const denied = await fetch(`${shareUrl(server, status.id)}api/feedback`, { method: "POST", headers, body: JSON.stringify({ intent }) });
      expect(denied.status).toBe(400);
    }
    const crossOrigin = await fetch(`${shareUrl(server, status.id)}api/feedback`, {
      method: "POST", headers: { ...headers, origin: "https://attacker.example" }, body: JSON.stringify({ comment: "forged" }),
    });
    expect(crossOrigin.status).toBe(403);
    expect(feedback).not.toHaveBeenCalled();
    const plainText = await fetch(`${shareUrl(server, status.id)}api/unlock`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ accessCode: status.accessCode }),
    });
    expect(plainText.status).toBe(415);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 4 * 60 * 60 * 1_000 + 1);
    try {
      expect((await fetch(`${shareUrl(server, status.id)}api/state`, { headers: { cookie } })).status).toBe(401);
    } finally {
      clock.mockRestore();
    }
  });

  it("reserves the attempt budget before concurrent password checks", async () => {
    const server = await createGuestServer({ port: 0, log: vi.fn() });
    handles.push(server);
    const status = shareStatus("share_attempts", "view");
    await server.addShare(registration(status));
    const responses = await Promise.all(Array.from({ length: 13 }, () => unlock(server, status.id, "incorrect")));
    expect(responses.filter((response) => response.status === 401)).toHaveLength(12);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
    expect((await unlock(server, status.id, status.accessCode)).status).toBe(429);
  });
  it("enforces GET-only resource capabilities and fails closed on legacy or unsafe preparation", async () => {
    const server = await createGuestServer({ port: 0, log: vi.fn() });
    handles.push(server);
    const status = shareStatus("share_resources", "review");
    let legacy = false;
    let unsafe = false;
    await server.addShare({
      ...registration(status),
      proxyRequest: async () => ({
        status: 200, contentType: "text/html", body: Buffer.from("<html>synthetic reviewed app</html>"),
        ...(legacy ? {} : { isolationVersion: 1 as const, headers: {
          ...PREVIEW_ERROR_HEADERS,
          ...(unsafe ? { "content-security-policy": "sandbox allow-scripts allow-same-origin" } : {}),
        } }),
      }),
    });
    const unlocked = await unlock(server, status.id, status.accessCode);
    const cookie = unlocked.headers.get("set-cookie")!.split(";", 1)[0]!;
    const state = guestStateSchema.parse(await (await fetch(`${shareUrl(server, status.id)}api/state`, { headers: { cookie } })).json());
    const base = `${shareUrl(server, status.id)}preview/${state.proxyToken}`;
    const bootstrap = await fetch(`${shareUrl(server, status.id)}sandbox/${state.proxyToken}/proxy?u=${encodeURIComponent(status.previewUrl!)}`, { redirect: "manual" });
    expect(bootstrap.status).toBe(302);
    expect(bootstrap.headers.get("location")).toBe(`${base}/`);
    expect(bootstrap.headers.get("content-security-policy")).toContain("sandbox allow-scripts allow-forms allow-popups");
    const resource = await fetch(`${base}/index.html`);
    expect(resource.status).toBe(200);
    expect(resource.headers.get("content-security-policy")).toContain("sandbox");
    expect(resource.headers.get("access-control-allow-credentials")).toBeNull();
    expect((await fetch(`${base}/index.html`, { method: "POST", body: "untrusted write" })).status).toBe(405);
    const escaped = await fetch(`${shareUrl(server, status.id)}sandbox/${state.proxyToken}/proxy?u=https://attacker.example/`, { redirect: "manual" });
    expect(escaped.status).toBe(403);
    const invalid = await fetch(`${shareUrl(server, status.id)}preview/missing/index.html`);
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("content-security-policy")).toContain("sandbox");
    legacy = true;
    const oldContract = await fetch(`${base}/legacy.html`);
    expect(oldContract.status).toBe(500);
    expect(oldContract.headers.get("content-security-policy")).toContain("sandbox");
    legacy = false;
    unsafe = true;
    const unsafeContract = await fetch(`${base}/unsafe.html`);
    expect(unsafeContract.status).toBe(400);
    expect(unsafeContract.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    server.removeShare(status.id);
    const revoked = await fetch(`${base}/revoked.html`);
    expect(revoked.status).toBe(404);
    expect(revoked.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("keeps screenshot receipts session-bound, page-bound, short-lived and write-once", async () => {
    const server = await createGuestServer({ port: 0, log: vi.fn() });
    handles.push(server);
    const status = { ...shareStatus("share_receipts", "review"), expiresAt: null };
    let writes = 0;
    await server.addShare({
      ...registration(status),
      submitFeedback: async () => ({
        captureId: "pp_canonical", pageUrl: status.previewUrl!,
        screenshotUpload: { token: "synthetic-server-only-receipt", expiresAt: Date.now() + 60_000 },
      }),
      uploadScreenshot: async () => { writes += 1; },
    });
    const unlocked = await unlock(server, status.id, status.accessCode);
    const cookie = unlocked.headers.get("set-cookie")!.split(";", 1)[0]!;
    const state = guestStateSchema.parse(await (await fetch(`${shareUrl(server, status.id)}api/state`, { headers: { cookie } })).json());
    const headers = { cookie, "content-type": "application/json", "x-share-csrf": state.csrfToken };
    const captured = await fetch(`${shareUrl(server, status.id)}api/feedback`, {
      method: "POST", headers, body: JSON.stringify({ comment: "synthetic confirmed capture", pinpoint: { url: status.previewUrl } }),
    });
    expect(await captured.json()).toEqual({ ok: true, capture: { captureId: "pp_canonical" } });
    const payload = { clientId: "pp_canonical", kind: "element", mime: "image/png", screenshot: "c3ludGhldGlj", url: status.previewUrl };
    const endpoint = `${shareUrl(server, status.id)}api/preview-screenshot-upload`;
    expect((await fetch(endpoint, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(payload) })).status).toBe(403);
    expect((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ ...payload, url: "http://127.0.0.1:3000/another-page" }) })).status).toBe(403);
    const other = await unlock(server, status.id, status.accessCode);
    const otherCookie = other.headers.get("set-cookie")!.split(";", 1)[0]!;
    const otherState = guestStateSchema.parse(await (await fetch(`${shareUrl(server, status.id)}api/state`, { headers: { cookie: otherCookie } })).json());
    expect((await fetch(endpoint, { method: "POST", headers: { ...headers, cookie: otherCookie, "x-share-csrf": otherState.csrfToken }, body: JSON.stringify(payload) })).status).toBe(403);
    expect(writes).toBe(0);
    expect((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(payload) })).status).toBe(200);
    expect((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(payload) })).status).toBe(409);
    expect(writes).toBe(1);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
    try {
      expect((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ ...payload, kind: "viewport" }) })).status).toBe(403);
      expect(writes).toBe(1);
    } finally { clock.mockRestore(); }
    expect((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ ...payload, kind: "viewport" }) })).status).toBe(403);
    expect(writes).toBe(1);
  });
});
