import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./host-contract.js";

// Host results travel in one JSON-RPC line capped at 8 MiB.
const MAX_STDOUT_BYTES = 6 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function homeDirectory(): string {
  return process.env.HOME || homedir();
}

// The daemon runs inside BB's Electron build. BB strips these variables for
// agent shells, so strip them here too: NODE_ENV=production would make package
// managers skip devDependencies, and ELECTRON_RUN_AS_NODE leaks into child
// Electron apps.
function childEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const { NODE_ENV: _nodeEnv, ELECTRON_RUN_AS_NODE: _electron, ...environment } = process.env;
  const path = [join(homeDirectory(), ".local", "bin"), environment.PATH].filter(Boolean).join(delimiter);
  return { ...environment, PATH: path, ...extra };
}

function resolveCommand(command: string): string {
  return command.startsWith("~/") ? join(homeDirectory(), command.slice(2)) : command;
}

async function findCommand(name: string): Promise<string | null> {
  for (const directory of (childEnvironment().PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

class CappedOutput {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    if (this.bytes >= this.limit) return;
    const kept = chunk.subarray(0, this.limit - this.bytes);
    this.chunks.push(kept);
    this.bytes += kept.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function exec(
  input: { cwd: string; command: string; args: string[]; stdin?: string; timeoutMs: number; env?: Record<string, string> },
  signal: AbortSignal,
): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    // A detached child leads its own process group, so a timeout also stops
    // the grandchildren a setup script starts.
    const child = spawn(resolveCommand(input.command), input.args, {
      cwd: input.cwd,
      env: childEnvironment(input.env),
      detached: true,
      stdio: [input.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = new CappedOutput(MAX_STDOUT_BYTES);
    const stderr = new CappedOutput(MAX_STDERR_BYTES);
    let timedOut = false;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group already exited.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, input.timeoutMs);
    signal.addEventListener("abort", kill, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const finish = (exitCode: number) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      resolvePromise({ exitCode, stdout: stdout.text(), stderr: stderr.text(), timedOut });
    };
    child.on("error", (error) => {
      stderr.push(Buffer.from(error.message));
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
    // A child that exits before reading its input must not crash the worker.
    child.stdin?.on("error", () => undefined).end(input.stdin);
  });
}

async function gitCommonDirectory(cwd: string, signal: AbortSignal): Promise<string | null> {
  const result = await exec({ cwd, command: "git", args: ["rev-parse", "--path-format=absolute", "--git-common-dir"], timeoutMs: 15_000 }, signal);
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

function insideHome(path: string): boolean {
  const relation = relative(homeDirectory(), resolve(path));
  return relation !== "" && !relation.startsWith("..") && !isAbsolute(relation);
}

async function writePrivate(path: string, content: string, mode: number): Promise<void> {
  await writeFile(path, content, { mode });
  // writeFile only applies the mode when it creates the file.
  await chmod(path, mode);
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    run: (input, context) => exec(input, context.signal),

    home: () => ({ home: homeDirectory() }),

    async bootstrap({ opVersion }, context) {
      const home = homeDirectory();
      const localBin = join(home, ".local", "bin");
      await mkdir(localBin, { recursive: true });
      let mise = await findCommand("mise");
      if (!mise) {
        const installer = join(context.experimental_paths.tempDir, "mise-install.sh");
        const download = await exec({
          cwd: home,
          command: "curl",
          args: ["--fail", "--silent", "--show-error", "--location", "--retry", "3", "--output", installer, "https://mise.run"],
          timeoutMs: 2 * 60_000,
        }, context.signal);
        if (download.exitCode === 0) {
          await exec({ cwd: home, command: "sh", args: [installer], timeoutMs: 2 * 60_000, env: { MISE_INSTALL_PATH: join(localBin, "mise") } }, context.signal);
        }
        await rm(installer, { force: true });
        mise = await findCommand("mise");
      }
      if (!mise) return { home, miseInstalled: false, opEnvironmentSupported: false };
      const tool = `1password-cli@${opVersion}`;
      await exec({ cwd: home, command: mise, args: ["install", tool], timeoutMs: 3 * 60_000 }, context.signal);
      const help = await exec({ cwd: home, command: mise, args: ["x", tool, "--", "op", "run", "--help"], timeoutMs: 60_000 }, context.signal);
      return { home, miseInstalled: true, opEnvironmentSupported: help.exitCode === 0 && help.stdout.includes("--environment") };
    },

    async probe({ cwd, commands }, context) {
      const missing: string[] = [];
      for (const command of commands) {
        if (!(await findCommand(command))) missing.push(command);
      }
      return { missing, gitCommonDir: await gitCommonDirectory(cwd, context.signal) };
    },

    async stage(input) {
      if (!insideHome(input.tokenPath) || !insideHome(input.helperPath)) {
        throw new Error("Credential files must stay inside the host home directory");
      }
      if (basename(input.metadataPath) !== "bb-project-environment.json") {
        throw new Error("Credential metadata must be named bb-project-environment.json");
      }
      for (const directory of [join(homeDirectory(), ".config", "op"), dirname(input.tokenPath)]) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
      }
      await writePrivate(input.tokenPath, `${input.token}\n`, 0o600);
      await mkdir(dirname(input.helperPath), { recursive: true });
      await writePrivate(input.helperPath, input.helperSource, 0o755);
      try {
        await access("/usr/local/bin", constants.W_OK);
        const link = "/usr/local/bin/bb-project-env-run";
        await rm(link, { force: true });
        await symlink(input.helperPath, link);
      } catch {
        // Only images with a writable /usr/local/bin get the global link.
      }
      await writePrivate(input.metadataPath, input.metadata, 0o600);
      return {};
    },

    async cleanup({ cwd, profileId, preserveSharedToken }, context) {
      const gitCommon = await gitCommonDirectory(cwd, context.signal);
      if (!gitCommon) return {};
      const metadataPath = resolve(gitCommon, "bb-project-environment.json");
      let metadata: { profileId?: unknown; tokenFile?: unknown; tokenScope?: unknown; legacyTokenFile?: unknown };
      try {
        metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      } catch {
        return {};
      }
      if (metadata.profileId !== profileId) return {};
      const tokenFile = typeof metadata.tokenFile === "string" ? metadata.tokenFile : null;
      if (tokenFile && (!preserveSharedToken || metadata.tokenScope === "workspace")) await rm(tokenFile, { force: true });
      if (
        tokenFile && !preserveSharedToken && typeof metadata.legacyTokenFile === "string"
        && dirname(metadata.legacyTokenFile) === dirname(tokenFile)
      ) {
        await rm(metadata.legacyTokenFile, { force: true });
      }
      await rm(metadataPath, { force: true });
      return {};
    },
  },
});
