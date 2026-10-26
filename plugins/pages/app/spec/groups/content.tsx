// Content: text, notes, headline numbers, and the small things a reply points at.
import { useState, type MouseEvent, type ReactNode } from "react";
import { defineComponent } from "@openuidev/react-lang";
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bell, Book, Bookmark, Briefcase, Bug, Building2, Calendar, Car, ChartBar, ChartLine, Check, CircleCheck, CircleX,
  Clock, Cloud, Code, Coffee, CreditCard, Database, DollarSign, Download, ExternalLink, Eye, File as FileIcon, FileText, Flag, Folder, GitBranch, GitCommitHorizontal,
  GitPullRequest, Globe, GraduationCap, Heart, House, Image as ImageIcon, Info, Key, Lightbulb, Link, Lock, Mail, MapPin, MessageSquare, Minus, Moon, Package,
  Pencil, Phone, Plane, Plus, Rocket, Search, Server, Settings, Shield, ShoppingCart, Sparkles, Star, Sun, Tag as TagIcon, Target, Terminal, Train, Trash2,
  TrendingDown, TrendingUp, TriangleAlert, Upload, User, Users, Utensils, Wrench, X, Zap,
} from "../icons.generated.js";
import type { IconComponent } from "../glyph.js";
import { z } from "zod";
import { childProps, focusRing, toneBar, trendText, type Group } from "../kit.js";
import { Zoomable } from "../viewer.js";
import { useHost } from "../host.js";
import { SourceContext, SourceLine } from "../SourceLine.js";
import { sameCaption, sourceCaption } from "../source.js";

const Heading = defineComponent({
  name: "Heading",
  props: z.object({ text: z.string() }),
  description: "A section title inside the UI. The reply already names the UI, so do not open with one.",
  component: ({ props }) => <h3 className="m-0 font-semibold text-foreground">{props.text}</h3>,
});

const Text = defineComponent({
  name: "Text",
  props: z.object({ text: z.string(), tone: z.enum(["default", "muted", "strong"]).optional() }),
  description: 'A paragraph of plain text. tone "default"|"muted"|"strong".',
  component: ({ props }) => <p className={`m-0 ${props.tone === "muted" ? "text-muted-foreground" : props.tone === "strong" ? "font-semibold text-foreground" : "text-foreground"}`}>{props.text}</p>,
});

const Callout = defineComponent({
  name: "Callout",
  props: z.object({ tone: z.enum(["info", "success", "warning", "danger"]), title: z.string(), body: z.string().optional() }),
  description: "A short highlighted note with a coloured side bar.",
  component: ({ props }) => <div className={`border-l-2 pl-3 ${toneBar[props.tone]}`}><p className="m-0 font-semibold text-foreground">{props.title}</p>{props.body ? <p className="m-0 text-muted-foreground">{props.body}</p> : null}</div>,
});

const tone = z.enum(["neutral", "info", "success", "warning", "danger"]);
type Tone = z.infer<typeof tone>;
const toneText: Record<Tone, string> = { neutral: "text-muted-foreground", info: "text-primary", success: "text-success", warning: "text-warning", danger: "text-destructive" };
const toneFill: Record<Tone, string> = { neutral: "bg-muted text-foreground", info: "bg-primary/10 text-primary", success: "bg-success/10 text-success", warning: "bg-warning/10 text-warning", danger: "bg-destructive/10 text-destructive" };
const toneDot: Record<Tone, string> = { neutral: "bg-muted-foreground", info: "bg-primary", success: "bg-success", warning: "bg-warning", danger: "bg-destructive" };
const TONES = 'tone "neutral" (default), "info", "success", "warning", or "danger"';

