import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { formatRunAge, needsAttention } from "./task-layout";

describe("task run state", () => {
  it("detects when a task needs attention and formats age", () => {
    expect(needsAttention({ status: "doing", run: { phase: "building", summary: null, proofPageId: null, updatedAt: "2026-11-23T00:00:00Z" } })).toBe(false);
    expect(needsAttention({ status: "doing", run: { phase: "waiting", summary: "2 scope questions waiting.", proofPageId: null, updatedAt: "2026-11-23T00:00:00Z" } })).toBe(true);
    expect(needsAttention({ status: "blocked", run: { phase: "blocked", summary: "Needs Mac.", proofPageId: null, updatedAt: "2026-11-23T00:00:00Z" } })).toBe(true);
    expect(needsAttention({ status: "review", run: { phase: null, summary: null, proofPageId: "6f807a6d-7754-4a44-8305-2051bb02c713", updatedAt: "2026-11-23T00:00:00Z" } })).toBe(true);
    expect(needsAttention({ status: "doing", run: { phase: "live", summary: "Ready to close.", proofPageId: null, proposedStatus: "done", updatedAt: "2026-11-23T00:00:00Z" } })).toBe(true);
    const now = Date.parse("2026-11-23T12:00:00Z");
    expect(formatRunAge("2026-11-23T11:59:40Z", now)).toBe("just now");
    expect(formatRunAge("2026-11-23T11:45:00Z", now)).toBe("15m");
    expect(formatRunAge("2026-11-23T09:00:00Z", now)).toBe("3h");
  });

  it("updates and clears task run metadata through bb worktasks run and exposes it on boardTasks", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "task-workspaces",
      experimental_declaredIconNames: ["tasks"],
      settings: { agentWrites: "workflow", allowWrites: false },
      sdk: {
        projects: { list: async () => [{ id: "proj-1", name: "Site", kind: "standard", gitRemoteUrl: null, sources: [], createdAt: 0, updatedAt: 0 }] },
      },
    });
    await plugin(bb);
    const db = bb.storage.database();
    db.prepare("INSERT INTO tasks (id,title,status,project_id,created_at,updated_at) VALUES ('t1','Uniform audio bars','doing','proj-1','2026-11-23','2026-11-23')").run();
    db.prepare("INSERT INTO task_refs VALUES ('t1','akiflow','ext-1','Uniform audio bars',NULL,'{}','2026-11-23')").run();
    db.prepare("INSERT INTO akiflow_identifiers (number,external_id) VALUES (7,'ext-1')").run();

    const updated = await harness.behavior.runCli([
      "run", "AKI-7", "--phase", "waiting", "--summary", "Proof ready — independent check passed.", "--proof", "6f807a6d-7754-4a44-8305-2051bb02c713", "--propose-status", "done",
    ]);
    expect(updated.exitCode).toBe(0);
    expect(JSON.parse(updated.stdout).run).toMatchObject({
      phase: "waiting",
      summary: "Proof ready — independent check passed.",
      proofPageId: "6f807a6d-7754-4a44-8305-2051bb02c713",
      proposedStatus: "done",
    });

    const board = await harness.behavior.callRpc("boardTasks", null) as { tasks: Array<{ id: string; run?: { phase: string; proposedStatus?: string | null } }> };
    expect(board.tasks.find((t) => t.id === "t1")?.run).toMatchObject({ phase: "waiting", proposedStatus: "done" });

    // Rejecting keeps the task open and clears the proposal.
    const rejected = await harness.behavior.callRpc("resolveRunProposal", { taskId: "t1", accept: false }) as { status: string; run?: { proposedStatus?: string | null } };
    expect(rejected.status).toBe("doing");
    expect(rejected.run?.proposedStatus).toBeNull();

    // Re-proposing and accepting moves the task to done and clears run state.
    await harness.behavior.runCli(["run", "AKI-7", "--propose-status", "done"]);
    const accepted = await harness.behavior.callRpc("resolveRunProposal", { taskId: "t1", accept: true }) as { status: string; run?: unknown };
    expect(accepted.status).toBe("done");
    expect(accepted.run).toBeUndefined();

    const cleared = await harness.behavior.runCli(["run", "AKI-7", "--clear"]);
    expect(cleared.exitCode).toBe(0);
    expect(JSON.parse(cleared.stdout).run).toBeUndefined();
    await harness.lifecycle.dispose();
  });

  it("reads live sandbox providers on demand, defaults to Boat (sandbox-box), and persists override", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "task-workspaces",
      experimental_declaredIconNames: ["tasks"],
      sdk: {
        plugins: {
          callRpc: async ({ pluginId, method }: { pluginId: string; method: string }) => {
            if (pluginId === "sandboxes" && method === "providers") {
              return [
                { provider: "daytona", enabled: true, configured: true },
                { provider: "box", enabled: true, configured: true },
                { provider: "modal", enabled: false, configured: false },
              ];
            }
            throw new Error(`unexpected rpc ${pluginId}.${method}`);
          },
        },
      },
    });
    await plugin(bb);
    // Zero startup RPCs.
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);

    const initial = await harness.behavior.callRpc("sandboxPreferences", null) as {
      available: boolean;
      selectedProviderId: string | null;
      effectiveProviderId: string | null;
      effectiveLabel: string | null;
      providers: Array<{ id: string; ready: boolean }>;
    };
    expect(initial.available).toBe(true);
    expect(initial.selectedProviderId).toBeNull();
    expect(initial.effectiveProviderId).toBe("sandbox-box");
    expect(initial.effectiveLabel).toBe("Boat Sandbox");
    expect(initial.providers.filter((p) => p.ready).map((p) => p.id)).toEqual(["sandbox-daytona", "sandbox-box"]);

    const overridden = await harness.behavior.callRpc("setDefaultSandboxProvider", { providerId: "sandbox-daytona" }) as {
      selectedProviderId: string | null;
      effectiveProviderId: string | null;
    };
    expect(overridden.selectedProviderId).toBe("sandbox-daytona");
    expect(overridden.effectiveProviderId).toBe("sandbox-daytona");

    const reset = await harness.behavior.callRpc("setDefaultSandboxProvider", { providerId: null }) as {
      selectedProviderId: string | null;
      effectiveProviderId: string | null;
    };
    expect(reset.selectedProviderId).toBeNull();
    expect(reset.effectiveProviderId).toBe("sandbox-box");
    await harness.lifecycle.dispose();
  });
});
