// Media: maps, galleries, before/after pictures, hotspots, and web image search. Map tiles, place names, photo search,
// and remote pictures all come through useHost().web, so chat never loads a third-party URL itself. When a lookup fails
// or is off, the component says so quietly and still draws what it can.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from "react";
import { defineComponent, useIsStreaming } from "@openuidev/react-lang";
import { ArrowUpRight, Image as ImageIcon, Maximize2, Minus, Plus, X } from "../icons.generated.js";
import type { IconComponent } from "../glyph.js";
import { z } from "zod";
import { childProps, focusRing, type Group } from "../kit.js";
import { Lightbox, lightboxImage, Zoomable } from "../viewer.js";
import { useHost, type Host, type WebMethod } from "../host.js";
import {
  autoColumns, centroid, clampView, latLng, lightText, MAP_FALLBACK_SIZE, mapNear, mapView, MAX_ZOOM, MIN_ZOOM, pan, pinPercent, placeKey, project, searchInput, toScreen, visibleTiles, zoomAround,
  type LatLng, type Size, type Tile, type View,
} from "./media-logic.js";
import { mapMarkers } from "../map-input.js";
import { useTour } from "../map-tour.js";
import { useAnimationsOff } from "../motion.js";
import { useImageResource } from "../image-resource.js";
import { NO_BB_SWIPE } from "../gpu/style.js";

// --- Web lookups: one session cache per host kind, shared by every component and remount. ---

type Asked = { promise: Promise<unknown>; value?: unknown; error?: string; at: number };
const asked = new Map<string, Asked>();
const ASKED_CAP = 600;
const RETRY_MS = 30_000;
const failure = (error: unknown) => error instanceof Error && error.message ? error.message : "That lookup failed.";
const askKey = (host: Host, method: WebMethod, input: Record<string, unknown>) => `${host.kind}|${method}|${JSON.stringify(input)}`;

/** Starts a lookup, or joins the cached one. A failure is retried once it is RETRY_MS old. */
function ask(host: Host, method: WebMethod, input: Record<string, unknown>): Asked {
  const key = askKey(host, method, input);
  const hit = asked.get(key);
  if (hit && !(hit.error !== undefined && Date.now() - hit.at > RETRY_MS)) { asked.delete(key); asked.set(key, hit); return hit; }
  const entry: Asked = {
    at: Date.now(),
    promise: Promise.resolve().then(() => host.web(method, input)).then(
      (value) => { entry.value = value; return value; },
      (error: unknown) => { entry.error = failure(error); entry.at = Date.now(); throw error; }),
  };
  entry.promise.catch(() => {});
  asked.set(key, entry);
  if (asked.size > ASKED_CAP) asked.delete(asked.keys().next().value as string);
  return entry;
}

/** A lookup's answer for rendering; null input asks nothing. Known answers show on the first render, so panned-to tiles never flash. */
function useAsk<T>(method: WebMethod, input: Record<string, unknown> | null): { value?: T; error?: string } {
  const host = useHost();
  const key = input ? JSON.stringify(input) : "";
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!input) return;
    let live = true;
    const entry = ask(host, method, input);
    if (entry.value === undefined && entry.error === undefined) entry.promise.then(() => { if (live) rerender((n) => n + 1); }, () => { if (live) rerender((n) => n + 1); });
    return () => { live = false; };
  }, [host, method, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const known = input ? asked.get(askKey(host, method, input)) : undefined;
  return known ? { value: known.value as T | undefined, error: known.error } : {};
}

const dataImage = /^data:image\/[a-z0-9.+-]+[;,]/iu;
function webHref(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try { const url = new URL(raw.trim()); return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? url.href : null; } catch { return null; }
}
const openWith = (openUrl: (url: string) => void, href: string) => (event: MouseEvent) => { event.preventDefault(); openUrl(href); };

/** A picture src to show: a data: image as is; http(s) through the Pages image lookup, except on a published page, which has no lookups and loads it directly. */
function useImage(raw: unknown): { src?: string; error?: string } {
  const host = useHost();
  const text = typeof raw === "string" ? raw.trim() : "";
  const remote = !dataImage.test(text) && webHref(text) !== null;
  const proxy = remote && host.kind !== "page";
  const answer = useAsk<{ dataUrl?: unknown }>("image", proxy ? { url: text } : null);
  if (!text) return {};
  if (!proxy) return remote || dataImage.test(text) ? { src: text } : { error: "That picture isn't an http(s) or data: image." };
  return typeof answer.value?.dataUrl === "string" ? { src: answer.value.dataUrl } : { error: answer.error };
}

/** An image that may need the lookup. While it loads, a muted box of the same shape (`box`, else `className`); if it fails, the box says so, or nothing when `quiet`. */
function Picture({ src: raw, alt, className, box, quiet }: { src: unknown; alt: string; className: string; box?: string; quiet?: boolean }) {
  const { src, error } = useImage(raw);
  const [broken, setBroken] = useState<string>();
  if (src && broken !== src) return <img src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" draggable={false} onError={() => setBroken(src)} className={className} />;
  if (quiet) return null;
  const failed = error !== undefined || src !== undefined;
  return <div role="img" aria-label={alt || "Image"} aria-busy={failed ? undefined : true} title={error} className={`${box ?? className} flex items-center justify-center bg-muted p-2 text-center text-sm text-muted-foreground`}>
    {failed ? <span><ImageIcon aria-hidden className="mr-1.5 inline size-[1em] align-[-0.125em]" />{alt || "Image unavailable"}</span> : null}
  </div>;
}

/** True when BB shows a dark theme. Host has no theme field, so this reads whether the text colour is light. */
function useDark(ref: RefObject<HTMLElement | null>): boolean {
  const [dark, setDark] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setDark(lightText(getComputedStyle(el).color));
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true });
    if (document.body) observer.observe(document.body, { attributes: true });
    const scheme = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    scheme?.addEventListener?.("change", read);
    return () => { observer.disconnect(); scheme?.removeEventListener?.("change", read); };
  }, [ref]);
  return dark;
}

