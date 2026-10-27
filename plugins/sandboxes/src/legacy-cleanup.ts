import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { SandboxProvider } from "./backend.js";
import type { SandboxBackend } from "./provider/sandbox-backend.js";
import {
  type SandboxCleanupRecord,
  type SandboxCleanupStep,
  type SandboxRecord,
  SandboxStore,
} from "./store.js";

const RECONCILE_INTERVAL_MS = 60_000;
const CLEANUP_RETRY_BASE_MS = 5_000;
const CLEANUP_RETRY_MAX_MS = 15 * 60_000;

type LegacyBackend = Pick<
  SandboxBackend<unknown, never>,
  "removeLegacy" | "removeLegacyCheckpoint"
>;

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missing(error: unknown): boolean {
  const status =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "status") ?? Reflect.get(error, "statusCode")
      : null;
  return (
    status === 404 || /\b404\b|not[- ]found|does not exist/iu.test(detail(error))
  );
}

function cleanupComplete(cleanup: SandboxCleanupRecord): boolean {
  return (
    cleanup.workspaceTeardownAt !== null &&
    cleanup.projectSourceDeletedAt !== null &&
    cleanup.providerSandboxDestroyedAt !== null &&
    cleanup.providerCheckpointDeletedAt !== null &&
    cleanup.hostDeletedAt !== null &&
    cleanup.connectMachineRevokedAt !== null
  );
}

