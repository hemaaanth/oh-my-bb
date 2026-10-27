// @vitest-environment jsdom
import { act, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it } from "vitest";
const work = "11111111-1111-4111-8111-111111111111",
  personal = "22222222-2222-4222-8222-222222222222";
const prefs = {
  routingModel: "saved/model",
  catalogIntegration: false,
  credentialsIntegration: false,
  agentsIntegration: false,
  sidebarIntegration: false,
  tasksIntegration: false,
};
const native = {
  groups: [
    { id: work, name: "work", color: "blue", position: 0, isDefault: false },
    {
      id: personal,
      name: "personal",
      color: "green",
      position: 1,
      isDefault: true,
    },
  ],
  projects: [
    {
      id: "project",
      name: "Synthetic project",
      gitRemoteUrl: null,
      localPath: null,
      groupId: work,
      position: 0,
      icon: "",
      routingProfile: {
        description: "",
        keywords: [],
        aliases: [],
        repositories: [],
        notFor: [],
        source: "none",
        updatedAt: null,
        learnedFor: [],
        learnedNotFor: [],
        learnedAt: null,
      },
    },
  ],
  assignmentStatus: [],
  routingConfigured: true,
  routingModel: "saved/model",
};
async function section(id: string, extra: Record<string, unknown> = {}) {
  const app = await loadPluginApp(() => import("./app"));
  return renderSlot(
    app.settingsSections.find((x) => x.id === id)!,
    {},
    {
      rpc: {
        organizationSnapshot: () => native,
        preferences: () => prefs,
        scriptsPreferences: () => ({ autoStartServices: false }),
        ...extra,
      } as never,
    },
  );
}
describe("Projects settings consolidation", () => {
  it("has only native settings sections and no navigation page", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.navPanels).toEqual([]);
    expect(app.settingsSections.map((x) => x.id)).toEqual([
      "preferences",
      "projects",
      "groups",
      "more",
      "oh-my-bb",
    ]);
  });
  it("shows compact project rows and direct assignment/refresh buttons without project creation or a navigation link", async () => {
    const v = await section("projects");
    await v.findByText("Synthetic project");
    expect(
      v.getByRole("button", { name: "Edit Synthetic project" }),
    ).toBeTruthy();
    expect(
      v.getByRole("button", { name: "Load assignment choices" }),
    ).toBeTruthy();
    expect(v.getByRole("button", { name: "Refresh profiles" })).toBeTruthy();
    expect(
      v.queryByRole("button", {
        name: /Add project|Manage project environments/,
      }),
    ).toBeNull();
    expect(
      v.inspection.rpcCalls.some((x) => x.method.includes("generate")),
    ).toBe(false);
    v.lifecycle.unmount();
  });
  it("keeps the paid action behind its explanatory confirmation", async () => {
    const v = await section("projects");
    await v.findByText("Synthetic project");
    fireEvent.click(v.getByRole("button", { name: "Refresh profiles" }));
    expect(await v.findByRole("dialog")).toBeTruthy();
    expect(v.getByText(/may incur cost/)).toBeTruthy();
    expect(
      v.inspection.rpcCalls.some(
        (x) => x.method === "generateMissingRoutingProfiles",
      ),
    ).toBe(false);
    v.lifecycle.unmount();
  });
  it("renders default and editable group rows with the same controls and a disabled delete button", async () => {
    const v = await section("groups");
    await v.findByDisplayValue("personal");
    expect(
      v
        .getByRole("button", { name: "Delete personal" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      v.getByRole("button", { name: "Delete work" }).hasAttribute("disabled"),
    ).toBe(false);
    expect(v.getByRole("button", { name: "Colour for work" })).toBeTruthy();
    expect(v.queryByRole("combobox")).toBeNull();
    v.lifecycle.unmount();
  });
  it("keeps a group-name draft on unrelated realtime reads and saves it on blur", async () => {
    let saved: unknown;
    const v = await section("groups", {
      saveGroup: (input: unknown) => {
        saved = input;
        return native.groups[0];
      },
    });
    const input = (await v.findByLabelText(
      "Group name: work",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New name" } });
    await v.behavior.emitRealtime("projects-configuration-changed", {});
    expect(input.value).toBe("New name");
    fireEvent.blur(input);
    await waitFor(() =>
      expect(saved).toMatchObject({
        id: work,
        name: "New name",
        color: "blue",
      }),
    );
    v.lifecycle.unmount();
  });
  it("autosaves preferences without a Save button and preserves a newer draft while a save waits", async () => {
    const pending = Promise.withResolvers<void>();
    let saved = prefs;
    let calls = 0;
    const v = await section("preferences", {
      preferences: () => saved,
      updatePreferences: async (input: Partial<typeof prefs>) => {
        if (++calls === 1) await pending.promise;
        saved = { ...saved, ...input };
        return saved;
      },
    });
    const input = (await v.findByLabelText(
      "Project profile model",
    )) as HTMLInputElement;
    expect(v.queryByRole("button", { name: "Save changes" })).toBeNull();
    fireEvent.change(input, { target: { value: "model/first" } });
    fireEvent.blur(input);
    await waitFor(() => expect(calls).toBe(1));
    fireEvent.change(input, { target: { value: "model/newer" } });
    await act(async () => pending.resolve());
    expect(input.value).toBe("model/newer");
    await waitFor(() => expect(saved.routingModel).toBe("model/newer"), {
      timeout: 2500,
    });
    v.lifecycle.unmount();
  });
  it("preserves the old service autostart value and changes only that setting", async () => {
    let patch: unknown;
    const v = await section("preferences", {
      saveScriptsPreferences: (input: unknown) => {
        patch = input;
        return input;
      },
    });
    await v.findByLabelText("Project profile model");
    const toggle = v.getByRole("switch", {
      name: "Start workspace services automatically",
    });
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => expect(patch).toEqual({ autoStartServices: true }));
    expect(
      v.inspection.rpcCalls.some((x) => x.method === "updatePreferences"),
    ).toBe(false);
    v.lifecycle.unmount();
  });
  it("explains every integration and preserves saved choices when a save fails", async () => {
    const v = await section("oh-my-bb", {
      preferences: () => ({ ...prefs, catalogIntegration: true }),
      updatePreferences: () => {
        throw new Error("Synthetic refusal");
      },
    });
    await waitFor(() =>
      expect(
        v
          .getByRole("switch", { name: "Executor" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(v.getByText(/skill choices/)).toBeTruthy();
    expect(v.getByText(/sidebar project groups/)).toBeTruthy();
    fireEvent.click(v.getByRole("switch", { name: "Executor" }));
    expect(await v.findByRole("alert")).toBeTruthy();
    expect(
      v.getByRole("switch", { name: "Executor" }).getAttribute("aria-checked"),
    ).toBe("true");
    v.lifecycle.unmount();
  });
  it("keeps only the standard setup-guide row in More and opens it without navigating", async () => {
    const v = await section("more");
    expect(v.getByText("Setup and usage.")).toBeTruthy();
    fireEvent.click(v.getByRole("button", { name: "Open setup guide" }));
    expect(await v.findByRole("dialog")).toBeTruthy();
    expect(v.inspection.navigateCalls).toEqual([]);
    v.lifecycle.unmount();
  });
});
