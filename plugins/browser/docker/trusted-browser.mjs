#!/usr/bin/env node

// bb-browser: the one trusted browser for agents. It drives Brave through
// agent-browser with an exact user agent, imported auth state, and — when
// egress is "home" — traffic that leaves through a Tailscale exit node. Every
// part of that identity is checked before the browser starts; anything that
// cannot be guaranteed fails loudly instead of quietly running another browser
// or egressing from the machine's own IP.
//
// Configuration lives in $BB_BROWSER_HOME (default $BB_DATA_DIR/trusted-browser)
// as one file per setting, written by `bb-browser provision` or by hand, and
// each can be overridden by an environment variable:
//
//   user-agent          BB_BROWSER_USER_AGENT       exact User-Agent header
//   exit-node           BB_BROWSER_EXIT_NODE        Tailscale exit node name or IP
//   home-egress-ip      BB_BROWSER_HOME_EGRESS_IP   expected public IP(s), comma separated
//   egress              BB_BROWSER_EGRESS           "home" or "direct"
//   tailscale-userspace BB_BROWSER_TAILSCALE_USERSPACE "1" on native sandbox machines
//   tailscale-authkey   (file only)                 auth key for the sandbox's tailscaled
//   state/<name>.json   BB_BROWSER_STATE            imported cookies and localStorage
//   required-state      BB_BROWSER_REQUIRED_STATE   state that must exist before launch
//   backend             BB_BROWSER_BACKEND          "native", "agent", "existing", or empty
//   cdp-port            BB_BROWSER_CDP_PORT         existing Brave loopback debugging port
//   profile             BB_BROWSER_PROFILE          native profile name under BraveSoftware
//   workspace           BB_BROWSER_WORKSPACE        native thread workspace (default 8)
//
// Three backends drive Brave. The explicit existing backend attaches to the
// regular browser without importing state or managing its lifetime. The agent
// backend lets agent-browser launch Brave
// with the identity above; sandboxes always use it, and so does any machine
// with a user agent or state configured unless backend is "native". On a local
// Linux desktop running Hyprland, the native backend instead launches Brave itself, headed,
// on a dedicated persistent profile with a loopback-only debugging port, and
// agent-browser attaches over CDP. Some bot checks refuse any browser that
// agent-browser launched, but accept this one. A temporary Hyprland window rule
// opens new thread windows silently on the configured workspace.
// It never takes the configured user agent or --state; the default state is
// loaded into its profile over CDP instead, once per revision.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomInt, randomBytes } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { homedir, hostname } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeRuntime } from './node-runtime.mjs';

const runtimeDirectory = dirname(fileURLToPath(import.meta.url));

const env = process.env;
const home =
  env.BB_BROWSER_HOME || join(env.BB_DATA_DIR || join(env.HOME || homedir(), ".bb"), "trusted-browser");
const stateDir = join(home, "state");
const tailscaleDir = join(home, "tailscale");
let tailscaleSocket = join(tailscaleDir, "tailscaled.sock"),networkClient='tailscale';
// Written when the last `bb-browser provision` could not apply everything.
const provisionErrorPath = join(home, "provision-error");
// Marks state/default.json as the sandboxes plugin's, so provision may remove it.
const provisionedStatePath = join(home, "provisioned-state");
let networkGeneration, networkAcquired = false, networkClosed = false;
let socksPort = Number(env.BB_BROWSER_SOCKS_PORT || 1055);
const ipEchoUrl = env.BB_BROWSER_IP_ECHO_URL || "https://api.ipify.org";
const inSandbox = env.IS_SANDBOX === "1";
const BRAVE_NAMES = ["brave-browser", "brave", "brave-browser-stable", "brave-origin"];
const BRAVE_FALLBACK_PATH = "/opt/brave.com/brave/brave";
const EGRESS_STAMP_TTL_MS = 60_000;
// One directory per native profile: its record, lock, leases, and log.
const nativeDir = join(home, "native");
function nativeWorkspace() {
  const value = setting("BB_BROWSER_WORKSPACE", "workspace").trim() || "8";
  if (!/^(?:[1-9][0-9]*|(?:name:|special:)[A-Za-z0-9_-]+)$/.test(value)) fail("invalid browser workspace; use a number, name:<name>, or special:<name>");
  return value;
}
const DEFAULT_NATIVE_PROFILE = "Brave-Origin-agent";
// The profiles Brave opens by default. The native backend must never drive the
// user's own browser.
const ORDINARY_PROFILE = /^Brave-(?:Browser|Origin)(?:-(?:Beta|Dev|Development|Nightly))?$/i;
const NATIVE_CLASS = /^bb-browser-[0-9a-f]{12}$/;
// 127.0.0.0/8 and ::1 as /proc/net/tcp{,6} print them on little-endian Linux.
const LOOPBACK_HEX = /^(?:[0-9A-F]{6}7F|0{24}01000000|0{16}FFFF0000[0-9A-F]{6}7F)$/;
// Exits 0 only when 127.0.0.1:<port> can be bound exclusively.
const PORT_PROBE =
  'const s=require("node:net").createServer();s.once("error",()=>process.exit(1));' +
  's.listen({host:"127.0.0.1",port:Number(process.argv[1]),exclusive:true},()=>s.close(()=>process.exit(0)))';
const NATIVE_LAUNCH_ATTEMPTS = 3;
const NATIVE_LIFECYCLE_LOG_LIMIT = 256 * 1024;
// Initial browser size only. Hyprland's normal tiling determines visible bounds.
const NATIVE_WINDOW = { width: 1440, height: 1000 };
// bb-browser's own session for loading the trusted state; callers cannot use it.
const NATIVE_STATE_SESSION = "bb-browser-state";

// Flags that would replace part of the trusted identity, or point agent-browser
// at a different browser altogether. Kernel and the other cloud providers come
// in through --provider, so they are refused here too. --restore and
// --session-name swap in other saved auth state.
const FORBIDDEN_FLAGS = new Set([
  "--executable-path",
  "--user-agent",
  "--proxy",
  "--proxy-bypass",
  "-p",
  "--provider",
  "--device",
  "--cdp",
  "--auto-connect",
  "--no-pin-tab",
  "--engine",
  "--profile",
  "--state",
  "--config",
  "--namespace",
  "--extension",
  "--restore",
  "--restore-save",
  "--restore-check-url",
  "--restore-check-text",
  "--restore-check-fn",
  "--session-name",
]);
// agent-browser flags that take a value, so the command can be found after
// them. Any other flag is read as boolean; a value after an unknown flag then
// reads as the command, which the allowlist below refuses.
const VALUE_FLAGS = new Set([
  "--session",
  "--headers",
  "--init-script",
  "--enable",
  "--ca-cert",
  "--screenshot-dir",
  "--screenshot-quality",
  "--screenshot-format",
  "--input-mode",
  "--color-scheme",
  "--download-path",
  "--max-output",
  "--allowed-domains",
  "--action-policy",
  "--confirm-actions",
  "--idle-timeout",
  "--filter",
  "--timeout",
]);
// Commands that act on the launched Brave. Everything else is refused: connect
// swaps in another browser, batch/chat/mcp run commands bb-browser cannot see,
// plugin and auth can load launch plugins, and install, upgrade, profiles,
// dashboard, inspect, and stream reach beyond the one browser.
const ALLOWED_COMMANDS = new Set([
  "open", "goto", "navigate", "read", "back", "forward", "reload", "pushstate",
  "click", "dblclick", "type", "fill", "press", "key", "keydown", "keyup", "keyboard",
  "hover", "focus", "check", "uncheck", "select", "drag", "upload", "download",
  "scroll", "scrollintoview", "scrollinto", "wait", "mouse",
  "snapshot", "observe", "act", "dialog", "screenshot", "pdf", "eval", "get", "is", "find",
  "set", "network", "cookies", "storage", "tab", "diff",
  "trace", "profiler", "record", "console", "errors", "highlight", "clipboard",
  "webmcp", "react", "vitals", "a11y", "addinitscript", "removeinitscript",
  "confirm", "deny", "session", "close", "quit", "exit", "skills",
]);
const CLOSE_COMMANDS = new Set(["close", "quit", "exit", "session"]);
// `set device` swaps in a device's user agent; `set headers` is checked below.
const ALLOWED_SET = new Set(["viewport", "geo", "geolocation", "offline", "headers", "credentials", "auth", "media"]);
// With a URL, or with these flags, `read` fetches from the agent-browser
// process itself: no proxy, no Brave, and agent-browser's own user agent.
const READ_FETCH_FLAGS = new Set(["--llms", "--require-md", "--raw"]);
// Browser switches agents need for layout and stability. Anything else is
// refused, since Chromium switches can bypass the proxy or replace the UA.
const ALLOWED_BROWSER_ARGS = new Set([
  "window-size",
  "window-position",
  "start-maximized",
  "start-fullscreen",
  "lang",
  "force-device-scale-factor",
  "hide-scrollbars",
  "mute-audio",
  "no-sandbox",
  "no-first-run",
  "no-default-browser-check",
  "disable-gpu",
  "disable-dev-shm-usage",
  "disable-blink-features",
  "disable-notifications",
  "disable-popup-blocking",
  "disable-infobars",
  "disable-extensions",
  "force-color-profile",
  "font-render-hinting",
  "use-gl",
  "use-angle",
  "enable-unsafe-swiftshader",
]);
const PROXY_ENV = new Set(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]);
const SAME_SITE = { strict: "Strict", lax: "Lax", none: "None", no_restriction: "None" };

class BrowserError extends Error {}

function fail(message) {
  throw new BrowserError(message);
}

function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0] ?? "";
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    sleep(500);
  }
}

function which(name) {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

// Every file bb-browser writes may be a secret, so all of them are 0600 inside
// 0700 directories and replaced atomically.
function writePrivate(path, data) {
  ensurePrivateDir(home);
  ensurePrivateDir(dirname(path));
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, data, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function setting(variable, file) {
  const fromEnv = env[variable];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    return readFileSync(join(home, file), "utf8").replace(/\r?\n$/, "");
  } catch {
    return "";
  }
}

function validName(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value);
}

function validUserAgent(value) {
  return value.length <= 1024 && /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
}

function validExitNode(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9.:_-]{0,252}$/.test(value);
}

function parseIps(value) {
  return value
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);
}

function validIpList(value) {
  const ips = parseIps(value);
  return ips.length > 0 && ips.every((ip) => isIP(ip) !== 0);
}

function validAuthKey(value) {
  return /^[\x21-\x7e]{1,512}$/.test(value);
}

function validEgress(value) {
  return value === "home" || value === "direct";
}

// ---------------------------------------------------------------- identity

function resolveBrave() {
  const explicit = env.BB_BROWSER_EXECUTABLE;
  const candidates = explicit
    ? [explicit]
    : [...BRAVE_NAMES.map(which), BRAVE_FALLBACK_PATH].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 15_000 });
    const version = firstLine(result.stdout);
    if (result.status === 0 && /^Brave (?:Browser|Origin)\b/.test(version)) return { path: candidate, version };
    if (explicit) {
      fail(`${candidate} is not Brave (--version printed "${version || "nothing"}"); bb-browser only runs Brave`);
    }
  }
  fail(
    explicit
      ? `BB_BROWSER_EXECUTABLE ${explicit} does not exist`
      : "Brave is not installed: no brave-browser, brave, brave-browser-stable, or brave-origin on PATH. " +
          "Install Brave or set BB_BROWSER_EXECUTABLE; bb-browser never falls back to Chrome or Chromium",
  );
}

function configuredUserAgent() {
  const userAgent = setting("BB_BROWSER_USER_AGENT", "user-agent");
  if (userAgent && !validUserAgent(userAgent)) {
    fail("the configured user agent must be one line of printable ASCII without surrounding spaces");
  }
  return userAgent;
}

function configuredExitNode() {
  const exitNode = setting("BB_BROWSER_EXIT_NODE", "exit-node").trim();
  if (exitNode && !validExitNode(exitNode)) fail("the configured exit node is not a Tailscale host name or IP");
  return exitNode;
}

// Home is the default whenever an exit node is configured, and always inside a
// sandbox: a trusted browser there must not silently use the sandbox's own IP.
// Direct egress has to be chosen explicitly.
function egressMode(exitNode) {
  const mode = setting("BB_BROWSER_EGRESS", "egress").trim() || (exitNode || inSandbox ? "home" : "direct");
  if (!validEgress(mode)) fail(`egress must be "home" or "direct", not "${mode}"`);
  return mode;
}

// A sandbox runs its own tailscaled in userspace mode, so only traffic sent to
// its SOCKS5 proxy uses the exit node. On a machine with system Tailscale the
// exit node routes everything and no proxy is needed.
function usesUserspaceTailscale() {
  return inSandbox || setting("BB_BROWSER_TAILSCALE_USERSPACE", "tailscale-userspace").trim() === "1";
}

function tailscaleArgs(userspace) {
  return userspace ? [`--socket=${tailscaleSocket}`] : [];
}

