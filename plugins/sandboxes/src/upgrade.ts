/**
 * `bb sandbox upgrade`: bring the sandbox image and every live native sandbox
 * machine up to the latest agent harnesses and the bb server's version.
 *
 * One run does, in order:
 *   1. check    — latest Claude Code, Codex, OMP, and FX releases plus the bb
 *                 server version, against the `bb.*` labels on the active image
 *   2. build    — use the local Docker builder with saved contents and target versions
 *   3. register — the image builder registers the pinned digest with providers
 *   4. verify   — the native machine backends now boot that image
 *   5. heal     — resume each live native machine, install the target
 *                 harness versions in place, verify, and put it back to sleep
 *   6. legacy   — start each VM from the pre-0.43 launcher, bring bb-app and
 *                 the harnesses current, restart its host daemon, and wait
 *                 for it to connect
 *
 * The heal step deliberately leaves bb itself alone on native machines:
 * reinstalling bb-app under the running host daemon can strand the machine,
 * and core owns daemon protocol updates. Legacy machines are the exception:
 * nothing but this plugin starts their daemon, and the server rejects one
 * whose bb-app is behind.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { stripVTControlCharacters } from "node:util";
import { adaptersRef, latestHarnessVersions } from "./upgrade-sources.js";
import { executorRunner, gatewaySetupOnHost, reconcileGatewaySetup, outputTail, type GatewaySetupResult } from "./gateway-setup.js";
import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import type { SandboxImageProvider } from "./config.js";
import type { NativeIdleSuspendHolds } from "./provider/idle-suspend.js";

export const harnessNames = ["claude-code", "codex", "omp", "fx", "pi", "prime-agent", "fx-acp", "nanocodex-acp", "prime-agent-acp"] as const;
export type HarnessName = (typeof harnessNames)[number];
export type HarnessVersions = Record<HarnessName, string>;

const harnessLabels: Record<HarnessName, string> = {
  "claude-code": "Claude Code",
  codex: "Codex CLI",
  omp: "OMP",
  fx: "FX",
  pi: "Pi",
  "prime-agent": "Prime Agent",
  "fx-acp": "FX ACP",
  "nanocodex-acp": "nanocodex ACP",
  "prime-agent-acp": "Prime Agent ACP",
};

/** What an image or machine carries; null where it could not be read. */
export interface CarriedVersions {
  bb: string | null;
  harness: Record<HarnessName, string | null>;
  setupRevision?: string | null;
}

export interface UpgradeTarget {
  bb: string;
  harness: HarnessVersions;
}

export interface SandboxUpgradeOptions {
  /** Report what would change without building, registering, or healing. */
  check?: boolean;
  /** Leave the image alone; only heal machines. */
  skipImage?: boolean;
  /** Leave machines alone; only rebuild the image. */
  skipMachines?: boolean;
  /** Rebuild even when the active image already matches. */
  forceImage?: boolean;
}

export type MachineUpgradeAction =
  | "current"
  | "would-heal"
  | "healed"
  | "unknown"
  | "skipped"
  | "failed";

export interface MachineUpgradeResult {
  hostId: string;
  name: string;
  action: MachineUpgradeAction;
  versions: CarriedVersions | null;
  setup?: GatewaySetupResult;
  message: string | null;
}

export interface SandboxUpgradeReport {
  check: boolean;
  target: UpgradeTarget;
  image: {
    before: CarriedVersions | null;
    reference: string | null;
    action: "current" | "would-build" | "built" | "skipped";
    tag: string | null;
    runUrl: string | null;
  };
  machines: MachineUpgradeResult[];
}

export type SandboxUpgradeJobState = "running" | "ready" | "error";

export interface SandboxUpgradeJobStatus {
  id: string;
  state: SandboxUpgradeJobState;
  error: string | null;
  progress: string[];
  cursor: number;
  report: SandboxUpgradeReport | null;
}

/** A VM from the pre-0.43 launcher; its record lives in the plugin database. */
export interface LegacyMachine {
  id: string;
  name: string;
  hostId: string;
}

export interface LegacyMachineOps {
  list(): LegacyMachine[];
  /**
   * Start the VM when it is stopped and run a script on it as the sandbox
   * user. `started` says whether this call started it.
   */
  run(id: string, script: string, timeoutMs: number): Promise<{ output: string; started: boolean }>;
  stop(id: string): Promise<void>;
  recordBbApp(id: string, version: string): void;
}

