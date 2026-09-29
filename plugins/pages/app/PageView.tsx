import { useEffect, useRef, useState, type ReactNode } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { experimental_Icon as Icon, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PageDetail, PagesRpc } from "../contract.js";
import { ShareButton } from "./share/SharePopover.js";
import { pageDirective, usePageDetail } from "./data.js";
import type { FileSource } from "./directives.js";
import { useResolvedFile } from "./PageCard.js";
import { PAGE_BG, PORTAL_SCOPE, focusRing, messageOf, relativeTime, themedUrl, usePreviewTheme } from "./ui.js";

export const LIBRARY_PATH = "pages";

const menuItem = `flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-state-hover data-[disabled]:opacity-50`;
const quiet = "flex h-full items-center justify-center p-6 text-sm text-muted-foreground";

/** Full-bleed shell: 40px header, an optional thin banner, then the page. All on the page background, so the panel shows one surface, not a third colour. */
function PanelShell({ header, banner, children }: { header: ReactNode; banner?: ReactNode; children: ReactNode }) {
  const theme = usePreviewTheme();
  return <div className="flex h-full min-h-0 flex-col" style={{ background: PAGE_BG[theme] }}>
    <header className="flex h-10 shrink-0 items-center gap-1 border-b border-border pl-3 pr-2">{header}</header>
    {banner ? <div aria-live="polite" className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border bg-muted/40 px-3 text-xs text-muted-foreground">{banner}</div> : null}
    <div className="relative min-h-0 flex-1">{children}</div>
  </div>;
}

function Preview({ title, src }: { title: string; src: string }) {
  return <iframe title={title} src={src} sandbox="allow-scripts" className="absolute inset-0 size-full border-0 bg-transparent" />;
}

function RenameInput({ detail, onDone }: { detail: PageDetail; onDone: (error?: string) => void }) {
  const rpc = useRpc<PagesRpc>();
  const [value, setValue] = useState(detail.page.title);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => { input.current?.select(); }, []);
  // Enter, Escape, and blur all end the edit; only the first one counts.
  const finish = (error?: string) => { settled.current = true; onDone(error); };
  const save = async () => {
    if (settled.current || saving) return;
    const title = value.trim();
    if (!title || title.length > 180) { finish("A title needs 1 to 180 characters."); return; }
    if (title === detail.page.title) { finish(); return; }
    setSaving(true);
    try { await rpc.call("renamePage", { pageId: detail.page.id, title }); finish(); }
    catch (error) { finish(messageOf(error, "Rename failed.")); }
  };
  return <input
    ref={input}
    aria-label="Page title"
    value={value}
    disabled={saving}
    maxLength={180}
    onChange={(event) => setValue(event.target.value)}
    onBlur={() => void save()}
    onKeyDown={(event) => {
      if (event.key === "Enter") { event.preventDefault(); void save(); }
      if (event.key === "Escape") { event.preventDefault(); finish(); }
    }}
    className={`h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm ${focusRing}`}
  />;
}

