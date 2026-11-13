// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fitColumns, fitTable, toggleCell } from "./table-fit.js";
import { TABLE_RUNTIME, needsTableRuntime } from "./page-runtime.js";

const sum = (widths: number[]) => widths.reduce((a, b) => a + b, 0);

describe("fitColumns", () => {
  it("returns null when every column fits", () => {
    expect(fitColumns([100, 200], [50, 50], 300, 160)).toBeNull();
  });

  it("keeps short columns whole and shares the rest between long ones", () => {
    const widths = fitColumns([60, 500, 900], [40, 40, 40], 700, 160)!;
    expect(widths[0]).toBe(60);
    expect(Math.abs(widths[1]! - widths[2]!)).toBeLessThanOrEqual(1);
    expect(sum(widths)).toBeLessThanOrEqual(700);
    expect(sum(widths)).toBeGreaterThan(695);
  });

  it("rounds whole columns up so short cells never clip, and still fits the box", () => {
    const widths = fitColumns([58.4, 900.2], [30, 30], 400, 160)!;
    expect(widths[0]).toBe(59);
    expect(sum(widths)).toBeLessThanOrEqual(400);
  });

  it("never goes below the heading or the floor, so a narrow box scrolls", () => {
    const widths = fitColumns([400, 400, 400], [200, 50, 50], 300, 160)!;
    expect(widths).toEqual([200, 160, 160]);
  });

  it("does not widen a column past its natural width to reach the floor", () => {
    const widths = fitColumns([40, 900], [30, 30], 300, 160)!;
    expect(widths[0]).toBe(40);
    expect(widths[1]).toBeLessThanOrEqual(260);
  });
});

function measuredTable(natural: number[], available: number) {
  document.body.innerHTML = `<div id="box"><table><thead><tr>${natural.map((_, i) => `<th>H${i}</th>`).join("")}</tr></thead><tbody><tr>${natural.map((_, i) => `<td>cell ${i}</td>`).join("")}</tr></tbody></table></div>`;
  const box = document.getElementById("box")!;
  Object.defineProperty(box, "clientWidth", { configurable: true, value: available });
  const table = box.querySelector("table")!;
  table.querySelectorAll("th").forEach((cell, i) => {
    cell.getBoundingClientRect = () => ({ width: natural[i] }) as DOMRect;
  });
  table.querySelectorAll("td").forEach((cell) => {
    Object.defineProperty(cell, "scrollWidth", { configurable: true, get: () => 500 });
    Object.defineProperty(cell, "clientWidth", { configurable: true, get: () => parseFloat(table.rows[0]!.cells[cell.cellIndex]!.style.width) || 500 });
  });
  return table;
}

describe("fitTable", () => {
  it("fixes column widths and marks clipped cells", () => {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => ({ width: 20 }) });
    const table = measuredTable([60, 500, 900], 700);
    fitTable(table, fitColumns);
    expect(table.dataset.fit).toBe("fixed");
    expect(table.style.tableLayout).toBe("fixed");
    expect(table.rows[0]!.cells[0]!.style.width).toBe("60px");
    const body = Array.from(table.tBodies[0]!.rows[0]!.cells);
    expect(body.map((cell) => cell.hasAttribute("data-clipped"))).toEqual([true, true, true]);
    expect(body[1]!.tabIndex).toBe(0);
  });

  it("leaves tables with merged cells alone", () => {
    document.body.innerHTML = '<div id="box"><table><tr><td colspan="2">a</td></tr><tr><td>b</td><td>c</td></tr></table></div>';
    const box = document.getElementById("box")!;
    Object.defineProperty(box, "clientWidth", { configurable: true, value: 300 });
    const table = box.querySelector("table")!;
    fitTable(table, fitColumns);
    expect(table.hasAttribute("data-fit")).toBe(false);
  });
});

