import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { parsePaseoManifest } from "./server";

function makeReadyEnvironment() {
  return {
    id: "env_1",
    name: null,
    projectId: "proj_1",
    hostId: "host_1",
    path: "/work/feature",
    managed: true,
    isGitRepo: true,
    isWorktree: true,
    workspaceProvisionType: "managed-worktree",
    branchName: "feature",
    baseBranch: "main",
    defaultBranch: "main",
    mergeBaseBranch: "main",
    status: "ready",
    createdAt: 1,
    updatedAt: 1,
  } as never;
}

describe("workspace scripts", () => {
  it("does not autostart services when the setting is disabled", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "workspace-scripts",
      settings: { autoStartServices: false },
    });
    await plugin(bb);

    const { errors } = await harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "th_1", projectId: "proj_1", environmentId: "env_1" }),
    });
    expect(errors).toEqual([]);
    expect(harness.inspection.sdk.callsTo("terminals.create")).toEqual([]);
  });

  it("parses Paseo lifecycle hooks, commands, and services", () => {
    const manifest = parsePaseoManifest(JSON.stringify({
      worktree: {
        setup: "npm ci",
        teardown: "npm run clean",
        terminals: [{ name: "Web", command: "npm run dev" }],
      },
      scripts: {
        verify: { command: "npm test" },
        api: { type: "service", command: "npm run api" },
      },
    }));

    expect(manifest.worktree?.setup).toBe("npm ci");
    expect(manifest.worktree?.terminals?.[0]?.name).toBe("Web");
    expect(manifest.scripts?.api?.type).toBe("service");
  });

  it("normalizes Paseo lifecycle hook arrays into fail-fast shell commands", () => {
    const manifest = parsePaseoManifest(JSON.stringify({
      worktree: {
        setup: ["npm ci", "npm run build"],
        teardown: ["npm run stop", "npm run clean"],
      },
    }));

    expect(manifest.worktree?.setup).toBe("set -e\nnpm ci\nnpm run build");
    expect(manifest.worktree?.teardown).toBe("set -e\nnpm run stop\nnpm run clean");
  });

  it("discovers the active checkout and uses thread versus environment terminal scopes", async () => {
    let terminalNumber = 0;
    const paseo = JSON.stringify({
      worktree: {
        setup: "npm ci",
        terminals: [{ name: "Web", command: "npm run dev" }],
      },
      scripts: {
        verify: { command: "npm test" },
        api: { type: "service", command: "npm run api -- --port \"$PASEO_PORT\"" },
      },
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "workspace-scripts",
      experimental_callHostRpc: async () => ({ port: 4321 }),
      sdk: {
        threads: {
          get: async () => makeThreadResponse({
            id: "th_1",
            projectId: "proj_1",
            environmentId: "env_1",
          }),
        },
        environments: {
          get: async () => ({
            id: "env_1",
            name: null,
            projectId: "proj_1",
            hostId: "host_1",
            path: "/work/feature",
            managed: true,
            isGitRepo: true,
            isWorktree: true,
            workspaceProvisionType: "managed-worktree",
            branchName: "feature",
            baseBranch: "main",
            defaultBranch: "main",
            mergeBaseBranch: "main",
            status: "ready",
            createdAt: 1,
            updatedAt: 1,
          }),
        },
        projects: {
          get: async () => ({
            id: "proj_1",
            kind: "standard",
            name: "Example",
            gitRemoteUrl: "https://example.com/repo.git",
            localHostId: "host_1",
            localPath: "/work/source",
          }) as never,
        },
        files: {
          read: async ({ path }) => {
            if (path.endsWith("/paseo.json")) {
              return { content: paseo, contentEncoding: "utf8" } as never;
            }
            throw new Error("ENOENT");
          },
        },
        terminals: {
          create: async ({ scope }) => ({
            id: `term_${++terminalNumber}`,
            hostId: "host_1",
            status: "running",
            exitCode: null,
            initialCwd: "/work/feature",
            scope,
          }) as never,
          get: async ({ terminalId }) => ({
            id: terminalId,
            hostId: "host_1",
            status: "running",
            exitCode: null,
          }) as never,
          close: async ({ terminalId }) => ({ id: terminalId }) as never,
        },
      },
    });
    await plugin(bb);

    const snapshot = await harness.behavior.callRpc("inspect", { threadId: "th_1" });
    expect(snapshot).toMatchObject({
      workspacePath: "/work/feature",
      setup: { source: "paseo" },
      actions: [
        { id: "script:verify", type: "command", running: false },
        { id: "script:api", type: "service", running: false },
        { name: "Web", source: "worktree-terminal", autostart: true },
      ],
    });

    await harness.behavior.callRpc("run", {
      threadId: "th_1",
      actionId: "script:verify",
    });
    await harness.behavior.callRpc("run", {
      threadId: "th_1",
      actionId: "script:api",
    });

    expect(harness.inspection.sdk.callsTo("terminals.create")).toEqual([
      [expect.objectContaining({ scope: { kind: "thread", threadId: "th_1" } })],
      [expect.objectContaining({
        scope: { kind: "environment", environmentId: "env_1" },
        start: { mode: "command", command: expect.stringContaining("export PASEO_PORT=4321") },
      })],
    ]);
    expect(harness.inspection.experimental_hostRpcCalls).toEqual([
      expect.objectContaining({ method: "allocate_port", hostId: "host_1" }),
    ]);
    await expect(
      harness.behavior.callRpc("run", {
        threadId: "th_1",
        actionId: "script:api",
      }),
    ).resolves.toMatchObject({ terminalId: "term_2", reused: true });
  });

  it("reports an offline workspace without failing inspection", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "workspace-scripts",
      sdk: {
        threads: {
          get: async () => makeThreadResponse({
            id: "th_offline",
            projectId: "proj_1",
            environmentId: "env_offline",
          }),
        },
        environments: {
          get: async () => ({
            id: "env_offline",
            name: null,
            projectId: "proj_1",
            hostId: "host_offline",
            path: "/work/offline",
            managed: true,
            isGitRepo: true,
            isWorktree: true,
            workspaceProvisionType: "managed-worktree",
            branchName: "feature",
            baseBranch: "main",
            defaultBranch: "main",
            mergeBaseBranch: "main",
            status: "ready",
            createdAt: 1,
            updatedAt: 1,
          }),
        },
        files: {
          read: async () => {
            throw new Error("HTTP 502: Host is not connected");
          },
        },
      },
    });
    await plugin(bb);

    await expect(harness.behavior.callRpc("inspect", { threadId: "th_offline" }))
      .resolves.toEqual({
        available: false,
        message: "This workspace host is offline.",
      });
  });

  it("reports the native setup hook as taking precedence over the Paseo fallback", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "workspace-scripts",
      sdk: {
        threads: {
          get: async () => makeThreadResponse({
            id: "th_1",
            projectId: "proj_1",
            environmentId: "env_1",
          }),
        },
        environments: {
          get: async () => makeReadyEnvironment(),
        },
        files: {
          read: async ({ path }) => {
            if (path.endsWith("/.bb-env-setup.sh")) {
              return { content: "echo native", contentEncoding: "utf8" } as never;
            }
            if (path.endsWith("/paseo.json")) {
              return {
                content: JSON.stringify({ worktree: { setup: "echo paseo" } }),
                contentEncoding: "utf8",
              } as never;
            }
            throw new Error("ENOENT");
          },
        },
      },
    });
    await plugin(bb);

    await expect(
      harness.behavior.callRpc("inspect", { threadId: "th_1" }),
    ).resolves.toMatchObject({ available: true, setup: { source: "bb" } });
  });

  it("autostarts declared worktree terminals when a thread becomes active", async () => {
    const paseo = JSON.stringify({
      worktree: { terminals: [{ name: "Web", command: "npm run dev" }] },
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "workspace-scripts",
      sdk: {
        threads: {
          get: async () => makeThreadResponse({
            id: "th_1",
            projectId: "proj_1",
            environmentId: "env_1",
          }),
        },
        environments: { get: async () => makeReadyEnvironment() },
        files: {
          read: async ({ path }) => {
            if (path.endsWith("/paseo.json")) {
              return { content: paseo, contentEncoding: "utf8" } as never;
            }
            throw new Error("ENOENT");
          },
        },
        terminals: {
          create: async ({ scope }) => ({
            id: "term_web",
            hostId: "host_1",
            status: "running",
            exitCode: null,
            initialCwd: "/work/feature",
            scope,
          }) as never,
          get: async ({ terminalId }) => ({
            id: terminalId,
            hostId: "host_1",
            status: "running",
            exitCode: null,
          }) as never,
          close: async ({ terminalId }) => ({ id: terminalId }) as never,
        },
      },
    });
    await plugin(bb);

    const { errors } = await harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "th_1", projectId: "proj_1", environmentId: "env_1" }),
    });
    expect(errors).toEqual([]);
    expect(harness.inspection.sdk.callsTo("terminals.create")).toEqual([
      [expect.objectContaining({ scope: { kind: "environment", environmentId: "env_1" } })],
    ]);
  });
});
