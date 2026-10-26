// Opt in on a machine with Brave and agent-browser installed. Uses a fresh profile.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { BrowserCookieConnection } from "../src/browser-cookie-connection.js";
import { browserExtensionOrigin } from "../src/browser-extension-download.js";

it.runIf(process.env.BB_TEST_REAL_BROWSER === "1")("pairs and syncs live Brave cookies directly to BB with no native helper", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bb-paired-live-"));
  let dispatch: ((path: string, init: RequestInit) => Promise<Response>) | undefined;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(name, value);
      const result = await dispatch!(request.url!.replace("/api/v1/plugins/browser/http", ""), {
        method: request.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { bb, harness } = createFakePluginHost({ pluginId: "browser", loopbackBaseUrl: address });
  const connection = new BrowserCookieConnection(bb, join(directory, "state"), async () => ({ ok: true }));
  await connection.register();
  dispatch = (path, init) => harness.behavior.fetchHttp(init.method!, path, init);
  const launcher = join(directory, "brave-test");
  const executable = process.env.BB_TEST_BRAVE_EXECUTABLE || "/opt/brave.com/brave/brave";
  await writeFile(launcher, `#!/usr/bin/python3
import os,sys
args=[arg for arg in sys.argv[1:] if arg!="--disable-extensions"]
os.execv(${JSON.stringify(executable)},[${JSON.stringify(executable)},${JSON.stringify(`--load-extension=${resolve("browser-extension")}`)}]+args)
`, { mode: 0o700 });
  const env = { ...process.env, HOME: directory, XDG_CONFIG_HOME: join(directory, "config"), BB_BROWSER_HOME: join(directory, "browser"),
    BB_BROWSER_BACKEND: "agent", BB_BROWSER_EGRESS: "direct", BB_BROWSER_STATE: "none", BB_BROWSER_EXECUTABLE: launcher };
  const browser = (args: string[]) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [resolvePath(), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(output) : reject(new Error(`bb-browser ${args[0]} failed`)));
  });
  function resolvePath() { return resolve("docker/trusted-browser.mjs"); }
  const until = async (condition: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
    throw new Error("Live cookie snapshot did not arrive");
  };
  try {
    const { code } = await connection.beginPairing();
    const origin = await browserExtensionOrigin();
    await browser(["open", `${origin}/options.html`]);
    await browser(["fill", "#server", address]);
    await browser(["fill", "#code", code]);
    await browser(["click", 'button[type="submit"]']);
    await until(async () => (await connection.status()).paired);
    await browser(["check", "#export"]);
    await browser(["cookies", "set", "bb_pair_test", "sample", "--domain", "example.test", "--path", "/"]);
    await until(async () => { try { return (await readFile(connection.stateFile, "utf8")).includes("bb_pair_test"); } catch { return false; } });
    expect((await connection.status()).cookies).toBeGreaterThan(0);
    await browser(["cookies", "clear"]);
    await until(async () => (await connection.status()).cookies === 0);
  } finally {
    await browser(["close", "--all"]).catch(() => undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await harness.lifecycle.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);
