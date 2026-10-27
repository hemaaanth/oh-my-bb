import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, useRealtime, useRpc, type PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
// Type-only from ./contract: its zod schemas stay out of the frontend bundle.
import type { ProjectGroupColor, rpcContract } from "./contract";
import { projectGroupColors } from "./group-colors";
import { ProjectRouterBanner } from "./project-router-ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Snapshot = PluginRpcResult<(typeof rpcContract)["snapshot"]>;
type Organization = PluginRpcResult<(typeof rpcContract)["organizationSnapshot"]>;
type Preferences = PluginRpcResult<(typeof rpcContract)["preferences"]>;
type Project = Organization["projects"][number];
type Reference = Snapshot["agents"][number];
const integrationRows = [
  ["catalogIntegration", "Catalog", "bundles"],
  ["credentialsIntegration", "Credentials", "applicationBindings"],
  ["agentsIntegration", "Agents", "agentPreferences"],
  ["sidebarIntegration", "Status Sidebar", null],
  ["tasksIntegration", "Task Workspaces", null],
] as const;
const colors: readonly ProjectGroupColor[] = projectGroupColors;
const groupColorClass: Record<ProjectGroupColor, string> = {
  amber: "bg-warning",
  blue: "bg-timeline-accent",
  violet: "bg-primary",
  green: "bg-success",
  rose: "bg-destructive",
  gray: "bg-muted-foreground",
};
const controlClass = "h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring";
const primaryButtonClass = "inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50";

