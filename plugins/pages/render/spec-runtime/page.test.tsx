// @vitest-environment jsdom
// The one-to-one guard: every example of every catalog component goes through the publish bake, the page
// runtime, and the page host, the way a published page draws it. A new component is picked up from GROUPS.
import { act } from "react";
import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenUIError } from "@openuidev/react-lang";
import { GROUPS } from "../../app/spec/catalog.js";
import { bakeSpecs, type BakeDeps } from "../../server/spec/bake.js";
import { escapeSpec } from "../spec-baked.js";
import { bakedTools, mountSpecs, pageHost, readBaked } from "./page.js";

const tile = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** A publish that allows every tool the example has a fixture for, with web lookups on. */
const depsFor = (fixtures: Record<string, unknown> | undefined): BakeDeps => ({
  tool: (tool) => fixtures && tool in fixtures ? Promise.resolve({ ok: true, data: fixtures[tool] }) : null,
  web: (method) => Promise.resolve(method === "tile" ? { ok: true, data: { dataUrl: tile } }
    : method === "geocode" ? { ok: true, data: { lat: 38.69, lng: -9.21 } }
      : method === "search" ? { ok: true, data: { images: [] } }
        : { ok: true, data: { dataUrl: tile } }),
});

afterEach(() => { document.body.innerHTML = ""; });

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

  const entries = GROUPS.flatMap((group) => group.entries.map((entry) => ({ group, entry })));
  for (const { group, entry } of entries) {
    for (const example of entry.examples) {
      it(`draws ${group.name} / ${entry.component.name} / ${example.name} on a page`, async () => {
        document.body.innerHTML = await bakeSpecs(`<main><p>Before</p><script type="text/openui-lang">${escapeSpec(example.code)}</script></main>`, depsFor(example.tools));
        let errors: OpenUIError[] = [];
        let count = 0;
        act(() => { count = mountSpecs(document, "", (next) => { errors = next; }); });
        expect(count).toBe(1);
        const root = document.querySelector(".bb-spec")?.shadowRoot?.querySelector("[data-bb-plugin-root]");
        expect(root, "no shadow root").toBeTruthy();
        await waitFor(() => expect(root!.textContent || root!.querySelector("svg,img,canvas,input,button,[role]"), "renders nothing").toBeTruthy());
        await waitFor(() => expect(errors.map((error) => error.message)).toEqual([]));
        expect(root!.textContent, "an answer was not baked").not.toMatch(/not saved with/u);
      });
    }
  }
});
