import { describe, expect, it } from "vitest";
import { executableAvailable } from "./executable.js";

describe("executableAvailable", () => {
  it("finds executable paths and rejects missing commands", async () => {
    await expect(executableAvailable(process.execPath)).resolves.toBe(true);
    await expect(
      executableAvailable("bb-session-share-command-that-does-not-exist"),
    ).resolves.toBe(false);
  });
});
