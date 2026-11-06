// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
const app = await loadPluginApp(() => import("./app"));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const skill = (app: string, name: string) => ({ id: `${app}/${name}`, sourceId: app, sourceName: app, name, description: `${name} description that is long enough to need a hover title.`, relativePath: name, revision: "r1", fileCount: 1 });
const NATIVE = "2f576f36-0d16-4f76-9a21-b66bcb47e100";

function render() {
  const assignments: Array<{ bundleId: string; kind: string; targetId: string }> = [];
  const snapshot = vi.fn(async () => ({ assignments: [...assignments] }));
  const setAssignment = vi.fn(async (input: { bundleId: string; kind: string; targetId: string; enabled: boolean }) => { if (input.enabled) assignments.push(input); return { ok: true }; });
  const connectStart = vi.fn(async () => ({ url: "https://executor.test/api/auth/oauth2/authorize?x=1" }));
  const disconnect = vi.fn(async () => ({ ok: true }));
  const slot = renderSlot(app.settingsSections.find(section => section.id === "catalog")!, {}, { rpc: {
    catalogOverview: () => ({
      skills: [skill("hstack", "build"), skill("hstack", "review"), skill("docs", "write")],
      bundles: [{ id: NATIVE, name: "Prospecting", description: "Prospecting tools.", skillIds: [], sourceId: null, nativeCapability: { pluginId: "prospecting", toolIds: ["tool-one"], skillIds: ["skill-one"] } }],
      targets: [{ kind: "project", id: "proj_one", name: "One", detail: null }], harnesses: [], skillsError: "ops: BB is not signed in to Executor connection ops.",
    }),
    preferences: () => ({ agentsIntegration: false }),
    executorConfiguration: () => ({ configured: true, url: "https://executor.test", mappings: [{ scope: "global", targetId: "*", toolkits: ["gtm", "ops"] }] }),
    executorOverview: () => ({ configured: true, url: "https://executor.test", error: null, connections: [
      { id: "gtm", url: "https://executor.test/mcp?connection=gtm", connected: true, assignedTo: ["Every project"] },
      { id: "ops", url: "https://executor.test/mcp?connection=ops", connected: false, assignedTo: ["Every project"] },
    ] }),
    snapshot, setAssignment, connectStart, disconnect,
  } as never });
  return { slot, snapshot, setAssignment, connectStart, disconnect };
}

it("puts the optional integration in Oh My BB", async () => {
  expect(app.settingsSections.map(section => section.id)).toEqual(["catalog", "oh-my-bb"]);
  const update = vi.fn(async () => { throw new Error("Save failed"); });
  const slot = renderSlot(app.settingsSections[1]!, {}, { rpc: { preferences: () => ({ agentsIntegration: false }), updatePreferences: update } as never });
  const toggle = await slot.findByRole("switch", { name: "Assign connections to Agents profiles" });
  await waitFor(() => expect(toggle.getAttribute("disabled")).toBeNull());
  fireEvent.click(toggle);
  await slot.findByRole("alert");
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(update).toHaveBeenCalledWith({ agentsIntegration: true });
});

it("shows connections with their sign-in state and reads assignments only on request", async () => {
  const { slot, snapshot, disconnect, connectStart } = render();
  await slot.findByText("Signed in · Every project");
  expect(slot.getByText("Not signed in")).toBeTruthy();
  expect(slot.inspection.rpcCalls.map(call => call.method).sort()).toEqual(["catalogOverview", "executorConfiguration", "executorOverview", "preferences"]);
  expect(snapshot).not.toHaveBeenCalled();

  const tab = { opener: {}, location: { href: "" }, close: vi.fn() };
  vi.stubGlobal("open", vi.fn(() => tab));
  fireEvent.click(slot.getByRole("button", { name: "Sign in to ops" }));
  await waitFor(() => expect(tab.location.href).toBe("https://executor.test/api/auth/oauth2/authorize?x=1"));
  expect(connectStart).toHaveBeenCalledWith({ connection: "ops", redirectOrigin: window.location.origin });
  expect(tab.opener).toBeNull();

  await waitFor(() => expect(slot.getByRole("button", { name: "Sign out of gtm" }).getAttribute("disabled")).toBeNull());
  fireEvent.click(slot.getByRole("button", { name: "Sign out of gtm" }));
  await waitFor(() => expect(disconnect).toHaveBeenCalledWith({ connection: "gtm" }));
});

it("groups skills by app and reports a connection that could not be read", async () => {
  const { slot } = render();
  await slot.findByText("hstack · 2 skills");
  expect(slot.getByText("docs · 1 skill")).toBeTruthy();
  expect(slot.getByText(/^ops: BB is not signed in/u)).toBeTruthy();
  const description = "build description that is long enough to need a hover title.";
  expect(slot.getByTitle(description).textContent).toBe(description);
});

it("edits plugin capability availability in one dialog", async () => {
  const { slot, setAssignment, snapshot } = render();
  fireEvent.click(await slot.findByRole("button", { name: "Projects for Prospecting" }));
  const every = await slot.findByRole("checkbox", { name: "Every project" });
  expect(snapshot).toHaveBeenCalledTimes(1);
  fireEvent.click(every);
  await waitFor(() => expect(setAssignment).toHaveBeenCalledWith({ bundleId: NATIVE, kind: "global", targetId: "*", enabled: true }));
  await waitFor(() => expect(slot.getByRole("checkbox", { name: "Every project" }).getAttribute("aria-checked")).toBe("true"));
  expect(slot.getByRole("checkbox", { name: "One" }).getAttribute("aria-checked")).toBe("false");
});

it("keeps setup guidance in its own dialog", async () => {
  const { slot } = render();
  fireEvent.click(await slot.findByRole("button", { name: "Open setup guide" }));
  expect(await slot.findByRole("heading", { name: "Executor setup guide" })).toBeTruthy();
  expect(slot.getByText(/Sign in to each connection/u)).toBeTruthy();
});
