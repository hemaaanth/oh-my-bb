import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { nativeThreadResources } from "../src/provider/machine-panel.js";
it("does not misreport an unavailable native host lookup as a local machine", async () => {
  const fake = createFakePluginHost({ pluginId: "sandboxes", sdk: { hosts: { get: async () => { throw new Error("fixture host observation unavailable"); } } } });
  await expect(nativeThreadResources(fake.bb, { threadId: "fixture-thread", hostId: "fixture-host" }, false)).rejects.toThrow("host observation unavailable");
  expect(fake.harness.inspection.experimental_hostRpcCalls).toEqual([]);
  await fake.harness.dispose();
});
