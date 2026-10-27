// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useComposer } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { profileInputSchema, type Profile } from "./server/contract";
import { offerDmDraft } from "./app/shared/composer-draft";

const profile: Profile = {
  ...profileInputSchema.parse({
    name: "Reviewer", slug: "reviewer", description: "Review code",
    modelMode: "level", level: "medium", providerId: "agents",
    model: "openai-codex/gpt-6-sol", reasoningLevel: "medium", serviceTier: "default",
    permissionMode: "full", instructions: "Review carefully", skillIds: [], mcpServerIds: [], isDefault: false,
  }),
  id: "5f0c8f5e-2d3c-4b8e-9a51-1f2e3d4c5b6a", revision: 1,
  memoryKey: "agent-5f0c8f5e-2d3c-4b8e-9a51-1f2e3d4c5b6a",
  createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z",
  homeReady: true, intervalMinutes: null,
};
const sourceDraft = {
  text: "Review @repo",
  mentions: [{ kind: "project" as const, projectId: "p1", label: "@repo", from: 7, to: 12 }],
  attachments: [{ type: "localFile" as const, path: "notes.txt", name: "notes.txt", sourceProjectId: "p1" }],
};

afterEach(cleanup);

describe("canonical DM composer", () => {
  it("preserves an existing DM draft until the owner chooses to transfer a New Thread draft", async () => {
    const app = await loadPluginApp(() => import("./app"));
    offerDmDraft("dm-reviewer", sourceDraft);

    const banner = app.composerCustomizations.find(({ id }) => id === "agent-dm")!.banners![0]!;
    const target = renderSlot(banner, {}, {
      composer: {
        scope: { kind: "thread", threadId: "dm-reviewer" },
        text: "Existing DM draft",
        selection: { providerId: "agents", model: `agent/${profile.id}` },
      },
      sdk: { threads: { getPluginMetadata: async () => ({ role: "dm", schemaVersion: 1, profileId: profile.id }) } },
    });
    await target.findByRole("button", { name: "Replace DM draft" });
    expect(target.inspection.composer.draft.text).toBe("Existing DM draft");
    fireEvent.click(target.getByRole("button", { name: "Replace DM draft" }));
    expect(target.inspection.composer.draft).toEqual(sourceDraft);
    expect(target.inspection.composer.submits).toEqual([]);
  });

  it("restores a DM's agent when a different model is picked without sending", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const Banner = app.composerCustomizations.find(({ id }) => id === "agent-dm")!.banners![0]!.component;
    function Composer() {
      const composer = useComposer();
      return <>
        <Banner />
        <button onClick={() => void composer.setSelection({ providerId: "agents", model: "agent/5f0c8f5e-2d3c-4b8e-9a51-1f2e3d4c5b6b" })}>Choose another agent</button>
      </>;
    }
    const slot = renderSlot({ component: Composer }, {}, {
      composer: { scope: { kind: "thread", threadId: "dm-reviewer" }, selection: { providerId: "agents", model: `agent/${profile.id}` } },
      sdk: { threads: { getPluginMetadata: async () => ({ role: "dm", schemaVersion: 1, profileId: profile.id }) } },
    });
    await waitFor(() => expect(slot.inspection.sdkCalls).toHaveLength(1));
    fireEvent.click(slot.getByRole("button", { name: "Choose another agent" }));
    await waitFor(() => expect(slot.inspection.composer.selection?.model).toBe(`agent/${profile.id}`));
    expect(slot.inspection.composer.submits).toEqual([]);
  });
});
