// @vitest-environment jsdom
// Every catalog example must render cleanly: it feeds the gallery and the agent reference.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Renderer, type OpenUIError, type ParseResult } from "@openuidev/react-lang";
import { GROUPS, specLibrary } from "./catalog.js";
import { fixtureTools } from "./kit.js";
import { specTools } from "./tools.js";

afterEach(cleanup);

describe("spec catalog", () => {
  const entries = GROUPS.flatMap((group) => group.entries.map((entry) => ({ group, entry })));

  it("names each component once and gives each one an example", () => {
    const names = entries.map(({ entry }) => entry.component.name);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(specLibrary.components).sort()).toEqual([...names].sort());
    for (const { entry } of entries) {
      expect(entry.summary.length, entry.component.name).toBeGreaterThan(0);
      if (!entry.part) expect(entry.examples.length, `${entry.component.name} needs an example`).toBeGreaterThan(0);
    }
  });

  it("answers example queries only with listed tools", () => {
    const listed = new Set(specTools.map((tool) => tool.name));
    for (const { entry } of entries) for (const example of entry.examples) for (const tool of Object.keys(example.tools ?? {})) expect(listed.has(tool), `${entry.component.name}: ${tool}`).toBe(true);
  });

  for (const { group, entry } of entries) {
    for (const example of entry.examples) {
      it(`renders ${group.name} / ${entry.component.name} / ${example.name}`, async () => {
        let parsed: ParseResult | null = null;
        let errors: OpenUIError[] = [];
        const view = render(<Renderer response={example.code} library={specLibrary} isStreaming={false} toolProvider={fixtureTools(example.tools)} onParseResult={(result) => { parsed = result; }} onError={(next) => { errors = next; }} />);
        await waitFor(() => expect(parsed).not.toBeNull());
        const { root, meta } = parsed!;
        expect(root, "no root").toBeTruthy();
        expect({ errors: meta.errors, unresolved: meta.unresolved, orphaned: meta.orphaned }).toEqual({ errors: [], unresolved: [], orphaned: [] });
        await waitFor(() => expect(errors.map((error) => error.message)).toEqual([]));
        expect(view.container.textContent || view.container.querySelector("svg,img,canvas,input,button,[role]"), "renders nothing").toBeTruthy();
      });
    }
  }
});