function tailscaleStatus(userspace) {
  const result = spawnSync(networkClient, [...tailscaleArgs(userspace), "status", "--json"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.error?.code === "ENOENT") fail("tailscale is not installed; home egress needs it");
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function activeExitNode(status) {
  return Object.values(status?.Peer ?? {}).find((peer) => peer?.ExitNode) ?? null;
}

function nodeNames(peer) {
  const dnsName = String(peer.DNSName ?? "").replace(/\.$/, "");
  return [peer.HostName, dnsName, dnsName.split(".")[0], ...(peer.TailscaleIPs ?? [])]
    .filter(Boolean)
    .map((name) => String(name).toLowerCase());
}

function exitNodeHealthy(status, exitNode) {
  const peer = activeExitNode(status);
  return Boolean(
    status?.BackendState === "Running" &&
      status.ExitNodeStatus?.Online &&
      peer &&
      nodeNames(peer).includes(exitNode.toLowerCase()),
  );
}

function tailscaleHostname() {
  const name = env.BB_BROWSER_TAILSCALE_HOSTNAME || `bb-${hostname()}`;
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);
}

// Two commands started together in a fresh sandbox must not both spawn
// tailscaled or both run `tailscale up --reset`, so egress setup holds a lock
// directory. A lock whose holder exited, or older than any setup could take,
// is left over from a crash.
function withLock(path, action, what = "home egress", staleMs = 180_000) {
  const deadline = Date.now() + staleMs;
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(path, "holder"), `${process.pid} ${processStart(process.pid)}`, { mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    try {
      const [pid, start] = readFileSync(join(path, "holder"), "utf8").split(" ");
      if (Date.now() - statSync(path).mtimeMs > staleMs || !sameProcess(Number(pid), start)) {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
    } catch {}
    if (Date.now() >= deadline) fail(`another bb-browser is still starting ${what} (lock ${path})`);
    sleep(250);
  }
  try {
    return action();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

// A process's start time in clock ticks, so a reused pid is not mistaken for
// the process that wrote a lock or lease.
function processStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" ? "" : fields[19] ?? "";
  } catch {
    return "";
  }
}

function sameProcess(pid, start) {
  // Without /proc only the lock's age can show it is stale.
  if (!existsSync("/proc/self/stat")) return true;
  return Number.isInteger(pid) && pid > 0 && alive(pid) && processStart(pid) === start;
}

function useNetworkConnection(value){
  if(!value||typeof value.socket!=='string'||!value.socket.startsWith('/')||value.socket.includes('\0')||!Number.isInteger(value.proxyPort)||value.proxyPort<1024||value.proxyPort>65535||typeof value.client!=='string'||!(value.client==='tailscale'||value.client.startsWith('/'))||value.client.includes('\0'))fail('Invalid host network connection; no direct fallback');
  tailscaleSocket=value.socket;socksPort=value.proxyPort;networkClient=value.client;
}
function networkControl(held){
  if(!threadOwner())fail('Managed sandbox egress requires its BB thread context');
  if(held&&!existsSync(join(home,'legacy-egress-retired'))){
    const socket=join(tailscaleDir,'tailscaled.sock');
    for(const name of readdirSync('/proc'))if(/^\d+$/.test(name)){
      let args;try{args=readFileSync('/proc/'+name+'/cmdline','utf8').split('\0');}catch{continue;}
      if(!args.includes('--socket='+socket)||!args.includes('--statedir='+tailscaleDir))continue;
      const pid=Number(name),start=processStart(pid);if(!sameProcess(pid,start))continue;process.kill(pid,'SIGTERM');
      if(!waitFor(()=>!sameProcess(pid,start),5000))fail('Legacy Browser egress did not stop; shared routing was not selected');
    }
    writePrivate(join(home,'legacy-egress-retired'),'1\n');
  }
  const request=Buffer.from(JSON.stringify({argv:['network',held?'ensure':'release',...(networkGeneration?[networkGeneration]:[])]})).toString('base64url');
  if(held&&networkGeneration)writePrivate(join(threadDir(),threadOwner()+'.network.json'),JSON.stringify({generation:networkGeneration}));
  const result=spawnSync('bb',['plugin','run','browser',request],{encoding:'utf8',timeout:240000,maxBuffer:1024*1024});
  if(result.status!==0)fail('Host network '+(held?'acquisition':'release')+' failed; no independent daemon or direct fallback was used');
  if(held){let value;try{value=JSON.parse(result.stdout);}catch{fail('Invalid host network response');}useNetworkConnection(value);writePrivate(join(home,'shared-network.json'),JSON.stringify(value));networkAcquired=true;}
  else networkAcquired=false;
}

function egressUp(exitNode) {
  if(setting('','network-service')==='sandboxes-v1'){networkControl(true);return;}
  for (const binary of ["tailscale", "tailscaled"]) {
    if (!which(binary)) fail(`${binary} is not installed; home egress needs it`);
  }
  ensurePrivateDir(home);
  ensurePrivateDir(tailscaleDir);
  withLock(join(tailscaleDir, "egress.lock"), () => {
    // Another command may have finished setup while this one waited.
    if (!exitNodeHealthy(tailscaleStatus(true), exitNode)) startEgress(exitNode);
  });
}

function startEgress(exitNode) {
  const logPath = join(tailscaleDir, "tailscaled.log");
  if (!tailscaleStatus(true)) {
    const log = openSync(logPath, "a", 0o600);
    const daemon = spawn(
      "tailscaled",
      [
        "--tun=userspace-networking",
        `--socks5-server=127.0.0.1:${socksPort}`,
        `--statedir=${tailscaleDir}`,
        `--socket=${tailscaleSocket}`,
      ],
      { detached: true, stdio: ["ignore", log, log] },
    );
    daemon.unref();
    closeSync(log);
    if (!waitFor(() => tailscaleStatus(true), 15_000)) fail(`tailscaled did not start; see ${logPath}`);
  }

  const authKey = join(home, "tailscale-authkey");
  const status = tailscaleStatus(true);
  if (status?.BackendState !== "Running") {
    if (!existsSync(authKey)) {
      fail(
        "this machine is not logged in to Tailscale and no auth key is stored; set the browserTailscaleAuthKey " +
          "sandbox setting (it is sent again on the next sandbox resume)",
      );
    }
    // file: keeps the key out of argv and the process list.
    const up = spawnSync(
      "tailscale",
      [
        ...tailscaleArgs(true),
        "up",
        "--reset",
        `--auth-key=file:${authKey}`,
        "--accept-dns=false",
        `--hostname=${tailscaleHostname()}`,
        "--timeout=60s",
      ],
      { encoding: "utf8", timeout: 90_000 },
    );
    if (up.status !== 0) fail(`tailscale up failed: ${firstLine(up.stderr || up.stdout)}`);
  }
  // tailscaled keeps its node key in the statedir, so the auth key is no
  // longer needed and should not sit on disk for every process to read.
  rmSync(authKey, { force: true });
  const set = spawnSync("tailscale", [...tailscaleArgs(true), "set", `--exit-node=${exitNode}`], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (set.status !== 0) fail(`tailscale could not use exit node ${exitNode}: ${firstLine(set.stderr || set.stdout)}`);
  if (!waitFor(() => exitNodeHealthy(tailscaleStatus(true), exitNode), 30_000)) {
    fail(`exit node ${exitNode} did not come online`);
  }
}

function publicIp(proxy) {
  const args = ["--fail", "--silent", "--show-error", "--max-time", "10"];
  if (proxy) args.push("--socks5-hostname", proxy.replace(/^socks5:\/\//, ""));
  args.push(ipEchoUrl);
  const result = spawnSync("curl", args, { encoding: "utf8", timeout: 15_000 });
  const ip = firstLine(result.stdout);
  if (result.status !== 0 || isIP(ip) === 0) {
    fail(
      `could not read the public IP${proxy ? " through the exit node" : ""} from ${ipEchoUrl}: ` +
        (firstLine(result.stderr) || "no IP returned"),
    );
  }
  return ip;
}

// Exit node status alone does not prove where packets leave, so read the
// public IP the way the browser would. With an expected home IP configured it
// must match exactly; without one, traffic through the proxy must at least not
// leave from the machine's own IP. System Tailscale routes the whole machine,
// so there is no own IP to compare with and the home IP is required.
function verifyEgressIp(proxy, exitNode) {
  const expected = parseIps(setting("BB_BROWSER_HOME_EGRESS_IP", "home-egress-ip"));
  if (expected.some((ip) => isIP(ip) === 0)) fail("the configured home egress IP is not an IP address list");
  if (!proxy && expected.length === 0) {
    fail(
      "system Tailscale routes this whole machine, so its public IP can only be checked against a configured " +
        "home egress IP; set browserHomeEgressIp or BB_BROWSER_HOME_EGRESS_IP",
    );
  }
  const stamp = join(home, "egress-verified.json");
  const key = JSON.stringify({ exitNode, proxy, expected, ipEchoUrl });
  try {
    const previous = JSON.parse(readFileSync(stamp, "utf8"));
    if (previous.key === key && Date.now() - previous.at < EGRESS_STAMP_TTL_MS) return previous.detail;
  } catch {}
  const viaExit = publicIp(proxy);
  let detail;
  if (expected.length > 0) {
    if (!expected.includes(viaExit)) fail(`browser traffic leaves from ${viaExit}, not the configured home egress IP`);
    detail = "public IP matches the configured home egress IP";
  } else {
    if (viaExit === publicIp(null)) {
      fail(`traffic through the exit node still leaves from this machine's own IP ${viaExit}`);
    }
    detail = "public IP differs from this machine's own IP";
  }
  writePrivate(stamp, JSON.stringify({ key, at: Date.now(), detail }));
  return detail;
}

function homeEgress(exitNode) {
  if (!exitNode) {
    fail(
      "home egress is required but no exit node is configured. Set the browserExitNode sandbox setting " +
        "or BB_BROWSER_EXIT_NODE, or opt out explicitly with BB_BROWSER_EGRESS=direct",
    );
  }
  const userspace = usesUserspaceTailscale();
  if(userspace&&setting('','network-service')==='sandboxes-v1')egressUp(exitNode);
  let status = tailscaleStatus(userspace);
  if (userspace && !exitNodeHealthy(status, exitNode)) {
    egressUp(exitNode);
    status = tailscaleStatus(userspace);
  }
  if (!status) fail(userspace ? "tailscaled is not running; run bb-browser egress up" : "tailscale is not running on this machine");
  if (status.BackendState !== "Running") fail(`tailscale is ${status.BackendState || "not running"}, not Running`);
  const peer = activeExitNode(status);
  if (!peer || !status.ExitNodeStatus?.Online) fail(`no exit node is online; expected ${exitNode}`);
  if (!nodeNames(peer).includes(exitNode.toLowerCase())) {
    fail(`traffic exits through ${peer.HostName || "another node"}, not the configured ${exitNode}`);
  }
  const proxy = userspace ? `socks5://127.0.0.1:${socksPort}` : null;
  const verified = verifyEgressIp(proxy, exitNode);
  // Logged in already: provision re-sends the key on resume, so drop it again.
  if (userspace) rmSync(join(home, "tailscale-authkey"), { force: true });
  return { exitNode: peer.HostName || exitNode, proxy, verified };
}

function statePath(name) {
  return join(stateDir, `${name}.json`);
}

function resolveState(explicit) {
  const name = explicit ?? (env.BB_BROWSER_STATE || null);
  if (name === "none") return null;
  if (name) {
    if (!validName(name)) fail(`invalid state name "${name}"`);
    if (!existsSync(statePath(name))) fail(`no imported state named "${name}"; see bb-browser state list`);
    return statePath(name);
  }
  // The sandboxes plugin records which state it imported. If that import did
  // not land, starting signed out would quietly be a different identity.
  const required = setting("BB_BROWSER_REQUIRED_STATE", "required-state").trim();
  if (required) {
    if (!validName(required) || !existsSync(statePath(required))) {
      fail(
        `auth state "${required}" is required but is not imported; check the browserStateFile sandbox ` +
          `setting, import it with bb-browser state import ${validName(required) ? required : "<name>"}, ` +
          "or pass --state-name none to run signed out",
      );
    }
    return statePath(required);
  }
  return existsSync(statePath("default")) ? statePath("default") : null;
}

function hyprlandSession() {
  return (
    process.platform === "linux" &&
    Boolean(env.HYPRLAND_INSTANCE_SIGNATURE) &&
    Boolean(env.WAYLAND_DISPLAY) &&
    Boolean(which("hyprctl"))
  );
}

// A configured user agent or auth state is an identity only the agent backend
// applies, so the native backend is never chosen automatically over it.
function agentIdentityConfigured(stateName) {
  return Boolean(
    stateName !== undefined ||
      env.BB_BROWSER_STATE ||
      setting("BB_BROWSER_USER_AGENT", "user-agent") ||
      setting("BB_BROWSER_REQUIRED_STATE", "required-state").trim() ||
      existsSync(statePath("default")),
  );
}

// Sandboxes and userspace Tailscale always use the agent backend: their proxy
// and imported state need agent-browser to launch Brave. Otherwise the native
// backend is chosen only where managed windows can be verified and no
// agent identity is configured, or when it is set explicitly.
function selectedBackend(stateName) {
  const configured = setting("BB_BROWSER_BACKEND", "backend").trim();
  if (configured && configured !== "native" && configured !== "agent" && configured !== "existing") {
    fail(`backend must be "native", "agent", or "existing", not "${configured}"`);
  }
  const remote = usesUserspaceTailscale();
  if (configured === "existing") {
    if (remote) fail("the existing backend is local only; sandboxes keep the agent-browser launch");
    return "existing";
  }
  if (configured === "native") {
    if (remote) fail("the native backend is local only; sandboxes keep the agent-browser launch");
    if (!hyprlandSession()) {
      fail("the native backend needs a Hyprland Wayland session (HYPRLAND_INSTANCE_SIGNATURE, WAYLAND_DISPLAY, hyprctl)");
    }
    return "native";
  }
  if (configured === "agent" || remote || !hyprlandSession()) return "agent";
  return agentIdentityConfigured(stateName) ? "agent" : "native";
}

function nativeProfile() {
  const name = setting("BB_BROWSER_PROFILE", "profile").trim() || DEFAULT_NATIVE_PROFILE;
  if (!validName(name)) fail(`invalid native profile name "${name}"`);
  if (ORDINARY_PROFILE.test(name)) {
    fail(`${name} is Brave's ordinary profile; the native backend only drives a dedicated agent profile`);
  }
  const config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(env.HOME || homedir(), ".config");
  return join(config, "BraveSoftware", name);
}

// The native backend loads only bb-browser's own default state, the one the
// weekly refresh imports, never a state a caller names. A required state must
// be that one, and must be imported.
function nativeTrustedState() {
  const required = setting("BB_BROWSER_REQUIRED_STATE", "required-state").trim();
  if (required && required !== "default") {
    fail(
      `auth state "${validName(required) ? required : "<invalid>"}" is required, but the native backend loads only ` +
        'the default state; set BB_BROWSER_BACKEND=agent to use it',
    );
  }
  const path = statePath("default");
  let file = null;
  try {
    file = lstatSync(path);
  } catch {}
  if (file && !file.isFile()) fail(`${path} is not a regular file; bb-browser does not load it`);
  if (file) return path;
  if (required) {
    fail('auth state "default" is required but is not imported; import it with bb-browser state import default');
  }
  return null;
}

// The native browser keeps its own sign-ins in its profile and its own user
// agent and client hints, which is what the bot checks accept. Only an
// explicit BB_BROWSER_BACKEND=native gets here with an agent identity
// configured: the configured user agent is then an expectation the live check
// enforces, never an override; the trusted default state is loaded into the
// profile through the running browser, never passed to Brave; and an
// explicitly chosen state fails instead of being silently ignored.
function nativeIdentity(stateName) {
  if (stateName !== undefined || env.BB_BROWSER_STATE) {
    fail(
      "imported states do not apply to the native backend: it keeps sign-ins in its own Brave profile and loads " +
        "only bb-browser's default state. Sign in there, or set BB_BROWSER_BACKEND=agent to use --state-name",
    );
  }
  const exitNode = configuredExitNode();
  const mode = egressMode(exitNode);
  const profile = nativeProfile();
  const id = createHash("sha256").update(profile).digest("hex").slice(0, 12);
  return {
    backend: "native",
    userAgent: "",
    expectedUserAgent: configuredUserAgent(),
    exitNode,
    mode,
    state: nativeTrustedState(),
    proxy: null,
    profile,
    dir: join(nativeDir, id),
    windowClass: `bb-browser-${id}`,
    namespace: `bb-trusted-native-${id}`,
    // agent-browser's socket directory. It keeps each session's pinned tab id
    // in namespaces/<namespace>/run after the session closes; bb-browser owns
    // this directory so a launch can clear ids from an earlier browser. Kept
    // short: socket paths must fit in 103 bytes.
    runtime: join(env.XDG_RUNTIME_DIR || join(home, "run"), "bb-browser"),
  };
}

// Explicit attachment to the user's already-running browser. Never launch,
// stop, hide, or import a state into it. The profile lock identifies the owner.
function existingIdentity(stateName) {
  if (process.platform !== "linux") fail("existing Brave attachment currently supports Linux only");
  if (stateName !== undefined || env.BB_BROWSER_STATE) fail("existing Brave uses its own sign-ins; --state-name and BB_BROWSER_STATE do not apply");
  const name = setting("BB_BROWSER_PROFILE", "profile").trim() || "Brave-Origin";
  if (!validName(name)) fail("invalid existing Brave profile name");
  const config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(env.HOME || homedir(), ".config");
  const profile = join(config, "BraveSoftware", name);
  let port = setting("BB_BROWSER_CDP_PORT", "cdp-port").trim();
  if (!port) {
    try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch {}
  }
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    fail("existing Brave needs a loopback debugging port; enable remote debugging in Brave and set BB_BROWSER_CDP_PORT (cookie sync does not need this)");
  }
  const exitNode = configuredExitNode();
  if (exitNode && usesUserspaceTailscale()) fail("existing Brave cannot use a userspace proxy");
  const id = createHash("sha256").update(`${profile}:${port}`).digest("hex").slice(0, 12);
  return { backend: "existing", profile, port: Number(port), userAgent: "", expectedUserAgent: configuredUserAgent(),
    exitNode, mode: egressMode(exitNode), state: null, proxy: null, namespace: `bb-trusted-existing-${id}`,
    runtime: join(env.XDG_RUNTIME_DIR || join(home, "run"), "bb-browser") };
}

function verifyExistingBrowser(identity) {
  const holder = profileHolder(identity.profile);
  if (!holder || holder.elsewhere) fail("the selected regular Brave profile is not running on this machine");
  let args = "";
  try {
    if (statSync(`/proc/${holder.pid}`).uid !== process.getuid()) fail("the regular Brave process belongs to another user");
    args = readFileSync(`/proc/${holder.pid}/cmdline`, "utf8").replaceAll("\0", " ");
  } catch { fail("could not verify the regular Brave process"); }
  if (!/(?:^|\/)(?:brave|brave-origin|brave-browser)(?: |$)/.test(args) || args.includes("--type=")) fail("the profile lock does not identify a Brave browser process");
  if (debugListener(holder.pid, identity.port) !== "loopback") fail("regular Brave must own its debugging port and listen only on loopback");
}

function existingFlags(identity, attach = true) {
  ensurePrivateDir(identity.runtime);
  const flags = ["--config", agentBrowserConfig(), "--namespace", identity.namespace];
  return attach ? [...flags, "--cdp", `http://127.0.0.1:${identity.port}`, "--pin-tab"] : flags;
}

function closeExisting(identity, args, command, inherit) {
  // Detach daemons without issuing Browser.close or touching any personal tab.
  // Tabs created by sessions stay open and can be closed in Brave by the user.
  const closing = command === "session" ? [] : args.includes("--all") ? sessionList(identity) : [requestedSession(args)];
  const result = runAgentBrowser([...existingFlags(identity, false), ...args], { identity, inherit, timeoutMs: 30000 });
  if (command !== "session") {
    waitFor(() => closing.every((name) => !sessionList(identity).includes(name)), 5000);
    const remaining = sessionList(identity);
    for (const name of closing) if (!remaining.includes(name)) forgetPinnedTab(identity, name);
  }
  return result.status ?? 1;
}

// The static half of the identity: what the browser should be. It names the
// agent-browser namespace, so changing any of it starts a fresh daemon rather
// than reusing one launched with the old identity. The state is keyed by path,
// not content: `state save` while browsing must not move later commands to a
// new daemon. A running browser keeps the cookies it started with until
// `bb-browser close`.
function plannedIdentity(stateName) {
  if (selectedBackend(stateName) === "existing") return existingIdentity(stateName);
  if (selectedBackend(stateName) === "native") return nativeIdentity(stateName);
  const userAgent = configuredUserAgent();
  const exitNode = configuredExitNode();
  const mode = egressMode(exitNode);
  const state = resolveState(stateName);
  const proxy = mode === "home" && usesUserspaceTailscale() ? `socks5://127.0.0.1:${socksPort}` : null;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        executable: env.BB_BROWSER_EXECUTABLE ?? "",
        userAgent,
        mode,
        exitNode,
        proxy,
        state,
      }),
    )
    .digest("hex")
    .slice(0, 12);
  return { backend: "agent", userAgent, exitNode, mode, state, proxy, namespace: `bb-trusted-${fingerprint}` };
}

function provisionProblem() {
  try {
    return readFileSync(provisionErrorPath, "utf8").trim() || "unknown error";
  } catch {
    return null;
  }
}

// The checked half: Brave is really Brave and home egress is really up.
function verifiedIdentity(stateName) {
  const problem = provisionProblem();
  if (problem) {
    fail(`the sandbox's browser settings did not apply (${problem}); fix them in the sandboxes plugin settings and resume the sandbox`);
  }
  let planned = plannedIdentity(stateName);
  const brave = resolveBrave();
  const egress = planned.mode === "home" ? homeEgress(planned.exitNode) : null;
  // Managed acquisition can change the proxy port and its namespace fingerprint.
  if (egress) planned = plannedIdentity(stateName);
  return { ...planned, brave, egress };
}

function agentBrowserConfig() {
  const path = join(home, "agent-browser.json");
  // An explicit empty config replaces ~/.agent-browser/config.json and any
  // project agent-browser.json, so neither can add a proxy, provider, or plugin.
  if (!existsSync(path)) writePrivate(path, "{}\n");
  return path;
}

function launchFlags(identity, browserArgs = [], includeState = true) {
  const flags = ["--config", agentBrowserConfig(), "--namespace", identity.namespace];
  if (identity.brave) flags.push("--executable-path", identity.brave.path);
  if (identity.userAgent) flags.push("--user-agent", identity.userAgent);
  if (identity.proxy) flags.push("--proxy", identity.proxy);
  if (includeState && identity.state) flags.push("--state", identity.state);
  const args = [...browserArgs];
  // Agent Browser otherwise exposes navigator.webdriver=true to every site.
  args.push("--disable-blink-features=AutomationControlled");
  // Chromium-based browsers refuse to start as root with their sandbox on, and
  // sandbox containers run agents as root.
  if (process.getuid?.() === 0 && !args.includes("--no-sandbox")) args.push("--no-sandbox");
  // WebRTC can otherwise send UDP straight out of the machine, bypassing the
  // SOCKS5 proxy and revealing its real IP.
  if (identity.proxy) args.push("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  if (args.length > 0) flags.push("--args", args.join(","));
  return flags;
}

function agentBrowserEnv(identity) {
  const scrubbed = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("AGENT_BROWSER_") || PROXY_ENV.has(key.toUpperCase())) continue;
    scrubbed[key] = value;
  }
  if (identity?.runtime) scrubbed.AGENT_BROWSER_SOCKET_DIR = identity.runtime;
  return scrubbed;
}

