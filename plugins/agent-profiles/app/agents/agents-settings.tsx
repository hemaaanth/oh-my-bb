import { Provider as TooltipProvider } from "@radix-ui/react-tooltip";
import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_Icon as Icon, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { Profile, rpcContract } from "../../server/contract";
import { modelLevelLabel } from "../../server/model-levels";
import { AgentDetail, agentTabs } from "./agent-detail";
import { ProfileForm } from "./profile-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorMessage, message } from "../shared/ui";

export function AgentsSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof agentTabs)[number]>("profile");
  const request = useRef(0);
  const load = useCallback(async () => {
    const sequence = ++request.current;
    try {
      const next = await rpc.call("listProfiles");
      if (sequence !== request.current) return;
      setProfiles(next); setError(null); setLoaded(true);
    } catch (cause) {
      if (sequence === request.current) { setError(message(cause)); setLoaded(true); }
    }
  }, [rpc]);
  useEffect(() => { void load(); return () => { request.current++; }; }, [load]);
  useRealtime("profiles-changed", useCallback(() => { void load(); }, [load]));
  const search = query.trim().toLowerCase();
  const visible = profiles.filter(profile => `${profile.name} @${profile.slug} ${profile.description}`.toLowerCase().includes(search)).sort((a,b) => a.name.localeCompare(b.name));
  const profile = profiles.find(item => item.id === editing);
  return <TooltipProvider><section className="min-w-0 space-y-3" aria-label="Agent profiles">
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-medium">Agents <span className="text-muted-foreground">{loaded ? `(${profiles.length})` : ""}</span></h2>
      <Button size="sm" variant="outline" disabled={!loaded || !!error} onClick={() => setEditing("new")}><Icon name="Plus" className="size-4" />New agent</Button>
    </div>
    {profiles.length > 0 && <Input aria-label="Search agents" placeholder="Search agents…" value={query} onChange={event => setQuery(event.target.value)} />}
    <div className="min-w-0 rounded-md border border-border bg-surface-recessed/70 px-3">
      {!loaded ? <p role="status" className="py-3 text-sm text-muted-foreground">Loading agents…</p> : !visible.length ? <p className="py-3 text-sm text-muted-foreground">{profiles.length ? "No agents match your search." : "No agents yet. Create an agent to get started."}</p> : <div className="max-h-[28rem] overflow-y-auto divide-y divide-border">{visible.map(item => <div key={item.id} className="flex min-w-0 items-center gap-3 py-2.5">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center text-xl">{item.avatar}</span>
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { setTab("profile"); setEditing(item.id); }} aria-label={`Edit ${item.name}`}>
          <span className="flex min-w-0 items-center gap-2 text-sm"><span className="truncate font-medium">{item.name}</span>{item.isDefault && <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">Default</span>}</span>
          <span className="block truncate text-xs text-muted-foreground">@{item.slug} · {item.kind === "thin" ? "Thin" : "Full"} · {item.modelMode === "level" ? modelLevelLabel(item.level) : item.model}</span>
          {item.description && <span className="block truncate text-xs text-muted-foreground">{item.description}</span>}
        </button>
        <Button size="icon" variant="ghost" className="size-8 shrink-0 p-0" aria-label={`Edit ${item.name} profile`} onClick={() => { setTab("profile"); setEditing(item.id); }}><svg aria-hidden className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m16 3 5 5M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z" /></svg></Button>
      </div>)}</div>}
    </div>
    <ErrorMessage error={error} />
    {error && <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>}
    <Dialog open={editing !== null} onOpenChange={open => { if (!open) setEditing(null); }}>
      {editing !== null && <DialogContent aria-describedby={undefined} className="agent-settings-editor w-[calc(100%-2rem)] max-w-[760px] h-[85dvh] overflow-y-auto">
        <DialogHeader className={editing === "new" ? undefined : "sr-only"}><DialogTitle>{editing === "new" ? "New agent" : profile?.name ?? "Agent unavailable"}</DialogTitle></DialogHeader>
        {editing === "new" ? <ProfileForm makeDefault={profiles.length === 0} onSaved={async () => { await load(); setEditing(null); }} onCancel={() => setEditing(null)} /> : profile ? <AgentDetail key={profile.id} profile={profile} tab={tab} onReload={load} onBack={() => setEditing(null)} onTab={setTab} /> : <p className="text-sm text-muted-foreground">This agent is no longer available.</p>}
      </DialogContent>}
    </Dialog>
  </section></TooltipProvider>;
}
