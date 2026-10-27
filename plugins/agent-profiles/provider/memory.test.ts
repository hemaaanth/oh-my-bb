import { randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentMemoryBusyError, AgentMemoryTurn } from "./bridge/agent-memory";
import { isolatePiTestEnv } from "./bridge/test-support";
import { materializeHempi } from "./bridge/hempi-extension";
import { MEMORY_GUARD_FILE } from "./memory-contract";
import { memorySignature } from "./memory-auth";
import { AgentMemoryHost } from "./memory-host";
import { snapshot } from "./memory-files";
import { startMemoryFixture } from "./memory-test-support";

let root: string;
let fixture: Awaited<ReturnType<typeof startMemoryFixture>>;
let thread = 0;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "bb-agent-memory-test-"));
  isolatePiTestEnv(root);
  fixture = await startMemoryFixture(root);
});
afterEach(async () => { await fixture.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const centralProfile = () => join(root, "optchat/profiles/agent-engineer");
async function turn(hostId: "primary" | "remote" | "remote2" = "remote", signal = new AbortController().signal) {
  const env = await fixture.env(`thread-${++thread}`, "engineer", hostId);
  return new AgentMemoryTurn({ memoryKey: "agent-engineer", env: { ...process.env, ...env }, dataDir: fixture.dataDirs[hostId], signal, onLost: (error) => { throw error; } });
}
const workingProfile = (turn: AgentMemoryTurn) => join(turn.homeOverride!, "profiles/agent-engineer");
async function nativeBindFailure(): Promise<unknown> {
  const entry = materializeHempi(fixture.hostDataDirs.primary);
  // Exercise the exact lock module materialized under this fixture's runtime dataDir.
  const pinned = await import(pathToFileURL(join(dirname(dirname(entry)), "node/src/optchat/profiles.mjs")).href);
  return pinned.holdProfile({}, centralProfile(), "agent-engineer", "native bind test", () => {}).then(async (unlock: () => Promise<void>) => { await unlock(); return null; }, (error: unknown) => error);
}

it("shares complete binary and hidden memory between remote hosts, without copying unrelated profiles", async () => {
  mkdirSync(join(root, "optchat/profiles/agent-other"), { recursive: true });
  writeFileSync(join(root, "optchat/profiles/agent-other/private.txt"), "other-profile-secret");
  writeFileSync(join(root, "optchat/last-profile"), "agent-other");
  const first = await turn(); await first.prepare();
  const original = snapshot(centralProfile());
  const interruptedGuard = join(centralProfile(), `${MEMORY_GUARD_FILE}.${randomUUID()}.tmp`);
  writeFileSync(interruptedGuard, "partial recovery marker from an interrupted atomic write");
  const working = workingProfile(first), bytes = Buffer.alloc(150_017, 0xa5);
  expect(existsSync(join(centralProfile(), MEMORY_GUARD_FILE))).toBe(true);
  expect(existsSync(join(working, MEMORY_GUARD_FILE))).toBe(false);
  mkdirSync(join(working, ".git/checkpoints"), { recursive: true });
  mkdirSync(join(working, "empty-directory"));
  writeFileSync(join(working, ".git/checkpoints/state"), Buffer.from([0, 255, 4]));
  writeFileSync(join(working, "memory.bin"), bytes);
  writeFileSync(join(working, "empty-file"), "");
  writeFileSync(join(working, "fact.txt"), "private-memory-marker");
  const changed = snapshot(working);
  expect(snapshot(centralProfile()).digest).toBe(original.digest);
  const concurrent = await turn("remote2");
  await expect(concurrent.prepare()).rejects.toBeInstanceOf(AgentMemoryBusyError);
  await concurrent.finish();
  await first.finish();
  expect(snapshot(centralProfile()).digest).toBe(changed.digest);
  expect(existsSync(join(fixture.dataDirs.remote, "memory-transfers", first.operationId))).toBe(false);
  const second = await turn("remote2"); await second.prepare();
  expect(readFileSync(join(workingProfile(second), "memory.bin"))).toEqual(bytes);
  expect(readFileSync(join(workingProfile(second), ".git/checkpoints/state"))).toEqual(Buffer.from([0, 255, 4]));
  expect(existsSync(join(workingProfile(second), "empty-directory"))).toBe(true);
  expect(readFileSync(join(workingProfile(second), "fact.txt"), "utf8")).toBe("private-memory-marker");
  expect(existsSync(join(second.homeOverride!, "profiles/agent-other"))).toBe(false);
  expect(existsSync(join(second.homeOverride!, "last-profile"))).toBe(false);
  await second.finish();
  expect(readFileSync(join(root, "optchat/last-profile"), "utf8")).toBe("agent-other");
  expect(fixture.logs).toContainEqual(expect.stringContaining(`downloaded ${original.bytes} bytes, uploaded ${changed.bytes} bytes`));
  expect(fixture.logs.join("\n")).not.toContain("private-memory-marker");
});

it("blocks a local bind if a remote copy-back fails after local preflight", async () => {
  const local = await turn("primary"); await local.prepare();
  const remote = await turn(); await remote.prepare();
  writeFileSync(join(workingProfile(remote), "fact.txt"), "must-not-be-skipped-by-local-start");
  fixture.failNextWrite(); await expect(remote.finish()).rejects.toThrow("retained");
  expect(await nativeBindFailure()).toMatchObject({ exitCode: 73, message: expect.stringContaining("requires remote memory recovery") });
  expect(existsSync(join(centralProfile(), "fact.txt"))).toBe(false);
  await local.finish();
  const recovered = await turn("primary"); await recovered.prepare();
  expect(readFileSync(join(centralProfile(), "fact.txt"), "utf8")).toBe("must-not-be-skipped-by-local-start");
  expect(await nativeBindFailure()).toBeNull();
  await recovered.finish();
});

it("holds the actual Hempi OS lock until copy-back is acknowledged", async () => {
  const running = await turn(); await running.prepare();
  const contender = new AgentMemoryHost(join(root, "contender-data"));
  const input = { operationId: randomUUID(), profile: "agent-engineer", threadId: "contender", hostId: "primary", directory: join(root, "contender-remote"), instructions: "", recover: false };
  const retain = () => ({ dispose: async () => undefined });
  expect((await contender.acquire(input, retain)).status).toBe("busy");
  let releaseCommit!: () => void, reachedCommit!: () => void;
  const gate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  const reached = new Promise<void>((resolve) => { reachedCommit = resolve; });
  fixture.beforeCall = async (method) => { if (method === "memoryCommit") { reachedCommit(); await gate; } };
  const finishing = running.finish(); await reached;
  expect((await contender.acquire(input, retain)).status).toBe("busy");
  releaseCommit(); await finishing;
  expect((await contender.acquire(input, retain)).status).toBe("acquired");
  await contender.release({ operationId: input.operationId, failed: false });
  await contender.dispose();
});

it("retains a failed copy, releases the lock, refuses stale local memory, then recovers before a local turn", async () => {
  const running = await turn(); await running.prepare();
  const original = snapshot(centralProfile()).digest;
  writeFileSync(join(workingProfile(running), "fact.txt"), "recover-this-fact");
  fixture.failNextWrite();
  await expect(running.finish()).rejects.toThrow("remote copy is retained");
  expect(snapshot(centralProfile()).digest).toBe(original);
  const state = await fixture.client.call("memoryState", { profile: "agent-engineer" }, { hostId: "primary" });
  expect(state.held).toBe(false); expect(state.pending?.phase).toBe("failed");
  expect(fixture.hosts.get("remote")!.remote({ operationId: running.operationId }).ready).toBe(true);
  fixture.offline.add("remote");
  const blocked = await turn("primary");
  await expect(blocked.prepare()).rejects.toThrow("offline"); await blocked.finish();
  expect(snapshot(centralProfile()).digest).toBe(original);
  fixture.offline.delete("remote");
  const recovered = await turn("primary"); await recovered.prepare();
  expect(readFileSync(join(workingProfile(recovered), "fact.txt"), "utf8")).toBe("recover-this-fact");
  expect((await fixture.hosts.get("primary")!.state({ profile: "agent-engineer" })).pending).toBeNull();
  expect(fixture.hosts.get("remote")!.remote({ operationId: running.operationId }).ready).toBe(false);
  expect(fixture.logs).toContainEqual(expect.stringMatching(/recovered \d+ bytes from remote/));
  await recovered.finish();
});

it("does not overwrite a newer native write during recovery", async () => {
  const running = await turn(); await running.prepare();
  writeFileSync(join(workingProfile(running), "remote.txt"), "remote-fact");
  fixture.failNextWrite(); await expect(running.finish()).rejects.toThrow("retained");
  writeFileSync(join(centralProfile(), "native.txt"), "newer-native-fact");
  const local = await turn("primary");
  await expect(local.prepare()).rejects.toThrow("Central memory changed"); await local.finish();
  expect(readFileSync(join(centralProfile(), "native.txt"), "utf8")).toBe("newer-native-fact");
  expect(existsSync(join(centralProfile(), "remote.txt"))).toBe(false);
  expect(fixture.hosts.get("remote")!.remote({ operationId: running.operationId }).ready).toBe(true);
  expect((await fixture.hosts.get("primary")!.state({ profile: "agent-engineer" })).held).toBe(false);
});

it("blocks after a worker restart until the remote turn has confirmed exit", async () => {
  const running = await turn(); await running.prepare();
  writeFileSync(join(workingProfile(running), "fact.txt"), "survives-worker-restart");
  await fixture.hosts.get("primary")!.dispose();
  fixture.hosts.set("primary", new AgentMemoryHost(fixture.hostDataDirs.primary));
  expect(await nativeBindFailure()).toMatchObject({ exitCode: 73, message: expect.stringContaining(realpathSync(workingProfile(running))) });
  const blocked = await turn("primary");
  await expect(blocked.prepare()).rejects.toThrow("has not confirmed Pi exit"); await blocked.finish();
  expect(existsSync(join(centralProfile(), "fact.txt"))).toBe(false);
  await expect(running.finish()).rejects.toThrow("retained");
  const recovered = await turn("primary"); await recovered.prepare();
  expect(readFileSync(join(workingProfile(recovered), "fact.txt"), "utf8")).toBe("survives-worker-restart");
  expect(existsSync(join(centralProfile(), MEMORY_GUARD_FILE))).toBe(false);
  await recovered.finish();
});

it.each(["moving-old", "installing-new"] as const)("recovers an interrupted %s install before allowing another turn", async (phase) => {
  const running = await turn(); await running.prepare();
  const original = snapshot(centralProfile()), next = workingProfile(running);
  writeFileSync(join(next, "fact.txt"), "survives-interrupted-install");
  const incoming = snapshot(next);
  await fixture.hosts.get("primary")!.dispose();
  const operation = join(fixture.hostDataDirs.primary, "agent-memory/operations", running.operationId);
  const backup = join(root, "optchat/profiles", `.agent-engineer.${running.operationId}.previous`);
  mkdirSync(backup);
  const oldNames = [...new Set(original.entries.map((entry) => entry.path.split("/")[0]!))];
  const newNames = [...new Set(incoming.entries.map((entry) => entry.path.split("/")[0]!))];
  writeFileSync(join(operation, "incoming.json"), JSON.stringify(incoming));
  writeFileSync(join(operation, "install.json"), JSON.stringify({ phase, oldNames, newNames }));
  for (const name of phase === "moving-old" ? oldNames.slice(0, 1) : oldNames) renameSync(join(centralProfile(), name), join(backup, name));
  if (phase === "installing-new") copyFileSync(join(next, "AGENTS.md"), join(centralProfile(), "AGENTS.md"));
  fixture.hosts.set("primary", new AgentMemoryHost(fixture.hostDataDirs.primary));
  await expect(running.finish()).rejects.toThrow("retained");
  const recovered = await turn("primary"); await recovered.prepare();
  expect(readFileSync(join(workingProfile(recovered), "fact.txt"), "utf8")).toBe("survives-interrupted-install");
  expect(snapshot(centralProfile()).digest).toBe(incoming.digest);
  expect(existsSync(backup)).toBe(false);
  await recovered.finish();
});

it("removes a stale guard under lock when the worker died before launch was permitted", async () => {
  const primary = fixture.hosts.get("primary")!, operationId = randomUUID();
  const input = { operationId, profile: "agent-engineer", threadId: "prestart", hostId: "remote", directory: join(root, "unlaunched-copy"), instructions: "persona", recover: false };
  expect((await primary.acquire(input, () => ({ dispose: async () => undefined }))).status).toBe("acquired");
  await primary.dispose();
  fixture.hosts.set("primary", new AgentMemoryHost(fixture.hostDataDirs.primary));
  expect(await nativeBindFailure()).toMatchObject({ exitCode: 73 });
  const local = await turn("primary"); await local.prepare();
  expect(existsSync(join(centralProfile(), MEMORY_GUARD_FILE))).toBe(false);
  expect((await fixture.hosts.get("primary")!.state({ profile: "agent-engineer" })).pending).toBeNull();
  expect(await nativeBindFailure()).toBeNull();
  await local.finish();
});

it.each(["before-receipt", "after-receipt"] as const)("accepts an installed tree after a worker crash %s, even with the remote offline", async (phase) => {
  const running = await turn(); await running.prepare();
  const original = snapshot(centralProfile()), next = workingProfile(running);
  writeFileSync(join(next, "fact.txt"), "already-durably-installed");
  const incoming = snapshot(next);
  await fixture.hosts.get("primary")!.dispose();
  const operation = join(fixture.hostDataDirs.primary, "agent-memory/operations", running.operationId);
  const backup = join(root, "optchat/profiles", `.agent-engineer.${running.operationId}.previous`);
  mkdirSync(backup);
  const oldNames = [...new Set(original.entries.map((entry) => entry.path.split("/")[0]!))];
  const newNames = [...new Set(incoming.entries.map((entry) => entry.path.split("/")[0]!))];
  writeFileSync(join(operation, "incoming.json"), JSON.stringify(incoming));
  writeFileSync(join(operation, "install.json"), JSON.stringify({ phase: "installing-new", oldNames, newNames }));
  for (const name of oldNames) renameSync(join(centralProfile(), name), join(backup, name));
  for (const name of newNames) cpSync(join(next, name), join(centralProfile(), name), { recursive: true });
  if (phase === "after-receipt") writeFileSync(join(operation, "committed.json"), JSON.stringify({ profile: "agent-engineer", digest: incoming.digest }));
  fixture.hosts.set("primary", new AgentMemoryHost(fixture.hostDataDirs.primary));
  if (phase === "after-receipt") await running.finish();
  else await expect(running.finish()).rejects.toThrow("retained");
  fixture.offline.add("remote");
  expect(await nativeBindFailure()).toMatchObject({ exitCode: 73 });
  const recovered = await turn("primary"); await recovered.prepare();
  expect(readFileSync(join(centralProfile(), "fact.txt"), "utf8")).toBe("already-durably-installed");
  expect(snapshot(centralProfile()).digest).toBe(incoming.digest);
  expect(existsSync(join(centralProfile(), MEMORY_GUARD_FILE))).toBe(false);
  expect((await fixture.hosts.get("primary")!.state({ profile: "agent-engineer" })).pending).toBeNull();
  expect(fixture.logs).toContainEqual(expect.stringContaining("already-installed memory; transferred 0 bytes"));
  await recovered.finish();
});

it("recognizes an acknowledged-on-disk commit when its HTTP reply is lost", async () => {
  const running = await turn(); await running.prepare();
  writeFileSync(join(workingProfile(running), "fact.txt"), "commit-survives-reply-loss");
  fixture.loseNextCommitReply(); await running.finish();
  expect(readFileSync(join(centralProfile(), "fact.txt"), "utf8")).toBe("commit-survives-reply-loss");
  expect((await fixture.hosts.get("primary")!.state({ profile: "agent-engineer" })).pending).toBeNull();
  expect((await fixture.hosts.get("primary")!.state({ profile: "agent-engineer" })).held).toBe(false);
});

it("rejects forged signatures, replayed requests and signed traversal without exposing other files", async () => {
  const env = await fixture.env("auth-thread", "engineer", "remote");
  const operationId = randomUUID();
  function request(action: Record<string, unknown>, secret = env.AGENT_MEMORY_SECRET, nonce = randomUUID()) {
    const body = JSON.stringify({ ...(action.action === "prepare" ? { directory: join(root, "signed-copy") } : {}), ...action, operationId }), time = String(Date.now());
    return new Request(fixture.url, { method: "POST", body, headers: { "x-agent-memory-key": env.AGENT_MEMORY_KEY, "x-agent-memory-time": time, "x-agent-memory-nonce": nonce, "x-agent-memory-signature": memorySignature(secret, time, nonce, body) } });
  }
  expect((await fixture.service.handle(request({ action: "prepare" }, "wrong-secret"))).status).toBe(401);
  expect(existsSync(centralProfile())).toBe(false);
  const signed = request({ action: "prepare" });
  const replay = signed.clone();
  expect((await fixture.service.handle(signed)).status).toBe(200);
  expect((await fixture.service.handle(replay)).status).toBe(401);
  const outside = join(root, "outside.txt"); writeFileSync(outside, "unchanged");
  const traversal = await fixture.service.handle(request({ action: "read", path: "../../outside.txt", offset: 0 }));
  expect(traversal.ok).toBe(false); expect(readFileSync(outside, "utf8")).toBe("unchanged");
  expect((await fixture.service.handle(request({ action: "release", failed: false }))).status).toBe(200);
});

it("fails closed when an agent has no coordinator configuration", () => {
  expect(() => new AgentMemoryTurn({ memoryKey: "agent-engineer", env: {}, dataDir: fixture.dataDirs.remote, signal: new AbortController().signal, onLost: () => { throw new Error("Unexpected callback"); } })).toThrow("Refusing to launch Pi with an independent memory");
});

it("keeps the remote profile socket path short under a deep data directory", async () => {
  const deep = join(fixture.dataDirs.remote, "x".repeat(120));
  mkdirSync(deep, { recursive: true });
  const env = await fixture.env(`thread-${++thread}`, "engineer", "remote");
  const memory = new AgentMemoryTurn({ memoryKey: "agent-engineer", env: { ...process.env, ...env }, dataDir: deep, signal: new AbortController().signal, onLost: (error) => { throw error; } });
  await memory.prepare();
  const socket = join(workingProfile(memory), "windows.sock");
  expect(Buffer.byteLength(socket)).toBeLessThan(107);
  expect(realpathSync(workingProfile(memory)).startsWith(realpathSync(deep))).toBe(true);
  const link = dirname(memory.homeOverride!);
  await memory.finish();
  expect(existsSync(link)).toBe(false);
});

it("reports a non-JSON coordinator reply as an HTTP error", async () => {
  const memory = await turn();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("404 Not Found", { status: 404 }));
  await expect(memory.prepare()).rejects.toThrow("Memory coordinator returned HTTP 404 without JSON: 404 Not Found");
});

it("releases a profile acquired after its preparing HTTP request was cancelled", async () => {
  let entered!: () => void, release!: () => void, acquired!: () => void;
  const enteredAcquire = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const acquiredProfile = new Promise<void>((resolve) => { acquired = resolve; });
  const primary = fixture.hosts.get("primary")!, originalAcquire = primary.acquire.bind(primary);
  vi.spyOn(primary, "acquire").mockImplementation(async (...args) => { const result = await originalAcquire(...args); acquired(); return result; });
  fixture.beforeCall = async (method) => { if (method === "memoryAcquire") { entered(); await gate; } };
  const abort = new AbortController(), cancelled = await turn("remote", abort.signal);
  const preparing = cancelled.prepare().then(() => null, (error: unknown) => error);
  await enteredAcquire;
  abort.abort(new Error("Cancel before Pi starts"));
  const error = await preparing;
  const finishing = cancelled.finish();
  release();
  await acquiredProfile; await finishing;
  expect(error).toBeInstanceOf(Error);
  expect((await primary.state({ profile: "agent-engineer" })).held).toBe(false);
  expect((await primary.state({ profile: "agent-engineer" })).pending).toBeNull();
});