export interface SandboxUpgradeDeps {
  bb: BbPluginApi;
  serverVersion(): Promise<string>;
  latestHarnessVersions(): Promise<HarnessVersions>;
  /** The active image's build tag and the versions its labels name. */
  activeImage(): Promise<{ tag: string; versions: CarriedVersions } | null>;
  buildImage(input: { tag: string; bbAppVersion: string; harness: HarnessVersions; onLog: (message: string) => void }): Promise<void>;
  /**
   * Per image provider, the image the native machine backend will boot next
   * and the one the store has active. They differ when activation did not
   * reach the backend.
   */
  nativeImages(): Array<{
    provider: SandboxImageProvider;
    booting: string | null;
    active: string | null;
  }>;
  holds: NativeIdleSuspendHolds | null;
  legacy?: LegacyMachineOps;
  setupOnHost?(hostId: string, check: boolean): Promise<GatewaySetupResult>;
  /** Injectable for tests. */
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

const MAX_JOB_LOG_LINES = 2_000;
const MAX_RETAINED_JOBS = 4;
const HOST_CONNECT_TIMEOUT_MS = 5 * 60 * 1_000;
const DISCONNECTED_GRACE_MS = 90_000;
const HEAL_TIMEOUT_MS = 10 * 60 * 1_000;
const HEAL_POLL_MS = 3_000;
const LEGACY_CONNECT_TIMEOUT_MS = 3 * 60 * 1_000;
const RESULT_MARKER = "BB-UPGRADE-RESULT";
const ENTRYPOINT = "/usr/local/bin/bb-sandbox-entrypoint";
// The legacy entrypoint restores the login snapshot taken at creation on every
// boot, clobbering fresher logins. Turn each restore into `if false`, once.
const ENTRYPOINT_AUTH_FIX = String.raw`s/^if \[ -n "\$\{(BB_SANDBOX_(OMP_AUTH_DB_GZIP|CLAUDE_AUTH|CODEX_AUTH)_BASE64):-\}" \]; then/if false; then # bb-fix \1/`;
const NATIVE_PROVIDER_PREFIX = "sandbox-";

/** A registry tag in the shape `bb sandbox register-image` resolves. */
export function upgradeImageTag(now: number): string {
  return new Date(now)
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "z")
    .toLowerCase();
}

/** Which parts of `carried` differ from `target`; unknown counts as stale. */
export function staleParts(
  carried: CarriedVersions | null,
  target: UpgradeTarget,
  options: { includeBb: boolean },
): string[] {
  const stale: string[] = [];
  if (options.includeBb && carried?.bb !== target.bb) {
    stale.push(`bb ${carried?.bb ?? "?"} → ${target.bb}`);
  }
  for (const name of harnessNames) {
    const current = carried?.harness[name] ?? null;
    if (current !== "disabled" && current !== target.harness[name]) {
      stale.push(`${harnessLabels[name]} ${current ?? "?"} → ${target.harness[name]}`);
    }
  }
  return stale;
}


const shellVersion = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u;

/** Read-only binary inventory. Adapter identities are executable content digests. */
export function probeScript(): string {
  return String.raw`node - <<'BB_PROBE_NODE'
const {execFileSync}=require('node:child_process');
const {readFileSync}=require('node:fs');
const {createHash}=require('node:crypto');
function version(binary,parse) {
  const id=({claude:"claude-code","prime-agent":"prime-agent"})[binary] || binary;
  if(binary !== "bb" && process.env.BB_IMAGE_TOOLS !== undefined && !process.env.BB_IMAGE_TOOLS.split(",").includes(id)) return "disabled";
  try { return parse(execFileSync(binary,['--version'],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','ignore']}).trim()); }
  catch { return ''; }
}
function digest(binary) {
  if(process.env.BB_IMAGE_TOOLS !== undefined && !process.env.BB_IMAGE_TOOLS.split(",").includes(binary)) return "disabled";
  try { const file=execFileSync('sh',['-c','command -v "$1"','sh',binary],{encoding:'utf8'}).trim();
    return createHash('sha256').update(readFileSync(file)).digest('hex'); }
  catch { return ''; }
}
const inventory={
  bb:version('bb',v=>v.split('\n')[0]),
  'claude-code':version('claude',v=>v.split(' ')[0]),
  codex:version('codex',v=>v.split(' ').at(-1)),
  omp:version('omp',v=>v.replace(/^omp\//,'')),
  fx:version('fx',v=>v.split(' ').at(-1)),
  pi:version('pi',v=>v.split(' ').at(-1)),
  'prime-agent':version('prime-agent',v=>v.split(' ').at(-1)),
  'fx-acp':digest('fx-acp'),'nanocodex-acp':digest('nanocodex-acp'),'prime-agent-acp':digest('prime-agent-acp')
};
console.log('BB-UPGRADE-RESULT '+JSON.stringify(inventory));
BB_PROBE_NODE
`;
}

/** BB rejects terminal commands longer than this. */
export const TERMINAL_COMMAND_LIMIT = 10_000;