// ---------------------------------------------------------- native browser
//
// One managed Brave per profile. Its pid, debugging port, profile, and window
// class are recorded in a private file in that profile's own directory, and
// every command checks them again before attaching: the process must be this
// user's Brave on this profile and class, that process must hold every
// listener on its port, on loopback only. Window class checks establish
// ownership; placement changes never stop a running browser.
//
// A per-profile lock covers each check, launch, and stop. A command that
// attaches holds a lease file from that check until its agent-browser call
// returns. Session close detaches without stopping the persistent managed Brave,
// so a close never disrupts a browser another command is about to drive.

function hyprctlRepl(lua) {
  const result = spawnSync("hyprctl", ["repl", lua], { encoding: "utf8", timeout: 10_000 });
  return `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? result.error.message : ""}`.trim();
}

// The rule matches only the managed browser's own class, never ordinary Brave
// windows. It places new windows on the configured workspace and stops them from
// taking focus. Hyprland controls tiling and user fullscreen requests. A config reload
// drops it, so every command adds it again; a handle the reload invalidated
// is ignored.
function addWindowRule(windowClass, workspace = nativeWorkspace()) {
  if (!NATIVE_CLASS.test(windowClass)) fail(`invalid native window class ${windowClass}`);
  const output = hyprctlRepl(
    `_G.__bb_browser_rules = _G.__bb_browser_rules or {} ` +
      `local old = _G.__bb_browser_rules["${windowClass}"] if old then pcall(function() old:set_enabled(false) end) end ` +
      `local rule = hl.window_rule({ name = "${windowClass}", match = { class = "^${windowClass}$" }, ` +
      `workspace = "${workspace} silent", no_initial_focus = true, focus_on_activate = false, ` +
      `float = false, suppress_event = "activate activatefocus" }) ` +
      `_G.__bb_browser_rules["${windowClass}"] = rule return "bb-browser-rule:" .. tostring(rule:is_enabled())`,
  );
  if (!output.includes("bb-browser-rule:true")) {
    fail(`Hyprland did not add the browser workspace rule (${firstLine(output) || "no output"})`);
  }
}

function removeWindowRule(windowClass) {
  if (!NATIVE_CLASS.test(windowClass ?? "")) return;
  hyprctlRepl(
    `local rules = _G.__bb_browser_rules or {} local rule = rules["${windowClass}"] ` +
      `if rule then pcall(function() rule:set_enabled(false) end) rules["${windowClass}"] = nil end ` +
      `return "bb-browser-rule:removed"`,
  );
}

// Check ownership, not placement: users can move windows during manual work.
// Returns how many managed windows there are.
function nativeWindows(browser) {
  const result = spawnSync("hyprctl", ["clients", "-j"], { encoding: "utf8", timeout: 10_000 });
  let clients;
  try {
    clients = JSON.parse(result.stdout);
    if (result.status !== 0 || !Array.isArray(clients)) throw new Error();
  } catch {
    fail("Hyprland did not list its windows, so the native browser's window cannot be checked");
  }
  const windows = clients.filter((client) => client?.pid === browser.pid || client?.class === browser.windowClass);
  for (const window of windows) {
    if (window.class !== browser.windowClass) {
      fail(`a native browser window has class ${window.class}, not ${browser.windowClass}`);
    }
  }
  return windows;
}
function checkNativeWindows(browser) { return nativeWindows(browser).length; }

function alive(pid) {
  try {
    process.kill(pid, 0);
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

// The browser process itself, not a renderer, run by this user on exactly
// this profile and window class.
function ownsNativeProcess(pid, browser) {
  if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) return false;
  try {
    if (statSync(`/proc/${pid}`).uid !== process.getuid()) return false;
    // Chromium rewrites its process title, so the arguments may be one
    // space-joined string rather than NUL-separated; match whole tokens.
    const args = ` ${readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ")} `;
    return (
      args.includes(` --user-data-dir=${browser.profile} `) &&
      args.includes(` --class=${browser.windowClass} `) &&
      !args.includes(" --type=")
    );
  } catch {
    return false;
  }
}

// Chromium's SingletonLock links to "<host>-<pid>" of the browser holding the
// profile.
function profileHolder(profile) {
  try {
    const match = /^(.*)-(\d+)$/.exec(readlinkSync(join(profile, "SingletonLock")));
    if (!match) return null;
    const pid = Number(match[2]);
    if (match[1] !== hostname()) return { pid, elsewhere: true };
    return alive(pid) ? { pid, elsewhere: false } : null;
  } catch {
    return null;
  }
}

// "loopback" when the process holds every listener on the port and all of them
// are bound to loopback, "exposed" when it holds one bound beyond loopback,
// and null otherwise. Brave writes no DevToolsActivePort for a fixed port, and
// another process could hold the port, so the socket inodes must be its own.
function debugListener(pid, port) {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  const listeners = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      const [, local, , state] = fields;
      if (state !== "0A" || !local?.endsWith(`:${hex}`)) continue;
      listeners.push({ inode: fields[9], loopback: LOOPBACK_HEX.test(local.slice(0, -5)) });
    }
  }
  const held = new Set();
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const socket = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (socket) held.add(socket[1]);
      } catch {}
    }
  } catch {
    return null;
  }
  const ours = listeners.filter((listener) => held.has(listener.inode));
  if (ours.some((listener) => !listener.loopback)) return "exposed";
  return ours.length > 0 && ours.length === listeners.length ? "loopback" : null;
}

function recordPath(identity) {
  return join(identity.dir, "browser.json");
}

// A record that names another profile or class is never trusted.
function readNativeBrowser(identity) {
  try {
    const browser = JSON.parse(readFileSync(recordPath(identity), "utf8"));
    if (!browser || typeof browser !== "object") return null;
    return browser.profile === identity.profile && browser.windowClass === identity.windowClass ? browser : null;
  } catch {
    return null;
  }
}

function liveNativeBrowser(identity) {
  const browser = readNativeBrowser(identity);
  if (
    !browser ||
    browser.profile !== identity.profile ||
    browser.windowClass !== identity.windowClass ||
    !ownsNativeProcess(browser.pid, browser) ||
    !Number.isInteger(browser.port) ||
    debugListener(browser.pid, browser.port) !== "loopback"
  ) {
    return null;
  }
  return browser;
}

function terminate(pid) {
  // This is only recovery for an invalid or failed native browser. Normal
  // session close leaves the verified managed Brave running because this Brave
  // Origin build crashes during every tested graceful shutdown path. SIGKILL
  // avoids another core dump and the next launch reloads trusted state.
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  waitFor(() => !alive(pid), 5_000);
}

