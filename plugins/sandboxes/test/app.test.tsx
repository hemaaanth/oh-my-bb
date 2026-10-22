// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("../app"));
afterEach(() => { cleanup(); window.sessionStorage.clear(); });

describe("sandbox thread header", () => {
  it("shows the icon before machine lookup finishes and keeps it muted for a local thread", async () => {
    let finish!: (view: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    const slot = renderSlot(
      app.threadHeaderActions.find((entry) => entry.id === "sandbox-resources")!,
      { threadId: "thr_new", projectId: "p_1", isCompactViewport: false },
      { rpc: { threadResources: () => pending, threadModelRoute: () => null } as never },
    );
    expect(slot.getByLabelText("Loading machine status")).toBeTruthy();
    finish({ managed: false });
    await waitFor(() => expect(slot.getByLabelText("Local machine")).toBeTruthy());
  });
  it("opens the model route from the local machine icon and marks a fallback", async () => {
    const slot = renderSlot(
      app.threadHeaderActions.find((entry) => entry.id === "sandbox-resources")!,
      { threadId: "thr_1", projectId: "p_1", isCompactViewport: false },
      {
        rpc: {
          threadResources: () => ({ managed: false }),
          threadModelRoute: () => ({
            chain: ["Claude Max", "Anthropic API", "ChatGPT"],
            chainIndex: 2,
            accountLabel: "pro",
            model: "claude-opus-5-5",
            stickyUntil: null,
            autoModel: null,
            auto: null,
            fallbackCause: {
              upstreamLabel: "Claude Max",
              category: "rate-limit",
              status: 429,
              message: "over limit",
              at: Date.UTC(2026, 9, 11, 14, 2),
            },
          }),
        } as never,
      },
    );
    const button = await slot.findByRole("button", { name: /Local machine\. Opus 5\.5 on ChatGPT \(fallback\)/ });
    fireEvent.click(button);
    await slot.findByText("Opus 5.5");
    expect(slot.getByText("Fallback")).toBeTruthy();
    expect(slot.getByText(/Claude Max hit its limit \(HTTP 429\)/)).toBeTruthy();
    expect(slot.getByText("ChatGPT", { selector: "span" }).className).toContain("font-medium");
  });

  it("keeps the local machine menu available without a gateway route", async () => {
    const slot = renderSlot(
      app.threadHeaderActions.find((entry) => entry.id === "sandbox-resources")!,
      { threadId: "thr_1", projectId: "p_1", isCompactViewport: false },
      { rpc: { threadResources: () => ({ managed: false }), threadModelRoute: () => null } as never },
    );
    await waitFor(() => expect(slot.getByLabelText("Local machine")).toBeTruthy());
    expect(slot.getByRole("button", { name: "Local machine" })).toBeTruthy();
  });
  it("runs the optional Scripts action from the machine menu and closes it", async () => {
    const run = vi.fn(async () => {});
    const slot = renderSlot(
      app.threadHeaderActions.find((entry) => entry.id === "sandbox-resources")!,
      { threadId: "thr_1", projectId: "p_1", isCompactViewport: false },
      {
        rpc: { threadResources: () => ({ managed: false }), threadModelRoute: () => null } as never,
        sidebarThreads: { threads: [{ id: "thr_1", projectId: "p_1", environment: null }] as never },
        threadActions: () => [{ key: "workspace-scripts/scripts", pluginId: "workspace-scripts", group: "machine", action: { label: "Scripts", icon: "Terminal", run } }],
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Local machine" }));
    fireEvent.click(await slot.findByRole("button", { name: "Scripts" }));
    expect(run).toHaveBeenCalledOnce();
    await waitFor(() => expect(slot.queryByRole("button", { name: "Scripts" })).toBeNull());
  });

});
