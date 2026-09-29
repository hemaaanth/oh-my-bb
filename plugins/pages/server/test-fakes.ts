// Test-only fakes for bb.sdk thread roots and file reads.
import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

export const WORKSPACE = "/work/repo";
export const storageOf = (threadId: string) => `/bb/threads/${threadId}/storage`;

/** A plugin host whose threads have a workspace at WORKSPACE and storage at storageOf(threadId). */
export function pagesHost() {
  const files = new Map<string, string>();
  /** Calls to other plugins (runProducerAction forwards to pr-review). */
  const rpcCalls: Array<{ pluginId: string; method: string; input: unknown }> = [];
  /** Threads that report archivedAt. */
  const archived = new Set<string>();
  /** When set, calls to other plugins fail with this error. */
  const rpcFailure: { error: Error | null } = { error: null };
  const { bb, harness } = createFakePluginHost({
    pluginId: "pages",
    sdk: {
      plugins: {
        callRpc: async ({ pluginId, method, input }) => {
          rpcCalls.push({ pluginId, method, input });
          if (rpcFailure.error) throw rpcFailure.error;
          return { ok: true };
        },
      },
      projects: {
        get: async ({ projectId }) => ({ id: projectId, name: projectId === "proj_test" ? "Test Project" : projectId }),
      },
      threads: {
        get: async ({ threadId }) => ({ id: threadId, projectId: "proj_test", archivedAt: archived.has(threadId) ? 1_790_000_000_000 : null, environmentId: "env_1", environment: { id: "env_1", path: WORKSPACE, hostId: "host_1", projectId: "proj_test" } }),
        storageLocation: async ({ threadId }) => ({ hostId: "host_1", storageRootPath: storageOf(threadId) }),
      },
      files: {
        read: async ({ path }) => {
          const content = files.get(path);
          if (content === undefined) throw Object.assign(new Error("not found"), { status: 404 });
          return { path, content, contentEncoding: "utf8", sizeBytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
        },
      },
    },
  });
  plugin(bb);
  return { bb, harness, files, rpcCalls, archived, rpcFailure };
}
