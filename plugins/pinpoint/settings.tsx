import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./components/ui/dialog";

type Integrations = { clasi: boolean; agents: boolean; providerUsage: boolean };
const rows = [
  { id: "clasi", label: "Clasi learning", help: "Save a design or copy preference only when you approve its exact text on a feedback card." },
  { id: "agents", label: "Agents", help: "Use your saved Pinpoint Fix and Pinpoint Copy agents for review chats. Otherwise BB creates a normal child thread." },
  { id: "providerUsage", label: "Provider Usage", help: "Check the saved agent's provider capacity before dispatch. Requires the Agents integration." },
] as const;

export function IntegrationSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Integrations | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const load = () => { setError(null); void rpc.call("integrations", null).then(setData).catch((cause: unknown) => setError(message(cause))); };
  useEffect(load, [rpc]);
  async function toggle(integration: keyof Integrations, enabled: boolean) {
    setPending(true); setError(null);
    try { setData(await rpc.call("setIntegration", { integration, enabled })); }
    catch (cause) { setError(message(cause)); }
    finally { setPending(false); }
  }
  return <section className="space-y-4">
    <h2 className="text-sm font-medium text-foreground">Oh My BB</h2>
    {data ? <div className="divide-y divide-border/60 rounded-md border border-border bg-surface-recessed/70 px-3">
      {rows.map((row) => <div key={row.id} className="flex min-w-0 items-center justify-between gap-4 py-3">
        <div className="min-w-0"><label htmlFor={`pinpoint-${row.id}`} className="text-sm text-foreground">{row.label}</label><p id={`pinpoint-${row.id}-help`} className="mt-0.5 text-xs leading-snug text-muted-foreground">{row.help}</p></div>
        <button id={`pinpoint-${row.id}`} type="button" role="switch" aria-checked={data[row.id]} aria-describedby={`pinpoint-${row.id}-help`} disabled={pending} onClick={() => void toggle(row.id, !data[row.id])} className={`relative h-5 w-9 shrink-0 rounded-full border border-border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 ${data[row.id] ? "bg-primary" : "bg-input"}`}>
          <span aria-hidden className={`absolute top-[1px] size-4 rounded-full bg-background shadow-sm transition-transform ${data[row.id] ? "translate-x-[1px]" : "-translate-x-[15px]"}`} />
        </button>
      </div>)}
    </div> : <p className="text-sm text-muted-foreground">Loading integrations…</p>}
    {error ? <div role="alert" className="text-sm text-destructive">{error} {!data ? <Button size="sm" variant="outline" onClick={load}>Retry</Button> : null}</div> : null}
  </section>;
}

export function MoreSettings() {
  const [setupOpen, setSetupOpen] = useState(false);
  return <section className="space-y-4">
    <h2 className="text-sm font-medium text-foreground">More</h2>
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface-recessed/70 p-3">
      <div className="min-w-0"><p className="text-sm">Setup guide</p><p className="mt-0.5 text-xs text-muted-foreground">Browser feedback, approvals, and optional integrations.</p></div>
      <Button size="sm" variant="outline" onClick={() => setSetupOpen(true)}>Open guide</Button>
    </div>
    <SetupGuide open={setupOpen} onOpenChange={setSetupOpen} />
  </section>;
}

export function SetupGuide({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-[728px]">
      <DialogHeader>
        <DialogTitle>Pinpoint setup guide</DialogTitle>
        <DialogDescription>Point at a page. Review the agent's changes.</DialogDescription>
      </DialogHeader>
      <div className="space-y-5">
      <section className="space-y-2 text-sm"><h2 className="font-medium">Open a page</h2><p>Open Pinpoint from a thread's panel launcher. Enter an HTTP or HTTPS URL that BB can reach. A remote sandbox's localhost preview is fetched on that sandbox.</p><p className="text-muted-foreground">Configure the default URL, review-chat routing, and automatic dispatch in native Configuration. No other plugin is required.</p></section>
      <section className="space-y-2 text-sm"><h2 className="font-medium">Pin and review</h2><p>Pick an element, select text, or use the context menu to edit text. Confirm Send in BB, outside the preview page. Use question mode to ask without requesting a code change.</p><p className="text-muted-foreground">The agent marks changes ready. Review the page and diff receipt, then approve or reply with more feedback. A receipt is the agent's claim, not an independently verified diff.</p></section>
      <details className="rounded-md border border-border bg-surface-recessed/70 p-3 text-sm"><summary className="cursor-pointer font-medium">Preview isolation</summary><div className="mt-3 space-y-2 text-muted-foreground"><p>Previews run in an opaque sandbox. They do not receive BB login cookies. Requests from inside a page need confirmation in BB before feedback is saved or approved.</p><p>The resource bridge reads only the selected app. Sign-in flows, write APIs, WebSockets, and undeclared external services may not work. For a protected BB Connect app, use its localhost URL in its owning thread when available.</p><p>Older Session Share preview links need the isolated-preview update in that sharing server. Normal Pinpoint in BB does not require Session Share.</p></div></details>
      <details className="rounded-md border border-border bg-surface-recessed/70 p-3 text-sm"><summary className="cursor-pointer font-medium">Optional integrations</summary><div className="mt-3 space-y-2 text-muted-foreground"><p>Enable each integration in Settings → Pinpoint → Oh My BB. Pinpoint never installs, enables, or probes another plugin at startup.</p><p>Agents selects your saved Pinpoint Fix or Pinpoint Copy profile during dispatch. Provider Usage is an optional capacity check for those profiles. Missing integrations fall back to BB's normal child threads.</p><p>Clasi learning starts off. Enabling it does not save anything. Each feedback card starts unchecked and shows the exact proposed text. Approving the fix alone saves nothing. The global switch is checked again before a write or retry. Disabling retains existing choices and saved preferences.</p><p>Clasi receives a design or copy preference, repository scope, source thread ID, and consent reference. Pinpoint owns the consent check. Clasi's reference is audit metadata, not independent proof of approval.</p></div></details>
      <details className="rounded-md border border-border bg-surface-recessed/70 p-3 text-sm"><summary className="cursor-pointer font-medium">Privacy and shared feedback</summary><div className="mt-3 space-y-2 text-muted-foreground"><p>Comments, page context, screenshots, and review state stay in private BB plugin storage. Installing public source does not publish this data. Do not enter secrets or private customer data into feedback.</p><p>Pinpoint does not publish a public HTTP feedback endpoint. Optional sharing integrations must authenticate their guests, enforce share scope and expiry, validate CSRF, and limit each action before calling Pinpoint's authenticated RPC methods. Never expose a plugin HTTP token to reviewed pages or guests.</p></div></details>
      </div>
    </DialogContent>
  </Dialog>;
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : "Pinpoint request failed"; }
