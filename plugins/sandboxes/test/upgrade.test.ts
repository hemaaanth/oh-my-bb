import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  healScript,
  hostScriptCommand,
  TERMINAL_COMMAND_LIMIT,
  probeScript,
  parseHealResult,
  SandboxUpgrader,
  staleParts,
  type CarriedVersions,
  type HarnessVersions,
  type LegacyMachineOps,
  type SandboxUpgradeDeps,
} from "../src/upgrade.js";

const adapters = ["fx-acp", "nanocodex-acp", "prime-agent-acp"] as const;
const adapterHashes = Object.fromEntries(adapters.map(name => [
  name, createHash("sha256").update(`#!/bin/sh\necho '${name}'\n`).digest("hex"),
])) as Record<(typeof adapters)[number], string>;
const latest: HarnessVersions = {
  "claude-code": "2.1.300",
  codex: "0.160.0",
  omp: "18.4.0",
  fx: "0.0.11",
  pi: "1.2.0",
  "prime-agent": "0.10.0",
  ...adapterHashes,
};

const oldImage: CarriedVersions = {
  bb: "0.43.4",
  harness: { ...latest, "claude-code": "2.1.281", codex: "0.156.1", omp: "18.3.0", fx: "0.0.10" },
};

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fakeBin(directory: string, name: string, output: string): void {
  const path = join(directory, "bin", name);
  writeFileSync(path, `#!/bin/sh\necho '${output}'\n`);
  chmodSync(path, 0o755);
}

function healPrefix(claudeVersion: string): string {
  const prefix = mkdtempSync(join(tmpdir(), "bb-upgrade-"));
  temporary.push(prefix);
  mkdirSync(join(prefix, "bin"));
  // The scripts run node; CI installs it outside /usr/bin.
  symlinkSync(process.execPath, join(prefix, "bin", "node"));
  fakeBin(prefix, "claude", `${claudeVersion} (Claude Code)`);
  fakeBin(prefix, "codex", `codex-cli ${latest.codex}`);
  fakeBin(prefix, "omp", `omp/${latest.omp}`);
  fakeBin(prefix, "fx", latest.fx);
  fakeBin(prefix, "bb", "0.43.0");
  fakeBin(prefix, "pi", latest.pi);
  fakeBin(prefix, "prime-agent", `prime-agent ${latest["prime-agent"]}`);
  for (const name of adapters) fakeBin(prefix, name, name);
  // Records every npm call; `npm install` also "upgrades" claude.
  const npm = join(prefix, "bin", "npm");
  writeFileSync(
    npm,
    `#!/bin/sh\necho "$*" >> '${prefix}/npm-calls'\n` +
      `if [ "$1" = install ]; then\ncase "$*" in\n*'@earendil-works/pi-coding-agent@'*) printf '#!/bin/sh\\necho "${latest.pi}"\\n' > '${prefix}/bin/pi'; chmod 755 '${prefix}/bin/pi';;\n*'@anthropic-ai/claude-code@'*) printf '#!/bin/sh\\necho "${latest["claude-code"]} (Claude Code)"\\n' > '${prefix}/bin/claude'; chmod 755 '${prefix}/bin/claude';;\nesac\nfi\nexit 0\n`,
  );
  chmodSync(npm, 0o755);
  return prefix;
}

function runHeal(prefix: string): string {
  return execFileSync("bash", ["-c", healScript(latest)], {
    env: { PATH: `${join(prefix, "bin")}:/usr/bin:/bin`, BB_HARNESS_PREFIX: prefix },
    encoding: "utf8",
  });
}