describe("toggleCell", () => {
  const panel = () => document.querySelector("[data-cell-panel]");

  it("opens a clipped cell in a floating panel without changing the table", () => {
    document.body.innerHTML = '<div><table><tr><td data-clipped tabindex="0">long <b>value</b> <a href="#x">link</a></td><td data-clipped>other</td></tr></table></div>';
    const table = document.querySelector("table")!;
    table.addEventListener("click", toggleCell);
    table.addEventListener("keydown", toggleCell);
    const cell = document.querySelectorAll("td")[0];
    const before = table.outerHTML;
    cell!.click();
    expect(panel()?.innerHTML).toBe('long <b>value</b> <a href="#x">link</a>');
    expect((panel() as HTMLElement).style.position).toBe("fixed");
    expect(cell!.hasAttribute("data-open")).toBe(true);
    expect(table.outerHTML.replace(" data-open=\"\"", "")).toBe(before);

    // A tap on the same cell closes it on pointerdown and does not reopen on click.
    cell!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    cell!.click();
    expect(panel()).toBeNull();
    expect(cell!.hasAttribute("data-open")).toBe(false);
  });

  it("closes on Escape and moves to another cell on tap", () => {
    document.body.innerHTML = '<div><table><tr><td data-clipped tabindex="0">a</td><td data-clipped tabindex="0">b</td></tr></table></div>';
    const table = document.querySelector("table")!;
    table.addEventListener("click", toggleCell);
    table.addEventListener("keydown", toggleCell);
    const [cell, other] = Array.from(document.querySelectorAll("td"));
    cell!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(panel()?.textContent).toBe("a");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel()).toBeNull();
    cell!.click();
    other!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    other!.click();
    expect(panel()?.textContent).toBe("b");
    expect(document.querySelectorAll("[data-cell-panel]")).toHaveLength(1);
  });

  it("keeps the panel inside the window when the cell is cut off", () => {
    document.body.innerHTML = '<div><table><tr><td data-clipped>a long value</td><td data-clipped>b</td></tr></table></div>';
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 390 });
    const [left, right] = Array.from(document.querySelectorAll("td"));
    left!.getBoundingClientRect = () => ({ left: -120, top: 100, width: 200, right: 80, bottom: 130, height: 30 }) as DOMRect;
    right!.getBoundingClientRect = () => ({ left: 340, top: 100, width: 200, right: 540, bottom: 130, height: 30 }) as DOMRect;
    const table = document.querySelector("table")!;
    table.addEventListener("click", toggleCell);
    for (const cell of [left!, right!]) {
      cell.click();
      const style = (panel() as HTMLElement).style;
      expect(parseFloat(style.left)).toBeGreaterThanOrEqual(8);
      expect(parseFloat(style.left) + parseFloat(style.minWidth)).toBeLessThanOrEqual(382);
      expect(parseFloat(style.maxWidth)).toBeLessThanOrEqual(374);
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    }
  });

  it("ignores taps on links inside the cell", () => {
    document.body.innerHTML = '<div><table><tr><td data-clipped>long <a href="#x">link</a></td></tr></table></div>';
    document.querySelector("table")!.addEventListener("click", toggleCell);
    document.querySelector("a")!.click();
    expect(panel()).toBeNull();
  });
});

describe("TABLE_RUNTIME", () => {
  it("is only needed for pages with tables", () => {
    expect(needsTableRuntime("<TABLE class=x>")).toBe(true);
    expect(needsTableRuntime("<p>tablet</p>")).toBe(false);
  });

  it("stands alone and wraps a bare table in a scroll box", () => {
    expect(TABLE_RUNTIME).not.toContain("__name");
    document.body.innerHTML = '<main><table><tr><td>a</td></tr></table><table class="wrap"><tr><td>b</td></tr></table></main>';
    Function(TABLE_RUNTIME)();
    const [first, second] = Array.from(document.querySelectorAll("table"));
    expect(first!.parentElement!.className).toBe("scroll");
    expect(second!.parentElement!.tagName).toBe("MAIN");
  });
});
