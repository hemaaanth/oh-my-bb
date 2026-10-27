import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hempiExtensionArgs } from "./hempi-extension.js";
import { assertFakePiLaunch, isolatePiTestEnv } from "./test-support.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function discover(help: string, exit = "0") {
  const root = mkdtempSync(join(tmpdir(), "hempi-discovery-"));
  roots.push(root);
  const dataDir = join(root, "data");
  isolatePiTestEnv(root);
  assertFakePiLaunch();
  return { root, dataDir, result: hempiExtensionArgs({
    cwd: root, dataDir,
    env: {
      ...process.env,
      FAKE_PI_HELP: help, FAKE_PI_HELP_EXIT: exit,
    },
  }) };
}

it("does not double-load Hempi when Pi reports its active role and OptChat flags", async () => {
  const discovery = discover("Options:\n  --role <role>\n  --optchat-profile <profile>\n");
  expect(await discovery.result).toEqual([]);
  expect(existsSync(discovery.dataDir)).toBe(false);
});

it("does not mistake flag names in prose for active Hempi options", async () => {
  const discovery = discover("Use --role and --optchat-profile with Hempi.\n");
  const args = await discovery.result;
  expect(args[0]).toBe("--extension");
});

it("fails rather than guessing and double-loading after a broken extension discovery", async () => {
  const discovery = discover("", "1");
  await expect(discovery.result).rejects.toThrow("Pi extension discovery failed (1)");
  expect(existsSync(discovery.dataDir)).toBe(false);
});
