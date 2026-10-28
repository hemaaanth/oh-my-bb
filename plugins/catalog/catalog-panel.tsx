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
type Source = Overview["sources"][number];
type Bundle = Overview["bundles"][number];
type SourceDraft = Pick<Source, "name" | "repositoryUrl" | "gitRef" | "subdirectory" | "updatePolicy" | "enabled"> & { id?: string };
type BundleDraft = Pick<Bundle, "name" | "description" | "skillIds"> & { id?: string };
type Mapping = Executor["mappings"][number];
const labelClass = "grid min-w-0 gap-1.5 text-sm";
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
const sourceFields = ({ name, repositoryUrl, gitRef, subdirectory, updatePolicy, enabled }: SourceDraft) => ({ name, repositoryUrl, gitRef, subdirectory, updatePolicy, enabled });
const bundleFields = ({ name, description, skillIds }: BundleDraft) => ({ name, description, skillIds });
type EditorExit = { onClose: () => void; onCloseAutoFocus: (event: Event) => void };

function useEditorOpen(onClose: () => void) {
  const [open, setOpen] = useState(true);
  // Commit native closed state before removing the editor, so the drawer restores focus.
  useEffect(() => { if (!open) onClose(); }, [open, onClose]);
  return [open, setOpen] as const;
}

function SourceEditor({ initial, onSave, onClose, onCloseAutoFocus }: { initial: SourceDraft; onSave: (draft: SourceDraft, expected: SourceDraft) => Promise<Source> } & EditorExit) {
  const [open, setOpen] = useEditorOpen(onClose);
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  const baseline = useRef(initial);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const update = (value: Partial<SourceDraft>) => { revision.current++; setDraft((current) => ({ ...current, ...value })); };
  async function save(event: FormEvent) {
    event.preventDefault();
    const submitted = revision.current;
    setSaving(true); setError(null);
    try {
      const saved = await onSave(draft, baseline.current);
      if (!mounted.current) return;
      baseline.current = saved;
      if (revision.current === submitted) setOpen(false);
      else setDraft((current) => ({ ...current, id: saved.id }));
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setSaving(false); }
  }
  return <Dialog open={open} onOpenChange={setOpen}><DialogContent onCloseAutoFocus={onCloseAutoFocus} className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>{draft.id ? "Edit source" : "Add source"}</DialogTitle><DialogDescription>Subscribe to an HTTPS Git repository. Weekly checks are opt-in.</DialogDescription></DialogHeader>
    <form className="grid min-w-0 gap-4" onSubmit={(event) => void save(event)}>
      <label className={labelClass}>Name<Input required maxLength={100} value={draft.name} onChange={(event) => update({ name: event.target.value })} /></label>
      <label className={labelClass}>Repository URL<Input required type="url" placeholder="https://github.com/example/skills.git" value={draft.repositoryUrl} onChange={(event) => update({ repositoryUrl: event.target.value })} /></label>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 9rem), 1fr))" }}><label className={labelClass}>Git ref<Input required value={draft.gitRef} onChange={(event) => update({ gitRef: event.target.value })} /></label><label className={labelClass}>Subdirectory<Input placeholder="skills" value={draft.subdirectory} onChange={(event) => update({ subdirectory: event.target.value })} /></label></div>
      <label className={labelClass}>Updates<Select value={draft.updatePolicy} onValueChange={(value) => update({ updatePolicy: value as SourceDraft["updatePolicy"] })}><SelectTrigger aria-label="Source update policy"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="automatic">Automatic</SelectItem><SelectItem value="review">Require approval</SelectItem></SelectContent></Select></label>
      <label className="flex min-w-0 items-center justify-between gap-3 text-sm"><span>Check this source weekly</span><Switch aria-label="Check this source weekly" checked={draft.enabled} onCheckedChange={(enabled) => update({ enabled })} /></label>
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      <DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save source"}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}

