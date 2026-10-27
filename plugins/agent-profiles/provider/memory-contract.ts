import { z } from "zod";

export const MEMORY_CHUNK_BYTES = 64 * 1024;
export const MEMORY_PAGE_ENTRIES = 64;
export const MEMORY_HTTP_BYTES = 128 * 1024;
export const MEMORY_GUARD_FILE = "remote-pending.json";
const MEMORY_GUARD_PATTERN = /^remote-pending\.json(?:\.[a-f0-9-]{36}\.tmp)?$/i;
export const isMemoryGuardName = (name: string): boolean => MEMORY_GUARD_PATTERN.test(name);
export const operationIdSchema = z.string().uuid();
export const profileNameSchema = z.string().regex(/^agent-[a-z0-9][a-z0-9_-]{0,57}$/);
export const relativePathSchema = z.string().min(1).max(4096).refine((value) =>
  !value.includes("\\") && !value.includes("\0") && !value.startsWith("/") &&
  !/^[a-z]:/i.test(value) && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
"Expected a normalized profile-relative path.");
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const memoryEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("directory"), path: relativePathSchema, mode: z.number().int().min(0).max(0o777) }).strict(),
  z.object({ kind: z.literal("file"), path: relativePathSchema, mode: z.number().int().min(0).max(0o777), size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sha256: digestSchema }).strict(),
]);
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export type MemoryManifest = { entries: MemoryEntry[]; digest: string; bytes: number };
const operation = z.object({ operationId: operationIdSchema }).strict();
const page = operation.extend({ cursor: z.number().int().nonnegative() });
const chunk = operation.extend({ path: relativePathSchema, offset: z.number().int().nonnegative() });
const dataSchema = z.string().max(Math.ceil(MEMORY_CHUNK_BYTES / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const summarySchema = z.object({ digest: digestSchema, entries: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() });
const pageSchema = z.object({ entries: z.array(memoryEntrySchema).max(MEMORY_PAGE_ENTRIES), nextCursor: z.number().int().nonnegative().nullable() });
export const memoryPendingSchema = z.object({ operationId: operationIdSchema, profile: profileNameSchema, hostId: z.string().min(1), threadId: z.string().min(1), directory: z.string().min(1).max(4096), phase: z.enum(["prepared", "running", "failed"]), baseDigest: digestSchema });
export type MemoryPending = z.infer<typeof memoryPendingSchema>;
const stateSchema = z.object({ home: z.string(), pending: memoryPendingSchema.nullable(), held: z.boolean() });
const acquiredSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("busy"), message: z.string() }),
  z.object({ status: z.literal("acquired"), ...summarySchema.shape }),
  z.object({ status: z.literal("committed") }),
]);
export const memoryHostContract = {
  memoryState: { input: z.object({ profile: profileNameSchema }).strict(), output: stateSchema },
  memoryAcquire: {
    input: memoryPendingSchema.omit({ phase: true, baseDigest: true }).extend({ instructions: z.string(), recover: z.boolean().default(false) }),
    output: acquiredSchema,
  },
  memoryPage: { input: page, output: pageSchema },
  memoryRead: { input: chunk, output: z.object({ data: dataSchema }) },
  memoryRunning: { input: operation, output: z.null() },
  memoryReceive: { input: operation.extend(summarySchema.shape), output: z.null() },
  memoryReceivePage: { input: operation.extend({ entries: z.array(memoryEntrySchema).max(MEMORY_PAGE_ENTRIES) }), output: z.null() },
  memoryWrite: { input: chunk.extend({ data: dataSchema }), output: z.null() },
  memoryCommit: { input: operation, output: z.null() },
  memoryRelease: { input: operation.extend({ failed: z.boolean() }), output: z.object({ committed: z.boolean() }) },
  memoryRemote: { input: operation, output: z.object({ ready: z.literal(false) }).or(z.object({ ready: z.literal(true), profile: profileNameSchema, ...summarySchema.shape })) },
  memoryRemotePage: { input: page, output: pageSchema },
  memoryRemoteRead: { input: chunk, output: z.object({ data: dataSchema }) },
  memoryRemoteDelete: { input: operation, output: z.null() },
} as const;
export type MemoryHostContract = typeof memoryHostContract;

export const memoryRequestSchema = z.discriminatedUnion("action", [
  operation.extend({ action: z.literal("prepare"), directory: z.string().min(1).max(4096) }),
  page.extend({ action: z.literal("page") }),
  chunk.extend({ action: z.literal("read") }),
  operation.extend({ action: z.literal("running") }),
  operation.extend({ action: z.literal("receive"), ...summarySchema.shape }),
  operation.extend({ action: z.literal("receivePage"), entries: z.array(memoryEntrySchema).max(MEMORY_PAGE_ENTRIES) }),
  chunk.extend({ action: z.literal("write"), data: dataSchema }),
  operation.extend({ action: z.literal("commit") }),
  operation.extend({ action: z.literal("release"), failed: z.boolean() }),
  operation.extend({ action: z.literal("heartbeat") }),
]);
export type MemoryRequest = z.infer<typeof memoryRequestSchema>;
