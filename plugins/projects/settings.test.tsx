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

async function settings(id = "projects") {
  const app = await loadPluginApp(() => import("./app"));
  return app.settingsSections.find((section) => section.id === id)!;
}

function expand(container: HTMLElement, title: string) {
  const summary = [...container.querySelectorAll("summary")].find((element) => element.textContent === title)!;
  if (!(summary.parentElement as HTMLDetailsElement).open) fireEvent.click(summary);
}

function projectEditor(container: HTMLElement) {
  expand(container, "More");
  expand(container, "Projects and routing profiles");
  expand(container, "Synthetic project");
  expand(container, "Routing profile");
}

describe("native Projects settings", () => {
  it("keeps organization useful with unimported assignments and does not load optional sources on view", async () => {
    const slot = renderSlot(await settings(), {}, { rpc: { organizationSnapshot: () => native, preferences: () => preferences } });
    expect(await slot.findByText("Synthetic project")).toBeTruthy();
    expand(slot.container, "More");
    expand(slot.container, "Project groups");
    expect(slot.getByLabelText("New group name")).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Load assignment choices" })).toBeNull();
    expect(slot.inspection.rpcCalls.some(({ method }) => method === "snapshot" || method === "assignmentOptionsV1")).toBe(false);
    slot.lifecycle.unmount();
  });

  it("holds group actions until native data is ready while preserving a loading-time draft", async () => {
    const { promise, resolve } = Promise.withResolvers<Organization>();
    const slot = renderSlot(await settings(), {}, { rpc: { organizationSnapshot: () => promise, preferences: () => preferences } });
    expand(slot.container, "More");
    expand(slot.container, "Project groups");
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
    expand(slot.container, "More");
    expand(slot.container, "Project groups");
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
    projectEditor(slot.container);
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

  it("does not offer the obsolete standalone Credentials picker or change saved assignments", async () => {
    const ready = { ...native, assignmentStatus: native.assignmentStatus.map((status) => ({ ...status, state: "source-owned" as const })) };
    const slot = renderSlot(await settings(), {}, { rpc: {
      organizationSnapshot: () => ready, preferences: () => ({ ...preferences, credentialsIntegration: true }),
      snapshot: () => ({ ...ready, credentials: [{ id: "missing/profile", name: "missing/profile", detail: "Not loaded" }], agents: [], bundles: [], globalAgentIds: [], globalBundleIds: [], projects: ready.projects.map((project) => ({ ...project, credentialId: "missing/profile", agentIds: [], bundleIds: [] })) }),
      assignmentOptionsV1: async () => { throw new Error("Credentials unavailable; keep saved selection"); },
    } });
    await slot.findByText("Synthetic project");
    projectEditor(slot.container);
    expand(slot.container, "Assignments and migration");
    expect(slot.inspection.rpcCalls.some(({ method }) => method === "assignmentOptionsV1")).toBe(false);
    expect(slot.queryByRole("button", { name: "Load assignment choices" })).toBeNull();
    expect(slot.queryByText("missing/profile")).toBeNull();
    expect(slot.inspection.rpcCalls.some(({ method }) => method === "updateProject")).toBe(false);
    slot.lifecycle.unmount();
  });
});

describe("native Projects preferences", () => {
  it("preserves a newer model draft through a pending save and realtime refresh", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    let saved = preferences;
    const slot = renderSlot(await settings("preferences"), {}, { rpc: {
      preferences: () => saved,
      updatePreferences: async (patch: Partial<typeof preferences>) => { await promise; saved = { ...saved, ...patch }; return saved; },
    } });
    const input = await slot.findByLabelText("Project profile model") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "synthetic/first-model" } });
    fireEvent.click(slot.getByRole("button", { name: "Save changes" }));
    fireEvent.change(input, { target: { value: "synthetic/newer-unsent-model" } });
    await slot.behavior.emitRealtime("projects-configuration-changed", null);
    await act(async () => resolve());
    await slot.behavior.emitRealtime("projects-configuration-changed", null);
    expect(saved.routingModel).toBe("synthetic/first-model");
    expect(input.value).toBe("synthetic/newer-unsent-model");
    slot.lifecycle.unmount();
  });

  it("keeps saved opt-ins when saving a switch fails without probing sources", async () => {
    const slot = renderSlot(await settings("oh-my-bb"), {}, { rpc: {
      preferences: () => ({ ...preferences, catalogIntegration: true, tasksIntegration: true }),
      updatePreferences: async () => { throw new Error("Synthetic save refused"); },
    } });
    await waitFor(() => expect(slot.getByRole("switch", { name: "Executor" }).getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(slot.getByRole("switch", { name: "Tasks" }));
    expect(await slot.findByRole("alert")).toBeTruthy();
    expect(slot.getByRole("switch", { name: "Tasks" }).getAttribute("aria-checked")).toBe("true");
    expect(slot.getByRole("switch", { name: "Executor" }).getAttribute("aria-checked")).toBe("true");
    expect(slot.inspection.rpcCalls.some(({ method }) => method === "snapshot" || method === "assignmentOptionsV1")).toBe(false);
    slot.lifecycle.unmount();
  });
});
