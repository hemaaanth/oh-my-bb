import { useIntegrations } from "../hooks/useIntegrations";
import type { IntegrationPreferences } from "../integrations";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";

const rows: ReadonlyArray<{ key: keyof IntegrationPreferences; label: string; help: string }> = [
  { key: "agentsIntegration", label: "Agents", help: "Show Bots and Channels from the separately installed Agents plugin." },
  { key: "projectsIntegration", label: "Projects", help: "Use Projects groups and project order instead of local sidebar groups." },
  { key: "tasksIntegration", label: "Tasks", help: "Add Attach to task to thread menus. Tasks owns provider setup." },
];

export function IntegrationSettings() {
  const { data, error, saving, load, save } = useIntegrations();
  return <section className="space-y-4">
    <h2 className="text-sm font-medium text-foreground">Oh My BB</h2>
    {data?.migrationPending ? <p role="status" className="text-sm text-muted-foreground">Saved integration preferences are preserved. Reload Status Sidebar once from the plugin menu to finish moving these controls out of Configuration.</p> : !data ? <div className="text-sm">
      {error ? <><p role="alert" className="text-destructive-text">{error}</p><Button size="sm" variant="outline" className="mt-2" onClick={load}>Retry</Button></> : <p role="status" className="text-muted-foreground">Loading integrations…</p>}
    </div> : <>
      <div className="divide-y divide-border/60 rounded-md border border-border bg-surface-recessed/70 px-3">
        {rows.map(({ key, label, help }) => {
          const id = `status-sidebar-${key}`;
          return <div key={key} className="flex items-center justify-between gap-4 py-3">
            <div className="min-w-0 flex-1"><label htmlFor={id} className="text-sm">{label}</label><p id={`${id}-help`} className="mt-0.5 text-xs leading-snug text-muted-foreground">{help}</p></div>
            <Switch id={id} aria-describedby={`${id}-help`} checked={data.values[key]} disabled={saving} onCheckedChange={(value) => { void save({ [key]: value }); }} />
          </div>;
        })}
      </div>
      {error ? <p role="alert" className="text-xs text-destructive-text">{error}</p> : null}
    </>}
  </section>;
}
