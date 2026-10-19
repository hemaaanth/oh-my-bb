import { afterEach, describe, expect, it, vi } from "vitest";
import { needsBaseUrlMessage } from "../server.js";
import { webhooksHost } from "./test-fakes.js";

afterEach(() => vi.unstubAllGlobals());

async function messages(options: Parameters<typeof webhooksHost>[0]) {
  return (await webhooksHost(options)).harness.inspection.needsConfigurationMessages;
}

describe("configuration status", () => {
  it("asks for a public base URL when none is set and BB has no app URL", async () => {
    expect(await messages({})).toEqual([needsBaseUrlMessage("")]);
  });

  it("names the setting and the commands that fix it", () => {
    const message = needsBaseUrlMessage("");
    expect(message).toContain("publicBaseUrl");
    expect(message).toContain("bb plugin config webhooks set publicBaseUrl");
    expect(message).toContain("bb plugin reload webhooks");
  });

  it("says the setting is invalid when it is set but unusable", async () => {
    const [message] = await messages({ settings: { publicBaseUrl: "http://hooks.example.com" } });
    expect(message).toBe(needsBaseUrlMessage("http://hooks.example.com"));
    expect(message).toContain("is not an https:// origin");
  });

  it("does not ask when the setting is a valid https origin", async () => {
    expect(await messages({ settings: { publicBaseUrl: "https://hooks.example.com" } })).toEqual([]);
  });

  it("does not ask when the setting is empty but BB has an https app URL", async () => {
    expect(await messages({ appUrl: "https://bb.example.com" })).toEqual([]);
  });

  it("does not ask when an invalid setting falls back to an https app URL", async () => {
    expect(await messages({ settings: { publicBaseUrl: "not a url" }, appUrl: "https://bb.example.com" })).toEqual([]);
  });

  it("asks when BB's app URL is not https", async () => {
    expect(await messages({ appUrl: "http://bb.local:3000" })).toEqual([needsBaseUrlMessage("")]);
  });
});