function useSize(ref: RefObject<HTMLElement | null>, fallback: Size): Size {
  const [size, setSize] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => { const { clientWidth: width, clientHeight: height } = el; if (width > 0 && height > 0) setSize((s) => s.width === width && s.height === height ? s : { width, height }); };
    read();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

// --- Map. Interaction and tile layout ported from GenUI ui/components/Map.tsx (Apache-2.0), without a map library. ---

const KINDS = ["general", "stay", "daytrip", "avoid"] as const;
type Kind = (typeof KINDS)[number];
// The one fixed palette in the library: hem.so's trip-map kinds, so a map reads the same in chat and on the site.
const KIND_COLOR: Record<Kind, string> = { general: "#6366f1", stay: "#10b981", daytrip: "#f59e0b", avoid: "#f43f5e" };
const kindOf = (kind: unknown): Kind => KINDS.includes(kind as Kind) ? kind as Kind : "general";
const position = z.union([z.string(), z.array(z.number())]);
const KIND_NOTE = 'kind "general" (default, indigo), "stay" (green), "daytrip" (amber), or "avoid" (red)';

const Marker = defineComponent({
  name: "Marker",
  props: z.object({ title: z.string(), at: position, kind: z.enum(KINDS).optional(), description: z.string().optional(), image: z.string().optional(), link: z.string().optional(), day: z.union([z.string(), z.number()]).optional(), wiki: z.string().optional() }),
  description: `One numbered place of Map. at is [lat, lng] or a place name. ${KIND_NOTE}. description, image, and link fill its click popup. day groups a trip's stops; later stops inherit it. wiki names an English Wikipedia article whose credited lead photo is looked up only when this place opens.`,
  component: () => null,
});

const Area = defineComponent({
  name: "Area",
  props: z.object({ title: z.string(), points: z.array(z.array(z.number())), kind: z.enum(KINDS).optional(), description: z.string().optional() }),
  description: `A shaded region of Map: points are three or more [lat, lng] corners in order. ${KIND_NOTE}. description shows in its popup.`,
  component: () => null,
});

type AreaProps = { title: string; points: number[][]; kind: Kind; description: string };
type Pin = { key: string; n: number; title: string; kind: Kind; description?: string; image?: string; link?: string; at: LatLng; day: string | null; wiki: string | null };
type Shape = { key: string; title: string; kind: Kind; description?: string; points: LatLng[] };
const DAY_COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ec4899", "#0ea5e9", "#a855f7"];

function MapPin({ pin, point, on, highlighted, color, onToggle, onHover, drop }: { pin: Pin; point: { left: number; top: number }; on: boolean; highlighted: boolean; color: string; onToggle: () => void; onHover: (hovered: boolean) => void; drop: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const off = useAnimationsOff();
  useEffect(() => {
    if (!drop || off || !ref.current) return;
    const animation = ref.current.animate([{ opacity: 0, transform: "translateY(-16px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 360, easing: "cubic-bezier(.22,1,.36,1)" });
    return () => animation.cancel();
  }, [drop, off]);
  const lit = on || highlighted;
  return <button ref={ref} type="button" aria-label={`${pin.n}. ${pin.title}`} aria-expanded={on} onClick={onToggle} onPointerEnter={() => onHover(true)} onPointerLeave={() => onHover(false)} onFocus={() => onHover(true)} onBlur={() => onHover(false)}
    style={{ ...point, "--pin": color, borderColor: lit ? color : undefined, boxShadow: lit ? `2px 2px 0 ${color}` : undefined } as CSSProperties}
    className={`absolute inline-flex h-7 min-w-7 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center gap-1 rounded-md border border-border bg-background px-1.5 text-xs font-semibold tabular-nums text-foreground hover:z-10 hover:border-(--pin) hover:shadow-[2px_2px_0_var(--pin)] ${lit ? "z-10" : ""} ${focusRing}`}><span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: color }} />{pin.n}</button>;
}

function WikiPhoto({ title, name, onError }: { title: string; name: string; onError: (error: string) => void }) {
  const answer = useAsk<{ photo: (Found & { articleUrl: string }) | null }>("wiki", { title });
  const photo = answer.value?.photo;
  const image = useImageResource(photo?.url);
  const error = answer.error ?? image?.error;
  useEffect(() => { if (error) onError(error); }, [error, onError]);
  if (error) return null;
  if (!answer.value || photo && !image?.image) return <p role="status" className="m-0 text-xs text-muted-foreground">Loading place photo…</p>;
  if (!photo) return <p className="m-0 text-xs text-muted-foreground">No credited lead photo found.</p>;
  return <figure className="m-0 flex min-w-0 flex-col gap-1"><Zoomable src={image!.image!.src} alt={name} caption={`${photo.creator} · ${photo.license}`}><img src={image!.image!.src} alt={name} className="max-h-32 max-w-full rounded-md object-contain" /></Zoomable><Credit image={photo} /></figure>;
}

const PAN_STEP = 80;

function MapTile({ tile, theme, onError }: { tile: Tile; theme: "light" | "dark"; onError: (message: string) => void }) {
  const { value, error } = useAsk<{ dataUrl?: unknown }>("tile", { z: tile.z, x: tile.x, y: tile.y, theme });
  useEffect(() => { if (error) onError(error); }, [error, onError]);
  // One extra pixel, from rounded corners, hides the seams between fractional-zoom tiles.
  const side = Math.ceil(tile.size) + 1;
  return <div className="absolute" style={{ left: Math.floor(tile.left), top: Math.floor(tile.top), width: side, height: side }}>
    <div className="absolute inset-0 border-r border-b border-border-hairline" />
    {typeof value?.dataUrl === "string" ? <img src={value.dataUrl} alt="" draggable={false} className="absolute inset-0 size-full" /> : null}
  </div>;
}

function MapPopup({ at, size, color, title, description, image, link, wiki, onError, onClose }: { at: { left: number; top: number }; size: Size; color: string; title: string; description?: string; image?: string; link?: string; wiki?: string | null; onError: (error: string) => void; onClose: () => void }) {
  const { openUrl } = useHost();
  const href = webHref(link);
  const below = at.top < (image ? 210 : 110);
  const style: CSSProperties = { left: Math.max(8, Math.min(at.left - 120, size.width - 248)), maxHeight: Math.max(80, below ? size.height - at.top - 28 : at.top - 28), ...(below ? { top: at.top + 20 } : { bottom: size.height - at.top + 20 }) };
  return <div data-map-ui="" role="dialog" aria-label={title} style={style} onClick={event => event.stopPropagation()} className="absolute z-20 w-60 cursor-auto select-text overflow-y-auto rounded-md border border-border-hairline bg-background text-foreground shadow-[2px_2px_0_var(--border)]">
    {image ? <Picture src={image} alt="" quiet className="block h-28 w-full object-cover" /> : null}
    <div className="flex flex-col gap-1 p-2.5">
      <div className="flex items-start gap-1.5">
        <span aria-hidden className="mt-[0.45em] size-2 shrink-0 rounded-full" style={{ background: color }} />
        {href ? <a href={href} title={href} onClick={openWith(openUrl, href)} className={`min-w-0 flex-1 rounded-sm font-medium text-foreground underline-offset-2 hover:underline ${focusRing}`}>{title}<ArrowUpRight aria-hidden className="ml-0.5 inline size-[0.9em] align-[-0.1em] text-muted-foreground" /></a>
          : <span className="min-w-0 flex-1 font-medium">{title}</span>}
        <button type="button" aria-label="Close" onClick={onClose} className={`-mt-0.5 -mr-1 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground ${focusRing}`}><X aria-hidden className="size-3.5" /></button>
      </div>
      {description ? <p className="m-0 text-sm text-muted-foreground">{description}</p> : null}
      {wiki && !image ? <WikiPhoto title={wiki} name={title} onError={onError} /> : null}
    </div>
  </div>;
}

function MapBody({ markers, areas, center, zoom, route = false, tour: wantedTour = false }: { markers: unknown[]; areas: unknown[]; center?: unknown; zoom?: number; route?: boolean; tour?: boolean }) {
  const host = useHost();
  const streaming = useIsStreaming();
  const frame = useRef<HTMLDivElement>(null);
  const size = useSize(frame, MAP_FALLBACK_SIZE);
  const dark = useDark(frame);
  const [found, setFound] = useState<Record<string, LatLng | string>>({});
  const [moved, setMoved] = useState<View | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [tileError, setTileError] = useState<string>();

  // Place names are looked up one at a time, nudged toward the places given as coordinates. A name still streaming waits.
  const marks = mapMarkers(markers);
  const nearby = mapNear(marks.map((m) => m?.at));
  const names = marks.flatMap((m, i) => typeof m?.at === "string" && m.at.trim() && !(streaming && i === marks.length - 1) ? [m.at.trim()] : []);
  if (typeof center === "string" && center.trim() && !streaming) names.push(center.trim());
  const pending = names.find((name) => !(placeKey(name) in found));
  const nearKey = JSON.stringify(nearby ?? null);
  useEffect(() => {
    if (!pending) return;
    let live = true;
    const key = placeKey(pending);
    ask(host, "geocode", nearby ? { name: pending, near: nearby } : { name: pending }).promise.then(
      (value) => { if (live) setFound((f) => ({ ...f, [key]: latLng(value) ?? "That place lookup gave no position." })); },
      (error: unknown) => { if (live) setFound((f) => ({ ...f, [key]: failure(error) })); });
    return () => { live = false; };
  }, [host, pending, nearKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolve = (at: unknown): LatLng | null => {
    const known = typeof at === "string" ? found[placeKey(at)] : undefined;
    return latLng(at) ?? (typeof known === "object" ? known : null);
  };
  const pins: Pin[] = marks.flatMap((m, i) => {
    const at = resolve(m.at);
    return at ? [{ key: `m${i}`, n: i + 1, title: m.title, kind: kindOf(m.kind), description: m.description, image: m.image, link: m.link, at, day: m.day, wiki: m.wiki }] : [];
  });
  const days = [...new Set(marks.flatMap(mark => mark.day === null ? [] : [mark.day]))];
  const grouped = new Map<string | null, Pin[]>([null, ...days].map(day => [day, []]));
  for (const pin of pins) grouped.get(pin.day)!.push(pin);
  const dayGroups = [...grouped].map(([day, pins]) => ({ day, pins }));
  const order = dayGroups.flatMap(group => group.pins);
  const positionByKey = new Map(order.map((pin, index) => [pin.key, index]));
  const dayColors = new Map(days.map((day, index) => [day, DAY_COLORS[index % DAY_COLORS.length]!]));
  if (days.length) order.forEach((pin, index) => { pin.n = index + 1; });
  const tour = useTour(wantedTour, order.length, frame);
  const shown = order.slice(0, tour.shown);
  const colorOf = (pin: Pin) => pin.day === null ? KIND_COLOR[pin.kind] : dayColors.get(pin.day)!;
  const shapes: Shape[] = areas.flatMap((node, i) => {
    const a = childProps<AreaProps>(node);
    const points = (Array.isArray(a?.points) ? a.points : []).flatMap((p) => latLng(p) ?? []);
    return points.length >= 3 ? [{ key: `a${i}`, title: a?.title ?? "", kind: kindOf(a?.kind), description: a?.description, points }] : [];
  });

  // The view follows the content until the reader moves it; the fit button and the 0 key hand it back.
  const centerAt = center === undefined || center === null ? null : resolve(center);
  const view = moved ?? mapView([...pins.map((p) => p.at), ...shapes.flatMap((s) => s.points)], centerAt, zoom, size);
  const live = useRef({ view, size });
  live.current = { view, size };
  const screen = (p: LatLng) => toScreen(project(p.lat, p.lng), view, size);
  const zoomBy = (by: number) => setMoved(zoomAround(view, view.zoom + by, { left: size.width / 2, top: size.height / 2 }, size));

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      // Plain scrolling keeps scrolling the reply; only ⌘/Ctrl+scroll (a trackpad pinch sends ctrlKey) zooms.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect(), { view: v, size: s } = live.current;
      setMoved(zoomAround(v, v.zoom - Math.max(-1, Math.min(1, event.deltaY / 100)), { left: event.clientX - rect.left, top: event.clientY - rect.top }, s));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const drag = useRef<{ x: number; y: number; from: View; id: number; moving: boolean } | null>(null);
  const dragged = useRef(false);
  const onUi = (target: EventTarget) => target instanceof Element && target.closest("button,a,[role=button],[data-map-ui]") !== null;
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    dragged.current = false;
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("[data-map-ui]"))) return;
    drag.current = { x: event.clientX, y: event.clientY, from: view, id: event.pointerId, moving: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    const dx = event.clientX - d.x, dy = event.clientY - d.y;
    if (!d.moving) {
      if (Math.hypot(dx, dy) < 4) return;
      d.moving = dragged.current = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    setMoved(pan(d.from, dx, dy, size));
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && active) { event.stopPropagation(); setActive(null); return; }
    if (event.target !== event.currentTarget) return;
    const step = ({ ArrowLeft: [PAN_STEP, 0], ArrowRight: [-PAN_STEP, 0], ArrowUp: [0, PAN_STEP], ArrowDown: [0, -PAN_STEP] } as Record<string, [number, number]>)[event.key];
    if (step) setMoved(pan(view, step[0], step[1], size));
    else if (event.key === "+" || event.key === "=") zoomBy(1);
    else if (event.key === "-" || event.key === "_") zoomBy(-1);
    else if (event.key === "0") setMoved(null);
    else return;
    event.preventDefault();
  };
  const show = (key: string, at: LatLng) => {
    setActive(key);
    const position = positionByKey.get(key);
    if (position !== undefined && tour.active) tour.seek(position);
    const { left, top } = screen(at);
    if (left < 40 || top < 40 || left > size.width - 40 || top > size.height - 40) setMoved(clampView({ ...project(at.lat, at.lng), zoom: view.zoom }, size));
  };

  const pin = pins.find((p) => p.key === active);
  const shape = shapes.find((s) => s.key === active);
  const shapeCenter = shape ? centroid(shape.points) : null;
  const notes = [...new Set([tileError, ...names.map((name) => found[placeKey(name)])].filter((note): note is string => typeof note === "string" && note !== ""))];
  const control = (label: string, Icon: IconComponent, onClick: () => void, disabled: boolean) => <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}
    className={`inline-flex size-7 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-foreground hover:bg-state-hover disabled:cursor-default disabled:text-muted-foreground disabled:hover:bg-transparent ${focusRing}`}><Icon aria-hidden className="size-3.5" /></button>;

  return <div className="flex min-w-0 flex-col gap-1.5">
    {days.length || tour.active ? <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 text-xs">{days.length ? <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">{days.map((day, index) => <span key={day} className="inline-flex min-w-0 items-center gap-1.5"><span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: DAY_COLORS[index % DAY_COLORS.length] }} /><span className="truncate">{day}</span></span>)}</div> : null}{tour.active ? <div className="flex shrink-0 items-center gap-3">{!tour.done ? <button type="button" onClick={tour.toggle} className={`rounded-sm text-muted-foreground ${focusRing}`}>{tour.paused ? "Resume tour" : "Pause tour"}</button> : null}<button type="button" onClick={() => { setActive(null); tour.replay(); }} className={`rounded-sm text-muted-foreground ${focusRing}`}>Replay tour</button></div> : null}</div> : null}
    <div ref={frame} role="region" aria-roledescription="map" aria-label={`Map of ${pins.length} ${pins.length === 1 ? "place" : "places"}. Arrow keys pan, plus and minus zoom, 0 fits everything.`} tabIndex={0} data-bb-image-preview-ignore=""
      {...NO_BB_SWIPE}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} onKeyDown={onKeyDown}
      onClickCapture={(event) => { if (dragged.current) { dragged.current = false; event.stopPropagation(); event.preventDefault(); } }}
      onClick={(event) => { if (!onUi(event.target)) setActive(null); }}
      onDoubleClick={(event) => {
        if (onUi(event.target)) return;
        const rect = event.currentTarget.getBoundingClientRect();
        setMoved(zoomAround(view, view.zoom + 1, { left: event.clientX - rect.left, top: event.clientY - rect.top }, size));
      }}
      className={`relative h-72 cursor-grab touch-none select-none overflow-hidden rounded-md border border-border-hairline bg-background text-foreground active:cursor-grabbing ${focusRing}`}>
      <div aria-hidden className="absolute inset-0">{visibleTiles(view, size).map((tile) => <MapTile key={tile.key} tile={tile} theme={dark ? "dark" : "light"} onError={setTileError} />)}</div>
      <svg className="pointer-events-none absolute inset-0" width={size.width} height={size.height}>
        {route ? dayGroups.map(group => {
          const stops = group.pins.filter(pin => positionByKey.get(pin.key)! < tour.shown);
          return stops.length > 1 ? <polyline key={group.day ?? "unassigned"} data-map-route="" points={stops.map(pin => { const point = screen(pin.at); return `${point.left},${point.top}`; }).join(" ")} fill="none" stroke={group.day === null ? "var(--primary)" : dayColors.get(group.day)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray="5 4" /> : null;
        }) : null}
        {shapes.map((s) => {
          const on = hover === s.key || active === s.key, color = KIND_COLOR[s.kind];
          const toggle = () => setActive(active === s.key ? null : s.key);
          return <polygon key={s.key} role="button" tabIndex={0} aria-label={s.title} aria-expanded={active === s.key}
            points={s.points.map((p) => { const q = screen(p); return `${q.left},${q.top}`; }).join(" ")}
            fill={color} fillOpacity={on ? (dark ? 0.32 : 0.34) : (dark ? 0.14 : 0.16)} stroke={color} strokeOpacity={dark ? 0.85 : 0.7} strokeWidth={on ? (dark ? 2.5 : 2.25) : (dark ? 1.5 : 1.25)} strokeLinejoin="round"
            className="pointer-events-auto cursor-pointer outline-none" onClick={toggle}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); } }}
            onPointerEnter={() => setHover(s.key)} onPointerLeave={() => setHover((h) => h === s.key ? null : h)} onFocus={() => setHover(s.key)} onBlur={() => setHover((h) => h === s.key ? null : h)} />;
        })}
      </svg>
      {shown.map((pin, index) => {
        const point = screen(pin.at);
        if (point.left < -24 || point.top < -24 || point.left > size.width + 24 || point.top > size.height + 24) return null;
        return <MapPin key={`${tour.epoch}:${pin.key}`} pin={pin} point={point} on={active === pin.key} highlighted={hover === pin.key} color={colorOf(pin)} onToggle={() => setActive(active === pin.key ? null : pin.key)} onHover={hovered => setHover(hovered ? pin.key : null)} drop={tour.active && index === tour.shown - 1 && performance.now() - tour.droppedAt < 1000} />;
      })}
      {pin ? <MapPopup at={screen(pin.at)} size={size} color={colorOf(pin)} title={pin.title} description={pin.description} image={pin.image} link={pin.link} wiki={pin.wiki} onError={setTileError} onClose={() => setActive(null)} />
        : shape && shapeCenter ? <MapPopup at={screen(shapeCenter)} size={size} color={KIND_COLOR[shape.kind]} title={shape.title} description={shape.description} onError={setTileError} onClose={() => setActive(null)} /> : null}
      <div data-map-ui="" className="absolute top-2 right-2 flex flex-col overflow-hidden rounded-md border border-border-hairline bg-background shadow-[2px_2px_0_var(--border)]">
        {control("Zoom in", Plus, () => zoomBy(1), view.zoom >= MAX_ZOOM)}
        {control("Zoom out", Minus, () => zoomBy(-1), view.zoom <= MIN_ZOOM)}
        {control("Fit everything", Maximize2, () => setMoved(null), moved === null)}
      </div>
    </div>
    {pins.length + shapes.length > 0 ? <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-0.5 p-0 text-sm">
      {order.map((p) => <li key={p.key}><button type="button" onClick={() => show(p.key, p.at)} onPointerEnter={() => setHover(p.key)} onPointerLeave={() => setHover(null)} className={`inline-flex cursor-pointer items-center gap-1.5 rounded-sm border-0 bg-transparent p-0 text-left text-foreground hover:underline ${active === p.key || hover === p.key ? "underline" : ""} ${focusRing}`}>
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: colorOf(p) }} /><span className="tabular-nums text-muted-foreground">{p.n}</span>{p.title}
      </button></li>)}
      {shapes.map((s) => <li key={s.key}><button type="button" onClick={() => { const c = centroid(s.points); if (c) show(s.key, c); }} className={`inline-flex cursor-pointer items-center gap-1.5 rounded-sm border-0 bg-transparent p-0 text-left text-foreground hover:underline ${focusRing}`}>
        <span aria-hidden className="size-2.5 shrink-0 rounded-[2px] opacity-60" style={{ background: KIND_COLOR[s.kind] }} />{s.title}
      </button></li>)}
    </ul> : null}
    {route ? <p className="m-0 text-xs text-muted-foreground">Stops are connected in trip order, not street directions.</p> : null}
    {notes.length ? <p role="status" className="m-0 text-sm text-muted-foreground">{notes.join(" ")}</p> : null}
  </div>;
}

