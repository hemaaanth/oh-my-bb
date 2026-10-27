import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc, type PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract";

type Preferences = PluginRpcResult<(typeof rpcContract)["preferences"]>;
export const integrationRows = [
  ["catalogIntegration", "Executor", "bundles"],
  ["agentsIntegration", "Agents", "agentPreferences"],
  ["sidebarIntegration", "Status Sidebar", null],
  ["tasksIntegration", "Tasks", null],
] as const;
const controlClass = "h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring";

function useProjectPreferences() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Preferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await rpc.call("preferences");
      if (request === sequence.current) { setData(next); setError(null); }
    } catch (cause) { if (request === sequence.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [rpc]);
  useEffect(() => { void load(); return () => { sequence.current++; }; }, [load]);
  useRealtime("projects-configuration-changed", () => { void load(); });
  async function save(patch: Partial<Preferences>) {
    const request = ++sequence.current;
    setSaving(true); setError(null);
    try {
      const next = await rpc.call("updatePreferences", patch);
      if (request === sequence.current) setData(next);
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { setSaving(false); }
  }
  return { data, error, saving, load, save };
}

export function PreferencesSettings() {
  const { data, error, saving, load, save } = useProjectPreferences();
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  return <section className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
    <h2 className="text-sm font-medium text-foreground">Preferences</h2>
    {!data ? <p role={error ? "alert" : "status"} className={`text-sm ${error ? "text-destructive" : "text-muted-foreground"}`}>{error ?? "Loading preferences…"}{error && <button type="button" className="ml-2 underline" onClick={() => void load()}>Retry</button>}</p> : <form className="space-y-3" onSubmit={(event) => {
      event.preventDefault();
      const value = modelDraft;
      if (value?.trim()) void save({ routingModel: value.trim() }).then((saved) => { if (saved) setModelDraft((current) => current === value ? null : current); });
    }}>
      <div className="rounded-md border border-border bg-surface-recessed/70 px-3">
        <div className="@container py-3"><div className="flex flex-col gap-2.5 @md:flex-row @md:items-center @md:justify-between @md:gap-5">
          <div className="min-w-0 flex-1"><label htmlFor="projects-profile-model" className="text-sm">Project profile model</label><p id="projects-profile-model-help" className="mt-0.5 text-xs leading-snug text-muted-foreground">For explicit profile generation and learning.</p></div>
          <div className="w-full min-w-0 @md:w-72 @md:shrink-0"><input id="projects-profile-model" aria-describedby="projects-profile-model-help" className={`${controlClass} w-full min-w-0`} value={modelDraft ?? data.routingModel} onChange={(event) => setModelDraft(event.target.value)} /></div>
        </div></div>
      </div>
      <div className="flex justify-end"><button type="submit" className={controlClass} disabled={saving || !modelDraft?.trim()}>{saving ? "Saving…" : "Save changes"}</button></div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </form>}
  </section>;
}

export function IntegrationSettings() {
  const { data, error, saving, load, save } = useProjectPreferences();
  return <section className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
    <h2 className="text-sm font-medium text-foreground">Oh My BB</h2>
    <div className="divide-y divide-border/60 rounded-md border border-border bg-surface-recessed/70 px-3">
      {integrationRows.map(([key, label]) => <div key={key} className="flex min-w-0 items-center justify-between gap-4 py-3">
        <label htmlFor={`projects-${key}`} className="min-w-0 text-sm">{label}</label>
        <button id={`projects-${key}`} type="button" role="switch" aria-checked={data?.[key] ?? false} disabled={saving || !data} onClick={() => void save({ [key]: !data?.[key] })} className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${data?.[key] ? "border-foreground bg-foreground" : "border-input bg-input"}`}>
          <span className={`pointer-events-none block size-4 rounded-full transition-transform ${data?.[key] ? "translate-x-4 bg-background" : "translate-x-0 bg-foreground"}`} />
        </button>
      </div>)}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}<button type="button" className="ml-2 underline" onClick={() => void load()}>Retry</button></p>}
  </section>;
}
