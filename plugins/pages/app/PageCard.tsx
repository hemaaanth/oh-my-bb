import { useCallback, useState, type ReactNode } from "react";
import { useBbNavigate, useRpc, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import type { PageDetail, PageDisplay, PagesRpc } from "../contract.js";
import { useFrameBridge } from "./bridge.js";
import { ShareButton } from "./share/SharePopover.js";
import { pageTag, sourceTag, updateCached, useCachedQuery, usePageDetail, type Load } from "./data.js";
import { parseDirective, type DirectiveName, type FileSource } from "./directives.js";
import { IconButton, QuietLine, focusRing, messageOf } from "./ui.js";

export const PANEL_ACTION_ID = "page";
const COLLAPSED_KEY = "bb.pages.collapsed";
/** The tallest an inline page grows. Past it the page is clipped with a fade, never scrolled: a frame that scrolls inside the thread traps the reader's scroll. */
export const MAX_INLINE_HEIGHT = 960;

function readCollapsed() {
  try { return window.localStorage.getItem(COLLAPSED_KEY) === "true"; } catch { return false; }
}

type FrameProps = { title: string; version: string | null; share: ReactNode; height: number; previewUrl: string; display: PageDisplay; onOpen: () => void };

/** Every directive renders through one of the two frames. */
function PageFrame({ display, ...props }: FrameProps) {
  return display === "inline" ? <InlineFrame {...props} /> : <CardFrame {...props} />;
}

/** The 32px bar plus a zoomed-out live preview. A click anywhere opens the panel. The compact ShareButton shows the shared dot. */
function CardFrame({ title, version, share, height, previewUrl, onOpen }: Omit<FrameProps, "display">) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const bridge = useFrameBridge(previewUrl, "card");
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
      <iframe ref={bridge.ref} title={`Preview: ${title}`} src={bridge.src} onLoad={bridge.onLoad} style={bridge.style} sandbox="allow-scripts" loading="lazy" className="block size-full border-0 bg-background" />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-background" />
      <button type="button" tabIndex={-1} aria-hidden title={`Open ${title} in panel`} className={`absolute inset-0 cursor-pointer ${focusRing}`} onClick={onOpen} />
    </div>}
  </div>;
}

/**
 * The borderless preview: the page itself, on the thread's background, as part of the reply. It is interactive and
 * fits the page's reported height. Until the first report it holds the directive height.
 */
function InlineFrame({ title, height, previewUrl, onOpen }: Omit<FrameProps, "display">) {
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const bridge = useFrameBridge(previewUrl, "inline", setContentHeight);
  const clipped = contentHeight !== null && contentHeight > MAX_INLINE_HEIGHT;
  return <div className="group/page relative my-2" style={{ height: contentHeight === null ? height : Math.min(contentHeight, MAX_INLINE_HEIGHT) }}>
    <iframe ref={bridge.ref} title={`Page: ${title}`} src={bridge.src} onLoad={bridge.onLoad} style={bridge.style} sandbox="allow-scripts" loading="lazy" scrolling="no" className="block size-full border-0 bg-transparent" />
    {clipped ? <>
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent to-background" />
      <button type="button" onClick={onOpen} className={`absolute bottom-2 left-1/2 h-7 -translate-x-1/2 cursor-pointer rounded-md border border-border bg-background px-2.5 text-xs text-foreground hover:bg-state-hover ${focusRing}`}>Open full page</button>
    </> : null}
    <IconButton label={`Open ${title} in panel`} icon="ExternalLink" onClick={onOpen} className="absolute right-1 top-1 border border-border bg-background opacity-0 transition-opacity focus-visible:opacity-100 group-hover/page:opacity-100 [@media(hover:none)]:opacity-100" />
  </div>;
}

function PageCard({ pageId, versionId, height, display, source }: { pageId: string; versionId: string | null; height: number; display: PageDisplay; source: string }) {
  const navigate = useBbNavigate();
  const { state } = usePageDetail(pageId, versionId);
  if (state.status === "loading" || state.status === "idle") return <QuietLine>Loading page…</QuietLine>;
  if (state.status === "missing") return <QuietLine source={source}>{versionId ? "This page version no longer exists." : "This page no longer exists."}</QuietLine>;
  if (state.status === "error") return <QuietLine tone="error" source={source}>{state.message}</QuietLine>;
  const { page, version, versions, share, previewUrl } = state.value;
  const latest = Math.max(version.n, ...versions.map(({ n }) => n));
  const pinnedOlder = version.n < latest;
  return <PageFrame
    title={page.title}
    version={pinnedOlder ? `v${version.n} of ${latest}` : `v${version.n}`}
    share={<ShareButton compact pageId={page.id} share={share} />}
    height={height}
    previewUrl={previewUrl}
    display={display}
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

function FileCard({ threadId, file, source, height, display, directiveSource }: { threadId: string; file: string; source: FileSource; height: number; display: PageDisplay; directiveSource: string }) {
  const navigate = useBbNavigate();
  const { state, publish } = useResolvedFile(threadId, file, source);
  if (state.status === "loading" || state.status === "idle") return <QuietLine>Loading {file}…</QuietLine>;
  if (state.status !== "ready") return <QuietLine tone="error" source={directiveSource}>{state.status === "error" ? state.message : "The file could not load."}</QuietLine>;
  const { page, previewUrl } = state.value;
  const title = page?.page.title ?? file;
  return <PageFrame
    title={title}
    version={page ? `v${page.version.n}` : null}
    share={<ShareButton compact pageId={page?.page.id ?? null} share={page?.share ?? null} onNeedsPage={publish} />}
    height={height}
    previewUrl={previewUrl}
    display={display}
    onOpen={() => navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title, params: { threadId, source, file } })}
  />;
}

/** One directive component per alias; all of them render the same frames. */
export function directiveComponent(name: DirectiveName) {
  return function PageDirective(props: PluginMessageDirectiveProps) {
    const parsed = parseDirective(name, props.attributes);
    if (!parsed.ok) return <QuietLine tone="error" source={props.source}>{parsed.message}</QuietLine>;
    const card = parsed.ref;
    return card.kind === "page"
      ? <PageCard pageId={card.pageId} versionId={card.versionId} height={card.height} display={card.display} source={props.source} />
      : <FileCard threadId={props.message.threadId} file={card.file} source={card.source} height={card.height} display={card.display} directiveSource={props.source} />;
  };
}