const Stat = defineComponent({
  name: "Stat",
  props: z.object({ label: z.string(), value: z.union([z.string(), z.number()]), change: z.string().optional(), trend: z.enum(["neutral", "up", "down"]).optional(), tone: tone.optional(), source: z.string().optional() }),
  description: 'One headline number. change is a short note under it, like "+12%" or "since May". trend "up" is good (green), "down" is bad (red), "neutral" (default) is muted. tone colours the value itself: "success", "warning", "danger", "info", or "neutral" (default, plain).',
  component: ({ props }) => <div className="flex min-w-24 flex-col">
    <span className="text-muted-foreground">{props.label}</span>
    <span className={`text-2xl font-semibold tabular-nums ${props.tone && props.tone !== "neutral" ? toneText[props.tone] : "text-foreground"}`}>{props.value}</span>
    {props.change ? <span className={`tabular-nums ${trendText[props.trend ?? "neutral"]}`}>{props.change}</span> : null}
    <SourceLine props={props} />
  </div>,
});

const Stats = defineComponent({
  name: "Stats",
  props: z.object({ items: z.array(Stat.ref) }),
  description: "A row of Stat numbers that wraps on narrow screens.",
  component: ({ props, renderNode }) => {
    const items = props.items.map((item) => childProps<Record<string, unknown>>(item) ?? {});
    const caption = items.length ? sourceCaption(items[0]) : null;
    const common = caption && items.every((item) => sameCaption(caption, sourceCaption(item))) ? caption : null;
    return <div className="flex min-w-0 flex-col gap-1.5">
      <SourceContext.Provider value={common}><div className="flex flex-wrap gap-x-8 gap-y-3">{renderNode(props.items)}</div></SourceContext.Provider>
      {common ? <SourceLine props={items[0]} /> : null}
    </div>;
  },
});

const Badge = defineComponent({
  name: "Badge",
  props: z.object({ text: z.string(), tone: tone.optional() }),
  description: `A short status in a tinted pill, like "Shipped", "Blocked", or "3 open". ${TONES}. For a topic or category, use Tag.`,
  component: ({ props }) => <span className={`inline-flex w-fit max-w-full items-center rounded-sm px-1.5 py-0.5 text-xs font-medium [overflow-wrap:anywhere] ${toneFill[props.tone ?? "neutral"]}`}>{props.text}</span>,
});

// A fixed allow-list of MingCute glyphs keeps the bundle small (pages can use every glyph with <i data-icon>).
// Names are compared without case, spaces, dashes, or underscores.
const ICONS: Record<string, IconComponent> = {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bell, Book, Bookmark, Briefcase, Bug, Building: Building2, Calendar, Car, ChartBar, ChartLine, Check, CircleCheck, CircleX,
  Clock, Cloud, Code, Coffee, CreditCard, Database, DollarSign, Download, ExternalLink, Eye, File: FileIcon, FileText, Flag, Folder, GitBranch, GitCommit: GitCommitHorizontal,
  GitPullRequest, Globe, GraduationCap, Heart, Home: House, Image: ImageIcon, Info, Key, Lightbulb, Link, Lock, Mail, MapPin, Message: MessageSquare, Minus, Moon, Package,
  Pencil, Phone, Plane, Plus, Rocket, Search, Server, Settings, Shield, ShoppingCart, Sparkles, Star, Sun, Tag: TagIcon, Target, Terminal, Train, Trash: Trash2,
  TrendingDown, TrendingUp, Upload, User, Users, Utensils, Warning: TriangleAlert, Wrench, X, Zap,
};
const ICON_NAMES = Object.keys(ICONS);
const iconKey = (name: string) => name.toLowerCase().replace(/[\s_-]/gu, "");
const ICON_BY_KEY = new Map(ICON_NAMES.map((name) => [iconKey(name), ICONS[name]!]));

/** The allowed icon for a name, or undefined. */
export function iconFor(name: unknown): IconComponent | undefined {
  return typeof name === "string" ? ICON_BY_KEY.get(iconKey(name)) : undefined;
}

