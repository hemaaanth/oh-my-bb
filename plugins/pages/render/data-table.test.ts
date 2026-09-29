// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DATA_TABLE_RUNTIME, needsDataTableRuntime } from "./page-runtime.js";

function render(data: unknown, url = "/"): Document {
  history.replaceState(null, "", url);
  document.body.innerHTML = `<div class="data-table" id="people" aria-label="People"><script type="application/json">${JSON.stringify(data).replaceAll("<", "\\u003c")}</script></div>`;
  Function(DATA_TABLE_RUNTIME)();
  return document;
}

describe("data table runtime", () => {
  it("detects only the opt-in component", () => {
    expect(needsDataTableRuntime('<div class="data-table"></div>')).toBe(true);
    expect(needsDataTableRuntime('<table data-table="none"></table>')).toBe(false);
  });

  it("virtualizes 10,000 typed rows and sorts every column", () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      name: `Person ${10_000 - index}`,
      email: `person${index}@example.com`,
      status: { label: index ? "Doing" : "Done", tone: index ? "warning" : "success", href: index ? undefined : "https://linkedin.com/in/person" },
      revenue: index,
      rate: index / 10_000,
    }));
    const document = render({
      columns: [
        { key: "name", label: "Name", type: "text" },
        { key: "email", label: "Email", type: "email" },
        { key: "status", label: "Status", type: "pill" },
        { key: "revenue", label: "Revenue", type: "currency", currency: "USD" },
        { key: "rate", label: "Rate", type: "percent" },
      ],
      rows,
    });
    expect(document.querySelector(".data-table-status")?.textContent).toBe("10,000 rows");
    expect(document.querySelector('[role="table"]')?.getAttribute("aria-label")).toBe("People");
    expect(document.querySelectorAll(".data-table-row").length).toBeLessThan(40);
    expect(document.querySelector('.data-table-cell a[href^="mailto:"]')).not.toBeNull();
    expect(document.querySelector("a.data-table-pill")?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(document.querySelector(".data-table-cell.num")?.textContent).toMatch(/\$0\.00/u);
    const revenue = Array.from(document.querySelectorAll<HTMLButtonElement>(".data-table-heading button")).find((button) => button.textContent === "Revenue")!;
    revenue.click();
    revenue.click();
    expect(document.querySelector('.data-table-heading[aria-sort="descending"] button')?.textContent).toBe("Revenue");
    expect(document.querySelector(".data-table-row .data-table-cell")?.textContent).toBe("Person 1");
    expect(document.querySelector(".data-table-status")?.textContent).toBe("10,000 rows");
    expect(document.querySelector(".data-table")?.lastElementChild?.classList.contains("data-table-footer")).toBe(true);

    const statusRow = document.querySelector<HTMLElement>('.data-table-filter-row[data-column="status"]')!;
    const statusTrigger = statusRow.querySelector<HTMLButtonElement>(".data-table-select-trigger")!;
    statusTrigger.click();
    const statusMenu = document.querySelector<HTMLElement>(`#${statusTrigger.getAttribute("aria-controls")}`)!;
    expect(statusMenu.parentElement).toBe(document.body);
    statusMenu.querySelector<HTMLButtonElement>('.data-table-select-option[data-value="Doing"]')!.click();
    expect(document.querySelector(".data-table-status")?.textContent).toBe("9,999 of 10,000 rows");
    expect(document.querySelectorAll(".data-table-heading.filtered")).toHaveLength(1);
    expect(location.search).toContain("dt.people.status=eq%3ADoing");
    expect(location.hash).toBe("#people");
    expect(document.querySelector<HTMLInputElement>('.data-table-filter-row[data-column="revenue"] input')?.type).toBe("text");
    expect(document.querySelector<HTMLInputElement>('.data-table-filter-row[data-column="revenue"] input')?.inputMode).toBe("decimal");
    expect(document.querySelector('.data-table-filter-row[data-column="revenue"] .data-table-select-trigger')?.textContent).toBe("Above");

    const clear = document.querySelector<HTMLButtonElement>(".data-table-filter-panel-head button")!;
    const setValueFilter = (column: string, modeValue: string, value: string) => {
      clear.click();
      const row = document.querySelector<HTMLElement>(`.data-table-filter-row[data-column="${column}"]`)!;
      const mode = row.querySelector<HTMLButtonElement>(".data-table-select-trigger")!;
      const input = row.querySelector("input")!;
      mode.click();
      document.querySelector<HTMLButtonElement>(`#${mode.getAttribute("aria-controls")} .data-table-select-option[data-value="${modeValue}"]`)!.click();
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    setValueFilter("name", "contains", "Person 1");
    expect(document.querySelector(".data-table-status")?.textContent).toMatch(/^1,112 of 10,000 rows$/u);
    setValueFilter("name", "eq", "Person 1");
    expect(document.querySelector(".data-table-status")?.textContent).toBe("1 of 10,000 rows");
    setValueFilter("name", "regex", "^Person [12]$");
    expect(document.querySelector(".data-table-status")?.textContent).toBe("2 of 10,000 rows");
    setValueFilter("email", "eq", "person0@example.com");
    expect(document.querySelector(".data-table-status")?.textContent).toBe("1 of 10,000 rows");
    setValueFilter("revenue", "gt", "9998");
    expect(document.querySelector(".data-table-status")?.textContent).toBe("1 of 10,000 rows");
    setValueFilter("rate", "lt", "0.01");
    expect(document.querySelector(".data-table-status")?.textContent).toBe("1 of 10,000 rows");
  });

  it("restores URL filters and marks a table that fills its tab", () => {
    const data = { columns: [{ key: "name", label: "Name", type: "text" }], rows: [{ name: "Alpha" }, { name: "Beta" }] };
    history.replaceState(null, "", "/?dt.people.name=eq%3ABeta#people");
    document.body.innerHTML = `<div class="tabs"><section data-tab="Data"><div class="data-table" id="people" aria-label="People"><script type="application/json">${JSON.stringify(data)}</script></div></section></div>`;
    Function(DATA_TABLE_RUNTIME)();
    expect(document.querySelector(".data-table")?.classList.contains("data-table-fill")).toBe(true);
    expect(document.querySelector(".data-table-status")?.textContent).toBe("1 of 2 rows");
    expect(document.querySelector(".data-table-row .data-table-cell")?.textContent).toBe("Beta");
  });

  it("shows a bounded error instead of throwing on malformed input", () => {
    const document = render({ columns: [], rows: [] });
    expect(document.querySelector(".data-table-error")?.textContent).toContain("expected columns and rows arrays");
  });
});