const MapView = defineComponent({
  name: "Map",
  props: z.object({ markers: z.array(z.union([Marker.ref, z.string(), z.record(z.string(), z.any())])), areas: z.union([z.array(Area.ref), z.object({ route: z.boolean().optional(), tour: z.boolean().optional() })]).optional(), center: position.optional(), zoom: z.number().optional() }),
  description: 'Numbered Marker parts, place names, or trip records {name,lat?,lng?,note?,day?,wiki?}. Existing Area lists, center, zoom, panning, and popups work unchanged. As the second argument, {route:true,tour:true} joins stops by day and drops pins in sequence without moving the camera. Days inherit from the preceding stop. A Wikipedia lead photo is looked up only when its place opens and must include reusable attribution. Tours pause in hidden pages and respect motion preferences.',
  component: ({ props }) => <MapBody markers={props.markers ?? []} areas={Array.isArray(props.areas) ? props.areas : []} center={props.center} zoom={props.zoom} route={!Array.isArray(props.areas) ? props.areas?.route : false} tour={!Array.isArray(props.areas) ? props.areas?.tour : false} />,
});

// --- Pictures. ---

type PhotoProps = { src: string; caption: string; alt: string };

const Photo = defineComponent({
  name: "Photo",
  props: z.object({ src: z.string(), caption: z.string().optional(), alt: z.string().optional() }),
  description: "One picture of Gallery: src is an http(s) or data: image URL, caption a short line under it, alt describes it for screen readers (default: the caption).",
  component: () => null,
});

