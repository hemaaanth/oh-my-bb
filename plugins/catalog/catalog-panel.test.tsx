// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
const app = await loadPluginApp(() => import("./app"));
afterEach(cleanup);
const sources = Array.from({ length: 8 }, (_, i) => ({ id: `source-${i}`, name: `Source ${i}`, repositoryUrl: `https://github.com/example/source-${i}`, gitRef: "main", subdirectory: "skills", updatePolicy: "review", enabled: false, lastError: null, pendingRevision: null }));
function render() {
  const snapshot = vi.fn(async () => ({ assignments: [] }));
  const executorOverview = vi.fn(async () => ({ error: null, warnings: [] }));
  const slot = renderSlot(app.settingsSections.find(section => section.id === "catalog")!, {}, { rpc: {
    catalogOverview: () => ({ sources, skills: [], bundles: [{ id: "set-one", name: "Source set", description: "Every enabled skill from Source 0.", skillIds: [], sourceId: sources[0]!.id, nativeCapability: null }], targets: [], assignments: null, assignmentState: { state: "uninitialized" }, harnesses: [] }),
    preferences: () => ({ agentsIntegration: false }), executorConfiguration: () => ({ configured: true, mappings: [] }),
    snapshot, executorOverview,
  } as never });
  return { slot, snapshot, executorOverview };
}
it("puts the optional integration in Oh My BB instead of a Preferences dialog", async () => {
  expect(app.settingsSections.map(section => section.id)).toEqual(["catalog", "oh-my-bb"]);
  const update = vi.fn(async () => { throw new Error("Save failed"); });
  const slot = renderSlot(app.settingsSections[1]!, {}, { rpc: { preferences: () => ({ agentsIntegration: false }), updatePreferences: update } as never });
  const toggle = await slot.findByRole("switch", { name: "Assign toolkits to Agents profiles" });
  await waitFor(() => expect(toggle.getAttribute("disabled")).toBeNull());
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  await slot.findByRole("alert");
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(update).toHaveBeenCalledWith({ agentsIntegration: true });
});
it("bounds and filters source rows without syncing or editing anything", async () => {
  const { slot } = render();
  await slot.findByText("Source 0");
  expect(slot.queryByText("Source 7")).toBeNull();
  fireEvent.change(slot.getByRole("textbox", { name: "Search sources" }), { target: { value: "Source 7" } });
  expect(slot.getByText("Source 7")).toBeTruthy();
  expect(slot.queryByText("Source 0")).toBeNull();
  expect(slot.inspection.rpcCalls.map(call => call.method)).toEqual(["catalogOverview", "preferences", "executorConfiguration"]);
});
it("keeps assignment reads and remote checks behind their explicit actions", async () => {
  const { slot, snapshot, executorOverview } = render();
  const load = await slot.findByRole("button", { name: "Load assignments" });
  expect(snapshot).not.toHaveBeenCalled(); expect(executorOverview).not.toHaveBeenCalled();
  fireEvent.click(load);
  await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
  fireEvent.click(slot.getByRole("button", { name: "Check Executor" }));
  await waitFor(() => expect(executorOverview).toHaveBeenCalledTimes(1));
});
it("opens the guide without initializing assignments", async () => {
  const { slot } = render();
  fireEvent.click(await slot.findByRole("button", { name: "Open setup guide" }));
  await slot.findByRole("dialog");
  expect(slot.getByRole("button", { name: "Initialize standalone assignments" }).getAttribute("disabled")).not.toBeNull();
  expect(slot.inspection.rpcCalls.some(call => call.method === "initializeAssignmentsV1")).toBe(false);
});
