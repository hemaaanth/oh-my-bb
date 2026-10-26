// openui-lang blocks on a page, and the answers baked into it at publish time. A block is
// <script type="text/openui-lang">…</script>; the page runtime (render/spec-runtime) draws it with the chat
// components. The publish (server/spec/bake.ts) adds one <script type="application/json" data-bb-spec-baked>
// with the Query results and web lookups the blocks need, keyed the same way on both sides.
import type { SpecResult } from "../contract.js";

export const SPEC_TYPE = "text/openui-lang";
/** Fence languages Pages claims, in chat and in Markdown pages. OpenUI's own prompt teaches `openui-lang`. GenUI owns `ui`. */
export const SPEC_LANGUAGES = ["openui-lang", "openui"] as const;
/** Raw executable HTML fences; their documents stay in opaque resource-restricted frames. */
export const APP_LANGUAGES = ["app", "pages-app"] as const;
export const APP_READY_ATTRIBUTE = "data-bb-apps-ready";
export const BAKED_ATTRIBUTE = "data-bb-spec-baked";

/** Query results and web lookups by bakedKey. A failed lookup is kept as its message. */
export type Baked = Record<string, SpecResult>;

const BLOCK = /<script\b[^>]*\btype\s*=\s*["']?text\/openui-lang["']?[^>]*>([\s\S]*?)<\/script\s*>/giu;
const BAKED = /<script\b[^>]*\bdata-bb-spec-baked\b[^>]*>[\s\S]*?<\/script\s*>/giu;

/** True when the HTML has an openui-lang block. */
export const hasSpecBlocks = (html: string) => new RegExp(BLOCK.source, "iu").test(html);

/** Each block's code and where its tag starts. */
export function specBlocks(html: string): { code: string; at: number }[] {
  return [...html.matchAll(BLOCK)].map((match) => ({ code: unescapeSpec(match[1]!), at: match.index }));
}

/** A block's code as a script body: "</script" can't appear in it, so it is written "<\/script". */
export const escapeSpec = (code: string) => code.replace(/<\/(script)/giu, "<\\/$1");
export const unescapeSpec = (code: string) => code.replace(/<\\\/(script)/giu, "</$1");

/** The page with any baked answers removed, so a republish bakes fresh. */
export const withoutBaked = (html: string) => html.replace(BAKED, "");

/** The baked answers as a script tag. "<" is escaped, so no string in them can close it. */
export const bakedScript = (baked: Baked) => `<script type="application/json" ${BAKED_ATTRIBUTE}>${JSON.stringify(baked).replace(/</gu, "\\u003c")}</script>`;

/** Sorted-key JSON, so the same arguments give the same key in any order. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** The key of a Query call ("tool") or a web lookup ("web"). */
export const bakedKey = (kind: "tool" | "web", name: string, input: unknown) => `${kind}:${name}:${stable(input ?? {})}`;
