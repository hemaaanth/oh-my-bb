import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { sandboxRpcContract } from "../src/contract.js";
import type { SandboxPreferences, SandboxPreferencesView } from "../src/settings-preferences.js";
import { sandboxIdleSleepOptions } from "../src/config.js";
import { formatSizeTier, sizeTierUnits, sandboxSizeTierValues } from "../src/size-tiers.js";
import type { SandboxIntegration } from "../src/preferences.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Switch } from "./ui/switch.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.js";

const BOX = "min-w-0 rounded-md border border-border bg-surface-recessed/70 px-3";
const ROW = "flex min-w-0 items-center justify-between gap-4 py-3";
const failureText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function SandboxPreferencesSettings() {
  const rpc = useRpc<typeof sandboxRpcContract>();
  const id = useId();
  const [data, setData] = useState<SandboxPreferencesView | null>(null);
  const [draft, setDraft] = useState<Partial<SandboxPreferences>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const savingRef = useRef(false), dirty = useRef(false), request = useRef(0);
  const load = useCallback(async () => {
    if (savingRef.current || dirty.current) return;
    const current = ++request.current;
    try { const next = await rpc.call("preferences", null); if (current === request.current) { setData(next); setError(""); } }
    catch (failure) { if (current === request.current) setError(failureText(failure)); }
  }, [rpc]);
  useEffect(() => { void load(); return () => { request.current++; }; }, [load]);
  useRealtime("sandbox-preferences", useCallback(() => { void load(); }, [load]));
  const save = async (values: Partial<SandboxPreferences>) => {
    if (!data || savingRef.current) return;
    const patch = { ...draft, ...values };
    dirty.current = true; setDraft(patch); savingRef.current = true; setSaving(true); setError(""); request.current++;
    try { const next = await rpc.call("updatePreferences", { expectedRevision: data.revision, values: patch }); setData(next); setDraft({}); dirty.current = false; }
    catch (failure) { setError(failureText(failure)); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const values = data ? { ...data.values, ...draft } : null;
  const textFields = [
    ["gitUsername", "Git HTTPS username", "Username for the Git token in Configuration."],
    ["browserUserAgent", "Browser user agent", "Leave empty to use Brave’s default."],
    ["browserExitNode", "Browser exit node", "Tailscale name or IP for home egress."],
    ["browserHomeEgressIp", "Expected home IP", "Optional public IPs, separated by commas."],
    ["browserTailscaleAuthKeyFile", "Browser enrollment file", "Optional server-side dotenv file; the key in Configuration takes precedence."],
    ["browserStateFile", "Browser auth state file", "Optional server-side export; paired Browser state takes precedence."],
  ] as const;
  return <section className="min-w-0 space-y-3" aria-label="Sandboxes preferences"><h2 className="text-sm font-medium">Preferences</h2>
    {!values ? <div className={BOX}><p role={error ? "alert" : "status"} className="text-sm">{error || "Loading preferences…"}</p>{error && <Button variant="outline" size="sm" onClick={() => void load()}>Retry</Button>}</div> : <div className={BOX}>
      <fieldset disabled={saving || data?.migrationPending} className="min-w-0 divide-y divide-border">
        <div className="@container flex min-w-0 flex-col gap-2 py-3 @md:flex-row @md:items-center @md:justify-between"><label htmlFor={`${id}-idle`} className="text-sm">Auto-sleep after</label><Select value={values.idleSleepAfter} onValueChange={value => void save({ idleSleepAfter: value as SandboxPreferences["idleSleepAfter"] })}><SelectTrigger id={`${id}-idle`} className="w-full min-w-0 @md:w-56"><SelectValue /></SelectTrigger><SelectContent>{sandboxIdleSleepOptions.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></div>
        <div className="@container flex min-w-0 flex-col gap-2 py-3 @md:flex-row @md:items-center @md:justify-between"><label htmlFor={`${id}-size`} className="text-sm">Default size</label><Select value={values.defaultSizeTier} onValueChange={value => void save({ defaultSizeTier: value as SandboxPreferences["defaultSizeTier"] })}><SelectTrigger id={`${id}-size`} className="w-full min-w-0 @md:w-56"><SelectValue>{values.defaultSizeTier} · {sizeTierUnits(values.defaultSizeTier).cpu} cores · {sizeTierUnits(values.defaultSizeTier).memoryGiB} GiB</SelectValue></SelectTrigger><SelectContent>{sandboxSizeTierValues.map(value => <SelectItem key={value} value={value}>{formatSizeTier(value)}</SelectItem>)}</SelectContent></Select></div>
        <label className={ROW}><span className="min-w-0"><span className="block text-sm">Copy GitHub CLI login</span><span className="block text-xs text-muted-foreground">Use this server’s GitHub access in new machines.</span></span><Switch checked={values.copyGitHubCliAuth} aria-label="Copy GitHub CLI login" onCheckedChange={value => void save({ copyGitHubCliAuth: value })} /></label>
        <label className={ROW}><span className="min-w-0"><span className="block text-sm">Open files in local editors</span><span className="block text-xs text-muted-foreground">Connect through Tailscale SSH from this server.</span></span><Switch checked={values.sshEnabled} aria-label="Open sandbox files in local editors" onCheckedChange={value => void save({ sshEnabled: value })} /></label>
        {textFields.map(([key, label, help]) => (
          <div key={key} className="@container flex min-w-0 flex-col gap-2 py-3 @md:flex-row @md:items-center @md:justify-between">
            <label htmlFor={`${id}-${key}`} className="min-w-0 @md:flex-1">
              <span className="block text-sm">{label}</span>
              <span className="block text-xs text-muted-foreground">{help}</span>
            </label>
            <Input id={`${id}-${key}`} className="w-full min-w-0 @md:w-64 @md:shrink-0" value={values[key]} autoComplete="off" spellCheck={false}
              onChange={event => { dirty.current = true; setDraft(previous => ({ ...previous, [key]: event.target.value })); }}
              onBlur={() => { if (values[key] !== data?.values[key]) void save({ [key]: values[key] }); }} />
          </div>
        ))}
      </fieldset>
      {saving && <p role="status" className="text-xs text-muted-foreground">Saving…</p>}
      {error && <div role="alert" className="space-y-2 text-xs text-destructive"><p>{error}</p><Button size="sm" variant="outline" onClick={() => { dirty.current = false; setDraft({}); void load(); }}>Reload saved preferences</Button></div>}
    </div>}
  </section>;
}

const integrationLabels: Record<SandboxIntegration, string> = {
  projectEnvironments: "Project environments", catalog: "Executor", agents: "Agents", projects: "Projects",
};
const integrationHelp: Record<SandboxIntegration, string> = {
  projectEnvironments: "Prepare the project’s environment and setup scripts before a turn.",
  catalog: "Read saved skills in launch previews and existing thread attachments.",
  agents: "Read saved agents in launch previews and existing thread attachments.",
  projects: "Read project configuration in launch previews and existing thread attachments.",
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
      {error && <p role="alert" className="break-words py-2 text-xs text-destructive">{error}</p>}
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
