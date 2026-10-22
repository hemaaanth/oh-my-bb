import { describe, expect, it, vi } from "vitest";
import { withHostRecovery } from "../src/manager.js";

describe("withHostRecovery", () => {
  it("repeats a step whose machine dropped with the tunnel", async () => {
    const step = vi.fn()
      .mockRejectedValueOnce(new Error("HTTP 502: Host is not connected"))
      .mockResolvedValueOnce("done");

    await expect(withHostRecovery(step, { delayMs: 0 })).resolves.toBe("done");
    expect(step).toHaveBeenCalledTimes(2);
  });

  it("keeps waiting through a terminal session that lost its machine", async () => {
    const step = vi.fn()
      .mockRejectedValueOnce(new Error("Checkout main disconnected from its host"))
      .mockResolvedValueOnce("done");

    await expect(withHostRecovery(step, { delayMs: 0 })).resolves.toBe("done");
  });

  it("surfaces a failure that is not the machine going away", async () => {
    const step = vi.fn(async () => {
      throw new Error("Could not check out origin/main: pathspec did not match");
    });

    await expect(withHostRecovery(step, { delayMs: 0 })).rejects.toThrow("pathspec");
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("gives up once the machine stays away past the budget", async () => {
    const step = vi.fn(async () => {
      throw new Error("HTTP 502: Host is not connected");
    });

    await expect(
      withHostRecovery(step, { budgetMs: 0, delayMs: 0 }),
    ).rejects.toThrow("Host is not connected");
    expect(step).toHaveBeenCalledTimes(1);
  });
});