// A small private audit trail for lifecycle diagnosis. It deliberately omits
// URLs, state, cookies, user agents, and profile paths. The file is truncated
// before it can grow without bound.
function logNativeLifecycle(identity, event, browser = null, detail = {}) {
  try {
    ensurePrivateDir(identity.dir);
    const path = join(identity.dir, "lifecycle.jsonl");
    if (existsSync(path) && statSync(path).size >= NATIVE_LIFECYCLE_LOG_LIMIT) writePrivate(path, "");
    const entry = {
      at: new Date().toISOString(),
      event,
      ...(Number.isInteger(browser?.pid) ? { pid: browser.pid } : {}),
      ...(Number.isInteger(browser?.port) ? { port: browser.port } : {}),
      ...detail,
    };
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {}
}

// Discards an invalid or failed browser: only a process whose own command line
// names this profile and class, never another profile's browser. Then removes
// this class's window rule, record, and state marker. Normal session close does
// not call this. Call it under the profile's lock.
function stopNativeBrowser(identity) {
  const recorded = readNativeBrowser(identity);
  if (recorded && ownsNativeProcess(recorded.pid, identity)) {
    logNativeLifecycle(identity, "discard-requested", recorded, { method: "SIGKILL" });
    terminate(recorded.pid);
    logNativeLifecycle(identity, "discarded", recorded, { method: "SIGKILL", clean: false });
  }
  const holder = profileHolder(identity.profile);
  if (holder && !holder.elsewhere && ownsNativeProcess(holder.pid, identity)) {
    terminate(holder.pid);
  }
  rmSync(stateMarkerPath(identity), { force: true });
  rmSync(`${stateMarkerPath(identity)}.cookies`, { force: true });
  removeWindowRule(identity.windowClass);
  rmSync(recordPath(identity), { force: true });
}

// Sessions left from an earlier browser pin tab ids that a new browser does
// not have, so they are closed before a launch. Fails if any survive. A closed
// session still remembers its tab id, so the runtime directory is cleared too.
function resetNativeSessions(identity) {
  const flags = ["--config", agentBrowserConfig(), "--namespace", identity.namespace];
  const stale = sessionList(identity);
  for (const session of stale) runAgentBrowser([...flags, "--session", session, "close"], { identity, timeoutMs: 30_000 });
  // Daemons exit a moment after close.
  if (stale.length > 0) waitFor(() => sessionList(identity).length === 0, 5_000);
  const left = stale.length > 0 ? sessionList(identity) : [];
  if (left.length > 0) fail(`agent-browser kept stale native sessions (${left.join(", ")}); run bb-browser close --all`);
  clearNativeRuntime(identity);
}

// agent-browser remembers the tab a session pinned even after the session
// closes, and with --pin-tab the session then fails on that closed tab when it
// starts again. Only for a session whose daemon has exited.
function forgetPinnedTab(identity, session) {
  if (!validName(session)) return;
  rmSync(join(identity.runtime, "namespaces", identity.namespace, "run", `${session}.target`), { force: true });
}

// Only while no session runs: a live daemon's socket is in this directory.
function clearNativeRuntime(identity) {
  ensurePrivateDir(identity.runtime);
  rmSync(join(identity.runtime, "namespaces", identity.namespace), { recursive: true, force: true });
}

// Launches Brave on the profile. Any failure stops what it started and
// removes the window rule.
function launchNativeBrowser(identity) {
  const { profile } = identity;
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  chmodSync(profile, 0o700);
  const holder = profileHolder(profile);
  if (holder) {
    fail(
      `the profile ${profile} is open in another Brave (pid ${holder.pid}${holder.elsewhere ? " on another host" : ""}); ` +
        "close it first. bb-browser never attaches to a browser it did not launch",
    );
  }
  let launched = null;
  const children = [];
  try {
    launched = startNativeBrowser(identity, children);
    return launched;
  } finally {
    if (!launched) {
      for (const pid of children) if (alive(pid)) terminate(pid);
      stopNativeBrowser(identity);
    }
  }
}

function startNativeBrowser(identity, children) {
  const { profile, windowClass } = identity;
  // Place even the startup window on the configured workspace without focus.
  addWindowRule(windowClass);
  const logPath = join(identity.dir, "brave.log");
  // Another process can take the probed port before Brave binds it. Brave then
  // never holds the listener, so the attempt fails and retries.
  for (let attempt = 0; attempt < NATIVE_LAUNCH_ATTEMPTS; attempt++) {
    const port = freeLoopbackPort();
    const log = openSync(logPath, "a", 0o600);
    let child;
    try {
      child = spawn(
        identity.brave.path,
        [
          `--user-data-dir=${profile}`,
          `--class=${windowClass}`,
          // A fixed port: with --remote-debugging-port=0 Brave reports
          // navigator.webdriver as true. Headed Chromium binds it to loopback.
          `--remote-debugging-port=${port}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--ozone-platform=wayland",
          `--load-extension=${join(runtimeDirectory, "../browser-extension")}`,
          `--window-size=${NATIVE_WINDOW.width},${NATIVE_WINDOW.height}`,
          "about:blank",
        ],
        { detached: true, stdio: ["ignore", log, log], env: agentBrowserEnv() },
      );
      child.unref();
      if (child.pid) children.push(child.pid);
      logNativeLifecycle(identity, "launch-started", { pid: child.pid, port }, { method: "hyprland-wayland" });
    } finally {
      closeSync(log);
    }
    const started = waitFor(() => {
      const pid = profileHolder(profile)?.pid;
      const listener = pid && ownsNativeProcess(pid, identity) ? debugListener(pid, port) : null;
      return listener ? { pid, listener } : null;
    }, 20_000);
    if (started?.listener === "loopback") {
      const browser = { pid: started.pid, port, profile, windowClass, startedAt: new Date().toISOString() };
      writePrivate(recordPath(identity), `${JSON.stringify(browser)}\n`);
      // The window must appear under the distinct managed class.
      if (!waitFor(() => checkNativeWindows(browser) > 0, 15_000)) {
        fail(`the native browser opened no ${windowClass} window`);
      }
      logNativeLifecycle(identity, "running", browser, { method: "hyprland-wayland" });
      return browser;
    }
    // The spawned process is ours even when it never proved itself.
    if (started && ownsNativeProcess(started.pid, identity)) terminate(started.pid);
    if (alive(child.pid)) terminate(child.pid);
    if (started) fail(`Brave's debugging port ${port} is reachable beyond loopback; bb-browser stopped it`);
  }
  fail(`Brave did not open its debugging port on the native profile after ${NATIVE_LAUNCH_ATTEMPTS} attempts; see ${logPath}`);
}

// A random port below Linux's ephemeral range that 127.0.0.1 can bind now.
function freeLoopbackPort() {
  for (let i = 0; i < 20; i++) {
    const port = randomInt(20_000, 32_768);
    const probe = spawnSync(nodeRuntime(), ["-e", PORT_PROBE, String(port)], { stdio: "ignore", timeout: 5_000 });
    if (probe.status === 0) return port;
  }
  fail("no free loopback port for the native browser");
}

// Launches and checks can take minutes; a holder that exited frees it at once.
function withNativeLock(identity, action) {
  ensurePrivateDir(home);
  ensurePrivateDir(nativeDir);
  ensurePrivateDir(identity.dir);
  ensurePrivateDir(identity.runtime);
  return withLock(join(identity.dir, "lock"), action, "the native browser", 600_000);
}

function leasePath(identity, pid = process.pid) {
  return join(identity.dir, "leases", String(pid));
}

// True while another live bb-browser command holds a lease on this browser.
// Leases of exited processes are removed.
function otherLeases(identity) {
  const dir = join(identity.dir, "leases");
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  let live = false;
  for (const name of names) {
    if (name === String(process.pid)) continue;
    let start = "";
    try {
      start = readFileSync(join(dir, name), "utf8");
    } catch {}
    if (/^\d+$/.test(name) && sameProcess(Number(name), start)) live = true;
    else rmSync(join(dir, name), { force: true });
  }
  return live;
}

// Under the profile's lock: checks the recorded browser again (pid, profile,
// class, loopback port), adds the window rule again, and checks its windows.
// A browser that fails a compositor check is preserved and the command fails. Without a
// live browser, stale sessions are reset and Brave is launched, unless launch
// is false. A browser that will run a command gets the current trusted state
// first. Then takes a lease and runs the action with the browser (or null)
// while holding it.
function withNativeBrowser(identity, launch, action) {
  const browser = withNativeLock(identity, () => {
    let running = liveNativeBrowser(identity);
    let launched = false;
    if (running && launch) {
      // A compositor problem must never destroy a person's manual login.
      addWindowRule(identity.windowClass);
      checkNativeWindows(running);
    } else if (!running && launch) {
      if (anyThreadHandoff()) fail("a browser handoff is pending; finish or cancel it before restarting Brave");
      resetNativeSessions(identity);
      stopNativeBrowser(identity);
      running = launchNativeBrowser(identity);
      launched = true;
    }
    if (running && launch) {
      try {
        if (!anyThreadHandoff()) applyNativeState(identity, running);
      } catch (error) {
        // A browser started only for this command is not left running.
        if (launched) stopNativeBrowser(identity);
        throw error;
      }
    }
    if (running) {
      ensurePrivateDir(join(identity.dir, "leases"));
      writePrivate(leasePath(identity), processStart(process.pid));
    }
    return running;
  });
  try {
    return action(browser);
  } finally {
    if (browser) rmSync(leasePath(identity), { force: true });
  }
}

function stateMarkerPath(identity) {
  return join(identity.dir, "state-applied");
}

// A state's revision is the hash of its content. It is kept only in the
// private marker and never printed.
function stateRevision(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function nativeStateCurrent(identity) {
  if (!identity.state) return true;
  try {
    return readFileSync(stateMarkerPath(identity), "utf8").trim() === stateRevision(identity.state);
  } catch {
    return false;
  }
}

// Loads the trusted state into the native profile through the running
// browser, once per revision; Brave never gets --state. The cookies and
// storage then persist in the profile. The marker advances only after a load
// succeeds, so a failed load, or a state the weekly refresh changed, loads on
// the next command. The revision is read before the load: a state replaced in
// between only loads once more. Nothing about the state is printed: an
// agent-browser error can name its cookies. Call it under the profile's lock.
function applyNativeState(identity, browser) {
  if (!identity.state) return;
  let revision;
  try {
    revision = stateRevision(identity.state);
  } catch {
    fail("bb-browser could not read its trusted state, so it did not load it into the native profile");
  }
  let applied = "";
  try {
    applied = readFileSync(stateMarkerPath(identity), "utf8").trim();
  } catch {}
  if (applied === revision) return;
  const state = JSON.parse(readFileSync(identity.state, "utf8"));
  if (state.bbCookieSync === true && !(state.origins || []).length) {
    // Cookie snapshots need no page or temporary tab at all.
    let previous = [];
    try { previous = JSON.parse(readFileSync(`${stateMarkerPath(identity)}.cookies`, "utf8")); } catch {}
    threadCdp(identity, browser, "syncCookies", {cookies:state.cookies, previous, cleanupTargetId:nativeHelperTarget(identity)});
    writePrivate(`${stateMarkerPath(identity)}.cookies`, JSON.stringify(state.cookies));
    forgetPinnedTab(identity, NATIVE_STATE_SESSION);
    writePrivate(stateMarkerPath(identity), `${revision}\n`);
    return;
  }
  const flags = [...nativeFlags(identity, browser), "--session", NATIVE_STATE_SESSION];
  // The last load closed its tab.
  forgetPinnedTab(identity, NATIVE_STATE_SESSION);
  let loaded = false;
  try {
    const synced = JSON.parse(readFileSync(identity.state, "utf8")).bbCookieSync === true;
    if (synced && runAgentBrowser([...flags, "cookies", "clear"], { identity, timeoutMs: 30000 }).status !== 0) fail("could not apply live cookie sync");
    loaded = runAgentBrowser([...flags, "state", "load", identity.state], { identity, timeoutMs: 60_000 }).status === 0;
  } finally {
    // Its tab is left alone when it is the last: Brave would quit.
    if (pageTabs(identity, flags) > 1) runAgentBrowser([...flags, "tab", "close"], { identity, timeoutMs: 30_000 });
    runAgentBrowser([...flags, "close"], { identity, timeoutMs: 30_000 });
    // Daemons exit a moment after close.
    waitFor(() => !sessionList(identity).includes(NATIVE_STATE_SESSION), 5_000);
  }
  if (!loaded) fail("agent-browser could not load bb-browser's trusted state into the native profile");
  writePrivate(stateMarkerPath(identity), `${revision}\n`);
}

// A prior version may have left its private state helper tab open.
function nativeHelperTarget(identity) {
  try {
    const pin = JSON.parse(readFileSync(join(identity.runtime, "namespaces", identity.namespace, "run", `${NATIVE_STATE_SESSION}.target`), "utf8"));
    return /^[A-Fa-f0-9]+$/.test(pin.targetId || "") ? pin.targetId : undefined;
  } catch { return undefined; }
}
// Older Agent Browser includes type; current versions list pages without it.
function pageTabs(identity, flags) {
  const result = runAgentBrowser([...flags, "--json", "tab", "list"], { identity, timeoutMs: 30_000 });
  try {
    const tabs = JSON.parse(result.stdout).data.tabs;
    return Array.isArray(tabs) ? tabs.filter((tab) => tab && (tab.type === undefined || tab.type === "page")).length : 0;
  } catch {
    return 0;
  }
}

// The native backend attaches with --cdp only. Brave already runs with its own
// user agent and profile, so no executable, user agent, proxy, state, or
// browser switches are passed.
function nativeFlags(identity, browser) {
  const flags = ["--config", agentBrowserConfig(), "--namespace", identity.namespace];
  return browser ? [...flags, "--cdp", String(browser.port), "--pin-tab"] : flags;
}

// Each named session pins its own tab in the one native browser. Closing a
// session closes its tab and detaches. The verified managed Brave stays running
// even after the last close: this Brave Origin build has crashed during both
// CDP Browser.close and normal compositor window close. Listing sessions never
// launches Brave. A failed identity/window check still discards it with
// SIGKILL, drops the state marker, and relaunches on the next command.
function closeNative(identity, args, command, inherit) {
  if (command === "session") return runAgentBrowser([...nativeFlags(identity, null), ...args], { identity, inherit }).status ?? 1;
  const all = args.includes("--all");
  const session = requestedSession(args);
  const result = withNativeBrowser(identity, false, (browser) => {
    const before = sessionList(identity);
    const closing = all ? before : before.includes(session) ? [session] : [];
    for (const name of closing) {
      const flags = [...nativeFlags(identity, browser), "--session", name];
      // Brave's original about:blank stays as its keepalive tab.
      if (browser && pageTabs(identity, flags) > 1) {
        runAgentBrowser([...flags, "tab", "close"], { identity, timeoutMs: 30_000 });
      }
    }
    return runAgentBrowser([...nativeFlags(identity, browser), ...args], { identity, inherit, timeoutMs: 30_000 });
  });
  // Daemons exit a moment after close.
  waitFor(() => (all ? sessionList(identity).length === 0 : !sessionList(identity).includes(session)), 5_000);
  withNativeLock(identity, () => {
    const sessions = sessionList(identity);
    if (!all && !sessions.includes(session)) forgetPinnedTab(identity, session);
    const idle = sessions.length === 0 && !otherLeases(identity);
    if (idle) {
      clearNativeRuntime(identity);
      const browser = liveNativeBrowser(identity);
      if (browser) logNativeLifecycle(identity, "sessions-closed", browser, { method: "detach", clean: true });
    }
  });
  return result.status ?? 1;
}

function requestedSession(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--session") return args[index + 1] || "default";
    if (args[index].startsWith("--session=")) return args[index].slice("--session=".length) || "default";
  }
  return "default";
}

function sessionList(identity) {
  const result = spawnSync(
    "agent-browser",
    ["--config", agentBrowserConfig(), "--namespace", identity.namespace, "--json", "session", "list"],
    { encoding: "utf8", env: agentBrowserEnv(identity), timeout: 15_000 },
  );
  if (result.error?.code === "ENOENT") fail("agent-browser is not installed");
  if (result.error) fail(`agent-browser failed while listing sessions: ${result.error.message}`);
  if (result.status !== 0) fail(`agent-browser could not list sessions: ${firstLine(result.stderr || result.stdout)}`);
  try {
    const sessions = JSON.parse(result.stdout)?.data?.sessions;
    if (!Array.isArray(sessions)) throw new Error();
    return sessions;
  } catch {
    fail("agent-browser returned an invalid session list");
  }
}

function runningSession(identity, args) {
  return sessionList(identity).includes(requestedSession(args));
}

function agentBrowser(identity, args, options = {}) {
  if (identity.backend === "existing") {
    verifyExistingBrowser(identity);
    return runAgentBrowser([...existingFlags(identity), ...args], { ...options, identity });
  }
  if (identity.backend === "native") {
    return withNativeBrowser(identity, true, (browser) => runAgentBrowser([...nativeFlags(identity, browser), ...args], { ...options, identity }));
  }
  // Reapplying --state restarts Agent Browser's Brave between every CLI call.
  // Load it only for a new session so open → snapshot/eval remains one browser.
  const includeState = Boolean(identity.state) && options.includeState !== false && !runningSession(identity, args);
  if (identity.state && options.includeState !== false) applySyncedAgentState(identity, args, includeState);
  return runAgentBrowser([...launchFlags(identity, options.browserArgs, includeState), ...args], options);
}

// Sync is authoritative for an isolated agent browser. Serialize each session's
// update, and leave its tabs alive. Ordinary imported states keep their behavior.
function applySyncedAgentState(identity, args, newSession) {
  let state;
  try { state = JSON.parse(readFileSync(identity.state, "utf8")); } catch { return; }
  if (state.bbCookieSync !== true) return;
  const session = requestedSession(args);
  if (!validName(session)) fail("invalid session name for cookie sync");
  const dir = join(home, "cookie-sync", identity.namespace);
  ensurePrivateDir(dir);
  withLock(join(dir, `${session}.lock`), () => {
    const revision = stateRevision(identity.state);
    const marker = join(dir, `${session}.revision`);
    if (!newSession && existsSync(marker) && readFileSync(marker, "utf8").trim() === revision) return;
    // A new session receives the snapshot at launch; no existing cookies exist.
    if (newSession) return;
    const flags = [...launchFlags(identity, [], false), "--session", session];
    for (const operation of [["cookies", "clear"], ["state", "load", identity.state]]) {
      const result = runAgentBrowser([...flags, ...operation], { identity, timeoutMs: 30000 });
      if (result.status !== 0 || result.error) fail("could not apply live cookie sync; retry before continuing");
    }
    writePrivate(marker, `${revision}\n`);
  }, "cookie sync");
}

function runAgentBrowser(argv, options = {}) {
  const result = spawnSync("agent-browser", argv, {
    encoding: "utf8",
    env: agentBrowserEnv(options.identity),
    stdio: options.inherit ? "inherit" : "pipe",
    timeout: options.timeoutMs,
  });
  if (result.error?.code === "ENOENT") fail("agent-browser is not installed");
  if (result.error) fail(`agent-browser failed: ${result.error.message}`);
  return result;
}

// ------------------------------------------------------------------- state

function normalizeState(raw) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    // JSON.parse quotes the input in its message; that input is the secret.
    fail("the state is not valid JSON");
  }
  const source = Array.isArray(parsed) ? { cookies: parsed, origins: [] } : parsed;
  if (!source || typeof source !== "object") {
    fail("the state must be a JSON object with cookies and origins, or an array of cookies");
  }
  if (source.bbCookieSync === true && !Array.isArray(source.cookies)) fail("a live snapshot needs a cookies array");
  const cookiesIn = source.cookies ?? [];
  const originsIn = source.origins ?? [];
  if (!Array.isArray(cookiesIn) || !Array.isArray(originsIn)) fail("cookies and origins must be arrays");

  const now = Date.now() / 1000;
  let expired = 0;
  const cookies = [];
  cookiesIn.forEach((cookie, index) => {
    if (
      !cookie ||
      typeof cookie !== "object" ||
      typeof cookie.name !== "string" ||
      typeof cookie.value !== "string" ||
      typeof cookie.domain !== "string" ||
      cookie.domain === ""
    ) {
      fail(`cookie ${index} needs a string name, value, and domain`);
    }
    // Playwright and agent-browser use expires; browser cookie exporters use
    // expirationDate and omit it for session cookies.
    const expires =
      typeof cookie.expires === "number"
        ? cookie.expires
        : typeof cookie.expirationDate === "number"
          ? cookie.expirationDate
          : -1;
    const session = cookie.session === true || expires <= 0;
    if (!session && expires < now) {
      expired += 1;
      return;
    }
    const sameSite = SAME_SITE[String(cookie.sameSite ?? "").toLowerCase()];
    cookies.push({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: typeof cookie.path === "string" && cookie.path ? cookie.path : "/",
      expires: session ? -1 : expires,
      httpOnly: cookie.httpOnly === true,
      secure: cookie.secure === true,
      ...(sameSite ? { sameSite } : {}),
    });
  });

  const origins = originsIn.map((entry, index) => {
    let url;
    try {
      url = new URL(entry?.origin);
    } catch {
      fail(`origin ${index} is not a URL`);
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== entry.origin) {
      fail(`origin ${index} must be a bare http or https origin`);
    }
    const storage = entry.localStorage ?? [];
    if (
      !Array.isArray(storage) ||
      storage.some((item) => typeof item?.name !== "string" || typeof item?.value !== "string")
    ) {
      fail(`origin ${index} localStorage must be a list of string name/value pairs`);
    }
    return { origin: url.origin, localStorage: storage.map(({ name, value }) => ({ name, value })) };
  });

  if (source.bbCookieSync !== true && cookies.length === 0 && origins.length === 0) {
    fail(expired > 0 ? "every cookie in the state has expired; export a fresh one" : "the state has no cookies or origins");
  }
  return { state: { cookies, origins, ...(source.bbCookieSync === true ? { bbCookieSync: true } : {}) }, summary: { cookies: cookies.length, expired, origins: origins.length } };
}

function describeImport(name, summary) {
  let text = `state "${name}": ${summary.cookies} cookies`;
  text += `, ${summary.origins} origins`;
  if (summary.expired > 0) text += `; dropped ${summary.expired} expired cookies`;
  return text;
}

function importState(name, raw) {
  if (!validName(name)) fail(`invalid state name "${name}"`);
  const { state, summary } = normalizeState(raw);
  writePrivate(statePath(name), `${JSON.stringify(state)}\n`);
  // A default imported by hand is the user's; provision must not remove it.
  if (name === "default") rmSync(provisionedStatePath, { force: true });
  return describeImport(name, summary);
}

function readInput(source) {
  if (!source || source === "-") return readFileSync(0, "utf8");
  try {
    return readFileSync(source, "utf8");
  } catch (error) {
    fail(`cannot read ${source}: ${error.code ?? error.message}`);
  }
}

function stateCommand(argv) {
  const [action, name, source] = argv;
  switch (action) {
    case "sync":
    case "import": {
      if (action === "sync") {
        let parsed;
        try { parsed = JSON.parse(readInput(source)); } catch { fail("the state is not valid JSON"); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("sync requires a cookies/origins object");
        parsed.bbCookieSync = true;
        console.log(`synced ${importState(name, JSON.stringify(parsed))}`);
        return 0;
      }
      if (!name) fail("usage: bb-browser state import <name> [file|-]");
      console.log(`imported ${importState(name, readInput(source))}`);
      if (source && source !== "-") console.log(`${source} still holds the secrets; delete it once you no longer need it`);
      return 0;
    }
    case "save": {
      if (!validName(name)) fail("usage: bb-browser state save <name> [--session <s>] [--state-name <n>]");
      ensurePrivateDir(home);
      ensurePrivateDir(stateDir);
      const temporary = join(stateDir, `.${name}.${process.pid}.save`);
      // Target the same namespace and session the browser was driven in.
      const { rest, stateName, command } = splitArgs(argv.slice(2));
      if (command !== undefined) fail("usage: bb-browser state save <name> [--session <s>] [--state-name <n>]");
      const identity = verifiedIdentity(stateName);
      if (identity.backend === "native" || identity.backend === "existing") {
        fail(`state save is refused on the ${identity.backend} backend: its sign-ins stay in its profile and are never exported`);
      }
      try {
        const result = agentBrowser(identity, [...rest, "state", "save", temporary]);
        if (result.status !== 0) fail(`agent-browser could not save the state: ${firstLine(result.stderr)}`);
        console.log(`saved ${importState(name, readFileSync(temporary, "utf8"))}`);
      } finally {
        rmSync(temporary, { force: true });
      }
      return 0;
    }
    case "list": {
      const names = existsSync(stateDir)
        ? readdirSync(stateDir).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5))
        : [];
      if (names.length === 0) console.log("no imported states");
      for (const entry of names.sort()) {
        const path = statePath(entry);
        let counts = "unreadable";
        try {
          const parsed = JSON.parse(readFileSync(path, "utf8"));
          counts = `${parsed.cookies?.length ?? 0} cookies, ${parsed.origins?.length ?? 0} origins`;
        } catch {}
        console.log(`${entry}\t${counts}\tupdated ${statSync(path).mtime.toISOString()}`);
      }
      return 0;
    }
    case "rm": {
      if (!validName(name)) fail("usage: bb-browser state rm <name>");
      if (!existsSync(statePath(name))) fail(`no imported state named "${name}"`);
      rmSync(statePath(name));
      console.log(`removed state "${name}"`);
      return 0;
    }
    default:
      fail("usage: bb-browser state import|sync|save|list|rm");
  }
}

// --------------------------------------------------------------- provision

// The sandboxes plugin pipes its browser settings here on stdin, so no value
// ever reaches argv, the environment, or a log. Absent keys are left alone;
// empty strings clear the setting. Each valid setting is applied even when
// another is not, so a bad value cannot keep an old identity in place. Any
// failure is recorded, and bb-browser refuses to launch until a provision
// succeeds.
const PROVISIONED = [
  { key: "userAgent", file: "user-agent", label: "user agent", valid: validUserAgent },
  { key: "exitNode", file: "exit-node", label: "exit node", valid: validExitNode },
  { key: "homeEgressIp", file: "home-egress-ip", label: "home egress IP", valid: validIpList },
  { key: "egress", file: "egress", label: "egress", valid: validEgress },
  {
    key: "tailscaleUserspace",
    file: "tailscale-userspace",
    label: "Tailscale userspace mode",
    valid: (value) => value === "1",
  },
  { key: "tailscaleAuthKey", file: "tailscale-authkey", label: "Tailscale auth key", valid: validAuthKey },
  {key:'networkService',file:'network-service',label:'host network service',valid:value=>value==='sandboxes-v1'},
  { key: "requiredState", file: "required-state", label: "required state", valid: validName },
];

function provision(raw) {
  const errors = [];
  const done = [];
  let input = null;
  try {
    input = JSON.parse(raw);
  } catch {
    errors.push("provision input is not valid JSON");
  }
  if (errors.length === 0 && (!input || typeof input !== "object" || Array.isArray(input))) {
    errors.push("provision input must be a JSON object");
    input = null;
  }

  for (const field of input ? PROVISIONED : []) {
    const value = input[field.key];
    if (value === undefined) continue;
    if (value === null || value === "") {
      rmSync(join(home, field.file), { force: true });
      done.push(`${field.label} cleared`);
    } else if (typeof value !== "string" || !field.valid(value)) {
      // Never keep the previous value: it is not what was configured.
      rmSync(join(home, field.file), { force: true });
      errors.push(`invalid ${field.label}`);
    } else {
      writePrivate(join(home, field.file), value);
      done.push(`${field.label} set`);
    }
  }

  // state is the content for the default state. null means none was sent: the
  // setting is empty or the file could not be read on the bb server. Either
  // way an earlier provisioned default must not keep being used.
  let stateError = null;
  if (input && input.state !== undefined) {
    const dropDefault = () => {
      if (existsSync(provisionedStatePath) || input.requiredState === "default") {
        rmSync(statePath("default"), { force: true });
        rmSync(provisionedStatePath, { force: true });
        return true;
      }
      return false;
    };
    if (input.state === null) {
      if (dropDefault()) done.push('state "default" removed');
    } else {
      try {
        const state = normalizeState(input.state);
        writePrivate(statePath("default"), `${JSON.stringify(state.state)}\n`);
        writePrivate(provisionedStatePath, "default\n");
        done.push(`imported ${describeImport("default", state.summary)}`);
      } catch (error) {
        if (!(error instanceof BrowserError)) throw error;
        dropDefault();
        stateError = `state not imported: ${error.message}`;
      }
    }
  }

  if (errors.length > 0) writePrivate(provisionErrorPath, `${errors.join("; ")}\n`);
  else rmSync(provisionErrorPath, { force: true });
  console.log(`bb-browser provisioned: ${done.length > 0 ? done.join("; ") : "nothing to change"}`);
  // A state that did not import blocks only the default state, through
  // required-state, so --state-name none still works.
  const failures = [...errors, ...(stateError ? [stateError] : [])];
  if (failures.length > 0) fail(failures.join("; "));
  return 0;
}

// ------------------------------------------------------------------ doctor

function evalResult(output) {
  try {
    const parsed = JSON.parse(output);
    return parsed?.data?.result ?? parsed?.result ?? parsed;
  } catch {
    return firstLine(output);
  }
}

function liveCheck(identity) {
  const session = ["--session", "bb-browser-doctor"];
  const run = (args) => {
    const result = agentBrowser(identity, [...session, ...args], { timeoutMs: 90_000 });
    if (result.status !== 0) fail(`agent-browser ${args[0]} failed: ${firstLine(result.stderr || result.stdout)}`);
    return result.stdout;
  };
  try {
    run(["open", "about:blank"]);
    const actual = evalResult(run(["--json", "eval", "navigator.userAgent"]));
    // The native backend never overrides the user agent; a configured one is
    // what its own Brave must report.
    const wantedUserAgent = identity.userAgent || identity.expectedUserAgent;
    if (wantedUserAgent && actual !== wantedUserAgent) {
      fail(`Brave reported a different user agent than the one configured: ${actual}`);
    }
    let detail = wantedUserAgent ? "navigator.userAgent matches exactly" : `navigator.userAgent is ${actual}`;
    if (identity.backend === "native") {
      if (/HeadlessChrome/.test(String(actual))) fail(`the native browser reports a headless user agent: ${actual}`);
      if (evalResult(run(["--json", "eval", "navigator.webdriver"])) !== false) {
        fail("the native browser reports navigator.webdriver as true");
      }
      detail += "; navigator.webdriver is false";
      const browser = liveNativeBrowser(identity);
      if (!browser) fail("the native browser stopped during the live check");
      if (checkNativeWindows(browser) === 0) fail(`the native browser has no ${identity.windowClass} window`);
      detail += `; its ${identity.windowClass} window is verified; new windows use workspace ${nativeWorkspace()}`;
      if (identity.state) {
        if (!nativeStateCurrent(identity)) fail("the trusted state is not loaded into the native profile at its current revision");
        detail += "; the trusted state is loaded at its current revision";
      }
    }
    const expected = parseIps(setting("BB_BROWSER_HOME_EGRESS_IP", "home-egress-ip"));
    if (identity.egress && expected.length > 0) {
      run(["open", ipEchoUrl]);
      const echoHost = new URL(ipEchoUrl).hostname;
      const actualHost = String(evalResult(run(["--json", "eval", "location.hostname"]))).trim();
      if (actualHost !== echoHost) fail(`agent-browser eval is not attached to the navigated ${echoHost} page`);
      const seen = String(evalResult(run(["--json", "eval", "document.body.innerText.trim()"]))).trim();
      if (!seen) fail(`the browser itself returned an empty public IP from ${ipEchoUrl}`);
      if (!expected.includes(seen)) fail(`the browser itself reached ${ipEchoUrl} from ${seen}, not the home egress IP`);
      detail += "; the browser's public IP matches home";
    }
    return detail;
  } finally {
    if (identity.backend === "existing") closeExisting(identity, [...session, "close"], "close", false);
    else if (identity.backend === "native") closeNative(identity, [...session, "close"], "close", false);
    else agentBrowser(identity, [...session, "close"], { timeoutMs: 30_000, includeState: false });
  }
}

function doctor(argv) {
  const json = argv.includes("--json");
  const live = !argv.includes("--offline");
  const checks = [];
  const record = (name, check) => {
    try {
      checks.push({ name, ok: true, detail: check() });
    } catch (error) {
      if (!(error instanceof BrowserError)) throw error;
      checks.push({ name, ok: false, detail: error.message });
    }
  };

  let brave;
  record("brave", () => {
    brave = resolveBrave();
    return `${brave.version} at ${brave.path}`;
  });
  record("agent-browser", () => {
    const result = spawnSync("agent-browser", ["--version"], { encoding: "utf8", env: agentBrowserEnv() });
    if (result.error || result.status !== 0) fail("agent-browser is not installed");
    return firstLine(result.stdout);
  });
  record("settings", () => {
    const problem = provisionProblem();
    if (problem) fail(`the last provision did not apply: ${problem}`);
    return "the last provision applied every setting";
  });
  let planned;
  record("backend", () => {
    if (selectedBackend() === "existing") return "existing: attach to regular Brave; session close detaches without stopping it";
    if (selectedBackend() === "agent") {
      const configured = setting("BB_BROWSER_BACKEND", "backend").trim();
      const nativePossible = !configured && !usesUserspaceTailscale() && hyprlandSession();
      return "agent: agent-browser launches Brave with the identity below" +
        (nativePossible ? " (a configured user agent or state keeps the native backend off; BB_BROWSER_BACKEND=native chooses it)" : "");
    }
    return "native: bb-browser launches one persistent Brave on a dedicated profile and attaches over loopback CDP; " +
      `a Hyprland rule keeps its window on ${nativeWorkspace()} and unfocused; session close detaches without terminating Brave`;
  });
  record("identity", () => {
    planned = plannedIdentity();
    if (planned.backend === "existing") {
      verifyExistingBrowser(planned);
      return `regular profile ${planned.profile} on verified loopback port ${planned.port}`;
    }
    if (planned.backend === "native") {
      return `profile ${planned.profile} with Brave's own user agent and client hints` +
        (planned.expectedUserAgent ? "; the configured user agent is checked, never applied" : "");
    }
    return planned.userAgent ? "exact user agent configured" : "no user agent configured; Brave's default is used";
  });
  let egress = null;
  if (planned) {
    record("egress", () => {
      if (planned.mode === "direct") return "direct: traffic leaves from this machine (explicitly configured)";
      egress = homeEgress(planned.exitNode);
      return `home through exit node ${egress.exitNode}${egress.proxy ? ` via ${egress.proxy}` : ""}; ${egress.verified}`;
    });
    record("state", () => {
      if (planned.backend === "existing") return "regular Brave keeps its own sign-ins; no state is imported";
      if (planned.backend === "native") {
        if (!planned.state) return "no trusted state; the native profile keeps its own sign-ins";
        // The live check loads a changed state and then requires it current.
        return nativeStateCurrent(planned)
          ? `${planned.state} is loaded into the native profile at its current revision`
          : `${planned.state} changed since it was last loaded, or never was; the next command loads it`;
      }
      return planned.state ? `using ${planned.state}` : "no imported state; the browser starts signed out";
    });
  }
  if (live && checks.every((check) => check.ok)) {
    record("live", () => liveCheck({ ...planned, brave, egress }));
  }

  if (json) {
    console.log(JSON.stringify({ ok: checks.every((check) => check.ok), checks }, null, 2));
  } else {
    for (const check of checks) console.log(`${check.ok ? "ok  " : "FAIL"}  ${check.name.padEnd(14)} ${check.detail}`);
    if (!live) console.log("skipped live browser check (--offline)");
  }
  return checks.every((check) => check.ok) ? 0 : 1;
}

// ------------------------------------------------------------- passthrough

function checkBrowserArgs(value, browserArgs) {
  for (const item of value.split(/[,\n]/).map((part) => part.trim()).filter(Boolean)) {
    // Chromium on POSIX takes both "--switch" and "-switch".
    const name = /^-{1,2}([a-zA-Z0-9-]+)(?:=|$)/.exec(item)?.[1]?.toLowerCase();
    if (name === undefined) {
      // A part without a dash continues the previous one, as in --window-size=800,600.
      if (item.startsWith("-") || browserArgs.length === 0) {
        fail(`browser argument ${item.split("=")[0]} is not one bb-browser allows`);
      }
    } else if (!ALLOWED_BROWSER_ARGS.has(name)) {
      fail(`browser argument ${item.split("=")[0]} is not one bb-browser allows; it could bypass the trusted identity`);
    }
    browserArgs.push(item);
  }
}

// Headers must not replace the user agent or its client hints.
function checkHeaders(value) {
  let headers;
  try {
    headers = JSON.parse(value);
  } catch {
    fail("headers must be a JSON object");
  }
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) fail("headers must be a JSON object");
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (lower === "user-agent" || lower.startsWith("sec-ch-ua")) {
      fail(`header ${key} is set by bb-browser from the trusted identity and cannot be overridden`);
    }
  }
}

