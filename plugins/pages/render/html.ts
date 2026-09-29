// Small HTML helpers shared by the renderers. No DOM, no dependencies.

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** JSON that is safe inside <script type="application/json">: no "</script>", no "<!--". */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

export type TagToken = {
  kind: "start" | "end";
  /** Lowercase tag name. */
  name: string;
  /** Index of "<". */
  start: number;
  /** Index just after ">". */
  end: number;
  /** Attributes in source order. Names are lowercase; values are raw (not entity-decoded). */
  attrs: Array<[string, string]>;
  /** For raw-text elements (script, style, …): the text between the start tag and its end tag. */
  text?: string;
};

export type ScanResult = {
  tags: TagToken[];
  /** Index just after the doctype, or -1. */
  doctypeEnd: number;
};

// Elements whose content is not parsed as markup. A "</head>" or "<html>"
// inside them is text, never a tag.
const RAW_TEXT: Record<string, true> = { script: true, style: true, textarea: true, title: true, xmp: true, iframe: true, noembed: true, noframes: true, noscript: true };

const isSpace = (char: string) => char === " " || char === "\n" || char === "\t" || char === "\f" || char === "\r";

/**
 * Tokenise just enough HTML to find real tags. Comments, doctypes, processing
 * instructions, and raw-text element bodies are skipped, so markup that only
 * looks like a tag (inside a script string or a comment) is never reported.
 */
export function scanHtml(html: string): ScanResult {
  const tags: TagToken[] = [];
  let doctypeEnd = -1;
  let index = 0;
  const length = html.length;
  while (index < length) {
    const open = html.indexOf("<", index);
    if (open < 0) break;
    const next = html.charCodeAt(open + 1);
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      index = close < 0 ? length : close + 3;
      continue;
    }
    if (next === 33 /* ! */ || next === 63 /* ? */) {
      const close = html.indexOf(">", open + 2);
      const end = close < 0 ? length : close + 1;
      if (doctypeEnd < 0 && /^<!doctype/i.test(html.slice(open, open + 9))) doctypeEnd = end;
      index = end;
      continue;
    }
    const isEnd = next === 47; /* / */
    const nameStart = isEnd ? open + 2 : open + 1;
    const first = html.charCodeAt(nameStart) | 32; // ASCII letter, either case
    if (first < 97 || first > 122) {
      index = open + 1;
      continue;
    }
    let cursor = nameStart;
    while (cursor < length && !isSpace(html[cursor]!) && html[cursor] !== "/" && html[cursor] !== ">") cursor += 1;
    const name = html.slice(nameStart, cursor).toLowerCase();
    const attrs: Array<[string, string]> = [];
    // Attributes: quoted values may contain ">".
    while (cursor < length && html[cursor] !== ">") {
      const char = html[cursor]!;
      if (isSpace(char) || char === "/") {
        cursor += 1;
        continue;
      }
      const attrStart = cursor;
      while (cursor < length && !isSpace(html[cursor]!) && html[cursor] !== "/" && html[cursor] !== ">" && html[cursor] !== "=") cursor += 1;
      if (cursor === attrStart) cursor += 1; // a stray "=" at attribute start
      const attrName = html.slice(attrStart, cursor).toLowerCase();
      while (cursor < length && isSpace(html[cursor]!)) cursor += 1;
      let value = "";
      if (html[cursor] === "=") {
        cursor += 1;
        while (cursor < length && isSpace(html[cursor]!)) cursor += 1;
        const quote = html[cursor];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, cursor + 1);
          const stop = close < 0 ? length : close;
          value = html.slice(cursor + 1, stop);
          cursor = stop + 1;
        } else {
          const valueStart = cursor;
          while (cursor < length && !isSpace(html[cursor]!) && html[cursor] !== ">") cursor += 1;
          value = html.slice(valueStart, cursor);
        }
      }
      if (attrName) attrs.push([attrName, value]);
    }
    const end = Math.min(cursor + 1, length);
    const token: TagToken = { kind: isEnd ? "end" : "start", name, start: open, end, attrs };
    tags.push(token);
    index = end;
    if (!isEnd && name === "plaintext") break;
    if (!isEnd && RAW_TEXT[name]) {
      const closer = new RegExp(`</${name}[\\s/>]`, "ig");
      closer.lastIndex = end;
      const match = closer.exec(html);
      const stop = match ? match.index : length;
      token.text = html.slice(end, stop);
      index = stop;
    }
  }
  return { tags, doctypeEnd };
}

export function attr(token: TagToken, name: string): string | undefined {
  return token.attrs.find(([key]) => key === name)?.[1];
}

export function hasClass(token: TagToken, className: string): boolean {
  return (attr(token, "class") ?? "").split(/\s+/u).includes(className);
}
