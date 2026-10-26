import { useEffect, useMemo, useState } from "react";
import { changedRegions, DEFAULT_TOLERANCE, diffGrid, formatPixelShare, MAX_TOLERANCE, pixelDiff, viewOfRegion, type Region } from "../compare-logic.js";
import { useImageResource } from "../image-resource.js";
import { field, focusRing } from "../kit.js";
import { Lightbox, Zoomable } from "../viewer.js";
import { placeImage } from "../zoomMath.js";
import { conditionDifferences, conditionsWarning, placement, readCompare, sizeWarning, type CompareImage } from "./compare.js";
import { ReportDetails, ReportError, ReportTitle } from "./reportUi.js";
import type { Value } from "./types.js";
import { useAnimationsOff } from "../motion.js";

const modes = { side: "Side by side", wipe: "Wipe", blink: "Blink", difference: "Difference" } as const;
type Mode = keyof typeof modes;

function ImageComparison({ images, title, initialMode }: { images: readonly CompareImage[]; title?: string; initialMode?: string }) {
  const [index, setIndex] = useState(1);
  const [mode, setMode] = useState<Mode>(initialMode && Object.hasOwn(modes, initialMode) ? initialMode as Mode : "side");
  const [reveal, setReveal] = useState(50);
  const [tolerance, setTolerance] = useState(DEFAULT_TOLERANCE);
  const [open, setOpen] = useState(false);
  const [region, setRegion] = useState<Region | null>(null);
  const motionOff = useAnimationsOff();
  const [blinking, setBlinking] = useState(true);
  const [showCandidate, setShowCandidate] = useState(false);
  useEffect(() => {
    if (mode !== "blink" || motionOff || !blinking) return;
    const timer = window.setInterval(() => setShowCandidate(value => !value), 700);
    return () => window.clearInterval(timer);
  }, [mode, motionOff, blinking]);
  const reference = images[0]!;
  const selectedIndex = Math.max(1, Math.min(index, images.length - 1));
  const candidate = images[selectedIndex] ?? reference;
  const a = useImageResource(reference.src);
  const loadedB = useImageResource(candidate.src === reference.src ? undefined : candidate.src);
  const b = candidate.src === reference.src ? a : loadedB;
  const frames = useMemo(() => {
    if (!a?.image || !b?.image || images.length < 2) return null;
    try {
      const size = diffGrid({ width: a.image.naturalWidth, height: a.image.naturalHeight });
      const fit = placement({ width: a.image.naturalWidth, height: a.image.naturalHeight }, { width: b.image.naturalWidth, height: b.image.naturalHeight });
      const candidateHeight = fit.height * size.width / a.image.naturalWidth;
      if (mode !== "difference") return { size, candidateHeight, before: null, after: null };
      const canvas = document.createElement("canvas");
      canvas.width = size.width; canvas.height = size.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("A 2D canvas is not available.");
      context.drawImage(a.image, 0, 0, size.width, size.height);
      const before = context.getImageData(0, 0, size.width, size.height);
      context.clearRect(0, 0, size.width, size.height);
      context.drawImage(b.image, 0, 0, size.width, fit.height * size.width / a.image.naturalWidth);
      return { size, before, after: context.getImageData(0, 0, size.width, size.height), candidateHeight };
    } catch (error) { return { error: error instanceof Error ? error.message : "Could not read the screenshot pixels." }; }
  }, [a?.image, b?.image, images.length, mode === "difference"]);
  const diff = useMemo(() => {
    if (!frames || "error" in frames || !frames.before || !frames.after) return null;
    const { width, height } = frames.size;
    const result = pixelDiff(frames.before.data, frames.after.data, width, height, tolerance);
    const regions = changedRegions(result.mask, width, height);
    const output = new Uint8ClampedArray(frames.before.data);
    for (let pixel = 0; pixel < result.total; pixel++) {
      const at = pixel * 4;
      if (result.mask[pixel]) { output[at] = 255; output[at + 1] = 84; output[at + 2] = 0; output[at + 3] = 235; }
      else output[at + 3] = Math.round(output[at + 3]! * 0.35);
    }
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.putImageData(new ImageData(output, width, height), 0, 0);
    return { ...regions, changed: result.changed, total: result.total, url: canvas.toDataURL("image/png") };
  }, [frames, tolerance]);
  if (a?.error || b?.error) return <ReportError message={a?.error ?? b?.error ?? "Could not load screenshots."} />;
  if (!a?.image || !b?.image) return <p role="status" className="m-0 text-xs text-muted-foreground">Loading screenshots…</p>;
  if (images.length < 2) return <div className="flex min-w-0 flex-col gap-2"><ReportTitle title={title} /><Zoomable src={a.image.src} alt={reference.label}><img src={a.image.src} alt={reference.label} className="max-h-96 max-w-full object-contain" /></Zoomable><p className="m-0 text-xs text-muted-foreground">Add a second screenshot to compare changes.</p></div>;
  if (!frames) return null;
  if ("error" in frames) return <ReportError message={frames.error ?? "Could not read the screenshot pixels."} />;
  const { width, height } = frames.size;
  const warning = conditionsWarning(conditionDifferences(reference, candidate), reference.label, candidate.label);
  const dimensions = sizeWarning({ width: a.image.naturalWidth, height: a.image.naturalHeight }, { width: b.image.naturalWidth, height: b.image.naturalHeight }, candidate.label);
  const beforeImage = <image href={a.image.src} width={width} height={height} />;
  const afterImage = <image href={b.image.src} width={width} height={frames.candidateHeight} />;
  const picture = <svg viewBox={`0 0 ${mode === "side" ? width * 2 + 12 : width} ${height}`} aria-label={`${reference.label} compared with ${candidate.label}`} className="block max-h-[32rem] w-full rounded-md">
    {mode === "difference" && diff ? <image href={diff.url} width={width} height={height} /> : mode === "wipe" ? <>{beforeImage}<g style={{ clipPath: `inset(0 ${100 - reveal}% 0 0)` }}>{afterImage}</g><line x1={width * reveal / 100} x2={width * reveal / 100} y2={height} stroke="var(--primary)" strokeWidth={Math.max(1, width / 400)} /></> : mode === "blink" ? showCandidate ? afterImage : beforeImage : <>{beforeImage}<g transform={`translate(${width + 12},0)`}>{afterImage}</g></>}
  </svg>;
  const regionPlacement = region ? placeImage(viewOfRegion(region, { width: 800, height: 600 }, { width, height }), { width: 800, height: 600 }, { width, height }) : null;
  return <div className="flex min-w-0 flex-col gap-3">
    <ReportTitle title={title} />
    {images.length > 2 ? <label className="flex min-w-0 items-center gap-3 text-xs">Compare with<select aria-label="Comparison screenshot" value={selectedIndex} onChange={event => { const value = Number(event.target.value); if (event.target.value && Number.isInteger(value) && value > 0 && value < images.length) { setIndex(value); setRegion(null); } }} className={`${field} h-7 min-w-0 flex-1 py-1`}>{images.slice(1).map((image, position) => <option key={`${image.src}:${position}`} value={position + 1}>{image.label}</option>)}</select></label> : null}
    <div role="group" aria-label="Screenshot comparison view" className="flex flex-wrap gap-3">{(Object.keys(modes) as Mode[]).map(value => <button key={value} type="button" aria-pressed={mode === value} onClick={() => { setMode(value); setRegion(null); setShowCandidate(false); if (value === "blink") setBlinking(true); }} className={`rounded-sm text-xs ${mode === value ? "text-foreground underline underline-offset-4" : "text-muted-foreground"} ${focusRing}`}>{modes[value]}</button>)}</div>
    {warning || dimensions ? <p className="m-0 text-xs text-warning">{[warning, dimensions].filter(Boolean).join(". ")}</p> : null}
    <p className="m-0 flex min-w-0 justify-between gap-3 text-xs text-muted-foreground"><span className="min-w-0 break-words">{reference.label}</span><span className="min-w-0 break-words text-right">{candidate.label}</span></p>
    <button type="button" aria-label="Expand screenshot comparison" aria-haspopup="dialog" onClick={() => { setRegion(null); setOpen(true); }} className={`min-w-0 cursor-zoom-in rounded-md bg-muted/30 p-0 ${focusRing}`}>{picture}</button>
    {mode === "wipe" ? <label className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">Reveal<input type="range" aria-label="Reveal comparison screenshot" min={0} max={100} value={reveal} onChange={event => setReveal(event.target.valueAsNumber)} className="min-w-0 flex-1 accent-primary" /><span className="w-10 text-right tabular-nums">{reveal}%</span></label> : null}
    {mode === "blink" ? <div className="flex flex-wrap items-center gap-3 text-xs"><span className="text-muted-foreground">{showCandidate ? candidate.label : reference.label}</span>{!motionOff ? <button type="button" onClick={() => setBlinking(!blinking)} className={`rounded-sm text-primary ${focusRing}`}>{blinking ? "Pause blink" : "Resume blink"}</button> : null}<button type="button" onClick={() => { setBlinking(false); setShowCandidate(!showCandidate); }} className={`rounded-sm text-primary ${focusRing}`}>Show {showCandidate ? reference.label : candidate.label}</button></div> : null}
    {mode === "difference" ? <>
      <label className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">Tolerance<input type="range" aria-label="Pixel difference tolerance" min={0} max={MAX_TOLERANCE} value={tolerance} onChange={event => setTolerance(event.target.valueAsNumber)} className="min-w-0 flex-1 accent-primary" /><span className="w-6 text-right tabular-nums">{tolerance}</span></label>
      {diff ? <p role="status" className="m-0 text-xs">{formatPixelShare(diff.changed, diff.total)} changed · {diff.changed.toLocaleString()} of {diff.total.toLocaleString()} pixels{frames.size.scale < 1 ? ` · compared at ${width}×${height}, scaled down from the reference` : ""}</p> : <ReportError message="Could not draw the pixel difference." />}
      {diff?.regions.length ? <ReportDetails summary={<span className="text-xs">{diff.regions.length} changed regions{diff.more ? ` · ${diff.more} more` : ""}</span>}><div className="flex flex-wrap gap-2">{diff.regions.map((area, position) => <button key={position} type="button" aria-label={`Inspect changed region ${position + 1}`} onClick={() => { setRegion(area); setOpen(true); }} className={`rounded-md border border-border px-2 py-1 text-xs ${focusRing}`}>{position + 1}: {area.width}×{area.height} at {area.x},{area.y}</button>)}</div></ReportDetails> : null}
    </> : null}
    {reference.meta.length || candidate.meta.length || reference.note || candidate.note ? <ReportDetails summary={<span className="text-xs">Capture details</span>}>{[reference, candidate].map((image, position) => <section key={position}><h4 className="m-0 mb-2 font-medium">{image.label}</h4>{image.note ? <p className="m-0 mb-2 whitespace-pre-wrap">{image.note}</p> : null}<dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">{image.meta.map(([key, value]) => <div key={key} className="contents"><dt className="text-muted-foreground">{key}</dt><dd className="m-0 break-words">{value}</dd></div>)}</dl></section>)}</ReportDetails> : null}
    <Lightbox open={open} onClose={() => setOpen(false)} label={region ? "Changed screenshot region" : "Screenshot comparison"} caption={region ? `${region.pixels} changed pixels · region ${region.x},${region.y}` : `${reference.label} / ${candidate.label}`} tone="page">{regionPlacement && diff ? <svg viewBox={`${-regionPlacement.x / regionPlacement.scale} ${-regionPlacement.y / regionPlacement.scale} ${800 / regionPlacement.scale} ${600 / regionPlacement.scale}`}><image href={diff.url} width={width} height={height} /></svg> : picture}</Lightbox>
  </div>;
}

export function CompareView({ images, title, mode }: { images: unknown; title?: string; mode?: string }) {
  const parsed = useMemo(() => readCompare(images as Value), [images]);
  if (!parsed.ok) return <ReportError message={parsed.error} />;
  return parsed.images.length ? <ImageComparison images={parsed.images} title={title} initialMode={mode} /> : <p className="m-0 text-xs text-muted-foreground">No comparison images.</p>;
}
