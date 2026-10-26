// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PAGE_RUNTIME } from "./page-runtime.js";
import { renderPrReview } from "./pr-review.js";
import type { PrReviewDocument } from "../contract.js";

afterEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; });

const css = readFileSync("assets/theme.css", "utf8");
// jsdom does not resolve CSS variables; use literal colors for these border checks.
const tableCss = css.slice(css.indexOf(":where(table) {"), css.indexOf("/* Virtualized data table."))
  .replaceAll("var(--bb-rule)", "#ccc").replaceAll("var(--bb-line)", "#ddd");

it("draws a complete rule above the footer, including its numeric cells", () => {
  document.head.innerHTML = `<style>${tableCss}</style>`;
  document.body.innerHTML = `<table><tbody><tr><th>Other</th><td>1</td><td>+0</td></tr></tbody><tfoot><tr><th>Total</th><td>581</td><td>+43526</td></tr></tfoot></table>`;
  for (const cell of document.querySelectorAll("tfoot th, tfoot td")) {
    expect(window.getComputedStyle(cell).borderTopWidth).toBe("1px");
    expect(window.getComputedStyle(cell).borderTopStyle).toBe("solid");
  }
  const bodyBorders = [...document.querySelectorAll("tbody th, tbody td")].map((cell) => window.getComputedStyle(cell).borderBottomWidth);
  expect(bodyBorders).toEqual(["1px", "1px", "1px"]);
});

it("ends tables without a footer consistently for both row headings and data cells", () => {
  document.head.innerHTML = `<style>${tableCss}</style>`;
  document.body.innerHTML = `<table><tbody><tr><th>Runtime</th><td>1</td></tr></tbody></table>`;
  for (const cell of document.querySelectorAll("th, td")) {
    expect(window.getComputedStyle(cell).borderBottomWidth).toBe("0px");
  }
});

describe("review page controls", () => {
  it("uses the Pages runtime for keyboard-accessible tabs and expandable inline findings", () => {
    const input: PrReviewDocument = {
      schema: "pr-review/v1", title: "Review", target: { kind: "other", label: "fixture" }, intent: "Check the controls", summary: "One finding", verdict: "advisory",
      coverage: { reviewed: ["controls"], validation: ["test"], skipped: [] },
      findings: [{ id: "a", title: "Finding", severity: "nit", category: "other", explanation: "Details", evidence: "Source", path: "app.ts", confidence: "high" }],
    };
    const parsed = new DOMParser().parseFromString(renderPrReview(input), "text/html");
    document.head.innerHTML = parsed.head.innerHTML;
    document.body.innerHTML = parsed.body.innerHTML;
    window.eval(PAGE_RUNTIME);
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Review", "Coverage"]);
    tabs[1]!.click();
    expect(document.querySelector<HTMLElement>('[data-tab="Review"]')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-tab="Coverage"]')!.hidden).toBe(false);
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".review-inline details > summary")!.textContent).toBe("Explanation and evidence");
    });
});
