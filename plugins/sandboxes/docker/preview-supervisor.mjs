#!/usr/bin/env node

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { connect as connectSocket } from "node:net";
import { basename, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root =
  process.env.BB_SANDBOX_PREVIEW_DIR ??
  `${process.env.BB_DATA_DIR ?? `${process.env.HOME ?? "/root"}/.bb`}/sandbox-previews`;
const specsDir = join(root, "specs");
const logsDir = join(root, "logs");
const supervisorPidFile = join(root, "supervisor.pid");
const scriptPath = fileURLToPath(import.meta.url);
const children = new Map();
const retries = new Map();
let stopping = false;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function ensureDirectories() {
  mkdirSync(specsDir, { recursive: true, mode: 0o700 });
  mkdirSync(logsDir, { recursive: true, mode: 0o700 });
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`Invalid preview port: ${value ?? "missing"}`);
  }
  return port;
}

function validName(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value);
}

function validEnvironmentName(value) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value);
}

function specPath(name) {
  return join(specsDir, `${name}.json`);
}

function normalizedPublicUrl(value) {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("public URL must be an HTTP(S) origin");
  }
  return url.origin;
}

function normalizedCanonicalOrigin(value) {
  const url = new URL(value);
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    url.protocol !== "http:" ||
    !loopbackHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "canonical origin must be an HTTP loopback origin such as http://localhost:3000",
    );
  }
  return url.origin;
}

function originPort(origin) {
  const url = new URL(origin);
  return Number(url.port || 80);
}

function readSpec(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof parsed.name !== "string" ||
      !validName(parsed.name) ||
      !Number.isInteger(parsed.port) ||
      parsed.port < 1 ||
      parsed.port > 65535 ||
      typeof parsed.cwd !== "string" ||
      !Array.isArray(parsed.command) ||
      parsed.command.length === 0 ||
      parsed.command.some((part) => typeof part !== "string" || part.length === 0) ||
      (parsed.publicUrl !== undefined &&
        normalizedPublicUrl(parsed.publicUrl) !== parsed.publicUrl) ||
      (parsed.publicUrlEnv !== undefined &&
        (typeof parsed.publicUrlEnv !== "string" ||
          !validEnvironmentName(parsed.publicUrlEnv))) ||
      (parsed.canonicalOrigin !== undefined &&
        normalizedCanonicalOrigin(parsed.canonicalOrigin) !== parsed.canonicalOrigin) ||
      (parsed.canonicalOrigin !== undefined &&
        originPort(parsed.canonicalOrigin) === parsed.port)
    ) {
      throw new Error("invalid fields");
    }
    return parsed;
  } catch (error) {
    process.stderr.write(`Ignoring invalid preview spec ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
    return null;
  }
}

function writeSpec(spec) {
  ensureDirectories();
  const path = specPath(spec.name);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(spec, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function isListening(port) {
  return new Promise((resolveListening) => {
    const socket = connectSocket({ host: "127.0.0.1", port });
    const finish = (value) => {
      socket.destroy();
      resolveListening(value);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function processIsSupervisor(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    const command = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return command.includes(basename(scriptPath)) && command.includes("supervise");
  } catch {
    return false;
  }
}

function currentSupervisorPid() {
  try {
    const pid = Number(readFileSync(supervisorPidFile, "utf8").trim());
    return processIsSupervisor(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function ensureSupervisor() {
  ensureDirectories();
  if (currentSupervisorPid() !== null) return;
  const child = spawn(process.execPath, [scriptPath, "supervise"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (currentSupervisorPid() !== null) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  fail("Preview supervisor did not start");
}

function rotateLog(path) {
  try {
    if (statSync(path).size < 5 * 1024 * 1024) return;
    const previous = `${path}.1`;
    if (existsSync(previous)) unlinkSync(previous);
    renameSync(path, previous);
  } catch {
    // A missing log needs no rotation.
  }
}

function previewEnvironment(spec) {
  const environment = { ...process.env };
  for (const key of [
    "BB_CONNECT_MACHINE_CREDENTIAL",
    "BB_SANDBOX_GIT_TOKEN",
    "BB_SANDBOX_GIT_USERNAME",
    "BB_SANDBOX_GIT_SSH_PRIVATE_KEY",
    "BB_SANDBOX_GIT_KNOWN_HOSTS",
    "BB_SANDBOX_OMP_AUTH_DB_GZIP_BASE64",
    "BB_SANDBOX_CLAUDE_AUTH_BASE64",
    "BB_SANDBOX_CODEX_AUTH_BASE64",
  ]) {
    delete environment[key];
  }
  if (spec.publicUrl) {
    const publicUrlEnv = spec.publicUrlEnv ?? "BB_PREVIEW_URL";
    if (publicUrlEnv !== "BB_PREVIEW_URL") delete environment.BB_PREVIEW_URL;
    environment[publicUrlEnv] = spec.publicUrl;
  }
  return environment;
}

function proxyRequestHeaders(headers, spec, websocket = false) {
  const deliveryOrigin = `http://127.0.0.1:${spec.port}`;
  if ((headers.host ?? "").toLowerCase() !== `127.0.0.1:${spec.port}`) {
    return null;
  }
  if (headers.origin && headers.origin !== deliveryOrigin) return null;
  if (headers.referer) {
    try {
      const refererOrigin = new URL(headers.referer).origin;
      if (
        refererOrigin !== deliveryOrigin &&
        refererOrigin !== spec.publicUrl
      ) {
        return null;
      }
    } catch {
      return null;
    }
  }
  const canonical = new URL(spec.canonicalOrigin);
  const forwarded = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (!websocket && HOP_BY_HOP_HEADERS.has(name)) continue;
    if (
      websocket &&
      HOP_BY_HOP_HEADERS.has(name) &&
      name !== "connection" &&
      name !== "upgrade"
    ) {
      continue;
    }
    if (name === "proxy-connection") continue;
    if (name === "host" || name === "origin" || name === "referer") continue;
    forwarded[name] = value;
  }
  forwarded.host = canonical.host;
  if (headers.origin) forwarded.origin = canonical.origin;
  if (headers.referer) forwarded.referer = `${canonical.origin}/`;
  return forwarded;
}

