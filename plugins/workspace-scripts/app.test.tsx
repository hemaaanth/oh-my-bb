// @vitest-environment jsdom
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { InspectResult, ScriptActionView } from "./server";

const app = await loadPluginApp(() => import("./app"));
afterEach(cleanup);

const visibleThreads = ["thr_1"];
const registration = app.threadActions.find(({ id }) => id === "scripts")!;
function ActionFixture() {
  const data = registration.useData!({ threadIds: visibleThreads });
  const action = registration.item({
    thread: { ...makeThreadResponse({ id: "thr_1", projectId: "proj_1" }), environment: null },
    data,
    sdk: useSdk(),
    navigate: useBbNavigate(),
  });
  return <div>{action?.choices?.items.map(choice => <button key={choice.id}
    disabled={action.disabled || choice.disabled}
    onClick={() => void action.run({ value: choice.id, requestRename() {} })}>{choice.label}</button>)}</div>;
}

function snapshot(action: Partial<ScriptActionView> = {}): InspectResult {
  return {
    available: true, workspacePath: "/repo", manifestFound: true, manifestFile: "bb.json", setup: null, teardown: null,
    actions: [{
      id: "script:verify", name: "Verify", command: "exit 7", description: null, type: "command",
      source: "script", autostart: false, status: "exited", exitCode: 7, closeReason: "process-exit",
      terminalId: "term_old", port: null, portState: null, ...action,
    }],
  };
}

it("does not execute on inspection and replaces a failed result after a thread-scoped run", async () => {
  let result = snapshot();
  const run = vi.fn(() => {
    result = snapshot({ exitCode: 0, terminalId: "term_new" });
    return { title: "Script · Verify", reused: false, terminalId: "term_new", service: false, port: null };
  });
  const slot = renderSlot({ component: ActionFixture }, {}, {
    rpc: { inspectMany: () => ({ thr_1: result }), run } as never,
    openTerminal: () => true,
  });
  const button = await slot.findByRole("button", { name: /Run Verify.*failed \(7\)/ });
  expect(run).not.toHaveBeenCalled();
  fireEvent.click(button);
  await slot.findByRole("button", { name: /Run Verify.*last passed/ });
  expect(run).toHaveBeenCalledWith({ threadId: "thr_1", actionId: "script:verify" });
});

it("keeps a newer result when an older inspection completes late", async () => {
  const first = Promise.withResolvers<unknown>();
  const second = Promise.withResolvers<unknown>();
  const inspectMany = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  const slot = renderSlot({ component: ActionFixture }, {}, { rpc: { inspectMany } as never });
  fireEvent.click(await slot.findByRole("button", { name: "Refresh status" }));
  await act(async () => { second.resolve({ thr_1: snapshot({ exitCode: 0 }) }); });
  await slot.findByRole("button", { name: /Run Verify.*last passed/ });
  await act(async () => { first.resolve({ thr_1: snapshot({ exitCode: 7 }) }); });
  expect(slot.getByRole("button", { name: /Run Verify.*last passed/ })).toBeTruthy();
  expect(slot.queryByRole("button", { name: /Run Verify.*failed/ })).toBeNull();
});

it("blocks duplicate starts while disconnected and restores Stop after reconnecting", async () => {
  let result = snapshot({
    id: "script:web", name: "Web", type: "service", status: "disconnected", exitCode: null,
    closeReason: null, port: 3000, portState: "unknown",
  });
  const run = vi.fn();
  const stopService = vi.fn(() => {
    result = snapshot({ id: "script:web", name: "Web", type: "service", status: "exited", closeReason: "user-close", exitCode: null });
    return { stopped: true };
  });
  const slot = renderSlot({ component: ActionFixture }, {}, {
    rpc: { inspectMany: () => ({ thr_1: result }), run, stopService } as never,
  });
  const disconnected = await slot.findByRole("button", { name: /Start Web.*disconnected/ }) as HTMLButtonElement;
  expect(disconnected.disabled).toBe(true);
  fireEvent.click(disconnected);
  expect(run).not.toHaveBeenCalled();
  result = snapshot({ id: "script:web", name: "Web", type: "service", status: "running", closeReason: null, exitCode: null, port: 3000, portState: "listening" });
  fireEvent.click(slot.getByRole("button", { name: "Refresh status" }));
  fireEvent.click(await slot.findByRole("button", { name: /Stop Web.*3000 listening/ }));
  await slot.findByRole("button", { name: /Start Web.*stopped/ });
  expect(stopService).toHaveBeenCalledWith({ threadId: "thr_1", actionId: "script:web" });
});