function checkCommand(command, args, flags) {
  if (command === undefined) return;
  if (!ALLOWED_COMMANDS.has(command)) {
    fail(`agent-browser ${command} is not available through bb-browser; it could bypass the trusted Brave`);
  }
  if (command === "read" && (args.length > 0 || flags.some((flag) => READ_FETCH_FLAGS.has(flag)))) {
    fail(
      "bb-browser read only reads the open tab: with a URL, --llms, --require-md, or --raw agent-browser fetches " +
        "outside Brave, from this machine's IP. Run bb-browser open <url>, then bb-browser read",
    );
  }
  if (command === "set") {
    const [what, value] = args;
    if (!ALLOWED_SET.has(what)) fail(`agent-browser set ${what ?? ""} is not available through bb-browser`.trim());
    if (what === "headers") checkHeaders(value ?? "");
  }
}

function splitArgs(argv) {
  const rest = [];
  const browserArgs = [];
  const flags = [];
  const positionals = [];
  let stateName;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    const value = () => {
      const next = equals > 0 ? arg.slice(equals + 1) : argv[++index];
      if (next === undefined) fail(`${flag} needs a value`);
      return next;
    };
    if (FORBIDDEN_FLAGS.has(flag)) fail(`${flag} is set by bb-browser from the trusted identity and cannot be overridden`);
    if (flag === "--state-name") {
      stateName = value();
      continue;
    }
    if (flag === "--args") {
      checkBrowserArgs(value(), browserArgs);
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      rest.push(arg);
      continue;
    }
    flags.push(flag);
    rest.push(arg);
    if (VALUE_FLAGS.has(flag)) {
      const given = value();
      if (equals < 0) rest.push(given);
      if (flag === "--headers") checkHeaders(given);
    } else if (equals < 0 && (argv[index + 1] === "true" || argv[index + 1] === "false")) {
      // Boolean flags take an optional true/false.
      rest.push(argv[++index]);
    }
  }
  const [command, ...args] = positionals;
  checkCommand(command, args, flags);
  return { rest, browserArgs, stateName, command, args, flags };
}

