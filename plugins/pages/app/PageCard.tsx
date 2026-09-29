import { useCallback, useState, type ReactNode } from "react";
import { useBbNavigate, useRpc, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import type { PageDetail, PagesRpc } from "../contract.js";
import { ShareButton } from "./share/SharePopover.js";
import { pageTag, sourceTag, updateCached, useCachedQuery, usePageDetail, type Load } from "./data.js";
import { parseDirective, type DirectiveName, type FileSource } from "./directives.js";
import { IconButton, QuietLine, focusRing, messageOf, themedUrl, usePreviewTheme } from "./ui.js";

export const PANEL_ACTION_ID = "page";
const COLLAPSED_KEY = "bb.pages.collapsed";

function readCollapsed() {
  try { return window.localStorage.getItem(COLLAPSED_KEY) === "true"; } catch { return false; }
}

/** The 32px bar plus the live preview. Every directive renders through this frame. The compact ShareButton shows the shared dot. */
function CardFrame({ title, version, share, height, src, onOpen }: {
  title: string; version: string | null; share: ReactNode; height: number; src: string; onOpen: () => void;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () => {
    setCollapsed(!collapsed);
    try { window.localStorage.setItem(COLLAPSED_KEY, String(!collapsed)); } catch { /* storage unavailable */ }
  };
  return <div className="my-2 overflow-hidden rounded-lg border border-border bg-background">
    <div className={`flex h-8 items-center gap-1.5 pl-3 pr-1 text-xs ${collapsed ? "" : "border-b border-border"}`}>
      <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={title}>{title}</span>
      {version ? <span className="shrink-0 tabular-nums text-muted-foreground">{version}</span> : null}
      <span className="ml-1 flex shrink-0 items-center">
        {share}
        <IconButton label={`Open ${title} in panel`} icon="ExternalLink" onClick={onOpen} />
        <IconButton label={collapsed ? `Expand ${title}` : `Collapse ${title}`} aria-expanded={!collapsed} icon={collapsed ? "ChevronRight" : "ChevronDown"} onClick={toggle} />
      </span>
    </div>
    {collapsed ? null : <div className="relative" style={{ height }}>
      <iframe title={`Preview: ${title}`} src={src} sandbox="allow-scripts" loading="lazy" className="block size-full border-0 bg-background" />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-background" />
      <button type="button" tabIndex={-1} aria-hidden title={`Open ${title} in panel`} className={`absolute inset-0 cursor-pointer ${focusRing}`} onClick={onOpen} />
    </div>}
  </div>;
}

function PageCard({ pageId, versionId, height, source }: { pageId: string; versionId: string | null; height: number; source: string }) {
  const navigate = useBbNavigate();
  const theme = usePreviewTheme();
  const { state } = usePageDetail(pageId, versionId);
  if (state.status === "loading" || state.status === "idle") return <QuietLine>Loading page…</QuietLine>;
  if (state.status === "missing") return <QuietLine source={source}>{versionId ? "This page version no longer exists." : "This page no longer exists."}</QuietLine>;
  if (state.status === "error") return <QuietLine tone="error" source={source}>{state.message}</QuietLine>;
  const { page, version, versions, share, previewUrl } = state.value;
  const latest = Math.max(version.n, ...versions.map(({ n }) => n));
  const pinnedOlder = version.n < latest;
  return <CardFrame
    title={page.title}
    version={pinnedOlder ? `v${version.n} of ${latest}` : `v${version.n}`}
    share={<ShareButton compact pageId={page.id} share={share} />}
    height={height}
    src={themedUrl(previewUrl, theme, "card")}
    onOpen={() => navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title: page.title, params: pinnedOlder ? { pageId: page.id, versionId: version.id } : { pageId: page.id } })}
  />;
}

type Resolved = { sourceKey: string; previewUrl: string; page: PageDetail | null };

/** A live file and the page (if any) it was published as. Cached per window like usePageDetail. */
export function useResolvedFile(threadId: string, file: string, source: FileSource) {
  const rpc = useRpc<PagesRpc>();
  const key = `resolveFile|${threadId}|${source}|${file}`;
  const state = useCachedQuery<Resolved>(key, async () => {
    try {
      return { status: "ready", value: await rpc.call("resolveFile", { threadId, file, source }) };
    } catch (error) {
      return { status: "error", message: messageOf(error, "The file could not load.") };
    }
  // Signals name the file's source key when it is first published (or republished), and its page id after that.
  }, (loaded) => loaded.status === "ready" ? [sourceTag(loaded.value.sourceKey), ...(loaded.value.page ? [pageTag(loaded.value.page.page.id)] : [])] : []);
  /** Share needs a page: snapshot the live file, then hand back the new page id. */
  const publish = useCallback(async () => {
    const result = await rpc.call("publishFile", { threadId, file, source });
    updateCached<Resolved>(key, (value) => ({ ...value, page: result }));
    return result.page.id;
  }, [threadId, file, source, rpc, key]);
  return { state, publish };
}

function FileCard({ threadId, file, source, height, directiveSource }: { threadId: string; file: string; source: FileSource; height: number; directiveSource: string }) {
  const navigate = useBbNavigate();
  const theme = usePreviewTheme();
  const { state, publish } = useResolvedFile(threadId, file, source);
  if (state.status === "loading" || state.status === "idle") return <QuietLine>Loading {file}…</QuietLine>;
  if (state.status !== "ready") return <QuietLine tone="error" source={directiveSource}>{state.status === "error" ? state.message : "The file could not load."}</QuietLine>;
  const { page, previewUrl } = state.value;
  const title = page?.page.title ?? file;
  return <CardFrame
    title={title}
    version={page ? `v${page.version.n}` : null}
    share={<ShareButton compact pageId={page?.page.id ?? null} share={page?.share ?? null} onNeedsPage={publish} />}
    height={height}
    src={themedUrl(previewUrl, theme, "card")}
    onOpen={() => navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title, params: { threadId, source, file } })}
  />;
}

/** One directive component per alias; all of them render the same card. */
export function directiveComponent(name: DirectiveName) {
  return function PageDirective(props: PluginMessageDirectiveProps) {
    const parsed = parseDirective(name, props.attributes);
    if (!parsed.ok) return <QuietLine tone="error" source={props.source}>{parsed.message}</QuietLine>;
    const card = parsed.ref;
    return card.kind === "page"
      ? <PageCard pageId={card.pageId} versionId={card.versionId} height={card.height} source={props.source} />
      : <FileCard threadId={props.message.threadId} file={card.file} source={card.source} height={card.height} directiveSource={props.source} />;
  };
}
