import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type FormEvent } from "react";
import { useRealtime, useRpc, type PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";
import { Checkbox } from "./components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Switch } from "./components/ui/switch";
import { Textarea } from "./components/ui/textarea";

type Overview = PluginRpcResult<(typeof rpcContract)["catalogOverview"]>;
type Preferences = PluginRpcResult<(typeof rpcContract)["preferences"]>;
type Executor = PluginRpcResult<(typeof rpcContract)["executorConfiguration"]>;
type Diagnostics = PluginRpcResult<(typeof rpcContract)["executorOverview"]>;
type Bundle = Overview["bundles"][number];
type Connection = Diagnostics["connections"][number];
type Mapping = Executor["mappings"][number];
const labelClass = "grid min-w-0 gap-1.5 text-sm";
const countLabel = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const boxClass = "min-w-0 divide-y divide-border/60 rounded-md border border-border bg-surface-recessed/70 px-3";
function SettingsSection({ title, help, action, children }: { title: string; help?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="min-w-0 space-y-4"><div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0"><h2 className="text-sm font-medium">{title}</h2>{help && <p className="mt-1 text-xs text-muted-foreground">{help}</p>}</div>{action}</div>{children}</section>;
}
function RowAction({ label, icon, onClick, disabled = false }: { label: string; icon: "Edit" | "Trash2"; onClick: (event: React.MouseEvent<HTMLButtonElement>) => void; disabled?: boolean }) {
  return <span title={label}><Button size="icon" variant="ghost" className="size-8 shrink-0" aria-label={label} disabled={disabled} onClick={onClick}><Icon name={icon} className="size-4" /></Button></span>;
}
function SettingsList<T extends { id: string; name: string }>({ items, label, children }: { items: T[]; label: string; children: (item: T) => ReactNode }) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const matches = items.filter(item => item.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="min-w-0 space-y-2">{items.length > 6 && <Input aria-label={`Search ${label}`} placeholder={`Search ${label}…`} value={query} onChange={event => setQuery(event.target.value)} className="h-8" />}<div className={boxClass}>{(expanded || query.trim() ? matches : matches.slice(0, 6)).map(children)}{!matches.length && <p className="py-3 text-sm text-muted-foreground">No {label} found.</p>}</div>{!query.trim() && items.length > 6 && <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>{expanded ? "Show fewer" : `Show all ${items.length} ${label}`}</Button>}</div>;
}
const projectMenuStyle = { maxWidth: "var(--radix-select-content-available-width)", overflowWrap: "anywhere" } as const;
type EditorExit = { onClose: () => void; onCloseAutoFocus: (event: Event) => void };

function useEditorOpen(onClose: () => void) {
  const [open, setOpen] = useState(true);
  // Commit native closed state before removing the editor, so the drawer restores focus.
  useEffect(() => { if (!open) onClose(); }, [open, onClose]);
  return [open, setOpen] as const;
}

function ToolkitEditor({ initial, mappings, projects, agentsEnabled, onSave, onClose, onCloseAutoFocus }: { initial: Mapping; mappings: Mapping[]; projects: Overview["targets"]; agentsEnabled: boolean; onSave: (mapping: Mapping, expected: string[]) => Promise<void> } & EditorExit) {
  const [open, setOpen] = useEditorOpen(onClose);
  const [scope, setScope] = useState(initial.scope);
  const [targetId, setTargetId] = useState(initial.targetId);
  const [slugs, setSlugs] = useState(initial.toolkits.join("\n"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  const baselines = useRef<Map<string, string[]> | null>(null);
  if (!baselines.current) baselines.current = new Map(mappings.map((mapping) => [`${mapping.scope}:${mapping.targetId}`, mapping.toolkits]));
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); const submitted = revision.current; setSaving(true); setError(null);
    try {
      const mapping = { scope, targetId: scope === "global" ? "*" : targetId, toolkits: slugs.split(/\s+/u).filter(Boolean) };
      const key = `${mapping.scope}:${mapping.targetId}`;
      await onSave(mapping, baselines.current!.get(key) ?? []);
      baselines.current!.set(key, [...new Set(mapping.toolkits)]);
      if (mounted.current && submitted === revision.current) setOpen(false);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setSaving(false); }
  }
  return <Dialog open={open} onOpenChange={setOpen}><DialogContent onCloseAutoFocus={onCloseAutoFocus} className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>Assign Executor connections</DialogTitle><DialogDescription>The first connection is the default. Executor keeps the apps, accounts, and approval rules.</DialogDescription></DialogHeader>
    <form className="grid min-w-0 gap-4" onSubmit={(event) => void save(event)} onChange={() => { revision.current++; }}>
      <label className={labelClass}>Scope<Select value={scope} disabled={initial.toolkits.length > 0} onValueChange={(value) => { revision.current++; setScope(value as Mapping["scope"]); setTargetId(value === "global" ? "*" : ""); }}><SelectTrigger aria-label="Connection scope"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="global">Every project</SelectItem><SelectItem value="project">One project</SelectItem><SelectItem value="agent" disabled={!agentsEnabled}>Agents profile</SelectItem><SelectItem value="plugin">Plugin backend</SelectItem></SelectContent></Select></label>
      {scope === "project" ? <label className={labelClass}>Project<Select value={targetId} disabled={initial.toolkits.length > 0} onValueChange={(id) => { revision.current++; setTargetId(id); }}><SelectTrigger className="min-w-0" aria-label="Connection project"><SelectValue placeholder="Choose a project" /></SelectTrigger><SelectContent style={projectMenuStyle}>{projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent></Select></label> : scope !== "global" ? <label className={labelClass}>{scope === "agent" ? "Agents profile ID" : "Plugin ID"}<Input required readOnly={initial.toolkits.length > 0} value={targetId} onChange={(event) => setTargetId(event.target.value)} /></label> : null}
      <label className={labelClass}>Connections<Textarea placeholder={"first-connection\nsecond-connection"} value={slugs} onChange={(event) => setSlugs(event.target.value)} /><span className="text-xs text-muted-foreground">One connection ID per line. Clear the list to remove this assignment.</span></label>
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      <DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={saving || (scope !== "global" && !targetId)}>{saving ? "Saving…" : "Save connections"}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}

/** Opens the sign-in tab before the RPC answers, so a popup blocker does not stop it. */
async function openSignIn(start: () => Promise<{ url: string }>) {
  const tab = window.open("", "_blank");
  try {
    const { url } = await start();
    if (tab) { tab.opener = null; tab.location.href = url; } else window.location.assign(url);
  } catch (cause) { tab?.close(); throw cause; }
}

export function CatalogPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Overview | null>(null);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [executor, setExecutor] = useState<Executor | null>(null);
  const [connections, setConnections] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mappingDraft, setMappingDraft] = useState<Mapping | null>(null);
  const [availabilityBundle, setAvailabilityBundle] = useState<Bundle | null>(null);
  const [availabilityAssignments, setAvailabilityAssignments] = useState<PluginRpcResult<(typeof rpcContract)["snapshot"]>["assignments"] | null>(null);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const availabilitySequence = useRef(0);
  const [setupOpen, setSetupOpen] = useState(false);
  const sequence = useRef(0);
  const settingsRoot = useRef<HTMLDivElement | null>(null);
  const editorTrigger = useRef<HTMLButtonElement | null>(null);
  function restoreEditorFocus(event: Event) {
    const invoking = editorTrigger.current;
    const target = invoking?.isConnected && !invoking.disabled ? invoking : settingsRoot.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    if (target) { event.preventDefault(); target.focus(); }
  }
  const load = useCallback(async () => {
    const current = ++sequence.current; setLoading(true);
    try {
      const [next, prefs, configuration, overview] = await Promise.all([rpc.call("catalogOverview"), rpc.call("preferences"), rpc.call("executorConfiguration"), rpc.call("executorOverview")]);
      if (sequence.current !== current) return;
      setData(next); setPreferences(prefs); setExecutor(configuration); setConnections(overview); setError(null);
    } catch (cause) { if (sequence.current === current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (sequence.current === current) setLoading(false); }
  }, [rpc]);
  useEffect(() => { void load(); return () => { sequence.current++; }; }, [load]);
  useRealtime("catalog-changed", () => { void load(); });
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await action(); await load(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { setBusy(false); }
  }
  async function readAvailability(sequence: number) {
    setAvailabilityError(null);
    try { const snapshot = await rpc.call("snapshot"); if (sequence === availabilitySequence.current) setAvailabilityAssignments(snapshot.assignments); }
    catch { if (sequence === availabilitySequence.current) setAvailabilityError("Could not load project availability. Try again."); }
  }
  function connect(connection: Connection) {
    setBusy(true); setError(null);
    void openSignIn(() => rpc.call("connectStart", { connection: connection.id, redirectOrigin: window.location.origin }))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  }
  const skillsByApp = useMemo(() => {
    const result = new Map<string, Overview["skills"]>();
    for (const skill of data?.skills ?? []) result.set(skill.sourceName, [...(result.get(skill.sourceName) ?? []), skill]);
    return [...result.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data?.skills]);
  const native = (data?.bundles ?? []).filter((bundle) => bundle.nativeCapability);
  const scopeName = (mapping: Mapping) => mapping.scope === "global" ? "Every project" : mapping.scope === "agent" ? "Agent profile" : mapping.scope === "plugin" ? `Plugin · ${mapping.targetId}` : data?.targets.find(target => target.id === mapping.targetId)?.name ?? "Project (missing)";
  const assignmentTargets = [{ id: "*", name: "Every project", kind: "global" as const }, ...(data?.targets ?? []).filter((target) => target.kind === "project")];
  return <div ref={settingsRoot} className="min-w-0 space-y-6" data-catalog-settings="">
    {error && <div role="alert" className="min-w-0 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"><p className="break-words text-destructive">{error}</p><Button className="mt-2" size="sm" variant="outline" disabled={loading} onClick={() => void load()}>Retry</Button></div>}
    {loading && !data && <p role="status" className="text-sm text-muted-foreground">Loading Executor…</p>}
    {data && <>
      <SettingsSection title="Connections" help="Each connection is a scoped set of Executor apps and accounts. BB signs in to each one once." action={<Button size="sm" variant="outline" disabled={!executor?.configured} onClick={(event) => { editorTrigger.current = event.currentTarget; setMappingDraft({ scope: "global", targetId: "*", toolkits: [] }); }}><Icon name="Plus" />Assign connections</Button>}>
        {!executor?.configured && <p className="text-sm text-muted-foreground">Add the Executor URL in Configuration.</p>}
        {connections?.error && <p role="alert" className="break-words text-xs text-destructive">{connections.error}</p>}
        {executor?.configured && <SettingsList items={(connections?.connections ?? []).map(connection => ({ ...connection, name: connection.id }))} label="connections">{connection => <div key={connection.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-3"><div className="min-w-0 flex-1 basis-48"><p className="break-all text-sm font-medium">{connection.id}</p><p className="text-xs text-muted-foreground">{connection.connected ? "Signed in" : <span className="text-warning-text">Not signed in</span>} · {connection.assignedTo.join(", ") || "Unassigned"}</p></div>{connection.connected
          ? <Button size="sm" variant="outline" disabled={busy} aria-label={`Sign out of ${connection.id}`} onClick={() => void run(() => rpc.call("disconnect", { connection: connection.id }))}>Sign out</Button>
          : <Button size="sm" disabled={busy} aria-label={`Sign in to ${connection.id}`} onClick={() => connect(connection)}>Sign in</Button>}</div>}</SettingsList>}
        {!!executor?.mappings.length && <div className={boxClass}>{executor.mappings.map(mapping => <div key={`${mapping.scope}:${mapping.targetId}`} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-3"><div className="min-w-0 flex-1 basis-48"><p className="text-sm" title={mapping.targetId}>{scopeName(mapping)}{mapping.scope === "agent" && <span className="ml-2 text-xs text-muted-foreground">{mapping.targetId.slice(0, 8)}</span>}</p><div className="mt-1 flex flex-wrap gap-1">{mapping.toolkits.map(toolkit => <span key={toolkit} className="min-w-0 break-all rounded border border-border/60 px-1.5 py-0.5 text-xs text-muted-foreground">{toolkit}</span>)}</div></div><RowAction label={`Edit connections for ${scopeName(mapping)}`} icon="Edit" onClick={event => { editorTrigger.current = event.currentTarget; setMappingDraft(mapping); }} /></div>)}</div>}
      </SettingsSection>
      <SettingsSection title="Skills" help="Executor apps ship these skills. Add or change them in Executor; BB copies them into each project's skill folders.">
        {data.skillsError && <p role="alert" className="break-words text-xs text-destructive">{data.skillsError}</p>}
        {skillsByApp.length ? <div className={boxClass}>{skillsByApp.map(([app, skills]) => <details key={app} className="min-w-0 py-3"><summary className="cursor-pointer text-sm">{app} · {countLabel(skills.length, "skill")}</summary><div role="region" aria-label={`${app} skills`} tabIndex={0} className="mt-2 max-h-72 space-y-2 overflow-y-auto" style={{ scrollbarGutter: "stable" }}>{skills.map(skill => <div key={skill.id} className="min-w-0 text-sm"><span className="block truncate font-medium" title={skill.name}>{skill.name}</span><span className="block truncate text-xs text-muted-foreground" title={skill.description}>{skill.description}</span></div>)}</div></details>)}</div>
          : <p className="text-sm text-muted-foreground">No skills yet. Add a skills app in Executor and include it in a connection.</p>}
      </SettingsSection>
      {native.length > 0 && <SettingsSection title="Plugin capabilities" help="Tools and skills other BB plugins provide. Choose which projects can use them.">
        <SettingsList items={native} label="capabilities">{bundle => <div key={bundle.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-3"><div className="min-w-0 flex-1 basis-48"><p className="break-words text-sm font-medium">{bundle.name}</p><p className="text-xs text-muted-foreground">{countLabel(bundle.nativeCapability!.toolIds.length, "tool")} · {countLabel(bundle.nativeCapability!.skillIds.length, "skill")} · Provided by {bundle.nativeCapability!.pluginId}</p>{bundle.description && <p className="truncate text-xs text-muted-foreground" title={bundle.description}>{bundle.description}</p>}</div><Button size="sm" variant="outline" aria-label={`Projects for ${bundle.name}`} onClick={event => {
          editorTrigger.current = event.currentTarget;
          setAvailabilityBundle(bundle); setAvailabilityAssignments(null);
          void readAvailability(++availabilitySequence.current);
        }}>Projects</Button></div>}</SettingsList>
      </SettingsSection>}
      <SettingsSection title="More"><div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface-recessed/70 p-3"><div><p className="text-sm">Setup guide</p><p className="mt-0.5 text-xs text-muted-foreground">Connections, sign-in, skills, and other harnesses.</p></div><Button size="sm" variant="outline" onClick={event => { editorTrigger.current = event.currentTarget; setSetupOpen(true); }}>Open setup guide</Button></div></SettingsSection>
    </>}
    {mappingDraft && data && <ToolkitEditor initial={mappingDraft} mappings={executor?.mappings ?? []} projects={data.targets} agentsEnabled={preferences?.agentsIntegration ?? false} onCloseAutoFocus={restoreEditorFocus} onClose={() => setMappingDraft(null)} onSave={async (mapping, expectedToolkits) => { await rpc.call("setExecutorToolkits", { ...mapping, expectedToolkits }); await load(); }} />}
    <Dialog open={availabilityBundle !== null} onOpenChange={open => { if (!open) { availabilitySequence.current++; setAvailabilityBundle(null); } }}>{availabilityBundle && <DialogContent onCloseAutoFocus={restoreEditorFocus} className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>Projects</DialogTitle><DialogDescription>{availabilityBundle.name} · Choose which projects can use this capability. Changes apply as you select.</DialogDescription></DialogHeader>
      {availabilityError && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{availabilityError}</p><Button size="sm" variant="outline" onClick={() => void readAvailability(availabilitySequence.current)}>Retry</Button></div>}
      {availabilityAssignments === null ? !availabilityError && <p role="status" className="text-sm text-muted-foreground">Loading projects…</p> : <div className="max-h-[50dvh] overflow-y-auto rounded-md border border-border px-3" style={{ scrollbarGutter: "stable" }}>{assignmentTargets.map(target => <label key={target.id} className="flex min-w-0 items-center gap-3 border-b border-border/60 py-3 text-sm last:border-0"><Checkbox disabled={busy} checked={availabilityAssignments.some(assignment => assignment.bundleId === availabilityBundle.id && assignment.kind === target.kind && assignment.targetId === target.id)} onCheckedChange={enabled => {
        const bundleId = availabilityBundle.id, sequence = availabilitySequence.current;
        setBusy(true); setAvailabilityError(null);
        void rpc.call("setAssignment", { bundleId, kind: target.kind, targetId: target.id, enabled: enabled === true }).then(() => readAvailability(sequence), () => { if (sequence === availabilitySequence.current) setAvailabilityError("Could not save project availability. Try again."); }).finally(() => setBusy(false));
      }} /><span className="min-w-0 break-words">{target.name}</span></label>)}</div>}
      <DialogFooter><Button variant="outline" onClick={() => { availabilitySequence.current++; setAvailabilityBundle(null); }}>Done</Button></DialogFooter>
    </DialogContent>}</Dialog>
    <Dialog open={setupOpen} onOpenChange={setSetupOpen}>{setupOpen && <DialogContent onCloseAutoFocus={restoreEditorFocus} className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>Executor setup guide</DialogTitle><DialogDescription>Connect Executor and make its apps and skills available to projects.</DialogDescription></DialogHeader><div className="space-y-4 text-sm"><ol className="list-decimal space-y-2 pl-5"><li>Add the Executor URL in Configuration. A personal access token is optional; it turns on account health alerts.</li><li>In Executor, create a connection for each group of apps and accounts. Its ID is the name BB uses.</li><li>Assign connections to every project, one project, an Agents profile, or a plugin backend.</li><li>Sign in to each connection. Executor asks you to approve BB once.</li><li>Skills come from skills apps in each connection. Change them in Executor.</li></ol>{data && <div className="space-y-2"><h3 className="font-medium">Other harnesses</h3>{data.harnesses.map(harness => <p key={harness.id} className="break-words text-xs text-muted-foreground"><span className="font-medium text-foreground">{harness.name}: </span>{harness.detail}</p>)}</div>}<p className="text-xs text-muted-foreground">Use <code>bb catalog</code> for command-line management. Grants stay on the BB server; approve requested actions in the thread.</p></div><DialogFooter><Button variant="outline" onClick={() => setSetupOpen(false)}>Done</Button></DialogFooter></DialogContent>}</Dialog>
  </div>;
}

export function CatalogIntegrationSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { void rpc.call("preferences").then(setPreferences, () => setError("Could not load integration settings.")); }, [rpc]);
  useEffect(load, [load]);
  useRealtime("catalog-changed", load);
  return <SettingsSection title="Oh My BB"><div className={boxClass}><label className="flex items-center justify-between gap-3 py-3"><span className="min-w-0"><span className="block text-sm">Agents</span><span className="mt-0.5 block text-xs text-muted-foreground">Assign connections to Agents profiles.</span></span><Switch aria-label="Assign connections to Agents profiles" disabled={busy || !preferences} checked={preferences?.agentsIntegration ?? false} onCheckedChange={agentsIntegration => { setBusy(true); setError(null); void rpc.call("updatePreferences", { agentsIntegration }).then(setPreferences, () => setError("Could not save integration settings.")).finally(() => setBusy(false)); }} /></label></div>{error && <p role="alert" className="text-xs text-destructive">{error}</p>}</SettingsSection>;
}
