import { useMemo, useState } from "react";
import { experimental_useSidebarThreads, useBbNavigate, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import "./sidebar.css";

const PER_PROJECT = 12;
const BUSY_STATUSES: Record<string, true> = { active: true, starting: true, stopping: true };

/** The host's sidebar thread objects carry the same BB IDs as traces_thread. */
export function TracesSidebar({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const [search, setSearch] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlyMap<string, number>>(new Map());
  const state = experimental_useSidebarThreads(showArchived ? { experimental_lifecycles: ["active", "archived"] } : undefined);
  const segments = subPath.split("/");
  const id = segments[0] === "context" ? segments[1] : segments[0];
  const selectedId = id && /^thr_[a-z0-9]+$/.test(id) ? id : null;
  const view = segments[0] === "metrics" || segments[0] === "context" || segments[0] === "explorer" ? segments[0]
    : selectedId || segments[0] === "waterfall" ? "waterfall" : "explorer";
  const fleetPath = view === "explorer" || view === "metrics" ? `${segments[1] ?? "_"}/${segments[2] ?? "24h"}` : "_/24h";
  const query = search.trim().toLocaleLowerCase();
  const groups = useMemo(() => {
    const matching = state.threads.filter((thread) => (showHidden || !thread.isHidden) && (showArchived || !thread.isArchived)
      && (!query || thread.displayTitle.toLocaleLowerCase().includes(query) || thread.id.toLocaleLowerCase().includes(query)));
    matching.sort((a, b) => Number(Object.hasOwn(BUSY_STATUSES, b.status)) - Number(Object.hasOwn(BUSY_STATUSES, a.status))
      || Math.max(b.updatedAt, b.latestAttentionAt) - Math.max(a.updatedAt, a.latestAttentionAt));
    const grouped = new Map<string, PluginSidebarThread[]>();
    for (const thread of matching) {
      const list = grouped.get(thread.projectId) ?? [];
      list.push(thread); grouped.set(thread.projectId, list);
    }
    return grouped;
  }, [state.threads, showHidden, showArchived, query]);
  const projects = new Map(state.projects.map((project) => [project.id, project.name]));
  const selectedVisible = selectedId === null || [...groups.values()].some((threads) => threads.some((thread) => thread.id === selectedId));
  const selectedThread = state.threads.find((thread) => thread.id === selectedId);
  const selectionNote = selectedVisible ? null : query && selectedThread && !selectedThread.displayTitle.toLocaleLowerCase().includes(query)
    && !selectedThread.id.toLocaleLowerCase().includes(query) ? "Selected thread does not match this search."
    : selectedThread?.isHidden && !showHidden ? "Selected thread is hidden. Enable Hidden to show it."
      : selectedThread?.isArchived && !showArchived ? "Selected thread is archived. Enable Archived to show it."
        : showArchived && state.experimental_archived?.status === "loading" ? "Loading archived threads…"
          : "Selected thread is unavailable in BB's sidebar list.";
  return <aside className="traces-sidebar" aria-label="Traces threads">
    <div className="traces-sidebar-search">
      <input type="search" value={search} onChange={(event) => setSearch(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape" && search) { event.preventDefault(); setSearch(""); } }}
        placeholder="Search threads" aria-label="Search Traces threads" />
      <nav className="traces-sidebar-views" aria-label="Traces views">
        <button type="button" aria-current={view === "explorer" ? "page" : undefined}
          onClick={() => navigate.toPluginPanel("waterfall", { subPath: view === "metrics" ? `explorer/${fleetPath}` : "" })}>Log Explorer</button>
        <button type="button" aria-current={view === "waterfall" ? "page" : undefined}
          onClick={() => navigate.toPluginPanel("waterfall", { subPath: selectedId ?? "waterfall" })}>Waterfall</button>
        <button type="button" aria-current={view === "context" ? "page" : undefined}
          onClick={() => navigate.toPluginPanel("waterfall", { subPath: selectedId ? `context/${selectedId}` : "context" })}>Context Inspector</button>
        <button type="button" aria-current={view === "metrics" ? "page" : undefined}
          onClick={() => navigate.toPluginPanel("waterfall", { subPath: `metrics/${fleetPath}` })}>Fleet Metrics</button>
      </nav>
    </div>
    <div className="traces-sidebar-groups">
      {state.status === "loading" && <p role="status">Loading BB threads…</p>}
      {state.status === "error" && <p role="alert">BB thread list unavailable.</p>}
      {state.status === "ready" && !groups.size && <p>{query ? "No matching threads." : "No threads in this view."}</p>}
      {state.status === "ready" && selectionNote && <p className="traces-sidebar-unlisted">{selectionNote}</p>}
      {[...groups].map(([projectId, threads]) => {
        const shown = threads.filter((thread, index) => index < (expanded.get(projectId) ?? (query ? 50 : PER_PROJECT)) || thread.id === selectedId);
        const omitted = threads.length - shown.length;
        return <section key={projectId} aria-label={projects.get(projectId) ?? projectId}>
          <h3>{projects.get(projectId) ?? projectId}<span>{threads.length}</span></h3>
          <ul>{shown.map((thread) => <li key={thread.id}><button type="button" aria-current={thread.id === selectedId ? "page" : undefined}
            aria-label={`${thread.displayTitle}, ${thread.id}${thread.isArchived ? ", archived" : ""}${thread.isHidden ? ", hidden" : ""}`}
            title={thread.displayTitle} onClick={() => navigate.toPluginPanel("waterfall", { subPath: thread.id })}>
            <span className="traces-sidebar-title">{thread.parentThreadId && <span aria-hidden="true">↳ </span>}{thread.displayTitle}</span>
            <small>{thread.id}{thread.isArchived ? " · archived" : thread.isHidden ? " · hidden" : Object.hasOwn(BUSY_STATUSES, thread.status) ? " · running" : ""}</small>
          </button></li>)}</ul>
          {omitted > 0 && <button type="button" className="traces-sidebar-more" onClick={() => setExpanded(new Map(expanded).set(projectId, shown.length + 50))}>Show {Math.min(50, omitted)} more</button>}
        </section>;
      })}
      {showArchived && state.experimental_archived?.status === "error" && <p role="alert">Archived threads unavailable.</p>}
      {showArchived && state.experimental_archived?.hasNextPage && <button type="button" className="traces-sidebar-more"
        disabled={state.experimental_archived.isFetchingNextPage} onClick={() => void state.experimental_archived?.fetchNextPage()}>
        {state.experimental_archived.isFetchingNextPage ? "Loading archived threads…" : "Load more archived threads"}</button>}
    </div>
    <div className="traces-sidebar-options">
      <label><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Archived</label>
      <label><input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} /> Hidden</label>
    </div>
  </aside>;
}
