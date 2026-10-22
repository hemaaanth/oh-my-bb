import { useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { PODCAST_VOICES, type PodcastContract, type PodcastProfile } from "../../shared/podcast.js";
import { podcastEngine, podcastStore } from "../../voice/podcast/controller.js";
import { useStore } from "../../voice/store.js";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Note } from "../settings/layout.js";

function ProjectPerson({ profile, save }: { profile: PodcastProfile; save: (profile: PodcastProfile) => Promise<void> }) {
  const [draft, setDraft] = useState(profile);
  const [busy, setBusy] = useState(false);
  return <div className="space-y-2 border-t border-border py-3">
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />{profile.name}</label>
    <div className="flex gap-2">
      <Input aria-label={`Name for ${profile.name}`} value={draft.name} maxLength={60} onChange={event => setDraft({ ...draft, name: event.target.value })} />
      <Select value={draft.voice} onValueChange={voice => setDraft({ ...draft, voice: voice as PodcastProfile["voice"] })}><SelectTrigger aria-label={`Voice for ${profile.name}`} className="w-36"><SelectValue /></SelectTrigger><SelectContent>{PODCAST_VOICES.map(voice => <SelectItem key={voice} value={voice}>{voice}</SelectItem>)}</SelectContent></Select>
    </div>
    <Textarea aria-label={`Personality for ${profile.name}`} placeholder="Personality, energy, and pace" rows={2} maxLength={800} value={draft.personality} onChange={event => setDraft({ ...draft, personality: event.target.value })} />
    <Input aria-label={`Topics for ${profile.name}`} placeholder="Topics and aliases that should route here" maxLength={500} value={draft.topics} onChange={event => setDraft({ ...draft, topics: event.target.value })} />
    <Button variant="outline" size="sm" disabled={busy || !draft.name.trim()} onClick={async () => { setBusy(true); try { await save(draft); } finally { setBusy(false); } }}>{busy ? "Saving…" : "Save person"}</Button>
  </div>;
}

export function PodcastPanel() {
  const rpc = useRpc<PodcastContract>();
  const state = useStore(podcastStore);
  const [profiles, setProfiles] = useState<PodcastProfile[] | null>(null);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const load = () => rpc.call("podcastProfiles", {}).then(result => setProfiles(result.profiles)).catch(error => setError(String(error)));
  useEffect(() => { if (open && profiles === null) void load(); }, [open]);
  return <section aria-label="Podcast experimental" className="space-y-3 border-t border-border pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <button type="button" className="text-sm text-foreground" aria-expanded={open} onClick={() => setOpen(!open)}>Podcast <span className="text-xs text-muted-foreground">Experimental</span></button>
      <div className="flex gap-2">
        {state.active ? <>
          <Button variant="outline" size="sm" onClick={() => podcastEngine()?.toggleMute()}>{state.muted ? "Unmute" : "Mute"}</Button>
          <Button variant="outline" size="sm" onClick={() => void podcastEngine()?.stop()}>End podcast</Button>
        </> : <Button variant="outline" size="sm" onClick={() => { setOpen(true); void podcastEngine()?.start(); }}>Start podcast</Button>}
      </div>
    </div>
    {state.active ? <p role="status" className="text-xs text-muted-foreground">{state.connecting ? "Connecting…" : state.speaker ? `${state.speaker} is speaking` : state.busy ? "Working on your request…" : state.muted ? "Microphone muted" : "Listening"}{state.pending ? ` · ${state.pending} pending updates` : ""}{state.hold ? " · Updates on hold" : ""}</p> : null}
    {state.error || error ? <Note tone="error">{state.error || error}</Note> : null}
    {open ? <>
      <Note>Each project speaks in its own AI voice and can direct only its own threads. Say a project name, give an instruction, or ask who needs you. Updates wait until the conversation is free. Say “hold the updates” to defer them. Uses your OpenAI API key. Podcast costs are separate from the GPT-Live usage estimate.</Note>
      {state.active && !state.connecting ? <form className="flex gap-2" onSubmit={event => { event.preventDefault(); const request = text.trim(); if (request) { setText(""); void podcastEngine()?.turn(request); } }}>
        <Input aria-label="Podcast instruction" placeholder="Or type an instruction…" maxLength={8000} value={text} onChange={event => setText(event.target.value)} />
        <Button type="submit" size="sm" disabled={!text.trim()}>Send</Button>
      </form> : null}
      {state.transcript.length ? <ol aria-label="Podcast conversation" className="max-h-72 space-y-3 overflow-y-auto">{state.transcript.map((item, index) => <li key={`${item.id}-${index}`} className="text-sm"><span className="text-xs text-muted-foreground">{item.speaker}{item.interrupted ? " · interrupted" : ""}</span><p className="whitespace-pre-wrap">{item.text}</p></li>)}</ol> : null}
      <details><summary className="cursor-pointer text-xs text-muted-foreground">Project people</summary>
        <Note>Changes apply on the next call. Voices may repeat after thirteen projects.</Note>
        {profiles?.map(profile => <ProjectPerson key={profile.projectId} profile={profile} save={async draft => {
          try { await rpc.call("podcastProfileSave", draft); setProfiles(previous => previous?.map(p => p.projectId === draft.projectId ? draft : p) ?? null); setError(""); }
          catch (cause) { setError(String(cause)); }
        }} />) ?? <p className="text-xs text-muted-foreground">Loading projects…</p>}
      </details>
    </> : null}
  </section>;
}
