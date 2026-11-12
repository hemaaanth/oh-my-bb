import postcss, { CssSyntaxError, type AnyNode, type Declaration, type Rule } from "postcss";
import { attr, scanHtml } from "../../render/html.js";
import { readPageAsset } from "../../render/assets.js";
import { formatDiagnostics } from "./diagnostics.js";

export interface PageStyleIssue {
  rule: string; offset: number; line: number; column: number; context: string; message: string; file?: string;
}
export const MAX_STYLE_ISSUES = 50;
const remedies = {
  "base-element": "Keep inherited semantic styling; use main.page, .lede, .scroll, .num or .list.",
  "font-family": "Inherit the theme font, or use var(--bb-font-sans) / var(--bb-font-mono).",
  "page-width": "Use main.page, .page.wide or .page.dashboard instead of a page-width reset.",
  "raw-color": "Use var(--bb-text), --bb-muted, --bb-surface, --bb-rule or a status/chart token.",
  "heavy-weight": "Keep inherited weight; use semantic headings/strong with --bb-strong.",
  "left-accent": "Use .note with warning/danger/success/info and a .tone label, or a 1px solid var(--bb-rule) separator.",
  gradient: "Use quiet var(--bb-surface), .note or .grid; mark only a custom visual as custom.",
  eyebrow: "Use .meta-line or .compare-label in sentence case with --bb-muted.",
  "css-syntax": "Fix CSS syntax before checking the author styles again.",
} as const;
type StyleRule = keyof typeof remedies;
let themes: Set<string> | undefined;
export function isBundledThemeStyle(css: string): boolean {
  if (!themes) {
    const raw = readPageAsset("theme.css").bytes.toString("utf8");
    const font = readPageAsset("inter.roman.var.woff2").bytes.toString("base64");
    themes = new Set([raw, raw.replaceAll('url("inter.roman.var.woff2")', `url("data:font/woff2;base64,${font}")`)]);
  }
  return themes.has(css);
}

/** Read type/class/id tokens, ignoring attribute bodies, comments and strings. */
function selectorTokens(selectors: string): string[] {
  const tokens: string[] = [];
  // Only the final compound targets the styled element; ancestors do not reset it.
  const pending = [selectors];
  while (pending.length) for (const group of postcss.list.comma(pending.pop()!)) {
    const selector = postcss.list.split(group, [" ", "\n", "\t", "\r", ">", "+", "~"], false).at(-1) ?? "";
    let bracket = 0;
    for (let i = 0; i < selector.length;) {
      const c = selector[i]!;
      if (selector.startsWith("/*", i)) { const end = selector.indexOf("*/", i + 2); i = end < 0 ? selector.length : end + 2; continue; }
      if (c === "\\") { i += 2; continue; }
      if (c === '"' || c === "'") { const quote = c; for (i++; i < selector.length; i++) { if (selector[i] === "\\") i++; else if (selector[i] === quote) { i++; break; } } continue; }
      if (c === "[") { bracket++; i++; continue; }
      if (c === "]") { bracket--; i++; continue; }
      if (/[a-z_-]/i.test(c)) {
        const start = i++;
        while (i < selector.length && /[\w-]/.test(selector[i]!)) i++;
        const prefix = selector[start - 1] ?? " ";
        if (!bracket && prefix === ":" && selector[i] === "(") {
          const positive = /^(?:is|where)$/i.test(selector.slice(start, i));
          const argumentStart = i + 1;
          let depth = 1;
          for (i++; i < selector.length && depth; i++) {
            if (selector[i] === "\\") i++;
            else if (selector[i] === '"' || selector[i] === "'") {
              const quote = selector[i++];
              for (; i < selector.length; i++) { if (selector[i] === "\\") i++; else if (selector[i] === quote) break; }
            } else if (selector.startsWith("/*", i)) { const end = selector.indexOf("*/", i + 2); i = end < 0 ? selector.length : end + 1; }
            else if (selector[i] === "(") depth++;
            else if (selector[i] === ")") depth--;
          }
          // Apply final-target selection to each positive branch; conditions stay ignored.
          if (positive && depth === 0) pending.push(selector.slice(argumentStart, i - 1));
          continue;
        }
        if (!bracket && !/[:\w-]/.test(prefix)) tokens.push((prefix === "." || prefix === "#" ? prefix : "") + selector.slice(start, i).toLowerCase());
        continue;
      }
      i++;
    }
  }
  return tokens;
}

