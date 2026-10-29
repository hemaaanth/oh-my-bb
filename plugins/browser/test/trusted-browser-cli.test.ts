import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const script = resolve("docker/trusted-browser.mjs");
const SECRET = "s3cret-cookie-value-do-not-print";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

let root: string;
let bin: string;
let home: string;
let log: string;

interface Call {
  argv: string[];
  env: Record<string, string>;
}

// Fakes stand in for Brave, agent-browser, tailscale, and curl. Each records
// its argv so the tests can see exactly what bb-browser launched.
async function fake(name: string, body: string) {
  const file = join(bin, name);
  await writeFile(
    file,
    `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("AGENT_BROWSER_") || /_PROXY$/i.test(key)));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: ${JSON.stringify(name)}, argv, env }) + "\\n");
${body}
`,
  );
  await chmod(file, 0o755);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bb-browser-test-"));
  bin = join(root, "bin");
  home = join(root, "home");
  log = join(root, "calls.jsonl");
  await mkdir(bin);
  await fake("brave-browser", `console.log("Brave Browser 141.1.83.118");`);
  await fake(
    "agent-browser",
    `if (argv.includes("--version")) { console.log("agent-browser 0.38.1"); process.exit(0); }
// Like agent-browser, a session remembers the tab it pinned after it closes,
// and with --pin-tab fails once that tab was closed.
if (argv.includes("--pin-tab") && process.env.AGENT_BROWSER_SOCKET_DIR) {
  const at = (name) => argv[argv.indexOf(name) + 1];
  const target = process.env.AGENT_BROWSER_SOCKET_DIR + "/namespaces/" + at("--namespace") + "/run/" + (argv.includes("--session") ? at("--session") : "default") + ".target";
  const pinned = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (argv.includes("tab") && argv.includes("close")) fs.writeFileSync(target, "closed");
  else if (pinned === "closed" && !argv.includes("close")) { console.error("tab_gone: bound tab is gone"); process.exit(1); }
  else if (!pinned && !argv.includes("close")) { fs.mkdirSync(require("node:path").dirname(target), { recursive: true }); fs.writeFileSync(target, "open"); }
}
if (argv.includes("state") && argv.includes("save")) {
  fs.writeFileSync(argv[argv.indexOf("save") + 1], JSON.stringify({ cookies: [{ name: "sid", value: "saved", domain: "example.com" }] }));
}
// Echoes the state it loads, so a test can see that bb-browser never prints it.
if (argv.includes("state") && argv.includes("load")) {
  const content = fs.readFileSync(argv[argv.indexOf("load") + 1], "utf8");
  if (process.env.FAKE_STATE_LOAD_FAIL) { console.error("could not set cookie " + content); process.exit(1); }
  console.log("loaded " + content);
}
// Each native namespace keeps its own sessions, like separate daemons.
const namespace = argv.includes("--namespace") ? argv[argv.indexOf("--namespace") + 1] : "";
const sessionFile = namespace.startsWith("bb-trusted-native-")
  ? process.env.FAKE_SESSION_FILE.replace(/\\.json$/, "-" + namespace + ".json")
  : process.env.FAKE_SESSION_FILE;
const sessionArg = argv.indexOf("--session");
const session = sessionArg === -1 ? "default" : argv[sessionArg + 1];
// A slow open registers its session only after the delay.
if (argv.includes("open") && process.env.FAKE_OPEN_DELAY_MS) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_OPEN_DELAY_MS));
}
let sessions = [];
try { sessions = JSON.parse(fs.readFileSync(sessionFile, "utf8")); } catch {}
if (argv.includes("session") && argv.includes("list")) {
  console.log(JSON.stringify({ success: true, data: { sessions } }));
  process.exit(0);
}
if (argv.includes("close")) sessions = argv.includes("--all") ? [] : sessions.filter((name) => name !== session);
else if (!sessions.includes(session)) sessions.push(session);
fs.writeFileSync(sessionFile, JSON.stringify(sessions));
// Brave opens with one blank tab, and each session pins a tab of its own.
if (argv.includes("tab") && argv.includes("list")) {
  const tabs = [...(process.env.FAKE_NO_BLANK_TAB ? [] : ["blank"]), ...sessions].map((label) => ({ label }));
  console.log(JSON.stringify({ success: true, data: { tabs } }));
  process.exit(0);
}
if (argv.includes("eval")) {
  const result = argv.includes("navigator.userAgent")
    ? process.env.FAKE_UA ?? argv[argv.indexOf("--user-agent") + 1]
    : argv.includes("navigator.webdriver") ? process.env.FAKE_WEBDRIVER === "true"
    : argv.includes("location.hostname") ? new URL(process.env.BB_BROWSER_IP_ECHO_URL ?? "https://api.ipify.org").hostname
    : process.env.FAKE_BROWSER_IP;
  console.log(JSON.stringify({ success: true, data: { result } }));
}`,
  );
  await fake(
    "tailscale",
    `if (argv.includes("status")) {
  if (!process.env.FAKE_TAILSCALE_STATUS) process.exit(1);
  console.log(process.env.FAKE_TAILSCALE_STATUS);
}`,
  );
  await fake(
    "curl",
    `console.log(argv.includes("--socks5-hostname") ? process.env.FAKE_PROXY_IP : process.env.FAKE_DIRECT_IP);`,
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(args: string[], options: { env?: Record<string, string>; input?: string } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    input: options.input ?? "",
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: root,
      BB_BROWSER_HOME: home,
      FAKE_LOG: log,
      FAKE_SESSION_FILE: join(root, "sessions.json"),
      FAKE_DIRECT_IP: "203.0.113.10",
      ...options.env,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function calls(tool: string): Promise<Call[]> {
  let text = "";
  try {
    text = await readFile(log, "utf8");
  } catch {
    return [];
  }
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Call & { tool: string })
    .filter((call) => call.tool === tool);
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function tailscaleStatus(hostName: string, online = true) {
  return JSON.stringify({
    BackendState: "Running",
    ExitNodeStatus: { Online: online },
    Peer: {
      a: { HostName: hostName, DNSName: `${hostName}.tail1234.ts.net.`, TailscaleIPs: ["100.64.0.2"], ExitNode: true },
      b: { HostName: "laptop", DNSName: "laptop.tail1234.ts.net.", ExitNode: false },
    },
  });
}

describe("bb-browser identity", () => {
  it("reports its version without resolving a browser, route, or login seed", async () => {
    const result = run(["--version"], {env: {
      BB_THREAD_ID: "thr_version",
      BB_BROWSER_BACKEND: "isolated",
      BB_BROWSER_EGRESS: "home",
      BB_BROWSER_REQUIRED_STATE: "missing-login-seed",
    }});
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`bb-browser ${JSON.parse(await readFile(resolve("package.json"), "utf8")).version}`);
    expect(await calls("brave-browser")).toEqual([]);
    expect(await calls("agent-browser")).toEqual([]);
    expect(await calls("tailscale")).toEqual([]);
    await expect(readFile(join(home, "threads/thr_version.backend"))).rejects.toThrow();
  });
  it("uses BB chat metadata for labels, with a persistent manual override", async () => {
    await fake("bb", `console.log(JSON.stringify({thread:{title:"Fix sign-in flow"}}));`);
    const env = {BB_THREAD_ID:"thr_label"};
    expect(run(["thread", "label"], {env}).stdout).toContain("Fix sign-in flow");
    expect((await calls("bb"))[0].argv).toEqual(["thread", "show", "thr_label", "--json"]);
    expect(await readFile(join(home,"threads/thr_label.label"),"utf8")).toBe("Fix sign-in flow\n");
    expect(run(["thread", "label", "My browser"], {env}).status).toBe(0);
    expect(await readFile(join(home,"threads/thr_label.label.manual"),"utf8")).toBe("1\n");
    expect(run(["thread", "label"], {env}).stdout).toContain("Fix sign-in flow");
    await expect(stat(join(home,"threads/thr_label.label.manual"))).rejects.toThrow();
  });

  it("configures a native workspace and rejects Lua or dispatcher text", async () => {
    expect(run(["workspace", "8"]).status).toBe(0);
    expect(await readFile(join(home, "workspace"), "utf8")).toBe("8\n");
    expect(run(["workspace", '8"; os.execute("bad")']).status).toBe(1);
    expect(await readFile(join(home, "workspace"), "utf8")).toBe("8\n");
  });

  it("scopes agent sessions by thread and makes close --all local to that thread", async () => {
    const a = {BB_THREAD_ID:"thr_a", BB_BROWSER_BACKEND:"agent"};
    const b = {BB_THREAD_ID:"thr_b", BB_BROWSER_BACKEND:"agent"};
    expect(run(["open", "about:blank"], {env:a}).status).toBe(0);
    expect(run(["open", "about:blank"], {env:b}).status).toBe(0);
    const before = (await calls("agent-browser")).filter(call => call.argv.includes("open"));
    expect(flag(before[0].argv, "--session")).not.toBe(flag(before[1].argv, "--session"));
    expect(run(["close", "--all"], {env:a}).status).toBe(0);
    const closing = (await calls("agent-browser")).filter(call => call.argv.includes("close"));
    expect(closing).toHaveLength(1);
    expect(flag(closing[0].argv, "--session")).toBe(flag(before[0].argv, "--session"));
    expect(closing[0].argv).not.toContain("--all");
    const list = run(["session", "list"], {env:b});
    expect(JSON.parse(list.stdout).data.sessions).toEqual([flag(before[1].argv, "--session")]);
  });

  it("blocks automation and idle cleanup during handoff until explicit resume", async () => {
    const env = {BB_THREAD_ID:"thr_handoff", BB_BROWSER_BACKEND:"agent"};
    expect(run(["open", "about:blank"], {env}).status).toBe(0);
    expect(run(["thread", "pause"], {env}).status).toBe(0);
    expect(run(["click", "button"], {env}).stderr).toContain("waiting for you");
    expect(run(["thread", "close"], {env}).status).toBe(0);
    expect((await calls("agent-browser")).filter(call => call.argv.includes("close"))).toHaveLength(0);
    expect(run(["thread", "resume"], {env}).status).toBe(0);
    expect(run(["snapshot"], {env}).status).toBe(0);
    expect(run(["thread", "discard"], {env}).status).toBe(0);
  });

  it("accepts the Brave Origin development build", async () => {
    await fake("brave-origin", `console.log("Brave Origin 154.1.96.59 unknown");`);
    expect(run(["provision"], { input: JSON.stringify({ userAgent: UA }) }).status).toBe(0);
    const result = run(["open", "https://example.com"], {
      env: { BB_BROWSER_EXECUTABLE: join(bin, "brave-origin") },
    });
    expect(result.status).toBe(0);
    const [call] = await calls("agent-browser");
    expect(flag(call.argv, "--executable-path")).toBe(join(bin, "brave-origin"));
  });

  it("refuses a browser that is not Brave instead of falling back", async () => {
    await fake("chrome", `console.log("Google Chrome 141.0.7390.54");`);
    const explicit = run(["open", "https://example.com"], { env: { BB_BROWSER_EXECUTABLE: join(bin, "chrome") } });
    expect(explicit.status).toBe(1);
    expect(explicit.stderr).toContain("is not Brave");

    await fake("brave-browser", `console.log("Chromium 141.0.7390.54");`);
    // Shadows any Brave Origin installed on the machine running the tests.
    await fake("brave-origin", `console.log("Chromium 141.0.7390.54");`);
    const onPath = run(["open", "https://example.com"]);
    expect(onPath.status).toBe(1);
    expect(onPath.stderr).toContain("never falls back to Chrome or Chromium");
    expect(await calls("agent-browser")).toEqual([]);
  });

  it("launches Brave with the exact user agent and a scrubbed environment", async () => {
    expect(run(["provision"], { input: JSON.stringify({ userAgent: UA }) }).status).toBe(0);
    const result = run(["open", "https://example.com"], {
      env: {
        AGENT_BROWSER_PROXY: "http://leak:8080",
        AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
        AGENT_BROWSER_PROVIDER: "kernel",
        HTTPS_PROXY: "http://leak:8080",
      },
    });
    expect(result.status).toBe(0);
    const [call] = await calls("agent-browser");
    expect(flag(call.argv, "--executable-path")).toBe(join(bin, "brave-browser"));
    expect(flag(call.argv, "--user-agent")).toBe(UA);
    expect(flag(call.argv, "--config")).toBe(join(home, "agent-browser.json"));
    expect(flag(call.argv, "--namespace")).toMatch(/^bb-trusted-[0-9a-f]{12}$/);
    expect(flag(call.argv, "--args")).toContain("--disable-blink-features=AutomationControlled");
    expect(call.argv).not.toContain("--proxy");
    expect(call.argv.slice(-2)).toEqual(["open", "https://example.com"]);
    expect(call.env).toEqual({});
    expect(JSON.parse(await readFile(join(home, "agent-browser.json"), "utf8"))).toEqual({});
  });

  it("starts a new daemon namespace when the identity changes", async () => {
    run(["open", "about:blank"], { env: { BB_BROWSER_USER_AGENT: "UA one" } });
    run(["open", "about:blank"], { env: { BB_BROWSER_USER_AGENT: "UA two" } });
    const [first, second] = await calls("agent-browser");
    expect(flag(first.argv, "--namespace")).not.toBe(flag(second.argv, "--namespace"));
  });

  it.each([
    [["--user-agent", "other", "open", "about:blank"], "--user-agent is set by bb-browser"],
    [["-p", "kernel", "open", "about:blank"], "-p is set by bb-browser"],
    [["--provider=kernel", "open", "about:blank"], "--provider is set by bb-browser"],
    [["--cdp", "9222", "snapshot"], "--cdp is set by bb-browser"],
    [["--args", "--window-size=800,600,--proxy-server=socks5://x:1", "open", "about:blank"], "--proxy-server is not one bb-browser allows"],
    [["--args", "-proxy-bypass-list=*", "open", "about:blank"], "-proxy-bypass-list is not one bb-browser allows"],
    [["--args", "-proxy-server=direct://", "open", "about:blank"], "-proxy-server is not one bb-browser allows"],
    [["--args", "--user-agent=other", "open", "about:blank"], "--user-agent is not one bb-browser allows"],
    [["connect", "9222"], "agent-browser connect is not available"],
    [["--session", "s", "connect", "9222"], "agent-browser connect is not available"],
    [["--headed", "true", "connect", "9222"], "agent-browser connect is not available"],
    [["batch", "connect 9222"], "agent-browser batch is not available"],
    [["mcp"], "agent-browser mcp is not available"],
    [["chat", "open example.com"], "agent-browser chat is not available"],
    [["plugin", "add", "./evil"], "agent-browser plugin is not available"],
    [["--restore", "open", "about:blank"], "--restore is set by bb-browser"],
    [["--session-name", "other", "open", "about:blank"], "--session-name is set by bb-browser"],
    [["set", "device", "iPhone 15"], "agent-browser set device is not available"],
    [["set", "headers", '{"User-Agent":"other"}'], "header User-Agent is set by bb-browser"],
    [["--headers", '{"sec-ch-ua":"x"}', "open", "about:blank"], "header sec-ch-ua is set by bb-browser"],
    [["read", "https://example.com"], "bb-browser read only reads the open tab"],
    [["read", "--llms"], "bb-browser read only reads the open tab"],
  ])("rejects overrides of the trusted identity: %j", async (args, message) => {
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(await calls("agent-browser")).toEqual([]);
  });

  it("passes harmless browser arguments through", async () => {
    expect(run(["--args", "--window-size=800,600", "open", "about:blank"]).status).toBe(0);
    const [call] = await calls("agent-browser");
    expect(flag(call.argv, "--args")).toContain("--window-size=800,600");
    expect(flag(call.argv, "--args")).toContain("--disable-blink-features=AutomationControlled");
  });

  it("finds the command after flags and their values", async () => {
    expect(run(["--session", "work", "--headed", "true", "open", "about:blank"]).status).toBe(0);
    expect(run(["--headers", '{"Accept-Language":"en"}', "read"]).status).toBe(0);
    expect(run(["set", "viewport", "800", "600"]).status).toBe(0);
    const [open, read, viewport] = await calls("agent-browser");
    expect(open.argv.slice(-6)).toEqual(["--session", "work", "--headed", "true", "open", "about:blank"]);
    expect(read.argv.slice(-1)).toEqual(["read"]);
    expect(viewport.argv.slice(-4)).toEqual(["set", "viewport", "800", "600"]);
  });

  it("renders exact frames in a disposable Brave session", async () => {
    const spec = join(root, "film.json");
    await writeFile(spec, JSON.stringify({
      url: "http://127.0.0.1:4173/?render",
      viewport: { width: 1440, height: 810, scale: 2 },
      frames: [
        { time: 0, path: "out/000000.png" },
        { time: 1 / 30, path: "out/000001.png", selector: "#stage" },
      ],
    }));
    const result = run(["render", "frames", spec], { env: { BB_THREAD_ID: "thr_render", BB_BROWSER_BACKEND: "agent" } });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ rendered: 2, viewport: { width: 1440, height: 810, scale: 2 } });
    const browser = await calls("agent-browser");
    const session = flag(browser[0].argv, "--session");
    expect(session).toMatch(/^render-[0-9a-f]{16}$/);
    expect(browser.every(call => flag(call.argv, "--session") === session)).toBe(true);
    expect(browser.some(call => call.argv.includes("set") && call.argv.includes("viewport") && call.argv.includes("2"))).toBe(true);
    expect(browser.filter(call => call.argv.includes("eval"))).toHaveLength(2);
    expect(browser.some(call => call.argv.includes("screenshot") && call.argv.includes("#stage"))).toBe(true);
    expect(browser.at(-1)?.argv).toContain("close");
  });

  it("keeps the daemon namespace when state is saved or imported", async () => {
    const source = join(root, "export.json");
    await writeFile(source, JSON.stringify({ cookies: [{ name: "sid", value: SECRET, domain: "example.com" }] }));
    expect(run(["open", "about:blank"]).status).toBe(0);
    expect(run(["state", "import", "default", source]).status).toBe(0);
    expect(run(["snapshot"]).status).toBe(0);
    const saved = run(["state", "save", "default"]);
    expect(saved.stderr).toBe("");
    expect(saved.status).toBe(0);
    expect(run(["snapshot"]).status).toBe(0);
    const namespaces = (await calls("agent-browser"))
      .filter((call) => call.argv.includes("snapshot"))
      .map((call) => flag(call.argv, "--namespace"));
    expect(namespaces).toHaveLength(2);
    expect(new Set(namespaces).size).toBe(1);
  });

  it("checks the live user agent exactly in doctor", async () => {
    const env = { BB_BROWSER_USER_AGENT: UA };
    const ok = run(["doctor"], { env });
    expect(ok.stdout).toContain("navigator.userAgent matches exactly");
    expect(ok.status).toBe(0);
    const closes = (await calls("agent-browser")).filter((call) => call.argv.includes("close"));
    expect(closes).toHaveLength(1);

    const drift = run(["doctor", "--json"], { env: { ...env, FAKE_UA: `${UA} extra` } });
    expect(drift.status).toBe(1);
    const report = JSON.parse(drift.stdout) as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "live")?.ok).toBe(false);
  });
});

