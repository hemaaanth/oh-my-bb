// Shared image/diagram shell. Gesture geometry is ported from GenUI (Apache-2.0).
import { createPortal } from "react-dom";
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus, X } from "./icons.generated.js";
import { focusRing, PORTAL_SCOPE } from "../ui.js";
import { usePaneBounds } from "./paneBounds.js";
import { usePanZoom } from "./panZoom.js";
import type { Size } from "./zoomMath.js";

export const lightboxImage = "block size-full max-h-none max-w-none object-contain";
const control = `grid size-9 shrink-0 cursor-pointer place-items-center rounded-md border border-border bg-background/90 text-foreground hover:bg-state-hover disabled:opacity-40 ${focusRing}`;
type Navigation = { index: number; count: number; go: (index: number) => void };

/** Fits natural image/SVG dimensions, then shares the same pan/zoom on touch and desktop. */
export function ZoomSurface({ children, content, inline = false, onBackdrop, onSwipe }: {
  children: ReactNode; content?: Size; inline?: boolean; onBackdrop?: () => void; onSwipe?: (dx: number, dy: number) => void;
}) {
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  const media = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<Size | null>(content ?? null);
  const [failed, setFailed] = useState(false);
  const size = content ?? natural;
  const zoom = usePanZoom(pane, {
    measure: () => {
      if (!pane || !size) return null;
      const rect = pane.getBoundingClientRect();
      return { left: rect.left, top: rect.top, pane: { width: pane.clientWidth, height: pane.clientHeight }, content: size };
    },
    draw: (placed) => { if (media.current) media.current.style.transform = `translate(${placed.x}px, ${placed.y}px) scale(${placed.scale})`; },
    plainWheel: !inline, doubleTap: true, onSwipe,
  });
  const measure = () => {
    if (content) return;
    const image = media.current?.querySelector("img");
    const svg = media.current?.querySelector("svg");
    const width = image?.naturalWidth || svg?.viewBox.baseVal.width || 0;
    const height = image?.naturalHeight || svg?.viewBox.baseVal.height || 0;
    if (width > 0 && height > 0) setNatural((last) => last?.width === width && last.height === height ? last : { width, height });
  };
  useLayoutEffect(() => {
    measure();
    if (!media.current) return;
    const observer = new MutationObserver(measure);
    observer.observe(media.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [children, content]);
  useLayoutEffect(() => {
    zoom.redraw();
    if (!pane) return;
    const observer = new ResizeObserver(zoom.redraw);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [pane, size, zoom.redraw]);
  const inlineStyle: CSSProperties | undefined = inline && size ? { aspectRatio: `${size.width}/${size.height}`, maxHeight: "32rem" } : undefined;
  return <div ref={setPane} data-pages-zoom="" className={`relative min-h-0 min-w-0 overflow-hidden select-none ${inline ? "w-full" : "flex-1"} ${zoom.zoomed ? "cursor-grab active:cursor-grabbing" : ""}`} style={{ ...inlineStyle, touchAction: inline && !zoom.zoomed ? "pan-y" : "none" }}
    onClick={(event) => { if (event.target === event.currentTarget) onBackdrop?.(); }}
    onKeyDown={(event) => {
      if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom.zoomBy(1.5); }
      else if (event.key === "-") { event.preventDefault(); zoom.zoomBy(1 / 1.5); }
      else if (event.key === "0") { event.preventDefault(); zoom.reset(); }
    }}>
    <div ref={media} data-pages-zoom-media="" onLoadCapture={measure} onErrorCapture={() => setFailed(true)}
      className="absolute left-0 top-0 origin-top-left [&_img]:h-full! [&_img]:max-h-none! [&_img]:w-full! [&_img]:max-w-none! [&_svg]:h-full! [&_svg]:w-full! [&_svg]:max-w-none!"
      style={size ? { width: size.width, height: size.height } : { visibility: "hidden" }}>{children}</div>
    {failed ? <p role="alert" className="absolute inset-0 m-0 grid place-items-center p-4 text-center text-sm">Could not load this image.</p> : !size ? <p role="status" className="absolute inset-0 m-0 grid place-items-center text-sm text-muted-foreground">Loading image…</p> : null}
    {!inline || zoom.zoomed ? <div role="group" aria-label="Zoom" className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-1 rounded-md bg-background/70 p-1 backdrop-blur-sm">
      <button type="button" aria-label="Zoom out" disabled={!zoom.zoomed || !size} onClick={() => zoom.zoomBy(1 / 1.5)} className={control}><Minus aria-hidden className="size-4" /></button>
      <button type="button" aria-label="Zoom in" disabled={!size} onClick={() => zoom.zoomBy(1.5)} className={control}><Plus aria-hidden className="size-4" /></button>
      <button type="button" aria-label="Reset zoom" disabled={!zoom.zoomed} onClick={zoom.reset} className={`${control} w-auto px-2 text-xs`}>Fit</button>
    </div> : null}
  </div>;
}

/** Native modal semantics, scoped styles, pane bounds, and return to the actual opener. */
export function Lightbox({ open, onClose, label, caption, nav, children, tone = "photo" }: {
  open: boolean; onClose: () => void; label: string; caption?: ReactNode; nav?: Navigation; children: ReactNode; tone?: "photo" | "page";
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const bounds = usePaneBounds(anchor, open);
  const many = nav !== undefined && nav.count > 1;
  const step = (by: number) => { if (many) nav.go((nav.index + by + nav.count) % nav.count); };
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    const root = anchor.current?.getRootNode();
    const opener = (root instanceof ShadowRoot ? root.activeElement : document.activeElement) as HTMLElement | null;
    element.showModal();
    return () => { element.close(); if (opener?.isConnected) opener.focus(); };
  }, [open]);
  const root = anchor.current?.getRootNode();
  const portal = root instanceof ShadowRoot ? root : document.body;
  return <><span ref={anchor} hidden />{open ? createPortal(<dialog ref={dialog} {...PORTAL_SCOPE} data-bb-image-preview-ignore="" aria-label={label} aria-modal="true"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); event.stopPropagation(); }}
    onKeyDown={(event) => { event.stopPropagation(); if (many && (event.key === "ArrowLeft" || event.key === "ArrowRight")) { event.preventDefault(); step(event.key === "ArrowLeft" ? -1 : 1); } }}
    className={`fixed m-0 max-h-none max-w-none overflow-hidden border-0 p-0 outline-none backdrop:bg-black/50 open:flex open:flex-col ${tone === "photo" ? "bg-black/95 text-white" : "bg-background text-foreground"}`}
    style={bounds ? { ...bounds, right: "auto", bottom: "auto" } : { inset: 0, width: "100vw", height: "100dvh" }}>
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 px-3">
      <span className="min-w-0 truncate text-xs opacity-75">{many ? `${nav.index + 1} / ${nav.count}` : label}</span>
      <button type="button" aria-label="Close image preview" onClick={onClose} className={control}><X aria-hidden className="size-4" /></button>
    </header>
    <div className="relative flex min-h-0 flex-1">
      <ZoomSurface key={`${label}:${nav?.index ?? 0}`} onBackdrop={onClose} onSwipe={(dx, dy) => {
        if (many && Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
        else if (dy > 96 && dy > Math.abs(dx) * 1.5) onClose();
      }}>{children}</ZoomSurface>
      {many ? <><button type="button" aria-label="Previous image" onClick={() => step(-1)} className={`absolute top-1/2 left-3 -translate-y-1/2 ${control}`}><ChevronLeft aria-hidden className="size-4" /></button>
        <button type="button" aria-label="Next image" onClick={() => step(1)} className={`absolute top-1/2 right-3 -translate-y-1/2 ${control}`}><ChevronRight aria-hidden className="size-4" /></button></> : null}
    </div>
    {caption ? <div className="max-h-[25%] shrink-0 overflow-y-auto px-4 py-3 text-center text-sm opacity-80">{caption}</div> : null}
  </dialog>, portal) : null}</>;
}

export function Zoomable({ src, alt, caption, className, children }: { src: string; alt: string; caption?: string; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" aria-haspopup="dialog" aria-label={`${alt ? `${alt}. ` : ""}Open full-size image`} onClick={() => setOpen(true)} className={`block max-w-full cursor-zoom-in border-0 bg-transparent p-0 text-left ${focusRing} ${className ?? "w-fit rounded-md"}`}>{children}</button>
    <Lightbox open={open} onClose={() => setOpen(false)} label={alt || "Image preview"} caption={caption || alt}><img src={src} alt={alt} draggable={false} className={lightboxImage} /></Lightbox></>;
}

export function ZoomDiagram({ width, height, label, children }: { width: number; height: number; label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <div className="relative min-w-0">
    <ZoomSurface inline content={{ width, height }}>{children}</ZoomSurface>
    <button type="button" aria-label="Expand diagram" onClick={() => setOpen(true)} className={`absolute top-1 right-1 ${control}`}><Maximize2 aria-hidden className="size-4" /></button>
    <Lightbox open={open} onClose={() => setOpen(false)} label={label} tone="page">{children}</Lightbox>
  </div>;
}
