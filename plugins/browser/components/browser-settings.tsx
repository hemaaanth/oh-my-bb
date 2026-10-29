import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import type { preferencesContract, BrowserPreferences, BrowserPreferencesPatch, BrowserPreferencesView } from '../src/preferences.js';
import { browserSettingDescriptors } from '../src/config.js';
import { BrowserCookieSettings } from './browser-cookie-settings';
import { Button } from './ui/button';
import { Input } from './ui/input';

const GROUP = 'divide-y divide-border/60 rounded-md border border-border bg-surface-recessed/70 px-3';
const BOX = 'rounded-md border border-border bg-surface-recessed/70 p-3';

function useBrowserPreferences() {
  const rpc = useRpc<typeof preferencesContract>();
  const rpcRef = useRef(rpc); rpcRef.current = rpc;
  const request = useRef(0);
  const [data, setData] = useState<BrowserPreferencesView | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const load = useCallback(() => {
    const id = ++request.current;
    void rpcRef.current.call('browserPreferences', null).then(next => {
      if (id === request.current) { setData(next); setError(''); }
    }).catch(() => { if (id === request.current) setError('Could not load preferences.'); });
  }, []);
  useEffect(() => { load(); return () => { request.current++; }; }, [load]);
  useRealtime('browser-preferences', load);
  const save = async (patch: BrowserPreferencesPatch) => {
    const id = ++request.current;
    setSaving(true); setError('');
    try {
      const next = await rpcRef.current.call('updateBrowserPreferences', patch);
      if (id === request.current) setData(next);
      return true;
    } catch { setError('Could not save preferences.'); return false; }
    finally { setSaving(false); }
  };
  return { data, error, saving, load, save };
}

function Toggle({ id, checked, disabled, describedBy, change }: { id: string; checked: boolean; disabled: boolean; describedBy?: string; change(value: boolean): void }) {
  return <button id={id} type="button" role="switch" aria-checked={checked} aria-describedby={describedBy} disabled={disabled} onClick={() => change(!checked)} className={`inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${checked ? 'border-foreground bg-foreground' : 'border-input bg-input'}`}>
    <span className={`pointer-events-none block size-4 rounded-full transition-transform ${checked ? 'translate-x-4 bg-background' : 'translate-x-0 bg-foreground'}`} />
  </button>;
}

function Row({ name, value, disabled, change }: { name: keyof BrowserPreferences; value: string | boolean; disabled: boolean; change(value: string | boolean): void }) {
  const descriptor = browserSettingDescriptors[name];
  const help = 'description' in descriptor ? descriptor.description : undefined;
  const id = `browser-${name}`, helpId = help ? `${id}-help` : undefined;
  const toggle = typeof value === 'boolean';
  return <div className="@container py-3">
    <div className={toggle ? 'flex items-center justify-between gap-4' : 'flex flex-col gap-2.5 @md:flex-row @md:items-center @md:justify-between @md:gap-5'}>
      <div className="min-w-0 flex-1"><label htmlFor={id} className="text-sm">{descriptor.label}</label>{help && <p id={helpId} className="mt-0.5 text-xs leading-snug text-muted-foreground">{help}</p>}</div>
      <div className={toggle ? 'shrink-0' : 'w-full min-w-0 @md:w-72 @md:shrink-0'}>
        {toggle ? <Toggle id={id} describedBy={helpId} checked={value} disabled={disabled} change={change} /> : <Input id={id} aria-describedby={helpId} value={value} placeholder={name === "browserUserAgent" ? "Automatic — browser default" : undefined} disabled={disabled} onChange={event => change(event.target.value)} autoComplete="off" spellCheck={false} />}
      </div>
    </div>
  </div>;
}

