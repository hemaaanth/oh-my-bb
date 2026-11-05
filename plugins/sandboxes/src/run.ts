/**
 * `bb sandbox run`: one command on a fresh, throwaway sandbox. The runner
 * creates a machine through a provider backend, copies the caller's checkout,
 * runs the command, and removes the machine. BB core never sees these
 * machines, so the plugin records each one until removal succeeds and retries
 * leftovers at startup.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import type { PluginMachineProviderResource } from "@get-bb/plugin-sdk/machine-provider";
import type { SandboxProvider } from "./backend.js";
import type { SandboxBackend } from "./provider/sandbox-backend.js";
import type { SandboxSizeTier } from "./size-tiers.js";
import type { SandboxRunRecord } from "./store.js";

export type SandboxRunBackend = Pick<
  SandboxBackend<unknown, PluginMachineProviderResource>,
  "parseInputs" | "parseResource" | "create" | "remove"
>;

export type SandboxRunState = "running" | "passed" | "failed" | "error";

export interface SandboxRunRequest {
  provider?: SandboxProvider;
  tier?: SandboxSizeTier;
  /** Shell script run with `bash -lc` from the copied checkout. */
  command: string;
  /** Local checkout to copy, or null to start from an empty directory. */
  directory: string | null;
  timeoutMs: number;
}

export interface SandboxRunStatus {
  id: string;
  provider: SandboxProvider;
  command: string;
  state: SandboxRunState;
  exitCode: number | null;
  error: string | null;
  /** Log lines produced after the cursor the caller passed in. */
  progress: string[];
  /** Cursor to pass to the next poll. */
  cursor: number;
}

export interface SandboxRunnerDeps {
  backends: ReadonlyMap<SandboxProvider, SandboxRunBackend>;
  store: {
    recordRun(id: string, provider: SandboxProvider, resource: PluginMachineProviderResource): void;
    deleteRun(id: string): void;
    listRuns(): SandboxRunRecord[];
  };
  warn(message: string): void;
}

interface SandboxRunJob extends Omit<SandboxRunStatus, "progress" | "cursor"> {
  log: string[];
  logStart: number;
}

const MAX_JOB_LOG_LINES = 2_000;
const MAX_RETAINED_JOBS = 20;
/** A larger checkout should run on a provisioned thread sandbox instead. */
const MAX_ARCHIVE_BYTES = 256 * 1024 ** 2;
/**
 * Some vendors pass the whole command as one shell argument, and Linux caps
 * one argument at 128 KiB. 64 KiB of tarball stays under it after base64.
 */
const CHUNK_BYTES = 64 * 1024;
const UPLOAD_CONCURRENCY = 4;
const READY_TIMEOUT_MS = 3 * 60_000;
const STEP_TIMEOUT_MS = 2 * 60_000;
const RUN_ROOT = '"$HOME/bb-run"';

export class SandboxRunner {
  private readonly jobs = new Map<string, SandboxRunJob>();

  constructor(private readonly deps: SandboxRunnerDeps) {}

  /** Resolve the provider and start the run; returns the job id. */
  start(request: SandboxRunRequest): string {
    const configured = [...this.deps.backends.keys()];
    const provider = request.provider ?? (configured.length === 1 ? configured[0] : undefined);
    if (provider === undefined) {
      throw new Error(
        configured.length === 0
          ? "No sandbox provider is configured"
          : `Pass --provider; configured providers: ${configured.map((value) => (value === "box" ? "boat" : value)).join(", ")}`,
      );
    }
    const backend = this.deps.backends.get(provider);
    if (backend === undefined) throw new Error(`Provider ${provider} is not configured`);
    const job: SandboxRunJob = {
      id: `run_${randomUUID().replaceAll("-", "")}`,
      provider,
      command: request.command,
      state: "running",
      exitCode: null,
      error: null,
      log: [],
      logStart: 0,
    };
    this.jobs.set(job.id, job);
    this.trimJobs();
    void this.execute(job, backend, request);
    return job.id;
  }

