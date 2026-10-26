// What a spec component may ask of the place it renders in. Group files never import the BB SDK:
// the chat fence and the gallery wire these to BB, and the page bundle (published pages, shared sites)
// wires them to plain fallbacks and data baked in at publish time.
import { createContext, lazy, useContext, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { focusRing } from "../ui.js";
import { decodeAsset, type AssetBytes, type ImageResult } from "./assets.js";
import type { AppBlockProps } from "../apps/AppBlock.js";
export type { AssetBytes, ImageResult } from "./assets.js";

/** Web lookups the Pages server runs for Map, Gallery, and ImageSearch. Answers are JSON. */
export type WebMethod = "tile" | "geocode" | "search" | "image" | "wiki";

export type Host = {
  /** "chat" in a reply, "gallery" in settings, "page" in a published page or shared site. */
  kind: "chat" | "gallery" | "page";
  threadId: string | null;
  blockKey: string | null;
  appsReady: boolean;
  App: ComponentType<AppBlockProps>;
  SourceCode: ComponentType<{ content: string; path: string }>;
  Diff: ComponentType<{ patch: string; path: string }>;
  Markdown: ComponentType<{ content: string }>;
  /** A web lookup. Rejects when lookups are off or fail; components then say so. */
  web: (method: WebMethod, input: Record<string, unknown>) => Promise<unknown>;
  /** Assets are local to this thread, or embedded at publish time. No browser-side remote fetches. */
  loadAsset: (src: string) => Promise<AssetBytes>;
  loadImage: (src: string) => Promise<ImageResult>;
  loadText: (src: string) => Promise<string>;
  animations: boolean;
  /** Opens an http(s) link the way the host does. */
  openUrl: (url: string) => void;
  /** Null outside BB; opens a scoped live file at one-based lines after a user click. */
  openFile: ((path: string, startLine?: number, endLine?: number) => Promise<boolean>) | null;
  /** True when an action can send a message to the thread. A page cannot: components that send turn read-only and say so. */
  replies: boolean;
};

const languages: Record<string, string> = {
  bash: "Shell", c: "C", cpp: "C++", cs: "C#", css: "CSS", diff: "Diff", go: "Go", h: "C", html: "HTML", java: "Java", js: "JavaScript",
  json: "JSON", jsx: "JSX", kt: "Kotlin", md: "Markdown", mjs: "JavaScript", openui: "openui-lang", php: "PHP", py: "Python", rb: "Ruby",
  rs: "Rust", scss: "SCSS", sh: "Shell", sql: "SQL", svelte: "Svelte", swift: "Swift", toml: "TOML", ts: "TypeScript", tsx: "TSX", txt: "Text",
  vue: "Vue", xml: "XML", yaml: "YAML", yml: "YAML", zsh: "Shell",
};

/** The language name a code header shows: "TypeScript" for "src/app.ts", "Dockerfile" for a Dockerfile. */
export function codeLanguage(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot < 1) return name || "Text";
  const ext = name.slice(dot + 1).toLowerCase();
  return languages[ext] ?? ext.toUpperCase();
}

/** Copies text; the label reads "Copied" or "Copy failed" for 1.5 s. */
export function useCopy(text: string) {
  const [copied, setCopied] = useState<"Copied" | "Copy failed" | null>(null);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(null), 1500); return () => clearTimeout(timer); }, [copied]);
  const copy = () => { navigator.clipboard?.writeText(text).then(() => setCopied("Copied"), () => setCopied("Copy failed")) ?? setCopied("Copy failed"); };
  return [copied, copy] as const;
}

/** The one frame every code and diff view sits in: a header with its label and Copy, then the body. */
export function CodeFrame({ label, text, children }: { label: string; text: string; children: ReactNode }) {
  const [copied, copy] = useCopy(text);
  // The border is drawn on top, so the code's own background can't thin it at the rounded corners.
  return <figure className="relative m-0 min-w-0 overflow-hidden rounded-md after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-border-hairline after:content-['']">
    <figcaption className="flex items-center justify-between gap-2 border-b border-border-hairline px-3 py-1 text-xs text-subtle-foreground">
      <span className="min-w-0 truncate">{label}</span>
      <button type="button" onClick={copy} aria-label={`Copy ${label}`} className={`shrink-0 cursor-pointer rounded-sm hover:text-foreground ${focusRing}`}><span aria-live="polite">{copied ?? "Copy"}</span></button>
    </figcaption>
    {children}
  </figure>;
}

const plain = "m-0 overflow-x-auto whitespace-pre-wrap p-3 font-mono text-[0.92em]";

export const fallbackHost: Host = {
  kind: "page",
  threadId: null,
  blockKey: null,
  appsReady: true,
  App: lazy(() => import("../apps/AppBlock.js").then((module) => ({ default: module.AppBlock }))),
  SourceCode: ({ content, path }) => <CodeFrame label={codeLanguage(path)} text={content}><pre className={plain}><code>{content}</code></pre></CodeFrame>,
  Diff: ({ patch, path }) => <CodeFrame label={path} text={patch}><pre className={plain}><code>{patch}</code></pre></CodeFrame>,
  Markdown: ({ content }) => <p className="m-0 whitespace-pre-wrap">{content}</p>,
  web: () => Promise.reject(new Error("Web lookups are not available here.")),
  loadAsset: async (src) => decodeAsset(src),
  loadImage: async (src) => src.startsWith("data:image/") ? { ok: true, url: src } : { ok: false, error: "This image was not saved with the page." },
  loadText: () => Promise.reject(new Error("This source file was not saved with the page.")),
  animations: true,
  openUrl: (url) => { if (/^https?:\/\//iu.test(url)) window.open(url, "_blank", "noopener,noreferrer"); },
  openFile: null,
  replies: false,
};

export const HostContext = createContext<Host>(fallbackHost);
export const useHost = (): Host => useContext(HostContext);