const zoomButton = `block w-full cursor-zoom-in overflow-hidden rounded-md border-0 bg-transparent p-0 ${focusRing}`;
const openLabel = (name: string) => `${name ? `${name}. ` : ""}Open full-size image`;

const Gallery = defineComponent({
  name: "Gallery",
  props: z.object({ items: z.array(z.union([z.string(), Photo.ref])), columns: z.number().optional() }),
  description: "A grid of pictures; clicking one opens it full size, with previous and next. Each item is an image URL or a Photo with a caption. columns is 1 to 6; by default one picture fills the width, two or four sit in pairs, and more go in threes.",
  component: ({ props }) => {
    const streaming = useIsStreaming();
    const [open, setOpen] = useState<number | null>(null);
    const all = (props.items ?? []).map((item): Partial<PhotoProps> | undefined => typeof item === "string" ? { src: item } : childProps<PhotoProps>(item));
    // The last item may still be streaming its URL.
    const photos = (streaming ? all.slice(0, -1) : all).filter((p): p is Partial<PhotoProps> => typeof p?.src === "string" && p.src !== "");
    const columns = Math.min(6, Math.max(1, Math.round(props.columns ?? autoColumns(photos.length))));
    const name = (p: Partial<PhotoProps>) => p.alt || p.caption || "";
    const shown = open === null ? undefined : photos[open];
    return <div className="min-w-0">
      <ul className="m-0 grid list-none gap-x-1.5 gap-y-2 p-0" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {photos.map((p, i) => <li key={i} className="flex min-w-0 flex-col gap-1">
          <button type="button" aria-haspopup="dialog" aria-label={openLabel(name(p))} onClick={() => setOpen(i)} className={zoomButton}>
            <Picture src={p.src} alt={name(p)} className={`block w-full object-cover ${columns === 1 ? "aspect-[3/2]" : "aspect-square"}`} />
          </button>
          {p.caption ? <span className="truncate text-sm text-muted-foreground" title={p.caption}>{p.caption}</span> : null}
        </li>)}
      </ul>
      <Lightbox open={shown !== undefined} onClose={() => setOpen(null)} label={shown ? name(shown) || "Image preview" : "Image preview"} caption={shown?.caption || shown?.alt}
        nav={open === null ? undefined : { index: open, count: photos.length, go: setOpen }}>
        {shown ? <Picture src={shown.src} alt={name(shown)} className={lightboxImage} box="h-64 w-[min(40rem,100%)] rounded-sm" /> : null}
      </Lightbox>
    </div>;
  },
});