  job(id: string, cursor = 0): SandboxRunStatus {
    const job = this.jobs.get(id);
    if (job === undefined) {
      throw new Error(`Sandbox run ${id} is unknown; a plugin reload drops run output`);
    }
    const { log, logStart, ...status } = job;
    return {
      ...status,
      progress: log.slice(Math.max(cursor - logStart, 0)),
      cursor: logStart + log.length,
    };
  }

  /** Remove machines that a crash or reload left behind. */
  async cleanupLeftovers(): Promise<void> {
    for (const record of this.deps.store.listRuns()) {
      if (this.jobs.has(record.id)) continue;
      const backend = this.deps.backends.get(record.provider);
      if (backend === undefined) continue;
      try {
        await this.remove(backend, record.id, backend.parseResource(record.resource));
        this.deps.store.deleteRun(record.id);
      } catch (error) {
        this.deps.warn(`Could not remove leftover sandbox run ${record.id}: ${message(error)}`);
      }
    }
  }

  private async execute(
    job: SandboxRunJob,
    backend: SandboxRunBackend,
    request: SandboxRunRequest,
  ): Promise<void> {
    const signal = AbortSignal.timeout(request.timeoutMs + READY_TIMEOUT_MS);
    const report = {
      step: (text: string) => this.append(job, text),
      log: (text: string) => this.append(job, text),
    };
    let resource: PluginMachineProviderResource | null = null;
    // Published only after removal, so a finished run never hides a leak.
    let outcome: Pick<SandboxRunJob, "state" | "exitCode" | "error"> = {
      state: "error",
      exitCode: null,
      error: null,
    };
    try {
      // Pack first so a bad checkout costs no machine time.
      const archive = request.directory === null ? null : await packCheckout(request.directory);
      if (archive !== null) {
        this.append(job, `Packed ${request.directory} (${formatBytes(archive.length)})`);
      }
      const created = await backend.create({
        key: job.id,
        attempt: 1,
        inputs: backend.parseInputs(request.tier === undefined ? {} : { size: request.tier }),
        report,
        signal,
        checkpoint: async (checkpointed) => {
          resource = checkpointed;
          this.deps.store.recordRun(job.id, job.provider, checkpointed);
        },
      });
      resource = created.resource;
      this.deps.store.recordRun(job.id, job.provider, created.resource);
      const executor = created.executor;
      await waitUntilReady(executor, signal);
      await shell(executor, `mkdir -p ${RUN_ROOT}/src ${RUN_ROOT}/parts`, signal);
      if (archive !== null) {
        this.append(job, "Copying the checkout");
        await upload(executor, archive, signal);
        await shell(
          executor,
          `cat ${RUN_ROOT}/parts/* | tar -xzf - -C ${RUN_ROOT}/src && rm -rf ${RUN_ROOT}/parts`,
          signal,
        );
      }
      this.append(job, `$ ${request.command}`);
      let partial = "";
      const { exitCode } = await executor.exec({
        command: ["bash", "-lc", `cd ${RUN_ROOT}/src && ${request.command}`],
        timeoutMs: request.timeoutMs,
        signal,
        stdin: "",
        onOutput: (chunk) => {
          const text = partial + chunk;
          const cut = text.lastIndexOf("\n");
          partial = cut < 0 ? text : text.slice(cut + 1);
          if (cut >= 0) this.append(job, text.slice(0, cut));
        },
      });
      this.append(job, partial);
      outcome = { state: exitCode === 0 ? "passed" : "failed", exitCode, error: null };
    } catch (error) {
      outcome = { state: "error", exitCode: null, error: message(error) };
    } finally {
      if (resource !== null) {
        try {
          await this.remove(backend, job.id, resource);
          this.deps.store.deleteRun(job.id);
          this.append(job, "Removed the sandbox");
        } catch (error) {
          this.deps.warn(`Could not remove sandbox run ${job.id}: ${message(error)}`);
          this.append(job, `Could not remove the sandbox; bb retries at the next plugin start: ${message(error)}`);
        }
      }
      Object.assign(job, outcome);
    }
  }

