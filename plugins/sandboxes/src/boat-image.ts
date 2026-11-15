import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { SandboxImageRegistryConfig } from "./config.js";
import { shQuote } from "./provider/backends/shell-exec.js";

export const BOAT_RUNTIME_CONTAINER = "bb-sandbox-runtime";
export const BOAT_RUNTIME_ROOT = "/bb-runtime";
const sandboxSchema = z.object({ sandbox: z.object({ id: z.string(), state: z.string() }) });
const journalSchema = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), ids: z.array(z.string()), saved: z.boolean(), verified: z.boolean().default(false) });

/** Never put credentials in command history. Boat's file API carries stdin. */
export class BoatImageClient {
  constructor(private readonly apiKey: string, readonly signal: AbortSignal) {}
  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
    const response = await fetch(`https://boat.dev/api/v1${path}`, {
      method, signal: AbortSignal.any([this.signal, AbortSignal.timeout(60_000)]),
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 404 && method === "GET") return null;
    const result: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Boat image ${method} ${path}: HTTP ${response.status}`);
    return result;
  }
  async wait() {
    this.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.signal.removeEventListener("abort", abort); resolve(); };
      const abort = () => { clearTimeout(timer); this.signal.removeEventListener("abort", abort); reject(this.signal.reason); };
      const timer = setTimeout(done, 3_000);
      this.signal.addEventListener("abort", abort, { once: true });
    });
  }
  async ready(id: string) {
    for (;;) {
      const { sandbox } = sandboxSchema.parse(await this.request("GET", `/sandboxes/${encodeURIComponent(id)}`));
      if (["ready", "idle", "running"].includes(sandbox.state)) return;
      if (["error", "archived", "stopped"].includes(sandbox.state)) throw new Error(`Boat image machine is ${sandbox.state}`);
      await this.wait();
    }
  }
  async command(id: string, command: string): Promise<string> {
    const path = `/sandboxes/${encodeURIComponent(id)}/commands`;
    const started = z.object({ processId: z.number().int() }).parse(await this.request("POST", path, { command, detached: true }));
    for (;;) {
      const status = z.object({ running: z.boolean(), exitCode: z.number().nullable(), stdout: z.string(), stderr: z.string() })
        .parse(await this.request("GET", `${path}/${started.processId}`));
      if (!status.running) {
        if (status.exitCode !== 0) throw new Error(`Boat image command failed (${status.exitCode}): ${status.stderr.slice(-2000)}${status.stdout.slice(-2000)}`);
        return status.stdout;
      }
      await this.wait();
    }
  }
  async upload(id: string, path: string, content: string) {
    await this.request("PUT", `/sandboxes/${encodeURIComponent(id)}/files`, { path, content: Buffer.from(content).toString("base64"), encoding: "base64" });
  }
  async ownedIds(name: string): Promise<string[]> {
    const ids: string[] = [];
    for (const suffix of ["prepare", "verify"]) {
      const exact = `${name}-${suffix}`;
      const result = z.object({ sandboxes: z.array(z.object({ id: z.string(), name: z.string().nullable() })), pageInfo: z.object({ hasMore: z.boolean() }) })
        .parse(await this.request("GET", `/sandboxes?name=${encodeURIComponent(exact)}&limit=200`));
      if (result.pageInfo.hasMore) throw new Error("Boat image cleanup listing is incomplete");
      ids.push(...result.sandboxes.filter(box => box.name === exact).map(box => box.id));
    }
    return ids;
  }
  async remove(id: string) {
    if (await this.request("GET", `/sandboxes/${encodeURIComponent(id)}`) === null) return;
    await this.request("DELETE", `/sandboxes/${encodeURIComponent(id)}`, undefined, { "X-Ascii-Confirm-Delete": id });
    while (await this.request("GET", `/sandboxes/${encodeURIComponent(id)}`) !== null) await this.wait();
  }
}

/** Replay only exact allocations journaled by a prior, interrupted image build. */
export async function cleanupBoatImageBuilds(directory: string, apiKey: string, onLog: (message: string) => void) {
  const files = await readdir(directory).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
  for (const file of files.filter(file => file.endsWith(".json"))) {
    try {
      const record = journalSchema.parse(JSON.parse(await readFile(join(directory, file), "utf8")));
      const client = new BoatImageClient(apiKey, AbortSignal.timeout(5 * 60_000));
      for (const id of new Set([...record.ids, ...await client.ownedIds(record.name)])) await client.remove(id);
      if (record.saved && !record.verified) {
        const path = `/saved-snapshots/${encodeURIComponent(record.name)}`;
        if (await client.request("GET", path) !== null) await client.request("DELETE", path);
      }
      // A completed snapshot may already be active. Keep it; the image catalog owns it.
      await rm(join(directory, file));
      onLog(`Cleaned interrupted Boat image allocation ${record.name}`);
    } catch { onLog(`Boat image cleanup retained ${file} for retry`); }
  }
}

export async function registerBoatImage(input: {
  apiKey: string; name: string; pinnedReference: string; registry: SandboxImageRegistryConfig;
  journalDirectory: string; signal?: AbortSignal; onName?: (name: string) => void; onLog?: (message: string) => void;
}): Promise<{ name: string; placement: null }> {
  z.string().min(1).max(512).parse(input.name);
  if (input.registry.platform !== "linux/amd64") throw new Error("Boat managed images require linux/amd64");
  if (!/@sha256:[a-f0-9]{64}$/.test(input.pinnedReference)) throw new Error("Boat images require an immutable registry digest");
  const client = new BoatImageClient(input.apiKey, AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(45 * 60_000)]));
  // Never replace an active saved snapshot before its replacement is verified.
  const baseName = input.name.toLowerCase().replace(/[^a-z0-9-]/gu, "-").replace(/^-+/u, "") || "bb-sandbox";
  const name = journalSchema.shape.name.parse(`${baseName.slice(0, 54)}-${randomUUID().slice(0, 8)}`);
  input.onName?.(name);
  const record = { name, ids: [] as string[], saved: false, verified: false };
  await mkdir(input.journalDirectory, { recursive: true, mode: 0o700 });
  const journal = join(input.journalDirectory, `${name}.json`);
  const persist = async () => {
    await writeFile(journal + ".tmp", JSON.stringify(record), { mode: 0o600 });
    await rename(journal + ".tmp", journal);
  };
  const log = input.onLog ?? (() => {});
  const create = async (from?: string) => {
    const key = `${name}-${from ? "verify" : "prepare"}`;
    const { sandbox } = sandboxSchema.parse(await client.request("POST", "/sandboxes", {
      name: key, type: "default", ttlSeconds: 7200, noEnv: true, ...(from ? { from } : {}),
    }, { "Idempotency-Key": key }));
    record.ids.push(sandbox.id); await persist(); await client.ready(sandbox.id); return sandbox.id;
  };
  const runtime = (script: string) => `sudo docker exec ${BOAT_RUNTIME_CONTAINER} chroot ${BOAT_RUNTIME_ROOT} sh -ec ${shQuote(script)}`;
  let verified = false;
  let primaryError: unknown;
  try {
    // Persist before allocation so an interrupted job has a durable recovery marker.
    await persist();
    log("Preparing a temporary Boat machine from the shared runtime image");
    const source = await create();
    await client.command(source, "sudo systemctl start docker && sudo docker info >/dev/null");
    const config = `/tmp/bb-image-${randomUUID()}`;
    try {
      if (input.registry.username && input.registry.token) {
        const first = input.registry.repository.split("/")[0]!;
        const host = first.includes(".") || first.includes(":") || first === "localhost" ? first : "https://index.docker.io/v1/";
        await client.command(source, `install -d -m 700 ${shQuote(config)}`);
        await client.upload(source, `${config}/config.json`, JSON.stringify({ auths: { [host]: { auth: Buffer.from(`${input.registry.username}:${input.registry.token}`).toString("base64") } } }));
        await client.command(source, `chmod 700 ${shQuote(config)} && chmod 600 ${shQuote(config + "/config.json")}`);
      }
      await client.command(source, `sudo docker --config ${shQuote(config)} pull ${shQuote(input.pinnedReference)}`);
    } finally {
      await client.command(source, `sudo rm -rf ${shQuote(config)}`);
    }
    // Keep the prepared image tagged: Boat retains tagged Docker images in snapshots.
    await client.command(source, `sudo docker tag ${shQuote(input.pinnedReference)} bb-sandbox-runtime:prepared && sudo docker volume create bb-sandbox-root && sudo docker create --name bb-runtime-seed bb-sandbox-runtime:prepared`);
    const copy = `sudo docker export bb-runtime-seed | sudo docker run --rm -i --user 0 --entrypoint tar -v bb-sandbox-root:${BOAT_RUNTIME_ROOT} bb-sandbox-runtime:prepared -xpf - -C ${BOAT_RUNTIME_ROOT}`;
    await client.command(source, `bash -o pipefail -c ${shQuote(copy)} && sudo docker rm -v bb-runtime-seed`);
    // Boat recreates containers; only named volumes retain their writable data.
    const boot = `mount -t proc proc ${BOAT_RUNTIME_ROOT}/proc; mount --rbind /sys ${BOAT_RUNTIME_ROOT}/sys; mount --rbind /dev ${BOAT_RUNTIME_ROOT}/dev; for file in resolv.conf hosts hostname; do rm -f ${BOAT_RUNTIME_ROOT}/etc/$file; touch ${BOAT_RUNTIME_ROOT}/etc/$file; mount --bind /etc/$file ${BOAT_RUNTIME_ROOT}/etc/$file; done; exec chroot ${BOAT_RUNTIME_ROOT} /bin/sh -c 'exec sleep infinity'`;
    await client.command(source, `sudo docker run -d --name ${BOAT_RUNTIME_CONTAINER} --restart always --user 0 -e IS_SANDBOX=1 --privileged -v bb-sandbox-root:${BOAT_RUNTIME_ROOT} --tmpfs ${BOAT_RUNTIME_ROOT}/run:mode=755 --tmpfs ${BOAT_RUNTIME_ROOT}/tmp:mode=1777 --entrypoint /bin/sh bb-sandbox-runtime:prepared -ec ${shQuote(boot)}`);
    await client.command(source, runtime("test -r /proc/self/stat"));
    const layers = (output: string) => z.array(z.string()).min(1).parse(JSON.parse(output));
    const sourceLayers = layers(await client.command(source, `sudo docker image inspect ${shQuote(input.pinnedReference)} --format '{{json .RootFS.Layers}}'`));
    await client.command(source, runtime(`printf %s ${shQuote(input.pinnedReference)} > /usr/local/share/bb-snapshot-reference`));
    const identityCheck = `test -z "$(find /root/.bb /root/.bb-machines -type f \\( -name auth.json -o -name host-id \\) -print 2>/dev/null)"`;
    await client.command(source, runtime(`command -v bb-host-daemon; command -v bb-sandbox-smoke-test; ${identityCheck}`));
    log("Saving the prepared Boat snapshot");
    record.saved = true; await persist();
    await client.request("POST", "/saved-snapshots", { sandboxId: source, name });
    for (;;) {
      const result = z.object({ snapshot: z.object({ status: z.string() }) }).parse(await client.request("GET", `/saved-snapshots/${encodeURIComponent(name)}`));
      if (result.snapshot.status === "ready") break;
      if (result.snapshot.status === "failed") throw new Error("Boat snapshot capture failed");
      await client.wait();
    }
    log("Restoring a new machine to verify the saved runtime and selected tools");
    const restored = await create(name);
    await client.command(restored, `sudo systemctl start docker; for attempt in $(seq 1 150); do sudo docker start ${BOAT_RUNTIME_CONTAINER} >/dev/null 2>&1 && sudo docker exec ${BOAT_RUNTIME_CONTAINER} test -r ${BOAT_RUNTIME_ROOT}/proc/self/stat && exit 0; sleep 2; done; exit 1`);
    // A fresh restore must run the same immutable image, without pulling or reinstalling.
    // Boat may recreate the container from a committed image, changing its reference.
    // Its ordered base layers must still be exactly the image pulled by digest.
    const restoredLayers = layers(await client.command(restored, `sudo docker image inspect "$(sudo docker inspect --format '{{.Image}}' ${BOAT_RUNTIME_CONTAINER})" --format '{{json .RootFS.Layers}}'`));
    if (sourceLayers.some((layer, index) => restoredLayers[index] !== layer)) throw new Error("Restored Boat runtime has the wrong image layers");
    const restoredReference = (await client.command(restored, runtime("cat /usr/local/share/bb-snapshot-reference"))).trim();
    if (restoredReference !== input.pinnedReference) throw new Error("Boat did not preserve the prepared container filesystem");
    log(await client.command(restored, runtime(`${identityCheck}; bb-sandbox-smoke-test`)));
    verified = true; record.verified = true; await persist();
    log("Boat snapshot passed restored runtime verification");
  } catch (error) { primaryError = error; }
  // Cleanup gets its own deadline even if preparation timed out. Retain a receipt on failure.
  const cleanup = new BoatImageClient(input.apiKey, AbortSignal.timeout(5 * 60_000));
  const failures: string[] = [];
  let owned = record.ids;
  try { owned = [...new Set([...owned, ...await cleanup.ownedIds(name)])]; } catch { failures.push("allocation lookup"); }
  for (const id of owned) { try { await cleanup.remove(id); } catch { failures.push(id); } }
  if (!verified && record.saved) {
    try {
      const path = `/saved-snapshots/${encodeURIComponent(name)}`;
      if (await cleanup.request("GET", path) !== null) await cleanup.request("DELETE", path);
    } catch { failures.push("snapshot"); }
  }
  if (failures.length === 0) await rm(journal, { force: true });
  else throw new Error(`Boat image cleanup pending (${failures.join(", ")}); recovery receipt retained${primaryError ? "; preparation also failed" : ""}`);
  if (primaryError) throw primaryError;
  if (!verified) throw new Error("Boat image was not verified");
  return { name, placement: null };
}
