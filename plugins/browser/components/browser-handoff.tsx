import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_useQuestionFormHost, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { BrowserFrame } from "./browser-live";
import { Button } from "./ui/button";

function ActionIcon({ name }: { name: "done" | "reply" | "cancel" | "send" | "external" | "note" }) {
  const paths = {
    done: "m5 12 4 4L19 6", cancel: "m6 6 12 12M6 18 18 6",
    reply: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z",
    send: "m22 2-7 20-4-9-9-4 20-7zM22 2 11 13",
    external: "M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5",
    note: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h6",
  };
  return <svg aria-hidden className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}

export function BrowserHandoff({ interaction, submit }: PluginPendingInteractionProps) {
  const { registerChoiceHandler } = experimental_useQuestionFormHost();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [reply, setReply] = useState("");
  const payload = interaction.payload as { instructions?: unknown; host?: unknown; viewerUrl?: unknown; inlineViewer?: unknown } | null;
  const instructions = typeof payload?.instructions === "string" && payload.instructions.trim() ? payload.instructions.trim() : "Complete the browser action.";
  const firstSentence = instructions.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/u, 1)[0];
  const summary = firstSentence.length > 100 ? `${firstSentence.slice(0, 97).trimEnd()}…` : firstSentence;
  const answer = useCallback((value: { done: boolean } | { reply: string }) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(false);
    void submit(value).catch(() => setError(true)).finally(() => { busyRef.current = false; setBusy(false); });
  }, [submit]);
  useEffect(() => registerChoiceHandler(index => {
    if (busyRef.current || replyOpen || index < 0 || index > 2) return false;
    if (index === 2) setReplyOpen(true); else answer({ done: index === 0 });
    return true;
  }), [registerChoiceHandler, answer, replyOpen]);
  const sendReply = () => { if (reply.trim()) answer({ reply: reply.trim() }); };
  return <div data-browser-handoff-card className="min-w-0 space-y-2 text-sm">
    <div className="flex min-w-0 flex-wrap items-start gap-2">
      <p className="min-w-0 flex-[1_1_16rem] truncate py-1.5 leading-5" title={firstSentence}>{summary}</p>
      <div className="flex shrink-0 items-center gap-1">
        {typeof payload?.viewerUrl === "string" && <a className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-state-hover" href={payload.viewerUrl} target="_blank" rel="noreferrer" aria-label="Open session" title="Open browser session"><ActionIcon name="external" /></a>}
        <span title="Done — action completed"><Button size="icon" className="size-8" disabled={busy} aria-label="Done" onClick={() => answer({ done: true })}><ActionIcon name="done" /></Button></span>
        <span title="Reply to agent"><Button size="icon" className="size-8" variant="ghost" disabled={busy} aria-label="Reply to agent" aria-expanded={replyOpen} onClick={() => setReplyOpen(!replyOpen)}><ActionIcon name="reply" /></Button></span>
        <span title="Cancel browser task"><Button size="icon" className="size-8" variant="ghost" disabled={busy} aria-label="Cancel" onClick={() => answer({ done: false })}><ActionIcon name="cancel" /></Button></span>
      </div>
    </div>
    <details className="min-w-0 text-xs text-muted-foreground">
      <summary className="w-fit cursor-pointer select-none"><span className="ml-1 inline-flex items-center gap-1.5 align-middle"><ActionIcon name="note" />Details</span></summary>
      <div className="space-y-1.5 pt-2"><p className="whitespace-pre-wrap break-words">{instructions}</p><p>Browser paused{typeof payload?.host === "string" ? ` · ${payload.host}` : ""}. Keep passwords and codes in the browser.</p></div>
    </details>
    {replyOpen && <form className="flex min-w-0 items-end gap-2" onSubmit={event => { event.preventDefault(); sendReply(); }}>
      <textarea autoFocus aria-label="Reply to agent" placeholder="Add context or give the agent a different direction…" maxLength={4000} rows={2} disabled={busy} className="min-w-0 flex-1 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50" value={reply} onChange={event => setReply(event.target.value)} onKeyDown={event => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); sendReply(); }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setReplyOpen(false); }
      }} />
      <span title="Send reply (Ctrl/⌘ Enter)"><Button size="icon" className="size-8 shrink-0" type="submit" disabled={busy || !reply.trim()} aria-label="Send reply"><ActionIcon name="send" /></Button></span>
    </form>}
    {payload?.inlineViewer === true && typeof payload.viewerUrl === "string" && <BrowserFrame url={payload.viewerUrl} />}
    {error && <p role="alert" className="text-xs text-destructive">Couldn’t save your answer. Try again.</p>}
  </div>;
}
