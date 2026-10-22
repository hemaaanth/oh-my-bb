import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserCookieConnection } from "../src/browser-cookie-connection.js";
import { browserExtensionOrigin } from "../src/browser-extension-download.js";
import { NO_TRUSTED_BROWSER } from "../src/trusted-browser.js";
import { spawnSync } from "node:child_process";

const disposers: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of disposers.splice(0)) await dispose(); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "paired-cookie-test-"));
  disposers.push(() => rm(directory, { recursive: true, force: true }));
  const fake = createFakePluginHost({ pluginId: "sandboxes", loopbackBaseUrl: "http://127.0.0.1:38886" });
  disposers.push(() => fake.harness.lifecycle.dispose());
  const local = vi.fn(async () => ({ ok: true }));
  const connection = new BrowserCookieConnection(fake.bb, directory, local);
  await connection.register();
  const origin = await browserExtensionOrigin();
  const post = (path: string, body: unknown, token?: string, overrideOrigin = origin) => fake.harness.behavior.fetchHttp("POST", `/cookie-sync/${path}`, {
    headers: { "content-type": "application/json", origin: overrideOrigin, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  const pair = async () => {
    const pairing = await connection.beginPairing();
    const response = await post("pair", { code: pairing.code });
    expect(response.status).toBe(200);
    return { ...(await response.json()) as { token: string }, ...pairing };
  };
  return { ...fake, connection, local, post, pair, directory, origin };
}
it("pairs once with an expiring code and persists only token hashes", async () => {
  const { connection, pair, post, harness, bb } = await setup();
  const { code, token } = await pair();
  expect((await post("pair", { code })).status).toBe(401);
  expect((await connection.status()).paired).toBe(true);
  const stored = JSON.stringify(await bb.storage.kv.get("browser-cookie-connection"));
  expect(stored).not.toContain(token); expect(stored).not.toContain(code);
  expect(JSON.stringify(harness.logEntries)).not.toContain(token);
});
it("rejects expired codes, foreign origins, and unauthenticated snapshots", async () => {
  const { connection, post } = await setup();
  const pending = await connection.beginPairing();
  vi.spyOn(Date, "now").mockReturnValue(pending.expiresAt + 1);
  expect((await post("pair", { code: pending.code })).status).toBe(401);
  expect((await post("pair", { code: pending.code }, undefined, "https://untrusted.test")).status).toBe(403);
  expect((await post("snapshot", { cookies: [] })).status).toBe(401);
});
it("stores private snapshots, hides values, handles deletion, and selects the managed source automatically", async () => {
  const { pair, post, connection, harness, local } = await setup();
  const { token } = await pair();
  const cookie = { name: "sid", value: "cookie-SECRET", domain: "example.test", path: "/", secure: true, httpOnly: true, session: true };
  const response = await post("snapshot", { cookies: [cookie] }, token);
  expect(response.status).toBe(200); expect(await response.text()).not.toContain("cookie-SECRET");
  expect((await stat(connection.stateFile)).mode & 0o777).toBe(0o600);
  expect(await readFile(connection.stateFile, "utf8")).toContain("cookie-SECRET");
  expect((await connection.settings(NO_TRUSTED_BROWSER)).browserStateFile).toBe(connection.stateFile);
  expect(local).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(harness.logEntries)).not.toContain("cookie-SECRET");
  await post("snapshot", { cookies: [] }, token);
  expect(JSON.parse(await readFile(connection.stateFile, "utf8")).cookies).toEqual([]);
});
it("exports without depending on a local CLI and revokes a replaced or disconnected browser", async () => {
  const { pair, post, connection, local } = await setup();
  local.mockResolvedValue({ ok: false });
  const first = await pair();
  expect((await post("snapshot", { cookies: [] }, first.token)).status).toBe(200);
  expect((await connection.status()).localImported).toBe(false);
  const next = await pair();
  expect((await post("snapshot", { cookies: [] }, first.token)).status).toBe(401);
  expect((await post("snapshot", { cookies: [] }, next.token)).status).toBe(200);
  await connection.disconnect();
  expect((await post("snapshot", { cookies: [] }, next.token)).status).toBe(401);
  expect((await connection.settings(NO_TRUSTED_BROWSER)).browserStateFile).toBe("");
});
it("bounds request bodies and keeps the last valid snapshot after malformed input", async () => {
  const { pair, post, connection } = await setup();
  const { token } = await pair();
  await post("snapshot", { cookies: [] }, token);
  expect((await post("snapshot", { cookies: [{ value: "secret" }] }, token)).status).toBe(400);
  expect(JSON.parse(await readFile(connection.stateFile, "utf8")).cookies).toEqual([]);
  expect((await post("snapshot", { cookies: [], padding: "x".repeat(5 * 1024 * 1024) }, token)).status).toBe(413);
});
it("downloads a portable extension ZIP containing no native helper", async () => {
  const { connection } = await setup();
  const { extensionZip } = await connection.beginPairing();
  const zip = Buffer.from(extensionZip, "base64");
  const result = spawnSync("python3", ["-c", "import sys,zipfile,io,json; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; m=json.loads(z.read('manifest.json')); assert 'nativeMessaging' not in m['permissions']; assert 'options.js' in z.namelist(); assert m['action']['default_popup'] == 'popup.html'; assert all(f in z.namelist() for f in ['popup.html','popup.js','extension.css','inter.woff2','bb.svg',*m['icons'].values()])"], { input: zip });
  expect(result.status).toBe(0);
});
