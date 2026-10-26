// The BB side of spec fences: BB's code and diff viewers, Markdown, links, and the Pages server for
// Query tools and web lookups. The chat fence and the gallery share it; group files only see the Host.
import { useCallback, useMemo } from "react";
import { Markdown, experimental_Diff as Diff, useBbNavigate, useRpc, useSettings, type ExperimentalLiveFileTarget } from "@get-bb/plugin-sdk/app";
import type { PagesRpc, SpecResult } from "../contract.js";
import { CodeFrame, type Host } from "./spec/host.js";
import type { Tools } from "./spec/kit.js";
import { specTools } from "./spec/tools.js";
import { NativeCode } from "./NativeCode.js";
import { hostResources } from "./spec/resources.js";
import { NativeApp } from "./apps/NativeApp.js";
import { sourcedQuery } from "./spec/source-metadata.js";

// BB's `*` scrollbar-color reaches into the viewer's shadow DOM and turns off its hidden scrollbar, so the
// system bar shows and reserves a gutter on the right. Reset it, and drop the bottom padding kept for that bar.
const noIdleScrollbar = "[--diffs-overflow-override:auto] [--diffs-scrollbar-gutter-override:0px] [&_*]:[scrollbar-color:auto]";
const unwrap = (result: SpecResult): unknown => { if (result.ok) return result.data; throw new Error(result.message); };

export function useBbHost(kind: Host["kind"], scope: { threadId?: string; blockKey?: string; appsReady?: boolean } = {}): Host {
  const rpc = useRpc<PagesRpc>();
  const navigate = useBbNavigate();
  const { threadId, blockKey = null, appsReady = true } = scope;
  const settings = useSettings();
  const animations = !settings.isLoading && settings.values?.animations !== false;
  const resources = useMemo(() => hostResources(
    async (src) => {
      if (!threadId) throw new Error("A local asset needs a thread.");
      return unwrap(await rpc.call("specTool", { threadId, tool: "asset", args: { path: src } }));
    },
    async (src) => unwrap(await rpc.call("specWeb", { method: "image", input: { url: src } })),
  ), [rpc, threadId]);
  const loadText = useCallback(async (src: string): Promise<string> => {
    if (!threadId) throw new Error("A local source file needs a thread.");
    const data = unwrap(await rpc.call("specTool", { threadId, tool: "read_text", args: { path: src } }));
    if (typeof data !== "string") throw new Error("Source text has an invalid response.");
    return data;
  }, [rpc, threadId]);
  return useMemo(() => ({
    kind,
    threadId: threadId ?? null,
    blockKey,
    appsReady,
    App: NativeApp,
    SourceCode: NativeCode,
    Diff: ({ patch, path }) => <CodeFrame label={path} text={patch}><Diff patch={patch} path={path} overflow="wrap" className={noIdleScrollbar} /></CodeFrame>,
    Markdown: ({ content }) => <Markdown content={content} />,
    web: async (method, input) => unwrap(await rpc.call("specWeb", { method, input })),
    ...resources,
    loadText,
    animations,
    // Only web links open: the URL comes from model output.
    openUrl: (url) => { if (/^https?:\/\//iu.test(url) && !navigate.openUrl(url)) window.open(url, "_blank", "noopener,noreferrer"); },
    openFile: !threadId ? null : async (path, startLine, endLine) => {
      const target = unwrap(await rpc.call("specTool", { threadId, tool: "file_target", args: { path } })) as ExperimentalLiveFileTarget;
      const location = startLine ? endLine ? { kind: "range" as const, startLine, endLine } : { kind: "line" as const, line: startLine, column: null } : null;
      return navigate.experimental_openFilePreview({ target, location });
    },
    replies: true,
  }), [kind, rpc, navigate, resources, animations, threadId, blockKey, appsReady, loadText]);
}

/** The Renderer's toolProvider in chat: each listed tool goes to the Pages server with this thread. */
export function useBbTools(threadId: string): Tools {
  const rpc = useRpc<PagesRpc>();
  return useMemo(() => Object.fromEntries(specTools.map(({ name }) => [name, async (args: Record<string, unknown>) => sourcedQuery(name, args, unwrap(await rpc.call("specTool", { threadId, tool: name, args })))])), [rpc, threadId]);
}