// The native profile is one persistent Brave profile that every session
// shares, including its sign-ins. Commands that would wipe or export them, or
// bind credentials to it, are refused; --idle-timeout would let agent-browser
// shut down on its own while a lease still holds the browser.
function checkNativeCommand(command, args, flags, backend = "native") {
  if (flags.includes("--idle-timeout")) fail("--idle-timeout does not apply to the native backend; bb-browser close stops it");
  const refused =
    (command === "cookies" && args[0] === "clear") ||
    (command === "storage" && args[1] === "clear") ||
    (command === "set" && args[0] === "credentials");
  if (refused) {
    fail(
      `agent-browser ${command} ${command === "storage" ? `${args[0]} clear` : args[0]} is refused on the ${backend} backend: ` +
        "its profile and sign-ins persist and are shared by every session",
    );
  }
}

// A BB thread owns one window. Sessions and tabs stay inside it. Legacy CLI
// calls without BB_THREAD_ID keep their previous explicit-session behavior.
function threadOwner() {
  const value = env.BB_THREAD_ID || "";
  if (value && !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail("invalid BB_THREAD_ID");
  return value;
}
function threadPrefix() { return `t${createHash("sha256").update(threadOwner()).digest("hex").slice(0, 14)}-`; }
function threadLabel(refresh = false) {
  const file = join(threadDir(), `${threadOwner()}.label`);
  let label = "";
  try {
    label = readFileSync(file, "utf8").trim();
    if (!refresh && (existsSync(`${file}.manual`) || Date.now() - statSync(file).mtimeMs < 60_000)) return label || threadOwner();
  } catch {}
  // BB already supplies the authenticated CLI on the browser host. Query only
  // this thread's metadata; no page or chat content is read or exported.
  const result = spawnSync("bb", ["thread", "show", threadOwner(), "--json"], {encoding:"utf8", timeout:2000, maxBuffer:256 * 1024});
  try {
    const thread = JSON.parse(result.stdout).thread;
    label = thread.title || thread.titleFallback || label;
  } catch {}
  label = String(label || threadOwner()).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0,120);
  writePrivate(file, label + "\n");
  return label;
}
function threadDir() { const dir = join(home, "threads"); ensurePrivateDir(dir); return dir; }
function threadHoldPath() { return join(threadDir(), `${threadOwner()}.hold`); }
function anyThreadHandoff() { return readdirSync(threadDir()).some(name => name.endsWith(".hold")); }
function scopedThreadArgs(args) {
  const name = requestedSession(args);
  if (!validName(name)) fail("invalid browser session name");
  const filtered = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session") { i++; continue; }
    if (args[i].startsWith("--session=")) continue;
    filtered.push(args[i]);
  }
  return ["--session", threadPrefix() + createHash("sha256").update(name).digest("hex").slice(0, 8), ...filtered];
}
function threadRecordPath(identity) { return join(threadDir(), `${threadOwner()}-${identity.namespace}.json`); }
function readThreadRecord(identity) {
  try { return JSON.parse(readFileSync(threadRecordPath(identity), "utf8")); } catch { return null; }
}
function withThreadLock(identity, action) {
  return withLock(join(threadDir(), `${threadOwner()}-${identity.namespace}.lock`), action, "this thread's browser", 600_000);
}
// Internal window ownership, cookie sync, and chat labels. Page scripts only
// open an owned tab or label its title; no page content is exported. Browser
// identity is checked first.
const THREAD_CDP = String.raw`
const fs = require('node:fs');
let step = 'connect';
(async () => {
 const input = JSON.parse(fs.readFileSync(0, 'utf8'));
 const version = await (await fetch('http://127.0.0.1:' + input.port + '/json/version')).json();
 const url = new URL(version.webSocketDebuggerUrl);
 if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || Number(url.port) !== input.port) throw Error('nonlocal debugger');
 const ws = new WebSocket(url);
 await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
 let id = 0; const pending = new Map(); let changed = () => {};
 ws.onmessage = event => { const data = JSON.parse(event.data); const p = pending.get(data.id); if (p) { pending.delete(data.id); clearTimeout(p.timer); data.error ? p.reject(Error(data.error.message)) : p.resolve(data.result); } else if (data.method === 'Page.screencastFrame') void call('Page.screencastFrameAck', {sessionId:data.params.sessionId}, data.sessionId).catch(() => {}); };
 const call = (method, params = {}, sessionId, timeoutMs = 15000) => new Promise((resolve, reject) => { step = method; const n = ++id; const timer = setTimeout(() => { pending.delete(n); reject(Error(method + ' deadline')); }, timeoutMs); pending.set(n, {resolve, reject, timer}); ws.send(JSON.stringify({id:n, method, params, ...(sessionId ? {sessionId} : {})})); });
 const detach = async sessionId => {
   const operation = step;
   try { await call('Target.detachFromTarget', {sessionId}); }
   catch (error) { if (!/session.*not found|no session|target.*closed/i.test(error.message)) throw error; }
   finally { step = operation; }
 };
 if (input.op === 'syncCookies') {
   const current = (await call('Storage.getCookies')).cookies;
   const key = cookie => JSON.stringify([cookie.name, cookie.domain, cookie.path || '/', cookie.partitionKey || null]);
   // A changed local cookie belongs to the agent login. Source sync must not replace it.
   const equal = (a,b) => !!a && !!b && a.value === b.value && !!a.secure === !!b.secure && !!a.httpOnly === !!b.httpOnly && (a.sameSite || "") === (b.sameSite || "");
   const live = new Map(current.map(cookie => [key(cookie), cookie]));
   const prior = new Map(input.previous.map(cookie => [key(cookie), cookie]));
   const source = new Map(input.cookies.map(cookie => [key(cookie), cookie]));
   for (const [id, cookie] of prior) {
     if (!source.has(id) && equal(live.get(id), cookie)) {
       await call('Storage.setCookies', {cookies:[{...cookie, value:'', path:cookie.path || '/', expires:1}]});
     }
   }
   const cookies = input.cookies.filter(cookie => {
     const id = key(cookie), existing = live.get(id), previous = prior.get(id);
     return (!existing && !previous) || equal(existing, previous);
   }).map(cookie => {
     const {expires, ...rest} = cookie;
     return {...rest, ...(expires > 0 ? {expires} : {})};
   });
   if (cookies.length) await call('Storage.setCookies', {cookies});
 }
 if (input.op === 'syncCookies' || input.op === 'closeHelper') {
   if (input.cleanupTargetId) {
     const pages = (await call('Target.getTargets')).targetInfos.filter(t => t.type === 'page');
     const helper = pages.find(t => t.targetId === input.cleanupTargetId && t.url === 'about:blank');
     if (pages.length > 1 && helper) await call('Target.closeTarget', {targetId:helper.targetId});
   }
   ws.close(); process.stdout.write('{}'); return;
 }
 const targets = (await call('Target.getTargets')).targetInfos.filter(t => t.type === 'page');
 let record = input.record;
 if (record?.browserKey !== url.pathname) record = null;
 const owned = [];
 if (record) {
   for (const target of targets) {
     if(!(record.tabOrder || Object.values(record.sessions || {})).includes(target.targetId)) continue;
     try { if ((await call('Browser.getWindowForTarget', {targetId:target.targetId})).windowId === record.windowId) owned.push(target); } catch {}
   }
   // OAuth popups belong to the thread that opened them, even in a new window.
   const known = new Set(owned.map(t => t.targetId));
   for (let i = 0; i < targets.length; i++) for (const t of targets) if (known.has(t.openerId) && !known.has(t.targetId)) { known.add(t.targetId); owned.push(t); }
 }
 const order = record?.tabOrder || [];
 owned.sort((a, b) => {
   const ai = order.indexOf(a.targetId), bi = order.indexOf(b.targetId);
   return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi) || a.targetId.localeCompare(b.targetId);
 });
 if (input.op === 'group') {
   const findWorkers = async () => (await call('Target.getTargets')).targetInfos.filter(t => t.type === 'service_worker' && t.url.startsWith(input.extensionOrigin + '/'));
   let workers = await findWorkers();
   // MV3 suspends idle extension workers; absence from targets is not absence of the extension.
   if (!workers.length && owned.length) {
     const page = (await call('Target.attachToTarget', {targetId:owned[0].targetId, flatten:true})).sessionId;
     try {
       await call('ServiceWorker.enable', {}, page);
       await call('ServiceWorker.startWorker', {scopeURL:input.extensionOrigin + '/'}, page);
       for (let attempt = 0; attempt < 10 && !workers.length; attempt++) {
         workers = await findWorkers();
         if (!workers.length) await new Promise(resolve => setTimeout(resolve, 50));
       }
     } catch {} finally { await detach(page); }
   }
   if (!workers.length) { step = '[NATIVE_GROUP_EXTENSION_REQUIRED] install or enable BB Browser extension in the managed profile'; throw Error('extension unavailable'); }
   const session = (await call('Target.attachToTarget', {targetId:workers[0].targetId, flatten:true})).sessionId;
   try {
     // An MV3 target can appear before its module has installed the grouping helper.
     const deadline = Date.now() + 2000;
     let ready = false;
     try {
       while (Date.now() < deadline) {
         const probe = await call('Runtime.evaluate', {expression:'typeof globalThis.__bbGroupTargets', returnByValue:true}, session, deadline - Date.now());
         if (probe.exceptionDetails) throw Error('helper readiness failed');
         if (probe.result?.value === 'function') { ready = true; break; }
         await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
       }
       if (!ready) throw Error('helper readiness deadline');
     } catch {
       step = '[NATIVE_GROUP_NOT_READY] BB Browser grouping helper did not become ready within 2000ms';
       throw Error('helper readiness deadline');
     }
     const result = await call('Runtime.evaluate', {expression:'globalThis.__bbGroupTargets(' + JSON.stringify(owned.map(t => t.targetId)) + ',' + JSON.stringify(input.label) + ')', awaitPromise:true, returnByValue:true}, session);
     if (result.exceptionDetails) { const detail = result.exceptionDetails.exception?.description || ''; step = 'Native grouping failed: ' + detail.split('\n')[0].replace(/https?:\/\/\S+/g, '[url]').slice(0,180); throw Error('Native grouping failed'); }
   }
   finally { await detach(session); }
   ws.close(); process.stdout.write('{}'); return;
 }
 if (input.op === 'page') {
   if (!owned.some(t => t.targetId === input.targetId)) throw Error('Target does not belong to this thread');
   const session = (await call('Target.attachToTarget', {targetId:input.targetId, flatten:true})).sessionId;
   try {
     const {pageOperation} = await import(input.operations); const output = await pageOperation((method, params) => call(method, params, session), input.argv,{dialog:input.dialog||null});
     if(input.argv[0]==='viewer'&&JSON.parse(input.argv[1]).type==='frame')Object.assign(output,{tabs:owned.map(t=>({id:t.targetId,title:t.title,url:t.url})),current:input.targetId,dialog:input.dialog||null});
     process.stdout.write(JSON.stringify(output));
   }
   finally { await detach(session); ws.close(); }
   return;
 }
 let output = {};
 if (input.op === 'ensure' || input.op === 'new') {
   if (!owned.length) record = null;
   let targetId = record?.sessions?.[input.session];
   if (input.op === 'new' || !owned.some(t => t.targetId === targetId)) {
     targetId = undefined;
     if (record) {
       // Target.createTarget's windowId is ignored by some Brave versions.
       // Opening from an owned page preserves its window even when a different
       // thread's window was most recently active in Chromium.
       const anchor = owned.find(t => !t.openerId) || owned[0];
       const attached = await call('Target.attachToTarget', {targetId:anchor.targetId, flatten:true});
       try {
         const opened = await call('Runtime.evaluate', {expression:"window.open('about:blank', '_blank'); undefined", userGesture:true}, attached.sessionId);
         if (opened.exceptionDetails) throw Error('could not open owned tab');
       } finally { await detach(attached.sessionId); }
       const previous = new Set(targets.map(t => t.targetId));
       for (let i = 0; i < 50 && !targetId; i++) {
         const created = (await call('Target.getTargets')).targetInfos.filter(t => t.type === 'page' && !previous.has(t.targetId) && t.openerId === anchor.targetId);
         if (created.length === 1) targetId = created[0].targetId;
         else await new Promise(resolve => setTimeout(resolve, 20));
       }
       if (!targetId) { step = 'open owned tab'; throw Error('no owned tab'); }
     } else targetId = (await call('Target.createTarget', {url:'about:blank', newWindow:true, background:true})).targetId;
     const window = await call('Browser.getWindowForTarget', {targetId});
     if (record && window.windowId !== record.windowId) { await call('Target.closeTarget', {targetId}); step = 'owned-window mismatch'; throw Error('browser cannot create tabs in the owned window'); }
     record = {...record, windowId:window.windowId, sessions:{...record?.sessions, [input.session]:targetId}};
   }
   record.browserKey = url.pathname;
   record.lastSession = input.session;
   record.tabOrder = [...new Set([...owned.map(t => t.targetId), targetId])];
   output = {record, targetId};
 } else if (input.op === 'list') {
   output = {tabs:owned.map((t, index) => ({index, targetId:t.targetId, url:t.url, title:t.title}))};
 } else if (input.op === 'show') {
   if (!owned.length) throw Error('thread window is no longer open');
   output = {ok:true}; // Attention requests never activate a desktop window.
 } else if (input.op === 'close') {
   for (const target of [...owned].reverse()) { try { await call('Target.closeTarget', {targetId:target.targetId}); } catch {} }
   const ids = new Set(owned.map(t => t.targetId));
   let remaining = true;
   for (let i=0; i<100; i++) {
     remaining = (await call('Target.getTargets')).targetInfos.some(t => ids.has(t.targetId));
     if (!remaining) break;
     await new Promise(resolve => setTimeout(resolve, 50));
   }
   if (remaining) { step = 'close owned tabs'; throw Error('owned tabs remain open'); }
 } else if (input.op === 'closeTab') {
   if (!owned.some(t => t.targetId === input.targetId)) throw Error('tab does not belong to this thread');
   await call('Target.closeTarget', {targetId:input.targetId});
 }
 ws.close(); process.stdout.write(JSON.stringify(output));
})().catch(error => { process.stderr.write('Browser window operation failed: ' + step + (/deadline/.test(error.message) ? ' (deadline)' : '')); process.exit(1); });
`;
function threadCdp(identity, browser, op, extra = {}) {
  const result = spawnSync(nodeRuntime(), ["-e", THREAD_CDP], {
    input: JSON.stringify({ port: browser.port, op, record: readThreadRecord(identity), ...extra }),
    encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) fail(`could not manage this thread's browser window (${firstLine(result.stderr) || "timed out"}); no other window was selected`);
  try { return JSON.parse(result.stdout); } catch { fail("invalid browser window response"); }
}
function ensureNativeGroup(identity, browser) {
  const path = join(threadDir(), `${identity.namespace}.title-worker`);
  try { const worker = JSON.parse(readFileSync(path, "utf8")); if (sameProcess(worker.pid, worker.start)) process.kill(worker.pid, "SIGTERM"); rmSync(path, {force:true}); } catch {}
  const manifest = JSON.parse(readFileSync(join(runtimeDirectory, "../browser-extension/manifest.json"), "utf8"));
  const id = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0,32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
  threadCdp(identity, browser, "group", {label:threadLabel(), extensionOrigin:`chrome-extension://${id}`});
}
function nativeEventsDirectory(identity) { return join(home, 'events', `${threadOwner()}-${identity.namespace}`); }
function ensureNativeEvents(identity, browser) {
  const record = readThreadRecord(identity); if(!record)return;
  const directory=nativeEventsDirectory(identity);ensurePrivateDir(directory);
  const holder=identity.backend === 'native' ? browser : profileHolder(identity.profile);
  if(!holder?.pid)fail('Cannot identify browser event owner');
  const session={pid:holder.pid,start:processStart(holder.pid),port:browser.port,session:record.browserKey,native:true,ownerRecord:threadRecordPath(identity),targetIds:record.tabOrder||Object.values(record.sessions),lastUsed:Date.now()};
  writePrivate(join(directory,'session.json'),JSON.stringify(session));
  try{const worker=JSON.parse(readFileSync(join(directory,'worker.json'),'utf8'));if(worker.session===session.session&&sameProcess(worker.pid,worker.start))return;}catch{}
  const child=spawn(nodeRuntime(),[join(runtimeDirectory,'session-events.mjs'),directory,home,threadOwner()],{detached:true,stdio:'ignore'});child.on('error',()=>{});child.unref();
  writePrivate(join(directory,'worker.json'),JSON.stringify({pid:child.pid,start:processStart(child.pid),session:session.session}));
}
function nativeDialog(identity,args) {
  const directory=nativeEventsDirectory(identity);let dialog=null;try{dialog=JSON.parse(readFileSync(join(directory,'dialog.json'),'utf8'));}catch{}
  if(!args[0]||args[0]==='inspect'){console.log(JSON.stringify({pending:dialog}));return 0;}
  if(!dialog||!['accept','dismiss'].includes(args[0]))fail('No pending dialog or unsupported dialog decision');
  const id=`${process.pid}-${Date.now()}`;writePrivate(join(directory,'dialog-request.json'),JSON.stringify({id,accept:args[0]==='accept',promptText:args[1]||''}));
  const result=waitFor(()=>{try{const r=JSON.parse(readFileSync(join(directory,'dialog-result.json'),'utf8'));return r.id===id?r:null;}catch{return null;}},15000);
  if(!result?.ok)fail(result?.error||'Dialog decision deadline; inspect before retrying');
  console.log(JSON.stringify({handled:true}));return 0;
}
function pinThreadTarget(identity, session, targetId) {
  const dir = join(identity.runtime, "namespaces", identity.namespace, "run");
  ensurePrivateDir(dir);
  writePrivate(join(dir, `${session}.target`), JSON.stringify({ targetId, url: "about:blank", pinned: true }));
}
function ensureThreadTab(identity, browser, session) {
  return withLock(join(threadDir(), `${identity.namespace}.windows.lock`), () => ensureThreadTabLocked(identity, browser, session), "browser window creation", 60_000);
}
function ensureThreadTabLocked(identity, browser, session) {
  const prior = readThreadRecord(identity);
  const before = identity.backend === "native" ? new Set(nativeWindows(browser).map(window => window.address)) : null;
  const result = threadCdp(identity, browser, "ensure", { session });
  if (before && (prior?.browserKey !== result.record.browserKey || prior?.windowId !== result.record.windowId)) {
    let address;
    waitFor(() => {
      const created = nativeWindows(browser).filter(window => !before.has(window.address));
      if (created.length === 1 && /^0x[0-9a-f]+$/i.test(created[0].address)) { address = created[0].address; return true; }
      return false;
    }, 5000);
    result.record.windowAddress = address || null;
  }
  writePrivate(threadRecordPath(identity), JSON.stringify({ ...result.record, backend: identity.backend, label:threadLabel() }));
  const flags = [...(identity.backend === "native" ? nativeFlags(identity, browser) : existingFlags(identity)), "--session", session];
  if (!sessionList(identity).includes(session)) pinThreadTarget(identity, session, result.targetId);
  // Select the validated owned target through the supported daemon command.
  // Rewriting its binding file while a daemon exits races its final save.
  if (runAgentBrowser([...flags, "tab", result.targetId], {identity, timeoutMs:30_000}).status !== 0) fail("could not bind this session to its owned browser tab");
  ensureNativeGroup(identity, browser);
  ensureNativeEvents(identity,browser);
}
function threadTabCommand(identity, browser, session, args) {
  const op = args[0] || "list";
  const flags = [...(identity.backend === "native" ? nativeFlags(identity, browser) : existingFlags(identity)), "--session", session];
  const tabs = threadCdp(identity, browser, "list").tabs;
  if (op === "list") { console.log(JSON.stringify({ success: true, data: { tabs } })); return 0; }
  const record = readThreadRecord(identity);
  let targetId;
  if (op === "new") {
    const result = threadCdp(identity, browser, "new", { session });
    writePrivate(threadRecordPath(identity), JSON.stringify({...result.record, backend:identity.backend}));
    targetId = result.targetId;
  } else if (op === "switch" || /^\d+$/.test(op)) {
    const selected = tabs[Number(op === "switch" ? args[1] : op)];
    if (!selected) fail("no such tab in this thread's window");
    targetId = selected.targetId;
  } else if (op === "close") {
    const selected = args[1] === undefined ? tabs.find(t => t.targetId === record.sessions[session]) : tabs[Number(args[1])];
    if (!selected) fail("no such tab in this thread's window");
    threadCdp(identity, browser, "closeTab", {targetId:selected.targetId});
    targetId = tabs.find(t => t.targetId !== selected.targetId)?.targetId;
  } else fail("use tab list, new [url], switch <index>, or close [index]");
  if (targetId) {
    const current = readThreadRecord(identity); current.sessions[session] = targetId;
    writePrivate(threadRecordPath(identity), JSON.stringify(current));
    if (runAgentBrowser([...flags, "tab", targetId], {identity, timeoutMs:30_000}).status !== 0) fail("could not select the owned tab");
    if (op === "new" && args[1]) return runAgentBrowser([...flags, "open", args[1]], {identity, inherit:true}).status ?? 1;
  } else {
    runAgentBrowser([...flags, "close"], {identity, timeoutMs:30_000});
    rmSync(threadRecordPath(identity), {force:true});
  }
  console.log(JSON.stringify({success:true})); return 0;
}
function closeThreadBrowser(identity, session = null) {
  const close = (browser) => {
    if (existsSync(threadHoldPath())) return 0;
    const sessions = sessionList(identity).filter(name => name.startsWith(threadPrefix()) && (!session || name === session));
    for (const session of sessions) {
      const flags = identity.backend === "native" ? nativeFlags(identity, browser) : identity.backend === "existing" ? existingFlags(identity, false) : launchFlags(identity, [], false);
      runAgentBrowser([...flags, "--session", session, "close"], {identity, timeoutMs:30_000});
    }
    const record = readThreadRecord(identity);
    if (browser && record && session && Object.keys(record.sessions).some(name => name !== session)) {
      const targetId = record.sessions[session];
      if (targetId && threadCdp(identity, browser, "list").tabs.some(tab => tab.targetId === targetId)) threadCdp(identity, browser, "closeTab", { targetId });
      delete record.sessions[session];
      writePrivate(threadRecordPath(identity), JSON.stringify(record));
    } else {
      if (browser && record) threadCdp(identity, browser, "close");
      rmSync(threadRecordPath(identity), {force:true});
      rmSync(join(nativeEventsDirectory(identity),'session.json'),{force:true});
    }
    return 0;
  };
  if (identity.backend === "native") return withNativeBrowser(identity, false, browser => withThreadLock(identity, () => close(browser)));
  if (identity.backend === "existing") { verifyExistingBrowser(identity); return withThreadLock(identity, () => close({port:identity.port})); }
  return close(null);
}
function threadCommand(args) {
  if (!threadOwner()) fail("thread commands require BB_THREAD_ID");
  const op = args[0];
  if (op === "label") {
    if (args.length > 2) fail("usage: bb-browser thread label [chat title]");
    const file = join(threadDir(), `${threadOwner()}.label`);
    if (args.length === 1) {
      rmSync(`${file}.manual`, {force:true});
      console.log(threadLabel(true));
    } else {
      const label = args[1].replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      writePrivate(file, label + "\n");
      writePrivate(`${file}.manual`, "1\n");
    }
    // Updating a label can decorate an existing window, including during a
    // manual handoff. This never launches a browser or imports cookies.
    try {
      const identity = plannedIdentity();
      if (identity.backend === "native") withNativeBrowser(identity, false, browser => { if (browser) ensureNativeGroup(identity, browser); });
      else if (identity.backend === "existing") { verifyExistingBrowser(identity); ensureNativeGroup(identity, {port:identity.port}); }
    } catch { /* Metadata remains available when its browser is disconnected. */ }
    return 0;
  }
  if (op === "pause") {
    const identity = plannedIdentity();
    const pause = () => { writePrivate(threadHoldPath(), "manual\n"); return 0; };
    if (identity.backend === "native") withNativeLock(identity, () => withThreadLock(identity, pause));
    else withThreadLock(identity, pause);
    console.log(JSON.stringify({ok:true, workspace:nativeWorkspace()})); return 0;
  }
  if (op === "resume") { rmSync(threadHoldPath(), {force:true}); return 0; }
  if (!['show', 'close', 'discard', 'viewer'].includes(op)) fail("usage: bb-browser thread pause|resume|show|close|discard|viewer");
  if (op === "close" && existsSync(threadHoldPath())) return 0;
  if (op === "discard") rmSync(threadHoldPath(), {force:true});
  const identity = plannedIdentity();
  if(op === 'viewer') {
    if(!existsSync(threadHoldPath()))fail('Viewer expired; this thread is not paused');
    const view=browser=>withThreadLock(identity,()=>{
      const record=readThreadRecord(identity);if(!record)fail('Thread browser is no longer open');
      const action=JSON.parse(args.slice(1).join(' ')||'{}');
      if(action.type==='dialog')return nativeDialog(identity,[action.accept?'accept':'dismiss',action.promptText||'']);
      const tabs=threadCdp(identity,browser,'list').tabs;
      if(action.type==='tab'){
        if(!tabs.some(t=>t.targetId===action.target))fail('Viewer target does not belong to this thread');
        record.viewerTargetId=action.target;writePrivate(threadRecordPath(identity),JSON.stringify(record));console.log(JSON.stringify({selected:action.target}));return 0;
      }
      const targetId=tabs.some(t=>t.targetId===record.viewerTargetId)?record.viewerTargetId:record.sessions?.[record.lastSession]||Object.values(record.sessions||{})[0];
      let dialog=null;try{dialog=JSON.parse(readFileSync(join(nativeEventsDirectory(identity),'dialog.json'),'utf8'));}catch{}
      const output=threadCdp(identity,browser,'page',{targetId,argv:['viewer',JSON.stringify(action)],dialog,operations:new URL('../browser-extension/page-operations.js',import.meta.url).href});
      console.log(JSON.stringify(output));return 0;
    });
    if(identity.backend === 'native')return withNativeBrowser(identity,false,view);
    if(identity.backend === 'existing'){verifyExistingBrowser(identity);return view({port:identity.port});}
    fail('This browser backend has no private viewer');
  }
  if (op !== "show") return closeThreadBrowser(identity);
  const show = browser => { if (!browser) fail("thread browser is no longer open"); threadCdp(identity, browser, "show"); return 0; };
  let result;
  if (identity.backend === "native") {
    result = withNativeBrowser(identity, false, browser => withNativeLock(identity, () => withThreadLock(identity, () => {
      show(browser);
      const record = readThreadRecord(identity);
      const address = record?.windowAddress;
      if (!/^0x[0-9a-f]+$/i.test(address || "") || !nativeWindows(browser).some(window => window.address === address)) {
        fail("this thread's desktop window cannot be identified; open it manually on the browser host");
      }
      console.log(JSON.stringify({ok:true, workspace:nativeWorkspace(), message:"Open the browser workspace manually; automation never changes desktop focus."}));
      return 0;
    })));
  } else if (identity.backend === "existing") { verifyExistingBrowser(identity); result = show({port:identity.port}); }
  else fail("manual handoff needs a headed desktop browser; open this host's desktop or use the native backend");
  return result;
}

function passthrough(argv) {
  const parsed = splitArgs(argv);
  let { rest } = parsed;
  const { browserArgs, stateName, command, args, flags } = parsed;
  const thread = threadOwner();
  if (thread) {
    if (flags.includes("--new-tab")) fail("use bb-browser tab new <url> to keep new tabs inside this thread's window");
    if (existsSync(threadHoldPath())) fail("this thread's browser is waiting for you; finish or cancel its browser handoff in BB before automation resumes");
    rest = scopedThreadArgs(rest);
  }
  // Closing or listing sessions launches nothing, so it must keep working while
  // egress is down.
  const identity = CLOSE_COMMANDS.has(command) ? plannedIdentity(stateName) : verifiedIdentity(stateName);
  if (thread && command === "session") {
    console.log(JSON.stringify({ success: true, data: { sessions: sessionList(identity).filter(name => name.startsWith(threadPrefix())) } }));
    return 0;
  }
  if (thread && identity.backend === "agent" && CLOSE_COMMANDS.has(command)) return closeThreadBrowser(identity, args.includes("--all") ? null : requestedSession(rest));
  if (thread && (identity.backend === "native" || identity.backend === "existing")) {
    if (CLOSE_COMMANDS.has(command) && command !== "session") return closeThreadBrowser(identity, args.includes("--all") ? null : requestedSession(rest));
    const execute = (browser) => {
      if (existsSync(threadHoldPath())) fail("this thread's browser is paused for manual input");
      if(command === 'dialog')return nativeDialog(identity,args);
      ensureThreadTab(identity, browser, requestedSession(rest));
      if (["observe", "act", "dialog", "screenshot"].includes(command)) {
        const record = readThreadRecord(identity);
        const output = threadCdp(identity, browser, "page", {targetId:record.sessions[requestedSession(rest)], argv:[command,...args,...flags.filter(flag=>['--delta','--full'].includes(flag))], operations:new URL("../browser-extension/page-operations.js", import.meta.url).href});
        if (command === "screenshot" && args[0] && !args[0].startsWith("--")) { writeFileSync(args[0], Buffer.from(output.data, "base64"), {mode:0o600}); console.log(JSON.stringify({path:args[0]})); }
        else console.log(JSON.stringify(output));
        return 0;
      }
      if (command === "tab") return threadTabCommand(identity, browser, requestedSession(rest), args);
      return runAgentBrowser([...(identity.backend === "native" ? nativeFlags(identity, browser) : existingFlags(identity)), ...rest], { identity, inherit: true }).status ?? 1;
    };
    checkNativeCommand(command, args, flags, identity.backend);
    if (browserArgs.length) fail("attached browsers own their launch arguments");
    if (identity.backend === "native") return withNativeBrowser(identity, true, browser => withThreadLock(identity, () => execute(browser)));
    verifyExistingBrowser(identity);
    return withThreadLock(identity, () => execute({ port: identity.port }));
  }
  if (identity.backend === "existing") {
    if (browserArgs.length || flags.includes("--idle-timeout")) fail("existing Brave owns its launch arguments and lifetime");
    checkNativeCommand(command, args, flags, "existing");
    if (CLOSE_COMMANDS.has(command)) return closeExisting(identity, rest, command, true);
  }
  if (identity.backend === "native") {
    if (browserArgs.length > 0) {
      fail("--args does not apply to the native backend: bb-browser fixes Brave's switches when it launches it");
    }
    checkNativeCommand(command, args, flags);
    if (requestedSession(rest) === NATIVE_STATE_SESSION) fail(`--session ${NATIVE_STATE_SESSION} is reserved for bb-browser`);
    if (CLOSE_COMMANDS.has(command)) return closeNative(identity, rest, command, true);
  }
  const result = agentBrowser(identity, rest, { browserArgs, inherit: true, includeState: !CLOSE_COMMANDS.has(command) });
  return result.status ?? 1;
}

// A render job is intentionally separate from the thread-owned interactive
// session. It has no imported state and always tears down its Agent Browser
// session, so frame seeking cannot resize, navigate, or capture a user's tab.
function renderFrames(args) {
  if (args.length !== 2 || args[0] !== "frames") {
    fail("usage: bb-browser render frames <spec.json>");
  }
  const specPath = resolve(args[1]);
  let spec;
  try { spec = JSON.parse(readFileSync(specPath, "utf8")); }
  catch { fail("render spec must be valid JSON"); }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) fail("render spec must be an object");
  let url;
  try { url = new URL(spec.url); } catch { fail("render spec needs an absolute url"); }
  if (!/^https?:$/.test(url.protocol)) fail("render url must use http or https");
  const viewport = spec.viewport;
  if (!viewport || typeof viewport !== "object" || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) ||
      viewport.width < 1 || viewport.width > 7680 || viewport.height < 1 || viewport.height > 7680 ||
      !Number.isFinite(viewport.scale) || viewport.scale < 0.5 || viewport.scale > 4) {
    fail("render viewport needs width, height, and scale (0.5 through 4)");
  }
  const clip = spec.clip;
  if (clip !== undefined && (!clip || typeof clip !== "object" || !Number.isInteger(clip.x) || !Number.isInteger(clip.y) ||
      !Number.isInteger(clip.width) || !Number.isInteger(clip.height) || clip.x < 0 || clip.y < 0 || clip.width < 1 || clip.height < 1 ||
      clip.x + clip.width > viewport.width || clip.y + clip.height > viewport.height)) {
    fail("render clip must fit inside the viewport");
  }
  if (!Array.isArray(spec.frames) || spec.frames.length < 1 || spec.frames.length > 10000) fail("render frames must contain 1 through 10000 frames");
  const frames = spec.frames.map((frame, index) => {
    if (!frame || typeof frame !== "object" || !Number.isFinite(frame.time) || frame.time < 0 || frame.time > 86400 ||
        typeof frame.path !== "string" || !frame.path || (frame.selector !== undefined && typeof frame.selector !== "string")) {
      fail(`render frame ${index} needs a non-negative time, path, and optional selector`);
    }
    return { time: frame.time, path: resolve(dirname(specPath), frame.path), selector: frame.selector };
  });
  const base = verifiedIdentity();
  if (base.backend === "existing") fail("render jobs never attach to a regular Brave profile");
  const session = `render-${randomBytes(8).toString("hex")}`;
  const identity = { ...base, backend: "agent", state: null, namespace: `bb-render-${randomBytes(8).toString("hex")}` };
  const call = (operation) => {
    const result = agentBrowser(identity, ["--session", session, ...operation], { includeState: false, timeoutMs: 90_000 });
    if (result.status !== 0) fail(`render ${operation[0]} failed`);
  };
  const crop = (path) => {
    if (!clip) return;
    const scale = viewport.scale;
    const geometry = `${Math.round(clip.width * scale)}x${Math.round(clip.height * scale)}+${Math.round(clip.x * scale)}+${Math.round(clip.y * scale)}`;
    const temporary = `${path}.bb-render-${process.pid}.png`;
    const result = spawnSync("magick", [path, "-crop", geometry, "+repage", temporary], { encoding: "utf8", timeout: 30_000 });
    if (result.error?.code === "ENOENT") fail("render clip needs ImageMagick (magick) on PATH");
    if (result.status !== 0) fail("render clip failed");
    renameSync(temporary, path);
  };
  try {
    call(["open", url.href]);
    call(["set", "viewport", String(viewport.width), String(viewport.height), String(viewport.scale)]);
    for (const frame of frames) {
      call(["eval", `(() => { const video = window.__video; if (!video || typeof video.show !== 'function') throw new Error('window.__video.show is required'); return video.show(${frame.time}); })()`]);
      call(frame.selector ? ["screenshot", frame.selector, frame.path] : ["screenshot", frame.path]);
      crop(frame.path);
    }
  } finally {
    agentBrowser(identity, ["--session", session, "close"], { includeState: false, timeoutMs: 30_000 });
  }
  console.log(JSON.stringify({ rendered: frames.length, viewport, ...(clip ? { clip } : {}), paths: frames.map(frame => frame.path) }));
  return 0;
}

