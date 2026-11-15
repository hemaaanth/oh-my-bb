import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupBoatImageBuilds, registerBoatImage } from "../src/boat-image.js";

const reference = `ghcr.io/acme/runtime@sha256:${"a".repeat(64)}`;
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(failSmoke = false, wrongDigest = false, missingState = false) {
  const directory = await mkdtemp(join(tmpdir(), "boat-image-test-")); dirs.push(directory);
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const deleted = new Set<string>();
  const processes = new Map<number, string>();
  let allocated = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace("/api/v1", "");
    const method = init.method!;
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ method, path, body });
    if (path === "/sandboxes" && method === "POST") return Response.json({ sandbox: { id: `vm-${++allocated}`, state: "ready" } });
    if (path === "/sandboxes" && method === "GET") return Response.json({ sandboxes: [], pageInfo: { hasMore: false } });
    const id = path.split("/")[2]!;
    if (method === "DELETE") { deleted.add(id); return Response.json({ ok: true }); }
    if (path.endsWith("/commands") && method === "POST") {
      const processId = processes.size + 1; processes.set(processId, body.command); return Response.json({ processId });
    }
    if (/\/commands\/\d+$/.test(path)) {
      const command = processes.get(Number(path.split("/").at(-1)))!;
      const smoke = command.includes("; bb-sandbox-smoke-test");
      return Response.json({ running: false, exitCode: smoke && failSmoke ? 1 : 0, stderr: smoke && failSmoke ? "missing selected tool" : "", stdout: command.includes("RootFS.Layers") ? JSON.stringify([wrongDigest && command.includes("$(sudo docker inspect") ? "wrong-layer" : "source-layer"]) : command.includes("cat /usr/local/share/bb-snapshot-reference") ? (missingState ? "" : reference) : "tools verified" });
    }
    if (path.startsWith("/saved-snapshots/")) return Response.json({ snapshot: { status: "ready" } });
    if (method === "GET" && path.startsWith("/sandboxes/")) return deleted.has(id) ? new Response(null, { status: 404 }) : Response.json({ sandbox: { id, state: "ready" } });
    return Response.json({ ok: true });
  }));
  const input = { apiKey: "boat-key", name: "bb-sandbox-v1", pinnedReference: reference,
    registry: { repository: "ghcr.io/acme/runtime", username: "owner", token: "registry-secret", platform: "linux/amd64" }, journalDirectory: directory };
  return { directory, calls, input };
}

it("prepares, saves and restores the shared image before returning an activatable snapshot", async () => {
  const { directory, calls, input } = await fixture();
  const result = await registerBoatImage({ ...input, onName: name => { calls.push({ method: "CHECKPOINT", path: name, body: {} }); } });
  expect(calls[0]).toMatchObject({ method: "CHECKPOINT", path: result.name });
  expect(result.name).toMatch(/^bb-sandbox-v1-[a-f0-9]{8}$/);
  const creates = calls.filter(c => c.method === "POST" && c.path === "/sandboxes");
  expect(creates.map(c => c.body)).toEqual([
    expect.objectContaining({ noEnv: true, ttlSeconds: 7200 }),
    expect.objectContaining({ from: result.name, noEnv: true }),
  ]);
  const commands = calls.filter(c => c.path.endsWith("/commands")).map(c => c.body.command);
  expect(commands.some(c => String(c).includes(`pull '${reference}'`))).toBe(true);
  expect(commands.some(c => String(c).includes("bb-sandbox-smoke-test"))).toBe(true);
  const ready = commands.findIndex(c => String(c).includes("for attempt"));
  expect(ready).toBeGreaterThan(-1);
  expect(commands.findIndex(c => String(c).includes("$(sudo docker inspect"))).toBeGreaterThan(ready);
  expect(commands.some(c => String(c).includes("docker tag"))).toBe(true);
  expect(commands.some(c => String(c).includes("-v bb-sandbox-root:/bb-runtime"))).toBe(true);
  expect(commands.some(c => String(c).includes("--tmpfs /bb-runtime/tmp"))).toBe(true);
  expect(commands.join("\n")).not.toContain("registry-secret");
  expect(calls.filter(c => c.method === "DELETE").map(c => c.path)).toEqual(["/sandboxes/vm-1", "/sandboxes/vm-2"]);
  expect(await readdir(directory)).toEqual([]);
});

it("deletes an unverified snapshot and temporary VMs when restored tool verification fails", async () => {
  const { calls, input, directory } = await fixture(true);
  await expect(registerBoatImage(input)).rejects.toThrow("missing selected tool");
  expect(calls.filter(c => c.method === "DELETE").map(c => c.path)).toEqual([
    "/sandboxes/vm-1", "/sandboxes/vm-2", expect.stringMatching(/^\/saved-snapshots\/bb-sandbox-v1-/),
  ]);
  expect(await readdir(directory)).toEqual([]);
});

it("replays interrupted build cleanup without deleting a verified snapshot", async () => {
  const { input, calls, directory } = await fixture();
  await writeFile(join(directory, "prior.json"), JSON.stringify({ name: "previous-build", ids: ["vm-previous"], saved: true, verified: true }));
  await cleanupBoatImageBuilds(directory, input.apiKey, () => {});
  expect(calls.filter(c => c.method === "DELETE").map(c => c.path)).toEqual(["/sandboxes/vm-previous"]);
  expect(await readdir(directory)).toEqual([]);
});

it("rejects a restored container with a different image before activation", async () => {
  const { input, calls } = await fixture(false, true);
  await expect(registerBoatImage(input)).rejects.toThrow("wrong image layers");
  expect(calls.filter(c => c.method === "DELETE")).toHaveLength(3);
});

it("rejects a restore that loses writable runtime state", async () => {
  const { input, calls } = await fixture(false, false, true);
  await expect(registerBoatImage(input)).rejects.toThrow("did not preserve the prepared container filesystem");
  expect(calls.filter(c => c.method === "DELETE")).toHaveLength(3);
});
