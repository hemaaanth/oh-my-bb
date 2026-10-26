// Server half of spec fences: Query tools and web lookups. Each handler answers SpecResult, so a
// failed call shows its message in the component instead of breaking the fence.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract, type SpecResult } from "../../contract.js";
import { resolveRoot, type FileSource } from "../files.js";
import { bakeSpecs } from "./bake.js";
import { runTool } from "./data.js";
import { SpecError } from "./errors.js";
import { runWeb } from "./web.js";
import type { PageSettings } from "../settings.js";

export const specRpcContract = defineRpcContract({
  specTool: rpcContract.specTool,
  specWeb: rpcContract.specWeb,
});

async function answer(log: BbPluginApi["log"], run: () => Promise<unknown>): Promise<SpecResult> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    if (error instanceof SpecError) return { ok: false, message: error.message };
    log.warn(`spec call failed: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, message: "That lookup failed." };
  }
}

/** Tools a publish may bake besides "file": they describe the workspace, which a workspace publish already reads. */
const WORKSPACE_TOOLS = new Set(["changes", "commits", "pull_request"]);

/** Bakes a page's openui-lang blocks for a publish from `source` in a thread. */
export type SpecBaker = (html: string, from: { threadId: string; source: FileSource }) => Promise<string>;

export function registerSpec(bb: BbPluginApi, settings: PageSettings): { bake: SpecBaker } {
  bb.rpc.register(specRpcContract, {
    specTool: ({ threadId, tool, args }) => answer(bb.log, () => runTool(bb, { threadId, tool, args })),
    specWeb: ({ method, input }) => answer(bb.log, async () => {
      const { webLookups, mapboxToken } = await settings.get();
      if (!webLookups) throw new SpecError("Web lookups are off in the Pages settings.");
      return runWeb(bb, method, input, mapboxToken?.trim());
    }),
  });
  // A published page reads only what its publish could: Query("file") inside the root the page came from,
  // and the workspace's git tools when it came from the workspace. Other threads and environments are left out.
  const bake: SpecBaker = async (html, { threadId, source }) => {
    const { webLookups, mapboxToken, animations } = await settings.get();
    const root = await resolveRoot(bb.sdk, threadId, source);
    const roots = [{ name: source === "workspace" ? "workspace" : "thread storage", rootPath: root.rootPath, hostId: root.hostId }];
    return bakeSpecs(html, {
      tool: (tool, args) => tool === "file" || tool === "asset" || tool === "read_text" || (source === "workspace" && WORKSPACE_TOOLS.has(tool)) ? answer(bb.log, () => runTool(bb, { threadId, tool, args, roots })) : null,
      web: webLookups ? (method, input) => answer(bb.log, () => runWeb(bb, method, input, mapboxToken?.trim())) : null,
      animations,
    });
  };
  return { bake };
}
