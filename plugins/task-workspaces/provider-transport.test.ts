import { describe, expect, it, vi } from "vitest";
import { createProviderTransport } from "./provider-transport";

describe("provider transport", () => {
  it("fails closed before an external mutation when writes are disabled", async () => {
    const fetchImpl = vi.fn();
    const transport = createProviderTransport({
      allowWrites: async () => false,
      secrets: async () => ["secret-token"],
      fetchImpl,
    });

    await expect(transport.json("https://example.test", { method: "POST" }, {
      provider: "Linear",
      mutation: true,
    })).rejects.toThrow(/changes to Linear are disabled/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows reads while writes are disabled", async () => {
    const transport = createProviderTransport({
      allowWrites: async () => false,
      secrets: async () => [],
      fetchImpl: vi.fn(async () => new Response('{"ok":true}', { status: 200 })),
    });

    await expect(transport.json("https://example.test", {}, {
      provider: "Linear",
      mutation: false,
    })).resolves.toEqual({ ok: true });
  });

  it("redacts credentials from provider errors", async () => {
    const transport = createProviderTransport({
      allowWrites: async () => true,
      secrets: async () => ["secret-token"],
      fetchImpl: vi.fn(async () => new Response('{"message":"bad secret-token"}', { status: 401 })),
    });

    await expect(transport.json("https://example.test", {}, {
      provider: "GitHub",
      mutation: false,
    })).rejects.toThrow("bad [redacted]");
  });
});
