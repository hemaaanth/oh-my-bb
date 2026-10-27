// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useComposer } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract } from "../../server/contract";

const first = "5f0c8f5e-2d3c-4b8e-9a51-1f2e3d4c5b6a";
const second = "5f0c8f5e-2d3c-4b8e-9a51-1f2e3d4c5b6b";
const select = (profileId: string) => ({ providerId: "agents", model: `agent/${profileId}` });

async function setup(options: {
  selection?: { providerId: string; model: string };
  ensureAgentDm?: (input: { profileId: string }) => Promise<{ threadId: string }>;
  text?: string;
} = {}) {
  const app = await loadPluginApp(() => import("../../app"));
  const Observer = app.composerCustomizations.find(({ id }) => id === "agent-profile")!.banners![0]!.component;
  function Composer() {
    const composer = useComposer();
    return <>
      <Observer />
      <button onClick={() => void composer.setSelection(select(first))}>Pick first</button>
      <button onClick={() => void composer.setSelection(select(second))}>Pick second</button>
      <button onClick={() => void composer.setSelection({ providerId: "codex", model: "manual" })}>Leave Agents</button>
      <output>{composer.selection?.providerId}:{composer.selection?.model}</output>
    </>;
  }
  return renderSlot({ component: Composer }, {}, {
    composer: {
      scope: { kind: "new-thread", projectId: "p1" },
      selection: options.selection ?? { providerId: "codex", model: "original" },
      text: options.text ?? "",
    },
    rpc: { ensureAgentDm: (input: unknown) => {
      const { profileId } = rpcContract.ensureAgentDm.input.parse(input);
      return options.ensureAgentDm?.({ profileId }) ?? { threadId: profileId };
    } },
  });
}

afterEach(cleanup);

describe("Agents picker routing", () => {
  it("routes only the latest selection and never submits the draft", async () => {
    const resolves = new Map<string, (value: { threadId: string }) => void>();
    const slot = await setup({
      text: "Unsent message",
      ensureAgentDm: ({ profileId }) => new Promise((resolve) => { resolves.set(profileId, resolve); }),
    });
    fireEvent.click(slot.getByRole("button", { name: "Pick first" }));
    await waitFor(() => expect(resolves.has(first)).toBe(true));
    fireEvent.click(slot.getByRole("button", { name: "Pick second" }));
    await waitFor(() => expect(resolves.has(second)).toBe(true));
    await act(async () => { resolves.get(first)!({ threadId: "stale" }); });
    expect(slot.inspection.navigateCalls).toEqual([]);
    await act(async () => { resolves.get(second)!({ threadId: "canonical" }); });
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "canonical" }]);
    expect(slot.inspection.composer.draft.text).toBe("Unsent message");
    expect(slot.inspection.composer.submits).toEqual([]);
  });

  it("does not bounce on a restored default or repeated mount; Open DM is explicit", async () => {
    const slot = await setup({ selection: select(first) });
    expect(slot.getByRole("button", { name: "Open DM" })).toBeTruthy();
    expect(slot.inspection.rpcCalls).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Open DM" }));
    await waitFor(() => expect(slot.inspection.navigateCalls).toHaveLength(1));
    slot.unmount();
    const again = await setup({ selection: select(first) });
    expect(again.inspection.rpcCalls).toEqual([]);
    expect(again.inspection.navigateCalls).toEqual([]);
  });

  it("opens a remembered agent after leaving Agents and deliberately selecting it again", async () => {
    const slot = await setup({ selection: select(first) });
    fireEvent.click(slot.getByRole("button", { name: "Leave Agents" }));
    fireEvent.click(slot.getByRole("button", { name: "Pick first" }));
    await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: first }]));
  });

  it("cancels redirect when selection changes away while allocation is pending", async () => {
    let finish!: (value: { threadId: string }) => void;
    const slot = await setup({ ensureAgentDm: () => new Promise((resolve) => { finish = resolve; }) });
    fireEvent.click(slot.getByRole("button", { name: "Pick first" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    fireEvent.click(slot.getByRole("button", { name: "Leave Agents" }));
    await act(async () => { finish({ threadId: "stale" }); });
    expect(slot.inspection.navigateCalls).toEqual([]);
    expect(slot.getByText("codex:manual")).toBeTruthy();
  });
});
