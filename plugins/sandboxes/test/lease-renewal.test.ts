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

it("recovers disconnected active sandboxes via suspend and auto-resumes only when work is waiting", async () => {
  const suspend = vi.fn(async () => ({}));
  const resume = vi.fn(async () => ({}));
  const staleAt = Date.now() - 5 * 60_000;
  const fake = createFakePluginHost({
    pluginId: "sandboxes",
    sdk: {
      hosts: {
        list: vi.fn(async () => [
          { id: "crashed-busy", machineProviderId: "sandbox-box", status: "disconnected", lifecycle: { phase: "active" }, lastSeenAt: staleAt, createdAt: staleAt },
          { id: "crashed-idle", machineProviderId: "sandbox-box", status: "disconnected", lifecycle: { phase: "active" }, lastSeenAt: staleAt, createdAt: staleAt },
        ]),
        experimental_suspend: suspend,
        experimental_resume: resume,
      },
      threads: {
        list: vi.fn(async ({ hostId }: { hostId: string }) =>
          hostId === "crashed-busy"
            ? { items: [{ id: "thr_1", status: "active", queuedMessageCount: 1 }] }
            : { items: [{ id: "thr_2", status: "idle", queuedMessageCount: 0 }] },
        ),
      },
    },
  });
  registerNativeLeaseRenewal(fake.bb, new Map([["sandbox-box", { parseResource: (r) => r, renewLease: vi.fn() }]]));
  await fake.harness.runSchedule("sandbox-lease-renewal");
  expect(suspend.mock.calls.map(([a]) => a.hostId)).toEqual(["crashed-busy", "crashed-idle"]);
  expect(resume.mock.calls.map(([a]) => a.hostId)).toEqual(["crashed-busy"]);
  await fake.harness.dispose();
});
