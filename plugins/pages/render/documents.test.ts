import { describe, expect, it } from "vitest";
import type { PrReviewDocument } from "../contract.js";
import { renderMarkdown, renderPrReview } from "./index.js";

describe("renderMarkdown", () => {
  it("escapes raw HTML and refuses script links", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))', { title: "t" });
    expect(html).not.toMatch(/<script>alert|<img src=x|href="javascript:/u);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("uses a leading h1 as the title, otherwise adds the given title", () => {
    expect(renderMarkdown("# Own title\n\ntext", { title: "file.md" }).match(/<h1>/gu)).toHaveLength(1);
    expect(renderMarkdown("# Own title", { title: "file.md" })).toContain("<h1>Own title</h1>");
    expect(renderMarkdown("## Section\n\ntext", { title: "A <b> title" })).toContain("<h1>A &lt;b&gt; title</h1>");
  });

  it("returns a themed document with language-tagged code fences", () => {
    const html = renderMarkdown("```ts\nconst a = 1 < 2;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |", { title: "t" });
    expect(html).toMatch(/^<!doctype html>/u);
    expect(html).toContain('<body class="auto">\n<main class="page">');
    expect(html).toContain('<pre><code class="language-ts">const a = 1 &lt; 2;');
    expect(html).toContain("<table>");
  });
});

const review: PrReviewDocument = {
  schema: "pr-review/v1",
  title: "PR 1: <review>",
  target: { kind: "pull-request", label: "org/repo#1", headSha: "0c2843455487a9836c5d92a94b32a5731525f104", url: "https://github.com/org/repo/pull/1" },
  intent: "Make it *safe*.",
  summary: "Two findings. <script>alert(1)</script>",
  verdict: "changes-requested",
  coverage: { reviewed: ["All files"], skipped: [], validation: ["tests <b>passed</b>", "lint passed"] },
  findings: [
    { id: "a", severity: "important", category: "bug", title: "Guard `history`", explanation: "It **leaks**.", evidence: "```\nreturn x;\n```", path: "src/a.ts", line: 88, endLine: 90, confidence: "high", suggestedAction: "Add the guard." },
    { id: "b", severity: "nit", category: "docs", title: "Comment", explanation: "Wrong flag.", evidence: "line 39", path: "src/b.ts", confidence: "medium" },
  ],
  diagrams: [{ title: "Flow", alt: "Flow alt", assets: [
    { id: "l", lens: "architecture", theme: "light", view: null, svg: "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", width: 10, height: 10, animated: false },
    { id: "d", lens: "architecture", theme: "dark", view: null, svg: "<svg xmlns='http://www.w3.org/2000/svg'/>", width: 10, height: 10, animated: false },
  ] }],
};

describe("renderPrReview", () => {
  const html = renderPrReview(review);

  it("renders the header once: title, lede, and a meta line with target, verdict, short SHA", () => {
    expect(html.match(/PR 1: &lt;review&gt;/gu)).toHaveLength(2); // <title> and <h1>
    expect(html).toContain('<div class="lede"><p>Two findings. &lt;script&gt;');
    expect(html).toContain('<div class="meta-line"><span><a href="https://github.com/org/repo/pull/1">org/repo#1</a></span><span class="verdict changes-requested">Changes requested</span><span class="sha">0c28434</span></div>');
    expect(html.slice(html.indexOf('<div class="meta-line">'), html.indexOf("<h2>Coverage</h2>"))).not.toMatch(/<code>|class="badge"/u);
    expect(html).not.toMatch(/renderer|footer/iu);
  });

  it("orders Coverage, diagrams, then Findings, and omits empty coverage rows", () => {
    const order = ["<h2>Coverage</h2>", '<figure class="diagram">', "<h2>Findings</h2>"].map((marker) => html.indexOf(marker));
    expect(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1]!))).toBe(true);
    expect(html).toContain("<dt>Intent</dt><dd>Make it <em>safe</em>.</dd>");
    expect(html).not.toContain("<dt>Skipped</dt>");
    expect(html).toContain("<li>tests &lt;b&gt;passed&lt;/b&gt;</li>");
  });

  it("shows light and dark diagrams as images, never inline SVG", () => {
    expect(html.match(/<img class="(light|dark)"/gu)).toEqual(['<img class="light"', '<img class="dark"']);
    expect(html).not.toContain("<svg");
    expect(html).toContain('data-bb-theme="dark"] .diagram .light { display: none; }');
  });

  it("renders each finding as one item: dot, title, location, text, evidence, next", () => {
    expect(html).toContain('<ol class="findings">');
    expect(html).toContain('<li><span class="sev important" role="img" aria-label="Important" title="Important"></span><strong>Guard <code>history</code></strong>\n<span class="loc">src/a.ts:88–90</span>\n<p>It <strong>leaks</strong>.</p>');
    expect(html).toContain("<details><summary>Evidence</summary><pre><code>return x;\n</code></pre>\n</details>");
    expect(html).toContain("<p><strong>Next:</strong> Add the guard.</p>");
    expect(html).toContain('<span class="loc">src/b.ts</span>');
  });

  it("says so quietly when there are no findings", () => {
    expect(renderPrReview({ ...review, findings: [], diagrams: undefined })).toContain('<h2>Findings</h2>\n<div class="note"><p>No verified findings.</p></div>');
  });
});
