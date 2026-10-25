import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { CLASI_RULES_FIXTURES, CLASI_SCOPE_FIXTURES } from "./lib/retention-fixtures.ts";
import plugin from "./server.ts";

const configuration = makePluginAgentConfigurationContext({
  thread: { id: "thread-1", title: null, parentThreadId: null, sourceThreadId: null },
  project: { id: "project-1", kind: "standard" as const, name: "Project One", gitRemoteUrl: null },
  environment: {
    id: "environment-1", name: "main", path: null,
    workspaceProvisionType: "managed-worktree" as const, branchName: "main",
  },
  host: { id: "host-1", name: "Local" },
  provider: { id: "codex", model: "test", capabilities: { supportsNativeUserQuestion: false } },
  origin: { kind: null, pluginId: null },
});

test("project Context shadows the same global key in injected instructions", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "clasi", agentSkillIds: ["clasi"] });
  await plugin(bb);
  await harness.behavior.callRpc("saveContext", {
    scope: { type: "global", id: "global" },
    logicalKey: "package-manager", kind: "preference", value: "Use npm.", priority: 50,
  });
  await harness.behavior.callRpc("saveContext", {
    scope: { type: "project", id: "project-1" },
    logicalKey: "package-manager", kind: "preference", value: "Use pnpm.", priority: 50,
  });

  const resolved = await harness.behavior.resolveAgentConfiguration(configuration);
  assert.match(resolved.instructions!, /package-manager: Use pnpm\./);
  assert.doesNotMatch(resolved.instructions!, /Use npm\./);
  assert.deepEqual(resolved.skills, ["clasi"]);
  assert.equal(resolved.tools.length, 5);
  assert.match(resolved.instructions!, /Before completing non-trivial work/);
});

test("repeated papercuts reinforce one open record", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "clasi", agentSkillIds: ["clasi"] });
  await plugin(bb);
  const input = {
    scope: { type: "global", id: "global" }, fingerprint: "docs.missing-example",
    summary: "The setup guide lacks a complete example.", severity: "minor",
    prevention: "Add one verified setup example.",
    acceptanceCondition: "The documented example passes from a clean install.",
  };

  const first = await harness.behavior.callRpc("savePapercut", input) as { id: string; recurrence: number };
  const second = await harness.behavior.callRpc("savePapercut", input) as { id: string; recurrence: number };
  assert.equal(second.id, first.id);
  assert.equal(second.recurrence, 2);

  const listed = await harness.behavior.callRpc("dashboard", {
    projectId: null, threadId: null, scope: { type: "global", id: "global" },
  }) as { papercuts: unknown[] };
  assert.equal(listed.papercuts.length, 1);

  const resolved = await harness.behavior.resolveAgentConfiguration(configuration);
  assert.match(resolved.instructions!, /Open papercuts: 0 blocker, 0 major, 1 minor/);
  assert.doesNotMatch(resolved.instructions!, /setup guide lacks/);
});

test("dashboard derives repository and current worktree from the thread", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "clasi",
    sdk: {
      threads: {
        get: async () => makeThreadResponse({
          id: "thread-1",
          projectId: "project-1",
          environmentId: "environment-1",
        }),
      },
      projects: {
        get: async () => ({
          id: "project-1", kind: "standard" as const, name: "Project One",
          gitRemoteUrl: null, createdAt: 1, updatedAt: 1, sources: [],
        }),
      },
    },
  });
  await plugin(bb);

  const dashboard = await harness.behavior.callRpc("dashboard", {
    projectId: null,
    threadId: "thread-1",
    scope: null,
  }) as {
    selectedScope: { type: string; id: string };
    currentEnvironmentId: string | null;
    scopes: Array<{ type: string; id: string }>;
  };

  assert.deepEqual(dashboard.selectedScope, {
    type: "project", id: "project-1", label: "Project One", parentId: null,
  });
  assert.equal(dashboard.currentEnvironmentId, "environment-1");
  assert.ok(dashboard.scopes.some((scope) => scope.type === "environment" && scope.id === "environment-1"));
});

