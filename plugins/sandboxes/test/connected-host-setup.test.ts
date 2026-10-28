import { expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { connectedHostSetup } from "../src/connected-host-setup.js";

it("waits for activation before terminal setup and stops with the plugin", async () => {
  let phase = "suspended";
  const { bb, harness } = createFakePluginHost({ pluginId: "sandboxes", sdk: { hosts: {
    get: async () => ({ id: "host_test", status: "connected", lifecycle: { phase } }) as never,
  } } });
  const prepare = vi.fn(async () => {});
  const enqueue = connectedHostSetup(bb, prepare);
  enqueue("host_test");
  const service = harness.runService("connected-host-setup");
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(prepare).not.toHaveBeenCalled();
  phase = "active";
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledExactlyOnceWith("host_test"), { timeout: 2000 });
  await harness.lifecycle.dispose();
  await service.done;
});
