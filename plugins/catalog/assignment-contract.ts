import { z } from "zod";

// Local copy of Projects C1 schema 1. No cross-package runtime dependency.
export const assignmentId = z.string().min(1).max(1_024);
export const assignmentRecordSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reference"), projectId: assignmentId.nullable(), targetId: assignmentId }).strict(),
  z.object({ type: z.literal("legacyBundle"), bundleId: assignmentId, kind: z.enum(["global", "project", "project-environment", "agent-profile"]), targetId: z.string().max(1_024) }).strict(),
]);
export type AssignmentRecord = z.infer<typeof assignmentRecordSchema>;
export const transferIdentitySchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("bundles"), generation: assignmentId,
  semanticDigest: z.string().regex(/^[a-f0-9]{64}$/u), destination: z.literal("catalog"),
  destinationVersion: z.string().regex(/^\d+\.\d+\.\d+$/u), adapterVersion: z.literal(1),
}).strict();
export type TransferIdentity = z.infer<typeof transferIdentitySchema>;
export const assignmentStatusSchema = z.object({
  kind: z.literal("bundles"),
  state: z.enum(["not-migrated", "source-owned", "frozen/exported", "destination-staged", "destination-owned", "reverse-frozen"]),
  transfer: transferIdentitySchema.nullable(), reverseGeneration: assignmentId.nullable(),
}).strict();
export const assignmentExportSchema = transferIdentitySchema.extend({
  frozen: z.literal(true), records: z.array(assignmentRecordSchema).max(200),
  recordCount: z.number().int().min(0).max(100_000), nextCursor: z.number().int().nonnegative().nullable(),
}).strict();
export const assignmentReceiptSchema = transferIdentitySchema.extend({
  phase: z.literal("staged"), recordCount: z.number().int().min(0).max(100_000),
  destinationRevision: assignmentId, conflicts: z.number().int().nonnegative(),
}).strict();
export type AssignmentReceipt = z.infer<typeof assignmentReceiptSchema>;
export const assignmentReverseSchema = transferIdentitySchema.extend({
  reverseGeneration: assignmentId, reverseDigest: transferIdentitySchema.shape.semanticDigest,
  recordCount: z.number().int().min(0).max(100_000), frozen: z.literal(true),
  records: z.array(assignmentRecordSchema).max(200), nextCursor: z.number().int().nonnegative().nullable(),
}).strict();
export const localAssignmentStatusSchema = z.object({
  state: z.enum(["uninitialized", "staged", "active", "reverse-frozen"]),
  transfer: transferIdentitySchema.nullable(), destinationRevision: assignmentId.nullable(),
  conflicts: z.number().int().nonnegative(),
}).strict();
export const bundleProjectionSchema = z.object({
  globalBundleIds: z.array(assignmentId),
  projects: z.array(z.object({ projectId: assignmentId, bundleIds: z.array(assignmentId) })),
});
export type BundleProjection = z.infer<typeof bundleProjectionSchema>;

export class AssignmentError extends Error {
  constructor(readonly reasonCode: "not-migrated" | "assignment-frozen" | "handoff-mismatch" | "owner-unavailable" | "caller-required", message: string) {
    super(`${reasonCode}: ${message}`);
    this.name = "AssignmentError";
  }
}

export function canonicalRecords(records: AssignmentRecord[]): AssignmentRecord[] {
  if (records.length > 100_000) throw new AssignmentError("handoff-mismatch", "Assignment snapshot exceeds 100,000 records.");
  const parsed = records.map((record) => assignmentRecordSchema.parse(record));
  const keys = parsed.map((record) => JSON.stringify(record));
  if (new Set(keys).size !== keys.length) throw new AssignmentError("handoff-mismatch", "Duplicate assignment records.");
  return parsed.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
}
export function sameIdentity(left: TransferIdentity | null, right: TransferIdentity): boolean {
  return left !== null && JSON.stringify(transferIdentitySchema.strip().parse(left)) === JSON.stringify(transferIdentitySchema.parse(right));
}
