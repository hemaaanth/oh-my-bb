import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentSetup } from "./agent-setup";

describe("required agent setup", () => {
  it("waits beyond the environment hook deadline for a successful recipe", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-setup-"));
    const script = join(root, "setup.py");
    const marker = join(root, "ready");
    try {
      await writeFile(script, `import os, pathlib, time
time.sleep(5.1)
pathlib.Path(os.environ['SETUP_TEST_MARKER']).write_text('ready')
`);
      await runAgentSetup({ AGENT_SETUP_SCRIPT: script, SETUP_TEST_MARKER: marker });
      const { readFile } = await import("node:fs/promises");
      expect(await readFile(marker, "utf8")).toBe("ready");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 10_000);
  it("rejects a failed recipe before model work can proceed", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-setup-"));
    const script = join(root, "setup.py");
    try {
      await writeFile(script, "raise SystemExit('deliberate setup failure')\n");
      await expect(runAgentSetup({ AGENT_SETUP_SCRIPT: script })).rejects.toThrow("deliberate setup failure");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("skips ordinary agents and rejects staging errors", async () => {
    await expect(runAgentSetup()).resolves.toBeUndefined();
    await expect(runAgentSetup({ AGENT_SETUP_ERROR: "staging failed" })).rejects.toThrow("staging failed");
  });
});
