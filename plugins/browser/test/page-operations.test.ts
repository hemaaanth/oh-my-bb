import { describe, expect, it } from "vitest";
// @ts-expect-error Browser extension source is intentionally plain JavaScript.
import { pageOperation } from "../browser-extension/page-operations.js";

describe("high-density screenshots", () => {
  it("uses CDP clip scale without resizing the page", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    await pageOperation(async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 1440, clientHeight: 900 } };
      if (method === "Page.captureScreenshot") return { data: "png" };
      return {};
    }, ["screenshot", "--scale", "3"], { owned: false });

    expect(calls).toContainEqual({
      method: "Page.captureScreenshot",
      params: { format: "png", captureBeyondViewport: false, clip: { x: 0, y: 0, width: 1440, height: 900, scale: 3 } },
    });
  });

  it("rejects unbounded full-page scale captures", async () => {
    await expect(pageOperation(async () => ({}), ["screenshot", "--full", "--scale", "2"], { owned: false }))
      .rejects.toThrow("cannot be combined");
  });
});
