// The BB side of spec fences: BB's code and diff viewers, Markdown, links, and the Pages server for
// Query tools and web lookups. The chat fence and the gallery share it; group files only see the Host.
import { useMemo } from "react";
import { Markdown, experimental_Diff as Diff, experimental_SourceCode as SourceCode, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PagesRpc, SpecResult } from "../contract.js";
import { CodeFrame, codeLanguage, type Host } from "./spec/host.js";
import type { Tools } from "./spec/kit.js";
import { specTools } from "./spec/tools.js";

// BB's `*` scrollbar-color reaches into the viewer's shadow DOM and turns off its hidden scrollbar, so the
// system bar shows and reserves a gutter on the right. Reset it, and drop the bottom padding kept for that bar.
const noIdleScrollbar = "[--diffs-overflow-override:auto] [--diffs-scrollbar-gutter-override:0px] [&_*]:[scrollbar-color:auto]";
const unwrap = (result: SpecResult): unknown => { if (result.ok) return result.data; throw new Error(result.message); };

export function useBbHost(kind: Host["kind"]): Host {
  const rpc = useRpc<PagesRpc>();
  const navigate = useBbNavigate();
  return useMemo(() => ({
    kind,
    SourceCode: ({ content, path }) => <CodeFrame label={codeLanguage(path)} text={content}><SourceCode content={content} path={path} overflow="wrap" className={noIdleScrollbar} /></CodeFrame>,
    Diff: ({ patch, path }) => <CodeFrame label={path} text={patch}><Diff patch={patch} path={path} overflow="wrap" className={noIdleScrollbar} /></CodeFrame>,
    Markdown: ({ content }) => <Markdown content={content} />,
    web: async (method, input) => unwrap(await rpc.call("specWeb", { method, input })),
    // Only web links open: the URL comes from model output.
    openUrl: (url) => { if (/^https?:\/\//iu.test(url) && !navigate.openUrl(url)) window.open(url, "_blank", "noopener,noreferrer"); },
    replies: true,
  }), [kind, rpc, navigate]);
}

/** The Renderer's toolProvider in chat: each listed tool goes to the Pages server with this thread. */
export function useBbTools(threadId: string): Tools {
  const rpc = useRpc<PagesRpc>();
  return useMemo(() => Object.fromEntries(specTools.map(({ name }) => [name, async (args: Record<string, unknown>) => unwrap(await rpc.call("specTool", { threadId, tool: name, args }))])), [rpc, threadId]);
}