test("overview dashboard lists records across known scopes", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "clasi",
    sdk: {
      projects: {
        get: async ({ projectId }) => ({
          id: projectId, kind: "standard" as const, name: projectId,
          gitRemoteUrl: null, createdAt: 1, updatedAt: 1, sources: [],
        }),
      },
    },
  });
  await plugin(bb);

  for (const projectId of ["project-1", "project-2", "project-3"]) {
    await harness.behavior.callRpc("dashboard", { projectId, threadId: null, scope: null });
  }
  await harness.behavior.callRpc("saveNapkin", {
    scope: { type: "project", id: "project-2" },
    logicalKey: "shared-review", category: "Validation",
    situation: "a system-wide panel opens", action: "show records from every known scope",
    priority: 80,
  });
  const dashboard = await harness.behavior.callRpc("dashboard", {
    projectId: null, threadId: null, scope: null,
  }) as {
    selectedScope: null;
    scopes: Array<{ type: string; id: string }>;
    napkins: Array<{ logicalKey: string; scope: { type: string; id: string } }>;
  };

  assert.equal(dashboard.selectedScope, null);
  assert.deepEqual(dashboard.scopes.map(({ type, id }) => ({ type, id })), [
    { type: "global", id: "global" },
    { type: "project", id: "project-1" },
    { type: "project", id: "project-2" },
    { type: "project", id: "project-3" },
  ]);
  assert.equal(dashboard.napkins.length, 1);
  assert.deepEqual({
    logicalKey: dashboard.napkins[0]?.logicalKey,
    scope: dashboard.napkins[0]?.scope,
  }, {
    logicalKey: "shared-review",
    scope: { type: "project", id: "project-2", label: "project-2", parentId: null },
  });
});

test("repository Napkins follow the Git remote across worktrees and every session", async () => {
  const project = (id: string) => ({
    id, kind: "standard" as const, name: id,
    gitRemoteUrl: "https://github.com/acme/example.git",
    createdAt: 1, updatedAt: 1, sources: [],
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "clasi",
    agentSkillIds: ["clasi"],
    sdk: { projects: { get: async ({ projectId }) => project(projectId) } },
  });
  await plugin(bb);

  await harness.behavior.callAgentTool("clasi_remember_napkin", {
    scope: "project",
    logicalKey: "verify-before-finish",
    category: "Validation",
    situation: "work is ready to hand off",
    action: "run the smallest relevant check",
    priority: 80,
  }, { projectId: "project-a" });

  const otherWorktree = {
    ...configuration,
    project: {
      ...configuration.project,
      id: "project-b",
      gitRemoteUrl: "git@github.com:acme/example.git",
    },
  };
  const first = await harness.behavior.resolveAgentConfiguration(otherWorktree);
  const second = await harness.behavior.resolveAgentConfiguration({
    ...otherWorktree,
    thread: { ...otherWorktree.thread, id: "thread-2" },
    environment: { ...otherWorktree.environment, id: "environment-2" },
  });
  for (const session of [first, second]) {
    assert.match(session.instructions!, /Napkin: Validation/);
    assert.match(session.instructions!, /run the smallest relevant check/);
    assert.deepEqual(session.skills, ["clasi"]);
  }
});


function overCapValue(index: number) {
  return `Entry ${String(index).padStart(2, "0")} guidance ${"alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa ".repeat(1)}`.trim();
}

test("engineering guidance includes scoped context and usable Napkin IDs", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "clasi", agentSkillIds: ["clasi"] });
  await plugin(bb);
  await harness.behavior.callRpc("saveContext", {
    scope: { type: "global", id: "global" },
    logicalKey: "release-cadence", kind: "fact", value: "Ship weekly.", priority: 70,
  });
  await harness.behavior.callRpc("saveContext", {
    scope: { type: "project", id: "project-1" },
    logicalKey: "package-manager", kind: "preference", value: "Use pnpm.", priority: 50,
  });
  const execution = await harness.behavior.callRpc("saveNapkin", {
    scope: { type: "project", id: "project-1" },
    logicalKey: "plan-first", category: "Execution",
    situation: "a task spans multiple files", action: "outline the change first", priority: 60,
  }) as { id: string };
  const validation = await harness.behavior.callRpc("saveNapkin", {
    scope: { type: "global", id: "global" },
    logicalKey: "verify-before-finish", category: "Validation",
    situation: "work is ready to hand off", action: "run the smallest relevant check", priority: 80,
  }) as { id: string };
  await harness.behavior.callRpc("savePapercut", {
    scope: { type: "global", id: "global" }, fingerprint: "docs.missing-example",
    summary: "The setup guide lacks a complete example.", severity: "minor",
    prevention: "Add one verified setup example.",
    acceptanceCondition: "The documented example passes from a clean install.",
  });

  const resolved = await harness.behavior.resolveAgentConfiguration(configuration);
  assert.match(resolved.instructions!, /release-cadence: Ship weekly\./);
  assert.match(resolved.instructions!, /package-manager: Use pnpm\./);
  assert.ok(resolved.instructions!.includes(execution.id));
  assert.ok(resolved.instructions!.includes(validation.id));
  assert.doesNotMatch(resolved.instructions!, /The setup guide lacks/);
});

