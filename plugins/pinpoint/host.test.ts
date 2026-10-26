import { afterEach, expect, it, vi } from "vitest";
import entry from "./host";
import { hostContract } from "./host-contract";

afterEach(() => vi.unstubAllGlobals());

it("enforces the caller resource budget for declared and streamed bodies without blocking a later fetch", async () => {
  const controller = new AbortController();
  const context = { signal: controller.signal, lifecycle: { signal: controller.signal } };
  const input = hostContract.fetch.input.parse({ url: "https://preview.example.test/asset", method: "GET", headers: {}, bodyBase64: null, maxResponseBytes: 8 });
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response("too large", { headers: { "content-length": "9" } }))
    .mockResolvedValueOnce(new Response("too large"))
    .mockResolvedValueOnce(new Response("valid"));
  vi.stubGlobal("fetch", fetch);
  await expect(entry.handlers.fetch(input, context as never)).rejects.toThrow();
  await expect(entry.handlers.fetch(input, context as never)).rejects.toThrow();
  const result = await entry.handlers.fetch(input, context as never);
  expect(Buffer.from(result.bodyBase64, "base64").toString()).toBe("valid");
  expect(result.continuationToken).toBeNull();
});
