import { randomUUID } from "node:crypto";
import {
  experimental_defineHostEntry,
  type ExperimentalHostWorkerLease,
} from "@get-bb/plugin-sdk/host";
import { hostContract } from "./host-contract.js";

const MIB = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 32 * MIB;
export const RESPONSE_CHUNK_BYTES = 4 * MIB;
const CHUNK_TTL_MS = 30_000;
const MAX_PENDING_BYTES = 200 * MIB;
const MAX_BUDGET_WAITERS = 256;

interface PendingResponse {
  body: Buffer;
  offset: number;
  expiresAt: number;
  timer: NodeJS.Timeout | undefined;
  lease: ExperimentalHostWorkerLease;
}

let pendingBytes = 0;
let activeReservedBytes = 0;
const budgetWaiters = new Set<() => void>();
const pendingResponses = new Map<string, PendingResponse>();

export function chunkResponseBody(
  body: Buffer,
  offset: number,
): { bodyBase64: string; nextOffset: number | null } {
  const end = Math.min(offset + RESPONSE_CHUNK_BYTES, body.length);
  return {
    bodyBase64: body.subarray(offset, end).toString("base64"),
    nextOffset: end < body.length ? end : null,
  };
}

function deletePendingResponse(token: string): boolean {
  const pending = pendingResponses.get(token);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingBytes -= pending.body.length;
  void pending.lease.dispose().catch(() => undefined);
  pendingResponses.delete(token);
  wakeBudgetWaiters();
  return true;
}

function wakeBudgetWaiters(): void {
  for (const wake of budgetWaiters) wake();
  budgetWaiters.clear();
}

function releaseActiveReservation(bytes: number): void {
  activeReservedBytes -= bytes;
  wakeBudgetWaiters();
}

async function acquireActiveReservation(
  bytes: number,
  signal: AbortSignal,
): Promise<void> {
  while (activeReservedBytes + pendingBytes + bytes > MAX_PENDING_BYTES) {
    if (signal.aborted) throw signal.reason;
    if (budgetWaiters.size >= MAX_BUDGET_WAITERS) {
      throw new Error("Shared preview host is busy; retry the request.");
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const wake = () => resolve();
    const abort = () => {
      budgetWaiters.delete(wake);
      reject(signal.reason);
    };
    budgetWaiters.add(wake);
    signal.addEventListener("abort", abort, { once: true });
    try {
      await promise;
    } finally {
      budgetWaiters.delete(wake);
      signal.removeEventListener("abort", abort);
    }
  }
  if (signal.aborted) throw signal.reason;
  activeReservedBytes += bytes;
}

export function responseReservationBytes(response: Response): number {
  const rawLength = response.headers.get("content-length");
  if (rawLength === null) return MAX_RESPONSE_BYTES;
  const declaredLength = Number(rawLength);
  return Number.isFinite(declaredLength) && declaredLength >= 0
    ? Math.min(declaredLength, MAX_RESPONSE_BYTES)
    : MAX_RESPONSE_BYTES;
}

function armPendingExpiry(token: string, pending: PendingResponse): void {
  clearTimeout(pending.timer);
  pending.expiresAt = Date.now() + CHUNK_TTL_MS;
  pending.timer = setTimeout(() => deletePendingResponse(token), CHUNK_TTL_MS);
  pending.timer.unref?.();
}

function prunePendingResponses(now = Date.now()): void {
  for (const [token, pending] of pendingResponses) {
    if (pending.expiresAt <= now) deletePendingResponse(token);
  }
}

function storePendingResponse(
  body: Buffer,
  offset: number,
  lease: ExperimentalHostWorkerLease,
): string {
  prunePendingResponses();
  const token = randomUUID();
  const pending: PendingResponse = {
    body,
    offset,
    expiresAt: 0,
    timer: undefined,
    lease,
  };
  pendingBytes += body.length;
  pendingResponses.set(token, pending);
  armPendingExpiry(token, pending);
  return token;
}

function responseLimitMessage(maxBytes: number, actualBytes?: number): string {
  const limitMiB = Math.round(maxBytes / MIB);
  if (actualBytes === undefined) {
    return `Shared preview response exceeded the ${limitMiB} MiB limit.`;
  }
  const actualMiB = Math.ceil((actualBytes / MIB) * 10) / 10;
  return `Shared preview response is ${actualMiB} MiB; the limit is ${limitMiB} MiB.`;
}

export async function readResponseBody(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks, totalBytes);
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error(responseLimitMessage(maxBytes));
    }
    chunks.push(Buffer.from(value));
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async fetch(input, context) {
      const target = new URL(input.url);
      if ((target.protocol !== "http:" && target.protocol !== "https:") || target.username || target.password) {
        throw new Error("Shared previews support only HTTP and HTTPS targets.");
      }
      const signal = AbortSignal.any([
        context.signal,
        context.lifecycle.signal,
        AbortSignal.timeout(15_000),
      ]);
      const response = await fetch(target, {
        method: "GET",
        redirect: "manual",
        signal,
      });
      const declaredLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_RESPONSE_BYTES
      ) {
        await response.body?.cancel();
        throw new Error(
          responseLimitMessage(MAX_RESPONSE_BYTES, declaredLength),
        );
      }
      const reservedBytes = responseReservationBytes(response);
      try {
        await acquireActiveReservation(reservedBytes, signal);
      } catch (error) {
        await response.body?.cancel();
        throw error;
      }
      try {
        const body = await readResponseBody(response);
        const firstChunk = chunkResponseBody(body, 0);
        return {
          status: response.status,
          contentType:
            response.headers.get("content-type") ?? "application/octet-stream",
          location: response.headers.get("location"),
          bodyBase64: firstChunk.bodyBase64,
          continuationToken:
            firstChunk.nextOffset === null
              ? null
              : storePendingResponse(
                  body,
                  firstChunk.nextOffset,
                  context.experimental_retainWorker(),
                ),
        };
      } finally {
        releaseActiveReservation(reservedBytes);
      }
    },
    async fetchChunk({ continuationToken }) {
      prunePendingResponses();
      const pending = pendingResponses.get(continuationToken);
      if (!pending) {
        throw new Error("Shared preview response continuation expired.");
      }
      const chunk = chunkResponseBody(pending.body, pending.offset);
      if (chunk.nextOffset === null) {
        deletePendingResponse(continuationToken);
      } else {
        pending.offset = chunk.nextOffset;
        armPendingExpiry(continuationToken, pending);
      }
      return {
        bodyBase64: chunk.bodyBase64,
        continuationToken:
          chunk.nextOffset === null ? null : continuationToken,
      };
    },
    async discardResponse({ continuationToken }) {
      return { discarded: deletePendingResponse(continuationToken) };
    },
  },
  dispose() {
    for (const token of pendingResponses.keys()) deletePendingResponse(token);
    wakeBudgetWaiters();
  },
});
