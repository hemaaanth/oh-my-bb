// Test-only fakes for bb.sdk thread roots and file reads.
import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

export const WORKSPACE = "/work/repo";
export const storageOf = (threadId: string) => `/bb/threads/${threadId}/storage`;

/**
 * A plugin host whose threads have a workspace at WORKSPACE and storage at storageOf(threadId).
 * `files` holds text (read as utf8) or bytes (read as base64). `files.list` returns every file
 * under a folder, dotfiles and node_modules included, so the plugin's own filter is what tests see.
 */
export function pagesHost() {
  /** Text files as strings; binary files (images) as bytes, read back as base64. */
  const files = new Map<string, string | Uint8Array>();
  /** Calls to other plugins (runProducerAction forwards to pr-review). */
  const rpcCalls: Array<{ pluginId: string; method: string; input: unknown }> = [];
  /** Threads that report archivedAt. */
  const archived = new Set<string>();
  /** When set, calls to other plugins and thread sends fail with this error. */
  const rpcFailure: { error: Error | null } = { error: null };
  /** Messages sent to threads (sendFeedback). */
  const sent: Array<{ threadId: string; mode: string; text: string }> = [];
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
        send: async ({ threadId, mode, input }) => {
          if (rpcFailure.error) throw rpcFailure.error;
          sent.push({ threadId, mode, text: input.map((part) => (part.type === "text" ? part.text : "")).join("") });
          return {} as never;
        },
        storageLocation: async ({ threadId }) => ({ hostId: "host_1", storageRootPath: storageOf(threadId) }),
      },
      files: {
        read: async ({ path }) => {
          const content = files.get(path);
          if (content === undefined) throw Object.assign(new Error("not found"), { status: 404 });
          const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
          return typeof content === "string"
            ? { path, content, contentEncoding: "utf8" as const, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
            : { path, content: bytes.toString("base64"), contentEncoding: "base64" as const, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
        },
        list: async ({ path, limit = 1_000 }) => {
          const prefix = `${path.replace(/\/$/u, "")}/`;
          const found = [...files.keys()].filter((file) => file.startsWith(prefix)).sort().map((file) => ({ path: file.slice(prefix.length), name: file.slice(file.lastIndexOf("/") + 1) }));
          return { files: found.slice(0, limit), truncated: found.length > limit };
        },
        write: async ({ path, content, contentEncoding, expectedSha256 }) => {
          const bytes = Buffer.from(content, contentEncoding ?? "utf8");
          const existing = files.get(path);
          const currentSha256 = existing === undefined ? null : createHash("sha256").update(existing).digest("hex");
          if (expectedSha256 !== undefined && expectedSha256 !== currentSha256) return { outcome: "conflict", currentSha256 };
          files.set(path, bytes);
          return { outcome: "written", sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength };
        },
      },
    },
  });
  plugin(bb);
  return { bb, harness, files, rpcCalls, archived, rpcFailure, sent };
}