const side = z.object({ label: z.string(), src: z.string(), alt: z.string(), tone: z.enum(["positive", "negative", "warning"]).optional(), caption: z.string().optional() });
type Side = z.infer<typeof side>;
const toneDot: Record<NonNullable<Side["tone"]>, string> = { positive: "bg-success", negative: "bg-destructive", warning: "bg-warning" };

const BeforeAfter = defineComponent({
  name: "BeforeAfter",
  props: z.object({ items: z.array(side) }),
  description: 'Two or more pictures side by side to compare, like Before and After or option A and B; they stack on a narrow screen. Each item is {"label", "src", "alt", "tone", "caption"}: label heads the column, src is an http(s) or data: image URL, alt describes it, tone "positive"|"negative"|"warning" puts a coloured dot by the label, and caption is a line under it. Clicking a picture opens it full size.',
  component: ({ props }) => {
    const streaming = useIsStreaming();
    const [open, setOpen] = useState<number | null>(null);
    const items = ((props.items ?? []) as unknown[]).filter((item): item is Partial<Side> => typeof item === "object" && item !== null);
    const shown = open === null ? undefined : items[open];
    return <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-x-8 gap-y-4">
      {items.map((item, i) => <figure key={i} className="m-0 flex min-w-0 flex-col gap-1.5">
        {item.label ? <p className="m-0 flex items-center gap-2 text-sm font-medium text-foreground">{item.tone && toneDot[item.tone] ? <span aria-hidden className={`size-[7px] shrink-0 rounded-full ${toneDot[item.tone]}`} /> : null}{item.label}</p> : null}
        <button type="button" aria-haspopup="dialog" aria-label={openLabel(item.alt || item.label || "")} onClick={() => setOpen(i)} className={zoomButton}>
          {/* The last item may still be streaming its URL. */}
          <Picture src={streaming && i === items.length - 1 ? undefined : item.src} alt={item.alt ?? ""} className="block h-auto w-full" box="aspect-[4/3] w-full" />
        </button>
        {item.caption ? <figcaption className="text-sm text-muted-foreground">{item.caption}</figcaption> : null}
      </figure>)}
      <Lightbox open={shown !== undefined} onClose={() => setOpen(null)} label={shown?.alt || shown?.label || "Image preview"}
        caption={shown ? [shown.label, shown.caption || shown.alt].filter(Boolean).join(" — ") : undefined} nav={open === null ? undefined : { index: open, count: items.length, go: setOpen }}>
        {shown ? <Picture src={shown.src} alt={shown.alt ?? ""} className={lightboxImage} box="h-64 w-[min(40rem,100%)] rounded-sm" /> : null}
      </Lightbox>
    </div>;
  },
});

