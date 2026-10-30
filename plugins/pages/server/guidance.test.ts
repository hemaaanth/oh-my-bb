import { describe, expect, it } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { pagesHost } from "./test-fakes.js";
import { PAGES_GUIDANCE } from "./tools.js";

describe("Pages guidance delivery", () => {
  it("provides surface and component selection through both instruction channels", async () => {
    const { harness } = pagesHost();
    const registrations = harness.inspection.registrations;
    const config = await registrations.agentConfigurationProvider!(makePluginAgentConfigurationContext());
    const publish = registrations.agentTools.find(tool => tool.name === "page_publish")!;
    expect(config.instructions).toContain(PAGES_GUIDANCE);
    expect(publish.instructions).toContain(PAGES_GUIDANCE);
    expect(config.tools).toEqual(expect.arrayContaining(["page_examples", "page_check"]));
  });
});