  private remove(
    backend: SandboxRunBackend,
    id: string,
    resource: PluginMachineProviderResource,
  ): Promise<void> {
    return backend.remove({
      hostId: id,
      resource,
      report: { step: () => {}, log: () => {} },
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
  }

  private append(job: SandboxRunJob, text: string): void {
    for (const line of text.split("\n")) {
      const trimmed = line.trimEnd();
      if (trimmed.length > 0) job.log.push(trimmed);
    }
    const overflow = job.log.length - MAX_JOB_LOG_LINES;
    if (overflow > 0) {
      job.log.splice(0, overflow);
      job.logStart += overflow;
    }
  }

  private trimJobs(): void {
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= MAX_RETAINED_JOBS) break;
      if (job.state !== "running") this.jobs.delete(id);
    }
  }
}

async function shell(executor: MachineExecutor, script: string, signal: AbortSignal, stdin = ""): Promise<void> {
  let output = "";
  const { exitCode } = await executor.exec({
    command: ["sh", "-c", script],
    timeoutMs: STEP_TIMEOUT_MS,
    signal,
    stdin,
    onOutput: (chunk) => {
      output += chunk;
    },
  });
  if (exitCode !== 0) {
    throw new Error(`Sandbox setup step failed (exit ${exitCode}): ${output.trim().slice(-500)}`);
  }
}

/** A just-created machine may refuse commands for a short while. */
async function waitUntilReady(executor: MachineExecutor, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      await shell(executor, "true", signal);
      return;
    } catch (error) {
      if (signal.aborted || Date.now() >= deadline) {
        throw new Error(`The sandbox did not accept commands: ${message(error)}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function upload(executor: MachineExecutor, archive: Buffer, signal: AbortSignal): Promise<void> {
  const count = Math.ceil(archive.length / CHUNK_BYTES);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < count) {
      const index = next++;
      const chunk = archive.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
      // Zero-padded names keep `cat parts/*` in upload order.
      await shell(
        executor,
        `base64 -d > ${RUN_ROOT}/parts/${String(index).padStart(6, "0")}`,
        signal,
        chunk.toString("base64"),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, count) }, worker));
}

/** Tracked and untracked, not ignored, files as a gzip tarball. */
export async function packCheckout(directory: string): Promise<Buffer> {
  if (!(await lstat(directory).then((stat) => stat.isDirectory(), () => false))) {
    throw new Error(`${directory} is not a directory on the bb server's machine; pass --dir <checkout> there or --no-upload`);
  }
  const listed = await capture("git", ["-C", directory, "ls-files", "-z", "-co", "--exclude-standard"], null);
  if (listed.exitCode !== 0) {
    throw new Error(`${directory} is not a git checkout; pass --dir <checkout> or --no-upload`);
  }
  const files: string[] = [];
  for (const file of new Set(listed.stdout.toString("utf8").split("\0"))) {
    if (file.length === 0) continue;
    // Tracked files deleted in the working tree are still listed.
    if (await lstat(join(directory, file)).then(() => true, () => false)) files.push(file);
  }
  const packed = await capture(
    "tar",
    ["-czf", "-", "--null", "--no-recursion", "-T", "-"],
    `${files.join("\0")}\0`,
    directory,
  );
  if (packed.exitCode !== 0) {
    throw new Error(`Could not pack ${directory}: ${packed.stderr.trim().slice(-500)}`);
  }
  return packed.stdout;
}

function capture(
  command: string,
  args: string[],
  stdin: string | null,
  cwd?: string,
): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "pipe" });
    const stdout: Buffer[] = [];
    let size = 0;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ARCHIVE_BYTES) {
        child.kill();
        reject(new Error(`The checkout is larger than ${formatBytes(MAX_ARCHIVE_BYTES)} compressed; run it in a thread sandbox instead`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdout), stderr }));
    // git can exit before reading its (empty) stdin; the exit code reports that.
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
