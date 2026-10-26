import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useHost } from "../host.js";
import { NO_BB_SWIPE } from "../gpu/style.js";
import { field, focusRing } from "../kit.js";
import { analyse, columns, countsText, describeRegion, formatClock, formatWer, laneIndex, parseClock, placeTracks, readTracks, tickStep, visibleSlice, type Analysis } from "./transcript.js";
import { ReportDetails, ReportError, ReportTitle } from "./reportUi.js";
import type { Value } from "./types.js";

const marks: Record<string, string> = { ok: "", sub: "bg-warning/15 text-warning", ins: "bg-primary/15 text-primary", del: "bg-destructive/15 text-destructive" };

function TranscriptComparison({ analysis, title, audio }: { analysis: Analysis; title?: string; audio?: string }) {
  const host = useHost();
  const player = useRef<HTMLAudioElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<{ path: string; url?: string; error?: string }>();
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [view, setView] = useState<"text" | "timeline">("text");
  const [pps, setPps] = useState(80);
  const [viewport, setViewport] = useState({ left: 0, width: 600 });
  const previousScale = useRef(pps);
  const [jump, setJump] = useState("");
  const aligned = useMemo(() => columns(analysis), [analysis]);
  const placed = useMemo(() => placeTracks(analysis), [analysis]);
  const indexes = useMemo(() => placed.map(lane => lane ? laneIndex(lane) : null), [placed]);
  const span = useMemo(() => Math.max(1, ...analysis.tracks.map(track => track.words.reduce((end, word) => Math.max(end, word.end ?? 0), 0))), [analysis]);
  const timed = placed.some(lane => lane !== null);
  const activeRegion = selected === null ? null : analysis.regions[selected] ?? null;
  useEffect(() => {
    if (!audio) return;
    let active = true, url: string | undefined;
    setMediaError(null);
    void host.loadAsset(audio).then(asset => {
      if (!active) return;
      if (!asset.ok) { setSource({ path: audio, error: asset.error }); return; }
      if (!asset.type.startsWith("audio/")) { setSource({ path: audio, error: "The recording is not a supported audio file." }); return; }
      url = URL.createObjectURL(new Blob([asset.bytes], { type: asset.type }));
      setSource({ path: audio, url });
    }, error => { if (active) setSource({ path: audio, error: error instanceof Error ? error.message : "Could not load the recording." }); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [audio, host.loadAsset]);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const update = () => setViewport({ left: element.scrollLeft, width: element.clientWidth });
    const observer = new ResizeObserver(update); observer.observe(element); update();
    return () => observer.disconnect();
  }, [view]);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pps !== previousScale.current) element.scrollLeft = Math.max(0, (element.scrollLeft + element.clientWidth / 2) / previousScale.current * pps - element.clientWidth / 2);
    previousScale.current = pps;
  }, [pps]);
  const go = (time: number, play = false) => {
    const target = Math.max(0, time);
    setCursor(target);
    const element = player.current;
    if (element) {
      element.currentTime = Number.isFinite(element.duration) ? Math.min(target, element.duration) : target;
      if (play) void element.play().catch(error => setMediaError(error instanceof Error ? error.message : "Could not play this recording."));
    }
  };
  const selectRegion = (index: number) => {
    const region = analysis.regions[index];
    if (!region) return;
    setSelected(index);
    if (region.start !== null) { go(region.start); if (scroller.current) scroller.current.scrollLeft = Math.max(0, region.start * pps - viewport.width / 3); }
    const column = aligned.findIndex(item => region.ref !== null && item.ref !== null && item.ref >= region.ref[0] && item.ref <= region.ref[1] || region.hyp !== null && item.hyp[region.track - 1]?.some(word => word >= region.hyp![0] && word <= region.hyp![1]));
    if (column >= 0) setPage(Math.floor(column / 40));
  };
  const word = (trackIndex: number, wordIndex: number) => {
    const item = analysis.tracks[trackIndex]!.words[wordIndex]!;
    const comparison = analysis.comparisons[trackIndex - 1];
    const status = comparison?.hypStatus[wordIndex] ?? (analysis.comparisons.some(other => other.refStatus[wordIndex] === "del") ? "del" : analysis.comparisons.some(other => other.refStatus[wordIndex] === "sub") ? "sub" : "ok");
    const speakerWrong = comparison?.speakerWrong[wordIndex];
    const time = item.start ?? placed[trackIndex]?.[wordIndex]?.start ?? null;
    const info = [item.speaker, time !== null ? formatClock(time) : "Untimed", item.timing === "segment" ? "Approximate segment timing" : item.timing === "none" && time !== null ? "Aligned timing, not measured" : null, item.confidence !== null ? `${Math.round(item.confidence * 100)}% confidence` : null].filter(Boolean).join(" · ");
    return <button key={wordIndex} type="button" title={info} onClick={() => {
      if (time !== null) go(time, Boolean(player.current));
      const region = analysis.regions.findIndex(region => trackIndex === 0 ? region.ref !== null && wordIndex >= region.ref[0] && wordIndex <= region.ref[1] : region.track === trackIndex && region.hyp !== null && wordIndex >= region.hyp[0] && wordIndex <= region.hyp[1]);
      if (region >= 0) setSelected(region);
    }} className={`max-w-full rounded-sm px-1 py-0.5 text-left text-xs ${marks[status]} ${speakerWrong ? "underline decoration-destructive decoration-wavy" : ""} ${focusRing}`}>{item.text}<span className="sr-only"> · {info}{status !== "ok" ? ` · ${status === "sub" ? "Misheard" : status === "ins" ? "Extra word" : "Missing word"}` : ""}{speakerWrong ? " · Wrong speaker" : ""}</span></button>;
  };
  const firstColumn = Math.min(page, Math.max(0, Math.ceil(aligned.length / 40) - 1)) * 40;
  const from = Math.max(0, viewport.left / pps - 1), to = (viewport.left + viewport.width) / pps + 1;
  const step = tickStep(pps);
  return <div className="flex min-w-0 flex-col gap-3">
    <ReportTitle title={title} />
    <div className="flex min-w-0 flex-wrap gap-3">{analysis.comparisons.map(comparison => <div key={comparison.track} className="min-w-0 text-xs"><strong className="font-medium">{analysis.tracks[comparison.track]!.name}</strong><span className="ml-2 tabular-nums">{comparison.wer === null ? "No reference words to score" : `${formatWer(comparison.wer)} word error rate`}</span><p className="m-0 mt-1 text-muted-foreground">{countsText(comparison.counts)}</p></div>)}</div>
    {audio ? source?.path !== audio ? <p role="status" className="m-0 text-xs text-muted-foreground">Loading recording…</p> : source.error ? <ReportError message={source.error} /> : <audio key={source.url} ref={player} src={source.url} controls preload="metadata" className="h-9 w-full" onTimeUpdate={event => setCursor(event.currentTarget.currentTime)} onError={() => setMediaError("The browser could not play this audio format.")} /> : null}
    {mediaError ? <ReportError message={mediaError} /> : null}
    <div className="flex min-w-0 flex-wrap items-center gap-3 text-xs">
      {timed ? <div role="group" aria-label="Transcript view" className="flex gap-3">{(["text", "timeline"] as const).map(mode => <button key={mode} type="button" aria-pressed={view === mode} onClick={() => setView(mode)} className={`rounded-sm ${view === mode ? "text-foreground underline underline-offset-4" : "text-muted-foreground"} ${focusRing}`}>{mode === "text" ? "Aligned text" : "Timeline"}</button>)}</div> : null}
      <button type="button" aria-label="Previous transcript error" disabled={!analysis.regions.length || selected === 0} onClick={() => selectRegion(selected === null ? 0 : selected - 1)} className={`rounded-sm text-muted-foreground disabled:opacity-40 ${focusRing}`}>Previous error</button>
      <span role="status" className="tabular-nums text-muted-foreground">{selected === null ? `${analysis.regions.length} ${analysis.regions.length === 1 ? "error" : "errors"}` : `Error ${selected + 1} of ${analysis.regions.length}`}</span>
      <button type="button" aria-label="Next transcript error" disabled={!analysis.regions.length || selected === analysis.regions.length - 1} onClick={() => selectRegion(selected === null ? 0 : selected + 1)} className={`rounded-sm text-muted-foreground disabled:opacity-40 ${focusRing}`}>Next error</button>
      {timed ? <form onSubmit={event => { event.preventDefault(); const time = parseClock(jump); if (time !== null) { go(time); if (scroller.current) scroller.current.scrollLeft = Math.max(0, time * pps - viewport.width / 3); } }} className="flex min-w-0 items-center gap-2"><input aria-label="Jump to transcript time" placeholder="m:ss" value={jump} onChange={event => setJump(event.target.value)} className={`${field} h-7 w-20 py-1 text-xs`} /><button type="submit" disabled={parseClock(jump) === null} className={`rounded-sm text-primary disabled:opacity-40 ${focusRing}`}>Go</button></form> : null}
    </div>
    {activeRegion ? <p className="m-0 break-words text-xs">{analysis.tracks[activeRegion.track]!.name}: {describeRegion(activeRegion)}{activeRegion.start !== null ? ` · ${formatClock(activeRegion.start)}` : ""}</p> : null}
    {view === "timeline" && timed ? <>
      <label className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">Timeline zoom<input type="range" aria-label="Transcript timeline zoom" min={20} max={400} step={10} value={pps} onChange={event => setPps(event.target.valueAsNumber)} className="min-w-0 flex-1 accent-primary" /></label>
      <div ref={scroller} {...NO_BB_SWIPE} onScroll={event => setViewport({ left: event.currentTarget.scrollLeft, width: event.currentTarget.clientWidth })} className="min-w-0 overflow-x-auto rounded-md border border-border">
        <div className="relative min-w-full" style={{ width: span * pps + 16 }}><div className="relative h-6 border-b border-border-hairline">{Array.from({ length: Math.ceil((to - from) / step) + 1 }, (_, index) => Math.floor(from / step) * step + index * step).filter(time => time <= span).map(time => <span key={time} className="absolute top-1 text-[10px] tabular-nums text-muted-foreground" style={{ left: time * pps }}>{formatClock(time, false)}</span>)}</div>
          {analysis.tracks.map((track, trackIndex) => {
            const positions = placed[trackIndex], indexed = indexes[trackIndex];
            const [first, last] = indexed ? visibleSlice(indexed, from, to) : [0, 0];
            return <div key={trackIndex} className="relative h-20 border-b border-border-hairline last:border-b-0"><span className="sticky left-0 top-0 z-10 block w-fit max-w-48 truncate bg-background/90 px-2 text-[10px] text-muted-foreground">{track.name}</span>{indexed && positions ? indexed.order.slice(first, last).map(wordIndex => { const position = positions[wordIndex]!; return <div key={wordIndex} className="absolute top-6 overflow-hidden" style={{ left: position.start * pps, width: Math.max(16, (position.end - position.start) * pps) }}>{word(trackIndex, wordIndex)}</div>; }) : <span className="sticky left-2 text-xs text-muted-foreground">No timed words</span>}</div>;
          })}<span aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-primary" style={{ left: cursor * pps }} />
        </div>
      </div><p className="m-0 text-xs text-muted-foreground">Segment and aligned timings are estimates, not measured word boundaries.</p>
    </> : <>
      <div {...NO_BB_SWIPE} className="min-w-0 overflow-x-auto rounded-md border border-border"><table className="border-collapse text-xs"><tbody>{analysis.tracks.map((track, trackIndex) => <tr key={trackIndex}><th scope="row" className="sticky left-0 z-10 max-w-40 min-w-28 border-b border-border-hairline bg-background p-2 text-left align-top font-medium">{track.name}</th>{aligned.slice(firstColumn, firstColumn + 40).map((column, columnIndex) => <td key={firstColumn + columnIndex} className="min-w-10 border-b border-border-hairline px-1 py-2 align-top">{trackIndex === 0 ? column.ref !== null ? word(0, column.ref) : <span className="sr-only">Insertion</span> : column.hyp[trackIndex - 1]?.length ? column.hyp[trackIndex - 1]!.map(index => word(trackIndex, index)) : column.ref !== null ? <span className="text-destructive" aria-label="Missing word">∅</span> : null}</td>)}</tr>)}</tbody></table></div>
      {aligned.length > 40 ? <div className="flex items-center justify-between gap-3 text-xs"><button type="button" disabled={firstColumn === 0} onClick={() => setPage(Math.max(0, page - 1))} className={`rounded-sm disabled:opacity-40 ${focusRing}`}>Previous words</button><span className="text-muted-foreground">{firstColumn + 1}–{Math.min(firstColumn + 40, aligned.length)} of {aligned.length}</span><button type="button" disabled={firstColumn + 40 >= aligned.length} onClick={() => setPage(page + 1)} className={`rounded-sm disabled:opacity-40 ${focusRing}`}>Next words</button></div> : null}
    </>}
    <ReportDetails summary={<span className="text-xs">Track details and scoring</span>}><p className="m-0 text-muted-foreground">The first track is the reference. Word error rate counts substitutions, missing words, and extra words. Speaker labels are mapped before counting speaker errors. No audio is transcribed here.</p>{analysis.tracks.map((track, index) => <div key={index}><strong className="font-medium">{track.name}</strong><p className="m-0 text-muted-foreground">{track.words.length.toLocaleString()} words · {track.source} · {track.timing === "none" ? "untimed" : `${track.timing} timing`}{track.untimed ? ` · ${track.untimed} invalid timestamps left untimed` : ""}{track.detail ? ` · ${track.detail}` : ""}</p></div>)}</ReportDetails>
  </div>;
}

export function TranscriptView({ tracks, title, audio }: { tracks: unknown; title?: string; audio?: string }) {
  const read = useMemo(() => readTracks(tracks as Value), [tracks]);
  const analysis = useMemo(() => read.ok ? analyse(read.tracks) : null, [read]);
  if (!read.ok) return <ReportError message={read.error} />;
  return analysis ? <TranscriptComparison analysis={analysis} title={title} audio={audio} /> : <p className="m-0 text-xs text-muted-foreground">No transcript words.</p>;
}
