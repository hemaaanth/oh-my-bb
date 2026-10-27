// @vitest-environment jsdom
import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract";

type Organization = PluginRpcResult<(typeof rpcContract)["organizationSnapshot"]>;
const native: Organization = {
  groups: [{ id: "11111111-1111-4111-8111-111111111111", name: "Personal", color: "amber", position: 0, isDefault: true }],
  projects: [{ id: "opaque/project", name: "Synthetic project", groupId: "11111111-1111-4111-8111-111111111111", position: 0, icon: "", gitRemoteUrl: null, localPath: null,
    routingProfile: { description: "Saved profile", keywords: [], aliases: [], repositories: [], notFor: [], source: "manual", updatedAt: null, learnedFor: [], learnedNotFor: [], learnedAt: null } }],
  assignmentStatus: ["bundles", "applicationBindings", "agentPreferences"].map((kind) => ({ kind, state: "not-migrated", transfer: null, reverseGeneration: null })) as Organization["assignmentStatus"],
  routingConfigured: false, routingModel: "saved/model",
};
const preferences = { routingModel: "saved/model", catalogIntegration: false, credentialsIntegration: false, agentsIntegration: false, sidebarIntegration: false, tasksIntegration: false };

async function settings() {
  const app = await loadPluginApp(() => import("./app"));
  return app.settingsSections.find(({ id }) => id === "projects")!;
}

describe("native Projects settings", () => {
  it("keeps organization useful with unimported assignments and does not load optional sources on view", async () => {
    const slot = renderSlot(await settings(), {}, { rpc: { organizationSnapshot: () => native, preferences: () => preferences } });
    expect(await slot.findByText("Synthetic project")).toBeTruthy();
    expect(slot.getByLabelText("New group name")).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Load assignment choices" })).toBeNull();
    expect(slot.inspection.rpcCalls.map(({ method }) => method)).toEqual(["organizationSnapshot", "preferences"]);
    slot.lifecycle.unmount();
  });

  it("holds group actions until native data is ready while preserving a loading-time draft", async () => {
    const { promise, resolve } = Promise.withResolvers<Organization>();
    const slot = renderSlot(await settings(), {}, { rpc: { organizationSnapshot: () => promise, preferences: () => preferences } });
    const color = slot.getByRole("combobox", { name: "New group color" });
    const add = slot.getByRole("button", { name: "Add group" });
    const input = slot.getByLabelText("New group name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Draft entered during native loading" } });
    expect(color.hasAttribute("disabled")).toBe(true);
    expect(add.hasAttribute("disabled")).toBe(true);
    await act(async () => resolve(native));
    await slot.findByText("Synthetic project");
    expect(color.hasAttribute("disabled")).toBe(false);
    expect(add.hasAttribute("disabled")).toBe(false);
    expect(input.value).toBe("Draft entered during native loading");
    slot.lifecycle.unmount();
  });

  it("preserves native drafts when a slow, stale reload arrives after a newer response", async () => {
    let count = 0;
    const { promise: slow, resolve: resolveSlow } = Promise.withResolvers<Organization>();
    const slot = renderSlot(await settings(), {}, { rpc: {
      organizationSnapshot: () => ++count === 2 ? slow : { ...native, projects: native.projects.map((project) => ({ ...project, name: count === 1 ? project.name : "Latest native name" })) },
      preferences: () => preferences,
    } });
    await slot.findByText("Synthetic project");
    const input = slot.getByLabelText("New group name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Unsent group draft" } });
    await slot.behavior.emitRealtime("projects-configuration-changed", null);
    await slot.behavior.emitRealtime("projects-configuration-changed", null);
    await slot.findByText("Latest native name");
    await act(async () => resolveSlow(native));
    expect(slot.getByText("Latest native name")).toBeTruthy();
    expect(input.value).toBe("Unsent group draft");
    slot.lifecycle.unmount();
  });

  it("preserves edits typed during a routing save and a later realtime reload", async () => {
    const { promise: pending, resolve: finish } = Promise.withResolvers<void>();
    const slot = renderSlot(await settings(), {}, { rpc: {
      organizationSnapshot: () => structuredClone(native), preferences: () => preferences,
      updateRoutingProfile: async () => { await pending; return native.projects[0]!.routingProfile; },
    } });
    await slot.findByText("Synthetic project");
    const input = slot.getByLabelText("What this project is for") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "First draft" } });
    fireEvent.click(slot.getByRole("button", { name: "Save profile", hidden: true }));
    fireEvent.change(input, { target: { value: "Newer unsent draft" } });
    await act(async () => finish());
    await waitFor(() => expect(slot.inspection.rpcCalls.filter(({ method }) => method === "organizationSnapshot").length).toBe(2));
    await slot.behavior.emitRealtime("projects-configuration-changed", null);
    expect(input.value).toBe("Newer unsent draft");
    slot.lifecycle.unmount();
  });

  it("retains unresolved credential IDs when an explicitly loaded source is unavailable", async () => {
    const ready = { ...native, assignmentStatus: native.assignmentStatus.map((status) => ({ ...status, state: "source-owned" as const })) };
    const slot = renderSlot(await settings(), {}, { rpc: {
      organizationSnapshot: () => ready, preferences: () => ({ ...preferences, credentialsIntegration: true }),
      snapshot: () => ({ ...ready, credentials: [{ id: "missing/profile", name: "missing/profile", detail: "Not loaded" }], agents: [], bundles: [], globalAgentIds: [], globalBundleIds: [], projects: ready.projects.map((project) => ({ ...project, credentialId: "missing/profile", agentIds: [], bundleIds: [] })) }),
      assignmentOptionsV1: async () => { throw new Error("Credentials unavailable; keep saved selection"); },
    } });
    await slot.findByText("Synthetic project");
    expect(slot.inspection.rpcCalls.some(({ method }) => method === "assignmentOptionsV1")).toBe(false);
    fireEvent.click(slot.getByRole("button", { name: "Load assignment choices" }));
    await slot.findByText("missing/profile");
    expect(await slot.findByRole("alert")).toBeTruthy();
    expect(slot.inspection.rpcCalls.some(({ method }) => method === "updateProject")).toBe(false);
    slot.lifecycle.unmount();
  });
});
