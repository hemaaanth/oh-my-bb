import { describe, expect, it } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { pagesHost } from "./test-fakes.js";
import { CODE_WORK_INSTRUCTIONS, EXAMPLES_INSTRUCTIONS, GUIDANCE_COMPONENT_MAP, PAGES_GUIDANCE, PUBLISH_INSTRUCTIONS, QUICK_COMPONENTS, WORKER_INSTRUCTIONS } from "./guidance.js";
import { specLibrary } from "../app/spec/catalog.js";
import { checkSource } from "./spec/authoring.js";
import examples from "./spec/examples.json";

const surfaces = { PAGES_GUIDANCE, CODE_WORK_INSTRUCTIONS, EXAMPLES_INSTRUCTIONS, PUBLISH_INSTRUCTIONS, WORKER_INSTRUCTIONS };
describe("Pages guidance delivery", () => {
  it.each([
    [{}, true],
    [{ thread: { parentThreadId: "parent" } }, false],
    [{ origin: { pluginId: "automation" } }, false],
    [{ origin: { pluginId: "side-chat" } }, true],
    [{ thread: { parentThreadId: "parent" }, pluginMetadata: { audience: "person" } }, true],
    [{ pluginMetadata: { audience: "agent" } }, false],
    [{ pluginMetadata: { audience: { instruction: "person" } } }, true],
    [{ origin: { pluginId: "automation" }, pluginMetadata: { audience: "PERSON" } }, false],
  ] as const)("selects tools for %j and gates person guidance", async (overrides, person) => {
    const { harness } = pagesHost();
    try {
      const configure = harness.inspection.registrations.agentConfigurationProvider!;
      const config = await configure(makePluginAgentConfigurationContext(overrides));
      expect(config.instructions).toBe(person ? PAGES_GUIDANCE : WORKER_INSTRUCTIONS);
      expect(config.tools).toEqual(["page_publish", "page_lookup", "page_browse", "page_share", "page_check", "page_examples"]);
      expect(config.skills).toEqual(["pages"]);
      expect(config.instructions!.length).toBeLessThanOrEqual(4096);
      for (const tool of harness.inspection.registrations.agentTools) if (tool.instructions) expect(tool.instructions.length).toBeLessThanOrEqual(4096);
    } finally { await harness.lifecycle.dispose(); }
  });

  it("maps real catalog components and uses current canonical signatures", () => {
    const components = specLibrary.toSpec().components;
    for (const group of GUIDANCE_COMPONENT_MAP) for (const name of group.components) expect(components[name], name).toBeDefined();
    for (const name of QUICK_COMPONENTS) {
      const signature = examples.find(entry => entry.name === name)!.signature;
      expect(signature).toBe(components[name]!.signature);
      expect(EXAMPLES_INSTRUCTIONS).toContain(signature);
    }
    for (const [name, text] of Object.entries(surfaces)) expect(text.length, name).toBeLessThanOrEqual(4096);
  });

  it("validates every worked program through the production author checker", async () => {
    const { bb, harness } = pagesHost();
    try {
      const programs = Object.values(surfaces).flatMap(text => [...text.matchAll(/```openui-lang\n([\s\S]*?)```/g)].map(match => match[1]!));
      expect(programs).toHaveLength(5);
      for (const code of programs) expect(await checkSource(bb, undefined, code, "openui-lang"), code).toMatchObject({ ok: true, issues: [] });
    } finally { await harness.lifecycle.dispose(); }
  });
});