type HotspotProps = { x: number; y: number; title: string; text: string };

const Hotspot = defineComponent({
  name: "Hotspot",
  props: z.object({ x: z.number(), y: z.number(), title: z.string(), text: z.string().optional() }),
  description: "One numbered point of Hotspots: x and y are percent across and down the picture (0 to 100), title names it, and text (Markdown) shows when it is picked.",
  component: () => null,
});

const Hotspots = defineComponent({
  name: "Hotspots",
  props: z.object({ image: z.string(), points: z.array(Hotspot.ref), alt: z.string().optional() }),
  description: "A picture with numbered points on it and a key below; picking a point or its row shows its text. image is an http(s) or data: image URL, and alt describes it. Only use it when you know where each feature sits in the picture.",
  component: ({ props }) => {
    const { Markdown } = useHost();
    const [picked, setPicked] = useState<number | null>(null);
    const [hover, setHover] = useState<number | null>(null);
    const [preview, setPreview] = useState(false);
    const spots = (props.points ?? []).map((node) => childProps<HotspotProps>(node));
    const lit = hover ?? picked;
    const pick = (i: number) => setPicked((p) => p === i ? null : i);
    const hovering = (i: number) => ({ onPointerEnter: () => setHover(i), onPointerLeave: () => setHover((h) => h === i ? null : h) });
    return <div className="flex min-w-0 flex-col gap-3">
      <div className="relative w-fit max-w-full">
        <Picture src={props.image} alt={props.alt ?? ""} className="block h-auto max-h-[28rem] w-auto max-w-full rounded-md" box="aspect-[3/2] w-[40rem] max-w-full rounded-md" />
        <button type="button" aria-label="Expand image" onClick={() => setPreview(true)} className={`absolute top-2 right-2 grid size-8 place-items-center rounded-md border border-border bg-background/90 text-foreground ${focusRing}`}><Maximize2 aria-hidden className="size-4" /></button>
        {spots.map((s, i) => {
          const x = pinPercent(s?.x), y = pinPercent(s?.y);
          if (x === null || y === null) return null;
          return <button key={i} type="button" aria-label={`${i + 1}. ${s?.title ?? ""}`} aria-pressed={picked === i} onClick={() => pick(i)} {...hovering(i)} style={{ left: `${x}%`, top: `${y}%` }}
            className={`absolute flex size-6 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border p-0 text-xs font-semibold tabular-nums shadow-[1px_1px_0_var(--border)] ${lit === i ? "border-foreground bg-foreground text-background" : "border-border bg-background text-foreground"} ${focusRing}`}>{i + 1}</button>;
        })}
      </div>
      <ol className="m-0 flex list-none flex-col p-0">
        {spots.map((s, i) => s?.title ? <li key={i} className="border-b border-border-hairline last:border-b-0">
          <button type="button" aria-expanded={s.text ? picked === i : undefined} onClick={() => pick(i)} {...hovering(i)} className={`flex w-full cursor-pointer items-center gap-2.5 rounded-sm border-0 bg-transparent px-0 py-1.5 text-left text-foreground ${focusRing}`}>
            <span className={`flex size-5 shrink-0 items-center justify-center rounded-full text-xs tabular-nums ${lit === i ? "bg-foreground text-background" : "bg-muted text-muted-foreground"}`}>{i + 1}</span>
            <span className="min-w-0 font-medium">{s.title}</span>
          </button>
          {picked === i && s.text ? <div className="pb-2 pl-7.5 text-muted-foreground"><Markdown content={s.text} /></div> : null}
        </li> : null)}
      </ol>
      <Lightbox open={preview} onClose={() => setPreview(false)} label={props.alt || "Image preview"}><Picture src={props.image} alt={props.alt ?? ""} className={lightboxImage} /></Lightbox>
    </div>;
  },
});

