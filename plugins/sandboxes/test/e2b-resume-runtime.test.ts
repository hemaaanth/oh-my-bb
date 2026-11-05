import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("restores the sandbox timeout when E2B resumes", () => {
  const directory = mkdtempSync(join(tmpdir(), "bb-e2b-resume-"));
  directories.push(directory);
  const moduleDir = join(directory, "node_modules", "e2b");
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(join(moduleDir, "package.json"), JSON.stringify({ type: "module", exports: "./index.mjs" }));
  writeFileSync(join(moduleDir, "index.mjs"), `
import { appendFileSync } from 'node:fs';
export class SandboxNotFoundError extends Error {}
export const Sandbox = {
  async connect(id) { return { sandboxId: id }; },
  async setTimeout(id, timeoutMs) {
    appendFileSync(process.env.BB_E2B_TEST_LOG, JSON.stringify({ id, timeoutMs }) + '\\n');
  },
};
`);
  const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "e2b-runtime.mjs"), "utf8");
  const scriptPath = join(directory, "e2b-runtime.mjs");
  writeFileSync(scriptPath, script);
  const log = join(directory, "calls");
  const result = spawnSync(process.execPath, [scriptPath, "resume-native"], {
    input: JSON.stringify({ providerSandboxId: "sandbox-test", timeoutMs: 3_600_000 }),
    encoding: "utf8",
    env: { ...process.env, E2B_API_KEY: "test-only", BB_E2B_TEST_LOG: log },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ action: "resume-native", sandboxId: "sandbox-test" });
  expect(JSON.parse(readFileSync(log, "utf8"))).toEqual({ id: "sandbox-test", timeoutMs: 3_600_000 });
});
