import { useCallback, useEffect, useId, useState } from "react";
import { experimental_useQuestionFormHost, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import {BrowserFrame} from "./browser-live";
import { Button } from "./ui/button";

export function BrowserHandoff({ interaction, submit }: PluginPendingInteractionProps) {
  const { registerChoiceHandler } = experimental_useQuestionFormHost();
  const detailsId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [details, setDetails] = useState(false);
  const payload = interaction.payload as { instructions?: unknown; host?: unknown; viewerUrl?: unknown;inlineViewer?:unknown } | null;
  const instructions = typeof payload?.instructions === "string" && payload.instructions.trim()
    ? payload.instructions.trim() : "Complete the browser action.";
  const firstSentence = instructions.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/u, 1)[0];
  const summary = firstSentence.length > 100 ? `${firstSentence.slice(0, 97).trimEnd()}…` : firstSentence;
  const answer = useCallback((done: boolean) => {
    if (busy) return;
    setBusy(true); setError(false);
    void submit({done}).catch(() => setError(true)).finally(() => setBusy(false));
  }, [submit, busy]);
  useEffect(() => registerChoiceHandler(index => {
    if (busy || (index !== 0 && index !== 1)) return false;
    answer(index === 0); return true;
  }), [registerChoiceHandler, answer, busy]);
  return <div className="space-y-2 text-sm">
    <div className="flex min-w-0 items-center gap-2">
      <p className="min-w-0 flex-1 truncate" title={firstSentence}>{summary}</p>
      {typeof payload?.viewerUrl === "string" && <a className="shrink-0 underline" href={payload.viewerUrl} target="_blank" rel="noreferrer">Open session</a>}
      <Button size="sm" disabled={busy} onClick={() => answer(true)}>Done</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => answer(false)}>Cancel</Button>
      <Button size="sm" variant="ghost" aria-expanded={details} aria-controls={detailsId} onClick={() => setDetails(!details)}>Details</Button>
    </div>
    {payload?.inlineViewer===true&&typeof payload.viewerUrl==="string"&&<BrowserFrame url={payload.viewerUrl}/>}
    {details && <div id={detailsId} className="space-y-2 text-xs text-muted-foreground">
      <p className="whitespace-pre-wrap">{instructions}</p>
      <p>Automation is paused.{typeof payload?.host === "string" ? ` Browser: ${payload.host}.` : ""} Keep passwords and codes in the browser.</p>
    </div>}
    {error && <p role="alert" className="text-xs text-destructive">Couldn’t save your answer. Try again.</p>}
  </div>;
}