function writeUpgradeRequest(socket, req, headers, head) {
  socket.write(`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/${req.httpVersion}\r\n`);
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) socket.write(`${name}: ${entry}\r\n`);
    } else if (value !== undefined) {
      socket.write(`${name}: ${value}\r\n`);
    }
  }
  socket.write("\r\n");
  if (head.length > 0) socket.write(head);
}

function createCanonicalProxy(spec, logPath) {
  const targetPort = originPort(spec.canonicalOrigin);
  const server = createHttpServer((req, res) => {
    const headers = proxyRequestHeaders(req.headers, spec);
    if (headers === null) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Forbidden preview origin");
      return;
    }
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: targetPort,
        method: req.method,
        path: req.url,
        headers,
      },
      (upstreamResponse) => {
        const headers = {};
        for (const [name, value] of Object.entries(upstreamResponse.headers)) {
          if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name)) {
            headers[name] = value;
          }
        }
        res.writeHead(upstreamResponse.statusCode ?? 502, headers);
        upstreamResponse.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end("Preview upstream unavailable");
    });
    req.pipe(upstream);
  });
  server.on("upgrade", (req, downstream, head) => {
    const headers = proxyRequestHeaders(req.headers, spec, true);
    if (headers === null) {
      downstream.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = connectSocket(
      { host: "127.0.0.1", port: targetPort },
      () => {
        writeUpgradeRequest(
          upstream,
          req,
          headers,
          head,
        );
        downstream.pipe(upstream).pipe(downstream);
      },
    );
    upstream.once("error", () => downstream.destroy());
    downstream.once("error", () => upstream.destroy());
  });
  server.once("error", (error) => {
    writeFileSync(logPath, `[supervisor] canonical proxy failed: ${error.message}\n`, {
      flag: "a",
      mode: 0o600,
    });
    stopChild(spec.name);
  });
  server.listen(spec.port, "127.0.0.1");
  return server;
}

