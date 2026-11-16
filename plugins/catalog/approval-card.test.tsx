// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
const app = await loadPluginApp(() => import("./app"));
afterEach(cleanup);
it("keeps the purpose and decision visible, with code collapsed and no broad script grant", async () => {
  const submit = vi.fn(async () => {});
  const code = "async () => { return 123; }";
  const slot = renderSlot(app.pendingInteractions[0]!, {
    interaction: { id: "i", threadId: "thr", payload: { approvalId: "a", toolkit: "everywhere", address: "app_123.execute", integration: "Executor script", account: null, tool: "execute", purpose: "Check license keys", script: true, description: "Purpose supplied by the agent", reason: "Effects have not been verified", message: `Approve execute? Arguments: ${code}`, args: JSON.stringify({ intent: "Check license keys", code }), approvalUrl: "" } }, submit,
  } as never, { rpc: { executorApprovals: () => ({ pending: [] }) } as never });
  expect(slot.queryByText("Purpose supplied by the agent")).toBeNull();
  expect(slot.queryByText("Check license keys")).toBeNull();
  expect(slot.queryByText("Executor script")).toBeNull();
  expect(slot.queryByText("everywhere")).toBeNull();
  expect(slot.queryByText("Effects have not been verified")).toBeNull();
  const details = slot.getByText("View code").closest("details")!;
  expect(details.open).toBe(false);
  expect(details.textContent).toBe(`View code${code}`);
  expect(slot.queryByText(/Approve execute/)).toBeNull();
  expect(slot.queryByRole("button", { name: /this thread/ })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Allow once" }));
  expect(submit).toHaveBeenCalledWith({ approved: true, scope: "once" });
});