function repositoryLabel(project: Project) {
  return project.gitRemoteUrl?.replace(/^https?:\/\/[^/]+\//u, "").replace(/^git@[^:]+:/u, "").replace(/\.git$/u, "")
    ?? project.localPath
    ?? "No repository source";
}

export function ProjectsPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Organization | null>(null);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [assignmentData, setAssignmentData] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
  const [groupColor, setGroupColor] = useState<ProjectGroupColor>("violet");
  const [freshConfirmed, setFreshConfirmed] = useState(false);
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const sequence = useRef(0);
  const optionsSequence = useRef(0);

  const load = useCallback(async () => {
    const request = ++sequence.current;
    const [next, nextPreferences] = await Promise.all([rpc.call("organizationSnapshot"), rpc.call("preferences")]);
    if (request !== sequence.current) return;
    setData(next);
    setPreferences(nextPreferences);
  }, [rpc]);
  useEffect(() => { void load().catch((cause) => setError(String(cause))); return () => { sequence.current++; optionsSequence.current++; }; }, [load]);
  useRealtime("projects-configuration-changed", () => { void load().catch((cause) => setError(String(cause))); });

  async function run(action: () => Promise<unknown>, message?: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      if (message) toast.success(message);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally { setBusy(false); }
  }

  async function loadAssignments() {
    const request = ++optionsSequence.current;
    const current = await rpc.call("snapshot");
    if (request !== optionsSequence.current) return;
    setAssignmentData(current);
    const failures: string[] = [];
    await Promise.all(integrationRows.map(async ([key, label, kind]) => {
      if (!kind || !preferences?.[key]) return;
      try {
        const { references } = await rpc.call("assignmentOptionsV1", { kind });
        if (request !== optionsSequence.current) return;
        const field = kind === "bundles" ? "bundles" : kind === "applicationBindings" ? "credentials" : "agents";
        setAssignmentData((previous) => previous ? { ...previous, [field]: [...references, ...previous[field].filter((reference) => !references.some(({ id }) => id === reference.id))] } : previous);
      } catch (cause) { failures.push(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`); }
    }));
    if (request === optionsSequence.current && failures.length) setError(failures.join("\n"));
  }

  async function saveDraft(key: string, value: string, action: () => Promise<unknown>) {
    if (await run(action)) setDrafts((current) => {
      if (current[key] !== value) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  const projectsByGroup = useMemo(() => new Map((data?.groups ?? []).map((group) => [
    group.id, data!.projects.filter((project) => project.groupId === group.id),
  ])), [data]);
  const ready = data?.assignmentStatus.every(({ state }) => state !== "not-migrated") ?? false;
  const writable = (kind: "bundles" | "applicationBindings" | "agentPreferences") => {
    const state = data?.assignmentStatus.find((status) => status.kind === kind)?.state;
    return state === "source-owned" || state === "destination-owned";
  };

  return <div className="mx-auto w-full max-w-[760px] space-y-6 px-4 pb-6 [overflow-wrap:anywhere]">
    <div className={`min-h-6 whitespace-pre-wrap text-sm ${error ? "text-destructive" : "text-muted-foreground"}`} role={error ? "alert" : "status"}>
      {error ?? (!data ? "Loading projects…" : null)}
      {error && <button type="button" className="ml-2 underline" onClick={() => void run(load)}>Retry</button>}
    </div>
    <section className="space-y-3">
      <h2 className="text-base font-semibold">Project groups</h2>
      {data?.groups.map((group) => <div key={group.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border p-3">
        <span className={`size-2.5 shrink-0 rounded-full ${groupColorClass[group.color]}`} aria-hidden />
        <input aria-label={`${group.name} group name`} className={`${controlClass} min-w-0 flex-1`} value={drafts[`group:${group.id}`] ?? group.name}
          onChange={(event) => setDrafts((current) => ({ ...current, [`group:${group.id}`]: event.target.value }))}
          onBlur={(event) => { const value = event.target.value; if (value.trim() && value !== group.name) void saveDraft(`group:${group.id}`, value, () => rpc.call("saveGroup", { id: group.id, name: value.trim(), color: group.color })); }} />
        <Select value={group.color} disabled={busy} onValueChange={(color) => void run(() => rpc.call("saveGroup", { id: group.id, name: drafts[`group:${group.id}`]?.trim() || group.name, color: color as ProjectGroupColor }))}>
          <SelectTrigger aria-label={`${group.name} group color`} className="w-28"><SelectValue /></SelectTrigger>
          <SelectContent>{colors.map((color) => <SelectItem key={color} value={color}>{color}</SelectItem>)}</SelectContent>
        </Select>
        {!group.isDefault && <button className="text-sm text-destructive" disabled={busy} onClick={() => { if (window.confirm(`Delete ${group.name}? Its projects will move to the default group.`)) void run(() => rpc.call("deleteGroup", { id: group.id })); }}>Delete</button>}
      </div>)}
      <form className="flex flex-wrap gap-2" onSubmit={(event) => {
        event.preventDefault();
        const draft = groupName;
        if (draft.trim()) void run(() => rpc.call("saveGroup", { name: draft.trim(), color: groupColor })).then((saved) => { if (saved) setGroupName((current) => current === draft ? "" : current); });
      }}>
        <input aria-label="New group name" className={`${controlClass} min-w-[10rem] flex-1`} placeholder="New group name" value={groupName} maxLength={80} onChange={(event) => setGroupName(event.target.value)} />
        <Select value={groupColor} disabled={!data} onValueChange={(color) => setGroupColor(color as ProjectGroupColor)}>
          <SelectTrigger aria-label="New group color" className="w-28"><SelectValue /></SelectTrigger>
          <SelectContent>{colors.map((color) => <SelectItem key={color} value={color}>{color}</SelectItem>)}</SelectContent>
        </Select>
        <button className={primaryButtonClass} disabled={busy || !data || !groupName.trim()}>Add group</button>
      </form>
    </section>

    <fieldset className="min-w-0 space-y-3 rounded-lg border border-border p-4">
      <legend className="px-1 text-sm font-medium">Preferences</legend>
      {preferences && <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); const value = modelDraft; if (value?.trim()) void run(() => rpc.call("updatePreferences", { routingModel: value.trim() })).then((saved) => { if (saved) setModelDraft((current) => current === value ? null : current); }); }}>
        <label className="grid min-w-0 flex-1 gap-1 text-sm">Project profile model
          <input className={`${controlClass} min-w-0 w-full`} value={modelDraft ?? preferences.routingModel} onChange={(event) => setModelDraft(event.target.value)} />
        </label>
        <button className={controlClass} disabled={busy || !modelDraft?.trim()}>Save</button>
      </form>}
    </fieldset>

    <section className="space-y-3">
      <h2 className="text-sm font-medium">Oh My BB</h2>
      <div className="divide-y divide-border rounded-lg border border-border px-3">
        {integrationRows.map(([key, label]) => <label key={key} className="flex items-center justify-between gap-3 py-3 text-sm">
          <span className="min-w-0">{label}</span>
          <input type="checkbox" checked={preferences?.[key] ?? false} disabled={busy || !preferences} onChange={(event) => {
            optionsSequence.current++;
            setAssignmentData(null);
            void run(() => rpc.call("updatePreferences", { [key]: event.target.checked }));
          }} />
        </label>)}
      </div>
      {ready && integrationRows.some(([key, , kind]) => kind && preferences?.[key]) && <button className={controlClass} disabled={busy} onClick={() => void run(loadAssignments)}>Load assignment choices</button>}
      {!ready && data && <div className="space-y-3 rounded-lg border border-border p-3">
        <p role="status" className="text-sm">Assignments are not migrated. Projects and groups work without them. Import existing assignments before using Catalog, Credentials or Agents assignment readers.</p>
        <button className={controlClass} disabled={busy} onClick={() => void run(() => rpc.call("importLegacyFromSourcesV1"), "Legacy assignments imported")}>Import legacy assignments</button>
        <details className="text-sm">
          <summary className="cursor-pointer">New installation with no legacy assignments</summary>
          <label className="my-3 flex items-start gap-2"><input type="checkbox" checked={freshConfirmed} onChange={(event) => setFreshConfirmed(event.target.checked)} /><span>I verified that no sibling has legacy assignments to import. Unavailable or unknown data is not empty data.</span></label>
          <button className={`${controlClass} h-auto min-h-9 py-2`} disabled={busy || !freshConfirmed} onClick={() => void run(() => rpc.call("initializeFreshV1", { confirmation: "no-legacy-assignments" }))}>Initialize without legacy assignments</button>
        </details>
      </div>}
      {data?.assignmentStatus.filter(({ state }) => state !== "source-owned" && state !== "not-migrated").map(({ kind, state }) => <p key={kind} className="text-sm" role="status">{kind}: {state}. {state !== "destination-owned" && "Writes are frozen. Resume the recorded handoff."}</p>)}
      {assignmentData && <div className="grid gap-4">
        {preferences?.agentsIntegration && <ReferenceChecklist title="Agents available everywhere" references={assignmentData.agents} checked={new Set(assignmentData.globalAgentIds)} busy={busy || !writable("agentPreferences")} onToggle={(targetId, enabled) => run(async () => { await rpc.call("setGlobalAgent", { targetId, enabled }); await loadAssignments(); })} />}
        {preferences?.catalogIntegration && <ReferenceChecklist title="Skills available everywhere" references={assignmentData.bundles} checked={new Set(assignmentData.globalBundleIds)} busy={busy || !writable("bundles")} onToggle={(targetId, enabled) => run(async () => { await rpc.call("setGlobalBundle", { targetId, enabled }); await loadAssignments(); })} />}
      </div>}
    </section>

    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Projects</h2>
        <button className={`${controlClass} h-auto min-h-9 py-2`} aria-describedby="routing-refresh-consequence" disabled={busy || !data?.routingConfigured} onClick={() => void run(() => rpc.call("generateMissingRoutingProfiles"))}>Refresh stale generated profiles</button>
      </div>
      <p id="routing-refresh-consequence" className="text-sm text-muted-foreground">Creates missing profiles and replaces stale generated profiles. Manual profiles stay unchanged. Uses the saved model and may incur cost.</p>
      {data?.groups.map((group) => <div key={group.id} className="space-y-3">
        <h3 className="text-sm font-medium">{group.name}</h3>
        {(projectsByGroup.get(group.id) ?? []).map((project) => {
          const assignment = assignmentData?.projects.find(({ id }) => id === project.id);
          return <article key={project.id} className="min-w-0 rounded-lg border border-border p-3">
            <h4 className="text-base font-semibold">{project.icon && `${project.icon} `}{project.name}</h4>
            <p className="mt-1 break-all text-xs text-muted-foreground">{repositoryLabel(project)}</p>
            <div className="mt-3 grid min-w-0 gap-3">
              <label className="grid min-w-0 gap-1 text-sm">Group
                <Select value={project.groupId ?? ""} disabled={busy} onValueChange={(groupId) => void run(() => rpc.call("setProjectGroup", { projectId: project.id, groupId }))}>
                  <SelectTrigger className="w-full min-w-0"><SelectValue /></SelectTrigger>
                  <SelectContent>{data.groups.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.name}</SelectItem>)}</SelectContent>
                </Select>
              </label>
              <label className="grid min-w-0 gap-1 text-sm">Icon
                <input className={`${controlClass} min-w-0 w-full`} value={drafts[`icon:${project.id}`] ?? project.icon} onChange={(event) => setDrafts((current) => ({ ...current, [`icon:${project.id}`]: event.target.value }))} onBlur={(event) => { const value = event.target.value; if (value !== project.icon) void saveDraft(`icon:${project.id}`, value, () => rpc.call("updateProject", { projectId: project.id, icon: value.trim() })); }} />
              </label>
              {assignment && preferences?.credentialsIntegration && <label className="grid min-w-0 gap-1 text-sm">Credentials
                <Select value={assignment.credentialId === null ? "none" : `profile:${assignment.credentialId}`} disabled={busy || !writable("applicationBindings")} onValueChange={(selection) => void run(async () => { await rpc.call("updateProject", { projectId: project.id, credentialId: selection === "none" ? null : selection.slice("profile:".length) }); await loadAssignments(); })}>
                  <SelectTrigger className="w-full min-w-0"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="none">No credentials</SelectItem>{assignmentData!.credentials.map((credential) => <SelectItem key={credential.id} value={`profile:${credential.id}`}>{credential.name}</SelectItem>)}</SelectContent>
                </Select>
              </label>}
              {assignment && preferences?.agentsIntegration && <ReferenceChecklist title="Additional agents" references={assignmentData!.agents.filter(({ id }) => !assignmentData!.globalAgentIds.includes(id))} checked={new Set(assignment.agentIds)} busy={busy || !writable("agentPreferences")} onToggle={(targetId, enabled) => run(async () => { await rpc.call("setProjectAgent", { projectId: project.id, targetId, enabled }); await loadAssignments(); })} />}
              {assignment && preferences?.catalogIntegration && <ReferenceChecklist title="Additional skills" references={assignmentData!.bundles.filter(({ id }) => !assignmentData!.globalBundleIds.includes(id))} checked={new Set(assignment.bundleIds)} busy={busy || !writable("bundles")} onToggle={(targetId, enabled) => run(async () => { await rpc.call("setProjectBundle", { projectId: project.id, targetId, enabled }); await loadAssignments(); })} />}
            </div>
            <details className="mt-4"><summary className="cursor-pointer text-sm">Routing profile</summary>
              <RoutingProfileEditor project={project} busy={busy} configured={data.routingConfigured} onSave={(profile) => run(() => rpc.call("updateRoutingProfile", { projectId: project.id, ...profile }))} onGenerate={() => run(() => rpc.call("generateRoutingProfile", { projectId: project.id }))} />
            </details>
          </article>;
        })}
      </div>)}
      {data?.projects.length === 0 && <p className="text-sm text-muted-foreground">No native projects. Create one from BB's project menu.</p>}
    </section>
    <details className="rounded-lg border border-border p-3 text-sm">
      <summary className="cursor-pointer font-medium">More</summary>
      <div className="mt-3 space-y-2">
        <p>Authentication keys stay in native Configuration. Reload Projects once after upgrading to finish moving the profile model to Preferences.</p>
        <p>Legacy import contacts Status Sidebar, Credentials, Catalog and Agents only when you request it. If a source is unavailable, restore that source and retry. Do not initialize unknown legacy data as empty.</p>
        <p>Optional sources are off until enabled. Load assignment choices explicitly. Missing choices retain their saved IDs.</p>
      </div>
    </details>
  </div>;
}

function lines(value: string): string[] {
  return value.split(/\r?\n|,/u).map((item) => item.trim()).filter(Boolean);
}

function RoutingProfileEditor({ project, busy, configured, onSave, onGenerate }: {
  project: Project;
  busy: boolean;
  configured: boolean;
  onSave: (profile: { description: string; keywords: string[]; aliases: string[]; repositories: string[]; notFor: string[] }) => Promise<unknown>;
  onGenerate: () => Promise<unknown>;
}) {
  const [description, setDescription] = useState(project.routingProfile.description);
  const [keywords, setKeywords] = useState(project.routingProfile.keywords.join("\n"));
  const [aliases, setAliases] = useState(project.routingProfile.aliases.join("\n"));
  const [repositories, setRepositories] = useState(project.routingProfile.repositories.join("\n"));
  const [notFor, setNotFor] = useState(project.routingProfile.notFor.join("\n"));
  const dirty = useRef(false);
  const draftRevision = useRef(0);

  useEffect(() => {
    if (dirty.current) return;
    setDescription(project.routingProfile.description);
    setKeywords(project.routingProfile.keywords.join("\n"));
    setAliases(project.routingProfile.aliases.join("\n"));
    setRepositories(project.routingProfile.repositories.join("\n"));
    setNotFor(project.routingProfile.notFor.join("\n"));
  }, [project.id, project.routingProfile]);

  const canSave = Boolean(description.trim());
  return (
    <div className="mt-4 min-w-0 space-y-4" onChange={() => { dirty.current = true; draftRevision.current++; }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h5 className="text-sm font-medium">Intelligent routing profile</h5>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
              {project.routingProfile.source === "none" ? "Not generated" : project.routingProfile.source === "manual" ? "Edited" : "Generated"}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <button className={`${controlClass} hover:bg-secondary disabled:opacity-50`} disabled={busy || !configured} onClick={() => void onGenerate()}>
            {project.routingProfile.source === "none" ? "Generate" : "Regenerate"}
          </button>
          <button
            className={primaryButtonClass}
            disabled={busy || !canSave}
            onClick={() => {
              const revision = draftRevision.current;
              void onSave({ description: description.trim(), keywords: lines(keywords), aliases: lines(aliases), repositories: lines(repositories), notFor: notFor.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean) }).then((saved) => {
                if (saved && draftRevision.current === revision) dirty.current = false;
              });
            }}
          >Save profile</button>
        </div>
      </div>
      <div className="mt-4 grid min-w-0 gap-4">
        <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">What this project is for
          <textarea className={`${controlClass} min-h-24 resize-y py-2`} placeholder="A qualitative description of the product, domain, and work that belongs here." value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">Keywords
          <textarea className={`${controlClass} min-h-28 resize-y py-2`} placeholder={"One phrase per line\ncustomer portal\nbilling"} value={keywords} onChange={(event) => setKeywords(event.target.value)} />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">Names and aliases
          <textarea className={`${controlClass} min-h-28 resize-y py-2`} placeholder={"One name per line\nproduct nickname\nteam abbreviation"} value={aliases} onChange={(event) => setAliases(event.target.value)} />
        </label>
        <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">Repositories and linked task sources
          <textarea className={`${controlClass} min-h-20 resize-y py-2`} placeholder={"owner/repository\nLinear · Project name"} value={repositories} onChange={(event) => setRepositories(event.target.value)} />
        </label>
        <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">Not for
          <textarea className={`${controlClass} min-h-20 resize-y py-2`} placeholder={"Requests that mention this project but belong elsewhere, one per line\nUsing the product for unrelated work\nQuestions about past threads"} value={notFor} onChange={(event) => setNotFor(event.target.value)} />
        </label>
        <div className="grid min-w-0 gap-1 text-xs text-muted-foreground">
          <span>Learned from your routing history{project.routingProfile.learnedAt ? ` · updated ${new Date(project.routingProfile.learnedAt).toLocaleDateString()}` : ""}</span>
          {project.routingProfile.learnedFor.length || project.routingProfile.learnedNotFor.length ? (
            <div className="grid gap-2 rounded-md border border-border px-3 py-2 text-foreground">
              {project.routingProfile.learnedFor.length ? <p><span className="text-muted-foreground">Belongs here: </span>{project.routingProfile.learnedFor.join(" · ")}</p> : null}
              {project.routingProfile.learnedNotFor.length ? <p><span className="text-muted-foreground">Not here: </span>{project.routingProfile.learnedNotFor.join(" · ")}</p> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ReferenceChecklist({ title, references, checked, busy, onToggle, empty = "Nothing is available yet." }: {
  title: string; references: Reference[]; checked: ReadonlySet<string>; busy: boolean;
  onToggle: (id: string, enabled: boolean) => Promise<unknown>; empty?: string;
}) {
  return (
    <div className="space-y-3">
      <h5 className="text-sm font-medium">{title}</h5>
      <div className="space-y-1">
        {references.map((reference) => (
          <label key={reference.id} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-secondary/60">
            <input type="checkbox" className="mt-0.5 size-4" checked={checked.has(reference.id)} disabled={busy} onChange={(event) => void onToggle(reference.id, event.target.checked)} />
            <span className="min-w-0"><span className="block break-words text-sm">{reference.name}</span>{reference.detail && <span className="block break-words text-xs text-muted-foreground">{reference.detail}</span>}</span>
          </label>
        ))}
        {references.length === 0 && <p className="text-xs text-muted-foreground">{empty}</p>}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "jev-project-router",
    scopes: ["new-thread"],
    banners: [{ id: "project-suggestion", chrome: "bare", component: ProjectRouterBanner }],
  });
  app.slots.settingsSection({
    id: "projects",
    title: "Projects",
    component: ProjectsPanel,
  });
});