/**
 * A terminal command that runs `script` and then keeps the session open, so
 * the output can still be read. The script is gzipped because the heal script
 * inlines the installer and is too big for a plain base64 command.
 */
export function hostScriptCommand(script: string): string {
  const encoded = gzipSync(script, { level: 9 }).toString("base64");
  const command = `bash -c 'bash -c "$(printf %s ${encoded} | base64 -d | gzip -dc)"; sleep 600'`;
  if (command.length > TERMINAL_COMMAND_LIMIT) {
    throw new Error(`the host script is too big for a terminal command (${command.length} > ${TERMINAL_COMMAND_LIMIT} characters)`);
  }
  return command;
}

/** Install required harnesses, including binaries absent from older images. */
export function healScript(target: HarnessVersions, options: { bbApp?: string } = {}): string {
  const gatewayInstaller = readFileSync(new URL("../docker/install-gateway-harnesses.sh", import.meta.url), "utf8");
  for (const name of harnessNames) {
    if (!shellVersion.test(target[name])) {
      throw new Error(`Refusing unexpected ${harnessLabels[name]} version ${JSON.stringify(target[name])}`);
    }
  }
  const bbApp = options.bbApp;
  if (bbApp !== undefined && !shellVersion.test(bbApp)) {
    throw new Error(`Refusing unexpected bb-app version ${JSON.stringify(bbApp)}`);
  }
  // bb-app builds native modules on install; harness-only heals need just Claude Code's.
  const allowScripts =
    bbApp === undefined
      ? "@anthropic-ai/claude-code"
      : "@anthropic-ai/claude-code,@parcel/watcher,better-sqlite3,node-pty,@google/genai,protobufjs";
  const bbAppInstall =
    bbApp === undefined
      ? ""
      : `bb_changed=
if [ "$(bbv)" != "${bbApp}" ]; then
  bb_changed=1
  packages="$packages bb-app@${bbApp}"
  rm -rf "$P/lib/node_modules/bb-app"
  find "$P/lib/node_modules" -maxdepth 1 -type d -name '.bb-app-*' -exec rm -rf {} + 2>/dev/null || true
fi
`;
  const daemon =
    bbApp === undefined
      ? ""
      : `E="\${BB_SANDBOX_ENTRYPOINT:-${ENTRYPOINT}}"
if [ -f "$E" ] && ! grep -q 'bb-fix' "$E"; then
  cp -p "$E" "$E.bak" && sed -i -E '${ENTRYPOINT_AUTH_FIX}' "$E"
fi
daemons() { ps -eo pid=,args= | awk '/bb-host-daemon/ && !/awk/ { print $1 }'; }
if [ -n "$bb_changed" ]; then
  for pid in $(daemons); do kill "$pid" 2>/dev/null || true; done
  sleep 2
fi
if [ -z "$(daemons)" ] && [ -x "$E" ]; then
  (setsid nohup "$E" >/tmp/bb.log 2>&1 </dev/null &)
fi
`;
  return `set -u
P="\${BB_HARNESS_PREFIX:-$(if [ "$(id -u)" = 0 ]; then node -p 'require("node:path").dirname(require("node:path").dirname(process.execPath))'; else printf '%s/.local' "$HOME"; fi)}"
export PATH="$P/bin:$PATH"
image_tool_enabled() { [ "\${BB_IMAGE_TOOLS+x}" != x ] || case ",\${BB_IMAGE_TOOLS}," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
mkdir -p "$P/bin"
CLAUDE_CODE_VERSION=${target["claude-code"]}
CODEX_VERSION=${target.codex}
OMP_VERSION=${target.omp}
FX_VERSION=${target.fx}
cc() { claude --version 2>/dev/null | awk '{print $1; exit}'; }
cx() { codex --version 2>/dev/null | awk '{print $NF; exit}'; }
om() { omp --version 2>/dev/null | sed -n 's|^omp/||p' | head -n1; }
fxv() { fx --version 2>/dev/null | awk '{print $NF; exit}'; }
bbv() { bb --version 2>/dev/null | head -n1; }
case "$(uname -m)" in
  x86_64) omp_arch=x64; fx_arch=x86_64 ;;
  aarch64|arm64) omp_arch=arm64; fx_arch=aarch64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; omp_arch=; fx_arch= ;;
esac
packages=
if image_tool_enabled claude-code && [ "$(cc)" != "$CLAUDE_CODE_VERSION" ]; then packages="$packages @anthropic-ai/claude-code@$CLAUDE_CODE_VERSION"; fi
if image_tool_enabled codex && [ "$(cx)" != "$CODEX_VERSION" ]; then packages="$packages @openai/codex@$CODEX_VERSION"; fi
# An interrupted install leaves .<name>-XXXX folders behind, and npm then
# fails with ENOTEMPTY.
for name in @anthropic-ai/.claude-code @openai/.codex; do
  find "$P/lib/node_modules/\${name%/*}" -maxdepth 1 -type d -name "\${name#*/}-*" -exec rm -rf {} + 2>/dev/null || true
done
${bbAppInstall}free_kb="$(df -Pk "$P" 2>/dev/null | awk 'NR == 2 { print $4 }')"
if [ -n "$packages" ] && [ "\${free_kb:-0}" -lt 1048576 ]; then
  # npm removes the old package before it fails, so a full disk would break
  # a working Claude Code or Codex.
  echo "Only $(( \${free_kb:-0} / 1024 )) MB free on $P; free disk space, then upgrade again" >&2
  packages=
fi
if [ -n "$packages" ]; then
  npm cache clean --force >/dev/null 2>&1 || true
  # Vendor images can link these CLIs from another npm prefix. Replace those links.
  npm install --global --force --prefix "$P" --allow-scripts=${allowScripts} $packages >/tmp/bb-upgrade-npm.log 2>&1 \\
    || tail -n 20 /tmp/bb-upgrade-npm.log >&2
  # The OMP download below needs the room the npm cache now holds.
  npm cache clean --force >/dev/null 2>&1 || true
fi
if image_tool_enabled omp && [ -n "$omp_arch" ] && [ "$(om)" != "$OMP_VERSION" ]; then
  base="https://github.com/can1357/oh-my-pi/releases/download/v$OMP_VERSION"
  if curl -fsSL --retry 5 -o /tmp/bb-upgrade-omp "$base/omp-linux-$omp_arch" \\
    && curl -fsSL --retry 5 -o /tmp/bb-upgrade-omp-sums "$base/SHA256SUMS.txt"; then
    sum="$(awk -v asset="omp-linux-$omp_arch" '$2 == asset { print $1 }' /tmp/bb-upgrade-omp-sums)"
    if [ -n "$sum" ] && printf '%s  %s\\n' "$sum" /tmp/bb-upgrade-omp | sha256sum --check --status; then
      chmod 755 /tmp/bb-upgrade-omp && mv -f /tmp/bb-upgrade-omp "$P/bin/omp"
    else
      echo "OMP checksum mismatch" >&2
    fi
  fi
  rm -f /tmp/bb-upgrade-omp /tmp/bb-upgrade-omp-sums
fi
if image_tool_enabled fx && [ -n "$fx_arch" ] && [ "$(fxv)" != "$FX_VERSION" ]; then
  asset="fx-linux-$fx_arch.tar.gz"
  base="https://github.com/vercel-labs/fx/releases/download/v$FX_VERSION"
  if curl -fsSL --retry 5 -o "/tmp/$asset" "$base/$asset" \\
    && curl -fsSL --retry 5 -o "/tmp/$asset.sha256" "$base/$asset.sha256"; then
    sum="$(awk '{ print $1; exit }' "/tmp/$asset.sha256")"
    if printf '%s  %s\\n' "$sum" "/tmp/$asset" | sha256sum --check --status \\
      && mkdir -p /tmp/bb-upgrade-fx && tar -C /tmp/bb-upgrade-fx -xzf "/tmp/$asset"; then
      chmod 755 /tmp/bb-upgrade-fx/fx && mv -f /tmp/bb-upgrade-fx/fx "$P/bin/fx"
    else
      echo "FX checksum mismatch" >&2
    fi
  fi
  rm -rf "/tmp/$asset" "/tmp/$asset.sha256" /tmp/bb-upgrade-fx
fi
BB_HARNESS_PREFIX="$P" PI_VERSION=${target.pi} PRIME_AGENT_VERSION=${target["prime-agent"]} \\
ADAPTERS_REF='${adaptersRef().replaceAll("'", "'\\''")}' \\
FX_ACP_SHA256=${target["fx-acp"]} NANOCODEX_ACP_SHA256=${target["nanocodex-acp"]} PRIME_AGENT_ACP_SHA256=${target["prime-agent-acp"]} \\
bash -c '${gatewayInstaller.replaceAll("'", "'\\''")}' || echo "Gateway harness installation failed" >&2
npm cache clean --force >/dev/null 2>&1 || true
${daemon}${probeScript()}
`;
}

