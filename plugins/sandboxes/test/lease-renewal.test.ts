import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { registerNativeLeaseRenewal } from "../src/provider/lease-renewal.js";

it("renews connected active machines, isolates failures, and leaves sleeping machines alone", async () => {
  const fake = createFakePluginHost({ pluginId: "sandboxes", sdk: { hosts: { list: vi.fn(async () => [
    { id: "failed", machineProviderId: "sandbox-box", status: "connected", lifecycle: { phase: "active" } },
    { id: "awake", machineProviderId: "sandbox-box", status: "connected", lifecycle: { phase: "active" } },
    { id: "sleeping", machineProviderId: "sandbox-box", status: "disconnected", lifecycle: { phase: "suspended" } },
    { id: "stopping", machineProviderId: "sandbox-box", status: "connected", lifecycle: { phase: "suspending" } },
    { id: "local", machineProviderId: null, status: "connected", lifecycle: { phase: "active" } },
  ]) } } });
  const getResource = vi.spyOn(fake.bb.experimental_machines, "getResource").mockImplementation(async hostId => ({ id: hostId }));
  const renewLease = vi.fn(async ({ hostId }: { hostId: string }) => { if (hostId === "failed") throw Error("provider unavailable"); });
  registerNativeLeaseRenewal(fake.bb, new Map([["sandbox-box", { parseResource: r => r, renewLease }]]));
  await fake.harness.runSchedule("sandbox-lease-renewal");
  expect(renewLease.mock.calls.map(([r]) => r.hostId)).toEqual(["failed", "awake"]);
  expect(getResource).toHaveBeenCalledTimes(2);
  await fake.harness.runSchedule("sandbox-lease-renewal");
  expect(renewLease).toHaveBeenCalledTimes(4);
  await fake.harness.dispose();
});
