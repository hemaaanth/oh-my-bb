import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import type { PluginMachineProviderResource } from "@get-bb/plugin-sdk/machine-provider";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { registerSandboxCli } from "../src/cli.js";
import type { SandboxRuntimeConfig } from "../src/config.js";
import { SandboxManager } from "../src/manager.js";
import {
  SandboxRunner,
  type SandboxRunBackend,
  type SandboxRunRequest,
  type SandboxRunStatus,
} from "../src/run.js";
import { sandboxMigrations, SandboxStore } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** Runs commands on this machine with HOME pointed at a scratch "sandbox". */
function localExecutor(home: string): MachineExecutor {
  return {
    exec: (request) =>
      new Promise((resolve) => {
        const [command, ...args] = request.command;
        const child = spawn(command!, args, { env: { ...process.env, HOME: home }, stdio: "pipe" });
        child.stdout.on("data", (chunk: Buffer) => request.onOutput(chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => request.onOutput(chunk.toString("utf8")));
        child.on("close", (code) => resolve({ exitCode: code ?? 1 }));
        child.stdin.end(request.stdin);
      }),
  };
}

function fakeBackend(home: string, overrides: Partial<SandboxRunBackend> = {}) {
  const removed: PluginMachineProviderResource[] = [];
  const inputs: unknown[] = [];
  const backend: SandboxRunBackend = {
    parseInputs: (value) => {
      inputs.push(value);
      return value;
    },
    parseResource: (value) => value,
    async create(context) {
      const resource = { provider: "box", key: context.key };
      await context.checkpoint(resource);
      return { resource, executor: localExecutor(home) };
    },
    async remove(context) {
      removed.push(context.resource);
    },
    ...overrides,
  };
  return { backend, removed, inputs };
}

function storeFor() {
  const fake = createFakePluginHost({ pluginId: "sandboxes" });
  const db = fake.bb.storage.database();
  fake.bb.storage.migrate(db, [...sandboxMigrations]);
  return { fake, store: new SandboxStore(db) };
}

async function settle(runner: SandboxRunner, id: string): Promise<SandboxRunStatus> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const status = runner.job(id);
    if (status.state !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("run did not settle");
}

async function checkout(): Promise<{ directory: string; large: Buffer }> {
  const directory = await temporaryDirectory("bb-run-checkout-");
  const git = (...args: string[]) => spawnSync("git", ["-C", directory, ...args], { stdio: "ignore" });
  git("init", "-q");
  // Several upload chunks, out of order if concurrency reorders them.
  const large = randomBytes(300 * 1024);
  await writeFile(join(directory, "large.bin"), large);
  await writeFile(join(directory, ".gitignore"), "ignored.txt\n");
  await writeFile(join(directory, "tracked.txt"), "tracked\n");
  await writeFile(join(directory, "gone.txt"), "gone\n");
  await mkdir(join(directory, "nested"));
  await writeFile(join(directory, "nested", "file with space.txt"), "spaced\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  await unlink(join(directory, "gone.txt"));
  await writeFile(join(directory, "untracked.txt"), "untracked\n");
  await writeFile(join(directory, "ignored.txt"), "ignored\n");
  return { directory, large };
}

function request(overrides: Partial<SandboxRunRequest>): SandboxRunRequest {
  return { command: "true", directory: null, timeoutMs: 60_000, ...overrides };
}

describe("SandboxRunner", () => {
  it("copies tracked and untracked files, runs the command, and removes the machine", async () => {
    const home = await temporaryDirectory("bb-run-home-");
    const { directory, large } = await checkout();
    const { store } = storeFor();
    const { backend, removed, inputs } = fakeBackend(home);
    const runner = new SandboxRunner({ backends: new Map([["box", backend]]), store, warn: () => {} });

    const id = runner.start(request({
      tier: "L",
      directory,
      command: "ls -A | sort && cat 'nested/file with space.txt'",
    }));
    const status = await settle(runner, id);

    expect(status).toMatchObject({ state: "passed", exitCode: 0, error: null, provider: "box" });
    expect(status.progress).toEqual(expect.arrayContaining([
      ".gitignore", "large.bin", "nested", "tracked.txt", "untracked.txt", "spaced", "Removed the sandbox",
    ]));
    expect(status.progress).not.toContain("ignored.txt");
    expect(status.progress).not.toContain("gone.txt");
    expect(await readFile(join(home, "bb-run", "src", "large.bin"))).toEqual(large);
    expect(inputs).toEqual([{ size: "L" }]);
    expect(removed).toEqual([{ provider: "box", key: id }]);
    expect(store.listRuns()).toEqual([]);
  });

  it("reports the command's exit status and still removes the machine", async () => {
    const home = await temporaryDirectory("bb-run-home-");
    const { store } = storeFor();
    const { backend, removed } = fakeBackend(home);
    const runner = new SandboxRunner({ backends: new Map([["box", backend]]), store, warn: () => {} });

    const status = await settle(runner, runner.start(request({ command: "echo partial; printf tail; exit 7" })));

    expect(status).toMatchObject({ state: "failed", exitCode: 7 });
    expect(status.progress).toEqual(expect.arrayContaining(["partial", "tail"]));
    expect(removed).toHaveLength(1);
  });

  it("removes a checkpointed machine when creation fails afterwards", async () => {
    const home = await temporaryDirectory("bb-run-home-");
    const { store } = storeFor();
    const { backend, removed } = fakeBackend(home, {
      async create(context) {
        await context.checkpoint({ provider: "box", key: context.key });
        throw new Error("quota exceeded");
      },
    });
    const runner = new SandboxRunner({ backends: new Map([["box", backend]]), store, warn: () => {} });

    const status = await settle(runner, runner.start(request({})));

    expect(status).toMatchObject({ state: "error", error: "quota exceeded" });
    expect(removed).toHaveLength(1);
    expect(store.listRuns()).toEqual([]);
  });

  it("keeps a machine it could not remove and removes it at the next start", async () => {
    const home = await temporaryDirectory("bb-run-home-");
    const { store } = storeFor();
    const warnings: string[] = [];
    const failing = fakeBackend(home, {
      async remove() {
        throw new Error("api down");
      },
    });
    const first = new SandboxRunner({
      backends: new Map([["box", failing.backend]]),
      store,
      warn: (message) => warnings.push(message),
    });
    const id = first.start(request({}));
    const status = await settle(first, id);
    expect(status.state).toBe("passed");
    expect(status.progress.join("\n")).toContain("Could not remove the sandbox");
    expect(store.listRuns().map((run) => run.id)).toEqual([id]);

    const healthy = fakeBackend(home);
    await new SandboxRunner({ backends: new Map([["box", healthy.backend]]), store, warn: () => {} })
      .cleanupLeftovers();

    expect(healthy.removed).toEqual([{ provider: "box", key: id }]);
    expect(store.listRuns()).toEqual([]);
    expect(warnings.join("\n")).toContain("api down");
  });

  it("fails before creating a machine when the directory is not a checkout", async () => {
    const home = await temporaryDirectory("bb-run-home-");
    const { store } = storeFor();
    let created = false;
    const { backend } = fakeBackend(home, {
      async create() {
        created = true;
        throw new Error("unreachable");
      },
    });
    const runner = new SandboxRunner({ backends: new Map([["box", backend]]), store, warn: () => {} });

    const status = await settle(runner, runner.start(request({ directory: home })));

    expect(status.state).toBe("error");
    expect(status.error).toContain("is not a git checkout");
    expect(created).toBe(false);
  });

  it("asks for a provider when several are configured", () => {
    const { store } = storeFor();
    const { backend } = fakeBackend("/unused");
    const runner = new SandboxRunner({
      backends: new Map([["box", backend], ["daytona", backend]]),
      store,
      warn: () => {},
    });

    expect(() => runner.start(request({}))).toThrow("configured providers: boat, daytona");
  });
});

function runtimeConfig(): SandboxRuntimeConfig {
  return {
    daytona: null,
    modal: null,
    e2b: null,
    box: null,
    freestyle: null,
    idleSleepMs: null,
    defaultSizeTier: "M",
    copyGitHubCliAuth: false,
    sandboxEnv: {},
    image: { repository: "ghcr.io/acme/bb-sandbox", username: null, token: null, platform: "linux/amd64" },
  };
}

describe("bb sandbox run", () => {
  function cli(statuses: SandboxRunStatus[]) {
    const { fake, store } = storeFor();
    const requests: SandboxRunRequest[] = [];
    registerSandboxCli(fake.bb, new SandboxManager(fake.bb, store, { config: runtimeConfig() }), {
      startRun: (runRequest) => {
        requests.push(runRequest);
        return "run_1";
      },
      runJob: () => statuses.shift() ?? statuses[0]!,
    });
    return { fake, requests };
  }

  const finished: SandboxRunStatus = {
    id: "run_1",
    provider: "box",
    command: "npm test",
    state: "failed",
    exitCode: 4,
    error: null,
    progress: ["$ npm test", "1 failing"],
    cursor: 2,
  };

  it("quotes argv words, uses the caller's checkout, and exits with the command status", async () => {
    const { fake, requests } = cli([finished]);

    const result = await fake.harness.runCli(
      ["run", "--provider", "boat", "--tier", "XL", "--timeout", "45", "--", "npm", "run", "test:ci", "--", "it's"],
      { cwd: "/work/repo" },
    );

    expect(requests).toEqual([{
      provider: "box",
      tier: "XL",
      command: "npm run test:ci -- 'it'\\''s'",
      directory: "/work/repo",
      timeoutMs: 45 * 60_000,
    }]);
    expect(result.exitCode).toBe(4);
    expect(result.stdout).toContain("1 failing");
    expect(result.stdout).toContain("Exited 4 on boat");
  });

  it("passes one word through as a shell script and skips the upload", async () => {
    const { fake, requests } = cli([{ ...finished, state: "passed", exitCode: 0 }]);

    const result = await fake.harness.runCli(["run", "--no-upload", "--", "make -j8 && make check"], { cwd: "/x" });

    expect(requests[0]).toMatchObject({ command: "make -j8 && make check", directory: null });
    expect(result.exitCode).toBe(0);
  });

  it("exits 3 with a resume command when the watch window ends first", async () => {
    const { fake } = cli([{ ...finished, state: "running", exitCode: null }]);

    const result = await fake.harness.runCli(["run", "--no-wait", "--", "sleep 600"], { cwd: "/x" });

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("bb sandbox run-status run_1");
  });

  it("requires a command after --", async () => {
    const { fake } = cli([finished]);

    const result = await fake.harness.runCli(["run", "--provider", "boat"], { cwd: "/x" });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("-- <command...>");
  });
});
