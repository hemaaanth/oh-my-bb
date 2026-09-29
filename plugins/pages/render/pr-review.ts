import type { PrReviewDocument } from "../contract.js";
import { escapeHtml } from "./html.js";
import { markdownBlock, markdownInline, pageDocument } from "./markdown.js";

const VERDICT: Record<PrReviewDocument["verdict"], string> = { pass: "Pass", "changes-requested": "Changes requested", advisory: "Advisory" };
const SEVERITY: Record<PrReviewDocument["findings"][number]["severity"], string> = { important: "Important", nit: "Nit", "pre-existing": "Pre-existing" };

// The meta line stays plain text: a verdict word with a small status dot, and
// the SHA in mono without the inline-code chip.
const META_STYLE = `
<style>
.meta-line { align-items: baseline; }
.meta-line .verdict { display: inline-flex; align-items: center; gap: 0.4rem; }
.meta-line .verdict::before { content: ""; width: 0.4375rem; height: 0.4375rem; border-radius: 50%; background: var(--bb-muted); }
.meta-line .verdict.changes-requested::before { background: var(--bb-negative); }
.meta-line .verdict.pass::before { background: var(--bb-positive); }
.meta-line .sha { font-family: var(--bb-font-mono); font-size: 0.8125rem; }
</style>`;

// Diagrams come as a light and a dark SVG. Show the one that matches the page:
// data-bb-theme in the BB preview, the reader's system when published.
const DIAGRAM_STYLE = `
<style>
.diagram img { display: block; }
.diagram .dark { display: none; }
:root[data-bb-theme="dark"] .diagram .light { display: none; }
:root[data-bb-theme="dark"] .diagram .dark { display: block; }
@media (prefers-color-scheme: dark) {
  :root:not([data-bb-theme]) .diagram .light { display: none; }
  :root:not([data-bb-theme]) .diagram .dark { display: block; }
}
</style>`;

/** SVG as an <img>: scripts inside the SVG never run, and CSP allows data: images. */
function svgImage(svg: string, alt: string, className: string): string {
  return `<img class="${className}" alt="${escapeHtml(alt)}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}">`;
}

function itemsHtml(items: string[]): string {
  if (items.length === 1) return markdownInline(items[0]!);
  return `<ul>${items.map((item) => `<li>${markdownInline(item)}</li>`).join("")}</ul>`;
}

function diagramHtml(diagram: NonNullable<PrReviewDocument["diagrams"]>[number]): string {
  const light = diagram.assets?.find((asset) => asset.theme === "light")?.svg ?? diagram.svg ?? diagram.assets?.[0]?.svg;
  const dark = diagram.assets?.find((asset) => asset.theme === "dark")?.svg;
  if (!light) return "";
  const images = dark && dark !== light
    ? `${svgImage(light, diagram.alt, "light")}${svgImage(dark, diagram.alt, "dark")}`
    : svgImage(light, diagram.alt, "");
  return `<figure class="diagram">${images}<figcaption>${escapeHtml(diagram.title)}</figcaption></figure>`;
}

function findingHtml(finding: PrReviewDocument["findings"][number]): string {
  const lines = finding.line ? `:${finding.line}${finding.endLine && finding.endLine !== finding.line ? `–${finding.endLine}` : ""}` : "";
  const severity = SEVERITY[finding.severity];
  return [
    `<li><span class="sev ${finding.severity}" role="img" aria-label="${severity}" title="${severity}"></span><strong>${markdownInline(finding.title)}</strong>`,
    `<span class="loc">${escapeHtml(finding.path + lines)}</span>`,
    markdownBlock(finding.explanation),
    `<details><summary>Evidence</summary>${markdownBlock(finding.evidence)}</details>`,
    finding.suggestedAction ? `<p><strong>Next:</strong> ${markdownInline(finding.suggestedAction)}</p>` : "",
    "</li>",
  ].filter(Boolean).join("\n");
}

/** pr-review/v1 → full HTML document using the theme classes. */
export function renderPrReview(document: PrReviewDocument): string {
  const { target, coverage } = document;
  const targetLabel = escapeHtml(target.label);
  const meta = [
    `<span>${target.url && /^https?:\/\//iu.test(target.url) ? `<a href="${escapeHtml(target.url)}">${targetLabel}</a>` : targetLabel}</span>`,
    `<span class="verdict ${document.verdict}">${VERDICT[document.verdict]}</span>`,
    target.headSha ? `<span class="sha">${escapeHtml(target.headSha.slice(0, 7))}</span>` : "",
  ].filter(Boolean);
  const coverageRows: Array<[string, string]> = [["Intent", markdownInline(document.intent)]];
  if (coverage.reviewed.length) coverageRows.push(["Reviewed", itemsHtml(coverage.reviewed)]);
  if (coverage.validation.length) coverageRows.push(["Validation", itemsHtml(coverage.validation)]);
  if (coverage.skipped.length) coverageRows.push(["Skipped", itemsHtml(coverage.skipped)]);
  const diagrams = (document.diagrams ?? []).map(diagramHtml).filter(Boolean);
  const body = [
    `<h1>${escapeHtml(document.title)}</h1>`,
    `<div class="lede">${markdownBlock(document.summary)}</div>`,
    `<div class="meta-line">${meta.join("")}</div>`,
    "<h2>Coverage</h2>",
    `<dl class="list">\n${coverageRows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join("\n")}\n</dl>`,
    ...diagrams,
    "<h2>Findings</h2>",
    document.findings.length
      ? `<ol class="findings">\n${document.findings.map(findingHtml).join("\n")}\n</ol>`
      : '<div class="note"><p>No verified findings.</p></div>',
  ];
  return pageDocument(document.title, `${body.join("\n")}\n`, META_STYLE + (diagrams.length ? DIAGRAM_STYLE : ""));
}
