import { describe, expect, it } from "vitest";
import { pagesHost } from "./test-fakes.js";

// Pages publishes, browses, and versions with no setup. Here.now sharing and Mapbox maps are optional, so a
// fresh install must not ask for configuration; each feature shows its own readiness where it is used.
describe("optional integrations on a fresh install", () => {
  it("does not mark the plugin as needing configuration", () => {
    const { harness } = pagesHost();
    expect(harness.inspection.needsConfigurationMessages).toEqual([]);
  });

  it("names the missing Mapbox token where a map asks for tiles", async () => {
    const { harness } = pagesHost();
    const answer = await harness.behavior.callRpc("specWeb", { method: "tile", input: { z: 3, x: 1, y: 2, theme: "dark" } });
    expect(answer).toMatchObject({ ok: false, message: expect.stringContaining("Mapbox token") });
  });

  it("tells the Share popover that Here.now is not configured", async () => {
    const { harness } = pagesHost();
    const status = await harness.behavior.callRpc("getShare", { pageId: "00000000-0000-4000-8000-000000000000" });
    expect(status).toMatchObject({ configured: false, share: null });
  });
});