function npmInstalls(prefix: string): string[] {
  try {
    return readFileSync(join(prefix, "npm-calls"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("install"));
  } catch {
    return [];
  }
}

describe("heal script", () => {
  it("installs nothing and reports versions when a machine is current", () => {
    const prefix = healPrefix(latest["claude-code"]);
    const output = runHeal(prefix);
    expect(npmInstalls(prefix)).toEqual([]);
    expect(parseHealResult(output)).toEqual({ bb: "0.43.0", harness: latest, setupRevision: null });
  });

  it("installs only the stale harness, into the machine's prefix", () => {
    const prefix = healPrefix("2.1.261");
    const output = runHeal(prefix);
    expect(npmInstalls(prefix)).toEqual([
      `install --global --prefix ${prefix} --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@${latest["claude-code"]}`,
    ]);
    expect(parseHealResult(output)?.harness["claude-code"]).toBe(latest["claude-code"]);
  });

  it("installs a missing required binary and reports it current", () => {
    const prefix = healPrefix(latest["claude-code"]);
    rmSync(join(prefix, "bin", "claude"));
    const output = runHeal(prefix);
    expect(npmInstalls(prefix)).toEqual([
      `install --global --prefix ${prefix} --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@${latest["claude-code"]}`,
    ]);
    expect(parseHealResult(output)?.harness["claude-code"]).toBe(latest["claude-code"]);
  });

  it("removes npm leftovers and keeps a working harness when the disk is nearly full", () => {
    const prefix = healPrefix("2.1.261");
    const leftover = join(prefix, "lib", "node_modules", "@openai", ".codex-vdnmINeK");
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(prefix, "bin", "df"), "#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/vda 20000000 19850000 150000 100%% /\\n'\n");
    chmodSync(join(prefix, "bin", "df"), 0o755);
    const output = execFileSync("bash", ["-c", `exec 2>&1\n${healScript(latest)}`], {
      env: { PATH: `${join(prefix, "bin")}:/usr/bin:/bin`, BB_HARNESS_PREFIX: prefix },
      encoding: "utf8",
    });
    expect(existsSync(leftover)).toBe(false);
    expect(npmInstalls(prefix)).toEqual([]);
    expect(output).toContain("Only 146 MB free");
    expect(parseHealResult(output)?.harness["claude-code"]).toBe("2.1.261");
  });

  it("installs Pi when an old image lacks it", () => {
    const prefix = healPrefix(latest["claude-code"]);
    rmSync(join(prefix, "bin", "pi"));
    const output = runHeal(prefix);
    expect(parseHealResult(output)?.harness.pi).toBe(latest.pi);
    expect(npmInstalls(prefix)).toEqual([
      `install --global --prefix ${prefix} --ignore-scripts @earendil-works/pi-coding-agent@${latest.pi}`,
    ]);
  });

  it("probes missing adapters without installing or changing files", () => {
    const prefix = healPrefix(latest["claude-code"]);
    rmSync(join(prefix, "bin", "nanocodex-acp"));
    const output = execFileSync("bash", ["-c", probeScript()], {
      env: { PATH: `${prefix}/bin:/usr/bin:/bin` }, encoding: "utf8",
    });
    expect(parseHealResult(output)?.harness).toEqual({ ...latest, "nanocodex-acp": null });
    expect(existsSync(join(prefix, "npm-calls"))).toBe(false);
    expect(existsSync(join(prefix, "bin", "nanocodex-acp"))).toBe(false);
  });

  it("fits the heal script in one terminal command and runs it unchanged", () => {
    const script = healScript(latest, { bbApp: "0.46.0" });
    const command = hostScriptCommand(script);
    expect(command.length).toBeLessThanOrEqual(TERMINAL_COMMAND_LIMIT);
    const inner = command.replace(/; sleep 600'$/u, "'").replace(/bash -c "\$\((.*)\)"/u, "$1");
    expect(execFileSync("bash", ["-c", inner], { encoding: "utf8" })).toBe(script);
  });

  it("refuses a host script too big for a terminal command", () => {
    const noise = Array.from({ length: 20_000 }, (_, i) => createHash("sha256").update(String(i)).digest("hex")).join("");
    expect(() => hostScriptCommand(noise)).toThrow(/too big for a terminal command/u);
  });

  it("refuses versions that could inject shell", () => {
    expect(() => healScript({ ...latest, codex: "1; rm -rf /" })).toThrow(/unexpected Codex CLI/u);
  });

  it("parses the marker out of noisy terminal output", () => {
    expect(
      parseHealResult(
        '\u001b[0mnpm warn\r\n\u001b[1G\u001b[0K⠙\u001b[1G\u001b[0KBB-UPGRADE-RESULT {"bb":"0.43.0","claude-code":"2.1.300","codex":"","omp":"18.4.0","fx":"0.0.11"}\r\n',
      ),
    ).toEqual({
      bb: "0.43.0",
      harness: { "claude-code": "2.1.300", codex: null, omp: "18.4.0", fx: "0.0.11",
        pi: null, "prime-agent": null, "fx-acp": null, "nanocodex-acp": null, "prime-agent-acp": null },
      setupRevision: null,
    });
    expect(parseHealResult("no marker")).toBeNull();
  });
});

describe("legacy heal script", () => {
  function legacyPrefix(daemonRunning: boolean) {
    const prefix = healPrefix(latest["claude-code"]);
    // The script finds daemons with ps; a fake keeps the test off real processes.
    fakeBin(prefix, "ps", daemonRunning ? "999999 node /usr/local/bin/bb-host-daemon" : "");
    const entrypoint = join(prefix, "entrypoint");
    writeFileSync(
      entrypoint,
      `#!/bin/sh\ntouch '${prefix}/daemon-started'\n` +
        'if [ -n "${BB_SANDBOX_CLAUDE_AUTH_BASE64:-}" ]; then\n  echo restore\nfi\n',
    );
    chmodSync(entrypoint, 0o755);
    return { prefix, entrypoint };
  }

  function runLegacyHeal(prefix: string, entrypoint: string): string {
    return execFileSync("bash", ["-c", healScript(latest, { bbApp: "0.46.0" })], {
      env: {
        PATH: `${join(prefix, "bin")}:/usr/bin:/bin`,
        BB_HARNESS_PREFIX: prefix,
        BB_SANDBOX_ENTRYPOINT: entrypoint,
      },
      encoding: "utf8",
    });
  }

  async function waitFor(path: string): Promise<boolean> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (existsSync(path)) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }

  it("installs bb-app, turns off the login restore once, and starts the daemon", async () => {
    const { prefix, entrypoint } = legacyPrefix(false);
    runLegacyHeal(prefix, entrypoint);
    expect(npmInstalls(prefix)).toEqual([
      `install --global --prefix ${prefix} --allow-scripts=@anthropic-ai/claude-code,@parcel/watcher,better-sqlite3,node-pty,@google/genai,protobufjs bb-app@0.46.0`,
    ]);
    const patched = readFileSync(entrypoint, "utf8");
    expect(patched).toContain("if false; then # bb-fix BB_SANDBOX_CLAUDE_AUTH_BASE64");
    expect(readFileSync(`${entrypoint}.bak`, "utf8")).not.toContain("bb-fix");
    expect(await waitFor(join(prefix, "daemon-started"))).toBe(true);

    writeFileSync(`${entrypoint}.bak`, "untouched");
    runLegacyHeal(prefix, entrypoint);
    expect(readFileSync(`${entrypoint}.bak`, "utf8")).toBe("untouched");
  });

  it("leaves a running daemon on the current bb-app alone", async () => {
    const { prefix, entrypoint } = legacyPrefix(true);
    fakeBin(prefix, "bb", "0.46.0");
    const output = runLegacyHeal(prefix, entrypoint);
    expect(npmInstalls(prefix)).toEqual([]);
    expect(parseHealResult(output)?.bb).toBe("0.46.0");
    expect(await waitFor(join(prefix, "daemon-started"))).toBe(false);
  });

  it("refuses a bb-app version that could inject shell", () => {
    expect(() => healScript(latest, { bbApp: "0.46.0; reboot" })).toThrow(/unexpected bb-app/u);
  });
});

