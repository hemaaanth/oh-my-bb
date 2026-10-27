import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRealtime, useRpc, type PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
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
const cardGrid = { gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 18rem), 1fr))" };
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
      <label className={labelClass}>Toolkit slugs<Textarea placeholder={"first-toolkit\nsecond-toolkit"} value={slugs} onChange={(event) => setSlugs(event.target.value)} /><span className="text-xs text-muted-foreground">One per line. An empty list removes this mapping.</span></label>
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
  const [preferencesOpen, setPreferencesOpen] = useState(false);
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
    <div className="flex flex-wrap items-center justify-end gap-2"><Button variant="outline" disabled={!preferences} onClick={(event) => { editorTrigger.current = event.currentTarget; setPreferencesOpen(true); }}>Preferences</Button></div>
    {error && <div role="alert" className="min-w-0 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"><p className="break-words text-destructive">{error}</p><Button className="mt-2" size="sm" variant="outline" disabled={loading} onClick={() => void load()}>Retry</Button></div>}
    {loading && <p role="status" className="text-sm text-muted-foreground">Loading Executor…</p>}
    {data && <>
      <section className="min-w-0 space-y-3" aria-labelledby="catalog-sources-title"><div className="flex flex-wrap items-center justify-between gap-2"><h2 id="catalog-sources-title" className="text-sm font-semibold">Sources</h2><Button size="sm" variant="outline" onClick={(event) => { editorTrigger.current = event.currentTarget; setSourceDraft({ name: "", repositoryUrl: "", gitRef: "main", subdirectory: "", updatePolicy: "review", enabled: false }); }}>Add source</Button></div>
        {!data.sources.length && <p className="text-sm text-muted-foreground">No sources. Add an HTTPS Git repository when you need one.</p>}
        <div className="grid min-w-0 gap-3" style={cardGrid}>{data.sources.map((source) => <Card key={source.id} className="min-w-0"><CardHeader className="pb-3"><CardTitle className="break-words text-base">{source.name}</CardTitle><p className="break-all text-xs text-muted-foreground">{source.repositoryUrl}</p><p className="break-words text-xs text-muted-foreground">{source.gitRef}{source.subdirectory ? ` / ${source.subdirectory}` : ""} · {source.enabled ? "Weekly checks on" : "Weekly checks off"}</p></CardHeader><CardContent className="min-w-0 space-y-3">
          {source.lastError && <p className="break-words text-sm text-destructive">{source.lastError}</p>}
          {source.pendingRevision && <p className="break-all text-xs text-warning-text">Revision {source.pendingRevision.slice(0, 12)} awaits review.</p>}
          <details className="min-w-0"><summary className="cursor-pointer text-sm">Skills · {(skillsBySource.get(source.id) ?? []).filter((skill) => skill.enabled).length} on</summary><div className="mt-2 max-h-72 space-y-2 overflow-y-auto">{(skillsBySource.get(source.id) ?? []).map((skill) => <label key={skill.id} className="flex min-w-0 items-start justify-between gap-3 text-sm"><span className="min-w-0 break-words"><span className="block font-medium">{skill.name}</span><span className="text-xs text-muted-foreground">{skill.description}</span></span><Switch className="mt-1 shrink-0" aria-label={`Enable ${skill.name}`} checked={skill.enabled} disabled={busy} onCheckedChange={(enabled) => void run(() => rpc.call("setSkillsEnabled", { skillIds: [skill.id], enabled }))} /></label>)}</div></details>
          <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => rpc.call("syncSource", { id: source.id }))}>Sync</Button>{source.pendingRevision && <Button size="sm" disabled={busy} onClick={() => void run(() => rpc.call("approveSource", { id: source.id }))}>Approve revision</Button>}<Button size="sm" variant="ghost" onClick={(event) => { editorTrigger.current = event.currentTarget; setSourceDraft(source); }}>Edit</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => rpc.call("deleteSource", { id: source.id }))}>Remove</Button></div>
        </CardContent></Card>)}</div>
      </section>
      <section className="min-w-0 space-y-3" aria-labelledby="catalog-sets-title"><div className="flex flex-wrap items-center justify-between gap-2"><h2 id="catalog-sets-title" className="text-sm font-semibold">Capability sets</h2><Button size="sm" variant="outline" onClick={(event) => { editorTrigger.current = event.currentTarget; setBundleDraft({ name: "", description: "", skillIds: [] }); }}>Create custom set</Button></div>
        {!data.bundles.length && <p className="text-sm text-muted-foreground">Sources add their own sets. Custom sets can mix approved skills.</p>}
        <div className="grid min-w-0 gap-3" style={cardGrid}>{data.bundles.map((bundle) => <Card key={bundle.id} className="min-w-0"><CardHeader className="pb-3"><CardTitle className="break-words text-base">{bundle.name}</CardTitle>{bundle.description && <p className="break-words text-sm text-muted-foreground">{bundle.description}</p>}</CardHeader><CardContent className="min-w-0 space-y-3"><p className="text-xs text-muted-foreground">{bundle.nativeCapability ? `${bundle.nativeCapability.toolIds.length} native tools · ${bundle.nativeCapability.skillIds.length} skills` : `${bundle.skillIds.length} skills`}</p>
          {!bundle.sourceId && !bundle.nativeCapability && <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={(event) => { editorTrigger.current = event.currentTarget; setBundleDraft(bundle); }}>Edit</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => rpc.call("deleteBundle", { id: bundle.id }))}>Remove</Button></div>}
          <details className="min-w-0"><summary className="cursor-pointer text-sm">Project availability</summary><div className="mt-3 space-y-2">{data.assignments === null ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void loadAssignments()}>Load assignments</Button> : assignmentTargets.map((target) => <label key={target.id} className="flex min-w-0 items-start gap-2 text-sm"><Checkbox className="mt-1 shrink-0" disabled={busy} checked={data.assignments!.some((assignment) => assignment.bundleId === bundle.id && assignment.kind === target.kind && assignment.targetId === target.id)} onCheckedChange={(enabled) => void run(() => rpc.call("setAssignment", { bundleId: bundle.id, kind: target.kind, targetId: target.id, enabled: enabled === true }))} /><span className="min-w-0 break-words">{target.name}</span></label>)}</div></details>
        </CardContent></Card>)}</div>
      </section>
      <section className="min-w-0 space-y-3" aria-labelledby="catalog-executor-title"><div className="flex flex-wrap items-center justify-between gap-2"><h2 id="catalog-executor-title" className="text-sm font-semibold">Executor toolkits</h2><Button size="sm" variant="outline" disabled={!executor?.configured} onClick={(event) => { editorTrigger.current = event.currentTarget; setMappingDraft({ scope: "global", targetId: "*", toolkits: [] }); }}>Assign toolkits</Button></div>
        {!executor?.configured && <p className="text-sm text-muted-foreground">Set the Executor URL and API key in native Configuration.</p>}
        {executor?.mappings.map((mapping) => <div key={`${mapping.scope}:${mapping.targetId}`} className="flex min-w-0 flex-wrap items-start justify-between gap-2 rounded-md border border-border p-3"><div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{mapping.scope === "global" ? "Every project" : data.targets.find((target) => target.id === mapping.targetId)?.name ?? `${mapping.scope}: ${mapping.targetId}`}</p><p className="break-all font-mono text-xs text-muted-foreground">{mapping.toolkits.join(" · ")}</p></div><Button size="sm" variant="outline" onClick={(event) => { editorTrigger.current = event.currentTarget; setMappingDraft(mapping); }}>Edit</Button></div>)}
        <details className="min-w-0"><summary className="cursor-pointer text-sm">Connection and policy checks</summary><div className="mt-3 space-y-3"><Button size="sm" variant="outline" disabled={busy || !executor?.configured} onClick={() => void run(async () => { setDiagnostics(await rpc.call("executorOverview", null)); })}>Check Executor</Button>{diagnostics?.error && <p role="alert" className="break-words text-sm text-destructive">{diagnostics.error}</p>}{diagnostics?.warnings.map((warning) => <p key={warning} className="break-words text-sm text-warning-text">{warning}</p>)}{diagnostics && !diagnostics.error && !diagnostics.warnings.length && <p className="text-sm text-muted-foreground">No connection or policy warnings.</p>}</div></details>
      </section>
      <details className="min-w-0 rounded-md border border-border p-3"><summary className="cursor-pointer text-sm font-medium">More</summary><div className="mt-4 min-w-0 space-y-4 text-sm"><div className="space-y-2"><h3 className="font-medium">Assignment readiness</h3><p className="break-words text-muted-foreground">Executor: {data.assignmentState.state}. Existing assignments require the source-first handoff. A missing source is not an empty source.</p>{data.assignmentState.state === "uninitialized" && <><label className="flex items-start gap-2"><Checkbox className="mt-1 shrink-0" checked={freshConfirmed} onCheckedChange={(checked) => setFreshConfirmed(checked === true)} /><span className="min-w-0 break-words">I confirm this is a new standalone installation with no legacy assignments.</span></label><Button size="sm" variant="outline" disabled={busy || !freshConfirmed} onClick={() => void run(() => rpc.call("initializeAssignmentsV1", { confirmation: "no-legacy-assignments" }))}>Initialize standalone assignments</Button></>}</div><div className="space-y-2"><h3 className="font-medium">Skills in other harnesses</h3>{data.harnesses.map((harness) => <p key={harness.id} className="break-words text-muted-foreground"><span className="font-medium text-foreground">{harness.name}: </span>{harness.detail}</p>)}</div><p className="break-words text-muted-foreground">Use <code>bb catalog</code> for source and assignment commands. Executor credentials stay on the server. Native approval cards are answered in the thread.</p></div></details>
    </>}
    {sourceDraft && <SourceEditor initial={sourceDraft} onCloseAutoFocus={restoreEditorFocus} onClose={() => setSourceDraft(null)} onSave={async (draft, expected) => { const saved = await rpc.call("saveSource", { ...(draft.id ? { id: draft.id, expected: sourceFields(expected) } : {}), ...sourceFields(draft) }); await load(); return saved; }} />}
    {bundleDraft && data && <BundleEditor initial={bundleDraft} skills={data.skills} onCloseAutoFocus={restoreEditorFocus} onClose={() => setBundleDraft(null)} onSave={async (draft, expected) => { const saved = await rpc.call("saveBundle", { ...(draft.id ? { id: draft.id, expected: bundleFields(expected) } : {}), ...bundleFields(draft) }); await load(); return saved; }} />}
    {mappingDraft && data && <ToolkitEditor initial={mappingDraft} mappings={executor?.mappings ?? []} projects={data.targets} agentsEnabled={preferences?.agentsIntegration ?? false} onCloseAutoFocus={restoreEditorFocus} onClose={() => setMappingDraft(null)} onSave={async (mapping, expectedToolkits) => { await rpc.call("setExecutorToolkits", { ...mapping, expectedToolkits }); await load(); }} />}
    <Dialog open={preferencesOpen} onOpenChange={setPreferencesOpen}><DialogContent onCloseAutoFocus={restoreEditorFocus}><DialogHeader><DialogTitle>Preferences</DialogTitle><DialogDescription>Optional sources. Saved choices stay in Executor.</DialogDescription></DialogHeader><section className="min-w-0 space-y-3"><h3 className="text-sm font-medium">Oh My BB</h3><label className="flex min-w-0 items-start justify-between gap-3"><span className="min-w-0 text-sm"><span className="block font-medium">Agents</span><span className="block break-words text-xs text-muted-foreground">Use Agents profile toolkit scopes. Off for a fresh installation; existing mapped-profile consent is retained.</span></span><Switch className="mt-1 shrink-0" aria-label="Use Agents profile toolkit scopes" disabled={busy || !preferences} checked={preferences?.agentsIntegration ?? false} onCheckedChange={(agentsIntegration) => void run(async () => { setPreferences(await rpc.call("updatePreferences", { agentsIntegration })); })} /></label></section><DialogFooter><Button variant="outline" onClick={() => setPreferencesOpen(false)}>Done</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