type Found = { url: string; width: number; height: number; title: string; creator: string; license: string; licenseUrl?: string | null; sourceUrl: string };
const aspects = { wide: "aspect-video", square: "aspect-square", tall: "aspect-[3/4]" } as const;

function Credit({ image }: { image: Found }) {
  const { openUrl } = useHost();
  const license = webHref(image.licenseUrl), source = webHref(image.sourceUrl);
  const link = `rounded-sm text-muted-foreground underline underline-offset-2 hover:text-foreground ${focusRing}`;
  return <p className="m-0 break-words text-xs text-muted-foreground" title={`${image.title} · ${image.creator}, ${image.license}`}>
    {image.title} · {image.creator} · {license ? <a href={license} onClick={openWith(openUrl, license)} className={link}>{image.license}</a> : image.license}
    {source ? <> · <a href={source} onClick={openWith(openUrl, source)} className={link}>Commons</a></> : null}
  </p>;
}

const ImageSearch = defineComponent({
  name: "ImageSearch",
  props: z.object({ query: z.string(), count: z.number().optional(), aspect: z.enum(["wide", "square", "tall"]).optional() }),
  description: 'Photos found on the web for query, from Wikimedia Commons, each credited with its author and licence. Use it to show what a place, landmark, plant, animal, or object looks like when you have no image URL. count is 1 (default) to 8. aspect "wide" (default), "square", or "tall" crops them alike. Clicking one opens it full size.',
  component: ({ props }) => {
    const streaming = useIsStreaming();
    const input = searchInput(props.query, props.count);
    const count = input?.count ?? 1;
    const { value, error } = useAsk<{ images?: Found[] }>("search", streaming ? null : input);
    const [open, setOpen] = useState<number | null>(null);
    const images = Array.isArray(value?.images) ? value.images : [];
    const aspect = aspects[props.aspect ?? "wide"] ?? aspects.wide;
    if (error) return <p className="m-0 text-sm text-muted-foreground">{error}</p>;
    if (images.length === 0) return <div aria-busy="true" className={`flex w-full items-center justify-center rounded-md bg-muted text-sm text-muted-foreground ${count === 1 ? aspect : "h-40"}`}>Finding photos…</div>;
    const shown = open === null ? undefined : images[open];
    return <div className="min-w-0">
      <ul className="m-0 grid list-none gap-x-1.5 gap-y-2 p-0" style={{ gridTemplateColumns: `repeat(${autoColumns(images.length)}, minmax(0, 1fr))` }}>
        {images.map((image, i) => <li key={image.url} className="flex min-w-0 flex-col gap-1">
          <button type="button" aria-haspopup="dialog" aria-label={openLabel(image.title)} onClick={() => setOpen(i)} className={zoomButton}>
            <Picture src={image.url} alt={image.title} className={`block w-full object-cover ${aspect}`} />
          </button>
          <Credit image={image} />
        </li>)}
      </ul>
      <Lightbox open={shown !== undefined} onClose={() => setOpen(null)} label={shown?.title || "Image preview"} caption={shown ? `${shown.title} — ${shown.creator}, ${shown.license}` : undefined}
        nav={open === null ? undefined : { index: open, count: images.length, go: setOpen }}>
        {shown ? <Picture src={shown.url} alt={shown.title} className={lightboxImage} box="h-64 w-[min(40rem,100%)] rounded-sm" /> : null}
      </Lightbox>
    </div>;
  },
});

// --- Catalog. Example photos are Wikimedia Commons thumbnails. ---