function BundleEditor({ initial, skills, onSave, onClose, onCloseAutoFocus }: { initial: BundleDraft; skills: Overview["skills"]; onSave: (draft: BundleDraft, expected: BundleDraft) => Promise<Bundle> } & EditorExit) {
  const [open, setOpen] = useEditorOpen(onClose);
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  const baseline = useRef(initial);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const update = (value: Partial<BundleDraft>) => { revision.current++; setDraft((current) => ({ ...current, ...value })); };
  async function save(event: FormEvent) {
    event.preventDefault(); const submitted = revision.current; setSaving(true); setError(null);
    try {
      const saved = await onSave(draft, baseline.current);
      if (!mounted.current) return;
      baseline.current = saved;
      if (revision.current === submitted) setOpen(false); else setDraft((current) => ({ ...current, id: saved.id }));
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setSaving(false); }
  }
  return <Dialog open={open} onOpenChange={setOpen}><DialogContent onCloseAutoFocus={onCloseAutoFocus} className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>{draft.id ? "Edit custom set" : "Create custom set"}</DialogTitle><DialogDescription>Choose approved skills. Source sets keep their own membership.</DialogDescription></DialogHeader>
    <form className="grid min-w-0 gap-4" onSubmit={(event) => void save(event)}>
      <label className={labelClass}>Name<Input required maxLength={100} value={draft.name} onChange={(event) => update({ name: event.target.value })} /></label>
      <label className={labelClass}>Description<Textarea value={draft.description} onChange={(event) => update({ description: event.target.value })} /></label>
      <fieldset className="max-h-64 min-w-0 space-y-2 overflow-y-auto rounded-md border border-border p-3"><legend className="px-1 text-sm">Skills</legend>
        {skills.filter((skill) => skill.enabled || draft.skillIds.includes(skill.id)).map((skill) => <label key={skill.id} className="flex min-w-0 items-start gap-2 text-sm"><Checkbox className="mt-1 shrink-0" checked={draft.skillIds.includes(skill.id)} onCheckedChange={(checked) => update({ skillIds: checked === true ? [...draft.skillIds, skill.id] : draft.skillIds.filter((id) => id !== skill.id) })} /><span className="min-w-0 break-words"><span className="block font-medium">{skill.name}</span><span className="text-xs text-muted-foreground">{skill.sourceName}</span></span></label>)}
        {!skills.length && <p className="text-sm text-muted-foreground">Sync a source to add skills.</p>}
      </fieldset>
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      <DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save set"}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
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
  return <Dialog open={open} onOpenChange={setOpen}><DialogContent onCloseAutoFocus={onCloseAutoFocus} className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>Assign Executor toolkits</DialogTitle><DialogDescription>The first toolkit is the default. Executor keeps the connections and approval rules.</DialogDescription></DialogHeader>
    <form className="grid min-w-0 gap-4" onSubmit={(event) => void save(event)} onChange={() => { revision.current++; }}>
      <label className={labelClass}>Scope<Select value={scope} disabled={initial.toolkits.length > 0} onValueChange={(value) => { revision.current++; setScope(value as Mapping["scope"]); setTargetId(value === "global" ? "*" : ""); }}><SelectTrigger aria-label="Toolkit scope"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="global">Every project</SelectItem><SelectItem value="project">One project</SelectItem><SelectItem value="agent" disabled={!agentsEnabled}>Agents profile</SelectItem><SelectItem value="plugin">Plugin backend</SelectItem></SelectContent></Select></label>
      {scope === "project" ? <label className={labelClass}>Project<Select value={targetId} disabled={initial.toolkits.length > 0} onValueChange={(id) => { revision.current++; setTargetId(id); }}><SelectTrigger className="min-w-0" aria-label="Toolkit project"><SelectValue placeholder="Choose a project" /></SelectTrigger><SelectContent style={projectMenuStyle}>{projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent></Select></label> : scope !== "global" ? <label className={labelClass}>{scope === "agent" ? "Agents profile ID" : "Plugin ID"}<Input required readOnly={initial.toolkits.length > 0} value={targetId} onChange={(event) => setTargetId(event.target.value)} /></label> : null}
      <label className={labelClass}>Toolkits<Textarea placeholder={"first-toolkit\nsecond-toolkit"} value={slugs} onChange={(event) => setSlugs(event.target.value)} /><span className="text-xs text-muted-foreground">One name per line. Clear the list to remove this assignment.</span></label>
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      <DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={saving || (scope !== "global" && !targetId)}>{saving ? "Saving…" : "Save toolkits"}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}

export function CatalogPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Overview | null>(null);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [executor, setExecutor] = useState<Executor | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceDraft, setSourceDraft] = useState<SourceDraft | null>(null);
  const [bundleDraft, setBundleDraft] = useState<BundleDraft | null>(null);
  const [mappingDraft, setMappingDraft] = useState<Mapping | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [freshConfirmed, setFreshConfirmed] = useState(false);
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
      const [next, prefs, configuration] = await Promise.all([rpc.call("catalogOverview"), rpc.call("preferences"), rpc.call("executorConfiguration")]);
      if (sequence.current !== current) return;
      setData(next); setPreferences(prefs); setExecutor(configuration); setError(null);
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
  async function loadAssignments() {
    setBusy(true); setError(null);
    try { const snapshot = await rpc.call("snapshot"); setData((current) => current ? { ...current, assignments: snapshot.assignments } : current); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const skillsBySource = useMemo(() => {
    const result = new Map<string, Overview["skills"]>();
    for (const skill of data?.skills ?? []) result.set(skill.sourceId, [...(result.get(skill.sourceId) ?? []), skill]);
    return result;
  }, [data?.skills]);
  const assignmentTargets = [{ id: "*", name: "Every project", kind: "global" as const }, ...(data?.targets ?? []).filter((target) => target.kind === "project")];
  return <div ref={settingsRoot} className="min-w-0 space-y-6" data-catalog-settings="">
    {error && <div role="alert" className="min-w-0 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"><p className="break-words text-destructive">{error}</p><Button className="mt-2" size="sm" variant="outline" disabled={loading} onClick={() => void load()}>Retry</Button></div>}
    {loading && <p role="status" className="text-sm text-muted-foreground">Loading Executor…</p>}
    {data && <>
      <SettingsSection title="Sources" help="Git repositories that supply your skills." action={<Button size="sm" variant="outline" onClick={(event) => { editorTrigger.current = event.currentTarget; setSourceDraft({ name: "", repositoryUrl: "", gitRef: "main", subdirectory: "", updatePolicy: "review", enabled: false }); }}><Icon name="Plus" />Add source</Button>}>
        <SettingsList items={data.sources} label="sources">{source => <div key={source.id} className="min-w-0 py-3">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2"><div className="min-w-0 flex-1 basis-48"><p className="break-words text-sm font-medium">{source.name}</p><p className="truncate text-xs text-muted-foreground" title={source.repositoryUrl}>{source.repositoryUrl.replace(/^https?:\/\//, "").replace(/\.git$/, "")}</p><p className="mt-0.5 truncate text-xs text-muted-foreground" title={`${source.gitRef} / ${source.subdirectory}`}>{source.gitRef}{source.subdirectory ? ` / ${source.subdirectory}` : ""} · Weekly checks {source.enabled ? "on" : "off"}</p></div><div className="flex shrink-0 items-center gap-1"><Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => rpc.call("syncSource", { id: source.id }))}>Sync</Button><RowAction label={`Edit ${source.name}`} icon="Edit" onClick={event => { editorTrigger.current = event.currentTarget; setSourceDraft(source); }} /><RowAction label={`Remove ${source.name}`} icon="Trash2" disabled={busy} onClick={() => void run(() => rpc.call("deleteSource", { id: source.id }))} /></div></div>
          {source.lastError && <p className="mt-2 break-words text-xs text-destructive">{source.lastError}</p>}
          {source.pendingRevision && <div className="mt-2 flex flex-wrap items-center gap-2"><p className="min-w-0 break-all text-xs text-warning-text">Update awaiting approval · {source.pendingRevision.slice(0, 12)}</p><Button size="sm" disabled={busy} onClick={() => void run(() => rpc.call("approveSource", { id: source.id }))}>Approve revision</Button></div>}
          <div className="mt-2"><details className="min-w-0"><summary className="cursor-pointer text-sm">Skills · {(skillsBySource.get(source.id) ?? []).filter((skill) => skill.enabled).length} on</summary><div className="mt-2 max-h-72 space-y-2 overflow-y-auto">{(skillsBySource.get(source.id) ?? []).map((skill) => <label key={skill.id} className="flex min-w-0 items-start justify-between gap-3 text-sm"><span className="min-w-0 break-words"><span className="block font-medium">{skill.name}</span><span className="text-xs text-muted-foreground">{skill.description}</span></span><Switch className="mt-1 shrink-0" aria-label={`Enable ${skill.name}`} checked={skill.enabled} disabled={busy} onCheckedChange={(enabled) => void run(() => rpc.call("setSkillsEnabled", { skillIds: [skill.id], enabled }))} /></label>)}</div></details></div>
        </div>}</SettingsList>
      </SettingsSection>
      <SettingsSection title="Capability sets" help="Choose where skills and plugin tools are available." action={<Button size="sm" variant="outline" onClick={(event) => { editorTrigger.current = event.currentTarget; setBundleDraft({ name: "", description: "", skillIds: [] }); }}><Icon name="Plus" />Create custom set</Button>}>
        <SettingsList items={data.bundles} label="sets">{bundle => <div key={bundle.id} className="min-w-0 py-3"><div className="flex min-w-0 flex-wrap items-center justify-between gap-2"><div className="min-w-0 flex-1 basis-48"><p className="break-words text-sm font-medium">{bundle.name}</p><p className="text-xs text-muted-foreground">{bundle.nativeCapability ? `${bundle.nativeCapability.toolIds.length} tools · ${bundle.nativeCapability.skillIds.length} skills` : `${bundle.skillIds.length} skills`}{bundle.sourceId ? " · From source" : bundle.nativeCapability ? " · Plugin" : " · Custom"}</p>{!bundle.sourceId && bundle.description && <p className="mt-0.5 text-xs text-muted-foreground">{bundle.description}</p>}</div>{!bundle.sourceId && !bundle.nativeCapability && <div className="flex items-center gap-1"><RowAction label={`Edit ${bundle.name}`} icon="Edit" onClick={event => { editorTrigger.current = event.currentTarget; setBundleDraft(bundle); }} /><RowAction label={`Remove ${bundle.name}`} icon="Trash2" disabled={busy} onClick={() => void run(() => rpc.call("deleteBundle", { id: bundle.id }))} /></div>}</div><div className="mt-2"><details className="min-w-0"><summary className="cursor-pointer text-sm">Project availability</summary><div className="mt-3 space-y-2">{data.assignments === null ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void loadAssignments()}>Load assignments</Button> : assignmentTargets.map((target) => <label key={target.id} className="flex min-w-0 items-start gap-2 text-sm"><Checkbox className="mt-1 shrink-0" disabled={busy} checked={data.assignments!.some((assignment) => assignment.bundleId === bundle.id && assignment.kind === target.kind && assignment.targetId === target.id)} onCheckedChange={(enabled) => void run(() => rpc.call("setAssignment", { bundleId: bundle.id, kind: target.kind, targetId: target.id, enabled: enabled === true }))} /><span className="min-w-0 break-words">{target.name}</span></label>)}</div></details></div></div>}</SettingsList>
      </SettingsSection>
      <SettingsSection title="Executor toolkits" help="Service connections available to each project." action={<Button size="sm" variant="outline" disabled={!executor?.configured} onClick={(event) => { editorTrigger.current = event.currentTarget; setMappingDraft({ scope: "global", targetId: "*", toolkits: [] }); }}><Icon name="Plus" />Assign toolkits</Button>}>
        {!executor?.configured && <p className="text-sm text-muted-foreground">Add the Executor URL and API key in Configuration.</p>}
        <div className={boxClass}>{executor?.mappings.map(mapping => <div key={`${mapping.scope}:${mapping.targetId}`} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-3"><div className="min-w-0 flex-1 basis-48"><p className="text-sm" title={mapping.targetId}>{mapping.scope === "global" ? "Every project" : mapping.scope === "agent" ? "Agent profile" : mapping.scope === "plugin" ? `Plugin · ${mapping.targetId}` : data.targets.find(target => target.id === mapping.targetId)?.name ?? "Project (missing)"}{mapping.scope === "agent" && <span className="ml-2 text-xs text-muted-foreground">{mapping.targetId.slice(0, 8)}</span>}</p><div className="mt-1 flex flex-wrap gap-1">{mapping.toolkits.map(toolkit => <span key={toolkit} className="min-w-0 break-all rounded border border-border/60 px-1.5 py-0.5 text-xs text-muted-foreground">{toolkit}</span>)}</div></div><RowAction label={`Edit toolkits for ${mapping.scope === "global" ? "every project" : data.targets.find(target => target.id === mapping.targetId)?.name ?? mapping.targetId}`} icon="Edit" onClick={event => { editorTrigger.current = event.currentTarget; setMappingDraft(mapping); }} /></div>)}
          <div className="py-3"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm">Connection check</p><p className="mt-0.5 text-xs text-muted-foreground">Contacts Executor only when you run it.</p></div><Button size="sm" variant="outline" disabled={busy || !executor?.configured} onClick={() => void run(async () => { setDiagnostics(await rpc.call("executorOverview", null)); })}>Check Executor</Button></div>{diagnostics?.error && <p role="alert" className="mt-2 break-words text-xs text-destructive">{diagnostics.error}</p>}{diagnostics?.warnings.map(warning => <p key={warning} className="mt-2 break-words text-xs text-warning-text">{warning}</p>)}{diagnostics && !diagnostics.error && !diagnostics.warnings.length && <p className="mt-2 text-xs text-muted-foreground">No connection or policy warnings.</p>}</div>
        </div>
      </SettingsSection>
      <SettingsSection title="More"><div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface-recessed/70 p-3"><div><p className="text-sm">Setup guide</p><p className="mt-0.5 text-xs text-muted-foreground">Sources, assignments, and other harnesses.</p></div><Button size="sm" variant="outline" onClick={event => { editorTrigger.current = event.currentTarget; setSetupOpen(true); }}>Open setup guide</Button></div></SettingsSection>
    </>}
    {sourceDraft && <SourceEditor initial={sourceDraft} onCloseAutoFocus={restoreEditorFocus} onClose={() => setSourceDraft(null)} onSave={async (draft, expected) => { const saved = await rpc.call("saveSource", { ...(draft.id ? { id: draft.id, expected: sourceFields(expected) } : {}), ...sourceFields(draft) }); await load(); return saved; }} />}
    {bundleDraft && data && <BundleEditor initial={bundleDraft} skills={data.skills} onCloseAutoFocus={restoreEditorFocus} onClose={() => setBundleDraft(null)} onSave={async (draft, expected) => { const saved = await rpc.call("saveBundle", { ...(draft.id ? { id: draft.id, expected: bundleFields(expected) } : {}), ...bundleFields(draft) }); await load(); return saved; }} />}
    {mappingDraft && data && <ToolkitEditor initial={mappingDraft} mappings={executor?.mappings ?? []} projects={data.targets} agentsEnabled={preferences?.agentsIntegration ?? false} onCloseAutoFocus={restoreEditorFocus} onClose={() => setMappingDraft(null)} onSave={async (mapping, expectedToolkits) => { await rpc.call("setExecutorToolkits", { ...mapping, expectedToolkits }); await load(); }} />}
    <Dialog open={setupOpen} onOpenChange={setSetupOpen}>{setupOpen && <DialogContent onCloseAutoFocus={restoreEditorFocus} className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>Executor setup guide</DialogTitle><DialogDescription>Connect services and make skills available to projects.</DialogDescription></DialogHeader><div className="space-y-4 text-sm"><ol className="list-decimal space-y-2 pl-5"><li>Add the Executor URL and API key in Configuration.</li><li>Assign toolkits to the projects that need their service connections.</li><li>Add a skill source, sync it, and approve any pending revision.</li><li>Choose a capability set’s project availability to enable its skills or tools.</li></ol>{data && <><div className="space-y-2"><h3 className="font-medium">Assignments</h3><p className="text-muted-foreground">{data.assignmentState.state === "uninitialized" ? "Assignments are not initialized. If you are migrating an existing installation, retain and transfer its assignments before continuing." : `Assignment status: ${data.assignmentState.state}.`}</p>{data.assignmentState.state === "uninitialized" && <><label className="flex items-start gap-2"><Checkbox className="mt-1 shrink-0" checked={freshConfirmed} onCheckedChange={checked => setFreshConfirmed(checked === true)} /><span>I confirm this is a new installation with no existing assignments.</span></label><Button size="sm" variant="outline" disabled={busy || !freshConfirmed} onClick={() => void run(() => rpc.call("initializeAssignmentsV1", { confirmation: "no-legacy-assignments" }))}>Initialize standalone assignments</Button></>}</div><div className="space-y-2"><h3 className="font-medium">Other harnesses</h3>{data.harnesses.map(harness => <p key={harness.id} className="break-words text-xs text-muted-foreground"><span className="font-medium text-foreground">{harness.name}: </span>{harness.detail}</p>)}</div></>}<p className="text-xs text-muted-foreground">Use <code>bb catalog</code> for command-line management. Credentials stay on the server; approve requested actions in the thread.</p></div><DialogFooter><Button variant="outline" onClick={() => setSetupOpen(false)}>Done</Button></DialogFooter></DialogContent>}</Dialog>

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
  return <SettingsSection title="Oh My BB"><div className={boxClass}><label className="flex items-center justify-between gap-3 py-3"><span className="min-w-0"><span className="block text-sm">Agents</span><span className="mt-0.5 block text-xs text-muted-foreground">Assign toolkits to Agents profiles.</span></span><Switch aria-label="Assign toolkits to Agents profiles" disabled={busy || !preferences} checked={preferences?.agentsIntegration ?? false} onCheckedChange={agentsIntegration => { setBusy(true); setError(null); void rpc.call("updatePreferences", { agentsIntegration }).then(setPreferences, () => setError("Could not save integration settings.")).finally(() => setBusy(false)); }} /></label></div>{error && <p role="alert" className="text-xs text-destructive">{error}</p>}</SettingsSection>;
}