const USAGE = `bb-browser — Brave through agent-browser with a pinned identity

  bb-browser <agent-browser command> [args]   e.g. open, snapshot, click, screenshot
  bb-browser layout tile                    tile existing managed Hyprland windows
  bb-browser thread label [chat title]        refresh or override this thread's label
  bb-browser workspace <number|name:NAME|special:NAME>  set the native workspace (default 8)
  bb-browser thread pause|resume|show|close|discard  handoff and cleanup for BB_THREAD_ID
  bb-browser doctor [--offline] [--json]      verify Brave, user agent, egress, and state
  bb-browser egress up|status                 start or inspect Tailscale home egress
  bb-browser state import <name> [file|-]     import cookies/localStorage (values never printed)
  bb-browser state sync <name> [file|-]       apply authoritative live cookie snapshots
  bb-browser state save <name>                save the running browser's state
  bb-browser state list | rm <name>
  bb-browser render frames <spec.json>       deterministic, isolated Brave frame capture
  bb-browser provision < settings.json        used by the sandboxes plugin

Use --state-name <name> (or BB_BROWSER_STATE) to pick an imported state, or
"none" for a signed-out browser. The executable, user agent, proxy, provider,
profile, and config are fixed by bb-browser and cannot be passed through.
Only commands that drive this Brave are accepted, and read takes no URL: run
open <url>, then read.

On a local Hyprland desktop with no user agent or state configured, or with
BB_BROWSER_BACKEND=native, bb-browser launches Brave itself, headed, on a
dedicated profile (BB_BROWSER_PROFILE, default ${DEFAULT_NATIVE_PROFILE}) and
attaches over a loopback CDP port. New thread windows use workspace
8 by default (BB_BROWSER_WORKSPACE or the workspace setting). Moving a window
preserves Brave. The profile's sign-ins persist. BB_THREAD_ID creates a separate
window per thread; sessions and tab commands stay inside it. close --all closes
only that thread's windows and tabs, keeping a blank keepalive window on the configured workspace.
Tab/window titles carry the chat name. Native windows use normal Hyprland
 tiling and fullscreen controls; layout tile converts earlier floating windows.
Live cookie snapshots use no helper tabs.
Without a thread ID, legacy explicit sessions share the browser.
Use browser_handoff in BB when the user must sign in or finish another manual
action. Its native attention card pauses automation and preserves the window
until Done or Cancel. thread pause/resume/show/close/discard are its host controls.
BB also cleans up on idle, failure, archive and deletion on connected hosts.
Native mode refuses --state-name, BB_BROWSER_STATE, --args, --idle-timeout,
state save, cookies clear, storage clear and set credentials. The imported
default state loads once per revision, deferred during manual handoff.
For your regular, already-running Brave, set BB_BROWSER_BACKEND=existing,
BB_BROWSER_PROFILE=Brave-Origin (or Brave-Browser), and BB_BROWSER_CDP_PORT to
its loopback debugging port. Linux only; no Hyprland requirement. bb-browser
checks the profile lock and listening socket, pins each session to a tab, and
never launches or stops your regular browser. Without a BB_THREAD_ID, session close detaches and
leaves its tab open. It never imports state into your regular profile.
Settings: ${home}`;

