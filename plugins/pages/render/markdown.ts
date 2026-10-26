import MarkdownIt from "markdown-it";
import { escapeHtml } from "./html.js";
import { APP_LANGUAGES, APP_READY_ATTRIBUTE, SPEC_LANGUAGES, SPEC_TYPE, escapeSpec } from "./spec-baked.js";

// Raw HTML off: "<script>" in Markdown is shown as text. markdown-it also
// refuses javascript:, vbscript:, file:, and non-image data: links.
const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

// Markdown pages draw ```openui-lang (and ```openui) fences with the chat components: each becomes a block the page runtime renders.
const pageMd = new MarkdownIt({ html: false, linkify: true, typographer: true });
const fence = pageMd.renderer.rules.fence!;
pageMd.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index]!;
  const language = token.info.trim().split(/\s+/u)[0] ?? "";
  const spec = (SPEC_LANGUAGES as readonly string[]).includes(language);
  const app = (APP_LANGUAGES as readonly string[]).includes(language);
  if (!spec && !app) return fence(tokens, index, options, env, self);
  // The token's source range includes the closing marker only when one exists.
  let lines = token.content && !token.content.endsWith("\n") ? 1 : 0;
  for (let i = 0; i < token.content.length; i++) if (token.content.charCodeAt(i) === 10) lines++;
  const closed = !!token.map && token.map[1] - token.map[0] === lines + 2;
  if (spec) return `<script type="${SPEC_TYPE}"${closed ? "" : ` ${APP_READY_ATTRIBUTE}="false"`}>${escapeSpec(token.content)}</script>\n`;
  if (app) {
    // A truncated app fence remains code; no preview bootstrap or app script runs.
    if (closed) return `<script type="${SPEC_TYPE}">${escapeSpec(`root = App(${JSON.stringify(`app-${index}`)}, ${JSON.stringify(token.content)})`)}</script>\n`;
  }
  return fence(tokens, index, options, env, self);
};

/** Markdown → block HTML (paragraphs, lists, code, tables). Safe for untrusted text. */
export function markdownBlock(text: string): string {
  return md.render(text);
}

/** Markdown → inline HTML (no wrapping <p>). Safe for untrusted text. */
export function markdownInline(text: string): string {
  return md.renderInline(text);
}

/** A full themed document around body HTML. */
export function pageDocument(title: string, body: string, head = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>${head}
</head>
<body class="auto">
<main class="page">
${body}</main>
</body>
</html>
`;
}

/** Markdown file → full HTML document. The first line's h1 is the title; otherwise the given title becomes the h1. */
export function renderMarkdown(markdown: string, options: { title: string }): string {
  const tokens = pageMd.parse(markdown, {});
  const opensWithTitle = tokens[0]?.type === "heading_open" && tokens[0].tag === "h1";
  const body = pageMd.renderer.render(tokens, pageMd.options, {});
  return pageDocument(options.title, `${opensWithTitle ? "" : `<h1>${escapeHtml(options.title)}</h1>\n`}${body}`);
}
