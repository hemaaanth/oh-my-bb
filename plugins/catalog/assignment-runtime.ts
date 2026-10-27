import type { BbPluginApi, ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CatalogAssignmentStore } from "./assignment-store.js";
import {
  AssignmentError, assignmentExportSchema, assignmentId, assignmentStatusSchema,
  bundleProjectionSchema, sameIdentity, type BundleProjection, type TransferIdentity,
  type AssignmentRecord,
} from "./assignment-contract.js";

export function requireAssignmentClient(context: ExperimentalPluginRpcHandlerContext) {
  if (context?.experimental_caller?.kind !== "client") throw new AssignmentError("caller-required", "Use the native Executor client for an explicit assignment transition.");
}
export function requireProjects(context: ExperimentalPluginRpcHandlerContext) {
  if (context?.experimental_caller?.kind !== "plugin" || context.experimental_caller.pluginId !== "projects") {
    throw new AssignmentError("caller-required", "Only verified Projects may use assignment compatibility operations.");
  }
}

const toggleSchema = z.object({ targetId: assignmentId, enabled: z.boolean() }).strict();
const projectToggleSchema = toggleSchema.extend({ projectId: assignmentId });
const projectInputSchema = z.object({ projectId: assignmentId }).strict();
const bundleInputSchema = z.object({ bundleId: assignmentId }).strict();

