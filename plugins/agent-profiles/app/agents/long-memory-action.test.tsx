// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useBbNavigate, useSdk, type PluginThreadActionTarget } from "@get-bb/plugin-sdk/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract } from "../../server/contract";
import { longMemoryAction } from "./long-memory-action";

const threadIds = ["plain", "agent", "codex"];
const target: PluginThreadActionTarget = {
  id: "plain", projectId: "p1", parentThreadId: null, archivedAt: null,
  pinnedAt: null, sectionId: null, isUnread: false, status: "idle", environment: null,
};

function Actions() {
  const data = longMemoryAction.useData!({ threadIds });
  const sdk = useSdk();
  const navigate = useBbNavigate();
  return <>{threadIds.map((id) => {
    const action = longMemoryAction.item({ thread: { ...target, id }, data, sdk, navigate });
    return action ? <button key={id} data-testid={id} disabled={action.disabled}
      onClick={() => void action.run({ requestRename: () => {} })}>{action.label}</button> : null;
  })}</>;
}

const sdk = {
  threads: {
    get: async ({ threadId }: { threadId: string }) => makeThreadResponse({
      id: threadId,
      providerId: threadId === "plain" ? "hempi" : threadId === "agent" ? "agent-123" : "codex",
    }),
  },
};

afterEach(cleanup);

describe("long memory thread action", () => {
  it("is available only on Hempi and follows saved state and realtime changes", async () => {
    let enabled = false;
    const slot = renderSlot({ component: Actions }, {}, {
      sdk,
      rpc: {
        getLongMemory: () => ({ enabled }),
        setLongMemory: (input) => {
          const change = rpcContract.setLongMemory.input.parse(input);
          enabled = change.enabled;
          return { enabled };
        },
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Long memory: off" }));
    await slot.findByRole("button", { name: "Long memory: on" });
    expect(enabled).toBe(true);
    expect(slot.queryByTestId("agent")).toBeNull();
    expect(slot.queryByTestId("codex")).toBeNull();
    await slot.behavior.emitRealtime("long-memory-changed", { threadId: "plain", enabled: false });
    await slot.findByRole("button", { name: "Long memory: off" });
    fireEvent.click(slot.getByRole("button", { name: "Long memory: off" }));
    await slot.findByRole("button", { name: "Long memory: on" });
    fireEvent.click(slot.getByRole("button", { name: "Long memory: on" }));
    await slot.findByRole("button", { name: "Long memory: off" });
    expect(enabled).toBe(false);
  });

  it("keeps the saved state when enabling memory fails", async () => {
    const slot = renderSlot({ component: Actions }, {}, {
      sdk,
      rpc: {
        getLongMemory: () => ({ enabled: false }),
        setLongMemory: () => { throw new Error("Pi session cannot be imported"); },
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Long memory: off" }));
    await waitFor(() => expect(slot.getByRole("button", { name: "Long memory: off" }).hasAttribute("disabled")).toBe(false));
    expect(slot.queryByRole("button", { name: "Long memory: on" })).toBeNull();
  });
});
