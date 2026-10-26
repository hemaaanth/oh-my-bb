// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { useWorkspaces } from "./useWorkspaces";

afterEach(cleanup);

it("retains saved groups when an explicitly enabled owner's refresh fails", async () => {
  let unavailable = false;
  function Probe() {
    const { workspaces, error } = useWorkspaces();
    return <><ul>{workspaces.map((group) => <li key={group.id}>{group.name}</li>)}</ul>{error ? <p role="alert">{error}</p> : null}</>;
  }
  const mounted = renderSlot({ component: Probe }, {}, {
    rpc: { listWorkspaces: () => {
      if (unavailable) throw new Error("Projects unavailable");
      return { workspaces: [{ id: "saved-group", name: "Saved group", color: "blue", isDefault: true, projectIds: ["fixture-project"], threadIds: [] }] };
    } },
  });
  await screen.findByText("Saved group");
  unavailable = true;
  await mounted.behavior.emitRealtime("workspaces", null);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Projects unavailable"));
  expect(screen.getByText("Saved group")).toBeDefined();
  expect(screen.queryByText("Personal")).toBeNull();
});
