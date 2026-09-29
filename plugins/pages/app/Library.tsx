import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_useSidebarThreads, useBbNavigate, useRealtime, useRpc, type PluginNavPanelProps, type PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { PagesRpc } from "../contract.js";
import { REALTIME_CHANNEL } from "./data.js";
import { UUID } from "./directives.js";
import { LIBRARY_PATH, PageView } from "./PageView.js";
import { SharedDot, focusRing, messageOf, relativeTime, themedUrl, usePreviewTheme } from "./ui.js";

type ListItem = PluginRpcResult<PagesRpc["listPages"]>["pages"][number];

/** Loads the iframe only once its card scrolls into view. */
function Thumbnail({ title, src }: { title: string; src: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = box.current;
    if (visible || !element) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) setVisible(true); }, { rootMargin: "200px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);
  // Render at 4x the card width, then scale down, so the thumbnail shows the page's desktop layout.
  return <div ref={box} aria-hidden className="relative h-36 overflow-hidden border-b border-border bg-muted/30">
    {visible ? <iframe title={`Preview of ${title}`} src={src} sandbox="allow-scripts" scrolling="no" loading="lazy" tabIndex={-1} className="pointer-events-none absolute left-0 top-0 h-[400%] w-[400%] origin-top-left scale-[0.25] border-0" /> : null}
  </div>;
}

function LibraryCard({ item, onOpen }: { item: ListItem; onOpen: () => void }) {
  const theme = usePreviewTheme();
  const { page, version, share } = item;
  return <li className="relative overflow-hidden rounded-lg border border-border bg-background hover:border-foreground/20">
    <Thumbnail title={page.title} src={themedUrl(item.previewUrl, theme, "card")} />
    <div className="px-3 py-2">
      <h3 className="truncate text-sm font-medium" title={page.title}>{page.title}</h3>
      <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {share ? <SharedDot /> : null}
        <span className="shrink-0 tabular-nums">v{version.n} · {relativeTime(page.updatedAt)}</span>
      </p>
    </div>
    <button type="button" aria-label={`Open ${page.title}${share ? " (shared)" : ""}`} className={`absolute inset-0 cursor-pointer rounded-lg ${focusRing}`} onClick={onOpen} />
  </li>;
}

