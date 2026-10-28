// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
const app = await loadPluginApp(() => import("./app"));
afterEach(cleanup);
const sources = Array.from({ length: 8 }, (_, i) => ({ id: `source-${i}`, name: `Source ${i}`, repositoryUrl: `https://github.com/example/source-${i}`, gitRef: "main", subdirectory: "skills", updatePolicy: "review", enabled: false, lastError: null, pendingRevision: null }));
function render() {
  const assignments: Array<{ bundleId: string; kind: string; targetId: string }> = [];
  const snapshot = vi.fn(async () => ({ assignments: [...assignments] }));
  const setAssignment = vi.fn(async (input: { bundleId: string; kind: string; targetId: string; enabled: boolean }) => { if (input.enabled) assignments.push(input); return { ok: true }; });
  const executorOverview = vi.fn(async () => ({ error: null, warnings: [] }));
  const slot = renderSlot(app.settingsSections.find(section => section.id === "catalog")!, {}, { rpc: {
    catalogOverview: () => ({ sources, skills: Array.from({ length: 36 }, (_, i) => ({ id: `skill-${i}`, sourceId: sources[0]!.id, name: `Skill ${i}`, description: `A long description for skill ${i} that should stay on one line and be available in full on hover.`, enabled: true })), bundles: [{ id: "set-one", name: "Source set", description: "Every enabled skill from Source 0.", skillIds: [], sourceId: sources[0]!.id, nativeCapability: null }, { id: "custom", name: "Security review", description: "Selected security skills.", skillIds: ["skill-0"], sourceId: null, nativeCapability: null }, { id: "plugin", name: "Prospecting", description: "Prospecting tools.", skillIds: [], sourceId: null, nativeCapability: { pluginId: "prospecting", toolIds: ["tool-one"], skillIds: ["skill-one"] } }], targets: [], assignments: null, assignmentState: { state: "uninitialized" }, harnesses: [] }),
    preferences: () => ({ agentsIntegration: false }), executorConfiguration: () => ({ configured: true, mappings: [] }),
    snapshot, executorOverview, setAssignment,
  } as never });
  return { slot, snapshot, executorOverview, setAssignment };
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
  const load = await slot.findByRole("button", { name: "Projects for Source 0" });
  expect(snapshot).not.toHaveBeenCalled(); expect(executorOverview).not.toHaveBeenCalled();
  fireEvent.click(load);
  await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
  fireEvent.click(slot.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
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

it("combines source availability with its source row and edits it in one modal", async () => {
  const { slot, setAssignment, snapshot } = render();
  const button = await slot.findByRole("button", { name: "Projects for Source 0" });
  expect(slot.queryByText("Source set")).toBeNull();
  expect(slot.queryByRole("button", { name: "Load assignments" })).toBeNull();
  fireEvent.click(button);
  const checkbox = await slot.findByRole("checkbox", { name: "Every project" });
  expect(checkbox.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(checkbox);
  await waitFor(() => expect(setAssignment).toHaveBeenCalledTimes(1));
  expect(setAssignment.mock.calls[0]![0]).toMatchObject({ enabled: true, bundleId: "set-one", kind: "global", targetId: "*" });
  await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
  expect(await snapshot.mock.results[1]!.value).toMatchObject({ assignments: [{ bundleId: "set-one", kind: "global", targetId: "*" }] });
  await waitFor(() => expect(slot.getByRole("checkbox", { name: "Every project" }).getAttribute("aria-checked")).toBe("true"));
  expect(setAssignment).toHaveBeenCalledWith({ bundleId: "set-one", kind: "global", targetId: "*", enabled: true });
  expect(slot.getByRole("dialog")).toBeTruthy();
});
it("exposes the total and full descriptions for a bounded skill list", async () => {
  const { slot } = render();
  await slot.findByText("Skills · 36 total · 36 enabled");
  expect(slot.getByText("Scrollable list · 36 skills · scroll to see all")).toBeTruthy();
  expect(slot.getByRole("region", { name: "Source 0 skills", hidden: true }).querySelectorAll('[role="switch"]')).toHaveLength(36);
  const description = "A long description for skill 0 that should stay on one line and be available in full on hover.";
  expect(slot.getByTitle(description).textContent).toBe(description);
});

it("presents custom and plugin-provided sets together with clear ownership", async () => {
  const { slot } = render();
  await slot.findByRole("heading", { name: "Sets", exact: true });
  expect(slot.queryByRole("heading", { name: "Plugin capabilities" })).toBeNull();
  expect(slot.getByText("1 skill · Custom")).toBeTruthy();
  expect(slot.getByText("1 tool · 1 skill · Provided by prospecting")).toBeTruthy();
  expect(slot.getByRole("button", { name: "Projects for Security review" }).textContent).toBe("Projects");
  expect(slot.getByRole("button", { name: "Projects for Prospecting" }).textContent).toBe("Projects");
  expect(slot.getByRole("button", { name: "Edit Security review" })).toBeTruthy();
  expect(slot.queryByRole("button", { name: "Edit Prospecting" })).toBeNull();
});
