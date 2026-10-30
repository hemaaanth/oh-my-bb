// @vitest-environment jsdom
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { SandboxThreadResourcesView } from "../src/manager";

const app = await loadPluginApp(() => import("../app"));
const section = app.threadInfoSections.find(({ id }) => id === "sandbox")!;
const props = { threadId: "thr_remote", projectId: "p_1", environment: null };
const GIB = 1024 ** 3;
const remote = (changes: Partial<SandboxThreadResourcesView> = {}): SandboxThreadResourcesView => ({
  managed: true, sandboxId: "sandbox-fixture", provider: "daytona", state: "live",
  capability: "unsupported", capabilityReason: null,
  provisioned: { cpuCores: 4, memoryBytes: 8 * GIB, diskBytes: 20 * GIB }, target: null,
  assessment: null, stale: false, sampleError: null,
  latest: {
    sampledAt: Date.now(), cpuCores: 4, memoryBytes: 8 * GIB, diskBytes: 20 * GIB,
    cpuUsagePercent: 23, memoryUsageBytes: 2 * GIB, diskUsageBytes: 5 * GIB,
    loadAverage1m: null, oomEvents: null, oomKills: null, memoryPeakBytes: null,
    memoryAnonBytes: null, memoryFileBytes: null, memorySlabReclaimableBytes: null,
    cpuThrottledPeriods: null, cpuThrottledUsec: null,
    memoryPressureSomeAvg10: null, memoryPressureSomeAvg60: null, memoryPressureFullAvg10: null, memoryPressureFullAvg60: null,
    cpuPressureSomeAvg10: null, cpuPressureSomeAvg60: null, cpuPressureFullAvg10: null, cpuPressureFullAvg60: null,
  }, ...changes,
});
const handlers = (view: SandboxThreadResourcesView) => ({
  threadResources: () => view,
  sandboxAlwaysOn: () => ({ enabled: false }),
  threadAttachments: () => ({ credentialProfileId: null, credentials: [], toolIds: [], tools: [], skillIds: [], skills: [], agentIds: [], agents: [] }),
  projectPreparationStatus: () => null,
});
afterEach(() => { cleanup(); vi.useRealTimers(); window.sessionStorage.clear(); });

describe("sandbox Info section", () => {
  it("replaces the combined machine/model header with a native Info section", () => {
    expect(app.threadHeaderActions.some(({ id }) => id === "sandbox-resources")).toBe(false);
    expect(section.group).toBe("1_related");
    expect(section.order).toBe(-10);
  });
  it("shows nothing during lookup or for a local thread, and never reads the model route", async () => {
    let finish!: (view: unknown) => void;
    const slot = renderSlot(section, props, { rpc: { threadResources: () => new Promise((resolve) => { finish = resolve; }) } as never });
    expect(slot.queryByText("Sandbox")).toBeNull();
    await act(async () => { finish({ managed: false }); });
    expect(slot.queryByText("Sandbox")).toBeNull();
    expect(slot.queryByText("Local machine")).toBeNull();
    expect(slot.inspection.rpcCalls.map(({ method }) => method)).toEqual(["threadResources"]);
  });
  it("shows remote lifecycle and CPU/RAM/disk as native detail rows", async () => {
    const slot = renderSlot(section, props, { rpc: handlers(remote()) as never });
    await slot.findByText("Running");
    for (const text of ["Sandbox", "Status", "CPU", "RAM", "Disk", "Daytona", "23% · 4 cores", "2.0 / 8.0 GiB", "5.0 / 20 GiB"])
      expect(slot.getByText(text)).toBeTruthy();
    expect(slot.queryByText("Model")).toBeNull();
    expect(slot.queryByText("Fallback")).toBeNull();
    expect(slot.container.querySelector("details")?.open).toBe(false);
  });
  it.each([ ["sleeping", "Sleeping"], ["waking", "Waking…"], ["unavailable", "Unavailable"], ["destroyed", "Destroyed"] ] as const)("shows %s without presenting old usage as current", async (state, label) => {
    const slot = renderSlot(section, props, { rpc: handlers(remote({ state })) as never });
    await slot.findByText(label);
    expect(slot.queryByText("23% · 4 cores")).toBeNull();
    expect(slot.getByText("4 cores")).toBeTruthy();
    expect(slot.getByText("— / 8.0 GiB")).toBeTruthy();
  });
  it("keeps a failed lookup visible without claiming that the machine is local", async () => {
    const slot = renderSlot(section, props, { rpc: { threadResources: () => { throw new Error("Status lookup failed"); } } as never });
    await slot.findByText("Unavailable");
    expect(slot.getByRole("alert").textContent).toBe("Status lookup failed");
    expect(slot.queryByText("Local machine")).toBeNull();
  });
  it("keeps a newer sleeping status when an older refresh finishes later", async () => {
    vi.useFakeTimers();
    let requests = 0;
    let finishOld!: (view: SandboxThreadResourcesView) => void;
    const slot = renderSlot(section, props, { rpc: { ...handlers(remote()), threadResources: () => {
      requests++;
      return requests === 1 ? remote() : requests === 2 ? new Promise((resolve) => { finishOld = resolve; }) : remote({ state: "sleeping" });
    } } as never });
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await slot.emitRealtime("sandboxes", {});
    await act(async () => { finishOld(remote()); });
    expect(slot.getByText("Sleeping")).toBeTruthy();
    expect(slot.queryByText("Running")).toBeNull();
  });
  it("keeps resize behind its explicit restart confirmation", async () => {
    const resize = vi.fn((_input: unknown) => ({ supported: true }));
    const slot = renderSlot(section, props, { rpc: { ...handlers(remote({ capability: "supported" })), resizeSandbox: resize } as never });
    await slot.findByText("Running");
    fireEvent.click(slot.getByText("Manage sandbox"));
    fireEvent.change(slot.getByLabelText("RAM GiB"), { target: { value: "4" } });
    fireEvent.click(slot.getByRole("button", { name: "Review resize" }));
    expect(resize).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Confirm restart" }));
    await act(async () => {});
    expect(resize).toHaveBeenCalledOnce();
    expect(resize.mock.calls[0]?.[0]).toMatchObject({ sandboxId: "sandbox-fixture", memoryBytes: 4 * GIB });
  });
  it("does not poll local threads", async () => {
    vi.useFakeTimers();
    const slot = renderSlot(section, props, { rpc: { threadResources: () => ({ managed: false }) } as never });
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(slot.inspection.rpcCalls).toHaveLength(1);
  });
});
