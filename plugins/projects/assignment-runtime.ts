import type { BbPluginApi, ExperimentalPluginRpcHandlerContext, JsonValue } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { AssignmentStore, MAX_ASSIGNMENT_RECORDS } from "./assignment-store.js";
import {
  AssignmentError, assignmentKinds, destinations, handoffInputSchema, receiptSchema, requireOwnerClient, reversePageSchema,
  transferIdentitySchema, type AssignmentKind, type AssignmentRecord,
} from "./assignments.js";

const installedPluginsSchema = z.object({
  plugins: z.array(z.object({ id: z.string().min(1), enabled: z.boolean(), status: z.string().min(1) })),
});
const destinationAssignmentStatusSchema = z.object({
  state: z.enum(["uninitialized", "staged", "active", "reverse-frozen"]),
  transfer: transferIdentitySchema.nullable(),
  destinationRevision: transferIdentitySchema.shape.generation.nullable(),
  conflicts: z.number().int().nonnegative(),
}).strict();

export function createAssignmentRuntime(bb: BbPluginApi, store: AssignmentStore) {
  async function requireSetupAuthority() {
    let installed: z.infer<typeof installedPluginsSchema>;
    try {
      installed = installedPluginsSchema.parse(await bb.sdk.plugins.list());
      if (new Set(installed.plugins.map((plugin) => plugin.id)).size !== installed.plugins.length) throw new Error("Duplicate installed plugin IDs");
    } catch {
      throw new AssignmentError("not-migrated", "Native installed-plugin metadata is unavailable or unsupported. Destination absence is not established; setup changed no assignments.");
    }
    for (const kind of assignmentKinds) {
      const destination = destinations[kind];
      const plugin = installed.plugins.find((plugin) => plugin.id === destination);
      if (!plugin) continue;
      if (!plugin.enabled || plugin.status !== "running") throw new AssignmentError("not-migrated", `${destination} is installed but not running. Enable a compatible destination and retry setup; do not initialize beside an unavailable owner.`);
      let status: z.infer<typeof destinationAssignmentStatusSchema>;
      try {
        status = destinationAssignmentStatusSchema.parse(await bb.sdk.plugins.callRpc({ pluginId: destination, method: "assignmentStatus", input: null, outputSchema: destinationAssignmentStatusSchema }));
      } catch {
        throw new AssignmentError("not-migrated", `${destination} assignmentStatus is unavailable or unsupported. Upgrade or recover its assignment adapter before Projects setup.`);
      }
      if (status.state !== "uninitialized" || status.transfer !== null || status.destinationRevision !== null || status.conflicts !== 0) throw new AssignmentError("not-migrated", `${destination} already has ${status.state} assignment state. Destination-first adoption is unsupported; leave its authority unchanged. Native project organization remains available.`);
    }
  }

  async function read<T>(kind: AssignmentKind, method: string, input: JsonValue, schema: z.ZodType<T>, local: () => T | Promise<T>, context?: ExperimentalPluginRpcHandlerContext): Promise<T> {
    store.requireReady();
    const status = store.status(kind);
    if (status.state === "reverse-frozen") throw new AssignmentError("assignment-frozen", "Reverse reconciliation is pending.");
    if (status.state !== "destination-owned") return local();
    if (context?.experimental_caller.kind === "plugin" && context.experimental_caller.pluginId === status.transfer!.destination) throw new AssignmentError("handoff-loop", "The assignment owner must read its own state, not call Projects back.");
    try {
      return await bb.sdk.plugins.callRpc({ pluginId: status.transfer!.destination, method: "assignmentReadV1", input: { ...status.transfer!, method, input }, outputSchema: schema });
    } catch (error) {
      throw new AssignmentError("owner-unavailable", `${kind} owner did not return a compatible read. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function write(kind: AssignmentKind, method: string, input: JsonValue, context: ExperimentalPluginRpcHandlerContext, local: () => void | Promise<void>) {
    store.requireReady();
    if (!context?.experimental_caller) throw new AssignmentError("owner-client-required", "An authenticated client or plugin caller is required.");
    const status = store.status(kind);
    if (status.state === "destination-owned") {
      if (context?.experimental_caller.kind === "plugin" && context.experimental_caller.pluginId === status.transfer!.destination) throw new AssignmentError("handoff-loop", "The destination cannot write back through Projects. Upgrade its adapter before continuing.");
      try {
        return await bb.sdk.plugins.callRpc({ pluginId: status.transfer!.destination, method: "assignmentWriteV1", input: { ...status.transfer!, method, input }, outputSchema: z.object({ ok: z.literal(true) }).strict() });
      } catch (error) {
        throw new AssignmentError("owner-unavailable", `${kind} remains destination-owned. ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    store.requireWritable(kind);
    await local();
    return { ok: true as const };
  }

  async function handoff(input: z.infer<typeof handoffInputSchema>, context: ExperimentalPluginRpcHandlerContext) {
    requireOwnerClient(context);
    if (input.phase === "freeze") return store.freeze(input.kind, input.destination, input.destinationVersion);
    const { phase, ...fields } = input;
    const identity = transferIdentitySchema.parse(fields);
    if (phase === "abort") {
      const aborted = store.abort(identity);
      if (aborted.notifyDestination) {
        // The durable source abort, not delivery of this advisory notice, revokes activation.
        void bb.sdk.plugins.callRpc({ pluginId: identity.destination, method: "assignmentAbortV1", input: identity, outputSchema: z.object({ ok: z.literal(true) }).strict() }).catch(() => {});
      }
      return aborted.status;
    }
    let current = store.match(identity);
    if (phase === "stage" || phase === "commit") {
      if (current.state === "destination-owned" || (phase === "stage" && current.state === "destination-staged")) return current;
      if (current.state !== (phase === "stage" ? "frozen/exported" : "destination-staged")) throw new AssignmentError("handoff-mismatch", "Stage the frozen transfer before commit.");
      const receipt = receiptSchema.parse(await bb.sdk.plugins.callRpc({ pluginId: identity.destination, method: "assignmentReceiptV1", input: identity, outputSchema: receiptSchema }));
      const { phase: _phase, recordCount, destinationRevision: _revision, conflicts, ...receivedIdentity } = receipt;
      current = store.match(identity);
      if (JSON.stringify(receivedIdentity) !== JSON.stringify(identity)) throw new AssignmentError("handoff-mismatch", "Destination receipt identity differs from the requested transfer.");
      if (current.state === "destination-owned" || (phase === "stage" && current.state === "destination-staged")) return current;
      if (current.state !== (phase === "stage" ? "frozen/exported" : "destination-staged")) throw new AssignmentError("handoff-mismatch", "Transfer state changed while awaiting the destination receipt.");
      const page = store.page(identity.kind, identity.generation, 0);
      if (recordCount !== page.recordCount || conflicts > recordCount) throw new AssignmentError("handoff-mismatch", "Destination record/conflict count differs from the frozen export.");
      // Destination stays read-only until it observes this durable destination-owned state.
      return store.transition(identity, [phase === "stage" ? "frozen/exported" : "destination-staged"], phase === "stage" ? "destination-staged" : "destination-owned", receipt);
    }
    if (phase === "reverse-freeze") {
      return store.transition(identity, ["destination-owned"], "reverse-frozen");
    }
    if (current.state === "source-owned" && current.reverseGeneration) return current;
    if (current.state !== "reverse-frozen") throw new AssignmentError("handoff-mismatch", "Reverse-freeze Projects before requesting a frozen destination export.");
    const records: AssignmentRecord[] = [];
    let cursor: number | null = 0;
    let reverseGeneration: string | null = null;
    let reverseDigest: string | null = null;
    let total: number | null = null;
    while (cursor !== null) {
      const page = reversePageSchema.parse(await bb.sdk.plugins.callRpc({ pluginId: identity.destination, method: "assignmentReverseExportV1", input: { ...identity, cursor, reverseGeneration }, outputSchema: reversePageSchema }));
      const { reverseGeneration: pageGeneration, reverseDigest: pageDigest, recordCount, frozen: _frozen, records: pageRecords, nextCursor, ...receivedIdentity } = page;
      current = store.match(receivedIdentity);
      if (current.state !== "reverse-frozen") throw new AssignmentError("handoff-mismatch", "Reverse reconciliation state changed.");
      if ((reverseGeneration !== null && reverseGeneration !== pageGeneration) || (reverseDigest !== null && reverseDigest !== pageDigest) || (total !== null && total !== recordCount) || recordCount > MAX_ASSIGNMENT_RECORDS) throw new AssignmentError("handoff-mismatch", "Reverse export changed between pages or exceeds the record limit.");
      reverseGeneration = pageGeneration;
      reverseDigest = pageDigest;
      total = recordCount;
      records.push(...pageRecords);
      if (records.length > recordCount || (nextCursor !== null && (pageRecords.length === 0 || nextCursor !== records.length)) || (nextCursor === null && records.length !== recordCount)) throw new AssignmentError("handoff-mismatch", "Invalid reverse export cursor or count.");
      cursor = nextCursor;
    }
    return store.reconcileReverse(identity, reverseGeneration!, reverseDigest!, records);
  }

  return { read, write, handoff, requireSetupAuthority };
}
