export function MoreSettings() {
  return <section className="space-y-4">
    <h2 className="text-sm font-medium">More</h2>
    <details id="status-sidebar-setup" className="rounded-md border border-border bg-surface-recessed/70 p-3">
      <summary className="cursor-pointer text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Setup guide</summary>
      <div className="mt-4 space-y-5">
      <section className="space-y-3 text-sm">
        <h3 className="font-medium">Choose the sidebar</h3>
        <div className="space-y-2 rounded-md border border-border bg-surface-recessed/70 p-3">
          <p>Choose Status Sidebar in Settings → Appearance → Sidebar. This is a per-client choice. Installing the package does not rewrite your layout preferences.</p>
          <p className="text-muted-foreground">BB keeps its navigation rail, new-thread control, footer, split navigation, and thread actions. The sidebar is intentionally narrow, not a full-width app page.</p>
        </div>
      </section>
      <section className="space-y-3 text-sm">
        <h3 className="font-medium">Organize threads</h3>
        <div className="space-y-2 rounded-md border border-border bg-surface-recessed/70 p-3">
          <p>Right-click or long-press a section heading to choose Group by, Subgroup by, and Sort by. Status groups distinguish needs input, active, drafting, unread, idle, and Later. Pinned and archived threads keep their own groups.</p>
          <p className="text-muted-foreground">Needs input and active work take precedence over an unsent draft. A parent summary includes its children. Expand a parent with its chevron. Manual sort enables drag ordering. Numbered keyboard targets follow the visible top-level rows.</p>
          <p className="text-muted-foreground">Right-click a thread for BB's native actions and Move to later. Opening a menu does not change the thread. Ctrl-click or Command-click opens a split. Shift-click and middle-click retain the link's native behavior.</p>
        </div>
      </section>
      <section className="space-y-3 text-sm">
        <h3 className="font-medium">Optional integrations</h3>
        <div className="divide-y divide-border rounded-md border border-border bg-surface-recessed/70 px-3">
          <div className="py-3"><h4 className="font-medium">Agents</h4><p className="mt-1 text-muted-foreground">Enable Agents under Oh My BB in plugin settings to add Bots and Channels. Agent rows open the canonical DM through Agents. Agents-owned threads are excluded from Code only while this integration is enabled and its snapshot is available.</p></div>
          <div className="py-3"><h4 className="font-medium">Projects</h4><p className="mt-1 text-muted-foreground">Enable Projects to use its existing groups and project order. Otherwise, local sidebar groups remain available. Changing this toggle does not migrate, delete, or merge either set of groups. Existing IDs, assignments, and orders stay stored. If Projects is unavailable, an error is shown and the current client snapshot stays visible.</p></div>
          <div className="py-3"><h4 className="font-medium">Tasks</h4><p className="mt-1 text-muted-foreground">Enable Tasks to add Attach to task to thread menus. Search runs only after you enter a query. Attachment runs only when you select a task. Tasks owns the credentials and provider setup.</p></div>
        </div>
        <p className="text-muted-foreground">All integrations are off by default. Install and configure their owner separately. Status Sidebar never installs, enables, or probes a sibling at startup. Native BB thread and machine data need no sibling plugin.</p>
      </section>
      <details className="rounded-md border border-border bg-surface-recessed/70 p-3 text-sm"><summary className="cursor-pointer font-medium">Saved state and privacy</summary><p className="mt-2 text-muted-foreground">Later markers, local groups, assignments, and ordering stay in private plugin storage. Grouping and collapse preferences stay in this client's browser storage. No migration reads private history, copies credentials, or changes BB's native list preferences. Disabling an integration retains its saved data.</p></details>
      </div>
    </details>
  </section>;
}
