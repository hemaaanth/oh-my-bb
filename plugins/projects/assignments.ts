import { z } from "zod";

const id = z.string().min(1).max(1_024);
export const assignmentKindSchema = z.enum(["bundles", "applicationBindings", "agentPreferences"]);
export type AssignmentKind = z.infer<typeof assignmentKindSchema>;
export const assignmentKinds = assignmentKindSchema.options;
export const destinations: Record<AssignmentKind, string> = {
  bundles: "catalog", applicationBindings: "project-environments", agentPreferences: "agent-profiles",
};
export const assignmentRecordSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reference"), projectId: id.nullable(), targetId: id }).strict(),
  z.object({ type: z.literal("binding"), projectId: id, credentialId: id.nullable() }).strict(),
  z.object({ type: z.literal("legacyBundle"), bundleId: id, kind: z.enum(["global", "project", "project-environment", "agent-profile"]), targetId: z.string().max(1_024) }).strict(),
  z.object({ type: z.literal("legacyBinding"), projectId: id, credentialId: id.nullable() }).strict(),
]);
export type AssignmentRecord = z.infer<typeof assignmentRecordSchema>;
export const transferIdentitySchema = z.object({
  schemaVersion: z.literal(1), kind: assignmentKindSchema, generation: id,
  semanticDigest: z.string().regex(/^[a-f0-9]{64}$/u), destination: id,
  destinationVersion: z.string().regex(/^\d+\.\d+\.\d+$/u), adapterVersion: z.literal(1),
}).strict();
export type TransferIdentity = z.infer<typeof transferIdentitySchema>;
export const receiptSchema = transferIdentitySchema.extend({
  phase: z.literal("staged"), recordCount: z.number().int().nonnegative(),
  destinationRevision: id, conflicts: z.number().int().nonnegative(),
}).strict();
export type AssignmentReceipt = z.infer<typeof receiptSchema>;
export const transferStateSchema = z.enum(["source-owned", "frozen/exported", "destination-staged", "destination-owned", "reverse-frozen"]);
export const assignmentStatusSchema = z.object({
  kind: assignmentKindSchema,
  state: z.enum(["not-migrated", ...transferStateSchema.options]),
  transfer: transferIdentitySchema.nullable(),
  reverseGeneration: id.nullable(),
}).strict();
export const exportPageSchema = transferIdentitySchema.extend({
  frozen: z.literal(true), records: z.array(assignmentRecordSchema).max(200),
  recordCount: z.number().int().nonnegative(), nextCursor: z.number().int().nonnegative().nullable(),
}).strict();
export const handoffInputSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("freeze"), kind: assignmentKindSchema, destination: id, destinationVersion: transferIdentitySchema.shape.destinationVersion }).strict(),
  transferIdentitySchema.extend({ phase: z.enum(["stage", "commit", "abort", "reverse-freeze", "reverse-commit"]) }).strict(),
]);
export const reverseReceiptSchema = transferIdentitySchema.extend({
  reverseGeneration: id, reverseDigest: transferIdentitySchema.shape.semanticDigest,
  recordCount: z.number().int().nonnegative(), frozen: z.literal(true),
}).strict();
export const reversePageSchema = reverseReceiptSchema.extend({
  records: z.array(assignmentRecordSchema).max(200), nextCursor: z.number().int().nonnegative().nullable(),
}).strict();

export class AssignmentError extends Error {
  constructor(readonly reasonCode: "not-migrated" | "assignment-frozen" | "handoff-mismatch" | "handoff-loop" | "owner-unavailable" | "owner-client-required", message: string) {
    super(`${reasonCode}: ${message}`);
    this.name = "AssignmentError";
  }
}

export function requireOwnerClient(context: { experimental_caller: { kind: string } } | undefined) {
  if (context?.experimental_caller.kind !== "client") throw new AssignmentError("owner-client-required", "Use the native Projects client for assignment migration.");
}

export function validateRecords(kind: AssignmentKind, records: AssignmentRecord[]) {
  for (const record of records) {
    const valid = kind === "applicationBindings"
      ? record.type === "binding" || record.type === "legacyBinding"
      : record.type === "reference" || (kind === "bundles" && record.type === "legacyBundle");
    if (!valid) throw new AssignmentError("handoff-mismatch", "Record kind differs from the frozen assignment kind.");
  }
  const keys = records.map((record) => JSON.stringify(record.type === "reference"
    ? [record.type, record.projectId, record.targetId]
    : record.type === "binding" ? [record.type, record.projectId] : record));
  if (new Set(keys).size !== keys.length) throw new AssignmentError("handoff-mismatch", "Duplicate assignment records.");
}