describe("staleParts", () => {
  it("names each part behind and treats unknown as behind", () => {
    expect(staleParts(oldImage, { bb: "0.43.4", harness: latest }, { includeBb: true })).toEqual([
      "Claude Code 2.1.281 → 2.1.300",
      "Codex CLI 0.156.1 → 0.160.0",
      "OMP 18.3.0 → 18.4.0",
      "FX 0.0.10 → 0.0.11",
    ]);
    expect(staleParts(null, { bb: "0.43.4", harness: latest }, { includeBb: true })[0]).toBe(
      "bb ? → 0.43.4",
    );
  });

  it("treats a missing required binary as stale on machines", () => {
    expect(staleParts({ bb: "0.43.4", harness: { ...latest, pi: null } },
      { bb: "0.43.4", harness: latest }, { includeBb: false })).toEqual(["Pi ? → 1.2.0"]);
  });
});


function harness(
  overrides: Partial<SandboxUpgradeDeps> = {},
  hostPhase: "active" | "suspended" = "suspended",
  teardown: { status: "running" | "failed"; attempt: number } | null = null,
) {
  const host = {
    id: "host_1",
    name: "Daytona · superspot",
    machineProviderId: "sandbox-daytona",
    status: hostPhase === "active" ? "connected" : "disconnected",
    lifecycle: { phase: hostPhase, teardown },
  };
  const marker = `BB-UPGRADE-RESULT ${JSON.stringify({ bb: "0.43.0", ...latest })}\n`;
  const resume = vi.fn(async () => {
    host.status = "connected";
    host.lifecycle.phase = "active";
    return host;
  });
  const suspend = vi.fn(async () => host);
  const reconcile = vi.fn(async () => host);
  const create = vi.fn(async () => ({ id: "term_1" }));
  const close = vi.fn(async () => ({ id: "term_1" }));
  const fake = createFakePluginHost({
    pluginId: "sandboxes",
    sdk: {
      hosts: {
        list: vi.fn(async () => [
          host,
          { ...host, id: "host_local", machineProviderId: null },
        ]),
        get: vi.fn(async () => host),
        experimental_resume: resume,
        experimental_suspend: suspend,
        experimental_reconcile: reconcile,
      },
      terminals: {
        create,
        close,
        output: vi.fn(async () => ({
          chunks: [{ seq: 0, dataBase64: Buffer.from(marker).toString("base64") }],
          nextSeq: 1,
          status: "running",
          closeReason: null,
          exitCode: null,
          truncated: false,
        })),
      },
    },
  });
  const dispatch = vi.fn(async () => ({ runId: "42", url: "https://github.com/run/42" }));
  const holds = { hold: vi.fn(), release: vi.fn() };
  const deps: SandboxUpgradeDeps = {
    bb: fake.bb,
    serverVersion: async () => "0.43.4",
    latestHarnessVersions: async () => latest,
    activeImage: async () => ({ tag: "20260924t030437z", versions: oldImage }),
    builds: {
      dispatch,
      status: async () => ({ status: "completed", conclusion: "success", url: "https://github.com/run/42" }),
    },
    startRegistration: vi.fn(async () => ({
      id: "job_1",
      kind: "register" as const,
      version: "v",
      reference: "r",
      pinnedReference: null,
      imageIds: [],
    })),
    imageJob: () => ({
      id: "job_1",
      kind: "register",
      version: "v",
      reference: "r",
      pinnedReference: null,
      imageIds: [],
      state: "ready",
      error: null,
      progress: ["Registered bb-sandbox-new-m with daytona (size M)"],
      cursor: 1,
      images: [],
      build: null,
    }),
    nativeImages: () => [{ provider: "daytona", booting: "bb-sandbox-new-m", active: "bb-sandbox-new-m" }],
    holds,
    sleep: async () => undefined,
    setupOnHost: vi.fn(async () => ({ revision: "setup-v1", current: true, files: [{ path: ".pi/agent/extensions/model-gateway.js", status: "current" as const }] })),
    ...overrides,
  };
  return { upgrader: new SandboxUpgrader(deps), dispatch, resume, suspend, reconcile, create, close, holds };
}