function retryDelay(attempt: number): number {
  return Math.min(
    CLEANUP_RETRY_MAX_MS,
    CLEANUP_RETRY_BASE_MS * 2 ** Math.max(0, Math.min(10, attempt - 1)),
  );
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Compatibility owner for machines created before the native BB 0.43
 * provider migration. Core cannot see their provider allocation, so deleting
 * these rows from the old manager without retaining its reaper leaked them.
 */
export class LegacySandboxCleanup {
  private readonly inFlight = new Map<string, Promise<SandboxRecord>>();

  constructor(
    private readonly bb: BbPluginApi,
    private readonly store: SandboxStore,
    private readonly backends: ReadonlyMap<SandboxProvider, LegacyBackend>,
  ) {}

  list(): SandboxRecord[] {
    return this.store.listLegacySandboxes();
  }

  get(idOrHostId: string): SandboxRecord | null {
    return this.store.getLegacySandbox(idOrHostId);
  }

  /** True only when BB can positively identify an unarchived thread on host. */
  async hasLiveThread(record: SandboxRecord): Promise<boolean> {
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const threads = await this.bb.sdk.threads.list({
        archived: false,
        includeHidden: true,
        limit,
        offset,
      });
      for (const thread of threads) {
        if (thread.id === record.threadId) return true;
        if (thread.environmentHostId === record.hostId) return true;
        if (thread.environmentId === null) continue;
        try {
          const environment = await this.bb.sdk.environments.get({
            environmentId: thread.environmentId,
          });
          if (environment.hostId === record.hostId) return true;
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      if (threads.length < limit) return false;
    }
  }

  private async cleanupOnce(id: string): Promise<SandboxRecord> {
    let record = this.store.getLegacySandbox(id);
    if (record === null) throw new Error(`Legacy sandbox ${id} was not found`);
    let cleanup = this.store.requestLegacyCleanup(id);
    if (cleanup.completedAt !== null && record.status === "destroyed") {
      return record;
    }
    record = this.store.updateLegacySandbox(id, {
      status: "destroying",
      error: null,
    });
    const target = record;
    cleanup = this.store.beginLegacyCleanupAttempt(id);
    const failures: string[] = [];

    const attempt = async (
      step: SandboxCleanupStep,
      doneAt: number | null,
      label: string,
      action: () => Promise<void>,
    ): Promise<void> => {
      if (doneAt !== null) return;
      try {
        await action();
        cleanup = this.store.markLegacyCleanupStep(id, step);
      } catch (error) {
        if (missing(error)) {
          cleanup = this.store.markLegacyCleanupStep(id, step);
          return;
        }
        failures.push(`${label}: ${detail(error)}`);
      }
    };

    // Workspaces lived on the soon-to-be-deleted provider machine. There is no
    // useful remote teardown left to perform; project/source and provider state
    // below are the durable resources that must be reaped.
    await attempt(
      "workspace",
      cleanup.workspaceTeardownAt,
      "workspace",
      async () => {},
    );
    await attempt(
      "projectSource",
      cleanup.projectSourceDeletedAt,
      "project source",
      async () => {
        if (target.projectSourceId === null) return;
        await this.bb.sdk.projects.sources.delete({
          projectId: target.projectId,
          sourceId: target.projectSourceId,
        });
      },
    );
    await attempt(
      "providerSandbox",
      cleanup.providerSandboxDestroyedAt,
      `${target.provider} sandbox`,
      async () => {
        if (target.providerSandboxId === null) return;
        const backend = this.backends.get(target.provider);
        if (backend === undefined) {
          throw new Error(
            `${target.provider} is not configured; restore its credentials to finish cleanup`,
          );
        }
        await backend.removeLegacy(target.providerSandboxId);
      },
    );
    await attempt(
      "providerCheckpoint",
      cleanup.providerCheckpointDeletedAt,
      `${target.provider} checkpoint`,
      async () => {
        if (cleanup.providerSandboxDestroyedAt === null) {
          throw new Error("waiting for confirmed provider removal; checkpoint retained");
        }
        const checkpoint = this.store.getLegacyCheckpointId(id);
        if (checkpoint !== null) {
          const backend = this.backends.get(target.provider);
          if (backend?.removeLegacyCheckpoint === undefined) {
            throw new Error(
              `checkpoint ${checkpoint} needs provider-specific manual removal`,
            );
          }
          await backend.removeLegacyCheckpoint(checkpoint);
        }
      },
    );
    await attempt("host", cleanup.hostDeletedAt, "BB host", async () => {
      if (cleanup.providerSandboxDestroyedAt === null || cleanup.providerCheckpointDeletedAt === null) {
        throw new Error("waiting for confirmed provider cleanup; BB host retained");
      }
      await this.bb.sdk.hosts.delete({ hostId: target.hostId });
    });
    await attempt(
      "connectMachine",
      cleanup.connectMachineRevokedAt,
      "Connect credential",
      async () => {
        // BB owns Connect enrollment now. Deleting (or finding no) host above
        // revokes its linked server access; the old direct credential id is
        // retained only as audit metadata.
        if (this.store.getLegacyCleanup(id)?.hostDeletedAt === null) {
          throw new Error("waiting for BB host deletion");
        }
      },
    );

    cleanup = this.store.ensureLegacyCleanup(id);
    if (failures.length === 0 && cleanupComplete(cleanup)) {
      this.store.completeLegacyCleanup(id);
      record = this.store.updateLegacySandbox(id, {
        status: "destroyed",
        error: null,
      });
    } else {
      if (failures.length === 0) failures.push("cleanup state is incomplete");
      const message = failures.join("; ");
      this.store.failLegacyCleanup(
        id,
        message,
        Date.now() + retryDelay(cleanup.attemptCount),
      );
      record = this.store.updateLegacySandbox(id, {
        status: "error",
        error: `Cleanup pending: ${message}`,
      });
    }
    this.bb.realtime.publish("sandboxes", { type: "changed", id });
    return record;
  }

  private async cleanup(id: string): Promise<SandboxRecord> {
    const existing = this.inFlight.get(id);
    if (existing !== undefined) return existing;
    const pending = this.cleanupOnce(id);
    this.inFlight.set(id, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(id) === pending) this.inFlight.delete(id);
    }
  }

  async destroy(
    idOrHostId: string,
    options: { allowLiveThreads: boolean },
  ): Promise<SandboxRecord> {
    const record = this.store.getLegacySandbox(idOrHostId);
    if (record === null) {
      throw new Error(`Legacy sandbox ${idOrHostId} was not found`);
    }
    if (!options.allowLiveThreads && (await this.hasLiveThread(record))) {
      throw new Error(
        `Refusing to delete ${record.id}: an unarchived thread still uses host ${record.hostId}`,
      );
    }
    this.store.requestLegacyCleanup(record.id);
    return this.cleanup(record.id);
  }

  async handleFinishedThread(threadId: string): Promise<void> {
    const record = this.store.getLegacySandboxByThread(threadId);
    if (record === null || record.status === "destroyed") return;
    try {
      if (await this.hasLiveThread(record)) return;
      this.store.requestLegacyCleanup(record.id);
      await this.cleanup(record.id);
    } catch (error) {
      this.bb.log.warn(
        `Could not retire legacy sandbox ${record.id} for thread ${threadId}: ${detail(error)}`,
      );
    }
  }

  async reconcile(now = Date.now()): Promise<void> {
    for (const record of this.store.listLegacySandboxes()) {
      if (record.status === "destroyed") continue;
      const cleanup = this.store.getLegacyCleanup(record.id);
      if (cleanup?.requestedAt !== null && cleanup?.requestedAt !== undefined) {
        continue;
      }
      if (
        record.status === "destroying" ||
        record.status === "error" ||
        (record.status === "provisioning" &&
          record.updatedAt <= now - 30 * 60_000)
      ) {
        if (!(await this.hasLiveThread(record))) {
          this.store.requestLegacyCleanup(record.id, now);
        }
        continue;
      }
      if (record.threadId === null) {
        // Never infer that an unattached row is disposable. Only the old
        // launcher's explicit attachment deadline or a manual delete may reap it.
        if (
          cleanup?.threadAttachDeadlineAt !== null &&
          cleanup?.threadAttachDeadlineAt !== undefined &&
          cleanup.threadAttachDeadlineAt <= now &&
          !(await this.hasLiveThread(record))
        ) {
          this.store.requestLegacyCleanup(record.id, now);
        }
        continue;
      }
      try {
        const thread = await this.bb.sdk.threads.get({
          threadId: record.threadId,
        });
        if (
          (thread.archivedAt !== null || thread.deletedAt !== null) &&
          !(await this.hasLiveThread(record))
        ) {
          this.store.requestLegacyCleanup(record.id, now);
        }
      } catch (error) {
        if (!missing(error)) {
          this.bb.log.warn(
            `Could not inspect legacy sandbox ${record.id}: ${detail(error)}`,
          );
          continue;
        }
        if (!(await this.hasLiveThread(record))) {
          this.store.requestLegacyCleanup(record.id, now);
        }
      }
    }
  }

  async cleanupDue(now = Date.now()): Promise<void> {
    for (const due of this.store.listDueLegacyCleanup(now)) {
      await this.cleanup(due.sandboxId).catch((error) =>
        this.bb.log.error(
          `Legacy sandbox cleanup ${due.sandboxId} crashed: ${detail(error)}`,
        ),
      );
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.reconcile().catch((error) =>
        this.bb.log.error(
          `Legacy sandbox reconciliation failed: ${detail(error)}`,
        ),
      );
      await this.cleanupDue().catch((error) =>
        this.bb.log.error(
          `Legacy sandbox cleanup sweep failed: ${detail(error)}`,
        ),
      );
      await wait(RECONCILE_INTERVAL_MS, signal);
    }
  }
}
