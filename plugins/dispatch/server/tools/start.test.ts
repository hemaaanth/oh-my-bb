import { describe, expect, it } from "vitest";
import { APP_CONTEXT, hostRow, makeContext, projectRow, threadRow, type Stubs } from "../core-test-host.js";
import { executeServerTool } from "./index.js";
import { NEW_THREAD_SCREEN_NOTE, pickEnvironment } from "./start.js";
import type { HostRow, ProjectRow } from "./resolve.js";

const personal = projectRow({ id: "proj_me", name: "Personal", kind: "personal", gitRemoteUrl: null });
const website = projectRow();
const notes = projectRow({ id: "proj_n", name: "Notes", gitRemoteUrl: null, sources: [{ hostId: "host_a", path: "/home/me/notes", isDefault: true }] });

const stubs = {
  projects: { list: async () => [personal, website, notes] },
  hosts: { list: async () => [hostRow(), hostRow({ id: "host_b", name: "laptop" })] },
  threads: {
    spawn: async () => ({ id: "thr_new" }),
    get: async () => threadRow({ id: "thr_new", title: "Add dark mode" }),
  },
} as unknown as Stubs;

async function start(args: Record<string, unknown>, context = APP_CONTEXT) {
  const { ctx, harness } = await makeContext(undefined, stubs);
  const result = await executeServerTool(ctx, { callId: "none", name: "start_thread", args, context });
  return { result, spawns: harness.inspection.sdk.callsTo("threads.spawn") as Array<[Record<string, unknown>]> };
}

describe("start_thread", () => {
  it("starts in the personal workspace when no project is given or current", async () => {
    const { result, spawns } = await start({ prompt: "Plan my week", title: "Week plan" });
    expect(result.status).toBe("success");
    expect(spawns[0]![0]).toMatchObject({
      projectId: "proj_me",
      prompt: "Plan my week",
      title: "Week plan",
      origin: "plugin",
      environment: { type: "host", hostId: "host_a", workspace: { type: "personal" } },
    });
  });

  it("uses a managed worktree on the default branch for a git project on a named machine", async () => {
    const { spawns } = await start({ project_id: "proj_a", machine_id: "laptop", prompt: "Add dark mode" });
    expect(spawns[0]![0].environment).toEqual({ type: "host", hostId: "host_b", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } });
  });

  it("uses the unmanaged source path for a project without git", async () => {
    const { spawns } = await start({ project_id: "proj_n", machine_id: "studio", prompt: "Tidy up" });
    expect(spawns[0]![0].environment).toEqual({ type: "host", hostId: "host_a", workspace: { type: "unmanaged", path: "/home/me/notes" } });
  });

  it("uses the project default without a machine, and the current project first", async () => {
    const { spawns } = await start({ prompt: "Fix it" }, { ...APP_CONTEXT, projectId: "proj_a" });
    expect(spawns[0]![0]).toMatchObject({ projectId: "proj_a", environment: { type: "project-default" } });
  });

  it("opens the New thread screen without a prompt", async () => {
    const { result, spawns } = await start({ project_id: "proj_a" });
    expect(spawns).toEqual([]);
    expect(JSON.parse(result.output)).toEqual({ newThreadScreen: true, projectId: "proj_a", projectName: "Website", note: NEW_THREAD_SCREEN_NOTE });
    expect(NEW_THREAD_SCREEN_NOTE).toMatch(/New thread screen is open/);
  });

  it("refuses a machine that does not hold a non-git project", () => {
    const other = hostRow({ id: "host_b", name: "laptop" }) as unknown as HostRow;
    expect(() => pickEnvironment(notes as unknown as ProjectRow, other)).toThrow(/laptop does not hold the project Notes/);
  });
});