/** Parse the heal script's marker line out of raw terminal output. */
export function parseHealResult(output: string): CarriedVersions | null {
  const clean = stripVTControlCharacters(output);
  const start = clean.indexOf(`${RESULT_MARKER} {`);
  if (start < 0) return null;
  const line = clean.slice(start).split(/\r?\n/u)[0]!;
  try {
    const parsed = JSON.parse(line.slice(RESULT_MARKER.length + 1)) as Record<string, unknown>;
    const read = (key: string) => {
      const value = parsed[key];
      return typeof value === "string" && value.length > 0 ? value : null;
    };
    return {
      bb: read("bb"),
      harness: Object.fromEntries(harnessNames.map((name) => [name, read(name)])) as CarriedVersions["harness"],
      setupRevision: read("setupRevision"),
    };
  } catch {
    return null;
  }
}

export interface StartupHarnessPolicy {
  /** null preserves an explicitly customized Dockerfile's installed versions. */
  target: HarnessVersions | null;
  tools: readonly string[] | null;
}

export async function prepareGatewayHarnesses(
  bb: BbPluginApi,
  input: { hostId: string; executor: MachineExecutor; signal: AbortSignal },
  policy: StartupHarnessPolicy,
): Promise<void> {
  const execute = executorRunner(input.executor, input.signal);
  const run = (command: string[], stdin?: string) => execute(
    policy.tools === null ? command : ["env", `BB_IMAGE_TOOLS=${policy.tools.join(",")}`, ...command], stdin,
  );
  const carried = parseHealResult(await run(["bash", "-c", probeScript()]));
  if (!carried) throw new Error("Sandbox did not return a harness inventory");
  let target = policy.target;
  if (target === null && harnessNames.some(name => carried.harness[name] === null)) {
    target = await latestHarnessVersions();
    // Explicit custom images retain their versions; only fill missing harnesses.
    for (const name of harnessNames) {
      if (carried.harness[name] !== null) target[name] = carried.harness[name]!;
    }
  }
  if (target !== null && staleParts(carried, { bb: "", harness: target }, { includeBb: false }).length > 0) {
    const output = await run(["bash", "-c", healScript(target)]);
    const stale = staleParts(parseHealResult(output), { bb: "", harness: target }, { includeBb: false });
    if (stale.length) throw new Error(`Sandbox harness preparation failed: ${stale.join(", ")}${outputTail(output)}`);
  }
  // Plain vendor images do not include the required BB preview supervisor.
  await run(["node", "-e", `
const fs=require("node:fs"),path=require("node:path"),{spawnSync}=require("node:child_process");
const source=fs.readFileSync(0);
if(spawnSync("sh",["-c","command -v bb-sandbox-preview"],{stdio:"ignore"}).status!==0){
  const file=path.join(path.dirname(process.execPath),"bb-sandbox-preview"),temporary=file+".tmp-"+process.pid;
  fs.writeFileSync(temporary,source,{mode:0o755,flag:"wx"});
  try{fs.renameSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
`], readFileSync(new URL("../docker/preview-supervisor.mjs", import.meta.url), "utf8"));
  await reconcileGatewaySetup(bb, input.hostId, run, false, true);
}

