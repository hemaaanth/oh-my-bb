import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { signStandardWebhook } from "./auth.js";
import { keepListening, parseListenerPort, startListener } from "./listener.js";
import { THREAD, createEndpoint, nowSeconds, webhooksHost } from "./test-fakes.js";

const ID = "wh_0123456789abcdef01234567";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return typeof address === "object" && address ? address.port : 0;
}

/** The plugin test host stubs global fetch, so the real-socket test uses node:http. */
function post(url: string, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "POST", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** keepListening starts in the background, so wait until the port answers. */
async function waitForPort(port: number): Promise<void> {
  for (let tries = 0; tries < 50; tries += 1) {
    if (await post(`http://127.0.0.1:${port}/`, {}, "").then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`port ${port} never answered`);
}

describe("parseListenerPort", () => {
  it("is off when empty and refuses ports outside 1024 to 65535", () => {
    expect(parseListenerPort("")).toBeNull();
    expect(parseListenerPort("  ")).toBeNull();
    expect(parseListenerPort("43128")).toBe(43128);
    for (const bad of ["80", "70000", "12ab", "-1", "1e4"]) expect(parseListenerPort(bad)).toBe("invalid");
  });
});

describe("webhook listener", () => {
  it("passes POST /webhook/<id> to the handler and answers 404 to everything else", async () => {
    const seen: Array<{ id: string; body: string; type: string | null; cookie: string | null }> = [];
    const listener = await startListener({
      port: 0,
      onError: () => undefined,
      handle: async (request, id) => {
        seen.push({ id, body: await request.text(), type: request.headers.get("content-type"), cookie: request.headers.get("cookie") });
        return new Response('{"ok":true}', { status: 202, headers: { "x-slack-no-retry": "1" } });
      },
    });
    const base = `http://127.0.0.1:${listener.port}`;
    try {
      const ok = await fetch(`${base}/webhook/${ID}`, { method: "POST", headers: { "content-type": "application/json", cookie: "a=b" }, body: '{"x":1}' });
      expect(ok.status).toBe(202);
      expect(ok.headers.get("x-slack-no-retry")).toBe("1");
      expect(seen).toEqual([{ id: ID, body: '{"x":1}', type: "application/json", cookie: null }]);

      for (const [method, path] of [
        ["GET", `/webhook/${ID}`],
        ["POST", "/webhook/wh_short"],
        ["POST", `/webhook/${ID}/extra`],
        ["POST", "/api/v1/projects"],
        ["POST", "/"],
      ]) {
        const response = await fetch(`${base}${path}`, { method, ...(method === "POST" ? { body: "{}" } : {}) });
        expect(response.status, `${method} ${path}`).toBe(404);
      }
      expect(seen).toHaveLength(1);
    } finally {
      await listener.close();
    }
  });

  it("answers an unread oversized body and closes the connection", async () => {
    const listener = await startListener({ port: 0, onError: () => undefined, handle: async () => new Response("{}", { status: 413 }) });
    try {
      const response = await fetch(`http://127.0.0.1:${listener.port}/webhook/${ID}`, { method: "POST", body: "x".repeat(2_000_000) });
      expect(response.status).toBe(413);
    } finally {
      await listener.close();
    }
  });

  it("retries while the port is busy, as when a reload overlaps the old copy", async () => {
    const old = await startListener({ port: 0, onError: () => undefined, handle: async () => new Response("old") });
    const events: string[] = [];
    const next = keepListening({
      port: old.port,
      retryMs: 20,
      onError: () => undefined,
      handle: async () => new Response("{}", { status: 202 }),
      onListening: () => events.push("listening"),
      onGiveUp: (reason) => events.push(`gave up: ${reason}`),
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(events).toEqual([]);
      await old.close();
      await waitForPort(old.port);
      expect(events).toEqual(["listening"]);
      expect(await post(`http://127.0.0.1:${old.port}/webhook/${ID}`, {}, "{}")).toBe(202);
    } finally {
      await next.close();
    }
  });

  it("runs the real deliver checks when the plugin's listenerPort is set", async () => {
    const port = await freePort();
    const host = await webhooksHost({ settings: { listenerPort: String(port), publicBaseUrl: "https://bb.example.com" } });
    try {
      const { endpoint, secret } = await createEndpoint(host);
      const detail = (await host.harness.behavior.callRpc("webhooks_get", { endpointId: endpoint.id })) as { endpoint: { deliveryPath: string } };
      expect(detail.endpoint.deliveryPath).toBe(`/webhook/${endpoint.id}`);

      await waitForPort(port);
      const url = `http://127.0.0.1:${port}/webhook/${endpoint.id}`;
      const body = JSON.stringify({ event: { event: "signup" } });
      expect(await post(url, { "content-type": "application/json" }, body)).toBe(401);

      const timestamp = nowSeconds();
      const signature = signStandardWebhook({ secret: secret!, id: "msg_listener", timestamp, body });
      const headers = { "content-type": "application/json", "webhook-id": "msg_listener", "webhook-timestamp": String(timestamp), "webhook-signature": signature };
      expect(await post(url, headers, body)).toBe(200);
      expect(host.sent).toEqual([expect.objectContaining({ threadId: THREAD })]);
    } finally {
      await host.harness.lifecycle.dispose();
    }
    await expect(post(`http://127.0.0.1:${port}/webhook/${ID}`, {}, "{}")).rejects.toThrow();
  });

  it("stays off and keeps the BB route path when listenerPort is empty", async () => {
    const host = await webhooksHost();
    try {
      const { endpoint } = await createEndpoint(host);
      const detail = (await host.harness.behavior.callRpc("webhooks_get", { endpointId: endpoint.id })) as { endpoint: { deliveryPath: string } };
      expect(detail.endpoint.deliveryPath).toBe(`/api/v1/plugins/webhooks/http/deliver?endpoint=${endpoint.id}`);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
});
