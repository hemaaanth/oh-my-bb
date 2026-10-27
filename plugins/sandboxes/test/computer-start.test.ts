import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("reports a computer-server crash immediately with its startup error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bb-computer-start-"));
  try {
    for (const [name, body] of Object.entries({
      curl: "exit 1",
      xdpyinfo: "exit 0",
      "cua-computer-server": "echo 'dependency startup error' >&2; exit 23",
    })) {
      const file = join(directory, name);
      await writeFile(file, `#!/bin/sh\n${body}\n`);
      await chmod(file, 0o755);
    }
    await expect(promisify(execFile)("sh", ["docker/computer-start.sh", "start"], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, BB_DATA_DIR: directory },
      timeout: 4000,
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("server exited with status 23\ndependency startup error") });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