interface UpgradeJob {
  id: string;
  state: SandboxUpgradeJobState;
  error: string | null;
  log: string[];
  logStart: number;
  report: SandboxUpgradeReport | null;
}

export class SandboxUpgrader {
  private readonly jobs = new Map<string, UpgradeJob>();
  private running: string | null = null;

  constructor(private readonly deps: SandboxUpgradeDeps) {}

  /** Start an upgrade and return its job id; one runs at a time. */
  start(options: SandboxUpgradeOptions = {}): string {
    if (this.running !== null) {
      throw new Error(
        `A sandbox upgrade is already running as ${this.running}; watch it with bb sandbox upgrade-status ${this.running}`,
      );
    }
    const job: UpgradeJob = {
      id: `upg_${randomUUID().replaceAll("-", "")}`,
      state: "running",
      error: null,
      log: [],
      logStart: 0,
      report: null,
    };
    this.jobs.set(job.id, job);
    for (const [id, candidate] of this.jobs) {
      if (this.jobs.size <= MAX_RETAINED_JOBS) break;
      if (candidate.state !== "running") this.jobs.delete(id);
    }
    this.running = job.id;
    const log = (message: string) => {
      for (const line of message.split("\n")) {
        const text = line.trimEnd();
        if (text.length > 0) job.log.push(text);
      }
      const overflow = job.log.length - MAX_JOB_LOG_LINES;
      if (overflow > 0) {
        job.log.splice(0, overflow);
        job.logStart += overflow;
      }
      this.deps.bb.log.info(`[sandbox upgrade] ${message.trimEnd()}`);
    };
    void this.run(options, log, job)
      .then(() => {
        const failed = job.report?.machines.some((machine) => machine.action === "failed") ?? false;
        job.state = failed ? "error" : "ready";
        if (failed) job.error = "One or more machines failed to upgrade";
      })
      .catch((error: unknown) => {
        job.state = "error";
        job.error = error instanceof Error ? error.message : String(error);
        log(`FAILED: ${job.error}`);
      })
      .finally(() => {
        this.running = null;
      });
    return job.id;
  }

