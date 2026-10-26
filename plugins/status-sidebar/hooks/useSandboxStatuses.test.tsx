// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { SandboxStatusCandidate } from "./useSandboxStatuses";

installTestPluginRuntime();
const { useSandboxStatuses } = await import("./useSandboxStatuses");

const results: ReadonlyMap<string, unknown>[] = [];

function Harness({ candidates }: { candidates: readonly SandboxStatusCandidate[] }) {
  results.push(useSandboxStatuses(candidates, "membership"));
  return null;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  results.length = 0;
  cleanup();
  vi.useRealTimers();
});

describe("useSandboxStatuses", () => {
  it("keeps its 30s cadence when activity only reorders the threads", async () => {
    let calls = 0;
    const a = { threadId: "a", hostId: "host_1" };
    const b = { threadId: "b", hostId: null };
    const rendered = renderSlot({ component: Harness }, { candidates: [a, b] }, {
      rpc: {
        listSandboxStatuses: () => {
          calls += 1;
          return { statuses: [] };
        },
      },
    });
    await act(async () => {});
    expect(calls).toBe(1);

    await act(async () => {
      rendered.lifecycle.rerender(<Harness candidates={[b, a]} />);
    });
    expect(calls).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(calls).toBe(2);
  });

  it("returns the same map when a poll finds nothing new", async () => {
    const status = {
      threadId: "a",
      sandboxId: "sbx_1",
      provider: "daytona",
      status: "live",
      label: "Daytona sandbox live",
    };
    renderSlot({ component: Harness }, {
      candidates: [{ threadId: "a", hostId: "host_1" }],
    }, {
      rpc: { listSandboxStatuses: () => ({ statuses: [{ ...status }] }) },
    });
    await act(async () => {});
    const loaded = results.at(-1);
    expect(loaded?.size).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(results.at(-1)).toBe(loaded);
  });
});