/** The page grid. Selecting a page shows the same view as the thread panel. */
export function Library({ selectedId, onSelect, inPanel = false }: { selectedId: string | null; onSelect: (pageId: string | null) => void; inPanel?: boolean }) {
  const rpc = useRpc<PagesRpc>();
  const { projects } = experimental_useSidebarThreads();
  const [projectId, setProjectId] = useState("");
  const [folder, setFolder] = useState("");
  const [folders, setFolders] = useState<Array<{ projectId: string | null; path: string | null; count: number }>>([]);
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const load = useCallback(async (offset: number) => {
    const id = ++request.current;
    try {
      const result = await rpc.call("listPages", { offset, ...(projectId ? { projectId } : {}), ...(folder ? { folder } : {}) });
      if (id !== request.current) return;
      setItems((current) => offset === 0 ? result.pages : [...(current ?? []), ...result.pages]);
      setNextOffset(result.nextOffset);
      setError(null);
    } catch (reason) {
      if (id === request.current) setError(messageOf(reason, "The pages could not load."));
    }
  }, [rpc, projectId, folder]);
  useEffect(() => { void load(0); }, [load]);
  useEffect(() => {
    void rpc.call("listFolders", projectId ? { projectId } : {}).then((result) => setFolders(result.folders)).catch(() => setFolders([]));
  }, [rpc, projectId]);
  // One share or publish sends a few signals in a row; reload once for the burst.
  const burst = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (burst.current) clearTimeout(burst.current); }, []);
  useRealtime(REALTIME_CHANNEL, useCallback(() => {
    if (burst.current) clearTimeout(burst.current);
    burst.current = setTimeout(() => { burst.current = null; void load(0); }, 250);
  }, [load]));

  if (selectedId) return <div className="flex h-full min-h-0 flex-col">
    <div className="flex h-8 shrink-0 items-center border-b border-border px-1.5">
      <button type="button" className={`inline-flex h-6 items-center rounded-md px-1.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground ${focusRing}`} onClick={() => onSelect(null)}>← All pages</button>
    </div>
    <div className="min-h-0 flex-1"><PageView pageId={selectedId} inLibrary onDeleted={() => onSelect(null)} /></div>
  </div>;

  const names = new Map(projects.map((project) => [project.id, project.name]));
  const groups = new Map<string, { label: string; items: ListItem[] }>();
  for (const item of items ?? []) {
    const projectName = item.page.projectId ? names.get(item.page.projectId) ?? "Other project" : "No project";
    const key = `${item.page.projectId ?? ""}\u0000${item.page.folderPath ?? ""}`;
    const label = `${projectName}${item.page.folderPath ? ` / ${item.page.folderPath}` : ""}`;
    const group = groups.get(key) ?? { label, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return <main aria-label="Pages library" className="h-full overflow-y-auto">
    <div className={`flex items-center gap-2 pb-3 ${inPanel ? "px-3 pt-3" : "px-5 pt-4"}`}>
      <label className="sr-only" htmlFor="pages-project-filter">Project</label>
      <select id="pages-project-filter" value={projectId} onChange={(event) => { setItems(null); setFolder(""); setProjectId(event.target.value); }} className={`h-8 max-w-full rounded-md border border-border bg-background px-2 text-sm ${focusRing}`}>
        <option value="">All projects</option>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      {projectId ? <><label className="sr-only" htmlFor="pages-folder-filter">Folder</label><select id="pages-folder-filter" value={folder} onChange={(event) => { setItems(null); setFolder(event.target.value); }} className={`h-8 max-w-full rounded-md border border-border bg-background px-2 text-sm ${focusRing}`}>
        <option value="">All folders</option>
        {folders.filter((entry) => entry.path).map((entry) => <option key={entry.path!} value={entry.path!}>{entry.path} ({entry.count})</option>)}
      </select></> : null}
    </div>
    {error ? <p role="alert" className={`py-2 text-sm text-destructive ${inPanel ? "px-3" : "px-5"}`}>{error}</p> : null}
    {items === null && !error ? <p role="status" className={`py-2 text-sm text-muted-foreground ${inPanel ? "px-3" : "px-5"}`}>Loading pages…</p> : null}
    {items?.length === 0 ? <p role="status" className={`py-2 text-sm text-muted-foreground ${inPanel ? "px-3" : "px-5"}`}>{projectId ? "No pages in this project yet." : "No pages yet. Pages that agents publish appear here."}</p> : null}
    {items?.length ? <div className={`space-y-5 pb-4 ${inPanel ? "px-3" : "px-5"}`}>{[...groups.entries()].map(([key, group]) => <section key={key}>
      <h2 className="mb-2 text-xs font-medium text-muted-foreground">{group.label}</h2>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
        {group.items.map((item) => <LibraryCard key={item.page.id} item={item} onOpen={() => onSelect(item.page.id)} />)}
      </ul>
    </section>)}</div> : null}
    {nextOffset !== null ? <div className={`pb-5 ${inPanel ? "px-3" : "px-5"}`}><button type="button" className={`h-8 rounded-md border border-border px-3 text-sm hover:bg-state-hover ${focusRing}`} onClick={() => void load(nextOffset)}>Load more</button></div> : null}
  </main>;
}

/** Nav panel at /plugins/pages/pages. `/<pageId>` or `?page=<pageId>` opens one page. */
export function LibraryPanel({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const linked = subPath.split("/")[0] || new URLSearchParams(window.location.search).get("page") || "";
  return <Library
    selectedId={UUID.test(linked) ? linked.toLowerCase() : null}
    onSelect={(pageId) => navigate.toPluginPanel(LIBRARY_PATH, pageId ? { subPath: pageId } : undefined)}
  />;
}