function VersionMenu({ detail, shownId, inLibrary, onSelect, onRename, onCopy, onDelete }: {
  detail: PageDetail; shownId: string; inLibrary: boolean;
  onSelect: (versionId: string) => void; onRename: () => void; onCopy: () => void; onDelete: () => void;
}) {
  const navigate = useBbNavigate();
  const versions = [...detail.versions].sort((a, b) => b.n - a.n);
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button type="button" aria-label={`Version ${detail.version.n}. Page menu`} className={`inline-flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-xs tabular-nums text-muted-foreground hover:bg-state-hover hover:text-foreground data-[state=open]:bg-state-hover ${focusRing}`}>
        v{detail.version.n}<Icon name="ChevronDown" aria-hidden className="size-3" />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content {...PORTAL_SCOPE} align="start" sideOffset={4} collisionPadding={8} style={{ zIndex: 75 }} className="w-72 max-w-[calc(100vw-16px)] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
        <DropdownMenu.Label className="px-2 pb-1 pt-1.5 text-xs text-muted-foreground">Versions</DropdownMenu.Label>
        <DropdownMenu.RadioGroup value={shownId} onValueChange={onSelect} className="max-h-64 overflow-y-auto">
          {versions.map((version) => <DropdownMenu.RadioItem key={version.id} value={version.id} className={menuItem}>
            <span className="flex w-3.5 shrink-0 justify-center"><DropdownMenu.ItemIndicator><Icon name="Check" aria-hidden className="size-3.5" /></DropdownMenu.ItemIndicator></span>
            <span className="shrink-0 tabular-nums">v{version.n}</span>
            {version.label ? <span className="min-w-0 truncate text-muted-foreground">· {version.label}</span> : null}
            <span className="ml-auto shrink-0 pl-2 text-xs tabular-nums text-muted-foreground">{relativeTime(version.createdAt)}</span>
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
        <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-border" />
        <DropdownMenu.Item className={menuItem} onSelect={onRename}>Rename</DropdownMenu.Item>
        <DropdownMenu.Item className={menuItem} onSelect={onCopy}>Copy reference</DropdownMenu.Item>
        {inLibrary ? null : <DropdownMenu.Item className={menuItem} onSelect={() => navigate.toPluginPanel(LIBRARY_PATH, { subPath: detail.page.id })}>Show in library</DropdownMenu.Item>}
        <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-border" />
        <DropdownMenu.Item className={`${menuItem} text-destructive`} onSelect={onDelete}>Delete…</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

/** A, B, … Z, AA: the letters PR Review shows for its findings. */
function findingLetter(index: number) {
  let label = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  return label;
}

/** The ⋯ menu for producer pages. Pages forwards the choice to the producer (PR Review), which sends it to the thread. */
function ProducerMenu({ detail, threadId, onNotice }: { detail: PageDetail; threadId: string; onNotice: (message: string) => void }) {
  const rpc = useRpc<PagesRpc>();
  const findings = detail.version.document?.findings ?? [];
  const run = async (action: "explain" | "fix" | "rerun", findingId?: string) => {
    try {
      const result = await rpc.call("runProducerAction", { pageId: detail.page.id, threadId, action, ...(findingId ? { findingId } : {}) });
      if (!result.ok) { onNotice(result.message); return; }
      onNotice(action === "rerun" ? "Rerun sent to the thread." : action === "fix" ? "Fix request sent to the thread." : "Explain request sent to the thread.");
    } catch (error) {
      onNotice(messageOf(error, "The request failed."));
    }
  };
  // Explain can cover the whole review; Fix always targets one finding.
  const findingMenu = (action: "explain" | "fix", label: string) => <DropdownMenu.Sub>
    <DropdownMenu.SubTrigger disabled={action === "fix" && !findings.length} className={menuItem}>{label}<Icon name="ChevronRight" aria-hidden className="ml-auto size-3.5" /></DropdownMenu.SubTrigger>
    <DropdownMenu.Portal>
      <DropdownMenu.SubContent {...PORTAL_SCOPE} sideOffset={4} collisionPadding={8} style={{ zIndex: 76 }} className="max-h-72 w-72 max-w-[calc(100vw-16px)] overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
        {action === "explain" ? <DropdownMenu.Item className={menuItem} onSelect={() => void run("explain")}>Whole review</DropdownMenu.Item> : null}
        {action === "explain" && findings.length ? <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-border" /> : null}
        {findings.map((finding, index) => <DropdownMenu.Item key={finding.id} className={menuItem} onSelect={() => void run(action, finding.id)}>
          <span className="w-5 shrink-0 tabular-nums text-muted-foreground">{findingLetter(index)}</span>
          <span className="min-w-0 truncate">{finding.title}</span>
        </DropdownMenu.Item>)}
      </DropdownMenu.SubContent>
    </DropdownMenu.Portal>
  </DropdownMenu.Sub>;
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button type="button" aria-label="Review actions" className={`inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground data-[state=open]:bg-state-hover ${focusRing}`}>
        <Icon name="MoreHorizontal" aria-hidden className="size-4" />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content {...PORTAL_SCOPE} align="end" sideOffset={4} collisionPadding={8} style={{ zIndex: 75 }} className="w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
        {findingMenu("explain", "Explain")}
        {findingMenu("fix", "Fix")}
        <DropdownMenu.Item className={menuItem} onSelect={() => void run("rerun")}>Rerun review</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

function DeleteDialog({ detail, open, onOpenChange, onDeleted }: { detail: PageDetail; open: boolean; onOpenChange: (open: boolean) => void; onDeleted: () => void }) {
  const rpc = useRpc<PagesRpc>();
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const remove = async () => {
    setState({ busy: true, error: null });
    try { await rpc.call("deletePage", { pageId: detail.page.id }); onOpenChange(false); onDeleted(); }
    catch (error) { setState({ busy: false, error: messageOf(error, "Delete failed.") }); }
  };
  const count = detail.versions.length;
  return <AlertDialog.Root open={open} onOpenChange={(next) => { if (!state.busy) onOpenChange(next); }}>
    <AlertDialog.Portal>
      <AlertDialog.Overlay {...PORTAL_SCOPE} className="fixed inset-0 bg-black/40" style={{ zIndex: 80 }} />
      <AlertDialog.Content {...PORTAL_SCOPE} style={{ zIndex: 81 }} className="fixed left-1/2 top-1/2 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-4 text-foreground shadow-lg">
        <AlertDialog.Title className="text-sm font-medium">Delete “{detail.page.title}”?</AlertDialog.Title>
        <AlertDialog.Description className="mt-1 text-sm text-muted-foreground">This removes the page and its {count === 1 ? "version" : `${count} versions`}. Chat cards that show it will say it no longer exists.</AlertDialog.Description>
        {state.error ? <p role="alert" className="mt-2 text-sm text-destructive">{state.error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <AlertDialog.Cancel asChild><button type="button" disabled={state.busy} className={`h-8 rounded-md border border-border px-3 text-sm hover:bg-state-hover ${focusRing}`}>Cancel</button></AlertDialog.Cancel>
          <button type="button" disabled={state.busy} onClick={() => void remove()} className={`h-8 rounded-md bg-destructive/10 px-3 text-sm font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50 ${focusRing}`}>{state.busy ? "Deleting…" : "Delete"}</button>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
}

/** The page panel: used by the thread side panel and inside the library. `threadId` is the thread the panel is open in, if any. */
export function PageView({ pageId, versionId = null, inLibrary = false, threadId = null, onDeleted }: { pageId: string; versionId?: string | null; inLibrary?: boolean; threadId?: string | null; onDeleted?: () => void }) {
  const theme = usePreviewTheme();
  const latest = usePageDetail(pageId, null);
  const [viewing, setViewing] = useState<string | null>(versionId);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { setViewing(versionId); setDeleted(false); }, [pageId, versionId]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2_500);
    return () => clearTimeout(timer);
  }, [notice]);
  const current = latest.state.status === "ready" ? latest.state.value : null;
  const olderId = current && viewing && viewing !== current.page.currentVersionId ? viewing : null;
  const older = usePageDetail(olderId ? pageId : null, olderId);

  if (deleted) return <p role="status" className={quiet}>Page deleted.</p>;
  if (latest.state.status === "loading" || latest.state.status === "idle") return <p role="status" className={quiet}>Loading page…</p>;
  if (latest.state.status === "missing") return <p role="status" className={quiet}>This page no longer exists.</p>;
  if (latest.state.status === "error") return <p role="alert" className={quiet}>{latest.state.message}</p>;
  const detail = latest.state.value;
  const shown = olderId ? older.state.status === "ready" ? older.state.value : null : detail;

  // Producer actions go to the thread the panel is open in; the library has none, so use the thread that made the version.
  const actionThreadId = threadId ?? detail.version.threadId;
  const header = <>
    {renaming
      ? <RenameInput detail={detail} onDone={(error) => { setRenaming(false); if (error) setNotice(error); else latest.reload(); }} />
      : <h2 className="min-w-0 truncate text-sm font-medium" title={detail.page.title}>{detail.page.title}</h2>}
    <VersionMenu
      detail={shown ?? detail}
      shownId={shown?.version.id ?? olderId ?? detail.version.id}
      inLibrary={inLibrary}
      onSelect={(id) => setViewing(id === detail.version.id ? null : id)}
      onRename={() => setRenaming(true)}
      onCopy={() => {
        const version = shown?.version.id ?? detail.version.id;
        void navigator.clipboard?.writeText(`Page ID: ${detail.page.id}\n${pageDirective(detail.page.id, version)}`).then(() => setNotice("Reference copied."), () => setNotice("Copy failed."));
      }}
      onDelete={() => setDeleting(true)}
    />
    <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
      {detail.page.producer === "pr-review" && actionThreadId ? <ProducerMenu detail={detail} threadId={actionThreadId} onNotice={setNotice} /> : null}
      <ShareButton pageId={detail.page.id} share={detail.share} />
    </div>
    <DeleteDialog detail={detail} open={deleting} onOpenChange={setDeleting} onDeleted={() => { setDeleted(true); onDeleted?.(); }} />
  </>;
  const banner = notice
    ? <span>{notice}</span>
    : olderId && shown
      ? <><span className="tabular-nums">Viewing v{shown.version.n}</span><span aria-hidden>·</span><button type="button" className={`rounded-sm text-foreground underline-offset-2 hover:underline ${focusRing}`} onClick={() => setViewing(null)}>Back to latest</button></>
      : null;
  let body: ReactNode;
  if (shown) body = <Preview title={`${shown.page.title}, version ${shown.version.n}`} src={themedUrl(shown.previewUrl, theme)} />;
  else if (older.state.status === "error") body = <p role="alert" className={quiet}>{older.state.message}</p>;
  else if (older.state.status === "missing") body = <p role="status" className={quiet}>This version no longer exists.</p>;
  else body = <p role="status" className={quiet}>Loading version…</p>;
  return <PanelShell header={header} banner={banner}>{body}</PanelShell>;
}

/** A live ::inline-vis file opened in the panel. Share snapshots it as a page first. */
export function LiveFileView({ threadId, file, source }: { threadId: string; file: string; source: FileSource }) {
  const theme = usePreviewTheme();
  const { state, publish } = useResolvedFile(threadId, file, source);
  if (state.status === "loading" || state.status === "idle") return <p role="status" className={quiet}>Loading {file}…</p>;
  if (state.status !== "ready") return <p role="alert" className={quiet}>{state.status === "error" ? state.message : "The file could not load."}</p>;
  const { page, previewUrl } = state.value;
  return <PanelShell header={<>
    <h2 className="min-w-0 truncate text-sm font-medium" title={file}>{page?.page.title ?? file}</h2>
    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{page ? `live · v${page.version.n}` : "live"}</span>
    <div className="ml-auto flex shrink-0 items-center gap-1 pl-2"><ShareButton pageId={page?.page.id ?? null} share={page?.share ?? null} onNeedsPage={publish} /></div>
  </>}>
    <Preview title={file} src={themedUrl(previewUrl, theme)} />
  </PanelShell>;
}