/** Mask comments, quoted content and url() so colors in assets/text are not declarations. */
function policyValue(value: string): string {
  let out = "";
  for (let i = 0; i < value.length;) {
    if (value.startsWith("/*", i)) { const end = value.indexOf("*/", i + 2); i = end < 0 ? value.length : end + 2; out += " "; }
    else if (/^url\s*\(/i.test(value.slice(i))) {
      i += /^url\s*\(/i.exec(value.slice(i))![0].length;
      let quote = "";
      for (; i < value.length; i++) { const c = value[i]; if (c === "\\") i++; else if (quote) { if (c === quote) quote = ""; } else if (c === '"' || c === "'") quote = c; else if (c === ")") { i++; break; } }
      out += " ";
    } else if (value[i] === '"' || value[i] === "'") {
      const quote = value[i++];
      for (; i < value.length; i++) { if (value[i] === "\\") i++; else if (value[i] === quote) { i++; break; } }
      out += " ";
    } else out += value[i++];
  }
  return out.toLowerCase();
}
const entities: Record<string, string> = { quot: '"', apos: "'", amp: "&", lt: "<", gt: ">", nbsp: " " };
function decode(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|quot|apos|amp|lt|gt|nbsp);/gi, (whole, entity: string) => {
    if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? whole;
    const n = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
  });
}