const commons = (path: string) => `https://upload.wikimedia.org/wikipedia/commons/thumb/${path}/960px-${path.split("/").pop()}`;
const tram = commons("6/62/Tram_28_Lisbon_Portuguese.jpg");
const belem = commons("9/9e/Lisbon_Torre_de_Bel%C3%A9m_BW_2018-10-03_16-33-21.jpg");
const pena = commons("7/74/Sintra_Portugal_Pal%C3%A1cio_da_Pena-01.jpg");
const alfama = commons("b/b0/Alfama%2C_Lisbon_%28DSC03367%29.jpg");
const svg = (body: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 480 300'><rect width='480' height='300' fill='#f4f4f5'/>${body}</svg>`)}`;
const formBefore = svg("<g fill='#d4d4d8'><rect x='32' y='28' width='220' height='16'/><rect x='32' y='64' width='416' height='22'/><rect x='32' y='98' width='200' height='22'/><rect x='248' y='98' width='200' height='22'/><rect x='32' y='132' width='416' height='22'/><rect x='32' y='166' width='130' height='22'/><rect x='175' y='166' width='130' height='22'/><rect x='318' y='166' width='130' height='22'/><rect x='32' y='200' width='416' height='22'/></g><rect x='32' y='244' width='70' height='26' fill='#a1a1aa'/><rect x='112' y='244' width='70' height='26' fill='#a1a1aa'/><rect x='192' y='244' width='70' height='26' fill='#a1a1aa'/>");
const formAfter = svg("<rect x='32' y='40' width='180' height='18' fill='#a1a1aa'/><g fill='#e4e4e7' stroke='#d4d4d8'><rect x='32' y='84' width='416' height='34'/><rect x='32' y='138' width='416' height='34'/></g><rect x='32' y='206' width='120' height='36' fill='#6366f1'/>");

export const group: Group = {
  id: "media",
  name: "Media",
  notes: ["Map tiles, place names, ImageSearch, and remote pictures come through Pages' web lookups (Mapbox, Photon, Wikimedia Commons). When lookups are off, these show a short muted note, and Map still draws its places on a blank grid."],
  entries: [
    { component: MapView, summary: "map with numbered places and areas", examples: [
      { name: "Trip plan", code: `root = Map([Marker("Belém Tower", [38.6916, -9.216], "daytrip", "16th-century fort on the Tagus. Go early.", "${belem}", "https://en.wikipedia.org/wiki/Bel%C3%A9m_Tower"), Marker("Guesthouse", [38.7118, -9.1300], "stay", "Two nights in Alfama."), Marker("Tram 28 stop", [38.7107, -9.1336], "general", "Ride it uphill, not at noon.", "${tram}"), Marker("Rua Augusta at noon", [38.7101, -9.1366], "avoid", "Packed with tour groups.")], [Area("Alfama", [[38.7148, -9.1345], [38.7152, -9.1262], [38.7098, -9.1250], [38.7090, -9.1322]], "stay", "Old quarter: steep lanes, good rooms.")])` },
      { name: "Places by name", code: `root = Map([Marker("Lisbon", "Lisbon, Portugal"), Marker("Sintra", "Sintra, Portugal", "daytrip", "Pena Palace and the Moorish Castle."), Marker("Cascais", "Cascais, Portugal", "daytrip", "Beach town at the end of the train line.")])` },
      { name: "Fixed view", code: `root = Map([Marker("Time Out Market", [38.7069, -9.1459], "general", "Food hall by Cais do Sodré.")], null, [38.7069, -9.1459], 16)` },
      { name: "Days and routes", code: 'root = Map([{name:"Belém Tower",lat:38.6916,lng:-9.216,day:1,wiki:"Belém Tower",note:"Go early."},{name:"Jerónimos Monastery",lat:38.6979,lng:-9.2067},{name:"Pena Palace",lat:38.7876,lng:-9.3906,day:2,wiki:"Pena Palace"},{name:"Moorish Castle",lat:38.7924,lng:-9.3894}], {route:true,tour:true})' },
    ] },
    { component: Marker, summary: "one place on a Map", part: true, examples: [] },
    { component: Area, summary: "shaded region on a Map", part: true, examples: [] },
    { component: Gallery, summary: "picture grid with a full-size viewer", examples: [
      { name: "Captioned photos", code: `root = Gallery([Photo("${tram}", "Tram 28 in the old town"), Photo("${belem}", "Belém Tower"), Photo("${pena}", "Pena Palace, Sintra"), Photo("${alfama}", "Alfama rooftops")])` },
      { name: "Links in three columns", code: `root = Gallery(["${pena}", "${belem}", "${alfama}"], 3)` },
    ] },
    { component: Photo, summary: "one picture of Gallery", part: true, examples: [] },
    { component: BeforeAfter, summary: "pictures side by side to compare", examples: [
      { name: "Before and after", code: `root = BeforeAfter([{"label": "Before", "src": "${formBefore}", "alt": "Sign-up form with nine fields and three buttons", "tone": "negative", "caption": "Nine fields, three equal buttons."}, {"label": "After", "src": "${formAfter}", "alt": "Sign-up form with two fields and one primary button", "tone": "positive", "caption": "Two fields and one clear action."}])` },
      { name: "Two options", code: `root = BeforeAfter([{"label": "Option A: Alfama", "src": "${alfama}", "alt": "Rooftops of Alfama above the river", "caption": "Old town, steep lanes, near the river."}, {"label": "Option B: Belém", "src": "${belem}", "alt": "Belém Tower on the Tagus", "tone": "warning", "caption": "Calmer, but a tram ride from the centre."}])` },
    ] },
    { component: Hotspots, summary: "picture with numbered points", examples: [
      { name: "Parts of a building", code: `root = Hotspots("${pena}", [Hotspot(22, 20, "Dome tower", "The yellow tower with the grey dome, the **New Palace** side."), Hotspot(67, 26, "Clock tower", "The red tower belongs to the old monastery the palace grew from."), Hotspot(54, 32, "Golden domes", "Two small domes that echo the big one."), Hotspot(40, 66, "Battlements", "Crenellated walls wrap the whole hilltop.")], "Pena Palace in Sintra, yellow and red towers above the trees")` },
    ] },
    { component: Hotspot, summary: "one point of Hotspots", part: true, examples: [] },
    { component: ImageSearch, summary: "photos found on the web for a query", examples: [
      { name: "One photo", code: `root = ImageSearch("Pena Palace Sintra")` },
      { name: "A few, square", code: `root = ImageSearch("Lisbon tram 28", 4, "square")` },
    ] },
  ],
};