test("engineering context honors its character cap in priority order", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "clasi", agentSkillIds: ["clasi"] });
  await plugin(bb);
  for (let index = 1; index <= 14; index += 1) {
    await harness.behavior.callRpc("saveContext", {
      scope: { type: "global", id: "global" },
      logicalKey: `note-${String(index).padStart(2, "0")}`, kind: "fact",
      value: overCapValue(index), priority: 100 - index,
    });
  }

  const resolved = await harness.behavior.resolveAgentConfiguration(configuration);
  const instructions = resolved.instructions!;
  assert.ok(instructions.length <= 2000);
  assert.match(instructions, /note-12/);
  assert.doesNotMatch(instructions, /note-13/);
});

test("unsafe retained text is rejected at the RPC boundary", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "clasi", agentSkillIds: ["clasi"] });
  await plugin(bb);
  await assert.rejects(() => harness.behavior.callRpc("saveContext", {
    scope: { type: "global", id: "global" },
    logicalKey: "credential", kind: "fact", value: "token=synthetic-test-value", priority: 50,
  }));
});

test("saveContext without topic defaults to engineering with no audit metadata", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "clasi", agentSkillIds: ["clasi"] });
  await plugin(bb);
  await harness.behavior.callRpc("saveContext", {
    scope: { type: "global", id: "global" },
    logicalKey: "package-manager", kind: "preference", value: "Use npm.", priority: 50,
  });

  const dashboard = await harness.behavior.callRpc("dashboard", {
    projectId: null, threadId: null, scope: { type: "global", id: "global" },
  }) as { context: Array<{ logicalKey: string; topic: string; sourceThreadId: string | null; consentRef: string | null; unconsented: boolean }> };
  assert.equal(dashboard.context.length, 1);
  assert.deepEqual({
    logicalKey: dashboard.context[0]?.logicalKey,
    topic: dashboard.context[0]?.topic,
    sourceThreadId: dashboard.context[0]?.sourceThreadId,
    consentRef: dashboard.context[0]?.consentRef,
    unconsented: dashboard.context[0]?.unconsented,
  }, {
    logicalKey: "package-manager",
    topic: "engineering",
    sourceThreadId: null,
    consentRef: null,
    unconsented: false,
  });
});

test("saveContext persists topic, provenance, and consent reference without injecting them", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "clasi", agentSkillIds: ["clasi"] });
  await plugin(bb);
  const record = await harness.behavior.callRpc("saveContext", {
    scope: { type: "project", id: "project-1" },
    logicalKey: "brand-voice", kind: "preference", value: "Prefer plain declarative sentences.",
    priority: 60, topic: "copy", provenance: "thread-consent-9", consentRef: "pinpoint:pin-42",
  }) as { topic: string; sourceThreadId: string | null; consentRef: string | null; unconsented: boolean };
  assert.deepEqual({
    topic: record.topic,
    sourceThreadId: record.sourceThreadId,
    consentRef: record.consentRef,
    unconsented: record.unconsented,
  }, {
    topic: "copy",
    sourceThreadId: "thread-consent-9",
    consentRef: "pinpoint:pin-42",
    unconsented: false,
  });

  const resolved = await harness.behavior.resolveAgentConfiguration(configuration);
  assert.match(resolved.instructions!, /brand-voice: Prefer plain declarative sentences\./);
  assert.doesNotMatch(resolved.instructions!, /thread-consent-9/);
  assert.doesNotMatch(resolved.instructions!, /pinpoint:pin-42/);
});

