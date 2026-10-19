// <i data-icon="name"></i> in a page becomes an inline MingCute SVG. injectPage calls this for every
// served view, so icons draw the same in chat, in the panel, and on shared sites, with no script and no font.
import type { TagToken } from "../html.js";

/** assets/icons.json, written by render/icons/build.mjs: SVG path markup per icon, and familiar names. */
export type IconSet = { line: Record<string, string>; fill: Record<string, string>; aliases: Record<string, string> };

/** Lowercase, without spaces, dashes, or underscores, as in generate.mjs. */
const iconKey = (name: string) => name.toLowerCase().replace(/[\s_-]/gu, "");

/**
 * The path markup for a data-icon name, or undefined. A whole name wins ("chart-line" is MingCute chart_line).
 * Otherwise a trailing "fill" or "line" picks the style of the exact MingCute name, then of the familiar name.
 */
export function iconPaths(name: string, set: IconSet): string | undefined {
  const key = iconKey(name);
  const whole = set.line[set.aliases[key] ?? key];
  if (whole) return whole;
  const match = /^(.+)(fill|line)$/u.exec(key);
  if (!match) return undefined;
  const [, base, style] = match as unknown as [string, string, "fill" | "line"];
  const glyphs = set[style];
  return glyphs[base] ?? glyphs[set.aliases[base] ?? ""];
}

const SAFE_NAME = /^[a-z_:][-\w:.]*$/u;

/**
 * Replacements for each empty `<i data-icon>` element: [start, end, svg]. The element must be empty
 * (whitespace allowed) so no author content is lost. Other attributes carry over; class gains "icon".
 * Icons are decorative (aria-hidden) unless the author gave an aria-label, which makes them role="img".
 */
export function iconReplacements(html: string, tags: TagToken[], set: IconSet): Array<[number, number, string]> {
  const out: Array<[number, number, string]> = [];
  tags.forEach((tag, index) => {
    if (tag.kind !== "start" || tag.name !== "i") return;
    const name = tag.attrs.find(([key]) => key === "data-icon")?.[1];
    const close = tags[index + 1];
    if (!name || close?.kind !== "end" || close.name !== "i" || html.slice(tag.end, close.start).trim()) return;
    const paths = iconPaths(name, set);
    if (!paths) return;
    const attrs = new Map<string, string>();
    for (const [key, value] of tag.attrs) if (SAFE_NAME.test(key) && !attrs.has(key)) attrs.set(key, value.replaceAll('"', "&quot;"));
    const label = attrs.has("aria-label");
    const extra = [...attrs].filter(([key]) => key !== "class").map(([key, value]) => ` ${key}="${value}"`).join("");
    const className = `icon${attrs.get("class") ? ` ${attrs.get("class")}` : ""}`;
    const a11y = label ? (attrs.has("role") ? "" : ' role="img"') : attrs.has("aria-hidden") ? "" : ' aria-hidden="true"';
    out.push([tag.start, close.end, `<svg class="${className}" viewBox="0 0 24 24" fill="currentColor"${a11y}${extra}>${paths}</svg>`]);
  });
  return out;
}
