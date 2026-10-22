// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));
afterEach(cleanup);

it("uses the shared machine action and panel instead of a header icon", () => {
  expect(app.threadHeaderActions).toHaveLength(0);
  expect(app.threadPanelActions.map(({ id }) => id)).toContain("scripts");
  const openThreadPanel = vi.fn();
  const registration = app.threadActions.find(({ id }) => id === "scripts")!;
  const input = { thread: { id: "thr_1" }, data: "thr_1", navigate: { openThreadPanel } } as unknown as Parameters<typeof registration.item>[0];
  const action = registration.item(input)!;
  action.run({ requestRename: () => {} });
  expect(openThreadPanel).toHaveBeenCalledWith({ actionId: "scripts", params: { threadId: "thr_1" } });
});

it("loads the panel and keeps script execution scoped to its thread", async () => {
  const run = vi.fn(() => ({ reused: false, terminalId: "term_1" }));
  const slot = renderSlot(app.threadPanelActions.find(({ id }) => id === "scripts")!,
    { threadId: "other_panel", params: { threadId: "thr_1" } }, {
      rpc: {
        inspect: () => ({ available: true, workspacePath: "/repo", manifestFound: true, setup: null, teardown: null,
          actions: [{ id: "verify", name: "Verify", command: "npm test", description: null, type: "command", source: "script", autostart: false, running: false, terminalId: null, port: null }] }),
        run,
      } as never,
    });
  fireEvent.click(await slot.findByRole("button", { name: "Run Verify" }));
  await waitFor(() => expect(run).toHaveBeenCalledWith({ threadId: "thr_1", actionId: "verify" }));
});