/** Author CSS only. Custom waivers are exact and never inherited. No script is executed. */
export function lintPageStyles(html: string): PageStyleIssue[] {
  const issues: PageStyleIssue[] = [];
  const starts = [0];
  for (let i = 0; i < html.length; i++) if (html[i] === "\n") starts.push(i + 1);
  const tags = scanHtml(html).tags;
  const frames = new Set<number>();
  const wrappers = new Set([".page", ".container", "#container"]);
  const stack: string[] = [];
  const voids: Record<string, true> = { area: true, base: true, br: true, col: true, embed: true, hr: true, img: true, input: true, link: true, meta: true, param: true, source: true, track: true, wbr: true };
  // Discover outer wrappers before checking styles in the document head.
  for (const tag of tags) {
    if (tag.kind === "end") { const at = stack.lastIndexOf(tag.name); if (at >= 0) stack.length = at; continue; }
    const outer = tag.name === "div" && (stack.at(-1) === "body" || stack.length === 0);
    const classes = (attr(tag, "class") ?? "").split(/\s+/).filter(Boolean);
    const id = attr(tag, "id");
    if (outer || tag.name === "body" || tag.name === "main" || classes.some(name => name === "page" || name === "container") || id === "container") {
      frames.add(tag.start);
      for (const name of classes) wrappers.add(`.${name.toLowerCase()}`);
      if (id) wrappers.add(`#${id.toLowerCase()}`);
    }
    if (!voids[tag.name] && tag.text === undefined) stack.push(tag.name);
  }
  const seen = new Set<string>();
  const report = (rule: StyleRule, offset: number, context: string, message: string = remedies[rule]) => {
    const key = JSON.stringify([rule, offset, context]);
    if (seen.has(key)) return;
    seen.add(key);
    let low = 0, high = starts.length;
    while (low + 1 < high) { const mid = (low + high) >>> 1; if (starts[mid]! <= offset) low = mid; else high = mid; }
    issues.push({ rule, offset, line: low + 1, column: offset - starts[low]! + 1, context: context.slice(0, 100), message });
  };
  const lintCss = (css: string, offset: number, inline: boolean, context: string, pageFrame: boolean) => {
    if (!inline && isBundledThemeStyle(css)) return;
    let root;
    try { root = postcss.parse(inline ? `x{${css}}` : css, { from: undefined }); }
    catch (error) {
      const at = error instanceof CssSyntaxError ? error.input?.offset ?? 0 : 0;
      report("css-syntax", offset + (inline ? 0 : at), context); return;
    }
    const eyebrows = new Map<string, { context: string; scope: string[][]; upper?: Declaration; spaced?: Declaration }>();
    root.walkRules((rule: Rule) => {
      if (inline) return;
      const hints = new Set<string>();
      for (const type of selectorTokens(rule.selector)) {
        if (/^h[1-6]$/.test(type)) hints.add("Remove this override; headings inherit theme styling.");
        else if (/^(?:table|th|td)$/.test(type)) hints.add("Remove this override; use .scroll for wide tables and .num for numeric columns.");
        else if (type === "body" || type === "html") hints.add("Remove this override; use body.auto and main.page for the page frame.");
        else if (type === "p") hints.add("Remove this override; paragraphs inherit theme styling. Use .lede for lead text.");
        else if (type === "a") hints.add("Remove this override; links inherit theme styling.");
        else if (type === "code" || type === "pre") hints.add("Remove this override; code/pre inherit the theme font. Use .scroll for wide code.");
        else if (/^(?:ul|ol|li)$/.test(type)) hints.add("Remove this override; lists inherit theme styling. Use .list for labelled rows.");
      }
      if (hints.size) report("base-element", offset + (rule.source?.start?.offset ?? 0), rule.selector, [...hints].join(" "));
    });
    root.walkDecls((decl: Declaration) => {
      const parent = decl.parent;
      const selector = parent?.type === "rule" ? parent.selector : "";
      const label = inline ? context : selector || parent?.type || "CSS";
      // Decoded attributes keep their original value location, not a misleading decoded column.
      const at = inline ? offset : offset + (decl.source?.start?.offset ?? 0);
      const prop = decl.prop.toLowerCase(), value = policyValue(decl.value);
      const emit = (rule: StyleRule) => report(rule, at, label);
      if (/^--bb-font-(?:sans|mono)$/.test(decl.prop) || (prop === "font-family" && !/^(?:inherit|initial|unset|revert(?:-layer)?|var\(\s*--bb-font-(?:sans|mono)\s*\))$/i.test(decl.value.trim())) || (prop === "font" && !/^(inherit|initial|unset|revert(?:-layer)?|var\([^)]*\))$/i.test(decl.value.trim()))) emit("font-family");
      if ((prop === "font-weight" && (/\b(?:bold|bolder)\b/.test(value) || value.trim().split(/\s+/).some(weight => Number(weight) >= 600))) || (prop === "font" && /(?:^|\s)(?:bold|bolder|[6-9]\d\d(?:\.\d+)?|\d{4,})(?=\s)/.test(value))) emit("heavy-weight");
      if (/^(?:max-)?width$/.test(prop) && (inline ? pageFrame : selectorTokens(selector).some(token => token === "body" || token === "main" || wrappers.has(token)))) emit("page-width");
      if (/#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\w-])|\b(?:rgba?|hsla?)\s*\(/i.test(value)) emit("raw-color");
      if (/\b(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/.test(value)) emit("gradient");
      const quietSeparator = /^border-(?:left|inline-start)$/.test(prop) && /^(?:1px|thin)\s+solid\s+var\(\s*--bb-rule\s*\)$/.test(value.trim());
      if (/^border-(?:left|inline-start)(?:-(?:width|style|color))?$/.test(prop) && !quietSeparator && !/(?:^|\s)(?:none|hidden|0(?:[a-z%]+)?)(?:\s|$)/.test(value) && value !== "transparent") emit("left-accent");
      const scope: string[][] = [];
      for (let ancestor: AnyNode | undefined = parent; ancestor; ancestor = ancestor.parent) if (ancestor.type === "atrule") scope.push([ancestor.name.toLowerCase(), ancestor.params]);
      scope.reverse();
      const key = JSON.stringify([label, scope]);
      const state = eyebrows.get(key) ?? { context: label, scope };
      if (prop === "text-transform" && value.trim() === "uppercase") state.upper = decl;
      if (prop === "letter-spacing" && !/^(?:normal|0(?:[a-z%]+)?)$/.test(value.trim()) && !/^\s*-/.test(value)) state.spaced = decl;
      eyebrows.set(key, state);
    });
    for (const state of eyebrows.values()) {
      let upper = state.upper, spaced = state.spaced;
      // Root and enclosing scopes apply inside nested scopes, but sibling conditions do not.
      for (let depth = state.scope.length - 1; depth >= 0 && (!upper || !spaced); depth--) {
        const enclosing = eyebrows.get(JSON.stringify([state.context, state.scope.slice(0, depth)]));
        upper ??= enclosing?.upper;
        spaced ??= enclosing?.spaced;
      }
      if (upper && spaced) report("eyebrow", inline ? offset : offset + (upper.source?.start?.offset ?? 0), state.context);
    }
  };
  for (const tag of tags) {
    if (tag.kind !== "start") continue;
    const custom = attr(tag, "data-pages-style") === "custom";
    const frame = frames.has(tag.start);
    if (!custom && tag.name === "style") lintCss(tag.text ?? "", tag.end, false, "style", false);
    const index = tag.attrs.findIndex(([name]) => name === "style");
    if (!custom && index >= 0) lintCss(decode(tag.attrs[index]![1]), tag.valueRanges[index]![0], true, tag.name, frame);
  }
  return issues.sort((a, b) => a.offset - b.offset);
}

export function formatStyleIssues(issues: readonly PageStyleIssue[], limit = MAX_STYLE_ISSUES, total = issues.length): string {
  const lines = issues.slice(0, limit).map(issue => `${issue.file ? `${issue.file}:` : ""}${formatDiagnostics([{ ...issue, severity: "warning", message: `[${issue.rule}] ${issue.context}: ${issue.message}` }])}`);
  if (total > Math.min(issues.length, limit)) lines.push(`${total - Math.min(issues.length, limit)} more style findings omitted.`);
  return lines.join("\n");
}
