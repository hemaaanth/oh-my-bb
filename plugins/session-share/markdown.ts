import { marked, Renderer } from "marked";
import sanitizeHtml from "sanitize-html";

const renderer = new Renderer();
const renderTable = renderer.table.bind(renderer);
renderer.table = (token) =>
  `<bb-table-scroll role="region" aria-label="Scrollable table" tabindex="0">${renderTable(token)}</bb-table-scroll>`;

export function renderSharedMarkdown(markdown: string): string {
  return sanitizeHtml(
    marked.parse(markdown, {
      async: false,
      breaks: true,
      gfm: true,
      renderer,
    }),
    {
      allowedTags: [
        "a",
        "blockquote",
        "br",
        "code",
        "del",
        "bb-table-scroll",
        "em",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "hr",
        "li",
        "ol",
        "p",
        "pre",
        "strong",
        "table",
        "tbody",
        "td",
        "th",
        "thead",
        "tr",
        "ul",
      ],
      allowedAttributes: {
        a: ["href", "title"],
        "bb-table-scroll": ["role", "aria-label", "tabindex"],
      },
      allowedSchemes: ["http", "https", "mailto"],
    },
  );
}