export function createAssignmentRuntime(bb: BbPluginApi, store: CatalogAssignmentStore, runningVersion: string, changed: (projectId: string | null) => void) {
  async function sourceStatus() {
    try {
      return assignmentStatusSchema.parse(await bb.sdk.plugins.callRpc({ pluginId: "projects", method: "assignmentStatusV1", input: { kind: "bundles" }, outputSchema: assignmentStatusSchema }));
    } catch (error) {
      throw new AssignmentError("owner-unavailable", `Projects assignment authority is unavailable or older than C1. Initialize an explicitly fresh installation or complete the reviewed handoff. ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async function initialize(input: { confirmation: "no-legacy-assignments" }) {
    if (input?.confirmation !== "no-legacy-assignments") throw new AssignmentError("not-migrated", "Explicit no-legacy confirmation is required.");
    if (store.status().state === "active" && store.status().transfer === null) { store.initializeFresh(); return; }
    let sourcePresent = false;
    try { await sourceStatus(); sourcePresent = true; }
    catch (error) { if (!(error instanceof AssignmentError) || error.reasonCode !== "owner-unavailable") throw error; }
    if (sourcePresent) throw new AssignmentError("not-migrated", "Projects is present; complete its explicit import and source-first handoff. A declaration cannot bypass known source authority.");
    let metadata;
    try { metadata = z.object({ plugins: z.array(z.object({ id: z.string() })) }).parse(await bb.sdk.plugins.list()); }
    catch { throw new AssignmentError("owner-unavailable", "Native installed-plugin metadata is unavailable. Source absence is not established; leave assignments unchanged."); }
    if (metadata.plugins.some((plugin) => plugin.id === "projects")) throw new AssignmentError("not-migrated", "Projects is installed but unavailable or older than C1. Complete the reviewed handoff; do not initialize over it.");
    store.initializeFresh();
  }
  async function legacySource() {
    const before = store.status();
    if (before.state !== "uninitialized" && before.state !== "reverse-frozen") throw new AssignmentError("assignment-frozen", "Staged Executor assignments cannot use the source as a fallback.");
    const source = await sourceStatus();
    const current = store.status();
    if (current.state !== before.state || (before.transfer && !sameIdentity(current.transfer, before.transfer))) throw new AssignmentError("assignment-frozen", "Local assignment authority changed while checking the source.");
    if (before.state === "reverse-frozen" && (source.state !== "source-owned" || !before.transfer
      || !sameIdentity(source.transfer, before.transfer) || source.reverseGeneration !== store.reverseGeneration())) {
      throw new AssignmentError("assignment-frozen", "Projects has not durably accepted this exact reverse snapshot. Local rows remain frozen.");
    }
    return source;
  }
  function requirePinnedRelease(identity: TransferIdentity) {
    if (identity.destinationVersion !== runningVersion) throw new AssignmentError("handoff-mismatch", `Staging and first activation require Executor ${identity.destinationVersion}; running ${runningVersion}. Preserve the stage and reinstall the reviewed release, or reverse-reconcile without activation.`);
  }
  async function requireSource(identity: TransferIdentity, states: readonly string[]) {
    const status = await sourceStatus();
    if (!states.includes(status.state) || !sameIdentity(status.transfer, identity)) throw new AssignmentError("handoff-mismatch", "Fresh Projects status does not authorize this exact assignment generation.");
    return status;
  }
  async function stage(identity: TransferIdentity) {
    requirePinnedRelease(identity);
    await requireSource(identity, ["frozen/exported", "destination-staged"]);
    const records: AssignmentRecord[] = [];
    let cursor: number | null = 0;
    let total: number | null = null;
    while (cursor !== null) {
      const page = assignmentExportSchema.parse(await bb.sdk.plugins.callRpc({ pluginId: "projects", method: "assignmentExportV1", input: { kind: "bundles", generation: identity.generation, cursor }, outputSchema: assignmentExportSchema }));
      if (!sameIdentity(page, identity) || (total !== null && total !== page.recordCount)) throw new AssignmentError("handoff-mismatch", "Source export identity or count changed between pages.");
      total = page.recordCount;
      records.push(...page.records);
      if (records.length > total || (page.nextCursor !== null && (page.records.length === 0 || page.nextCursor !== records.length)) || (page.nextCursor === null && records.length !== total)) {
        throw new AssignmentError("handoff-mismatch", "Invalid source export cursor or count.");
      }
      cursor = page.nextCursor;
    }
    await requireSource(identity, ["frozen/exported", "destination-staged"]);
    return store.stage(identity, records);
  }
  async function activate(identity: TransferIdentity) {
    const local = store.status();
    if (local.state === "active") { store.requireActive(identity); return; }
    requirePinnedRelease(identity);
    // Never infer activation from a source receipt, copied rows or a cached status.
    await requireSource(identity, ["destination-owned"]);
    store.activate(identity);
  }
  async function read(): Promise<BundleProjection> {
    const local = store.status();
    if (local.state === "active") return store.projection();
    const source = await legacySource();
    if (source.state === "not-migrated") throw new AssignmentError("not-migrated", "Projects assignments require explicit import or fresh initialization.");
    if (source.state === "destination-owned" || source.state === "reverse-frozen") throw new AssignmentError("assignment-frozen", "Complete the exact Executor activation or reverse reconciliation. Do not fall back to legacy rows.");
    return bundleProjectionSchema.parse(await bb.sdk.plugins.callRpc({ pluginId: "projects", method: "bundleAssignmentSnapshot", input: null, outputSchema: bundleProjectionSchema }));
  }
  async function write(method: "setGlobalBundle" | "setProjectBundle" | "removeBundle", input: unknown) {
    const value = method === "setProjectBundle" ? projectToggleSchema.parse(input) : method === "setGlobalBundle" ? toggleSchema.parse(input) : bundleInputSchema.parse(input);
    const local = store.status();
    if (local.state === "active") store.write(method, value);
    else {
      const source = await legacySource();
      if (source.state !== "source-owned") throw new AssignmentError(source.state === "not-migrated" ? "not-migrated" : "assignment-frozen", "Projects is not the writable assignment authority.");
      await bb.sdk.plugins.callRpc({ pluginId: "projects", method, input: value, outputSchema: z.object({ ok: z.literal(true) }).strict() });
    }
    changed("projectId" in value && typeof value.projectId === "string" ? value.projectId : null);
    return { ok: true as const };
  }
  function compatibilityRead(identity: TransferIdentity, method: string, input: unknown) {
    store.requireActive(identity);
    const projection = store.projection();
    if (method === "bundleAssignmentSnapshot") { z.null().parse(input); return projection; }
    if (method === "globalContext") { z.null().parse(input); return { bundleIds: projection.globalBundleIds }; }
    const bundleIds = (projectId: string) => [...new Set([...projection.globalBundleIds, ...(projection.projects.find((project) => project.projectId === projectId)?.bundleIds ?? [])])];
    if (method === "projectContext") return { bundleIds: bundleIds(projectInputSchema.parse(input).projectId) };
    if (method === "projectContexts") {
      const { projectIds } = z.object({ projectIds: z.array(assignmentId).max(5_000).refine((ids) => new Set(ids).size === ids.length) }).strict().parse(input);
      return { projects: projectIds.map((projectId) => ({ projectId, bundleIds: bundleIds(projectId) })) };
    }
    if (method === "bundleAssignments") {
      const { bundleId } = bundleInputSchema.parse(input);
      return { global: projection.globalBundleIds.includes(bundleId), projectIds: projection.projects.filter((project) => project.bundleIds.includes(bundleId)).map((project) => project.projectId) };
    }
    throw new AssignmentError("handoff-mismatch", "Unsupported bundle compatibility read.");
  }
  async function reverse(identity: TransferIdentity, cursor: number, reverseGeneration: string | null) {
    const local = store.status();
    if (!sameIdentity(local.transfer, identity)) throw new AssignmentError("handoff-mismatch", "Reverse request differs from the preserved destination identity.");
    await requireSource(identity, ["reverse-frozen"]);
    return store.reverseExport(identity, cursor, reverseGeneration);
  }
  return { sourceStatus, initialize, stage, activate, read, write, compatibilityRead, reverse, requirePinnedRelease };
}
