import { afterEach, describe, expect, it, vi } from "vitest";
import { needsBaseUrlMessage } from "../server.js";
import { createEndpoint, webhooksHost } from "./test-fakes.js";

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
    expect(message).toContain("Listener port");
  });

  it("says the banner clears on reload, not when the setting is saved", () => {
    expect(needsBaseUrlMessage("")).toContain("this banner clears when the plugin next loads");
    expect(needsBaseUrlMessage("")).toContain("bb plugin reload webhooks");
  });

  it("does not ask when a listener port is set, since a tunnel to it is a public route", async () => {
    expect(await messages({ settings: { listenerPort: "43128" } })).toEqual([]);
  });

  it("still asks when the listener port is invalid", async () => {
    expect(await messages({ settings: { listenerPort: "80" } })).toEqual([needsBaseUrlMessage("")]);
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

describe("live settings", () => {
  it("rejects values the fields cannot use", async () => {
    const { harness } = await webhooksHost({ settings: { publicBaseUrl: "https://hooks.example.com" } });
    await expect(harness.behavior.setSettings({ publicBaseUrl: "http://hooks.example.com" })).rejects.toThrow();
    await expect(harness.behavior.setSettings({ listenerPort: "80" })).rejects.toThrow();
    await harness.lifecycle.dispose();
  });

  it("applies a saved public base URL to the overview and to the CLI without a reload", async () => {
    const host = await webhooksHost({ settings: { publicBaseUrl: "https://hooks.example.com" } });
    try {
      const { endpoint } = await createEndpoint(host);
      const url = async () => ((await host.harness.behavior.callRpc("webhooks_overview")) as { publicBaseUrl: string | null }).publicBaseUrl;
      expect(await url()).toBe("https://hooks.example.com");

      const before = host.harness.inspection.realtimeSignals.length;
      await host.harness.behavior.setSettings({ publicBaseUrl: "https://other.example.com/hooks/" });
      await applied();
      expect(host.harness.inspection.realtimeSignals.slice(before)).toEqual([expect.objectContaining({ channel: "webhooks-changed" })]);
      expect(await url()).toBe("https://other.example.com/hooks");
      const shown = await host.harness.behavior.runCli(["show", endpoint.id]);
      expect(shown.stdout).toContain(`https://other.example.com/hooks/api/v1/plugins/webhooks/http/deliver?endpoint=${endpoint.id}`);

      await host.harness.behavior.setSettings({ publicBaseUrl: null });
      await applied();
      expect(await url()).toBeNull();
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });

  it("asks for a public base URL when a saved change leaves none, and only once", async () => {
    const host = await webhooksHost({ settings: { publicBaseUrl: "https://hooks.example.com" } });
    try {
      await host.harness.behavior.setSettings({ publicBaseUrl: null });
      await applied();
      await host.harness.behavior.setSettings({ listenerPort: "" });
      await applied();
      expect(host.harness.inspection.needsConfigurationMessages).toEqual([needsBaseUrlMessage("")]);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
});

/** The settings listener applies a change on a promise chain, so let it finish. */
const applied = () => new Promise((resolve) => setTimeout(resolve, 20));
