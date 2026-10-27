import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { SetupRecipe } from "./setup-contract.js";

export async function stageSetup(cwd: string, recipe: SetupRecipe, signal: AbortSignal) {
  signal.throwIfAborted();
  if (process.platform === "win32") throw new Error("Agent setup requires a POSIX host with Python 3");
  if (!isAbsolute(cwd)) throw new Error("Setup working directory must be absolute");
  const id = createHash("sha256").update(JSON.stringify({ cwd, recipe })).digest("hex");
  const directory = join(homedir(), ".local/share/bb/agent-setup", id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  async function publish(name: string, content: string) {
    signal.throwIfAborted();
    const staged = join(directory, `${name}.${process.pid}.${crypto.randomUUID()}`);
    await writeFile(staged, content, { mode: 0o600 });
    await rename(staged, join(directory, name));
  }
  for (const [name, content] of Object.entries(recipe.files)) await publish(name, content);
  const setupDirectory = Object.keys(recipe.files).length ? directory : cwd;
  const variables: Record<string, string> = {
    HOME: homedir(), PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    BB_SETUP_DIR: setupDirectory, BB_WORKSPACE_DIR: cwd,
  };
  const env: Record<string, string> = { BB_SETUP_DIR: setupDirectory, BB_WORKSPACE_DIR: cwd };
  for (const [name, value] of Object.entries(recipe.env)) {
    env[name] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, variable: string) => {
      if (!Object.hasOwn(variables, variable)) throw new Error(`Unsupported setup variable: ${variable}`);
      return variables[variable]!;
    });
  }
  const payload = JSON.stringify({ cwd, command: recipe.command, env });
  const wrapper = `import json, os, subprocess, sys\nconfig = json.loads(${JSON.stringify(payload)})\nresult = subprocess.run(config['command'], shell=True, cwd=config['cwd'], env={**os.environ, **config['env']})\nsys.exit(result.returncode if result.returncode >= 0 else 128 - result.returncode)\n`;
  await publish("agent-setup.py", wrapper);
  signal.throwIfAborted();
  return { setupScript: join(directory, "agent-setup.py"), env };
}

export async function runSetup(setupScript: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<{ exitCode: number; stdout: string; stderr: string }>();
  const child = spawn("python3", [setupScript], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  let force: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    try { process.kill(-child.pid!, "SIGTERM"); } catch {}
    force ??= setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 1_000);
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, 600_000);
  const cleanup = () => { clearTimeout(timer); clearTimeout(force); signal.removeEventListener("abort", stop); };
  signal.addEventListener("abort", stop, { once: true });
  child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-16_000); });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16_000); });
  child.once("error", error => { cleanup(); reject(error); });
  child.once("close", code => {
    cleanup();
    if (signal.aborted) reject(new Error("Setup cancelled"));
    else if (timedOut) reject(new Error("Setup timed out after ten minutes"));
    else resolve({ exitCode: code ?? 1, stdout, stderr });
  });
  if (signal.aborted) stop();
  return promise;
}
