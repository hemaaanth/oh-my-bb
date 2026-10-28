import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { Hono, type Handler } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, { rpcContract } from "./server";
import { PREVIEW_TTL_MS, PreviewSessions } from "./lib/preview-security";

const TARGET = "https://preview.getbb.app";
const PREFIX = "/api/v1/plugins/pinpoint/http";
const disposals: Array<() => Promise<void>> = [];
interface PreviewTestHost {
  behavior: {
    fetchHttp(method: "GET" | "POST", path: string, init?: RequestInit): Promise<Response>;
  };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dispose of disposals.splice(0)) await dispose();
});
async function host() {
  const { bb, harness } = createFakePluginHost({
    pluginId: "pinpoint", appUrl: "https://bb.example.test", settings: { autoDispatch: false },
    sdk: { threads: { get: async () => ({ projectId: "synthetic-project", environmentId: null }) } },
  });
  // The SDK fake host matches literal paths only. Mount the same registered
  // handlers in Hono so capability parameters and wildcard paths are real.
  const routes = new Hono();
  const register = bb.http.route.bind(bb.http);
  bb.http.route = (method, path, handler, options) => {
    // BB matches plugin HTTP routes by exact path, not Hono's parameter syntax.
    if (!/[:*]/.test(path)) routes.on(method, path, handler as Handler);
    return register(method, path, handler, options);
  };
  await plugin(bb);
  disposals.push(() => harness.lifecycle.dispose());
  return {
    ...harness,
    behavior: {
      ...harness.behavior,
      fetchHttp: async (method: string, path: string, init?: RequestInit) =>
        routes.request(`https://bb.example.test${path}`, { ...init, method }),
    },
  };
}
async function bootstrap(harness: PreviewTestHost, target = TARGET + "/start?tab=one") {
  const response = await harness.behavior.fetchHttp("GET", `/proxy?u=${encodeURIComponent(target)}&t=synthetic-thread`, {
    headers: { host: "bb.example.test", "x-forwarded-proto": "https", cookie: "synthetic_owner_session=never_forward" },
  });
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location")!);
  return location.pathname.slice(PREFIX.length) + location.search;
}

