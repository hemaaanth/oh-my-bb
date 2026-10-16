import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { gatewayEnvironment } from "../fx-acp.mjs";

/** @type {Array<() => void | Promise<unknown>>} */
const cleanups = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

it("relays host-reachable URLs through private loopback endpoints without a login", async () => {
  /** @type {Array<{url: string | undefined, method: string | undefined, body: string}>} */
  const requests = [];
  const upstream = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, method: req.method, body });
    res.writeHead(200, { "content-type": req.method === "GET" ? "application/json" : "text/event-stream" });
    res.end(req.method === "GET" ? '{"models":[]}' : 'event: response.completed\ndata: {"type":"response.completed"}\n\n');
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  cleanups.push(() => new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  const base = `http://localhost:${address.port}`;
  const gateway = await gatewayEnvironment({
    FX_E2E_OPENAI_CODEX_RESPONSES_URL: `${base}/v1/responses?gateway_token=fake-test-value`,
    FX_E2E_OPENAI_CODEX_MODELS_URL: `${base}/v1/models?gateway_token=fake-test-value`,
  });
  cleanups.push(gateway.close);
  expect(gateway.env.FX_AUTH_MODE).toBe("host-managed");
  expect(gateway.env.FX_PROVIDER).toBe("gateway");
  const modelsUrl = gateway.env.FX_E2E_OPENAI_CODEX_MODELS_URL;
  const responsesUrl = gateway.env.FX_E2E_OPENAI_CODEX_RESPONSES_URL;
  if (!modelsUrl || !responsesUrl) throw new Error("Missing relay URLs");
  const models = await fetch(modelsUrl);
  expect(await models.json()).toEqual({ models: [] });
  const response = await fetch(responsesUrl, { method: "POST", body: '{"model":"gpt-6-sol"}' });
  expect(await response.text()).toBe('event: response.completed\ndata: {"type":"response.completed"}\n\n');
  expect(requests).toEqual([
    { url: "/v1/models?gateway_token=fake-test-value", method: "GET", body: "" },
    { url: "/v1/responses?gateway_token=fake-test-value", method: "POST", body: '{"model":"gpt-6-sol"}' },
  ]);
  const local = new URL(responsesUrl);
  expect((await fetch(`${local.origin}/responses`, { method: "POST" })).status).toBe(404);
});

it("leaves standalone FX unchanged but refuses an incomplete gateway pair", async () => {
  const env = { FX_PROVIDER: "codex" };
  const standalone = await gatewayEnvironment(env);
  expect(standalone.env).toBe(env);
  standalone.close();
  await expect(gatewayEnvironment({ FX_E2E_OPENAI_CODEX_MODELS_URL: "https://host.example/models" })).rejects.toThrow(/Both/);
});
