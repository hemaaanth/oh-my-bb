import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";

/** BB launches agents beside the real Node executable, ahead of vendor PATH entries. */
export function sandboxExecutor(executor: MachineExecutor): MachineExecutor {
  return {
    exec(request) {
      return executor.exec({
        ...request,
        command: ["sh", "-c", 'node_bin=$(node -p \'require("node:path").dirname(process.execPath)\') || exit; export PATH="$node_bin:$PATH"; exec "$@"', "bb-sandbox-exec", ...request.command],
      });
    },
  };
}

/** User-facing names are independent of vendor allocation IDs and hostnames. */
export async function sandboxName(bb: BbPluginApi, provider: string, key: string): Promise<string> {
  try {
    const thread = await bb.sdk.threads.get({ threadId: key });
    if (thread.projectId) {
      const project = await bb.sdk.projects.get({ projectId: thread.projectId });
      return `${provider} · ${project.name}`;
    }
    return `${provider} · Personal workspace`;
  } catch {
    return `${provider} · ${key.replace(/^thr_/u, "").slice(0, 6)}`;
  }
}
