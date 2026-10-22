import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

let root: string;
const script = resolve("scripts/refresh-browser-state.sh");
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cookie-refresh-"));
  await mkdir(join(root, "bin"));
  for (const name of ["bb-browser", "ps", "hyprctl", "bb", "agent-browser"]) {
    const file = join(root, "bin", name);
    await writeFile(file, `#!/bin/sh\nprintf '%s\\n' '${name}' "$@" >> "$FAKE_LOG"\n`);
    await chmod(file, 0o700);
  }
});
afterEach(() => rm(root, { recursive: true, force: true }));
function run() {
  return spawnSync("bash", [script], { encoding: "utf8", env: {
    PATH: `${join(root, "bin")}:/usr/bin:/bin`, FAKE_LOG: join(root, "calls"),
    BB_COOKIE_SYNC_STATE_FILE: join(root, "state.json"),
  } });
}
it("imports an extension snapshot without touching any running browser", async () => {
  await writeFile(join(root, "state.json"), JSON.stringify({ bbCookieSync: true, cookies: [] }));
  expect(run().status).toBe(0);
  expect(await readFile(join(root, "calls"), "utf8")).toBe(`bb-browser\nstate\nsync\ndefault\n${join(root, "state.json")}\n`);
});
it("refuses legacy state without closing or restarting Brave", async () => {
  await writeFile(join(root, "state.json"), '{"cookies":[]}');
  expect(run().status).toBe(1);
  await expect(readFile(join(root, "calls"))).rejects.toThrow();
});
