// @vitest-environment jsdom
import { act, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it, vi } from "vitest";
vi.mock("emoji-picker-react", () => ({
  EmojiStyle: { NATIVE: "native" },
  Theme: { AUTO: "auto" },
  default: ({
    onEmojiClick,
  }: {
    onEmojiClick(data: { emoji: string }): void;
  }) => (
    <button onClick={() => onEmojiClick({ emoji: "🚀" })}>
      Choose rocket emoji
    </button>
  ),
}));
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
      "groups",
      "projects",
      "more",
    ]);
  });
  it("shows project metadata without confusing global assignment/refresh buttons without project creation or a navigation link", async () => {
    const v = await section("projects");
    await v.findByText("Synthetic project");
    expect(
      v.getByRole("button", { name: "Edit Synthetic project" }),
    ).toBeTruthy();
    expect(
      v.queryByRole("button", { name: "Load assignment choices" }),
    ).toBeNull();
    expect(v.queryByRole("button", { name: "Refresh profiles" })).toBeNull();
    expect(v.getByText("No repository")).toBeTruthy();
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
      patchGroup: (input: unknown) => {
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
      "Project description model",
    )) as HTMLInputElement;
    expect(v.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(v.queryByText("Changes save automatically.")).toBeNull();
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
    await v.findByLabelText("Project description model");
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
  it("has no obsolete integration switchboard", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.settingsSections.some((x) => x.id === "oh-my-bb")).toBe(false);
  });
  it("saves a custom hex colour and rejects invalid input without writing", async () => {
    let saved: unknown;
    const v = await section("groups", {
      patchGroup: (input: unknown) => {
        saved = input;
        return native.groups[0];
      },
    });
    fireEvent.click(await v.findByRole("button", { name: "Colour for work" }));
    const hex = await v.findByLabelText("Hex colour");
    fireEvent.change(hex, { target: { value: "#garbag" } });
    fireEvent.blur(hex);
    expect(saved).toBeUndefined();
    expect(await v.findByRole("alert")).toBeTruthy();
    fireEvent.change(hex, { target: { value: "#123abc" } });
    fireEvent.blur(hex);
    await waitFor(() => expect(saved).toEqual({ id: work, color: "#123abc" }));
    v.lifecycle.unmount();
  });
  it("chooses and resets an emoji without accepting freeform icon text", async () => {
    let current = {
      ...native,
      projects: native.projects.map((p) => ({ ...p })),
    };
    const patches: unknown[] = [];
    const v = await section("projects", {
      organizationSnapshot: () => current,
      environment_snapshot: () => ({ profiles: [], projects: [] }),
      updateProject: (input: { projectId: string; icon: string }) => {
        patches.push(input);
        current = {
          ...current,
          projects: current.projects.map((p) => ({ ...p, icon: input.icon })),
        };
        return { ok: true };
      },
    });
    fireEvent.click(
      await v.findByRole("button", { name: "Edit Synthetic project" }),
    );
    expect(await v.findByText("Default folder")).toBeTruthy();
    expect(v.queryByRole("textbox", { name: "Project icon" })).toBeNull();
    fireEvent.click(v.getByRole("button", { name: "Choose project emoji" }));
    fireEvent.click(
      await v.findByRole("button", { name: "Choose rocket emoji" }),
    );
    await waitFor(() =>
      expect(patches).toEqual([{ projectId: "project", icon: "🚀" }]),
    );
    fireEvent.click(
      await v.findByRole("button", { name: "Reset project icon" }),
    );
    await waitFor(() =>
      expect(patches).toEqual([
        { projectId: "project", icon: "🚀" },
        { projectId: "project", icon: "" },
      ]),
    );
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
