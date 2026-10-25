import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stageSetup, runSetup } from "./setup-host";
import { setupRecipeSchema } from "./setup-contract";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "bb-setup-")); vi.stubEnv("HOME", root); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it("runs in the workspace with the declared executable path, not the provider directory", async () => {
  const workspace = join(root, "workspace"), bin = join(workspace, ".tools/bin");
  await mkdir(bin, { recursive: true });
  const probe = join(bin, "setup-probe");
  await writeFile(probe, '#!/usr/bin/env python3\nimport json, os\nprint(json.dumps({"cwd":os.getcwd(),"value":os.environ["FIXTURE"],"path":os.environ["PATH"]}))\n');
  await chmod(probe, 0o755);
  const recipe = setupRecipeSchema.parse({ name: "fixture", script: "prepare", command: "setup-probe", env: { PATH: "${BB_WORKSPACE_DIR}/.tools/bin:${PATH}", FIXTURE: "ready" } });
  const staged = await stageSetup(workspace, recipe, new AbortController().signal);
  const result = await runSetup(staged.setupScript, new AbortController().signal);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ cwd: workspace, value: "ready", path: `${bin}:${process.env.PATH}` });
});

it("waits for the command to finish and preserves a failing exit code", async () => {
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "wait.py"), 'import pathlib,time,sys\npathlib.Path("entered").write_text("ready")\nwhile not pathlib.Path("release").exists(): time.sleep(0.01)\nprint("completed")\nsys.exit(7)\n');
  const staged = await stageSetup(workspace, setupRecipeSchema.parse({ name: "wait", script: "wait", command: "python3 wait.py", env: {} }), new AbortController().signal);
  let completed = false;
  const pending = runSetup(staged.setupScript, new AbortController().signal).then(result => { completed = true; return result; });
  try {
    await vi.waitFor(async () => expect(await readFile(join(workspace, "entered"), "utf8")).toBe("ready"));
    expect(completed).toBe(false);
  } finally { await writeFile(join(workspace, "release"), "go"); }
  const result = await pending;
  expect(result.exitCode).toBe(7);
  expect(result.stdout.trim()).toBe("completed");
});

it("cancels the setup process group before reporting completion", async () => {
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "cancel.py"), 'import pathlib,signal,sys\ndef stopped(*args):\n pathlib.Path("cancelled").write_text("stopped")\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stopped)\npathlib.Path("entered").write_text("ready")\nsignal.pause()\n');
  const controller = new AbortController();
  const staged = await stageSetup(workspace, setupRecipeSchema.parse({ name: "cancel", script: "cancel", command: "python3 cancel.py", env: {} }), controller.signal);
  const pending = runSetup(staged.setupScript, controller.signal);
  const rejected = expect(pending).rejects.toThrow("cancelled");
  try { await vi.waitFor(async () => expect(await readFile(join(workspace, "entered"), "utf8")).toBe("ready")); }
  finally { controller.abort(); }
  await rejected;
  await vi.waitFor(async () => expect(await readFile(join(workspace, "cancelled"), "utf8")).toBe("stopped"));
});

it("keeps parallel workspace environments separate", async () => {
  const directories = [join(root, "a"), join(root, "b")];
  await Promise.all(directories.map(path => mkdir(path)));
  const staged = await Promise.all(directories.map((cwd, index) => stageSetup(cwd, setupRecipeSchema.parse({ name: "parallel", script: "prepare", command: 'printf "%s" "$FIXTURE"', env: { FIXTURE: String(index) } }), new AbortController().signal)));
  const results = await Promise.all(staged.map(value => runSetup(value.setupScript, new AbortController().signal)));
  expect(results.map(value => [value.exitCode, value.stdout])).toEqual([[0, "0"], [0, "1"]]);
});

it("rejects reserved environment fields and paths outside a staged recipe", async () => {
  expect(() => setupRecipeSchema.parse({ name: "bad", script: "bad", command: "true", env: { AGENT_SETUP_SCRIPT: "override" } })).toThrow();
  expect(() => setupRecipeSchema.parse({ name: "bad", script: "bad", command: "true", env: {}, files: { "../outside": "payload" } })).toThrow();
  const bad = setupRecipeSchema.parse({ name: "bad", script: "bad", command: "true", env: { FIXTURE: "${UNDECLARED}" } });
  await expect(stageSetup(root, bad, new AbortController().signal)).rejects.toThrow("Unsupported setup variable");
});