describe("bb-browser auth state", () => {
  const state = {
    cookies: [
      { name: "sid", value: SECRET, domain: ".example.com", path: "/", expires: 4102444800, httpOnly: true, secure: true, sameSite: "Lax" },
      { name: "old", value: SECRET, domain: "example.com", expires: 946684800 },
      { name: "pref", value: "1", domain: "news.example.org", session: true, sameSite: "no_restriction" },
    ],
    origins: [{ origin: "https://example.com", localStorage: [{ name: "token", value: SECRET }] }],
  };

  it("imports state privately and never prints its values", async () => {
    const source = join(root, "export.json");
    await writeFile(source, JSON.stringify(state));
    const result = run(["state", "import", "work", source]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('state "work": 2 cookies, 1 origins; dropped 1 expired cookies');
    expect(result.stdout).not.toContain("example.com");
    expect(result.stdout).not.toContain("news.example.org");
    expect(result.stdout + result.stderr).not.toContain(SECRET);

    const saved = join(home, "state", "work.json");
    expect((await stat(saved)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, "state"))).mode & 0o777).toBe(0o700);
    const stored = JSON.parse(await readFile(saved, "utf8")) as { cookies: Array<{ name: string; sameSite?: string }> };
    expect(stored.cookies.map((cookie) => [cookie.name, cookie.sameSite])).toEqual([
      ["sid", "Lax"],
      ["pref", "None"],
    ]);

    const list = run(["state", "list"]);
    expect(list.stdout).toMatch(/^work\t2 cookies, 1 origins\t/m);
    expect(list.stdout).not.toContain(SECRET);

    expect(run(["--state-name", "work", "open", "https://example.com"]).status).toBe(0);
    const call = (await calls("agent-browser")).find((entry) => entry.argv.includes("open"));
    expect(call).toBeDefined();
    expect(flag(call!.argv, "--state")).toBe(saved);
  });

  it("accepts a cookie-exporter array from stdin", async () => {
    const exported = [{ name: "sid", value: SECRET, domain: ".example.com", expirationDate: 4102444800, sameSite: "no_restriction" }];
    const result = run(["state", "import", "default", "-"], { input: JSON.stringify(exported) });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 cookies, 0 origins");
    expect(result.stdout).not.toContain("example.com");
    // The default state is used without being named.
    run(["open", "https://example.com"]);
    const call = (await calls("agent-browser")).find((entry) => entry.argv.includes("open"));
    expect(call).toBeDefined();
    expect(flag(call!.argv, "--state")).toBe(join(home, "state", "default.json"));
  });

  it("loads state only when the browser session starts", async () => {
    expect(run(["state", "import", "default", "-"], { input: JSON.stringify(state) }).status).toBe(0);
    expect(run(["--session", "work", "open", "https://example.com"]).status).toBe(0);
    expect(run(["--session", "work", "eval", "location.hostname"]).status).toBe(0);

    const commands = (await calls("agent-browser")).filter((call) => !call.argv.includes("session"));
    expect(flag(commands[0].argv, "--state")).toBe(join(home, "state", "default.json"));
    expect(commands[1].argv).not.toContain("--state");
  });

  it("rejects malformed state without echoing it", () => {
    const broken = run(["state", "import", "work", "-"], { input: `{"cookies": [{"value": "${SECRET}"` });
    expect(broken.status).toBe(1);
    expect(broken.stderr).toContain("not valid JSON");
    expect(broken.stderr).not.toContain(SECRET);

    const incomplete = run(["state", "import", "work", "-"], { input: JSON.stringify([{ value: SECRET }]) });
    expect(incomplete.status).toBe(1);
    expect(incomplete.stderr).toContain("cookie 0 needs a string name, value, and domain");
    expect(incomplete.stderr).not.toContain(SECRET);
  });

  it("fails rather than running signed out when required state is missing", async () => {
    expect(run(["provision"], { input: JSON.stringify({ requiredState: "default" }) }).status).toBe(0);
    const result = run(["open", "https://example.com"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('auth state "default" is required but is not imported');
    expect(await calls("agent-browser")).toEqual([]);

    expect(run(["--state-name", "none", "open", "https://example.com"]).status).toBe(0);
    const [call] = await calls("agent-browser");
    expect(call.argv).not.toContain("--state");
  });
});

describe("bb-browser provision", () => {
  it("stores settings privately and reports only what changed", async () => {
    const input = {
      userAgent: UA,
      exitNode: "home-pc",
      homeEgressIp: "198.51.100.7",
      tailscaleAuthKey: "tskey-auth-SECRET",
      requiredState: "default",
      state: { cookies: [{ name: "sid", value: SECRET, domain: "example.com" }] },
    };
    const result = run(["provision"], { input: JSON.stringify(input) });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Tailscale auth key set");
    expect(result.stdout).toContain('imported state "default": 1 cookies, 0 origins');
    expect(result.stdout).not.toContain("example.com");
    for (const value of [UA, "home-pc", "198.51.100.7", "tskey-auth-SECRET", SECRET]) {
      expect(result.stdout + result.stderr).not.toContain(value);
    }
    expect(await readFile(join(home, "tailscale-authkey"), "utf8")).toBe("tskey-auth-SECRET");
    for (const file of ["user-agent", "exit-node", "home-egress-ip", "tailscale-authkey", "required-state"]) {
      expect((await stat(join(home, file))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(home)).mode & 0o777).toBe(0o700);

    const cleared = run(["provision"], { input: JSON.stringify({ tailscaleAuthKey: "" }) });
    expect(cleared.stdout).toContain("Tailscale auth key cleared");
    await expect(stat(join(home, "tailscale-authkey"))).rejects.toThrow();
  });

  it("applies valid settings and blocks launch on an invalid one", async () => {
    expect(run(["provision"], { input: JSON.stringify({ homeEgressIp: "198.51.100.7" }) }).status).toBe(0);
    const result = run(["provision"], {
      input: JSON.stringify({ userAgent: UA, homeEgressIp: "not-an-ip" }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid home egress IP");
    expect(await readFile(join(home, "user-agent"), "utf8")).toBe(UA);
    // The old IP is not what was configured, so it is not kept.
    await expect(stat(join(home, "home-egress-ip"))).rejects.toThrow();

    const blocked = run(["open", "https://example.com"], { env: { BB_BROWSER_EGRESS: "direct" } });
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("browser settings did not apply (invalid home egress IP)");
    expect(await calls("agent-browser")).toEqual([]);
    const doctor = run(["doctor", "--json", "--offline"], { env: { BB_BROWSER_EGRESS: "direct" } });
    const report = JSON.parse(doctor.stdout) as { checks: Array<{ name: string; ok: boolean }> };
    expect(report.checks.find((check) => check.name === "settings")?.ok).toBe(false);

    expect(run(["provision"], { input: JSON.stringify({ homeEgressIp: "" }) }).status).toBe(0);
    expect(run(["open", "https://example.com"], { env: { BB_BROWSER_EGRESS: "direct" } }).status).toBe(0);
  });

  it("applies the other settings when the state is invalid and drops the stale default", async () => {
    const good = { cookies: [{ name: "sid", value: SECRET, domain: "example.com" }] };
    expect(run(["provision"], { input: JSON.stringify({ requiredState: "default", state: good }) }).status).toBe(0);
    const result = run(["provision"], {
      input: JSON.stringify({ userAgent: UA, requiredState: "default", state: "{not json" }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("state not imported");
    expect(await readFile(join(home, "user-agent"), "utf8")).toBe(UA);
    await expect(stat(join(home, "state", "default.json"))).rejects.toThrow();

    const open = run(["open", "https://example.com"]);
    expect(open.stderr).toContain('auth state "default" is required but is not imported');
    // A bad state blocks only the default state.
    expect(run(["--state-name", "none", "open", "https://example.com"]).status).toBe(0);
  });

  it("removes a provisioned default when the state setting is cleared, but keeps a hand-imported one", async () => {
    const good = { cookies: [{ name: "sid", value: SECRET, domain: "example.com" }] };
    expect(run(["provision"], { input: JSON.stringify({ requiredState: "default", state: good }) }).status).toBe(0);
    const cleared = run(["provision"], { input: JSON.stringify({ requiredState: "", state: null }) });
    expect(cleared.status).toBe(0);
    expect(cleared.stdout).toContain('state "default" removed');
    await expect(stat(join(home, "state", "default.json"))).rejects.toThrow();

    expect(run(["state", "import", "default", "-"], { input: JSON.stringify(good) }).status).toBe(0);
    const kept = run(["provision"], { input: JSON.stringify({ requiredState: "", state: null }) });
    expect(kept.status).toBe(0);
    expect(kept.stdout).not.toContain("removed");
    expect((await stat(join(home, "state", "default.json"))).isFile()).toBe(true);
  });
});

describe("bb-browser home egress", () => {
  const exitNode = { BB_BROWSER_EXIT_NODE: "home-pc" };

  it("releases a failed startup generation and retains it for recoverable discard", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "network-service"), "sandboxes-v1");
    await writeFile(join(home, "legacy-egress-retired"), "1");
    await fake("bb", `console.log(JSON.stringify({socket:${JSON.stringify(join(root,'tailscaled.sock'))},proxyPort:12345,client:'tailscale'}));`);
    const fields=readFileSync(`/proc/${process.pid}/stat`,'utf8').split(') ')[1].split(' ');
    for(let index=0;index<4;index++){
      const directory=join(home,'sessions','thr_busy'+index);await mkdir(directory,{recursive:true});
      await writeFile(join(directory,'session.json'),JSON.stringify({pid:process.pid,start:fields[19],session:'busy'+index}));
    }
    const env={...exitNode,BB_BROWSER_BACKEND:'isolated',BB_THREAD_ID:'thr_startup',BB_BROWSER_TAILSCALE_USERSPACE:'1',BB_BROWSER_HOME_EGRESS_IP:'198.51.100.7',FAKE_TAILSCALE_STATUS:tailscaleStatus('home-pc'),FAKE_PROXY_IP:'198.51.100.7'};
    const failed=run(['--state-name','none','open','https://example.com'],{env});
    expect(failed.status).toBe(1);expect(failed.stderr).toContain('Four isolated sessions');
    const requests=(await calls('bb')).map(call=>JSON.parse(Buffer.from(call.argv.at(-1)!,'base64url').toString()).argv);
    expect(requests).toHaveLength(2);expect(requests[0]).toEqual(['network','ensure',expect.stringMatching(/^[a-f0-9]{32}$/)]);
    expect(requests[1]).toEqual(['network','release',requests[0][2]]);
    const stale=join(home,'sessions','thr_startup');
    await writeFile(join(stale,'session.json'),JSON.stringify({pid:99999999,start:'1',session:'dead',networkGeneration:'a'.repeat(32)}));
    expect(run(['thread','discard'],{env}).status).toBe(0);
    const cleanup=(await calls('bb')).slice(2).map(call=>JSON.parse(Buffer.from(call.argv.at(-1)!,'base64url').toString()).argv);
    expect(cleanup).toEqual([['network','release','a'.repeat(32)],requests[1]]);
  });

  it.each([false, true])("uses the acquired managed proxy even with a stale cached connection (%s)", async (cached) => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "network-service"), "sandboxes-v1");
    await writeFile(join(home, "legacy-egress-retired"), "1");
    const connection = { socket: join(root, "tailscaled.sock"), proxyPort: 12345, client: "tailscale" };
    if (cached) await writeFile(join(home, "shared-network.json"), JSON.stringify({ ...connection, proxyPort: 12344 }));
    await fake("bb", `console.log(${JSON.stringify(JSON.stringify(connection))});`);
    const env = {
      ...exitNode,
      BB_BROWSER_BACKEND: "agent",
      BB_THREAD_ID: "thr_managed_proxy",
      BB_BROWSER_TAILSCALE_USERSPACE: "1",
      FAKE_TAILSCALE_STATUS: tailscaleStatus("home-pc"),
      FAKE_PROXY_IP: "198.51.100.7",
    };
    const result = run(["open", "https://example.com"], { env });
    expect(result.status, result.stderr).toBe(0);
    const [curl] = await calls("curl");
    expect(flag(curl.argv, "--socks5-hostname")).toBe("127.0.0.1:12345");
    const [first] = await calls("agent-browser");
    expect(flag(first.argv, "--proxy")).toBe("socks5://127.0.0.1:12345");
    expect(run(["open", "https://example.com/next"], { env }).status).toBe(0);
    const browserCalls = await calls("agent-browser");
    expect(flag(browserCalls.at(-1)!.argv, "--namespace")).toBe(flag(first.argv, "--namespace"));
  });

  it("fails inside a sandbox when no exit node is configured", async () => {
    const result = run(["open", "https://example.com"], { env: { IS_SANDBOX: "1" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("home egress is required but no exit node is configured");
    expect(await calls("agent-browser")).toEqual([]);

    expect(run(["open", "https://example.com"], { env: { IS_SANDBOX: "1", BB_BROWSER_EGRESS: "direct" } }).status).toBe(0);
  });

  it.each([
    ["tailscale is down", {}, "tailscale is not running on this machine"],
    ["the exit node is offline", { FAKE_TAILSCALE_STATUS: tailscaleStatus("home-pc", false) }, "no exit node is online"],
    ["another exit node is active", { FAKE_TAILSCALE_STATUS: tailscaleStatus("office") }, "not the configured home-pc"],
    [
      "the public IP is not home",
      { FAKE_TAILSCALE_STATUS: tailscaleStatus("home-pc"), BB_BROWSER_HOME_EGRESS_IP: "198.51.100.7", FAKE_DIRECT_IP: "203.0.113.10" },
      "not the configured home egress IP",
    ],
  ])("fails when %s", async (_case, env, message) => {
    const result = run(["open", "https://example.com"], { env: { ...exitNode, ...env } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(await calls("agent-browser")).toEqual([]);
  });

  it("needs the home IP to check system tailscale", async () => {
    const result = run(["open", "https://example.com"], {
      env: { ...exitNode, FAKE_TAILSCALE_STATUS: tailscaleStatus("home-pc"), FAKE_DIRECT_IP: "198.51.100.7" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("set browserHomeEgressIp");
    expect(await calls("agent-browser")).toEqual([]);
  });

  it("uses system tailscale directly when the public IP matches home", async () => {
    const result = run(["open", "https://example.com"], {
      env: {
        ...exitNode,
        FAKE_TAILSCALE_STATUS: tailscaleStatus("home-pc"),
        BB_BROWSER_HOME_EGRESS_IP: "198.51.100.7, 2001:db8::7",
        FAKE_DIRECT_IP: "198.51.100.7",
      },
    });
    expect(result.status).toBe(0);
    const [call] = await calls("agent-browser");
    expect(call.argv).not.toContain("--proxy");
  });

  it("checks the navigated doctor tab before reading the browser IP", async () => {
    const result = run(["doctor"], {
      env: {
        ...exitNode,
        BB_BROWSER_TAILSCALE_USERSPACE: "1",
        BB_BROWSER_HOME_EGRESS_IP: "198.51.100.7",
        FAKE_TAILSCALE_STATUS: tailscaleStatus("home-pc"),
        FAKE_PROXY_IP: "198.51.100.7",
        FAKE_BROWSER_IP: "198.51.100.7",
      },
    });
    expect(result.status).toBe(0);
    const browserCalls = await calls("agent-browser");
    expect(browserCalls.filter((call) => call.argv.includes("open"))).toHaveLength(2);
    expect(browserCalls.find((call) => call.argv.includes("https://api.ipify.org"))?.argv).toContain("open");
  });

  it("routes a userspace sandbox browser through the exit node proxy", async () => {
    const result = run(["open", "https://example.com"], {
      env: {
        BB_BROWSER_EXIT_NODE: "home-pc.tail1234.ts.net",
        BB_BROWSER_TAILSCALE_USERSPACE: "1",
        FAKE_TAILSCALE_STATUS: tailscaleStatus("home-pc"),
        FAKE_PROXY_IP: "198.51.100.7",
      },
    });
    expect(result.status).toBe(0);
    const curl = await calls("curl");
    expect(flag(curl[0].argv, "--socks5-hostname")).toBe("127.0.0.1:1055");
    const [call] = await calls("agent-browser");
    expect(flag(call.argv, "--proxy")).toBe("socks5://127.0.0.1:1055");
    expect(flag(call.argv, "--args")).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  });

  it("fails when the proxy still leaves from the machine's own IP", async () => {
    const result = run(["open", "https://example.com"], {
      env: {
        ...exitNode,
        BB_BROWSER_TAILSCALE_USERSPACE: "1",
        FAKE_TAILSCALE_STATUS: tailscaleStatus("home-pc"),
        FAKE_PROXY_IP: "203.0.113.10",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("still leaves from this machine's own IP");
  });

  it("asks for an auth key when the sandbox is not logged in", async () => {
    await fake("tailscaled", "");
    const result = run(["open", "https://example.com"], {
      env: {
        ...exitNode,
        BB_BROWSER_TAILSCALE_USERSPACE: "1",
        FAKE_TAILSCALE_STATUS: JSON.stringify({ BackendState: "NeedsLogin" }),
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no auth key is stored");
  });

  it("logs a sandbox in with the auth key file, then deletes the key", async () => {
    // tailscaled is already up but logged out; up logs it in, set picks the exit node.
    const tsState = join(root, "tailscale-state");
    await fake("tailscaled", "");
    await fake(
      "tailscale",
      `const state = fs.existsSync(${JSON.stringify(tsState)}) ? fs.readFileSync(${JSON.stringify(tsState)}, "utf8") : "";
if (argv.includes("status")) {
  console.log(state === "exit" ? ${JSON.stringify(tailscaleStatus("home-pc"))} : JSON.stringify({ BackendState: state ? "Running" : "NeedsLogin" }));
} else if (argv.includes("up")) {
  const key = argv.find((arg) => arg.startsWith("--auth-key=file:")).slice("--auth-key=file:".length);
  if (fs.readFileSync(key, "utf8") !== "tskey-auth-SECRET") process.exit(1);
  fs.writeFileSync(${JSON.stringify(tsState)}, "up");
} else if (argv.includes("set")) {
  fs.writeFileSync(${JSON.stringify(tsState)}, "exit");
}`,
    );
    expect(
      run(["provision"], {
        input: JSON.stringify({ tailscaleUserspace: "1", tailscaleAuthKey: "tskey-auth-SECRET" }),
      }).status,
    ).toBe(0);
    const result = run(["open", "https://example.com"], {
      env: { ...exitNode, FAKE_PROXY_IP: "198.51.100.7" },
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const tailscale = await calls("tailscale");
    const up = tailscale.find((call) => call.argv.includes("up"));
    expect(up?.argv).toContain(`--auth-key=file:${join(home, "tailscale-authkey")}`);
    for (const call of tailscale) expect(call.argv.join(" ")).not.toContain("tskey-auth-SECRET");
    expect(tailscale.find((call) => call.argv.includes("set"))?.argv).toContain("--exit-node=home-pc");
    await expect(stat(join(home, "tailscale-authkey"))).rejects.toThrow();
    expect(await calls("tailscaled")).toEqual([]);
    expect(flag((await calls("agent-browser"))[0].argv, "--proxy")).toBe("socks5://127.0.0.1:1055");
  });

  it("keeps closing sessions available while egress is down", async () => {
    expect(run(["close"], { env: exitNode }).status).toBe(0);
    expect(await calls("agent-browser")).toHaveLength(1);
  });
});

describe("bb-browser native backend", () => {
  const hyprland = { HYPRLAND_INSTANCE_SIGNATURE: "test", WAYLAND_DISPLAY: "wayland-1" };
  let profile: string;
  let pids: string;

  beforeEach(async () => {
    profile = join(root, "config", "BraveSoftware", "Brave-Origin-agent");
    pids = join(root, "brave.pids");
    // A headed Brave stand-in: it holds the profile through SingletonLock and
    // listens on the requested port itself, writing no DevToolsActivePort.
    await fake(
      "brave-browser",
      `if (argv.includes("--version")) { console.log("Brave Origin 154.1.96.59"); process.exit(0); }
const dir = argv.find((arg) => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
// Like Chromium, rewrite the process title into one space-joined string.
process.title = process.argv.join(" ");
fs.appendFileSync(process.env.FAKE_ROOT + "/brave.pids", process.pid + "\\n");
const port = Number(argv.find((arg) => arg.startsWith("--remote-debugging-port=")).slice("--remote-debugging-port=".length));
const windowClass = argv.find((arg) => arg.startsWith("--class=")).slice("--class=".length);
const server = require("node:net").createServer();
server.listen(port, process.env.FAKE_BRAVE_HOST || "127.0.0.1", () => {
  try { fs.unlinkSync(dir + "/SingletonLock"); } catch {}
  fs.symlinkSync(require("node:os").hostname() + "-" + process.pid, dir + "/SingletonLock");
  fs.writeFileSync(dir + "/ready", String(server.address().port));
  // Its window, as Hyprland would list it.
  fs.mkdirSync(process.env.FAKE_ROOT + "/clients", { recursive: true });
  fs.writeFileSync(process.env.FAKE_ROOT + "/clients/" + process.pid + ".json", JSON.stringify({
    pid: process.pid,
    class: process.env.FAKE_WINDOW_CLASS || windowClass,
    workspace: { name: process.env.FAKE_WORKSPACE || "special:bb-browser" },
  }));
});
process.on("SIGTERM", () => {
  try { fs.unlinkSync(dir + "/SingletonLock"); } catch {}
  process.exit(0);
});`,
    );
    await fake(
      "hyprctl",
      `if (process.env.FAKE_HYPR_FAIL) { console.log("lua error"); process.exit(1); }
if (argv[0] === "clients") {
  const dir = process.env.FAKE_ROOT + "/clients";
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  const clients = names.map((name) => JSON.parse(fs.readFileSync(dir + "/" + name, "utf8"))).filter((client) => {
    try { process.kill(client.pid, 0); return true; } catch { return false; }
  });
  console.log(JSON.stringify(clients));
  process.exit(0);
}
console.log(argv[1].includes("hl.window_rule") ? "bb-browser-rule:true" : argv[1].includes("bb-browser-moved") ? "bb-browser-moved" : "bb-browser-rule:removed");`,
    );
  });

  afterEach(async () => {
    let text = "";
    try {
      text = await readFile(pids, "utf8");
    } catch {}
    for (const pid of text.split("\n").filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {}
    }
  });

  function runNative(args: string[], env: Record<string, string> = {}) {
    return run(args, { env: { ...hyprland, XDG_CONFIG_HOME: join(root, "config"), FAKE_ROOT: root, ...env } });
  }

  async function launches() {
    return (await calls("brave-browser")).filter((call) => !call.argv.includes("--version"));
  }

  // Each profile's record, lock, and leases live in a directory named by the
  // profile's hash, the same id as its window class and namespace.
  function profileDir(profilePath = profile) {
    return join(home, "native", createHash("sha256").update(profilePath).digest("hex").slice(0, 12));
  }

  function recordFile(profilePath = profile) {
    return join(profileDir(profilePath), "browser.json");
  }

  async function browserRecord(profilePath = profile) {
    return JSON.parse(await readFile(recordFile(profilePath), "utf8"));
  }

  async function ruleCalls() {
    return (await calls("hyprctl")).filter((call) => call.argv[0] === "repl").map((call) => call.argv[1]);
  }

  async function ordered() {
    return (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Call & { tool: string });
  }

  function startTime(pid: number) {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    return text.slice(text.lastIndexOf(")") + 2).split(" ")[19];
  }

  function runNativeAsync(args: string[], env: Record<string, string> = {}) {
    const child = spawn(process.execPath, [script, ...args], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: root,
        BB_BROWSER_HOME: home,
        FAKE_LOG: log,
        FAKE_SESSION_FILE: join(root, "sessions.json"),
        FAKE_DIRECT_IP: "203.0.113.10",
        ...hyprland,
        XDG_CONFIG_HOME: join(root, "config"),
        FAKE_ROOT: root,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    return new Promise<{ status: number | null; stderr: string }>((done) => child.on("close", (status) => done({ status, stderr })));
  }

  async function until(check: () => boolean | Promise<boolean>, ms = 10_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  function isAlive(pid: number) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function ordinaryBrowser(host = "127.0.0.1") {
    const ordinary = join(root, "config", "BraveSoftware", "Brave-Origin");
    await mkdir(ordinary, { recursive: true });
    const child = spawn(join(bin, "brave-browser"), [
      `--user-data-dir=${ordinary}`, "--class=ordinary-brave", "--remote-debugging-port=0",
    ], { env: { ...process.env, FAKE_LOG: log, FAKE_ROOT: root, FAKE_BRAVE_HOST: host }, stdio: "ignore" });
    expect(await until(async () => { try { await readFile(join(ordinary, "ready")); return true; } catch { return false; } })).toBe(true);
    const port = (await readFile(join(ordinary, "ready"), "utf8")).trim();
    return { child, port, env: { BB_BROWSER_BACKEND: "existing", BB_BROWSER_CDP_PORT: port, XDG_CONFIG_HOME: join(root, "config") } };
  }

  it("attaches to regular Brave without launching, hiding, importing state, or stopping it", async () => {
    const { child, port, env } = await ordinaryBrowser();
    const before = (await launches()).length;
    expect(run(["provision"], { input: JSON.stringify({ state: JSON.stringify({ cookies: [{ name: "sid", value: SECRET, domain: "example.com" }] }) }) }).status).toBe(0);
    expect(run(["open", "https://example.com"], { env }).stderr).toBe("");
    expect(run(["snapshot"], { env }).status).toBe(0);
    expect(run(["close", "--all"], { env }).status).toBe(0);
    expect(isAlive(child.pid!)).toBe(true);
    expect((await launches()).length).toBe(before);
    expect(await calls("hyprctl")).toEqual([]);
    const attached = (await calls("agent-browser")).filter((call) => call.argv.includes("--cdp"));
    expect(attached).toHaveLength(2);
    for (const call of attached) {
      expect(flag(call.argv, "--cdp")).toBe(`http://127.0.0.1:${port}`);
      expect(call.argv).toContain("--pin-tab");
      for (const name of ["--state", "--user-agent", "--args", "--executable-path", "--proxy"]) expect(call.argv).not.toContain(name);
    }
    expect((await calls("agent-browser")).some((call) => call.argv.includes("load"))).toBe(false);
  });

  it("rejects an existing Brave debugging listener exposed beyond loopback", async () => {
    const { child, env } = await ordinaryBrowser("0.0.0.0");
    const result = run(["snapshot"], { env });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("listen only on loopback");
    expect(isAlive(child.pid!)).toBe(true);
    expect(await calls("agent-browser")).toEqual([]);
  });

  it("refuses attachment to a different process's port without touching regular Brave", async () => {
    const { child, env } = await ordinaryBrowser();
    const result = run(["snapshot"], { env: { ...env, BB_BROWSER_CDP_PORT: "1" } });
    expect(result.status).toBe(1);
    expect(isAlive(child.pid!)).toBe(true);
    expect(await calls("agent-browser")).toEqual([]);
  });

  it("launches the dedicated profile once and reuses it over loopback CDP without UA or state flags", async () => {
    // Explicit native launches without the configured user agent; doctor only
    // checks it.
    expect(run(["provision"], { input: JSON.stringify({ userAgent: UA }) }).status).toBe(0);
    for (const args of [["open", "https://example.com"], ["snapshot"], ["eval", "document.title"]]) {
      const result = runNative(args, { BB_BROWSER_BACKEND: "native" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }

    const [launch, ...again] = await launches();
    expect(again).toEqual([]);
    const windowClass = launch.argv.find((arg) => arg.startsWith("--class="))?.slice("--class=".length);
    expect(windowClass).toMatch(/^bb-browser-[0-9a-f]{12}$/);
    const port = Number(launch.argv.find((arg) => arg.startsWith("--remote-debugging-port="))?.split("=")[1]);
    expect(port).toBeGreaterThanOrEqual(20_000);
    expect(port).toBeLessThan(32_768);

    const record = await browserRecord();
    expect(record).toMatchObject({ profile, windowClass, port });
    expect((await stat(recordFile())).mode & 0o777).toBe(0o600);
    expect((await stat(profileDir())).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, "native"))).mode & 0o777).toBe(0o700);
    expect((await stat(profile)).mode & 0o777).toBe(0o700);

    const commands = (await calls("agent-browser")).filter((call) => !call.argv.includes("list"));
    expect(commands).toHaveLength(3);
    for (const call of commands) {
      expect(flag(call.argv, "--cdp")).toBe(String(record.port));
      expect(call.argv).toContain("--pin-tab");
      expect(flag(call.argv, "--namespace")).toMatch(/^bb-trusted-native-[0-9a-f]{12}$/);
      for (const name of ["--user-agent", "--state", "--args", "--executable-path", "--proxy"]) {
        expect(call.argv).not.toContain(name);
      }
    }

    // Every command adds the rule again and checks the window.
    const rules = (await ruleCalls()).filter((lua) => lua.includes("hl.window_rule"));
    expect(rules).toHaveLength(3);
    expect(new Set(rules).size).toBe(1);
    expect((await calls("hyprctl")).filter((call) => call.argv[0] === "clients").length).toBeGreaterThanOrEqual(3);
    const lua = rules[0];
    expect(lua).toContain(`match = { class = "^${windowClass}$" }`);
    expect(lua).toContain('workspace = "8 silent"');
    expect(lua).toContain("no_initial_focus = true");
    expect(lua).toContain("focus_on_activate = false");
    // Hyprland would tile the window to the workspace and ignore --window-size.
    expect(lua).toContain('float = false');
    expect(lua).not.toContain('size =');
    expect(lua).toContain('suppress_event = "activate activatefocus"');
  });

  it("moves legacy parked windows silently but leaves user-placed windows alone", async () => {
    expect(runNative(["open", "https://example.com"]).status).toBe(0);
    const {pid} = await browserRecord();
    const clientPath = join(root,"clients",pid+".json");
    const client = JSON.parse(await readFile(clientPath,"utf8"));
    await writeFile(clientPath,JSON.stringify({...client,address:"0xabc",floating:false}));
    expect(runNative(["layout","tile"]).status).toBe(0);
    const moves = (await ruleCalls()).filter(lua=>lua.includes("hl.dsp.window.move"));
    expect(moves).toHaveLength(1);
    expect(moves[0]).toContain('workspace = "8", follow = false');
    expect(moves[0]).toContain('window = "address:0xabc"');
    await writeFile(clientPath,JSON.stringify({...client,address:"0xabc",workspace:{name:"3"}}));
    expect(runNative(["layout","tile"]).status).toBe(0);
    expect((await ruleCalls()).filter(lua=>lua.includes("hl.dsp.window.move"))).toHaveLength(1);
  });

  it("gives each session its own tab and keeps one managed Brave after the last close", async () => {
    expect(runNative(["--session", "a", "open", "https://example.com"]).status).toBe(0);
    expect(runNative(["--session", "b", "open", "https://example.org"]).status).toBe(0);
    const { pid } = await browserRecord();

    expect(runNative(["--session", "a", "close"]).status).toBe(0);
    const tabClose = (await calls("agent-browser")).filter((call) => call.argv.includes("tab") && call.argv.includes("close"));
    expect(tabClose).toHaveLength(1);
    expect(flag(tabClose[0].argv, "--session")).toBe("a");
    expect(isAlive(pid)).toBe(true);
    // The closed session starts again on a new tab, not the one it closed.
    expect(runNative(["--session", "a", "open", "https://example.com"])).toMatchObject({ status: 0, stderr: "" });
    expect(runNative(["--session", "a", "close"]).status).toBe(0);

    const sessions = runNative(["session", "list"]);
    expect(sessions.status).toBe(0);
    expect(flag((await calls("agent-browser")).at(-1)!.argv, "--cdp")).toBeUndefined();

    expect(runNative(["--session", "b", "close"]).status).toBe(0);
    expect((await calls("agent-browser")).filter((call) => call.argv.includes("tab") && call.argv.includes("close"))).toHaveLength(3);
    expect(isAlive(pid)).toBe(true);
    await stat(recordFile());
    expect((await ruleCalls()).filter((lua) => lua.includes("hl.dsp.window.close"))).toEqual([]);
    const lifecyclePath = join(profileDir(), "lifecycle.jsonl");
    const lifecycle = (await readFile(lifecyclePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lifecycle.map((entry) => entry.event)).toEqual([
      "launch-started",
      "running",
      "sessions-closed",
    ]);
    expect(lifecycle.at(-1)).toMatchObject({ pid, method: "detach", clean: true });
    expect((await stat(lifecyclePath)).mode & 0o777).toBe(0o600);
    expect(await readFile(lifecyclePath, "utf8")).not.toMatch(/example|cookie|state|user.?agent/i);
    // The profile and its sign-ins persist; the next launch uses it again.
    await writeFile(join(profile, "Cookies"), "persisted");
    expect(runNative(["open", "about:blank"]).status).toBe(0);
    expect(await readFile(join(profile, "Cookies"), "utf8")).toBe("persisted");
    const relaunches = await launches();
    expect(relaunches).toHaveLength(1);
    expect((await browserRecord()).pid).toBe(pid);
  });

  it("cleans up after a Brave that exited on its own, resets its stale sessions, and launches a fresh one", async () => {
    expect(runNative(["--session", "a", "open", "about:blank"]).status).toBe(0);
    expect(runNative(["--session", "b", "open", "about:blank"]).status).toBe(0);
    const first = await browserRecord();
    process.kill(first.pid, "SIGKILL");
    await until(() => !isAlive(first.pid));
    expect(runNative(["--session", "b", "snapshot"]).status).toBe(0);
    const second = await browserRecord();
    expect(second.pid).not.toBe(first.pid);
    expect(await launches()).toHaveLength(2);
    // Each launch first clears what a previous browser left, then adds the
    // rule; a command on a live browser adds it again.
    expect(await ruleCalls().then((rules) => rules.map((lua) => (lua.includes("hl.window_rule") ? "add" : "remove")))).toEqual([
      "remove",
      "add",
      "add",
      "remove",
      "add",
    ]);

    // Both old sessions were closed, without --cdp, before the new Brave
    // started, so no pinned tab id from the old browser survives.
    const all = await ordered();
    const relaunch = all.findIndex((call) => call.tool === "brave-browser" && call.argv.includes(`--remote-debugging-port=${second.port}`));
    const resets = all
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.tool === "agent-browser" && call.argv.at(-1) === "close" && !call.argv.includes("--cdp"));
    expect(resets.map(({ call }) => flag(call.argv, "--session")).sort()).toEqual(["a", "b"]);
    for (const { index } of resets) expect(index).toBeLessThan(relaunch);
    const snapshot = all.filter((call) => call.tool === "agent-browser" && call.argv.includes("snapshot"));
    expect(flag(snapshot[0].argv, "--cdp")).toBe(String(second.port));
  });

  it("clears tab ids that closed sessions remember before a new Brave starts", async () => {
    const xdg = join(root, "xdg");
    const runtime = join(xdg, "bb-browser");
    const namespace = `bb-trusted-native-${profileDir().split("/").at(-1)}`;
    expect(runNative(["--session", "a", "open", "about:blank"], { XDG_RUNTIME_DIR: xdg }).status).toBe(0);
    // agent-browser writes this and keeps it after the session closes.
    const target = join(runtime, "namespaces", namespace, "run", "a.target");
    // Another profile's namespace is left alone.
    const other = join(runtime, "namespaces", "bb-trusted-native-000000000000", "run", "a.target");
    await mkdir(dirname(other), { recursive: true });
    await writeFile(other, "{}");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, '{"targetId":"OLD","pinned":true}');
    const first = await browserRecord();
    process.kill(first.pid, "SIGKILL");
    await until(() => !isAlive(first.pid));

    expect(runNative(["--session", "a", "open", "about:blank"], { XDG_RUNTIME_DIR: xdg }).status).toBe(0);
    // The old tab id is gone; the session pinned a new tab.
    expect(await readFile(target, "utf8")).toBe("open");
    expect(await readFile(other, "utf8")).toBe("{}");
    expect((await stat(runtime)).mode & 0o777).toBe(0o700);
    for (const call of (await calls("agent-browser")).filter((call) => !call.argv.includes("--version"))) {
      expect(call.env.AGENT_BROWSER_SOCKET_DIR).toBe(runtime);
    }

    // The last close clears it as well.
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "{}");
    expect(runNative(["--session", "a", "close"], { XDG_RUNTIME_DIR: xdg }).status).toBe(0);
    expect(await readdir(join(runtime, "namespaces"))).toEqual(["bb-trusted-native-000000000000"]);
  });

  it("refuses a debugging port reachable beyond loopback and stops that Brave", async () => {
    const result = runNative(["open", "about:blank"], { FAKE_BRAVE_HOST: "0.0.0.0" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("reachable beyond loopback");
    const pid = Number((await readFile(pids, "utf8")).trim());
    expect(isAlive(pid)).toBe(false);
    expect((await calls("agent-browser")).filter((call) => call.argv.includes("--cdp"))).toEqual([]);
    expect((await calls("hyprctl")).at(-1)!.argv[1]).toContain("set_enabled(false)");
    await expect(stat(recordFile())).rejects.toThrow();
  });

  it("fails closed when Hyprland does not add the hiding rule", async () => {
    const result = runNative(["open", "about:blank"], { FAKE_HYPR_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("did not add the browser workspace rule");
    expect(await launches()).toEqual([]);
  });

  it("never attaches to a profile another Brave holds", async () => {
    await mkdir(profile, { recursive: true });
    await symlink(`${hostname()}-${process.pid}`, join(profile, "SingletonLock"));
    const result = runNative(["open", "about:blank"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is open in another Brave");
    expect(await launches()).toEqual([]);
    expect((await ruleCalls()).filter((lua) => lua.includes("hl.window_rule"))).toEqual([]);
  });

  it.each([
    [{ BB_BROWSER_PROFILE: "Brave-Origin" }, ["open", "about:blank"], "ordinary profile"],
    [{ BB_BROWSER_PROFILE: "Brave-Browser" }, ["open", "about:blank"], "ordinary profile"],
    [{ BB_BROWSER_BACKEND: "native" }, ["--state-name", "work", "open", "about:blank"], "imported states do not apply"],
    [{ BB_BROWSER_BACKEND: "native", BB_BROWSER_STATE: "work" }, ["open", "about:blank"], "imported states do not apply"],
    [{}, ["--args", "--window-size=800,600", "open", "about:blank"], "--args does not apply"],
    [{}, ["--cdp", "9222", "snapshot"], "--cdp is set by bb-browser"],
    [{}, ["--session", "bb-browser-state", "open", "about:blank"], "is reserved for bb-browser"],
    [{ BB_BROWSER_BACKEND: "chrome" }, ["open", "about:blank"], 'backend must be "native", "agent", or "existing"'],
  ])("refuses %j %j in native mode", async (env, args, message) => {
    const result = runNative(args, env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(await launches()).toEqual([]);
  });

  it("checks the native browser in doctor, including the configured user agent, without changing focus", async () => {
    expect(run(["provision"], { input: JSON.stringify({ userAgent: UA }) }).status).toBe(0);
    const result = runNative(["doctor"], { BB_BROWSER_BACKEND: "native", FAKE_UA: UA });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/ok\s+backend\s+native/);
    expect(result.stdout).toContain("the configured user agent is checked, never applied");
    expect(result.stdout).toContain("navigator.userAgent matches exactly");
    expect(result.stdout).toContain("navigator.webdriver is false");
    expect(result.stdout).toContain("new windows use workspace 8");
    const pid = Number((await readFile(pids, "utf8")).trim());
    expect(isAlive(pid)).toBe(true);
    await stat(recordFile());
    for (const call of await calls("agent-browser")) expect(call.argv).not.toContain("--user-agent");
  });

  it("fails native doctor when Brave's own user agent differs from the configured one", async () => {
    expect(run(["provision"], { input: JSON.stringify({ userAgent: UA }) }).status).toBe(0);
    const result = runNative(["doctor"], { BB_BROWSER_BACKEND: "native", FAKE_UA: "Mozilla/5.0 (X11; Linux x86_64) Chrome/154.0.0.0 Safari/537.36" });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("different user agent than the one configured");
    const pid = Number((await readFile(pids, "utf8")).trim());
    expect(isAlive(pid)).toBe(true);
  });

  it("fails native doctor when navigator.webdriver is true and still detaches", async () => {
    const result = runNative(["doctor"], { FAKE_UA: "Mozilla/5.0 (X11; Linux x86_64) Chrome/154.0.0.0 Safari/537.36", FAKE_WEBDRIVER: "true" });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("navigator.webdriver as true");
    const pid = Number((await readFile(pids, "utf8")).trim());
    expect(isAlive(pid)).toBe(true);
  });

  it.each([
    ["a user agent", { input: { userAgent: UA }, env: {} }],
    ["a required state", { input: { requiredState: "default" }, env: {} }],
    ["BB_BROWSER_STATE", { input: null, env: { BB_BROWSER_STATE: "none" } }],
  ])("chooses the agent backend automatically when %s is configured", async (_name, setup) => {
    if (setup.input) expect(run(["provision"], { input: JSON.stringify(setup.input) }).status).toBe(0);
    runNative(["open", "about:blank"], setup.env);
    expect(await launches()).toEqual([]);
    expect(await calls("hyprctl")).toEqual([]);
    for (const call of await calls("agent-browser")) expect(call.argv).not.toContain("--cdp");
    const doctor = runNative(["doctor", "--offline"], setup.env);
    expect(doctor.stdout).toMatch(/backend\s+agent.*keeps the native backend off/);
  });

  it("chooses the agent backend automatically when a default state was imported", async () => {
    const state = join(root, "state.json");
    await writeFile(state, JSON.stringify({ cookies: [{ name: "sid", value: SECRET, domain: "example.com" }] }));
    expect(runNative(["state", "import", "default", state]).status).toBe(0);
    runNative(["open", "about:blank"]);
    expect(await launches()).toEqual([]);
    expect(await calls("hyprctl")).toEqual([]);
  });

  // Imports a default state the way the weekly refresh does; returns its revision.
  async function importDefault(value: string) {
    const file = join(root, "state.json");
    await writeFile(file, JSON.stringify({ cookies: [{ name: "sid", value, domain: "secret.example" }] }));
    expect(runNative(["state", "import", "default", file]).status).toBe(0);
    return createHash("sha256").update(await readFile(join(home, "state", "default.json"))).digest("hex");
  }

  async function stateLoads() {
    return (await calls("agent-browser")).filter((call) => call.argv.includes("load"));
  }

  function expectNoSecrets(result: { stdout: string; stderr: string }, ...more: string[]) {
    for (const text of [SECRET, "secret.example", ...more]) {
      expect(result.stdout).not.toContain(text);
      expect(result.stderr).not.toContain(text);
    }
  }

  it("loads the trusted default state into an explicit native profile once per revision, never through --state", async () => {
    const native = { BB_BROWSER_BACKEND: "native" };
    const first = await importDefault(SECRET);
    const marker = join(profileDir(), "state-applied");
    const opened = runNative(["open", "about:blank"], native);
    expect(opened).toMatchObject({ status: 0, stderr: "" });
    expectNoSecrets(opened, first);

    const [load, ...more] = await stateLoads();
    expect(more).toEqual([]);
    const { port } = await browserRecord();
    expect(flag(load.argv, "--cdp")).toBe(String(port));
    expect(flag(load.argv, "--session")).toBe("bb-browser-state");
    expect(load.argv.slice(-3)).toEqual(["state", "load", join(home, "state", "default.json")]);
    expect(load.argv).not.toContain("--state");
    for (const launch of await launches()) expect(launch.argv.some((arg) => arg.startsWith("--state"))).toBe(false);
    expect(await readFile(marker, "utf8")).toBe(`${first}\n`);
    expect((await stat(marker)).mode & 0o777).toBe(0o600);
    // It loads before the command runs, then closes its tab, since Brave's
    // blank one remains, and its session.
    const all = await ordered();
    const stateCalls = all.filter((call) => call.tool === "agent-browser" && flag(call.argv, "--session") === "bb-browser-state");
    expect(stateCalls.map((call) => call.argv.slice(call.argv.indexOf("bb-browser-state") + 1))).toEqual([
      ["state", "load", join(home, "state", "default.json")],
      ["--json", "tab", "list"],
      ["tab", "close"],
      ["close"],
    ]);
    expect(all.indexOf(stateCalls[3])).toBeLessThan(all.findIndex((call) => call.argv.includes("open")));

    // The same revision is not loaded again.
    expect(runNative(["snapshot"], native).status).toBe(0);
    expect(await stateLoads()).toHaveLength(1);

    // A refreshed state loads on the next command, into the running browser.
    const second = await importDefault(`changed-${SECRET}`);
    expect(second).not.toBe(first);
    const again = runNative(["--session", "b", "open", "about:blank"], native);
    expect(again).toMatchObject({ status: 0, stderr: "" });
    expectNoSecrets(again, first, second);
    expect(await stateLoads()).toHaveLength(2);
    expect((await browserRecord()).port).toBe(port);
    expect(await launches()).toHaveLength(1);
    expect(await readFile(marker, "utf8")).toBe(`${second}\n`);
    const tabClose = (await calls("agent-browser")).filter(
      (call) => call.argv.includes("tab") && call.argv.includes("close") && flag(call.argv, "--session") === "bb-browser-state",
    );
    expect(tabClose).toHaveLength(2);
    expect(runNative(["session", "list"], native).stdout).not.toContain("bb-browser-state");
  });

  it("leaves the state session's tab open when it is the browser's only one", async () => {
    await importDefault(SECRET);
    expect(runNative(["open", "about:blank"], { BB_BROWSER_BACKEND: "native", FAKE_NO_BLANK_TAB: "1" }).status).toBe(0);
    const stateCalls = (await calls("agent-browser")).filter((call) => flag(call.argv, "--session") === "bb-browser-state");
    expect(stateCalls.map((call) => call.argv.at(-1))).toEqual([join(home, "state", "default.json"), "list", "close"]);
    expect(stateCalls[2].argv).not.toContain("tab");
  });

  it("keeps native Brave and its loaded state across closes, then reloads after a crash", async () => {
    const native = { BB_BROWSER_BACKEND: "native" };
    await importDefault(SECRET);
    const marker = join(profileDir(), "state-applied");
    expect(runNative(["open", "about:blank"], native).status).toBe(0);
    const first = await browserRecord();
    expect(runNative(["close", "--all"], native).status).toBe(0);
    expect(isAlive(first.pid)).toBe(true);
    await stat(marker);
    expect(runNative(["open", "about:blank"], native).status).toBe(0);
    expect((await browserRecord()).pid).toBe(first.pid);
    expect(await stateLoads()).toHaveLength(1);
    expect((await ruleCalls()).filter((lua) => lua.includes("hl.dsp.window.close"))).toEqual([]);

    // Brave crashed: the next command loads the state again.
    process.kill(first.pid, "SIGKILL");
    await until(() => !isAlive(first.pid));
    expect(runNative(["open", "about:blank"], native).status).toBe(0);
    expect(await stateLoads()).toHaveLength(2);
    await stat(marker);
  });

  it("fails closed when the trusted state does not load, keeps the marker, and loads it on the next command", async () => {
    const native = { BB_BROWSER_BACKEND: "native" };
    const revision = await importDefault(SECRET);
    const marker = join(profileDir(), "state-applied");
    const failed = runNative(["open", "about:blank"], { ...native, FAKE_STATE_LOAD_FAIL: "1" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("could not load bb-browser's trusted state into the native profile");
    expectNoSecrets(failed, revision);
    await expect(stat(marker)).rejects.toThrow();
    expect((await calls("agent-browser")).filter((call) => call.argv.includes("open"))).toEqual([]);
    // The browser started for that command is stopped.
    const [pid] = (await readFile(pids, "utf8")).trim().split("\n").map(Number);
    expect(isAlive(pid)).toBe(false);
    await expect(stat(recordFile())).rejects.toThrow();

    expect(runNative(["open", "about:blank"], native)).toMatchObject({ status: 0, stderr: "" });
    expect(await stateLoads()).toHaveLength(2);
    expect(await readFile(marker, "utf8")).toBe(`${revision}\n`);

    // A failed reload into a running browser keeps it and the old marker.
    await importDefault(`changed-${SECRET}`);
    const { pid: running } = await browserRecord();
    expect(runNative(["snapshot"], { ...native, FAKE_STATE_LOAD_FAIL: "1" }).status).toBe(1);
    expect(isAlive(running)).toBe(true);
    expect(await readFile(marker, "utf8")).toBe(`${revision}\n`);
  });

  it("verifies in doctor that the trusted state is loaded at its current revision", async () => {
    const native = { BB_BROWSER_BACKEND: "native" };
    const revision = await importDefault(SECRET);
    const offline = runNative(["doctor", "--offline"], native);
    expect(offline.status).toBe(0);
    expect(offline.stdout).toMatch(/ok\s+state\s+.*default\.json changed since it was last loaded, or never was/);

    const live = runNative(["doctor"], native);
    expect(live).toMatchObject({ status: 0, stderr: "" });
    expect(live.stdout).toContain("the trusted state is loaded at its current revision");
    expectNoSecrets(live, revision);
    // Doctor detached its session but kept the native browser and marker.
    expect(runNative(["doctor", "--offline"], native).stdout).toMatch(/ok\s+state\s+.*default\.json is loaded into the native profile at its current revision/);

    // A refreshed state that does not load fails the live check.
    await importDefault(`changed-${SECRET}`);
    const stale = runNative(["doctor"], { ...native, FAKE_STATE_LOAD_FAIL: "1" });
    expect(stale.status).toBe(1);
    expect(stale.stdout).toMatch(/FAIL\s+live\s+.*could not load bb-browser's trusted state/);
    expectNoSecrets(stale, revision);
  });

  it("keeps required-state semantics on the native backend", async () => {
    const native = { BB_BROWSER_BACKEND: "native" };
    expect(run(["provision"], { input: JSON.stringify({ requiredState: "default" }) }).status).toBe(0);
    const missing = runNative(["open", "about:blank"], native);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('auth state "default" is required but is not imported');

    await importDefault(SECRET);
    expect(run(["provision"], { input: JSON.stringify({ requiredState: "work" }) }).status).toBe(0);
    const other = runNative(["open", "about:blank"], native);
    expect(other.status).toBe(1);
    expect(other.stderr).toContain("the native backend loads only the default state");
    expect(await launches()).toEqual([]);
  });

  it.each([
    [["cookies", "clear"], "cookies clear is refused"],
    [["storage", "local", "clear"], "storage local clear is refused"],
    [["storage", "session", "clear"], "storage session clear is refused"],
    [["set", "credentials", "user", "pass"], "set credentials is refused"],
    [["--idle-timeout", "10s", "open", "about:blank"], "--idle-timeout"],
    [["state", "save", "work"], "state save is refused on the native backend"],
  ])("refuses %j on the persistent native profile", async (args, message) => {
    const result = runNative(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(await launches()).toEqual([]);
    expect((await calls("agent-browser")).filter((call) => !call.argv.includes("list"))).toEqual([]);
  });

  it("allows reading and setting cookies and storage, which persist in the profile", async () => {
    for (const args of [["cookies", "get"], ["cookies", "set", "a", "b"], ["storage", "local", "get"], ["storage", "local", "set", "k", "v"]]) {
      expect(runNative(args).status).toBe(0);
    }
  });

  it("keeps two profiles' browsers, records, and rules apart when they run at once", async () => {
    const other = join(root, "config", "BraveSoftware", "bb-browser-second");
    const [first, second] = await Promise.all([
      runNativeAsync(["open", "about:blank"]),
      runNativeAsync(["open", "about:blank"], { BB_BROWSER_PROFILE: "bb-browser-second" }),
    ]);
    expect(first).toMatchObject({ status: 0, stderr: "" });
    expect(second).toMatchObject({ status: 0, stderr: "" });
    const a = await browserRecord();
    const b = await browserRecord(other);
    expect(a.pid).not.toBe(b.pid);
    expect(a.windowClass).not.toBe(b.windowClass);
    expect(profileDir()).not.toBe(profileDir(other));

    // A record forged to name the other profile's browser is not trusted, and
    // closing either profile never terminates a native browser.
    await writeFile(recordFile(), JSON.stringify({ ...b }));
    const before = (await ruleCalls()).length;
    expect(runNative(["close", "--all"]).status).toBe(0);
    expect(isAlive(b.pid)).toBe(true);
    expect(isAlive(a.pid)).toBe(true);
    expect((await ruleCalls()).slice(before).filter((lua) => lua.includes("set_enabled(false)") && !lua.includes("hl.window_rule"))).toEqual([]);

    expect(runNative(["close"], { BB_BROWSER_PROFILE: "bb-browser-second" }).status).toBe(0);
    expect(isAlive(b.pid)).toBe(true);
  });

  it("keeps Brave running when a close races a command that already holds a lease", async () => {
    expect(runNative(["--session", "a", "open", "about:blank"]).status).toBe(0);
    const { pid, port } = await browserRecord();
    // b has verified the browser and holds its lease, but has not opened its
    // session yet when a closes the last listed session.
    const pending = runNativeAsync(["--session", "b", "open", "https://example.org"], { FAKE_OPEN_DELAY_MS: "1500" });
    expect(await until(async () => (await readdir(join(profileDir(), "leases")).catch(() => [])).length > 0)).toBe(true);
    expect(runNative(["--session", "a", "close"]).status).toBe(0);
    expect(isAlive(pid)).toBe(true);
    expect(await pending).toMatchObject({ status: 0, stderr: "" });
    expect(isAlive(pid)).toBe(true);
    expect((await browserRecord()).port).toBe(port);
    expect(await readdir(join(profileDir(), "leases"))).toEqual([]);

    expect(runNative(["--session", "b", "close"]).status).toBe(0);
    expect(isAlive(pid)).toBe(true);
  });

  it("counts only live leases from the same process and never terminates on close", async () => {
    expect(runNative(["open", "about:blank"]).status).toBe(0);
    const { pid } = await browserRecord();
    const leases = join(profileDir(), "leases");
    // A lease whose pid was reused by another process is stale.
    await writeFile(join(leases, String(process.pid)), "1");
    expect(runNative(["--session", "x", "close"]).status).toBe(0);
    expect(isAlive(pid)).toBe(true);
    expect(runNative(["close"]).status).toBe(0);
    expect(isAlive(pid)).toBe(true);
    await expect(stat(join(leases, String(process.pid)))).rejects.toThrow();

    expect(runNative(["open", "about:blank"]).status).toBe(0);
    const second = await browserRecord();
    await writeFile(join(leases, String(process.pid)), startTime(process.pid));
    expect(runNative(["close"]).status).toBe(0);
    expect(isAlive(second.pid)).toBe(true);
    expect(runNative(["close", "--all"]).status).toBe(0);
    expect(isAlive(second.pid)).toBe(true);
  });

  it("keeps agent-browser's runtime directory while another command holds a lease, even after close --all", async () => {
    const xdg = join(root, "xdg");
    const namespace = `bb-trusted-native-${profileDir().split("/").at(-1)}`;
    // What a command that holds a lease writes as it starts its session.
    const starting = join(xdg, "bb-browser", "namespaces", namespace, "run", "b.target");
    expect(runNative(["--session", "a", "open", "about:blank"], { XDG_RUNTIME_DIR: xdg }).status).toBe(0);
    const { pid } = await browserRecord();
    const lease = join(profileDir(), "leases", String(process.pid));
    await writeFile(lease, startTime(process.pid));
    await mkdir(dirname(starting), { recursive: true });
    await writeFile(starting, "{}");

    expect(runNative(["--session", "a", "close"], { XDG_RUNTIME_DIR: xdg }).status).toBe(0);
    expect(isAlive(pid)).toBe(true);
    expect(await readFile(starting, "utf8")).toBe("{}");
    expect(runNative(["close", "--all"], { XDG_RUNTIME_DIR: xdg }).status).toBe(0);
    expect(isAlive(pid)).toBe(true);
    expect(await readFile(starting, "utf8")).toBe("{}");

    // With no lease left, close clears only the idle agent runtime.
    await rm(lease);
    expect(runNative(["close"], { XDG_RUNTIME_DIR: xdg }).status).toBe(0);
    await expect(stat(starting)).rejects.toThrow();
  });

  it("preserves Brave and manual work when its window moves to another workspace", async () => {
    expect(runNative(["open", "about:blank"]).status).toBe(0);
    const { pid } = await browserRecord();
    const client = join(root, "clients", `${pid}.json`);
    await writeFile(client, JSON.stringify({ ...JSON.parse(await readFile(client, "utf8")), workspace: { name: "1" } }));
    const result = runNative(["snapshot"]);
    expect(result.status).toBe(0);
    expect(isAlive(pid)).toBe(true);
    expect((await browserRecord()).pid).toBe(pid);
  });

  it("preserves Brave when the compositor rule fails, and rejects an unexpected window class", async () => {
    expect(runNative(["open", "about:blank"]).status).toBe(0);
    const { pid } = await browserRecord();
    const failed = runNative(["snapshot"], { FAKE_HYPR_FAIL: "1" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("did not add the browser workspace rule");
    expect(isAlive(pid)).toBe(true);
    // A fresh profile with an unexpected class is still refused at launch.
    const result = runNative(["open", "about:blank"], { BB_BROWSER_PROFILE: "test-class-other", FAKE_WINDOW_CLASS: "brave-browser" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has class brave-browser");
    expect((await ruleCalls()).at(-1)).toContain("set_enabled(false)");
    await expect(stat(recordFile())).resolves.toBeDefined();
    const launched = (await readFile(pids, "utf8")).trim().split("\n").map(Number);
    expect(isAlive(pid)).toBe(true);
    for (const each of launched.filter(each => each !== pid)) expect(isAlive(each)).toBe(false);
  });

  it("keeps the agent-browser launch in sandboxes and when the agent backend is chosen", async () => {
    expect(run(["provision"], { input: JSON.stringify({ userAgent: UA }) }).status).toBe(0);
    expect(runNative(["open", "about:blank"], { IS_SANDBOX: "1", BB_BROWSER_EGRESS: "direct" }).status).toBe(0);
    expect(runNative(["open", "about:blank"], { BB_BROWSER_BACKEND: "agent" }).status).toBe(0);
    for (const call of await calls("agent-browser")) {
      if (call.argv.includes("list")) continue;
      expect(flag(call.argv, "--executable-path")).toBe(join(bin, "brave-browser"));
      expect(flag(call.argv, "--user-agent")).toBe(UA);
      expect(call.argv).not.toContain("--cdp");
    }
    expect(await launches()).toEqual([]);
    expect(await calls("hyprctl")).toEqual([]);

    const forced = runNative(["open", "about:blank"], { IS_SANDBOX: "1", BB_BROWSER_EGRESS: "direct", BB_BROWSER_BACKEND: "native" });
    expect(forced.status).toBe(1);
    expect(forced.stderr).toContain("the native backend is local only");
  });

  it("does not choose the native backend without Hyprland", async () => {
    expect(run(["open", "about:blank"], { env: { XDG_CONFIG_HOME: join(root, "config") } }).status).toBe(0);
    expect(await launches()).toEqual([]);
    const forced = run(["open", "about:blank"], { env: { BB_BROWSER_BACKEND: "native" } });
    expect(forced.status).toBe(1);
    expect(forced.stderr).toContain("needs a Hyprland Wayland session");
  });
});


describe("authoritative cookie snapshots", () => {
  const settings = { BB_BROWSER_BACKEND: "agent", BB_BROWSER_EGRESS: "direct" };
  const sync = (cookies: unknown[]) => run(["state", "sync", "default"], { input: JSON.stringify({ cookies, origins: [] }) });
  it("accepts an empty sync, but keeps rejecting an empty ordinary import", () => {
    expect(sync([]).status).toBe(0);
    expect(run(["state", "sync", "default"], { input: "{}" }).status).toBe(1);
    expect(run(["state", "import", "work"], { input: '{"cookies":[]}' }).status).toBe(1);
    const result = run(["state", "sync", "default"], { input: `invalid-${SECRET}` });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain(SECRET);
  });
  it("applies changed cookies and deletions to running sessions without closing their tabs", async () => {
    sync([{ name: "sid", value: SECRET, domain: "example.com" }]);
    expect(run(["open", "https://example.com"], { env: settings }).status).toBe(0);
    expect(run(["snapshot"], { env: settings }).status).toBe(0);
    const before = await calls("agent-browser");
    expect(run(["snapshot"], { env: settings }).status).toBe(0);
    expect((await calls("agent-browser")).slice(before.length).some((call) => call.argv.includes("load"))).toBe(false);
    sync([]);
    const result = run(["snapshot"], { env: settings });
    expect(result.status).toBe(0); expect(result.stdout + result.stderr).not.toContain(SECRET);
    const changed = (await calls("agent-browser")).slice(before.length);
    expect(changed.some((call) => call.argv.includes("cookies") && call.argv.includes("clear"))).toBe(true);
    expect(changed.some((call) => call.argv.includes("load"))).toBe(true);
    expect(changed.some((call) => call.argv.includes("close"))).toBe(false);
  });
  it("fails the command if loading the fresh cookies fails", () => {
    sync([{ name: "sid", value: SECRET, domain: "example.com" }]);
    expect(run(["open", "https://example.com"], { env: settings }).status).toBe(0);
    sync([]);
    const result = run(["snapshot"], { env: { ...settings, FAKE_STATE_LOAD_FAIL: "1" } });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain(SECRET);
    expect(result.stderr).toContain("could not apply live cookie sync");
  });
  it("preserves sync semantics when the plugin provisions a sandbox", async () => {
    expect(run(["provision"], { input: JSON.stringify({ requiredState: "default", state: JSON.stringify({ cookies: [], origins: [], bbCookieSync: true }) }) }).status).toBe(0);
    expect(JSON.parse(await readFile(join(home, "state/default.json"), "utf8")).bbCookieSync).toBe(true);
  });
});

describe("native cookie merge", () => {
  type Cookie = { name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string; expires?: number };
  const cookie = (name: string, extra: Partial<Cookie> = {}): Cookie => ({
    name, value: SECRET, domain: "secret.example", path: "/", ...extra,
  });

  async function merge(current: Cookie[], previous: Cookie[], cookies: Cookie[], rejectWrites = false) {
    // Execute the shipped worker with an in-memory protocol peer, never a live browser.
    const source = await readFile(script, "utf8");
    const worker = source.match(/const THREAD_CDP = String.raw`([\s\S]*?)`;/)![1];
    const key = (c: Cookie) => JSON.stringify([c.name, c.domain, c.path || "/"]);
    const jar = new Map(current.map(c => [key(c), { ...c }]));
    let stdout = "", stderr = "", status = 0;
    class Peer {
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      close() {}
      send(message: string) {
        const { id, method, params } = JSON.parse(message);
        let result = {}, error: {message:string}|undefined;
        if (method === "Storage.getCookies") result = { cookies: [...jar.values()] };
        else if (method === "Storage.setCookies") {
          for (const c of params.cookies as Cookie[]) {
            const prefixed = c.name.startsWith("__Secure-") || c.name.startsWith("__Host-");
            const invalidHost = c.name.startsWith("__Host-") && (c.domain.startsWith(".") || c.path !== "/");
            if (rejectWrites || (prefixed && !c.secure) || invalidHost || (c.sameSite === "None" && !c.secure)) {
              error = { message: `Invalid cookie fields: ${c.name} ${c.domain} ${SECRET}` };
              break;
            }
            if (c.expires !== undefined && c.expires > 0 && c.expires < Date.now() / 1000) jar.delete(key(c));
            else jar.set(key(c), { ...c });
          }
        } else throw new Error(`Unexpected mock method: ${method}`);
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, result, error }) }));
      }
    }
    await runInNewContext(worker, {
      require: (name: string) => {
        if (name !== "node:fs") throw new Error(`Unexpected mock module: ${name}`);
        return { readFileSync: () => JSON.stringify({ port: 12345, op: "syncCookies", current, previous, cookies }) };
      },
      fetch: async () => ({ json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:12345/mock" }) }),
      WebSocket: Peer, URL, setTimeout, clearTimeout,
      process: {
        stdout: { write: (text: string) => { stdout += text; } },
        stderr: { write: (text: string) => { stderr += text; } },
        exit: (code: number) => { status = code; },
      },
    });
    return { cookies: [...jar.values()], stdout, stderr, status };
  }

  it.each([
    cookie("ordinary"),
    cookie("__Secure-session", { secure: true, httpOnly: true, sameSite: "None" }),
    cookie("__Host-session", { secure: true, httpOnly: true, sameSite: "Lax" }),
  ])("removes an unchanged deleted source cookie: $name", async (deleted) => {
    const next = cookie("fresh", { value: "next-source" });
    const result = await merge([deleted], [deleted], [next]);
    expect(result).toMatchObject({ status: 0, stderr: "", cookies: [next] });
    expect(result.stdout).toBe("{}");
  });

  it("preserves agent-local values and security attributes while applying source changes", async () => {
    const removed = cookie("__Host-deleted", { secure: true, httpOnly: true });
    const previous = [
      removed, cookie("__Secure-local", { secure: true }), cookie("attributes"),
      cookie("updated"), cookie("locally-deleted"),
    ];
    const local = [
      cookie("__Secure-local", { secure: true, value: "agent-login" }),
      cookie("attributes", { secure: true, httpOnly: true }),
      cookie("agent-only", { value: "agent-created" }),
    ];
    const updated = cookie("updated", { value: "new-source" });
    const result = await merge(
      [removed, ...local, cookie("updated")], previous,
      [updated, cookie("locally-deleted", { value: "source-refresh" })],
    );
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.cookies).toEqual([...local, updated]);
  });

  it("fails closed without exposing cookie data from protocol errors", async () => {
    const deleted = cookie("__Host-session", { secure: true, httpOnly: true });
    const result = await merge([deleted], [deleted], [], true);
    expect(result.status).toBe(1);
    expect(result.cookies).toEqual([deleted]);
    expect(result.stderr).toBe("Browser window operation failed: Storage.setCookies");
    expect(result.stdout).toBe("");
    for (const secret of [SECRET, deleted.name, deleted.domain]) {
      expect(result.stdout + result.stderr).not.toContain(secret);
    }
  });
});

describe("native tab group prerequisites", () => {
  it.each([false, true])("wakes an idle worker and handles an already-detached session (%s)", async (alreadyDetached) => {
    const source = await readFile(script, "utf8");
    const worker = source.match(/const THREAD_CDP = String.raw`([\s\S]*?)`;/)![1];
    let stdout = "", stderr = "", awake = false;
    const methods: string[] = [];
    class Peer {
      onopen?: () => void;
      onmessage?: (event: {data:string}) => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      close() {}
      send(message:string) {
        const {id,method,params,sessionId} = JSON.parse(message);
        methods.push(method);
        let result: Record<string,unknown> = {};
        if (method === "Target.getTargets") result = {targetInfos:[
          {type:"page",targetId:"owned",url:"about:blank"},
          ...(awake ? [{type:"service_worker",targetId:"worker",url:"chrome-extension://fixture/background.js"}] : []),
        ]};
        else if (method === "Browser.getWindowForTarget") result = {windowId:1};
        else if (method === "Target.attachToTarget") result = {sessionId:params.targetId};
        else if (method === "ServiceWorker.startWorker") {
          expect(sessionId).toBe("owned");
          expect(params.scopeURL).toBe("chrome-extension://fixture/");
          awake = true;
        } else if (method === "Runtime.evaluate") {
          expect(sessionId).toBe("worker");
          if (params.expression.startsWith("typeof globalThis.__bbGroupTargets")) result = {result:{value:"function"}};
          else expect(params.expression).toContain('["owned"]');
        } else if (!["ServiceWorker.enable","Target.detachFromTarget"].includes(method)) throw Error(method);
        const response = alreadyDetached && method === "Target.detachFromTarget"
          ? {id,error:{message:"Session with given id not found."}}
          : {id,result};
        queueMicrotask(() => this.onmessage?.({data:JSON.stringify(response)}));
      }
    }
    await runInNewContext(worker, {
      require:() => ({readFileSync:() => JSON.stringify({
        port:12345,op:"group",extensionOrigin:"chrome-extension://fixture",label:"Fixture",
        record:{browserKey:"/mock",windowId:1,tabOrder:["owned"],sessions:{default:"owned"}},
      })}),
      fetch:async () => ({json:async () => ({webSocketDebuggerUrl:"ws://127.0.0.1:12345/mock"})}),
      WebSocket:Peer,URL,setTimeout,clearTimeout,
      process:{stdout:{write:(text:string) => {stdout+=text;}},stderr:{write:(text:string) => {stderr+=text;}},exit:() => {}},
    });
    expect(stderr).toBe("");
    expect(stdout).toBe("{}");
    expect(methods).toContain("ServiceWorker.startWorker");
    expect(methods).not.toContain("Target.createTarget");
    expect(methods).not.toContain("Target.activateTarget");
  });
  it("reports the missing extension without mutating another thread or exposing its target", async () => {
    const source = await readFile(script, "utf8");
    const worker = source.match(/const THREAD_CDP = String.raw`([\s\S]*?)`;/)![1];
    let stdout = "", stderr = "", status = 0;
    const methods: string[] = [];
    class Peer {
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      close() {}
      send(message: string) {
        const { id, method } = JSON.parse(message);
        methods.push(method);
        if (method !== "Target.getTargets") throw Error("Unexpected mutation in prerequisite check");
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({
          id, result: { targetInfos: [{ type: "page", targetId: SECRET, title: SECRET, url: `https://secret.example/${SECRET}` }] },
        }) }));
      }
    }
    await runInNewContext(worker, {
      require: () => ({ readFileSync: () => JSON.stringify({
        port: 12345, op: "group", extensionOrigin: "chrome-extension://fixture",
      }) }),
      fetch: async () => ({ json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:12345/mock" }) }),
      WebSocket: Peer, URL, setTimeout, clearTimeout,
      process: {
        stdout: { write: (text: string) => { stdout += text; } },
        stderr: { write: (text: string) => { stderr += text; } },
        exit: (code: number) => { status = code; },
      },
    });
    expect(status).toBe(1);
    expect(stderr).toContain("[NATIVE_GROUP_EXTENSION_REQUIRED]");
    expect(stdout).toBe("");
    expect(stdout + stderr).not.toContain(SECRET);
    expect(methods.every(method => method === "Target.getTargets")).toBe(true);
  });
});

describe("native group helper readiness", () => {
  async function runGroup(readyOnProbe: number, outcome: "ok" | "probe-timeout" | "group-timeout" | "group-error" = "ok") {
    const source = await readFile(script, "utf8");
    const worker = source.match(/const THREAD_CDP = String.raw`([\s\S]*?)`;/)![1];
    let probes = 0, invocations = 0, status = 0, stdout = "", stderr = "";
    class Peer {
      onopen?: () => void;
      onmessage?: (event: {data: string}) => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      close() {}
      send(message: string) {
        const {id, method, params} = JSON.parse(message);
        let result: Record<string, unknown> = {};
        if (method === "Target.getTargets") result = {targetInfos: [
          {type: "service_worker", targetId: "worker", url: "chrome-extension://fixture/background.js"},
        ]};
        else if (method === "Target.attachToTarget") result = {sessionId: "worker"};
        else if (method === "Runtime.evaluate") {
          if (params.expression.startsWith("typeof globalThis.__bbGroupTargets")) {
            probes++;
            if (outcome === "probe-timeout") return;
            result = {result: {value: probes >= readyOnProbe ? "function" : "undefined"}};
          } else {
            invocations++;
            if (outcome === "group-timeout") return;
            result = outcome === "group-error" || probes < readyOnProbe
              ? {exceptionDetails: {exception: {description: "TypeError: globalThis.__bbGroupTargets is not a function"}}}
              : {result: {value: {grouped: 0}}};
          }
        } else if (method !== "Target.detachFromTarget") throw Error(`Unexpected synthetic method: ${method}`);
        queueMicrotask(() => this.onmessage?.({data: JSON.stringify({id, result})}));
      }
    }
    vi.useFakeTimers();
    const start = Date.now();
    try {
      const execution = runInNewContext(worker, {
        require: () => ({readFileSync: () => JSON.stringify({
          port: 12345, op: "group", extensionOrigin: "chrome-extension://fixture", label: "Fixture",
        })}),
        fetch: async () => ({json: async () => ({webSocketDebuggerUrl: "ws://127.0.0.1:12345/mock"})}),
        WebSocket: Peer, URL, Date, setTimeout, clearTimeout,
        process: {
          stdout: {write: (text: string) => {stdout += text;}},
          stderr: {write: (text: string) => {stderr += text;}},
          exit: (code: number) => {status = code;},
        },
      });
      await vi.runAllTimersAsync();
      await execution;
      return {probes, invocations, status, stdout, stderr, elapsed: Date.now() - start};
    } finally { vi.useRealTimers(); }
  }

  it.each([1, 3])("groups once only after the helper is ready on probe %s", async (readyOnProbe) => {
    const result = await runGroup(readyOnProbe);
    expect(result).toMatchObject({status: 0, stderr: "", stdout: "{}", invocations: 1, probes: readyOnProbe});
  });

  it("fails closed within the readiness budget when the helper stays missing", async () => {
    const result = await runGroup(Infinity);
    expect(result.status).toBe(1);
    expect(result.invocations).toBe(0);
    expect(result.probes).toBeGreaterThan(1);
    expect(result.elapsed).toBeLessThanOrEqual(2000);
    expect(result.stderr).toContain("[NATIVE_GROUP_NOT_READY]");
  });

  it("bounds a nonresponding readiness probe without invoking grouping", async () => {
    const result = await runGroup(1, "probe-timeout");
    expect(result).toMatchObject({status: 1, invocations: 0, probes: 1});
    expect(result.elapsed).toBeLessThanOrEqual(2000);
    expect(result.stderr).toContain("[NATIVE_GROUP_NOT_READY]");
  });

  it.each(["group-timeout", "group-error"] as const)("never replays grouping after %s", async (outcome) => {
    const result = await runGroup(1, outcome);
    expect(result).toMatchObject({status: 1, invocations: 1, probes: 1});
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(outcome === "group-timeout" ? "deadline" : "Native grouping failed");
  });
});
