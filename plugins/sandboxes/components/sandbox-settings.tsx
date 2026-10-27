import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { sandboxRpcContract } from "../src/contract.js";
import type { SandboxPreferences, SandboxPreferencesView } from "../src/settings-preferences.js";
import { sandboxIdleSleepOptions } from "../src/config.js";
import { formatSizeTier, sandboxSizeTierValues } from "../src/size-tiers.js";
import type { SandboxIntegration } from "../src/preferences.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Switch } from "./ui/switch.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.js";

const BOX = "min-w-0 rounded-md border border-border bg-card p-3";
const ROW = "flex min-w-0 items-center justify-between gap-4 py-3";
interface BuilderView { repository: string | null; savedRepository: string | null; source: "environment" | "preference" | "import" | "unconfigured"; imported: boolean }
const failureText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function SandboxPreferencesSettings() {
  const rpc = useRpc<typeof sandboxRpcContract>();
  const id = useId();
  const [data, setData] = useState<SandboxPreferencesView | null>(null);
  const [builder, setBuilder] = useState<BuilderView | null>(null);
  const [draft, setDraft] = useState<Partial<SandboxPreferences>>({});
  const [repositoryDraft, setRepositoryDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const savingRef = useRef(false);
  const load = useCallback(async () => {
    if (savingRef.current) return;
    const id = ++request.current;
    try {
      const [preferences, repository] = await Promise.all([rpc.call("preferences", null), rpc.call("imageBuildRepository", null)]);
      if (id === request.current) { setData(preferences); setBuilder(repository); setError(""); }
    } catch (failure) { if (id === request.current) setError(failureText(failure)); }
  }, [rpc]);
  useEffect(() => { void load(); return () => { request.current++; }; }, [load]);
  useRealtime("sandbox-preferences", useCallback(() => { void load(); }, [load]));
  const save = async (kind: "preferences" | "builder") => {
    savingRef.current = true; setSaving(true); setError(""); request.current++;
    try {
      if (kind === "preferences" && data) {
        const next = await rpc.call("updatePreferences", { expectedRevision: data.revision, values: draft });
        setData(next); setDraft({});
      } else {
        setBuilder(await rpc.call("saveImageBuildRepository", { repository: repositoryDraft ?? builder?.savedRepository ?? "" }));
        setRepositoryDraft(null);
      }
    } catch (failure) { setError(failureText(failure)); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const values = data ? { ...data.values, ...draft } : null;
  return <section className="min-w-0 space-y-3" aria-label="Sandboxes preferences">
    <h2 className="text-sm font-medium">Preferences</h2>
    {!values ? <div className={BOX}><p role={error ? "alert" : "status"} className="text-sm">{error || "Loading preferences…"}</p>{error && <Button variant="outline" size="sm" onClick={() => void load()}>Retry</Button>}</div> : <div className={BOX}>
      {data?.migrationPending && <p role="status" className="mb-3 text-sm text-muted-foreground">Saved preferences are preserved. Reload Sandboxes once to finish moving them out of Configuration.</p>}
      <fieldset disabled={saving || data?.migrationPending} className="min-w-0 divide-y divide-border">
        <div className="@container flex min-w-0 flex-col gap-2 py-3 @md:flex-row @md:items-center @md:justify-between">
          <label htmlFor={`${id}-idle`} className="text-sm">Auto-sleep after</label>
          <Select value={values.idleSleepAfter} onValueChange={value => setDraft(previous => ({ ...previous, idleSleepAfter: value as SandboxPreferences["idleSleepAfter"] }))}>
            <SelectTrigger id={`${id}-idle`} className="w-full min-w-0 @md:w-64"><SelectValue /></SelectTrigger>
            <SelectContent>{sandboxIdleSleepOptions.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="@container flex min-w-0 flex-col gap-2 py-3 @md:flex-row @md:items-center @md:justify-between">
          <label htmlFor={`${id}-size`} className="text-sm">Default size</label>
          <Select value={values.defaultSizeTier} onValueChange={value => setDraft(previous => ({ ...previous, defaultSizeTier: value as SandboxPreferences["defaultSizeTier"] }))}>
            <SelectTrigger id={`${id}-size`} className="w-full min-w-0 @md:w-64"><SelectValue /></SelectTrigger>
            <SelectContent>{sandboxSizeTierValues.map(value => <SelectItem key={value} value={value}>{formatSizeTier(value)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <label className={ROW}><span className="min-w-0 text-sm">Copy this server’s GitHub CLI login</span><Switch checked={values.copyGitHubCliAuth} aria-label="Copy GitHub CLI login" onCheckedChange={value => setDraft(previous => ({ ...previous, copyGitHubCliAuth: value }))} /></label>
        <label className={ROW}><span className="min-w-0 text-sm">Open sandbox files in local editors</span><Switch checked={values.sshEnabled} aria-label="Open sandbox files in local editors" onCheckedChange={value => setDraft(previous => ({ ...previous, sshEnabled: value }))} /></label>
        <div className="flex justify-end pt-3"><Button size="sm" variant="outline" disabled={saving || !Object.keys(draft).length} onClick={() => void save("preferences")}>{saving ? "Saving…" : "Save preferences"}</Button></div>
      </fieldset>
      <fieldset disabled={saving} className="mt-4 min-w-0 space-y-2 border-t border-border pt-4">
        <label htmlFor={`${id}-builder`} className="text-sm">Image build repository</label>
        <Input id={`${id}-builder`} value={repositoryDraft ?? builder?.savedRepository ?? ""} placeholder="owner/repository" autoComplete="off" spellCheck={false} onChange={event => setRepositoryDraft(event.target.value)} />
        {builder?.source === "environment" && <p className="break-words text-xs text-muted-foreground">Runtime environment override is active: {builder.repository}. It takes precedence over this saved preference.</p>}
        {builder?.source === "unconfigured" && <p className="text-xs text-muted-foreground">No image builder configured. Select a repository with a supported sandbox-image.yml before upgrading images.</p>}
        <div className="flex justify-end"><Button size="sm" variant="outline" disabled={saving || repositoryDraft === null} onClick={() => void save("builder")}>Save image builder</Button></div>
      </fieldset>
      <p role={error ? "alert" : undefined} className="min-h-5 break-words pt-2 text-xs text-destructive">{error}</p>
    </div>}
  </section>;
}

const integrationLabels: Record<SandboxIntegration, string> = {
  projectEnvironments: "Credentials", catalog: "Catalog", agents: "Agents", projects: "Projects",
};
const integrationHelp: Record<SandboxIntegration, string> = {
  projectEnvironments: "Stage the existing project application configuration for its exact sandbox workspace.",
  catalog: "Read saved skills and retain legacy scoped selections. This does not approve new skills.",
  agents: "Read saved agents and retain legacy scoped selections. This does not grant agent access.",
  projects: "Read native project context and existing assignment IDs. This does not enable automatic routing.",
};
export function SandboxIntegrationSettings() {
  const rpc = useRpc<typeof sandboxRpcContract>();
  const [values, setValues] = useState<Record<SandboxIntegration, boolean> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void rpc.call("integrations", null).then(next => { if (active) setValues(next); }, failure => { if (active) setError(failureText(failure)); });
    return () => { active = false; };
  }, [rpc]);
  return <section className="min-w-0 space-y-3" aria-label="Oh My BB integrations">
    <h2 className="text-sm font-medium">Oh My BB</h2>
    <div className={BOX}>
      {!values ? <p role={error ? "alert" : "status"} className="text-sm">{error || "Loading integrations…"}</p> : <div className="divide-y divide-border">{(Object.keys(integrationLabels) as SandboxIntegration[]).map(name => <label key={name} className={ROW}>
        <span className="min-w-0"><span className="block text-sm">{integrationLabels[name]}</span><span className="mt-1 block text-xs text-muted-foreground">{integrationHelp[name]}</span></span>
        <Switch checked={values[name]} disabled={saving} aria-label={`Enable ${integrationLabels[name]} integration`} onCheckedChange={checked => {
          setSaving(true); setError("");
          void rpc.call("updateIntegrations", { name, enabled: checked }).then(setValues, failure => setError(failureText(failure))).finally(() => setSaving(false));
        }} />
      </label>)}</div>}
      {values && <p role={error ? "alert" : undefined} className="min-h-5 break-words pt-2 text-xs text-destructive">{error}</p>}
    </div>
  </section>;
}

interface PreparationView { state: "not-required" | "pending" | "running" | "ready" | "not-ready" | "failed" | "unknown"; jobId: string | null; reason: string | null; retryable: boolean; sourceVersion?: 1 }
export function SandboxPreparationStatus({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof sandboxRpcContract>();
  const [view, setView] = useState<PreparationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void rpc.call("projectPreparationStatus", { threadId }).then(next => { if (active) setView(next); }, failure => { if (active) setError(failureText(failure)); });
    return () => { active = false; };
  }, [rpc, threadId]);
  if (!error && (!view || view.state === "ready" || view.state === "not-required")) return null;
  const act = async (retry: boolean) => {
    setBusy(true); setError("");
    try { setView(await rpc.call(retry ? "retryProjectPreparation" : "reconcileProjectPreparation", { threadId })); }
    catch (failure) { setError(failureText(failure)); }
    finally { setBusy(false); }
  };
  return <section className="min-w-0 space-y-2 border-t border-border pt-3">
    <h3 className="text-xs font-medium">Project preparation · {view?.state ?? "unknown"}</h3>
    <p role={error ? "alert" : "status"} className="break-words text-xs text-muted-foreground">{error || view?.reason}</p>
    {view?.state === "unknown" && <p className="text-xs text-muted-foreground">Catalog preparation remains unconfirmed; safe retry is unavailable when it participates. Refresh only observes the same job.</p>}
    <div className="flex flex-wrap gap-2">
      {view?.jobId && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(false)}>Refresh job status</Button>}
      {view?.sourceVersion === 1 && view.retryable && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(true)}>Retry preparation</Button>}
    </div>
  </section>;
}
