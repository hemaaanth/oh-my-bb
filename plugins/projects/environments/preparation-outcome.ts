import type { PreparationOutcomeV1 } from "./contract.js";
import type { Preparation } from "./store.js";

type ObservedPreparationStatus =
  | { state: "running" }
  | { state: "complete"; result: Preparation }
  | { state: "failed" };

export class PreparationObservation {
  private remoteStarted = false;
  private pending = 0;
  private unconfirmed = false;
  private confirmedNotReady = false;

  async observeHost<T>(method: string, operation: () => Promise<T>) {
    this.remoteStarted = true;
    this.pending++;
    try {
      const result = await operation();
      if (method === "run" && result !== null && typeof result === "object" && "timedOut" in result && result.timedOut === true) {
        this.unconfirmed = true;
      }
      return result;
    } catch (error) {
      this.unconfirmed = true;
      throw error;
    } finally {
      this.pending--;
    }
  }

  catalogWork() {
    // Legacy Catalog job status does not prove that all remote work stopped.
    this.remoteStarted = true;
    this.unconfirmed = true;
  }

  notReady() {
    this.confirmedNotReady = true;
  }

  snapshot(jobId: string, status: ObservedPreparationStatus): PreparationOutcomeV1 {
    const base = { schemaVersion: 1 as const, jobId };
    if (status.state === "running") return { ...base, state: "running", retryable: false, reason: "in_progress" };
    if (this.unconfirmed || this.pending > 0 || (status.state === "failed" && this.remoteStarted && !this.confirmedNotReady)) {
      return { ...base, state: "unknown", retryable: false, reason: "completion_unconfirmed" };
    }
    if (status.state === "complete") {
      return status.result.ready
        ? { ...base, state: "complete", ready: true, retryable: false, reason: "ready" }
        : { ...base, state: "complete", ready: false, retryable: true, reason: "not_ready" };
    }
    return { ...base, state: "failed", retryable: true, reason: this.confirmedNotReady ? "not_ready" : "before_remote_work" };
  }
}