function main(argv) {
  const [command, ...rest] = argv;
  if (command === "--version" && rest.length === 0) {
    console.log(`bb-browser ${JSON.parse(readFileSync(join(runtimeDirectory, "..", "package.json"), "utf8")).version}`);
    return;
  }
  let backend = setting("BB_BROWSER_BACKEND", "backend").trim();
  if(setting('','network-service')==='sandboxes-v1'&&existsSync(join(home,'shared-network.json')))useNetworkConnection(JSON.parse(readFileSync(join(home,'shared-network.json'),'utf8')));
  const scopedCommand=command&&!['help','--help','-h','provision','egress','workspace','layout','render'].includes(command)&&(command!=='state'||rest[0]==='save')&&!(command==='thread'&&rest[0]==='label');
  if(threadOwner()&&scopedCommand){
    const file=join(threadDir(),threadOwner()+'.backend');let prior='';try{prior=readFileSync(file,'utf8').trim();}catch{}
    if(prior){
      if(!['native','existing','agent','isolated','relay'].includes(prior))fail('Invalid saved thread backend; no browser selected');
      if(env.BB_BROWSER_BACKEND&&env.BB_BROWSER_BACKEND!==prior)fail('This thread already owns a different browser backend. Close its session before selecting another.');
      backend=prior;env.BB_BROWSER_BACKEND=prior;
    }else{
      if(backend&&!['native','existing','agent','isolated','relay'].includes(backend))fail('Unknown browser backend');
      backend=backend||(usesUserspaceTailscale()?'isolated':selectedBackend(argv.some(arg=>arg==='--state-name'||arg.startsWith('--state-name='))?'selected':undefined));env.BB_BROWSER_BACKEND=backend;
      writePrivate(file,backend+'\n');
    }
  }
  const isolated = backend === 'isolated' || !backend && usesUserspaceTailscale() && !!threadOwner();
  const runtimeCommand = command && (!['help','--help','-h','provision','state','egress','workspace','layout','render'].includes(command) || isolated && command === 'state' && rest[0] === 'save');
  if (runtimeCommand && (backend === "relay" || command === "fast")) {
    if (!threadOwner()) fail("relay requires BB_THREAD_ID");
    const result = spawnSync("bb", ["plugin", "run", "browser", Buffer.from(JSON.stringify({argv})).toString("base64url")], {encoding:'utf8', timeout:command === 'fast' ? 70_000 : 35_000,maxBuffer:12*1024*1024});
    if(result.stderr)process.stderr.write(result.stderr);
    if(result.status===0&&command==='thread'){
      if(rest[0]==='pause')writePrivate(threadHoldPath(),'manual\n');
      else if(['resume','discard'].includes(rest[0]))rmSync(threadHoldPath(),{force:true});
    }
    if(result.status === 0 && command === 'screenshot' && rest[0] && !rest[0].startsWith('--')) {
      let data;try{data=JSON.parse(result.stdout).data;}catch{fail('Invalid relay screenshot response; no file was written');}
      if(typeof data !== 'string'||!data)fail('Relay returned no screenshot; no file was written');
      writeFileSync(rest[0],Buffer.from(data,'base64'),{mode:0o600});console.log(JSON.stringify({path:rest[0]}));
    } else if(result.stdout)process.stdout.write(result.stdout);
    return result.status ?? 1;
  }
  if (runtimeCommand && isolated) return withLock(join(threadDir(),threadOwner()+".network.lock"), () => {
    let closingGenerations;
    try {
    for (let attempt = 0; attempt < 2; attempt++) {
    let current, lease;
    try { current = JSON.parse(readFileSync(join(home,"sessions",threadOwner(),"session.json"),"utf8")); } catch {}
    try { lease = JSON.parse(readFileSync(join(threadDir(),threadOwner()+'.network.json'),"utf8")); } catch {}
    const acquiring = command !== "close" && command !== "thread";
    const closing = command === "close" || command === "thread" && ["close","discard"].includes(rest[0]);
    if(closing)closingGenerations=[...new Set([current?.networkGeneration,lease?.generation])];
    const running = current && sameProcess(current.pid,current.start);
    const generation = running ? current.networkGeneration : undefined;
    networkGeneration = acquiring ? generation || randomBytes(16).toString("hex") : current?.networkGeneration || (closing ? lease?.generation : undefined);
    const configured = env.BB_BROWSER_BACKEND;
    env.BB_BROWSER_BACKEND = "agent";
    const parsed = ["thread", "doctor", "identity", "state"].includes(command) ? null : splitArgs(argv);
    let identity;
    try { identity = command === "close" || command === "thread" ? plannedIdentity(parsed?.stateName) : verifiedIdentity(parsed?.stateName); }
    finally { if (configured === undefined) delete env.BB_BROWSER_BACKEND; else env.BB_BROWSER_BACKEND = configured; }
    const expectedIps = identity.egress ? setting('BB_BROWSER_HOME_EGRESS_IP','home-egress-ip') || publicIp(identity.proxy) : '';
    const operation = command === 'state' && rest[0] === 'save' ? ['identity','save',...rest.slice(1)] : parsed ? [parsed.command,...parsed.args,...parsed.flags.filter(flag=>['--delta','--full'].includes(flag))] : argv;
    const result = spawnSync(nodeRuntime(), [join(runtimeDirectory, "session.mjs")], { input:JSON.stringify({home, thread:threadOwner(), identity:{...identity,networkGeneration,networkSession:running?current.session:undefined}, argv:parsed?.rest || argv, operation, expectedIps, agentConfig:agentBrowserConfig()}), encoding:"utf8", timeout:90_000, maxBuffer:12*1024*1024 });
    if (result.status === 75 && attempt === 0) continue;
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if(result.status===0&&closing&&!existsSync(threadHoldPath())){
      if(setting('','network-service')==='sandboxes-v1'&&existsSync(join(home,'shared-network.json'))){
        for(const generation of closingGenerations){networkGeneration=generation;networkControl(false);}
      }
      networkClosed=true;
    }
    return result.status ?? 1;
    }
    } finally {
      let latest;try{latest=JSON.parse(readFileSync(join(home,'sessions',threadOwner(),'session.json'),'utf8'));}catch{}
      if(networkAcquired&&!(latest&&sameProcess(latest.pid,latest.start)))networkControl(false);
    }
  }, "isolated browser command", 900_000);
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    case "layout": {
      if (rest.length !== 1 || rest[0] !== "tile") fail("usage: bb-browser layout tile");
      const identity = plannedIdentity();
      if (identity.backend !== "native") fail("layout tile is for the managed Hyprland browser");
      return withNativeBrowser(identity, false, browser => {
        addWindowRule(identity.windowClass);
        if (!browser) return 0;
        if (!anyThreadHandoff() && nativeHelperTarget(identity)) {
          threadCdp(identity, browser, "closeHelper", {cleanupTargetId:nativeHelperTarget(identity)});
          forgetPinnedTab(identity, NATIVE_STATE_SESSION);
        }
        for (const window of nativeWindows(browser)) {
          if (!/^0x[0-9a-f]+$/i.test(window.address || "")) continue;
          // Migrate only our legacy parking workspace; preserve windows the user moved.
          if (window.pid === browser.pid && window.workspace?.name === "special:bb-browser") {
            const moved = hyprctlRepl(`hl.dispatch(hl.dsp.window.move({window = "address:${window.address}", workspace = "${nativeWorkspace()}", follow = false})) return "bb-browser-moved"`);
            if (!moved.includes("bb-browser-moved")) fail("Hyprland could not move a managed browser window to its configured workspace");
          }
          if (!window.floating) continue;
          const result = hyprctlRepl(`hl.dispatch(hl.dsp.window.float({window = "address:${window.address}", action = "off"})) return "bb-browser-tiled"`);
          if (!result.includes("bb-browser-tiled")) fail("Hyprland could not tile a managed browser window");
        }
        return 0;
      });
    }
    case "workspace": {
      if (rest.length !== 1) fail("usage: bb-browser workspace <number|name:NAME|special:NAME>");
      const value = rest[0];
      if (!/^(?:[1-9][0-9]*|(?:name:|special:)[A-Za-z0-9_-]+)$/.test(value)) fail("invalid browser workspace");
      writePrivate(join(home, "workspace"), value + "\n");
      console.log(`Browser workspace: ${value}. New windows use this workspace; existing windows stay where you put them.`);
      return 0;
    }
    case "thread": return threadCommand(rest);
    case "doctor":
      return doctor(rest);
    case "state":
      return stateCommand(rest);
    case "render":
      return renderFrames(rest);
    case "provision":
      return provision(readFileSync(0, "utf8"));
    case "egress": {
      const exitNode = configuredExitNode();
      if (rest[0] === "up") {
        if (!exitNode) fail("no exit node is configured; set browserExitNode or BB_BROWSER_EXIT_NODE");
        if (!usesUserspaceTailscale()) fail("egress up manages a sandbox's userspace tailscaled; use the system tailscale here");
        egressUp(exitNode);
      } else if (rest[0] !== "status") {
        fail("usage: bb-browser egress up|status");
      }
      const egress = homeEgress(exitNode);
      console.log(`home egress through ${egress.exitNode}${egress.proxy ? ` via ${egress.proxy}` : ""}; ${egress.verified}`);
      return 0;
    }
    default:
      return passthrough(argv);
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
  const args=process.argv.slice(2);
  if(process.exitCode===0&&threadOwner()&&!existsSync(threadHoldPath())&&(args[0]==='close'&&args.includes('--all')||args[0]==='thread'&&['close','discard'].includes(args[1]))){
    if(!networkClosed&&setting('','network-service')==='sandboxes-v1'&&existsSync(join(home,'shared-network.json')))networkControl(false);
    rmSync(join(threadDir(),threadOwner()+'.backend'),{force:true});
  }
} catch (error) {
  if (!(error instanceof BrowserError)) throw error;
  process.stderr.write(`bb-browser: ${error.message}\n`);
  process.exitCode = 1;
}