  /** The running upgrade, else the one started last; null after a reload. */
  latestId(): string | null {
    return this.running ?? [...this.jobs.keys()].at(-1) ?? null;
  }

  job(id: string, cursor = 0): SandboxUpgradeJobStatus {
    const job = this.jobs.get(id);
    if (job === undefined) {
      throw new Error(
        `Sandbox upgrade ${id} is unknown; a plugin reload drops running upgrades, so start it again with bb sandbox upgrade`,
      );
    }
    return {
      id: job.id,
      state: job.state,
      error: job.error,
      progress: job.log.slice(Math.max(cursor - job.logStart, 0)),
      cursor: job.logStart + job.log.length,
      report: job.report,
    };
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async run(
    options: SandboxUpgradeOptions,
    log: (message: string) => void,
    job: UpgradeJob,
  ): Promise<void> {
    const check = options.check === true;
    log("Checking the latest harness releases and the bb server version");
    const [serverVersion, harness, active] = await Promise.all([
      this.deps.serverVersion(),
      this.deps.latestHarnessVersions(),
      this.deps.activeImage(),
    ]);
    const target: UpgradeTarget = { bb: serverVersion, harness };
    log(
      `Target: bb ${target.bb}, ${harnessNames
        .map((name) => `${harnessLabels[name]} ${target.harness[name]}`)
        .join(", ")}`,
    );
    const report: SandboxUpgradeReport = {
      check,
      target,
      image: {
        before: active?.versions ?? null,
        reference: active?.tag ?? null,
        action: "skipped",
        tag: null,
        runUrl: null,
      },
      machines: [],
    };
    job.report = report;

    if (options.skipImage !== true) {
      const stale = staleParts(active?.versions ?? null, target, { includeBb: true });
      if (active === null) log("No active image carries readable version labels");
      if (stale.length === 0 && options.forceImage !== true) {
        report.image.action = "current";
        log(`Image ${active?.tag ?? "?"} is current`);
      } else if (check) {
        report.image.action = "would-build";
        log(`Image ${active?.tag ?? "?"} is behind: ${stale.join(", ") || "rebuild forced"}`);
      } else {
        log(`Image ${active?.tag ?? "?"} is behind: ${stale.join(", ") || "rebuild forced"}`);
        const tag = upgradeImageTag(this.now());
        report.image.tag = tag;
        await this.deps.buildImage({ tag, bbAppVersion: target.bb, harness: target.harness, onLog: log });
        this.verifyNativeImages(log);
        report.image.action = "built";
      }
    }

    if (options.skipMachines !== true) {
      report.machines = [
        ...(await this.healMachines(target.harness, check, log)),
        ...(await this.healLegacyMachines(target, check, log)),
      ];
    }
    log(check ? "Check finished; nothing was changed" : "Upgrade finished");
  }

  /** Fail loudly if activation did not reach a native machine backend. */
  private verifyNativeImages(log: (message: string) => void): void {
    const mismatched = this.deps
      .nativeImages()
      .filter((entry) => entry.active !== null && entry.booting !== entry.active);
    if (mismatched.length > 0) {
      throw new Error(
        `New machines would still boot an old image (${mismatched
          .map((entry) => `${entry.provider}: ${entry.booting ?? "none"} instead of ${entry.active}`)
          .join("; ")}); run bb plugin reload sandboxes`,
      );
    }
    log("New sandbox machines boot the new image");
  }

  private async healMachines(
    target: HarnessVersions,
    check: boolean,
    log: (message: string) => void,
  ): Promise<MachineUpgradeResult[]> {
    // Core records a failed wake of a suspended machine as a failed teardown,
    // with the phase still "suspended". Heal is the repair for that, so only a
    // teardown in progress keeps a machine out.
    const hosts = (await this.deps.bb.sdk.hosts.list()).filter(
      (host) =>
        host.machineProviderId?.startsWith(NATIVE_PROVIDER_PREFIX) === true &&
        host.lifecycle.teardown?.status !== "running" &&
        (host.lifecycle.phase === "active" || host.lifecycle.phase === "suspended"),
    );
    if (hosts.length === 0) {
      log("No live sandbox machines");
      return [];
    }
    log(`${check ? "Checking" : "Healing"} ${hosts.length} sandbox machine${hosts.length === 1 ? "" : "s"}`);
    const results: MachineUpgradeResult[] = [];
    // One at a time: each resume costs a provider start, and a failure should
    // read clearly in the log rather than interleave with others.
    for (const host of hosts) {
      const result = await this.healMachine(host, target, check, log);
      results.push(result);
      const detail = result.message === null ? "" : ` — ${result.message}`;
      log(`${host.name} (${host.id}): ${result.action}${detail}`);
    }
    return results;
  }

  private async healMachine(
    host: Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["list"]>>[number],
    target: HarnessVersions,
    check: boolean,
    log: (message: string) => void,
  ): Promise<MachineUpgradeResult> {
    const base = { hostId: host.id, name: host.name };
    const wasSuspended = host.lifecycle.phase === "suspended";
    if (!wasSuspended && host.status !== "connected") {
      // Usually a machine mid-wake for a thread; give it a moment.
      const connected = check
        ? false
        : await this.waitForConnection(host.id, DISCONNECTED_GRACE_MS).then(
            () => true,
            () => false,
          );
      if (!connected) {
        return {
          ...base,
          action: check ? "unknown" : "skipped",
          versions: null,
          message: "disconnected while active; try bb machine reconcile",
        };
      }
    }
    if (check) {
      if (wasSuspended) return { ...base, action: "unknown", versions: null, message: "asleep; binary versions and setup revision unknown (not woken)" };
      let versions: CarriedVersions | null = null;
      try {
        versions = parseHealResult(await this.runOnHost(host.id, probeScript()));
        if (!versions) throw new Error("No inventory result from the read-only probe");
        const setup = await (this.deps.setupOnHost ?? ((hostId, mode) => gatewaySetupOnHost(this.deps.bb, hostId, mode)))(host.id, true);
        versions.setupRevision = setup.current ? setup.revision : null;
        const stale = staleParts(versions, { bb: "", harness: target }, { includeBb: false });
        return { ...base, action: stale.length === 0 && setup.current ? "current" : "would-heal", versions, setup,
          message: [...stale, ...setup.files.filter(file => file.status !== "current").map(file => `${file.path}: ${file.status}`)].join(", ") || `setup ${setup.revision} current` };
      } catch (error) {
        return { ...base, action: "failed", versions, message: error instanceof Error ? error.message : String(error) };
      }
    }
    const bb = this.deps.bb;
    this.deps.holds?.hold(host.id);
    try {
      if (wasSuspended) {
        log(`Waking ${host.name}`);
        try {
          await this.wake(host.id);
        } catch (error) {
          // A machine whose core record drifted from the provider (a stuck
          // teardown, a stop behind core's back) wakes after a reconcile.
          log(`${host.name} did not wake (${error instanceof Error ? error.message : String(error)}); reconciling and retrying`);
          await bb.sdk.hosts.experimental_reconcile({ hostId: host.id });
          await this.wake(host.id);
        }
      }
      const output = await this.runOnHost(host.id, healScript(target));
      const versions = parseHealResult(output);
      if (versions === null) {
        return {
          ...base,
          action: "failed",
          versions: null,
          message: `no result from the heal script: ${output.trim().split("\n").slice(-3).join(" | ")}`,
        };
      }
      const setup = await (this.deps.setupOnHost ?? ((hostId, mode) => gatewaySetupOnHost(bb, hostId, mode)))(host.id, false);
      versions.setupRevision = setup.revision;
      const stale = staleParts(versions, { bb: "", harness: target }, { includeBb: false });
      return {
        ...base,
        action: stale.length === 0 ? "healed" : "failed",
        versions,
        setup,
        message: stale.length === 0 ? `bb ${versions.bb ?? "?"} left as is` : `still behind: ${stale.join(", ")}${outputTail(output)}`,
      };
    } catch (error) {
      return {
        ...base,
        action: "failed",
        versions: null,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.deps.holds?.release(host.id);
      if (wasSuspended) {
        await bb.sdk.hosts.experimental_suspend({ hostId: host.id }).catch((error: unknown) => {
          log(`Could not put ${host.name} back to sleep: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
  }

  private async healLegacyMachines(
    target: UpgradeTarget,
    check: boolean,
    log: (message: string) => void,
  ): Promise<MachineUpgradeResult[]> {
    const legacy = this.deps.legacy;
    const machines = legacy?.list() ?? [];
    if (legacy === undefined || machines.length === 0) return [];
    log(`${check ? "Checking" : "Healing"} ${machines.length} legacy machine${machines.length === 1 ? "" : "s"}`);
    const results: MachineUpgradeResult[] = [];
    for (const machine of machines) {
      const result = await this.healLegacyMachine(legacy, machine, target, check, log);
      results.push(result);
      const detail = result.message === null ? "" : ` — ${result.message}`;
      log(`${machine.name} (${machine.hostId}): ${result.action}${detail}`);
    }
    return results;
  }

  private async healLegacyMachine(
    legacy: LegacyMachineOps,
    machine: LegacyMachine,
    target: UpgradeTarget,
    check: boolean,
    log: (message: string) => void,
  ): Promise<MachineUpgradeResult> {
    const base = { hostId: machine.hostId, name: machine.name };
    if (check) {
      const host = await this.deps.bb.sdk.hosts.get({ hostId: machine.hostId });
      if (host.status !== "connected" || host.lifecycle.phase === "suspended") {
        return { ...base, action: "unknown", versions: null, message: "legacy VM not connected; inventory unknown (not started)" };
      }
      return this.healMachine({ ...host, name: machine.name }, target.harness, true, log);
    }
    let started = false;
    try {
      log(`Healing ${machine.name}`);
      const run = await legacy.run(machine.id, healScript(target.harness, { bbApp: target.bb }), HEAL_TIMEOUT_MS);
      started = run.started;
      const versions = parseHealResult(run.output);
      if (versions === null) {
        return {
          ...base,
          action: "failed",
          versions: null,
          message: `no result from the heal script: ${run.output.trim().split("\n").slice(-3).join(" | ")}`,
        };
      }
      if (versions.bb !== null) legacy.recordBbApp(machine.id, versions.bb);
      const stale = staleParts(versions, target, { includeBb: true });
      if (stale.length > 0) {
        return { ...base, action: "failed", versions, message: `still behind: ${stale.join(", ")}${outputTail(run.output)}` };
      }
      try {
        await this.waitForConnection(machine.hostId, LEGACY_CONNECT_TIMEOUT_MS, { requireActive: false });
      } catch (error) {
        return {
          ...base,
          action: "failed",
          versions,
          message: `its daemon ${error instanceof Error ? error.message : String(error)}; see /tmp/bb.log on the VM`,
        };
      }
      const setup = await (this.deps.setupOnHost ?? ((hostId, mode) => gatewaySetupOnHost(this.deps.bb, hostId, mode)))(machine.hostId, false);
      versions.setupRevision = setup.revision;
      return { ...base, action: "healed", versions, message: started ? "connected; stopping it again" : "connected" };
    } catch (error) {
      return {
        ...base,
        action: "failed",
        versions: null,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (started) {
        await legacy.stop(machine.id).catch((error: unknown) => {
          log(`Could not stop ${machine.name} again: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
  }

  private async wake(hostId: string): Promise<void> {
    // Core's resume can wait out its own long connect timeout; bound it.
    await this.within(
      this.deps.bb.sdk.hosts.experimental_resume({ hostId }),
      HOST_CONNECT_TIMEOUT_MS,
      "did not resume within five minutes",
    );
    await this.waitForConnection(hostId);
  }

  private within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  private async waitForConnection(
    hostId: string,
    timeoutMs = HOST_CONNECT_TIMEOUT_MS,
    options: { requireActive: boolean } = { requireActive: true },
  ): Promise<void> {
    const started = this.now();
    for (;;) {
      const host = await this.deps.bb.sdk.hosts.get({ hostId });
      if (
        host.status === "connected" &&
        (!options.requireActive || host.lifecycle.phase === "active")
      ) {
        return;
      }
      if (this.now() - started > timeoutMs) {
        throw new Error(
          `did not reconnect within ${Math.round(timeoutMs / 60_000)} minutes (${host.lifecycle.phase}, ${host.status})`,
        );
      }
      await this.sleep(2_000);
    }
  }

  /**
   * Run a script in a machine terminal and return its output. The command
   * keeps the terminal open after the script ends, because core serves
   * terminal output only while the terminal runs.
   */
  private async runOnHost(hostId: string, script: string): Promise<string> {
    const terminals = this.deps.bb.sdk.terminals;
    const terminal = await terminals.create({
      cols: 200,
      rows: 50,
      title: "bb sandbox upgrade",
      scope: { kind: "host_path", hostId, cwd: "/" },
      start: { mode: "command", command: hostScriptCommand(script) },
    });
    const started = this.now();
    let output = "";
    let sinceSeq = 0;
    try {
      for (;;) {
        await this.sleep(HEAL_POLL_MS);
        const page = await terminals.output({ terminalId: terminal.id, sinceSeq });
        for (const chunk of page.chunks) {
          output += Buffer.from(chunk.dataBase64, "base64").toString("utf8");
        }
        sinceSeq = page.nextSeq;
        if (parseHealResult(output) !== null) return output;
        if (page.status === "exited" || page.status === "disconnected") return output;
        if (this.now() - started > HEAL_TIMEOUT_MS) {
          throw new Error("the heal script did not finish within ten minutes");
        }
      }
    } finally {
      await terminals.close({ terminalId: terminal.id, mode: "force" }).catch(() => undefined);
    }
  }
}