describe("opaque preview resource capabilities", () => {
  it("loads the preview root created by the address-bar redirect", async () => {
    const harness = await host();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><body>Demo page</body></html>", {
      headers: { "content-type": "text/html" },
    })));
    const path = await bootstrap(harness, "http://localhost:8787/");
    expect(path).toMatch(/\/preview\?token=[a-f0-9]{64}&path=%2F$/);
    const response = await harness.behavior.fetchHttp("GET", path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Demo page");
  });

  it("keeps queries and target resources while withholding BB credentials and response authority", async () => {
    const harness = await host();
    const upstream = vi.fn(async (_url: string, _options?: RequestInit) => new Response('<html><head><script src="/app.js"></script></head><body>synthetic<img src="https://*"><img src="https://bb.example.test/private"></body></html>', {
      headers: { "content-type": "text/html", "set-cookie": "upstream_cookie=discard", "access-control-allow-credentials": "true" },
    }));
    vi.stubGlobal("fetch", upstream);
    const path = await bootstrap(harness);
    const response = await harness.behavior.fetchHttp("GET", path, { headers: { cookie: "synthetic_owner_session=also_never_forward" } });
    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0]![0]).toBe(TARGET + "/start?tab=one");
    const options = upstream.mock.calls[0]![1] as RequestInit;
    expect(new Headers(options.headers).get("cookie")).toBeNull();
    expect(new Headers(options.headers).get("authorization")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain("sandbox allow-scripts allow-forms allow-popups;");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).not.toContain("allow-popups-to-escape-sandbox");
    expect(csp).not.toContain("https://*");
    expect(csp).not.toContain(" https://bb.example.test ");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const text = await response.text();
    expect(text).toContain(`${path.split("&path=")[0]}&amp;path=%2Fapp.js`);
    expect(text).not.toContain("never_forward");
  });

  it("explains protected BB Connect previews without forwarding owner cookies", async () => {
    const harness = await host();
    const upstream = vi.fn(async (_url: string, _options?: RequestInit) => new Response("<html><head><title>bb connect</title></head><body>Sign in</body></html>", {
      status: 401, headers: { "content-type": "text/html" },
    }));
    vi.stubGlobal("fetch", upstream);
    const path = await bootstrap(harness, "https://owner--8787.getbb.app/demo?q=one");
    const response = await harness.behavior.fetchHttp("GET", path, {
      headers: { cookie: "synthetic_owner_session=never_forward" },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("content-security-policy")).toContain("sandbox ");
    expect(await response.text()).toContain("http://localhost:8787/demo?q=one");
    expect(new Headers(upstream.mock.calls[0]![1]?.headers).get("cookie")).toBeNull();
  });

  it("does not issue a capability to an opaque or cross-site document or to BB itself", async () => {
    const harness = await host();
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    for (const headers of [{ origin: "null" }, { "sec-fetch-site": "cross-site" }, { origin: "https://attacker.example.test" }]) {
      const response = await harness.behavior.fetchHttp("GET", `/proxy?u=${encodeURIComponent(TARGET)}&t=synthetic-thread`, { headers });
      expect(response.status).toBe(403);
    }
    const self = await harness.behavior.fetchHttp("GET", "/proxy?u=https%3A%2F%2Fbb.example.test%2F&t=synthetic-thread");
    expect(self.status).toBe(403);
    const wildcard = await harness.behavior.fetchHttp("GET", `/proxy?u=${encodeURIComponent("https://*/")}&t=synthetic-thread`);
    expect(wildcard.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects unknown capabilities, writes, and redirects outside the selected origin", async () => {
    const harness = await host();
    const upstream = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://bb.example.test/private" } }));
    vi.stubGlobal("fetch", upstream);
    const path = await bootstrap(harness);
    expect((await harness.behavior.fetchHttp("GET", "/preview?token=not-a-capability&path=%2Fstart")).status).toBe(410);
    expect((await harness.behavior.fetchHttp("POST", path, { body: "synthetic write" })).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
    const response = await harness.behavior.fetchHttp("GET", path);
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain("sandbox ");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("expires capabilities without resurrecting them when the owner returns", () => {
    const sessions = new PreviewSessions();
    const session = sessions.create({ threadId: "synthetic-thread", origin: TARGET, viewerOrigin: "https://bb.example.test", hostId: null }, 0);
    sessions.renew("other-thread", TARGET, 100);
    expect(sessions.get(session.token, PREVIEW_TTL_MS)).toBeNull();
    sessions.renew("synthetic-thread", TARGET, PREVIEW_TTL_MS + 1);
    expect(sessions.get(session.token, PREVIEW_TTL_MS + 1)).toBeNull();
  });
});

describe("guest preview isolation contract", () => {
  const input = {
    targetUrl: "https://preview.example.test/start",
    proxyBase: "https://review.example.test/preview/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    contentType: "text/html", bodyBase64: Buffer.from('<html><head></head><body><button>synthetic</button></body></html>').toString("base64"),
  };
  it("refuses legacy consumers before returning executable content", async () => {
    const harness = await host();
    await expect(harness.behavior.callRpc("prepareGuestProxy", input)).rejects.toThrow();
    await expect(harness.behavior.callRpc("prepareGuestProxy", { ...input, isolationVersion: 1, proxyBase: "https://review.example.test/proxy" })).rejects.toThrow("scoped capability");
  });
  it("returns required sandbox headers and scoped resources to versioned consumers", async () => {
    const harness = await host();
    const result = rpcContract.prepareGuestProxy.output.parse(await harness.behavior.callRpc("prepareGuestProxy", { ...input, isolationVersion: 1 }));
    expect(result.isolationVersion).toBe(1);
    expect(result.headers["content-security-policy"]).toContain("sandbox allow-scripts allow-forms allow-popups;");
    expect(result.headers["content-security-policy"]).not.toContain("allow-same-origin");
    expect(result.headers["referrer-policy"]).toBe("no-referrer");
    expect(Buffer.from(result.bodyBase64, "base64").toString()).toContain(input.proxyBase + "/.pinpoint/picker-lib.js");
  });
});

it("binds screenshot writes to the approved capture thread and page", async () => {
  const harness = await host();
  const captured = rpcContract.capture.output.parse(await harness.behavior.callRpc("capture", {
    threadId: "synthetic-thread", url: TARGET + "/start", comment: "Synthetic capture", clientId: "pp_syntheticshot",
  }));
  const upload = { threadId: "synthetic-thread", clientId: captured.row.annotation.id, kind: "element", mime: "image/webp", screenshot: "dGVzdA==", url: TARGET + "/start" };
  await expect(harness.behavior.callRpc("uploadScreenshot", { ...upload, threadId: "another-thread" })).rejects.toThrow();
  await expect(harness.behavior.callRpc("uploadScreenshot", { ...upload, url: TARGET + "/other" })).rejects.toThrow();
  const before = rpcContract.screenshot.output.parse(await harness.behavior.callRpc("screenshot", { id: upload.clientId, kind: "element" }));
  expect(before.shot).toBeNull();
  await harness.behavior.callRpc("uploadScreenshot", upload);
  await expect(harness.behavior.callRpc("uploadScreenshot", { ...upload, screenshot: "b3ZlcndyaXRl" })).rejects.toThrow();
  const after = rpcContract.screenshot.output.parse(await harness.behavior.callRpc("screenshot", { id: upload.clientId, kind: "element" }));
  expect(after.shot?.data).toBe("dGVzdA==");
});