test("clasi_remember_context with topic design records the source thread and gets flagged", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "clasi", agentSkillIds: ["clasi"] });
  await plugin(bb);
  await harness.behavior.callAgentTool("clasi_remember_context", {
    scope: "global", logicalKey: "spacing-scale", kind: "preference",
    value: "Use a four pixel spacing scale.", priority: 55, topic: "design",
  }, { threadId: "thread-design-1" });

  const dashboard = await harness.behavior.callRpc("dashboard", {
    projectId: null, threadId: null, scope: { type: "global", id: "global" },
  }) as { context: Array<{ topic: string; sourceThreadId: string | null; consentRef: string | null; unconsented: boolean }> };
  assert.deepEqual({
    topic: dashboard.context[0]?.topic,
    sourceThreadId: dashboard.context[0]?.sourceThreadId,
    consentRef: dashboard.context[0]?.consentRef,
    unconsented: dashboard.context[0]?.unconsented,
  }, {
    topic: "design",
    sourceThreadId: "thread-design-1",
    consentRef: null,
    unconsented: true,
  });
});

test("write tools record the calling thread as provenance", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "clasi", agentSkillIds: ["clasi"] });
  await plugin(bb);
  await harness.behavior.callAgentTool("clasi_remember_napkin", {
    scope: "global", logicalKey: "verify-before-finish", category: "Validation",
    situation: "work is ready to hand off", action: "run the smallest relevant check", priority: 80,
  }, { threadId: "thread-prov-1" });
  await harness.behavior.callAgentTool("clasi_capture_papercut", {
    scope: "global", fingerprint: "docs.missing-example",
    summary: "The setup guide lacks a complete example.", severity: "minor",
    prevention: "Add one verified setup example.",
    acceptanceCondition: "The documented example passes from a clean install.",
  }, { threadId: "thread-prov-2" });

  const dashboard = await harness.behavior.callRpc("dashboard", {
    projectId: null, threadId: null, scope: { type: "global", id: "global" },
  }) as {
    napkins: Array<{ sourceThreadId: string | null }>;
    papercuts: Array<{ sourceThreadId: string | null }>;
  };
  assert.equal(dashboard.napkins[0]?.sourceThreadId, "thread-prov-1");
  assert.equal(dashboard.papercuts[0]?.sourceThreadId, "thread-prov-2");
});

test("a design flood cannot push engineering context below cap minus the reserve", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "clasi", agentSkillIds: ["clasi"] });
  await plugin(bb);
  for (let index = 1; index <= 6; index += 1) {
    await harness.behavior.callRpc("saveContext", {
      scope: { type: "global", id: "global" },
      logicalKey: `eng-${index}`, kind: "fact",
      value: `Engineering guidance ${index} ${"alpha bravo charlie delta echo foxtrot golf hotel india juliet".repeat(1)}`,
      priority: 90 - index,
    });
  }
  for (let index = 1; index <= 20; index += 1) {
    await harness.behavior.callRpc("saveContext", {
      scope: { type: "global", id: "global" },
      logicalKey: `design-${index}`, kind: "preference",
      value: `Design guidance ${index} ${"kilo lima mike november oscar papa quebec romeo sierra tango".repeat(1)}`,
      priority: 100 - index, topic: "design", provenance: "thread-flood", consentRef: `pin-${index}`,
    });
  }

  const resolved = await harness.behavior.resolveAgentConfiguration(configuration);
  const instructions = resolved.instructions!;
  for (let index = 1; index <= 6; index += 1) {
    assert.match(instructions, new RegExp(`eng-${index}:`));
  }
  assert.match(instructions, /## Design context/);
  assert.match(instructions, /design-1:/);
  assert.ok(instructions.length <= 2000);
  assert.doesNotMatch(instructions, /thread-flood/);
  assert.doesNotMatch(instructions, /pin-\d/);
});

test("napkin category Design is accepted end-to-end and rendered inside the reserve", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "clasi", agentSkillIds: ["clasi"] });
  await plugin(bb);
  await harness.behavior.callAgentTool("clasi_remember_napkin", {
    scope: "global", logicalKey: "contrast-check", category: "Design",
    situation: "a new surface introduces text on color", action: "verify contrast before shipping",
    priority: 70,
  }, { threadId: "thread-design-2" });
  const record = await harness.behavior.callRpc("saveNapkin", {
    scope: { type: "global", id: "global" },
    logicalKey: "microcopy-tone", category: "Copy",
    situation: "an error message is added", action: "state the fix, not the failure",
    priority: 60,
  }) as { category: string };
  assert.equal(record.category, "Copy");

  const resolved = await harness.behavior.resolveAgentConfiguration(configuration);
  assert.match(resolved.instructions!, /## Napkin: Design/);
  assert.match(resolved.instructions!, /verify contrast before shipping/);
  assert.match(resolved.instructions!, /## Napkin: Copy/);
  assert.match(resolved.instructions!, /state the fix, not the failure/);
});