function launch(spec) {
  const logPath = join(logsDir, `${spec.name}.log`);
  rotateLog(logPath);
  const log = openSync(logPath, "a", 0o600);
  const startedAt = Date.now();
  const child = spawn(spec.command[0], spec.command.slice(1), {
    cwd: spec.cwd,
    env: previewEnvironment(spec),
    detached: true,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  const proxy = spec.canonicalOrigin
    ? createCanonicalProxy(spec, logPath)
    : null;
  children.set(spec.name, {
    child,
    proxy,
    fingerprint: JSON.stringify(spec),
    startedAt,
  });
  child.once("error", (error) => {
    writeFileSync(logPath, `[supervisor] could not start: ${error.message}\n`, { flag: "a", mode: 0o600 });
  });
  child.once("exit", () => {
    const current = children.get(spec.name);
    if (current?.child !== child) return;
    children.delete(spec.name);
    current.proxy?.close();
    const previous = retries.get(spec.name) ?? { failures: 0, nextStartAt: 0 };
    const ranFor = Date.now() - startedAt;
    const failures = ranFor >= 10_000 ? 0 : Math.min(previous.failures + 1, 5);
    retries.set(spec.name, {
      failures,
      nextStartAt: Date.now() + Math.min(30_000, 1_000 * 2 ** failures),
    });
  });
}

function stopChild(name) {
  const current = children.get(name);
  if (!current) return;
  children.delete(name);
  current.proxy?.close();
  try {
    process.kill(-current.child.pid, "SIGTERM");
  } catch {
    current.child.kill("SIGTERM");
  }
  setTimeout(() => {
    if (current.child.exitCode !== null) return;
    try {
      process.kill(-current.child.pid, "SIGKILL");
    } catch {
      current.child.kill("SIGKILL");
    }
  }, 5_000).unref();
}

async function reconcile() {
  const specs = new Map();
  for (const file of readdirSync(specsDir).filter((entry) => entry.endsWith(".json"))) {
    const spec = readSpec(join(specsDir, file));
    if (spec !== null) specs.set(spec.name, spec);
  }
  for (const name of children.keys()) {
    const spec = specs.get(name);
    const current = children.get(name);
    if (spec === undefined || current?.fingerprint !== JSON.stringify(spec)) stopChild(name);
  }
  for (const spec of specs.values()) {
    if (children.has(spec.name)) continue;
    if (await isListening(spec.port)) continue;
    const retry = retries.get(spec.name);
    if (retry && retry.nextStartAt > Date.now()) continue;
    launch(spec);
  }
}

async function supervise() {
  ensureDirectories();
  const otherPid = currentSupervisorPid();
  if (otherPid !== null && otherPid !== process.pid) process.exit(0);
  writeFileSync(supervisorPidFile, `${process.pid}\n`, { mode: 0o600 });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const name of children.keys()) stopChild(name);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    while (!stopping) {
      await reconcile();
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
  } finally {
    try {
      if (Number(readFileSync(supervisorPidFile, "utf8").trim()) === process.pid) {
        unlinkSync(supervisorPidFile);
      }
    } catch {
      // The next supervisor validates stale pid files against /proc.
    }
  }
}

async function start(args) {
  let port = null;
  let name = null;
  let cwd = process.cwd();
  let waitSeconds = 60;
  let expose = true;
  let publicUrlEnv = "BB_PREVIEW_URL";
  let canonicalOrigin;
  let commandIndex = -1;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--") {
      commandIndex = index + 1;
      break;
    }
    if (value === "--port") port = parsePort(args[++index]);
    else if (value === "--name") name = args[++index];
    else if (value === "--cwd") cwd = resolve(args[++index]);
    else if (value === "--wait-seconds") waitSeconds = Number(args[++index]);
    else if (value === "--no-expose") expose = false;
    else if (value === "--public-url-env") {
      publicUrlEnv = args[++index];
      if (!validEnvironmentName(publicUrlEnv ?? "")) {
        fail(`Invalid --public-url-env: ${publicUrlEnv ?? "missing"}`);
      }
    }
    else if (value === "--canonical-origin") {
      try {
        canonicalOrigin = normalizedCanonicalOrigin(args[++index]);
      } catch (error) {
        fail(`Invalid --canonical-origin: ${error.message}`);
      }
    }
    else fail(`Unknown start option: ${value}`);
  }
  if (port === null) fail("start requires --port <port>");
  name ??= `port-${port}`;
  if (!validName(name)) fail(`Invalid preview name: ${name}`);
  if (!Number.isFinite(waitSeconds) || waitSeconds <= 0 || waitSeconds > 600) {
    fail(`Invalid --wait-seconds value: ${waitSeconds}`);
  }
  const command = commandIndex < 0 ? [] : args.slice(commandIndex);
  if (command.length === 0) fail("start requires -- <command> [args...]");
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) fail(`Preview cwd does not exist: ${cwd}`);
  if (canonicalOrigin && originPort(canonicalOrigin) === port) {
    fail("--canonical-origin must use a different port than --port");
  }
  let publicUrl;
  if (expose) {
    const exposed = spawnSync("bb", ["connect", "expose", String(port), "--json"], {
      cwd,
      encoding: "utf8",
      env: process.env,
    });
    if (exposed.status !== 0) fail(exposed.stderr.trim() || "Could not expose preview port");
    try {
      publicUrl = normalizedPublicUrl(JSON.parse(exposed.stdout).url);
    } catch {
      fail("Could not read the public preview URL from bb connect expose");
    }
  }
  const spec = {
    name,
    port,
    cwd,
    command,
    ...(publicUrl ? { publicUrl, publicUrlEnv } : {}),
    ...(canonicalOrigin ? { canonicalOrigin } : {}),
    updatedAt: Date.now(),
  };
  writeSpec(spec);
  await ensureSupervisor();
  const deadline = Date.now() + waitSeconds * 1_000;
  while (Date.now() < deadline) {
    const publicReady = await isListening(port);
    const upstreamReady = canonicalOrigin
      ? await isListening(originPort(canonicalOrigin))
      : true;
    if (publicReady && upstreamReady) {
      if (expose) {
        process.stdout.write(`${publicUrl}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(spec)}\n`);
      }
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  fail(`Preview ${name} did not listen on port ${port} within ${waitSeconds} seconds. Check ${join(logsDir, `${name}.log`)}`);
}

async function stop(args) {
  ensureDirectories();
  const name = args[0];
  if (!name || !validName(name)) fail("Usage: bb-sandbox-preview stop <name>");
  try {
    unlinkSync(specPath(name));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  process.stdout.write(`Stopped supervised preview ${name}\n`);
}

function list() {
  ensureDirectories();
  const specs = readdirSync(specsDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => readSpec(join(specsDir, entry)))
    .filter((entry) => entry !== null);
  process.stdout.write(`${JSON.stringify({ previews: specs }, null, 2)}\n`);
}

const [action, ...args] = process.argv.slice(2);
if (action === "supervise") await supervise();
else if (action === "ensure") await ensureSupervisor();
else if (action === "start") await start(args);
else if (action === "stop") await stop(args);
else if (action === "list") list();
else {
  fail("Usage: bb-sandbox-preview <ensure|start --port PORT [--name NAME] [--cwd PATH] [--public-url-env NAME] [--canonical-origin URL] -- COMMAND...|stop NAME|list>");
}
