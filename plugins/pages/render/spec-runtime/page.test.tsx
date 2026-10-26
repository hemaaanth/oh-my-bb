// @vitest-environment jsdom
// Published components read their baked resources without a live BB backend.
import { describe, expect, it } from "vitest";
import { bakedTools, pageHost, readBaked } from "./page.js";

const tile = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";


describe("page runtime", () => {
  it("answers web lookups and Query calls only from baked answers", async () => {
    const host = pageHost({ "web:geocode:{\"name\":\"Lisbon\"}": { ok: true, data: { lat: 1, lng: 2 } }, "tool:file:{\"path\":\"a\"}": { ok: false, message: "No such file." } });
    expect(host.kind).toBe("page");
    expect(host.replies).toBe(false);
    await expect(host.web("geocode", { name: "Lisbon" })).resolves.toEqual({ lat: 1, lng: 2 });
    await expect(host.web("tile", { z: 1, x: 0, y: 0, theme: "light" })).rejects.toThrow("not saved");
    const tools = bakedTools(readBaked(document));
    await expect(tools.file!({ path: "a" })).rejects.toThrow('Query("file") was not saved with this page.');
  });

  it("decodes an embedded asset offline and does not fetch a missing file", async () => {
    const host = pageHost({ 'tool:asset:{"path":"thumb.png"}': { ok: true, data: { dataUrl: tile } } });
    const image = await host.loadAsset("thumb.png");
    expect(image.ok).toBe(true);
    if (!image.ok) throw new Error(image.error);
    expect(image.type).toBe("image/png");
    expect([...new Uint8Array(image.bytes).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect((await host.loadAsset("missing.glb")).ok).toBe(false);
  });

});
