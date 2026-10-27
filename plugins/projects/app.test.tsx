// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createProjectRouterStatusTarget } from "./project-router-placement";
import type { rpcContract } from "./contract";

type RouterContract = Pick<typeof rpcContract, "suggestProject">;

describe("project router status placement", () => {
  it("creates a stable row after the native project controls and collapses its empty banner row", () => {
    const composer = document.createElement("div");
    composer.dataset.appComposerRole = "primary";
    const bannerRow = document.createElement("div");
    const pluginRoot = document.createElement("div");
    const anchor = document.createElement("span");
    pluginRoot.appendChild(anchor);
    bannerRow.appendChild(pluginRoot);
    composer.append(bannerRow, document.createElement("div"), document.createElement("div"));
    document.body.appendChild(composer);

    const placement = createProjectRouterStatusTarget(anchor)!;
    expect(composer.lastElementChild).toBe(placement.target);
    expect(placement.target.dataset.jevProjectRouterStatus).toBe("");
    expect(bannerRow.style.display).toBe("none");

    placement.dispose();
    expect(placement.target.isConnected).toBe(false);
    expect(bannerRow.style.display).toBe("");
    composer.remove();
  });
});

describe("new-thread project router", () => {
  it("evaluates every edit after ten characters and only reroutes on a changed suggestion", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const customization = app.composerCustomizations.find(({ id }) => id === "jev-project-router");
    const banner = customization?.banners?.find(({ id }) => id === "project-suggestion");
    expect(customization?.scopes).toEqual(["new-thread"]);
    expect(banner).toBeDefined();

    const slot = renderSlot<{}, RouterContract>(banner!, {}, {
      composer: {
        text: "short",
        scope: { kind: "new-thread", projectId: "p_other" },
      },
      sidebarThreads: {
        projects: [
          { id: "p_bb", name: "bb", isPersonal: false, href: "/projects/p_bb", settingsHref: "/projects/p_bb/settings" },
          { id: "p_site", name: "site", isPersonal: false, href: "/projects/p_site", settingsHref: "/projects/p_site/settings" },
          { id: "p_other", name: "other", isPersonal: false, href: "/projects/p_other", settingsHref: "/projects/p_other/settings" },
        ],
      },
      rpc: {
        suggestProject: async () => ({
          suggestion: {
            id: "p_bb",
            name: "bb",
            repository: "get-bb/bb",
            summary: "The BB desktop application.",
            probability: 0.84,
          },
          alternatives: [],
          noProject: null,
          confidence: 0.78,
          autoApply: true,
        }),
      },
    });

    expect(slot.inspection.rpcCalls).toHaveLength(0);
    expect(slot.getByText("Jev is idle.")).toBeTruthy();
    await slot.behavior.setComposerText("Improve the project picker in BB");
    await waitFor(() => {
      expect(slot.inspection.rpcCalls).toHaveLength(1);
      expect(slot.inspection.composer.selections).toHaveLength(1);
    });
    expect(slot.inspection.composer.selections).toEqual([{ projectId: "p_bb" }]);
    expect(slot.inspection.navigateCalls).toHaveLength(0);

    await slot.behavior.setComposerScope({ kind: "new-thread", projectId: "p_bb" });
    expect(slot.getByText(/Jev routed this thread to/iu)).toBeTruthy();
    expect(slot.getByText("84%")).toBeTruthy();
    expect(slot.queryByText(/Choose another project/iu)).toBeNull();
    expect(slot.queryByText(/% match/iu)).toBeNull();
    await slot.behavior.setComposerText("Improve the project picker in BB!");
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(2));
    expect(slot.inspection.composer.selections).toHaveLength(1);

    await slot.behavior.setComposerScope({ kind: "new-thread", projectId: "p_site" });
    expect(slot.getByText(/Keeping/iu)).toBeTruthy();
    await slot.behavior.setComposerText("Improve the native project picker in BB");
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(3));
    expect(slot.inspection.composer.selections).toHaveLength(1);
    await slot.behavior.setComposerText("short");
    expect(slot.getByText("Jev is idle.")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("stays off while the composer holds a fork draft", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const banner = app.composerCustomizations
      .find(({ id }) => id === "jev-project-router")
      ?.banners?.find(({ id }) => id === "project-suggestion");
    document.body.dataset.appComposerRole = "primary";
    const forkChip = document.createElement("button");
    forkChip.setAttribute("aria-label", "Cancel fork");
    document.body.appendChild(forkChip);

    const slot = renderSlot<{}, RouterContract>(banner!, {}, {
      composer: {
        text: "Continue this work in another project",
        scope: { kind: "new-thread", projectId: "p_site" },
      },
      sidebarThreads: {
        projects: [
          { id: "p_bb", name: "bb", isPersonal: false, href: "/projects/p_bb", settingsHref: "/projects/p_bb/settings" },
          { id: "p_site", name: "site", isPersonal: false, href: "/projects/p_site", settingsHref: "/projects/p_site/settings" },
        ],
      },
      rpc: {
        suggestProject: async () => ({
          suggestion: { id: "p_bb", name: "bb", repository: "get-bb/bb", summary: "BB.", probability: 0.9 },
          alternatives: [],
          noProject: null,
          confidence: 0.9,
          autoApply: true,
        }),
      },
    });

    expect(slot.getByText(/forks keep their project/iu)).toBeTruthy();
    await slot.behavior.setComposerText("Continue this work in the BB repository");
    expect(slot.inspection.rpcCalls).toHaveLength(0);
    expect(slot.inspection.composer.selections).toHaveLength(0);

    forkChip.remove();
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    slot.lifecycle.unmount();
    delete document.body.dataset.appComposerRole;
  });

  it("offers the suggestion again when the composer refuses the project switch", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const banner = app.composerCustomizations
      .find(({ id }) => id === "jev-project-router")
      ?.banners?.find(({ id }) => id === "project-suggestion");
    // The harness rejects setSelection in a queued-message scope, as bb does.
    const slot = renderSlot<{}, RouterContract>(banner!, {}, {
      composer: {
        text: "",
        scope: { kind: "queued-message", threadId: "t_1", queuedMessageId: "q_1" },
      },
      sidebarThreads: {
        projects: [
          { id: "p_bb", name: "bb", isPersonal: false, href: "/projects/p_bb", settingsHref: "/projects/p_bb/settings" },
        ],
      },
      rpc: {
        suggestProject: async () => ({
          suggestion: { id: "p_bb", name: "bb", repository: "get-bb/bb", summary: "BB.", probability: 0.9 },
          alternatives: [],
          noProject: null,
          confidence: 0.9,
          autoApply: true,
        }),
      },
    });

    await slot.behavior.setComposerText("Improve the project picker in BB");
    await waitFor(() => expect(slot.getByText("Use suggestion")).toBeTruthy());
    expect(slot.getByText(/Keeping/iu)).toBeTruthy();
    expect(slot.inspection.composer.selections).toHaveLength(0);
    expect(slot.inspection.navigateCalls).toHaveLength(0);
    slot.lifecycle.unmount();
  });

  it("suggests working without a project but never switches automatically", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const banner = app.composerCustomizations
      .find(({ id }) => id === "jev-project-router")
      ?.banners?.find(({ id }) => id === "project-suggestion");
    const slot = renderSlot<{}, RouterContract>(banner!, {}, {
      composer: {
        text: "short",
        scope: { kind: "new-thread", projectId: "p_bb" },
      },
      sidebarThreads: {
        projects: [
          { id: "p_personal", name: "Personal", isPersonal: true, href: "/projects/p_personal", settingsHref: "/projects/p_personal/settings" },
          { id: "p_bb", name: "bb", isPersonal: false, href: "/projects/p_bb", settingsHref: "/projects/p_bb/settings" },
        ],
      },
      rpc: {
        suggestProject: async () => ({
          suggestion: null,
          alternatives: [],
          noProject: { probability: 0.8 },
          confidence: 0.7,
          autoApply: false,
        }),
      },
    });

    await slot.behavior.setComposerText("What is the capital of Portugal?");
    await waitFor(() => expect(slot.getByText("Jev suggests working without a project.")).toBeTruthy());
    expect(slot.getByText("80%")).toBeTruthy();
    expect(slot.inspection.composer.selections).toHaveLength(0);

    fireEvent.click(slot.getByText("Start without a project"));
    expect(slot.inspection.composer.selections).toEqual([{ projectId: "p_personal" }]);
    await slot.behavior.setComposerScope({ kind: "new-thread", projectId: "p_personal" });
    expect(slot.getByText("Jev agrees this needs no project.")).toBeTruthy();
    expect(slot.queryByText("Start without a project")).toBeNull();
    slot.lifecycle.unmount();
  });
});
