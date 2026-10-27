import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { loadAgentPreferences } from "./preferences";

it("moves the native channel preference once and preserves it through reload", async () => {
  let fake = createFakePluginHost({ pluginId: "agent-profiles", settings: { defaultResponseBehavior: "directed", jevApiKey: "fixture-private-key" } });
  try {
    await loadAgentPreferences(fake.bb);
    expect(await fake.harness.callRpc("agentPreferences", null)).toEqual({ responseBehavior: "directed" });
    await expect(fake.harness.behavior.callRpc("updateAgentPreferences", { responseBehavior: "smart" }, { experimental_caller: { kind: "plugin", pluginId: "fixture" } })).rejects.toThrow("Owner client");
    await fake.harness.callRpc("updateAgentPreferences", { responseBehavior: "smart" });
    fake = await fake.harness.lifecycle.reload(async bb => { await loadAgentPreferences(bb); });
    expect(await fake.harness.callRpc("agentPreferences", null)).toEqual({ responseBehavior: "smart" });
    expect(Object.keys(fake.harness.registrations.settingsDescriptors)).toEqual(["jevApiKey"]);
  } finally { await fake.harness.dispose(); }
});