// ---------------------------------------------------------------------------
// U8 — Pinpoint consent loop, clasi side.
// ---------------------------------------------------------------------------

test("AE6: a Pinpoint-consented design write lands unflagged and appears in the design reserve", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "clasi",
    agentSkillIds: ["clasi"],
    sdk: {
      projects: {
        get: async () => ({
          id: "project-1", kind: "standard" as const, name: "Project One",
          gitRemoteUrl: null, createdAt: 1, updatedAt: 1, sources: [],
        }),
      },
    },
  });
  await plugin(bb);

  // The exact payload pinpoint's learning write sends after an approve with
  // the explicit opt-in (see pinpoint/lib/learning-write.ts).
  await harness.behavior.callRpc("saveContext", {
    scope: { type: "project", id: "project-1" },
    logicalKey: "button-consistency",
    kind: "preference",
    value: "Use one shared button component per variant.",
    priority: 50,
    topic: "design",
    provenance: "thread-consenting-1",
    consentRef: "pinpoint:pp_learn1",
  });

  // Unflagged in the dashboard: the consent reference clears "unconsented".
  const dashboard = await harness.behavior.callRpc("dashboard", {
    projectId: "project-1", threadId: null, scope: { type: "project", id: "project-1" },
  }) as { context: Array<{ logicalKey: string; consentRef: string | null; unconsented: boolean }> };
  assert.equal(dashboard.context.length, 1);
  assert.deepEqual({
    logicalKey: dashboard.context[0]?.logicalKey,
    consentRef: dashboard.context[0]?.consentRef,
    unconsented: dashboard.context[0]?.unconsented,
  }, {
    logicalKey: "button-consistency",
    consentRef: "pinpoint:pp_learn1",
    unconsented: false,
  });

  // Subsequent injected instructions carry the learning inside the design
  // reserve — with no audit metadata leaking into the instructions.
  const resolved = await harness.behavior.resolveAgentConfiguration(configuration);
  assert.match(resolved.instructions!, /## Design context/);
  assert.match(
    resolved.instructions!,
    /button-consistency: Use one shared button component per variant\./,
  );
  assert.doesNotMatch(resolved.instructions!, /pinpoint:pp_learn1/);
  assert.doesNotMatch(resolved.instructions!, /thread-consenting-1/);
});

test("strict retention schema accepts and rejects synthetic boundary cases", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "clasi" });
  await plugin(bb);
  const save = (logicalKey: string, value: string) =>
    harness.behavior.callRpc("saveContext", {
      scope: { type: "global", id: "global" },
      logicalKey, kind: "preference", value, priority: 50, topic: "design",
    });

  for (const key of CLASI_RULES_FIXTURES.safeKey.accept) {
    await save(key, "A safe generalized preference.");
  }
  for (const key of CLASI_RULES_FIXTURES.safeKey.reject) {
    await assert.rejects(() => save(key, "A safe generalized preference."), `safeKey should reject: ${JSON.stringify(key)}`);
  }
  for (const value of CLASI_RULES_FIXTURES.safeText.accept) {
    await save("parity-text", value);
  }
  for (const value of CLASI_RULES_FIXTURES.safeText.reject) {
    await assert.rejects(() => save("parity-text", value), `safeText should reject: ${JSON.stringify(value)}`);
  }
});

