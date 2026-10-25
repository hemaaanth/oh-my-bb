import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { UrlLink, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { JournalPreferences, JournalPreferencesPatch, JournalPreferencesView } from "./preferences";
import { AI_BACKENDS, GATEWAY_MODELS, PREFERENCES_CHANGED } from "./shared";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";
import { Input } from "./components/ui/input";
import { Switch } from "./components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";

function useJournalPreferences() {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc); rpcRef.current = rpc;
  const request = useRef(0);
  const [data, setData] = useState<JournalPreferencesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const load = useCallback(() => {
    const id = ++request.current;
    rpcRef.current.call("journal_preferences", null).then((next) => {
      if (id === request.current) { setData(next); setError(null); }
    }, (cause: unknown) => { if (id === request.current) setError(cause instanceof Error ? cause.message : String(cause)); });
  }, []);
  useEffect(() => { load(); return () => { request.current++; }; }, [load]);
  useRealtime(PREFERENCES_CHANGED, load);
  const save = async (patch: JournalPreferencesPatch) => {
    const id = ++request.current; setSaving(true); setError(null);
    try {
      const next = await rpcRef.current.call("journal_preferences_update", patch);
      if (id === request.current) setData(next);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally { setSaving(false); }
  };
  return { data, error, saving, load, save };
}

function SettingsRow({ label, help, id, compact = false, children }: {
  label: string; help: string; id: string; compact?: boolean; children: ReactNode;
}) {
  return <div className="@container py-3"><div className={compact ? "flex items-center justify-between gap-4" : "flex flex-col gap-2.5 @md:flex-row @md:items-center @md:justify-between @md:gap-5"}>
    <div className="min-w-0 flex-1"><label htmlFor={id} className="text-sm">{label}</label><p id={`${id}-help`} className="mt-0.5 text-xs leading-snug text-muted-foreground">{help}</p></div>
    <div className={compact ? "shrink-0" : "w-full min-w-0 @md:w-72 @md:shrink-0"}>{children}</div>
  </div></div>;
}

function PreferencesLoading({ error, retry }: { error: string | null; retry: () => void }) {
  return <div className="text-sm">{error ? <><p role="alert" className="text-destructive">{error}</p><Button size="sm" variant="outline" className="mt-2" onClick={retry}>Retry</Button></> : <p role="status" className="text-muted-foreground">Loading…</p>}</div>;
}

export function PreferencesSettings() {
  const { data, error, saving, load, save } = useJournalPreferences();
  const [draft, setDraft] = useState<Partial<{ openRouterModel: string; gatewayModel: JournalPreferences["gatewayModel"]; intelligenceEnabled: boolean; automaticDailyBudgetUsd: string; workTimeZone: string }>>({});
  return <section className="space-y-4">
    <h2 className="text-sm font-medium text-foreground">Preferences</h2>
    {!data ? <PreferencesLoading error={error} retry={load} /> : data.migrationPending ? <p role="status" className="text-sm text-muted-foreground">Saved preferences are preserved. Reload Journal once from the plugin menu, or run <code>bb plugin reload journal</code>, to finish moving these controls out of Configuration.</p> : <form className="space-y-3" onSubmit={(event) => {
      event.preventDefault();
      const { automaticDailyBudgetUsd, ...rest } = draft;
      void save({ ...rest, ...(automaticDailyBudgetUsd === undefined ? {} : { automaticDailyBudgetUsd: Number(automaticDailyBudgetUsd) }) }).then((saved) => { if (saved) setDraft({}); });
    }}>
      <div className="divide-y divide-border/60 rounded-md border border-border bg-surface-recessed/70 px-3">
        <SettingsRow id="journal-intelligence" compact label="Intelligent summaries" help="Summarize completed days.">
          <Switch id="journal-intelligence" aria-describedby="journal-intelligence-help" checked={draft.intelligenceEnabled ?? data.values.intelligenceEnabled} disabled={saving} onCheckedChange={(intelligenceEnabled) => setDraft((next) => ({ ...next, intelligenceEnabled }))} />
        </SettingsRow>
        <SettingsRow id="journal-model" label="OpenRouter model" help="Default when empty.">
          <Input id="journal-model" aria-describedby="journal-model-help" value={draft.openRouterModel ?? data.values.openRouterModel} disabled={saving} onChange={(event) => setDraft((next) => ({ ...next, openRouterModel: event.target.value }))} />
        </SettingsRow>
        <SettingsRow id="journal-subscription-model" label="Subscription model" help="For Model Gateway.">
          <Select value={draft.gatewayModel ?? data.values.gatewayModel} onValueChange={(value) => { if (GATEWAY_MODELS.includes(value as JournalPreferences["gatewayModel"])) setDraft((next) => ({ ...next, gatewayModel: value as JournalPreferences["gatewayModel"] })); }} disabled={saving}>
            <SelectTrigger id="journal-subscription-model" aria-describedby="journal-subscription-model-help"><SelectValue /></SelectTrigger>
            <SelectContent align="end">{GATEWAY_MODELS.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow id="journal-budget" label="Automatic AI budget (USD/day)" help="Daily OpenRouter limit.">
          <Input id="journal-budget" aria-describedby="journal-budget-help" type="number" min="0" max="100" step="any" required value={draft.automaticDailyBudgetUsd ?? data.values.automaticDailyBudgetUsd} disabled={saving} onChange={(event) => setDraft((next) => ({ ...next, automaticDailyBudgetUsd: event.target.value }))} />
        </SettingsRow>
        <SettingsRow id="journal-timezone" label="Work day timezone" help="Used for new work days.">
          <Input id="journal-timezone" aria-describedby="journal-timezone-help" required value={draft.workTimeZone ?? data.values.workTimeZone} disabled={saving} onChange={(event) => setDraft((next) => ({ ...next, workTimeZone: event.target.value }))} />
        </SettingsRow>
      </div>
      <div className="flex justify-end"><Button size="sm" variant="outline" type="submit" disabled={saving || Object.keys(draft).length === 0}>{saving ? "Saving…" : "Save changes"}</Button></div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </form>}
  </section>;
}

export function IntegrationSettings() {
  const { data, error, saving, load, save } = useJournalPreferences();
  if (data?.migrationPending) return null;
  return <section className="space-y-4">
    <h2 className="text-sm font-medium text-foreground">Oh My BB</h2>
    {!data ? <PreferencesLoading error={error} retry={load} /> : <>
      <div className="divide-y divide-border/60 rounded-md border border-border bg-surface-recessed/70 px-3">
        <SettingsRow id="journal-ai-backend" label="AI backend" help="Choose your AI service.">
          <Select value={data.values.aiBackend} onValueChange={(value) => { if (AI_BACKENDS.includes(value as JournalPreferences["aiBackend"])) void save({ aiBackend: value as JournalPreferences["aiBackend"] }); }} disabled={saving}>
            <SelectTrigger id="journal-ai-backend" aria-describedby="journal-ai-backend-help"><SelectValue /></SelectTrigger>
            <SelectContent align="end"><SelectItem value="openrouter">OpenRouter API key</SelectItem><SelectItem value="subscription">Model Gateway subscription</SelectItem></SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow id="journal-dispatch-calls" compact label="Show Dispatch calls" help="Show calls in the calendar.">
          <Switch id="journal-dispatch-calls" aria-describedby="journal-dispatch-calls-help" checked={data.values.showDispatchCalls} disabled={saving} onCheckedChange={(showDispatchCalls) => { void save({ showDispatchCalls }); }} />
        </SettingsRow>
      </div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </>}
  </section>;
}

export function MoreSettings() {
  const navigate = useBbNavigate();
  return <section className="space-y-4">
    <h2 className="text-sm font-medium text-foreground">More</h2>
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface-recessed/70 p-3">
      <div className="min-w-0"><p className="text-sm">Setup guide</p><p className="mt-0.5 text-xs text-muted-foreground">Setup and usage.</p></div>
      <Button size="sm" variant="outline" onClick={() => navigate.toPluginPanel("journal", { subPath: "setup" })}>Open setup guide</Button>
    </div>
  </section>;
}

export function JournalSetup() {
  const navigate = useBbNavigate();
  return <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-[760px] space-y-6 px-4 py-4">
    <header className="flex items-center gap-3">
      <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-raised"><Icon name="journal/journal" className="size-5" /></span>
      <div className="min-w-0"><h1 className="text-lg font-semibold">Set up Journal</h1><p className="text-xs text-muted-foreground">Keep a dated record of agent work.</p></div>
    </header>
    <section className="space-y-2 text-sm leading-relaxed"><h2 className="font-medium">Local history</h2>
      <p>Journal records visible thread lifecycle events and agent turn times without an API key. Hidden threads are excluded. Children and side chats roll into their parent.</p>
      <p className="text-muted-foreground">Choose the work day timezone before indexing older work. The existing America/New_York default is retained for date compatibility. Changing it does not delete or rewrite recorded days.</p>
    </section>
    <section className="space-y-2 text-sm leading-relaxed"><h2 className="font-medium">Optional AI summaries</h2>
      <p>Choose OpenRouter or Model Gateway under Oh My BB. OpenRouter needs an API key in Configuration. The key stays in BB's host-local secret storage. Model Gateway uses your ChatGPT subscription accounts and never falls back to a paid API key. With intelligence enabled, Journal sends transcript excerpts to the selected backend.</p>
      <p className="text-muted-foreground">The automatic budget defaults to $0.50 per work day. Manual catch-up Refresh, enrichment, and explicit backfill are outside this budget and can cost extra. Use bb journal cost to inspect recorded usage.</p>
      <p className="text-muted-foreground">Choose models, intelligent summaries, the automatic budget, and work day timezone under Preferences. Automatic thread briefings run only on the subscription backend. Use bb journal ai-status to check backend readiness without a model request.</p>
      <p className="text-muted-foreground">Use bb journal backfill --dry-run for an estimate before explicit historical indexing. Do not run backfill just to validate installation.</p>
      <Button size="sm" variant="outline" asChild><UrlLink href="/settings/plugins/journal">Open Configuration</UrlLink></Button>
    </section>
    <section className="space-y-2 text-sm leading-relaxed"><h2 className="font-medium">Optional Dispatch calls</h2>
      <p>The Calls toggle and Show Dispatch calls control under Oh My BB share one opt-in. While enabled, Calendar and Traces read Dispatch calls on demand. Missing Dispatch does not block Journal. Calls never count toward agent hours.</p>
      <p className="text-muted-foreground">Journal does not install, enable, or contact Dispatch at startup. Dispatch owns call memory and retention.</p>
    </section>
    <Button size="sm" variant="outline" onClick={() => navigate.toPluginPanel("journal")}>Back to Journal</Button>
  </div></div>;
}
