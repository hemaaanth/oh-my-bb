import { createHash, randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const scopeType = z.enum(["global", "project", "environment"]);
const itemType = z.enum(["context", "napkin", "papercut"]);
const contextKind = z.enum(["fact", "preference"]);
const contextTopic = z.enum(["design", "copy", "engineering", "workflow"]);
// Design and Copy are appended after the original five so the legacy category
// order (and therefore the injected section order) is unchanged.
const napkinCategory = z.enum([
  "Execution",
  "Validation",
  "Tooling",
  "Repository Conventions",
  "Domain Guardrails",
  "Design",
  "Copy",
]);
const DESIGN_COPY_TOPICS: ReadonlySet<z.infer<typeof contextTopic>> = new Set([
  "design",
  "copy",
]);
const DESIGN_COPY_CATEGORIES: ReadonlySet<z.infer<typeof napkinCategory>> =
  new Set(["Design", "Copy"]);
const severity = z.enum(["minor", "major", "blocker"]);
const SEVERITY_RANK = { minor: 1, major: 2, blocker: 3 } as const;
const lifecycle = z.enum(["open", "resolved", "dismissed"]);
const safeKey = z.string().min(1).max(80).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
const safeText = z.string().min(1).max(240).refine(isSafeText, {
  message: "Use one generalized line without paths, source excerpts, or secrets",
});
const scopeRef = z.object({ type: scopeType, id: z.string().min(1).max(120) }).strict();

const scopeRecord = z.object({
  type: scopeType,
  id: z.string(),
  label: z.string(),
  parentId: z.string().nullable(),
});
const contextRecord = z.object({
  id: z.string(), logicalKey: z.string(), kind: contextKind, value: z.string(),
  priority: z.number().int(), updatedAt: z.number().int(),
  topic: contextTopic,
  // Audit metadata: surfaced in the dashboard only, never injected into instructions.
  sourceThreadId: z.string().nullable(), consentRef: z.string().nullable(),
  unconsented: z.boolean(),
});
const napkinRecord = z.object({
  id: z.string(), logicalKey: z.string(), category: napkinCategory,
  priority: z.number().int(), recurrence: z.number().int(), hitCount: z.number().int(),
  situation: z.string(), action: z.string(), updatedAt: z.number().int(),
  sourceThreadId: z.string().nullable(),
});
const papercutRecord = z.object({
  id: z.string(), fingerprint: z.string(), summary: z.string(), severity,
  prevention: z.string(), acceptanceCondition: z.string(), lifecycle,
  recurrence: z.number().int(), updatedAt: z.number().int(),
  sourceThreadId: z.string().nullable(),
});
const scopedContextRecord = contextRecord.extend({ scope: scopeRecord });
const scopedNapkinRecord = napkinRecord.extend({ scope: scopeRecord });
const scopedPapercutRecord = papercutRecord.extend({ scope: scopeRecord });

export const rpcContract = defineRpcContract({
  dashboard: {
    input: z.object({
      projectId: z.string().nullable(),
      threadId: z.string().nullable(),
      scope: scopeRef.nullable(),
    }).strict(),
    output: z.object({
      scopes: z.array(scopeRecord),
      selectedScope: scopeRecord.nullable(),
      currentEnvironmentId: z.string().nullable(),
      context: z.array(scopedContextRecord),
      napkins: z.array(scopedNapkinRecord),
      papercuts: z.array(scopedPapercutRecord),
    }),
  },
  saveContext: {
    input: z.object({
      scope: scopeRef, logicalKey: safeKey, kind: contextKind,
      value: safeText, priority: z.number().int().min(0).max(100),
      topic: contextTopic.default("engineering"),
      provenance: z.string().min(1).max(120).optional(),
      consentRef: z.string().min(1).max(240).optional(),
    }).strict(),
    output: contextRecord,
  },
  saveNapkin: {
    input: z.object({
      scope: scopeRef, logicalKey: safeKey, category: napkinCategory,
      situation: safeText, action: safeText,
      priority: z.number().int().min(0).max(100),
    }).strict(),
    output: napkinRecord,
  },
  savePapercut: {
    input: z.object({
      scope: scopeRef, fingerprint: safeKey, summary: safeText, severity,
      prevention: safeText, acceptanceCondition: safeText,
    }).strict(),
    output: papercutRecord,
  },
  markHit: {
    input: z.object({ id: z.string().uuid() }).strict(),
    output: napkinRecord,
  },
  updatePapercut: {
    input: z.object({ id: z.string().uuid(), lifecycle }).strict(),
    output: papercutRecord,
  },
  remove: {
    input: z.object({ type: itemType, id: z.string().uuid() }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
});

type ScopeType = z.infer<typeof scopeType>;
type ScopeRef = z.infer<typeof scopeRef>;
type ToolContext = { threadId: string; projectId: string; signal: AbortSignal };
type Db = ReturnType<BbPluginApi["storage"]["database"]>;

type ContextRow = {
  id: string; logical_key: string; kind: "fact" | "preference"; value: string;
  priority: number; updated_at: number; topic: z.infer<typeof contextTopic>;
  source_thread_id: string | null; consent_ref: string | null;
};
type NapkinRow = {
  id: string; logical_key: string; category: z.infer<typeof napkinCategory>;
  priority: number; recurrence: number; hit_count: number; situation: string;
  action: string; updated_at: number; source_thread_id: string | null;
};
type PapercutRow = {
  id: string; fingerprint: string; summary: string; severity: z.infer<typeof severity>;
  prevention: string; acceptance_condition: string; lifecycle: z.infer<typeof lifecycle>;
  recurrence: number; updated_at: number; source_thread_id: string | null;
};
type ScopeRow = {
  scope_type: ScopeType; scope_id: string; label: string; parent_scope_id: string | null;
};

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [SCHEMA, RETIRED_IMPORT_SCHEMA, TOPIC_PROVENANCE_SCHEMA]);

  const settings = bb.settings.define({
    contextCharacterCap: {
      type: "select", label: "Active context character cap",
      options: ["1000", "2000", "4000"], default: "2000",
    },
    napkinsPerCategory: {
      type: "select", label: "Napkins per category",
      options: ["1", "3", "5"], default: "3",
    },
    designCopyReserve: {
      type: "select", label: "Design/copy context reserve (characters)",
      options: ["200", "400", "600"], default: "400",
    },
  });
  let currentSettings = await settings.get();
  settings.onChange((next) => { currentSettings = next; });

  rememberScope(db, { type: "global", id: "global" }, "Everywhere", null);

  const changed = () => bb.realtime.publish("changed", { at: Date.now() });
  const store = createStore(db, changed);

  bb.rpc.register(rpcContract, {
    dashboard: async ({ projectId, threadId, scope }) => {
      const thread = threadId ? await bb.sdk.threads.get({ threadId }) : null;
      const currentProjectId = projectId ?? thread?.projectId ?? null;
      const project = currentProjectId
        ? await bb.sdk.projects.get({ projectId: currentProjectId })
        : null;
      const projectScope = project ? projectScopeRef(project) : null;
      if (projectScope) rememberScope(db, projectScope, project!.name, null);
      if (thread?.environmentId) {
        rememberScope(
          db,
          { type: "environment", id: thread.environmentId },
          "This worktree",
          projectScope?.id ?? null,
        );
      }
      const scopes = listScopes(db, projectScope?.id ?? null);
      const selected = scope && scopes.some((item) => item.type === scope.type && item.id === scope.id)
        ? scope
        : projectScope;
      const selectedScope = selected
        ? scopes.find((item) => item.type === selected.type && item.id === selected.id) ?? null
        : null;
      const visibleScopes = selectedScope ? [selectedScope] : scopes;
      return {
        scopes,
        selectedScope,
        currentEnvironmentId: thread?.environmentId ?? null,
        context: visibleScopes
          .flatMap((visibleScope) => store.listContext(visibleScope).map((record) => ({ ...record, scope: visibleScope })))
          .sort((left, right) => right.priority - left.priority || right.updatedAt - left.updatedAt),
        napkins: visibleScopes
          .flatMap((visibleScope) => store.listNapkins(visibleScope).map((record) => ({ ...record, scope: visibleScope })))
          .sort((left, right) => right.priority - left.priority || right.recurrence - left.recurrence || right.hitCount - left.hitCount || right.updatedAt - left.updatedAt),
        papercuts: visibleScopes
          .flatMap((visibleScope) => store.listPapercuts(visibleScope).map((record) => ({ ...record, scope: visibleScope })))
          .sort((left, right) => SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] || right.updatedAt - left.updatedAt),
      };
    },
    saveContext: ({ provenance, consentRef, ...input }) => store.saveContext({
      ...input,
      sourceThreadId: provenance ?? null,
      consentRef: consentRef ?? null,
    }),
    saveNapkin: (input) => store.saveNapkin({ ...input, sourceThreadId: null }),
    savePapercut: (input) => store.savePapercut({ ...input, sourceThreadId: null }),
    markHit: ({ id }) => store.markHit(id),
    updatePapercut: ({ id, lifecycle }) => store.updatePapercut(id, lifecycle),
    remove: ({ type, id }) => ({ removed: store.remove(type, id) }),
  });

  const targetScope = async (target: ScopeType, ctx: ToolContext): Promise<ScopeRef> => {
    if (target === "global") return { type: "global", id: "global" };
    if (target === "project") {
      return projectScopeRef(await bb.sdk.projects.get({ projectId: ctx.projectId, signal: ctx.signal }));
    }
    const thread = await bb.sdk.threads.get({ threadId: ctx.threadId, signal: ctx.signal });
    if (!thread.environmentId) throw new Error("This thread has no environment scope");
    return { type: "environment", id: thread.environmentId };
  };

  bb.agents.registerTool({
    name: "clasi_remember_context",
    description: "Remember one durable generalized fact or preference at global, project, or environment scope.",
    instructions: PRIVACY_INSTRUCTIONS,
    presentation: {
      label: {
        pending: "Remembering context",
        completed: "Remembered context",
      },
      icon: { glyph: "Brain" },
    },
    parameters: z.object({
      scope: scopeType, logicalKey: safeKey, kind: contextKind, value: safeText,
      priority: z.number().int().min(0).max(100).default(50),
      topic: contextTopic.default("engineering"),
    }).strict(),
    async execute(input, ctx) {
      const record = store.saveContext({
        ...input,
        scope: await targetScope(input.scope, ctx),
        sourceThreadId: ctx.threadId,
        consentRef: null,
      });
      return JSON.stringify({ status: "saved", record });
    },
  });
  bb.agents.registerTool({
    name: "clasi_remember_napkin",
    description: "Create or reinforce a short reusable working lesson.",
    instructions: PRIVACY_INSTRUCTIONS,
    presentation: {
      label: {
        pending: "Saving working lesson",
        completed: "Saved working lesson",
      },
      icon: { glyph: "FileText" },
    },
    parameters: z.object({
      scope: scopeType, logicalKey: safeKey, category: napkinCategory,
      situation: safeText, action: safeText,
      priority: z.number().int().min(0).max(100).default(50),
    }).strict(),
    async execute(input, ctx) {
      const record = store.saveNapkin({
        ...input,
        scope: await targetScope(input.scope, ctx),
        sourceThreadId: ctx.threadId,
      });
      return JSON.stringify({ status: "saved", record });
    },
  });
  bb.agents.registerTool({
    name: "clasi_mark_napkin_hit",
    description: "Record that an injected napkin materially helped the current task.",
    presentation: {
      label: {
        pending: "Recording lesson use",
        completed: "Recorded lesson use",
      },
      icon: { glyph: "CircleCheck" },
      suppress: true,
    },
    parameters: z.object({ id: z.string().uuid() }).strict(),
    execute({ id }) {
      return JSON.stringify({ status: "updated", record: store.markHit(id) });
    },
  });
  bb.agents.registerTool({
    name: "clasi_capture_papercut",
    description: "Capture or reinforce unresolved, fixable workflow friction without interrupting the task.",
    instructions: PRIVACY_INSTRUCTIONS,
    presentation: {
      label: {
        pending: "Capturing workflow papercut",
        completed: "Captured workflow papercut",
      },
      icon: { glyph: "Bug" },
    },
    parameters: z.object({
      scope: scopeType, fingerprint: safeKey, summary: safeText, severity,
      prevention: safeText, acceptanceCondition: safeText,
    }).strict(),
    async execute(input, ctx) {
      const record = store.savePapercut({
        ...input,
        scope: await targetScope(input.scope, ctx),
        sourceThreadId: ctx.threadId,
      });
      return JSON.stringify({ status: "saved", record });
    },
  });
  bb.agents.registerTool({
    name: "clasi_update_papercut",
    description: "Resolve, dismiss, or reopen a known papercut.",
    presentation: {
      label: {
        pending: "Updating workflow papercut",
        completed: "Updated workflow papercut",
      },
      icon: { glyph: "CircleCheck" },
    },
    parameters: z.object({ id: z.string().uuid(), lifecycle }).strict(),
    execute({ id, lifecycle }) {
      return JSON.stringify({ status: "updated", record: store.updatePapercut(id, lifecycle) });
    },
  });

  bb.agents.configure((context) => {
    const projectScope = projectScopeRef(context.project);
    rememberScope(db, projectScope, context.project.name, null);
    rememberScope(
      db,
      { type: "environment", id: context.environment.id },
      context.environment.name ?? context.environment.branchName ?? context.environment.id,
      projectScope.id,
    );
    const scopes: ScopeRef[] = [
      { type: "global", id: "global" },
      projectScope,
      { type: "environment", id: context.environment.id },
    ];
    return {
      tools: [
        "clasi_remember_context",
        "clasi_remember_napkin",
        "clasi_mark_napkin_hit",
        "clasi_capture_papercut",
        "clasi_update_papercut",
      ],
      skills: ["clasi"],
      instructions: buildActiveView(
        db,
        scopes,
        Number(currentSettings.contextCharacterCap),
        Number(currentSettings.napkinsPerCategory),
        Number(currentSettings.designCopyReserve),
      ),
    };
  });

  bb.cli.register({
    name: "clasi",
    summary: "Inspect and manage scoped Context, Napkins, and Papercuts",
    commands: [
      { name: "status", summary: "Show record counts", usage: "bb clasi status" },
      { name: "list", summary: "List one scope", usage: "bb clasi list [global|project:<id>|environment:<id>]" },
      { name: "remove", summary: "Delete a record", usage: "bb clasi remove <context|napkin|papercut> <uuid> --confirm" },
    ],
    async run(argv, ctx) {
      const command = argv[0] ?? "status";
      if (command === "status") return { exitCode: 0, stdout: `${JSON.stringify(store.status(), null, 2)}\n` };
      if (command === "list") {
        const scope = await cliScope(argv[1] ?? "global", ctx.projectId, ctx.threadId, bb);
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            scope,
            context: store.listContext(scope),
            napkins: store.listNapkins(scope),
            papercuts: store.listPapercuts(scope),
          }, null, 2)}\n`,
        };
      }
      if (command === "remove") {
        const parsedType = itemType.safeParse(argv[1]);
        const id = z.string().uuid().safeParse(argv[2]);
        if (!parsedType.success || !id.success || !argv.includes("--confirm")) {
          return { exitCode: 2, stderr: "usage: bb clasi remove <context|napkin|papercut> <uuid> --confirm\n" };
        }
        return { exitCode: 0, stdout: `${JSON.stringify({ removed: store.remove(parsedType.data, id.data) })}\n` };
      }
      return { exitCode: 2, stderr: "usage: bb clasi <status|list|remove>\n" };
    },
  });

  bb.log.info("loaded scoped Context, Napkins, and Papercuts");
}

function createStore(db: Db, changed: () => void) {
  const listContext = (scope: ScopeRef) => db.prepare(`
    SELECT id, logical_key, kind, value, priority, updated_at, topic, source_thread_id, consent_ref
    FROM contexts WHERE scope_type = ? AND scope_id = ?
    ORDER BY priority DESC, updated_at DESC
  `).all(scope.type, scope.id).map((row) => mapContext(row as ContextRow));
  const listNapkins = (scope: ScopeRef) => db.prepare(`
    SELECT id, logical_key, category, priority, recurrence, hit_count, situation, action, updated_at, source_thread_id
    FROM napkins WHERE scope_type = ? AND scope_id = ?
    ORDER BY priority DESC, recurrence DESC, hit_count DESC, updated_at DESC
  `).all(scope.type, scope.id).map((row) => mapNapkin(row as NapkinRow));
  const listPapercuts = (scope: ScopeRef) => db.prepare(`
    SELECT id, fingerprint, summary, severity, prevention, acceptance_condition, lifecycle, recurrence, updated_at, source_thread_id
    FROM papercuts WHERE scope_type = ? AND scope_id = ?
    ORDER BY CASE severity WHEN 'blocker' THEN 3 WHEN 'major' THEN 2 ELSE 1 END DESC, updated_at DESC
  `).all(scope.type, scope.id).map((row) => mapPapercut(row as PapercutRow));

  return {
    listContext,
    listNapkins,
    listPapercuts,
    saveContext(input: {
      scope: ScopeRef; logicalKey: string; kind: "fact" | "preference";
      value: string; priority: number; topic: z.infer<typeof contextTopic>;
      sourceThreadId: string | null; consentRef: string | null;
    }) {
      const now = Date.now();
      const existing = db.prepare(`SELECT id FROM contexts WHERE scope_type = ? AND scope_id = ? AND logical_key = ?`)
        .get(input.scope.type, input.scope.id, input.logicalKey) as { id: string } | undefined;
      const id = existing?.id ?? randomUUID();
      db.prepare(`
        INSERT INTO contexts (id, scope_type, scope_id, logical_key, kind, value, priority, topic, source_thread_id, consent_ref, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_type, scope_id, logical_key) DO UPDATE SET
          kind = excluded.kind, value = excluded.value, priority = excluded.priority,
          topic = excluded.topic, source_thread_id = excluded.source_thread_id,
          consent_ref = excluded.consent_ref, updated_at = excluded.updated_at
      `).run(
        id, input.scope.type, input.scope.id, input.logicalKey, input.kind, input.value,
        input.priority, input.topic, input.sourceThreadId, input.consentRef, now, now,
      );
      changed();
      return mapContext(db.prepare(`
        SELECT id, logical_key, kind, value, priority, updated_at, topic, source_thread_id, consent_ref
        FROM contexts WHERE id = ?
      `).get(id) as ContextRow);
    },
    saveNapkin(input: {
      scope: ScopeRef; logicalKey: string; category: z.infer<typeof napkinCategory>;
      situation: string; action: string; priority: number; sourceThreadId: string | null;
    }) {
      const now = Date.now();
      const existing = db.prepare(`SELECT id FROM napkins WHERE scope_type = ? AND scope_id = ? AND logical_key = ?`)
        .get(input.scope.type, input.scope.id, input.logicalKey) as { id: string } | undefined;
      const id = existing?.id ?? randomUUID();
      db.prepare(`
        INSERT INTO napkins (id, scope_type, scope_id, logical_key, category, priority, recurrence, hit_count, situation, action, source_thread_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_type, scope_id, logical_key) DO UPDATE SET
          category = excluded.category, priority = excluded.priority,
          recurrence = napkins.recurrence + 1, situation = excluded.situation,
          action = excluded.action, source_thread_id = excluded.source_thread_id,
          updated_at = excluded.updated_at
      `).run(id, input.scope.type, input.scope.id, input.logicalKey, input.category, input.priority, input.situation, input.action, input.sourceThreadId, now, now);
      changed();
      return getNapkin(db, id);
    },
    savePapercut(input: {
      scope: ScopeRef; fingerprint: string; summary: string; severity: z.infer<typeof severity>;
      prevention: string; acceptanceCondition: string; sourceThreadId: string | null;
    }) {
      const now = Date.now();
      const existing = db.prepare(`
        SELECT id FROM papercuts
        WHERE scope_type = ? AND scope_id = ? AND fingerprint = ? AND lifecycle = 'open'
      `).get(input.scope.type, input.scope.id, input.fingerprint) as { id: string } | undefined;
      if (existing) {
        db.prepare(`
          UPDATE papercuts SET recurrence = recurrence + 1, summary = ?, severity = ?,
            prevention = ?, acceptance_condition = ?, source_thread_id = ?, updated_at = ? WHERE id = ?
        `).run(input.summary, input.severity, input.prevention, input.acceptanceCondition, input.sourceThreadId, now, existing.id);
        changed();
        return getPapercut(db, existing.id);
      }
      const id = randomUUID();
      db.prepare(`
        INSERT INTO papercuts
          (id, scope_type, scope_id, fingerprint, summary, severity, prevention, acceptance_condition, lifecycle, recurrence, source_thread_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?, ?)
      `).run(id, input.scope.type, input.scope.id, input.fingerprint, input.summary, input.severity, input.prevention, input.acceptanceCondition, input.sourceThreadId, now, now);
      changed();
      return getPapercut(db, id);
    },
    markHit(id: string) {
      const result = db.prepare(`UPDATE napkins SET hit_count = hit_count + 1, updated_at = ? WHERE id = ?`).run(Date.now(), id);
      if (result.changes === 0) throw new Error("Napkin not found");
      changed();
      return getNapkin(db, id);
    },
    updatePapercut(id: string, next: z.infer<typeof lifecycle>) {
      const result = db.prepare(`UPDATE papercuts SET lifecycle = ?, updated_at = ? WHERE id = ?`).run(next, Date.now(), id);
      if (result.changes === 0) throw new Error("Papercut not found");
      changed();
      return getPapercut(db, id);
    },
    remove(type: z.infer<typeof itemType>, id: string) {
      const table = type === "context" ? "contexts" : type === "napkin" ? "napkins" : "papercuts";
      const removed = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes > 0;
      if (removed) changed();
      return removed;
    },
    status() {
      const count = (table: string) => (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
      return { context: count("contexts"), napkins: count("napkins"), papercuts: count("papercuts") };
    },
  };
}

export function buildActiveView(db: Db, scopes: ScopeRef[], cap = 2000, perCategory = 3, designCopyReserve = 400): string {
  const placeholders = scopes.map(() => "(?, ?)").join(", ");
  const args = scopes.flatMap((scope) => [scope.type, scope.id]);
  const precedence = new Map(scopes.map((scope, index) => [`${scope.type}:${scope.id}`, index]));
  // Audit columns (source_thread_id, consent_ref) are intentionally never selected here:
  // provenance and consent metadata must never reach injected instructions.
  const contextRows = db.prepare(`
    SELECT scope_type, scope_id, id, logical_key, kind, value, priority, topic, updated_at
    FROM contexts WHERE (scope_type, scope_id) IN (${placeholders})
  `).all(...args) as Array<ContextRow & { scope_type: ScopeType; scope_id: string }>;
  const napkinRows = db.prepare(`
    SELECT scope_type, scope_id, id, logical_key, category, priority, recurrence, hit_count, situation, action, updated_at
    FROM napkins WHERE (scope_type, scope_id) IN (${placeholders})
  `).all(...args) as Array<NapkinRow & { scope_type: ScopeType; scope_id: string }>;
  const papercutRows = db.prepare(`
    SELECT severity FROM papercuts WHERE lifecycle = 'open' AND (scope_type, scope_id) IN (${placeholders})
  `).all(...args) as Array<{ severity: z.infer<typeof severity> }>;

  const chooseSpecific = <T extends { scope_type: ScopeType; scope_id: string; logical_key: string }>(rows: T[]) => {
    const selected = new Map<string, T>();
    for (const row of rows.sort((a, b) =>
      (precedence.get(`${a.scope_type}:${a.scope_id}`) ?? -1) - (precedence.get(`${b.scope_type}:${b.scope_id}`) ?? -1))) {
      selected.set(row.logical_key, row);
    }
    return [...selected.values()];
  };
  const allContexts = chooseSpecific(contextRows).sort((a, b) => b.priority - a.priority || b.updated_at - a.updated_at);
  const allNapkins = chooseSpecific(napkinRows);
  // Design/copy records render inside a fixed reserve carved from the cap; every
  // other topic (engineering, workflow) shares the remainder and renders exactly
  // as the pre-topic algorithm did. With no design/copy records the reserve is
  // not carved, so the output stays byte-identical to the pre-topic build.
  const contexts = allContexts.filter((row) => !DESIGN_COPY_TOPICS.has(row.topic));
  const designCopyContexts = allContexts.filter((row) => DESIGN_COPY_TOPICS.has(row.topic));
  const napkins = allNapkins.filter((row) => !DESIGN_COPY_CATEGORIES.has(row.category));
  const designCopyNapkins = allNapkins.filter((row) => DESIGN_COPY_CATEGORIES.has(row.category));
  const hasDesignCopy = designCopyContexts.length > 0 || designCopyNapkins.length > 0;
  const effectiveCap = hasDesignCopy ? Math.max(0, cap - designCopyReserve) : cap;
  const counts = { minor: 0, major: 0, blocker: 0 };
  for (const row of papercutRows) counts[row.severity] += 1;

  const sections = [
    "# Clasi active context",
    "Current user instructions and repository state remain authoritative.",
    `Open papercuts: ${counts.blocker} blocker, ${counts.major} major, ${counts.minor} minor.`,
    "Before completing non-trivial work, evaluate whether a generalized fact, preference, reusable lesson, or recurring fixable friction emerged. If yes, use the matching Clasi tool once; otherwise retain nothing.",
  ];
  const napkinSection = <T extends NapkinRow>(rows: T[], category: string, lines: string[]) => {
    const selected = rows
      .filter((row) => row.category === category)
      .sort((a, b) => b.priority - a.priority || b.recurrence - a.recurrence || b.hit_count - a.hit_count)
      .slice(0, perCategory);
    if (!selected.length) return;
    lines.push(`\n## Napkin: ${category}`);
    for (const row of selected) lines.push(`- [${row.id}] When ${row.situation}; do ${row.action}`);
  };
  const lines: string[] = [];
  if (contexts.length) {
    lines.push("\n## Context");
    for (const row of contexts) lines.push(`- [${row.scope_type}] ${row.logical_key}: ${row.value}`);
  }
  for (const category of napkinCategory.options) {
    if (DESIGN_COPY_CATEGORIES.has(category)) continue;
    napkinSection(napkins, category, lines);
  }
  let result = `${sections.join("\n")}\n`;
  for (const line of lines) {
    if (result.length + line.length + 1 > effectiveCap) break;
    result += `${line}\n`;
  }

  if (hasDesignCopy) {
    const designCopyLines: string[] = [];
    for (const topic of ["design", "copy"] as const) {
      const rows = designCopyContexts.filter((row) => row.topic === topic);
      if (!rows.length) continue;
      designCopyLines.push(`\n## ${topic === "design" ? "Design" : "Copy"} context`);
      for (const row of rows) designCopyLines.push(`- [${row.scope_type}] ${row.logical_key}: ${row.value}`);
    }
    napkinSection(designCopyNapkins, "Design", designCopyLines);
    napkinSection(designCopyNapkins, "Copy", designCopyLines);
    let remaining = designCopyReserve;
    for (const line of designCopyLines) {
      if (line.length + 1 > remaining) break;
      result += `${line}\n`;
      remaining -= line.length + 1;
    }
  }
  return result;
}