function Loading({ error, retry }: { error: string; retry(): void }) {
  return <div className={BOX}>{error ? <><p role="alert" className="text-sm text-destructive">{error}</p><Button size="sm" variant="outline" className="mt-2" onClick={retry}>Retry</Button></> : <p role="status" className="text-sm text-muted-foreground">Loading…</p>}</div>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="min-w-0 space-y-4"><h2 className="text-sm font-medium text-foreground">{title}</h2>{children}</section>;
}

export function BrowserPreferencesSettings() {
  const { data, error, saving, load, save } = useBrowserPreferences();
  const [draft, setDraft] = useState<BrowserPreferencesPatch>({});
  const row = (name: keyof BrowserPreferences) => <Row key={name} name={name} value={name === 'fastRunner' && !data!.fastApiKeyConfigured ? false : draft[name] ?? data!.values[name]} disabled={saving || (["fastRunner", "fastEndpoint", "fastModel"].includes(name) && !data!.fastApiKeyConfigured)} change={value => setDraft(previous => ({ ...previous, [name]: value }))} />;
  return <Section title="Preferences">
    {!data ? <Loading error={error} retry={load} /> : data.migrationPending ? <div className={BOX}><p role="status" className="text-sm text-muted-foreground">Saved preferences are preserved. Reload Browser once to finish moving them out of Configuration.</p></div> : <form className="space-y-3" onSubmit={event => {
      event.preventDefault(); void save(draft).then(saved => { if (saved) setDraft({}); });
    }}>
      <div className={GROUP}>{row('homeRouting')}{row('browserExitNode')}{row('browserHomeEgressIp')}{row('sharePersonalLogins')}{row('browserUserAgent')}{row('fastRunner')}{row('fastEndpoint')}{row('fastModel')}{!data.fastApiKeyConfigured && <p className="py-3 text-xs text-muted-foreground">Add a fast-task API key in Configuration to enable these options.</p>}</div>
      <div className="flex justify-end"><Button type="submit" size="sm" variant="outline" disabled={saving || !Object.keys(draft).length}>{saving ? 'Saving…' : 'Save changes'}</Button></div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </form>}
  </Section>;
}

export function BrowserIntegrationSettings() {
  const { data, error, saving, load, save } = useBrowserPreferences();
  if (data?.migrationPending) return null;
  return <Section title="Oh My BB">
    {!data ? <Loading error={error} retry={load} /> : <div className={GROUP}><Row name="sandboxesIntegration" value={data.values.sandboxesIntegration} disabled={saving} change={value => { void save({ sandboxesIntegration: value === true }); }} /></div>}
    {data && error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </Section>;
}

export function BrowserMoreSettings() {
  return <Section title="More">
    <details className={BOX}><summary className="cursor-pointer text-sm">Browser connection</summary><div className="mt-3 border-t border-border pt-3"><BrowserCookieSettings /></div></details>
    <details className={BOX}>
      <summary className="cursor-pointer text-sm">Setup guide</summary>
      <div className="mt-3 space-y-3 border-t border-border pt-3 text-sm text-muted-foreground">
        <p>Use <code>bb-browser</code> from a BB thread. Each thread owns its tabs. Isolated sessions also keep separate logins.</p>
        <p>To pair a regular profile, open Browser connection and download the extension. Extract it, then use Extensions → Developer mode → Load unpacked in Brave or Chrome. Enter the BB address and pairing code in the extension’s options. Do not replace an existing paired extension without approval.</p>
        <p>Only pair the regular profile. Its relay shares that profile’s live login state. For new isolated sessions, enable cookie export in the regular profile’s extension and Share personal logins in Preferences. Agent profiles do not pair; their later login changes stay private. Disconnecting stops future seeds but does not sign out existing sessions.</p>
        <p>Enable Sandboxes under Oh My BB for managed provisioning and private desktop handoff. Home routing and login sharing stay separate opt-ins under Preferences.</p>
        <p>For fast tasks, configure the endpoint and model under Preferences and the key in Configuration. Each task also needs <code>--allow-model</code> to send page content.</p>
      </div>
    </details>
  </Section>;
}