test("project scopes canonicalize SSH and HTTPS remotes without a sibling package", async () => {
  const remoteByProject = new Map(
    CLASI_SCOPE_FIXTURES.scopeRemotes.map((fixture, index) => [`fixture-${index}`, fixture]),
  );
  const { bb, harness } = createFakePluginHost({
    pluginId: "clasi",
    sdk: {
      projects: {
        get: async ({ projectId }) => ({
          id: projectId, kind: "standard" as const, name: projectId,
          gitRemoteUrl: remoteByProject.get(projectId)?.remote ?? null,
          createdAt: 1, updatedAt: 1, sources: [],
        }),
      },
    },
  });
  await plugin(bb);

  for (const [projectId, fixture] of remoteByProject) {
    // Expected canonical forms are independent of the runtime implementation.
    const expected = `repo_${createHash("sha256").update(fixture.canonical).digest("hex").slice(0, 32)}`;
    const dashboard = await harness.behavior.callRpc("dashboard", {
      projectId, threadId: null, scope: null,
    }) as { selectedScope: { type: string; id: string } | null };
    assert.deepEqual(
      { type: dashboard.selectedScope?.type, id: dashboard.selectedScope?.id },
      { type: "project", id: expected },
      `remote ${fixture.remote}`,
    );
  }
});

test("reload preserves retained records, audit metadata, and papercut lifecycle", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "clasi", agentSkillIds: ["clasi"] });
  await plugin(bb);
  const scope = { type: "global", id: "global" };
  await harness.behavior.callRpc("saveContext", {
    scope, logicalKey: "plain-copy", kind: "preference", value: "Use plain labels.",
    priority: 60, topic: "copy", provenance: "thread-example", consentRef: "review:example",
  });
  const napkin = await harness.behavior.callRpc("saveNapkin", {
    scope, logicalKey: "check-boundaries", category: "Validation",
    situation: "a value crosses a boundary", action: "validate the value", priority: 50,
  }) as { id: string };
  await harness.behavior.callRpc("markHit", { id: napkin.id });
  const papercut = await harness.behavior.callRpc("savePapercut", {
    scope, fingerprint: "guide.example", summary: "An example is missing.", severity: "minor",
    prevention: "Add a verified example.", acceptanceCondition: "The example runs.",
  }) as { id: string };
  await harness.behavior.callRpc("updatePapercut", { id: papercut.id, lifecycle: "resolved" });
  const input = { projectId: null, threadId: null, scope };
  const before = await harness.behavior.callRpc("dashboard", input);
  const reloaded = await harness.lifecycle.reload(plugin);
  try {
    assert.deepEqual(await reloaded.harness.behavior.callRpc("dashboard", input), before);
    const active = await reloaded.harness.behavior.resolveAgentConfiguration(configuration);
    assert.match(active.instructions!, /plain-copy: Use plain labels\./);
    assert.doesNotMatch(active.instructions!, /review:example|thread-example|An example is missing/);
  } finally {
    await reloaded.harness.lifecycle.dispose();
  }
});

test("thread activation never reads repository files and retained Napkins survive reload", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "clasi",
    sdk: {
      projects: {
        get: async () => ({
          id: "project-1", kind: "standard" as const, name: "Example",
          gitRemoteUrl: null, createdAt: 1, updatedAt: 1, sources: [],
        }),
      },
      environments: {
        get: async () => ({
          id: "environment-1", name: "main", projectId: "project-1",
          hostId: "host-1", path: "/workspace/example", managed: false,
          isGitRepo: true, isWorktree: false, workspaceProvisionType: "unmanaged" as const,
          branchName: "main", baseBranch: null, defaultBranch: "main", mergeBaseBranch: "main",
          status: "ready" as const, createdAt: 1, updatedAt: 1,
        }),
      },
      files: { read: async () => { throw new Error("Repository files must not be read"); } },
    },
  });
  await plugin(bb);
  const scope = { type: "project", id: "project-1" };
  await harness.behavior.callRpc("saveNapkin", {
    scope, logicalKey: "legacy-example", category: "Validation",
    situation: "a change is ready", action: "verify its behavior", priority: 70,
  });
  const input = { projectId: null, threadId: null, scope };
  const before = await harness.behavior.callRpc("dashboard", input);
  await harness.behavior.emitThreadEvent("thread.active", {
    thread: makeThreadResponse({ id: "thread-1", projectId: "project-1", environmentId: "environment-1" }),
  });
  assert.equal(harness.inspection.sdk.callsTo("files.read").length, 0);
  assert.deepEqual(await harness.behavior.callRpc("dashboard", input), before);
  const reloaded = await harness.lifecycle.reload(plugin);
  try {
    assert.deepEqual(await reloaded.harness.behavior.callRpc("dashboard", input), before);
  } finally {
    await reloaded.harness.lifecycle.dispose();
  }
});