function rememberScope(db: Db, scope: ScopeRef, label: string, parentId: string | null) {
  db.prepare(`
    INSERT INTO scopes (scope_type, scope_id, label, parent_scope_id, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(scope_type, scope_id) DO UPDATE SET
      label = excluded.label, parent_scope_id = excluded.parent_scope_id, updated_at = excluded.updated_at
  `).run(scope.type, scope.id, label, parentId, Date.now());
}

function ensureScope(db: Db, scope: ScopeRef, label: string, parentId: string | null) {
  db.prepare(`
    INSERT OR IGNORE INTO scopes (scope_type, scope_id, label, parent_scope_id, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(scope.type, scope.id, label, parentId, Date.now());
}

function listScopes(db: Db, projectId: string | null) {
  const rows = db.prepare(`
    SELECT scope_type, scope_id, label, parent_scope_id FROM scopes
    WHERE ? IS NULL OR scope_type = 'global' OR scope_id = ? OR parent_scope_id = ?
    ORDER BY CASE scope_type WHEN 'global' THEN 0 WHEN 'project' THEN 1 ELSE 2 END, label
  `).all(projectId, projectId, projectId) as ScopeRow[];
  return rows.map((row) => ({
    type: row.scope_type, id: row.scope_id, label: row.label, parentId: row.parent_scope_id,
  }));
}

function mapContext(row: ContextRow) {
  return {
    id: row.id, logicalKey: row.logical_key, kind: row.kind, value: row.value,
    priority: row.priority, updatedAt: row.updated_at, topic: row.topic,
    sourceThreadId: row.source_thread_id, consentRef: row.consent_ref,
    unconsented: DESIGN_COPY_TOPICS.has(row.topic) && !row.consent_ref,
  };
}
function mapNapkin(row: NapkinRow) {
  return {
    id: row.id, logicalKey: row.logical_key, category: row.category, priority: row.priority,
    recurrence: row.recurrence, hitCount: row.hit_count, situation: row.situation,
    action: row.action, updatedAt: row.updated_at, sourceThreadId: row.source_thread_id,
  };
}
function mapPapercut(row: PapercutRow) {
  return {
    id: row.id, fingerprint: row.fingerprint, summary: row.summary, severity: row.severity,
    prevention: row.prevention, acceptanceCondition: row.acceptance_condition,
    lifecycle: row.lifecycle, recurrence: row.recurrence, updatedAt: row.updated_at,
    sourceThreadId: row.source_thread_id,
  };
}

function getNapkin(db: Db, id: string) {
  const row = db.prepare(`
    SELECT id, logical_key, category, priority, recurrence, hit_count, situation, action, updated_at, source_thread_id
    FROM napkins WHERE id = ?
  `).get(id) as NapkinRow | undefined;
  if (!row) throw new Error("Napkin not found");
  return mapNapkin(row);
}
function getPapercut(db: Db, id: string) {
  const row = db.prepare(`
    SELECT id, fingerprint, summary, severity, prevention, acceptance_condition, lifecycle, recurrence, updated_at, source_thread_id
    FROM papercuts WHERE id = ?
  `).get(id) as PapercutRow | undefined;
  if (!row) throw new Error("Papercut not found");
  return mapPapercut(row);
}

async function cliScope(
  token: string,
  projectId: string | undefined,
  threadId: string | undefined,
  bb: BbPluginApi,
): Promise<ScopeRef> {
  if (token === "global") return { type: "global", id: "global" };
  if (token === "project" && projectId) {
    return projectScopeRef(await bb.sdk.projects.get({ projectId }));
  }
  if (token === "environment" && threadId) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.environmentId) return { type: "environment", id: thread.environmentId };
  }
  const match = /^(project|environment):(.+)$/.exec(token);
  if (match?.[1] === "project") {
    return projectScopeRef(await bb.sdk.projects.get({ projectId: match[2]! }));
  }
  if (match) return { type: "environment", id: match[2]! };
  throw new Error("Use global, project:<id>, or environment:<id>");
}

function projectScopeRef(project: { id: string; gitRemoteUrl: string | null }): ScopeRef {
  if (!project.gitRemoteUrl) return { type: "project", id: project.id };
  const canonical = canonicalGitRemote(project.gitRemoteUrl);
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  return { type: "project", id: `repo_${digest}` };
}

function canonicalGitRemote(remote: string): string {
  const trimmed = remote.trim().replace(/\.git\/?$/i, "");
  const scp = trimmed.includes("://") ? null : /^([^@]+@)?([^:]+):(.+)$/.exec(trimmed);
  const normalized = scp ? `ssh://${scp[1] ?? ""}${scp[2]}/${scp[3]}` : trimmed;
  try {
    const url = new URL(normalized);
    const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}/${path}`;
  } catch {
    return normalized;
  }
}

function isSafeText(value: string) {
  if (/\r|\n/.test(value)) return false;
  if (/(?:^|\s)(?:\/[^\s]+|[A-Za-z]:\\[^\s]+)/.test(value)) return false;
  return !/(?:BEGIN [A-Z ]*PRIVATE KEY|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|(?:password|token|secret)\s*[:=]\s*\S+)/i.test(value);
}

const PRIVACY_INSTRUCTIONS = "Store only generalized derived guidance. Never send raw prompts, messages, terminal output, source excerpts, paths, secrets, PII, or customer data.";

const SCHEMA = `
  CREATE TABLE scopes (
    scope_type TEXT NOT NULL CHECK(scope_type IN ('global', 'project', 'environment')),
    scope_id TEXT NOT NULL,
    label TEXT NOT NULL,
    parent_scope_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(scope_type, scope_id)
  );
  CREATE TABLE contexts (
    id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL,
    logical_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('fact', 'preference')),
    value TEXT NOT NULL, priority INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(scope_type, scope_id, logical_key)
  );
  CREATE TABLE napkins (
    id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL,
    logical_key TEXT NOT NULL, category TEXT NOT NULL, priority INTEGER NOT NULL,
    recurrence INTEGER NOT NULL, hit_count INTEGER NOT NULL, situation TEXT NOT NULL,
    action TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(scope_type, scope_id, logical_key)
  );
  CREATE TABLE papercuts (
    id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, summary TEXT NOT NULL,

    severity TEXT NOT NULL CHECK(severity IN ('minor', 'major', 'blocker')),
    prevention TEXT NOT NULL, acceptance_condition TEXT NOT NULL,
    lifecycle TEXT NOT NULL CHECK(lifecycle IN ('open', 'resolved', 'dismissed')),
    recurrence INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX papercuts_scope ON papercuts(scope_type, scope_id, lifecycle);
`;
// Historical slot: BB verifies migration SQL hashes. No importer uses this table.
const RETIRED_IMPORT_SCHEMA = `
  CREATE TABLE legacy_napkin_imports (
    project_scope_id TEXT PRIMARY KEY,
    source_hash TEXT NOT NULL,
    imported_count INTEGER NOT NULL,
    skipped_count INTEGER NOT NULL,
    imported_at INTEGER NOT NULL
  );
`;
// Append-only migration: topic dimension on contexts plus audit-only provenance
// columns. Existing context rows read back as topic 'engineering'.
const TOPIC_PROVENANCE_SCHEMA = `
  ALTER TABLE contexts ADD COLUMN topic TEXT NOT NULL DEFAULT 'engineering';
  ALTER TABLE contexts ADD COLUMN source_thread_id TEXT;
  ALTER TABLE contexts ADD COLUMN consent_ref TEXT;
  ALTER TABLE napkins ADD COLUMN source_thread_id TEXT;
  ALTER TABLE papercuts ADD COLUMN source_thread_id TEXT;
`;