async function settle(upgrader: SandboxUpgrader, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = upgrader.job(id);
    if (status.state !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("upgrade did not settle");
}

describe("SandboxUpgrader", () => {
  it("only reports in check mode", async () => {
    const { upgrader, dispatch, resume, create } = harness();
    const status = await settle(upgrader, upgrader.start({ check: true }));
    expect(status.state).toBe("ready");
    expect(status.report?.image.action).toBe("would-build");
    expect(status.report?.machines).toEqual([
      expect.objectContaining({ hostId: "host_1", action: "unknown", versions: null }),
    ]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("reports binary inventory and setup revision for connected check-mode hosts without waking them", async () => {
    const setupOnHost = vi.fn(async () => ({ revision: "setup-v2", current: false,
      files: [{ path: ".pi/agent/extensions/model-gateway.js", status: "missing" as const }] }));
    const { upgrader, resume, dispatch, create } = harness({ setupOnHost }, "active");
    const status = await settle(upgrader, upgrader.start({ check: true }));
    expect(status.report?.machines[0]).toMatchObject({ action: "would-heal",
      versions: { harness: latest, setupRevision: null }, setup: { revision: "setup-v2", current: false },
      message: ".pi/agent/extensions/model-gateway.js: missing" });
    expect(setupOnHost).toHaveBeenCalledWith("host_1", true);
    expect(resume).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("builds, registers, verifies, and heals a sleeping machine back to sleep", async () => {
    const { upgrader, dispatch, resume, suspend, close, holds } = harness();
    const status = await settle(upgrader, upgrader.start());
    expect(status.error).toBeNull();
    expect(status.state).toBe("ready");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ bbAppVersion: "0.43.4", harness: latest }),
    );
    expect(status.report?.image).toMatchObject({ action: "built", runUrl: "https://github.com/run/42" });
    expect(status.progress.join("\n")).toContain("New sandbox machines boot the new image");
    expect(status.report?.machines).toEqual([
      expect.objectContaining({ hostId: "host_1", action: "healed" }),
    ]);
    expect(resume).toHaveBeenCalledWith({ hostId: "host_1" });
    expect(suspend).toHaveBeenCalledWith({ hostId: "host_1" });
    expect(close).toHaveBeenCalledWith({ terminalId: "term_1", mode: "force" });
    expect(holds.hold).toHaveBeenCalledWith("host_1");
    expect(holds.release).toHaveBeenCalledWith("host_1");
  });

  it("skips the build when the image already matches", async () => {
    const { upgrader, dispatch } = harness({
      activeImage: async () => ({ tag: "t", versions: { bb: "0.43.4", harness: latest } }),
    }, "active");
    const status = await settle(upgrader, upgrader.start());
    expect(status.report?.image.action).toBe("current");
    expect(dispatch).not.toHaveBeenCalled();
    expect(status.report?.machines[0]?.action).toBe("healed");
  });

  it("fails when activation did not reach the native backend", async () => {
    const { upgrader, resume } = harness({
      nativeImages: () => [{ provider: "daytona", booting: "bb-sandbox-old-m", active: "bb-sandbox-new-m" }],
    });
    const status = await settle(upgrader, upgrader.start());
    expect(status.state).toBe("error");
    expect(status.error).toMatch(/still boot an old image.*bb plugin reload sandboxes/u);
    expect(resume).not.toHaveBeenCalled();
  });

  it("heals a sleeping machine whose last wake failed, but not one being torn down", async () => {
    const failed = harness({}, "suspended", { status: "failed", attempt: 5 });
    const healed = await settle(failed.upgrader, failed.upgrader.start({ skipImage: true }));
    expect(healed.report?.machines[0]).toMatchObject({ hostId: "host_1", action: "healed" });

    const running = harness({}, "suspended", { status: "running", attempt: 1 });
    const skipped = await settle(running.upgrader, running.upgrader.start({ skipImage: true }));
    expect(skipped.report?.machines).toEqual([]);
    expect(running.resume).not.toHaveBeenCalled();
  });

  it("reconciles and retries a machine that will not wake", async () => {
    const { upgrader, resume, reconcile } = harness();
    resume.mockRejectedValueOnce(new Error("Timed out waiting for machine connection"));
    const status = await settle(upgrader, upgrader.start({ skipImage: true }));
    expect(reconcile).toHaveBeenCalledWith({ hostId: "host_1" });
    expect(resume).toHaveBeenCalledTimes(2);
    expect(status.report?.machines[0]?.action).toBe("healed");
  });

  function legacyOps(output: string, started = true) {
    return {
      list: () => [{ id: "sbx_1", name: "site (legacy daytona)", hostId: "host_legacy" }],
      run: vi.fn(async () => ({ output, started })),
      stop: vi.fn(async () => undefined),
      recordBbApp: vi.fn(),
    } satisfies LegacyMachineOps;
  }
  const legacyMarker = (bb: string) =>
    `BB-UPGRADE-RESULT ${JSON.stringify({ bb, ...latest })}`;

  it("heals a legacy machine onto the server's bb-app and stops it again", async () => {
    const legacy = legacyOps(legacyMarker("0.43.4"));
    const { upgrader } = harness({ legacy }, "active");
    const status = await settle(upgrader, upgrader.start({ skipImage: true }));
    expect(legacy.run).toHaveBeenCalledWith("sbx_1", expect.stringContaining("bb-app@0.43.4"), expect.any(Number));
    expect(legacy.recordBbApp).toHaveBeenCalledWith("sbx_1", "0.43.4");
    expect(legacy.stop).toHaveBeenCalledWith("sbx_1");
    expect(status.report?.machines).toEqual([
      expect.objectContaining({ hostId: "host_1", action: "healed" }),
      expect.objectContaining({ hostId: "host_legacy", action: "healed" }),
    ]);
    expect(status.state).toBe("ready");
  });

  it("fails a legacy machine whose bb-app stayed behind", async () => {
    const legacy = legacyOps(legacyMarker("0.43.0"), false);
    const { upgrader } = harness({ legacy }, "active");
    const status = await settle(upgrader, upgrader.start({ skipImage: true }));
    expect(status.report?.machines[1]).toMatchObject({
      action: "failed",
      message: "still behind: bb 0.43.0 → 0.43.4",
    });
    expect(legacy.stop).not.toHaveBeenCalled();
    expect(status.state).toBe("error");
  });

  it("only reports legacy machines in check mode", async () => {
    const legacy = legacyOps("");
    const { upgrader } = harness({ legacy });
    const status = await settle(upgrader, upgrader.start({ check: true }));
    expect(status.report?.machines[1]?.action).toBe("unknown");
    expect(legacy.run).not.toHaveBeenCalled();
  });

  it("names the running or latest job", async () => {
    const { upgrader } = harness();
    expect(upgrader.latestId()).toBeNull();
    const id = upgrader.start({ check: true });
    expect(upgrader.latestId()).toBe(id);
    await settle(upgrader, id);
    expect(upgrader.latestId()).toBe(id);
  });

  it("runs one upgrade at a time", () => {
    const { upgrader } = harness();
    const id = upgrader.start({ check: true });
    expect(() => upgrader.start()).toThrow(new RegExp(id, "u"));
  });
});