const Icon = defineComponent({
  name: "Icon",
  props: z.object({ name: z.string(), tone: tone.optional(), label: z.string().optional() }),
  description: `A small icon at the size of the text around it. With no tone it takes the text colour; ${TONES.replace(' (default)', '')} colours it. label is read by screen readers; leave it out when the icon only decorates. An unknown name shows nothing. Names: ${ICON_NAMES.join(", ")}.`,
  component: ({ props }) => {
    const Glyph = iconFor(props.name);
    if (!Glyph) return null;
    return <Glyph role={props.label ? "img" : undefined} aria-label={props.label} aria-hidden={props.label ? undefined : true} className={`inline-block size-[1em] shrink-0 align-[-0.125em] ${props.tone ? toneText[props.tone] : ""}`} />;
  },
});

function TagView({ text, icon, tone: t }: { text?: string; icon?: string; tone?: Tone }) {
  const Glyph = iconFor(icon);
  return <span className="inline-flex w-fit max-w-full items-center gap-1 rounded-sm border border-border-hairline px-1.5 py-0.5 text-xs text-foreground">
    {Glyph ? <Glyph aria-hidden className={`size-3 shrink-0 ${t ? toneText[t] : "text-muted-foreground"}`} /> : t ? <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${toneDot[t]}`} /> : null}
    <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
  </span>;
}

const Tag = defineComponent({
  name: "Tag",
  props: z.object({ text: z.string(), icon: z.string().optional(), tone: tone.optional() }),
  description: `A label for a topic, category, or owner, in a hairline outline. icon is an Icon name shown before the text. ${TONES} colours the icon, or a small dot when there is no icon. For a status, use Badge.`,
  component: ({ props }) => <TagView {...props} />,
});

const Chips = defineComponent({
  name: "Chips",
  props: z.object({ items: z.array(z.union([z.string(), Tag.ref])) }),
  description: "A wrapping row of tags. Each item is a plain string or a Tag. For chips the reader picks from, use Choice.",
  component: ({ props, renderNode }) => <ul className="m-0 flex min-w-0 list-none flex-wrap gap-1.5 p-0">
    {(props.items ?? []).map((item, i) => typeof item === "string" ? <li key={i} className="flex"><TagView text={item} /></li> : item ? <li key={i} className="flex">{renderNode(item)}</li> : null)}
  </ul>,
});

/** An http(s) URL, or null. */
export function webUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? url : null;
  } catch { return null; }
}

/** An image src this page may show: http(s) or a data: image. Anything else (paths, javascript:, file:) is null. */
export function imageUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const src = raw.trim();
  return webUrl(src) || /^data:image\/[a-z0-9.+-]+[;,]/iu.test(src) ? src : null;
}

const domainOf = (url: URL) => url.host.replace(/^www\./iu, "");
const isElement = (value: unknown) => (value as { type?: unknown } | null)?.type === "element";

/** `{label: value}` or `[[label, value], ...]` as rows. A streaming `[label]` shows before its value; other shapes give no rows. */
export function pairsOf(value: unknown): Array<[string, unknown]> {
  if (Array.isArray(value)) return value.flatMap((row): Array<[string, unknown]> => Array.isArray(row) && row.length > 0 ? [[String(row[0] ?? ""), row[1] ?? null]] : []);
  if (value && typeof value === "object" && !isElement(value)) return Object.entries(value);
  return [];
}

function cell(value: unknown, renderNode: (node: unknown) => ReactNode): ReactNode {
  if (value === null || value === undefined || value === "") return <span className="text-muted-foreground">—</span>;
  if (typeof value === "number") return <span className="tabular-nums">{value}</span>;
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return <span className="inline-flex flex-wrap items-center gap-1.5">{value.map((item, i) => <span key={i}>{cell(item, renderNode)}</span>)}</span>;
  return isElement(value) ? renderNode(value) : null;
}

const pairs = z.union([z.record(z.string(), z.any()), z.array(z.array(z.any()))]);

// Opens through the host so BB picks the browser; the href stays for copy-link and semantics.
const openWith = (openUrl: (url: string) => void, href: string) => (event: MouseEvent) => { event.preventDefault(); openUrl(href); };

const kindIcon: Record<string, IconComponent> = { person: User, place: MapPin, org: Building2, product: Package, link: Link };

const Entity = defineComponent({
  name: "Entity",
  props: z.object({ name: z.string(), subtitle: z.string().optional(), image: z.string().optional(), facts: pairs.optional(), url: z.string().optional(), kind: z.enum(["person", "place", "org", "product", "link", "other"]).optional() }),
  description: 'One person, place, or thing: a picture, the name, a subtitle, and a few facts. facts is an object like {"Rating": 4.6, "Price": "$$"} or a list of [label, value] pairs. image is an http(s) or data: image URL; with none, a kind icon or the first letter stands in. url (http or https) makes the name a link. kind "person", "place", "org", "product", "link", or "other" (default). In a narrow tile, like a Grid or Carousel, the picture goes on top.',
  component: ({ props, renderNode }) => {
    const { openUrl } = useHost();
    const [failed, setFailed] = useState<string | null>(null);
    const src = imageUrl(props.image);
    const shown = src !== null && failed !== src;
    const link = webUrl(props.url);
    const Glyph = kindIcon[props.kind ?? ""];
    const name = props.name ?? "";
    const facts = pairsOf(props.facts);
    return <div className="@container min-w-0">
      <div className={`flex min-w-0 items-start gap-3 ${shown ? "@max-[16rem]:flex-col" : ""}`}>
        <div className={`flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground ${shown ? "@max-[16rem]:aspect-[4/3] @max-[16rem]:size-auto @max-[16rem]:w-full" : ""}`}>
          {shown ? <Zoomable src={src} alt={name} className="size-full"><img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(src)} className="size-full object-cover" /></Zoomable>
            : Glyph ? <Glyph aria-hidden className="size-5" /> : <span aria-hidden className="text-lg font-semibold uppercase">{Array.from(name)[0] ?? ""}</span>}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {link ? <a href={link.href} title={link.href} onClick={openWith(openUrl, link.href)} className={`w-fit max-w-full rounded-sm font-medium text-foreground underline-offset-2 [overflow-wrap:anywhere] hover:underline ${focusRing}`}>{name}</a>
            : <span className="font-medium text-foreground [overflow-wrap:anywhere]">{name}</span>}
          {props.subtitle ? <span className="text-muted-foreground">{props.subtitle}</span> : null}
          {facts.length ? <dl className="m-0 flex flex-wrap gap-x-3 gap-y-0.5 text-sm">{facts.map(([label, value], i) => <div key={i} className="flex min-w-0 gap-1"><dt className="text-muted-foreground">{label}</dt><dd className="m-0 font-medium text-foreground">{cell(value, renderNode)}</dd></div>)}</dl> : null}
        </div>
      </div>
    </div>;
  },
});

const File = defineComponent({
  name: "File",
  props: z.object({ path: z.string(), line: z.number().optional() }),
  description: "A file reference in mono, as path or path:line. An http(s) URL opens on click; a workspace path shows as text.",
  component: ({ props }) => {
    const { openUrl } = useHost();
    const url = webUrl(props.path);
    const label = props.line ? `${props.path ?? ""}:${props.line}` : props.path ?? "";
    const inner = <><FileText aria-hidden className="size-[1em] shrink-0" /><span className="min-w-0 truncate">{label}</span></>;
    const look = "inline-flex w-fit max-w-full items-center gap-1.5 rounded-sm font-mono text-[0.92em]";
    return url ? <a href={url.href} title={url.href} onClick={openWith(openUrl, url.href)} className={`${look} text-primary underline-offset-2 hover:underline ${focusRing}`}>{inner}</a>
      : <span title={label} className={`${look} text-foreground`}>{inner}</span>;
  },
});

const Image = defineComponent({
  name: "Image",
  props: z.object({ src: z.string(), alt: z.string(), caption: z.string().optional() }),
  description: "A picture from an http(s) or data: image URL. alt describes it for screen readers, and shows in its place if it fails to load. caption is a line under it. Clicking it opens it full size. Other sources, like file paths, show the alt text.",
  component: ({ props }) => {
    const [failed, setFailed] = useState<string | null>(null);
    const src = imageUrl(props.src);
    return <figure className="m-0 flex min-w-0 flex-col gap-1.5">
      {src && failed !== src ? <Zoomable src={src} alt={props.alt ?? ""} caption={props.caption}><img src={src} alt={props.alt ?? ""} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(src)} className="block h-auto max-h-96 w-fit max-w-full rounded-md object-contain" /></Zoomable>
        : <div role="img" aria-label={props.alt} className="flex min-h-24 items-center justify-center rounded-md bg-muted p-4 text-center text-muted-foreground"><span><ImageIcon aria-hidden className="mr-1.5 inline size-[1em] align-[-0.125em]" />{props.alt || "Image"}</span></div>}
      {props.caption ? <figcaption className="text-sm text-muted-foreground">{props.caption}</figcaption> : null}
    </figure>;
  },
});

const KeyValue = defineComponent({
  name: "KeyValue",
  props: z.object({ pairs }),
  description: 'Labels and their values in two aligned columns; on a narrow screen each label sits above its value. pairs is an object like {"Owner": "Ana", "Due": "Fri"} or a list of [label, value] pairs. A value may be text, a number, null (shown as a dash), or a component such as Badge or File.',
  component: ({ props, renderNode }) => {
    const rows = pairsOf(props.pairs);
    if (rows.length === 0) return null;
    return <div className="@container min-w-0">
      <dl className="m-0 grid min-w-0 grid-cols-1 @sm:grid-cols-[fit-content(40%)_minmax(0,1fr)] @sm:gap-x-6">
        {rows.map(([label, value], i) => <div key={i} className="col-span-full grid grid-cols-subgrid gap-y-0.5 border-b border-border-hairline py-1.5 first:pt-0 last:border-b-0 last:pb-0">
          <dt className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">{label}</dt>
          <dd className="m-0 min-w-0 text-foreground [overflow-wrap:anywhere]">{cell(value, renderNode)}</dd>
        </div>)}
      </dl>
    </div>;
  },
});

/** List items as rows: a nested List joins the item before it; any other part is its own item. */
export function listRows(items: unknown[]): Array<{ head: unknown; nested: unknown[] }> {
  const rows: Array<{ head: unknown; nested: unknown[] }> = [];
  for (const item of items) {
    if (item === null || item === undefined) continue;
    const last = rows.at(-1);
    if ((item as { typeName?: unknown }).typeName === "List" && last) last.nested.push(item);
    else rows.push({ head: item, nested: [] });
  }
  return rows;
}

const List = defineComponent({
  name: "List",
  props: z.object({ items: z.array(z.any()), ordered: z.boolean().optional() }),
  description: "A bulleted list, or a numbered one with ordered true. Each item is a string or a component, like File or Text. A List right after an item nests under it.",
  component: ({ props, renderNode }) => {
    const Tag = props.ordered ? "ol" : "ul";
    return <Tag className={`m-0 flex min-w-0 flex-col gap-1 pl-5 marker:text-muted-foreground ${props.ordered ? "list-decimal" : "list-disc"}`}>
      {listRows(props.items ?? []).map((row, i) => <li key={i} className="min-w-0 pl-0.5 text-foreground">
        {typeof row.head === "string" || typeof row.head === "number" ? row.head : renderNode(row.head)}
        {row.nested.length ? <div className="pt-1">{renderNode(row.nested)}</div> : null}
      </li>)}
    </Tag>;
  },
});

const Source = defineComponent({
  name: "Source",
  props: z.object({ url: z.string(), title: z.string().optional(), note: z.string().optional() }),
  description: "One cited link of Sources: an http(s) url, a title (the domain shows when it is missing), and an optional short note.",
  component: () => null,
});

type SourceProps = { url: string; title?: string; note?: string };

const Sources = defineComponent({
  name: "Sources",
  props: z.object({ links: z.array(z.union([z.string(), Source.ref])), title: z.string().optional() }),
  description: 'The links an answer drew on, numbered in order, so "[2]" in the reply is the second. Each link is a URL string or a Source with a title and note. Only http(s) links open; another link keeps its number and says it cannot open. title heads the list, default "Sources".',
  component: ({ props }) => {
    const { openUrl } = useHost();
    const items = (props.links ?? []).map((item): Partial<SourceProps> | undefined => typeof item === "string" ? { url: item } : childProps<SourceProps>(item));
    const marker = "flex size-5 shrink-0 items-center justify-center rounded-sm bg-muted text-xs tabular-nums text-muted-foreground";
    return <section className="flex min-w-0 flex-col gap-1">
      <span className="text-sm text-muted-foreground">{props.title ?? "Sources"}</span>
      <ol className="m-0 flex min-w-0 list-none flex-col p-0">
        {items.map((item, i) => {
          // The last link may still be streaming its url.
          if (!item?.url && i === items.length - 1) return null;
          const url = webUrl(item?.url);
          if (!url) return <li key={i} className="flex min-w-0 items-start gap-2.5 py-1"><span className={marker}>{i + 1}</span><span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">Cannot open: {item?.url || "no url"}</span></li>;
          return <li key={i} className="min-w-0">
            <a href={url.href} title={url.href} onClick={openWith(openUrl, url.href)} className={`group/source flex min-w-0 items-start gap-2.5 rounded-sm py-1 text-foreground no-underline ${focusRing}`}>
              <span className={`${marker} group-hover/source:bg-foreground group-hover/source:text-background`}>{i + 1}</span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium underline-offset-2 group-hover/source:underline">{item?.title || domainOf(url)}</span>
                <span className="truncate text-sm text-muted-foreground">{domainOf(url)}{item?.title ? "" : url.pathname.replace(/\/+$/u, "")}</span>
                {item?.note ? <span className="text-sm text-muted-foreground">{item.note}</span> : null}
              </span>
            </a>
          </li>;
        })}
      </ol>
    </section>;
  },
});

const photo = "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/Tour_Eiffel_Wikimedia_Commons.jpg/640px-Tour_Eiffel_Wikimedia_Commons.jpg";

export const group: Group = {
  id: "content",
  name: "Content",
  entries: [
    { component: Heading, summary: "section title", examples: [{ name: "Heading", code: `root = Stack([Heading("Open questions"), Text("Two remain.")])` }] },
    { component: Text, summary: "paragraph", examples: [
      { name: "Tones", code: `root = Stack([Text("Default text."), Text("Muted text.", "muted"), Text("Strong text.", "strong")])` },
    ] },
    { component: Callout, summary: "highlighted note", examples: [
      { name: "Tones", code: `root = Stack([Callout("info", "Heads up", "The API changes on Monday."), Callout("success", "Deployed"), Callout("warning", "Two blockers", "Fix them before Friday."), Callout("danger", "Build failed")])` },
    ] },
    { component: Stat, summary: "one headline number", examples: [
      { name: "With change", code: `root = Stat("Signups", 1240, "+12%", "up")` },
      { name: "Coloured value", code: `root = Stats([Stat("Failing tests", 3, "since main", "neutral", "danger"), Stat("Uptime", "99.98%", "30 days", "neutral", "success")])` },
    ] },
    { component: Stats, summary: "row of Stat", examples: [
      { name: "Three numbers", code: `root = Stats([Stat("Signups", 1240, "+12%", "up"), Stat("Churn", "2.1%", "+0.4%", "down"), Stat("Due", "Fri")])` },
    ] },
    { component: Badge, summary: "status pill", examples: [
      { name: "Tones", code: `root = Stack([Badge("Draft"), Badge("In review", "info"), Badge("Shipped", "success"), Badge("At risk", "warning"), Badge("Blocked", "danger")], "row", "s")` },
    ] },
    { component: Tag, summary: "topic or category label", examples: [
      { name: "Plain, dot, and icon", code: `root = Stack([Tag("design"), Tag("backend", null, "info"), Tag("Ana", "User"), Tag("Berlin", "MapPin", "danger")], "row", "s")` },
    ] },
    { component: Chips, summary: "wrapping row of tags", examples: [
      { name: "Strings and tags", code: `root = Chips(["react", "zod", "vitest", Tag("needs review", "Warning", "warning")])` },
    ] },
    { component: Icon, summary: "small icon from a fixed set", examples: [
      { name: "Inline and toned", code: `root = Stack([Icon("Check", "success", "Done"), Icon("Warning", "warning", "Warning"), Icon("CircleX", "danger", "Failed"), Icon("Rocket"), Icon("GitPullRequest", "info")], "row", "m")` },
    ] },
    { component: Entity, summary: "person, place, or thing", examples: [
      { name: "Place with photo", code: `root = Entity("Eiffel Tower", "Landmark in Paris", "${photo}", {"Height": "330 m", "Opened": 1889, "Visitors": "6M a year"}, "https://www.toureiffel.paris", "place")` },
      { name: "Person, no photo", code: `root = Entity("Ana Lima", "Staff engineer, Payments", null, [["Team", "Payments"], ["Time zone", "UTC-3"]], null, "person")` },
      { name: "Tiles", code: `root = Grid([Entity("Kyoto", "3 nights", "${photo}", {"From": "$180"}), Entity("Nara", "Day trip", null, {"Train": "45 min"}, null, "place"), Entity("Osaka", "2 nights", null, {"From": "$140"})])` },
    ] },
    { component: File, summary: "file path, optional line", examples: [
      { name: "Path and URL", code: `root = Stack([File("src/server/auth.ts", 42), File("README.md"), File("https://github.com/hemaaanth/oh-my-bb/blob/main/README.md")])` },
    ] },
    { component: Image, summary: "picture with alt text", examples: [
      { name: "With caption", code: `root = Image("${photo}", "The Eiffel Tower on a clear day", "Paris, from the Champ de Mars")` },
      { name: "Cannot load", code: `root = Image("/tmp/chart.png", "Weekly signups chart")` },
    ] },
    { component: KeyValue, summary: "labels and values", examples: [
      { name: "Object", code: `root = KeyValue({"Owner": "Ana Lima", "Status": Badge("In review", "info"), "Due": "Fri 24 Oct", "Budget": 12000, "Notes": null})` },
      { name: "Pairs", code: `root = KeyValue([["Entry point", File("server.ts", 12)], ["Runtime", "Node 22"]])` },
    ] },
    { component: List, summary: "bulleted or numbered list", examples: [
      { name: "Bullets", code: `root = List(["Faster builds", "Smaller bundle", "One config file"])` },
      { name: "Numbered, nested", code: `root = List(["Set up", List(["Install Node 22", "Run npm ci"]), "Build", File("dist/index.js"), "Deploy"], true)` },
    ] },
    { component: Sources, summary: "numbered cited links", examples: [
      { name: "With titles", code: `root = Sources([Source("https://react.dev/reference/react/useId", "useId", "Stable ids for accessibility attributes."), Source("https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog", "The dialog element"), "https://www.w3.org/WAI/ARIA/apg/patterns/accordion/"])` },
    ] },
    { component: Source, summary: "one link of Sources", part: true, examples: [] },
  ],
};
