// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FORM_RUNTIME, needsFormRuntime } from "./form-runtime.js";
import { injectPage } from "./inject.js";

// The runtime listens on the document, so it runs once; each test sets new fields.
beforeAll(() => { Function(FORM_RUNTIME)(); });
beforeEach(() => { document.querySelectorAll(".bb-picker").forEach((el) => el.remove()); document.body.innerHTML = ""; });

const picker = () => document.querySelector<HTMLElement>(".bb-picker");
const press = (target: Element, key: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
const mousedown = (target: Element) => target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup<T extends Element>(html: string, selector: string): T {
  document.body.innerHTML = html;
  return document.querySelector<T>(selector)!;
}

describe("form runtime detection", () => {
  it("runs for select, date, time, and number fields only", () => {
    expect(needsFormRuntime("<select name=a><option>x</option></select>")).toBe(true);
    expect(needsFormRuntime('<input type="date">')).toBe(true);
    expect(needsFormRuntime("<input type=time>")).toBe(true);
    expect(needsFormRuntime("<input type='number'>")).toBe(true);
    expect(needsFormRuntime('<input type="datetime-local"><input type="text"><p>select a date</p>')).toBe(false);
  });

  it("is injected into a page with such a field, and only then", () => {
    expect(injectPage('<form><input type="date" name="d"></form>', { assetBase: "./", theme: null, hasCharts: false })).toContain("data-bb-pickers");
    expect(injectPage('<form><input name="d"></form>', { assetBase: "./", theme: null, hasCharts: false })).not.toContain("data-bb-pickers");
  });

  it("marks the root so the theme hides the browser icons and spin buttons", () => {
    expect(document.documentElement.hasAttribute("data-bb-pickers")).toBe(true);
  });
});

describe("select picker", () => {
  const html = `<label for="r">Region</label><select id="r" name="r">
    <option value="" hidden>Choose</option>
    <optgroup label="Americas"><option>US</option><option disabled>Brazil</option></optgroup>
    <option selected>EU</option><option>APAC</option></select>`;

  it("stops the browser list and opens a themed list box with groups, the chosen option, and disabled options", () => {
    const select = setup<HTMLSelectElement>(html, "select");
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    select.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const list = picker()!;
    expect(list.getAttribute("role")).toBe("listbox");
    expect(list.getAttribute("aria-label")).toBe("Region");
    expect(select.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(list);
    expect(Array.from(list.querySelectorAll(".bb-picker-group")).map((el) => el.textContent)).toEqual(["Americas"]);
    const options = Array.from(list.querySelectorAll('[role="option"]'));
    expect(options.map((el) => el.textContent)).toEqual(["US", "Brazil", "EU", "APAC"]);
    expect(options[1].getAttribute("aria-disabled")).toBe("true");
    expect(options[2].getAttribute("aria-selected")).toBe("true");
    expect(list.getAttribute("aria-activedescendant")).toBe(options[2].id);
  });

  it("picks with the keyboard, skips disabled options, and fires input and change", () => {
    const select = setup<HTMLSelectElement>(html, "select");
    const change = vi.fn();
    const input = vi.fn();
    select.addEventListener("change", change);
    select.addEventListener("input", input);
    press(select, "Enter");
    const list = picker()!;
    press(list, "ArrowUp");
    expect(list.querySelector(".is-active")!.textContent).toBe("US");
    press(list, "Enter");
    expect(picker()).toBeNull();
    expect(select.value).toBe("US");
    expect(change).toHaveBeenCalledTimes(1);
    expect(input).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(select);
    expect(select.getAttribute("aria-expanded")).toBe("false");
  });

  it("picks with a click, finds options by typing, and closes on Escape without a change", () => {
    const select = setup<HTMLSelectElement>(html, "select");
    const change = vi.fn();
    select.addEventListener("change", change);
    press(select, "ArrowDown");
    press(picker()!, "a");
    expect(picker()!.querySelector(".is-active")!.textContent).toBe("APAC");
    press(picker()!, "Escape");
    expect(picker()).toBeNull();
    expect(change).not.toHaveBeenCalled();
    mousedown(select);
    (picker()!.querySelectorAll('[role="option"]')[3] as HTMLElement).click();
    expect(select.value).toBe("APAC");
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("closes on a press outside, and a second press on the field closes it", () => {
    const select = setup<HTMLSelectElement>(`${html}<p>Elsewhere</p>`, "select");
    mousedown(select);
    mousedown(document.querySelector("p")!);
    expect(picker()).toBeNull();
    mousedown(select);
    mousedown(select);
    expect(picker()).toBeNull();
  });

  it("leaves disabled, multiple, and data-bb-pages-native selects to the browser", () => {
    for (const markup of [
      "<select disabled><option>a</option></select>",
      "<select multiple><option>a</option></select>",
      "<div data-bb-pages-native><select><option>a</option></select></div>",
    ]) {
      const select = setup<HTMLSelectElement>(markup, "select");
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
      select.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(picker()).toBeNull();
    }
  });
});

describe("date picker", () => {
  it("opens a month calendar on click, keeps the focus in the field, and picks a day", () => {
    const input = setup<HTMLInputElement>('<input type="date" name="d" value="2026-10-21" min="2026-10-05" max="2026-11-10">', "input");
    const change = vi.fn();
    input.addEventListener("change", change);
    input.focus();
    input.click();
    const calendar = picker()!;
    expect(calendar.classList.contains("bb-picker-calendar")).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(calendar.querySelector(".bb-picker-title")!.textContent).toMatch(/2026/);
    const days = Array.from(calendar.querySelectorAll<HTMLButtonElement>(".bb-picker-day"));
    expect(days).toHaveLength(42);
    expect(calendar.querySelector('[aria-pressed="true"]')!.getAttribute("data-date")).toBe("2026-10-21");
    expect(calendar.querySelector<HTMLButtonElement>('[data-date="2026-10-04"]')!.disabled).toBe(true);
    expect(calendar.querySelector<HTMLButtonElement>('[data-date="2026-10-05"]')!.disabled).toBe(false);
    calendar.querySelector<HTMLButtonElement>('[data-date="2026-10-28"]')!.click();
    expect(input.value).toBe("2026-10-28");
    expect(change).toHaveBeenCalledTimes(1);
    expect(picker()).toBeNull();
  });

  it("moves by month inside min and max, and steps days with the keyboard", () => {
    const input = setup<HTMLInputElement>('<input type="date" value="2026-10-21" min="2026-10-05" max="2026-11-10">', "input");
    press(input, "ArrowDown", { altKey: true });
    const calendar = picker()!;
    const [prev, next] = Array.from(calendar.querySelectorAll<HTMLButtonElement>(".bb-picker-nav"));
    expect(prev.disabled).toBe(true);
    expect(document.activeElement!.getAttribute("data-date")).toBe("2026-10-21");
    press(document.activeElement!, "ArrowDown");
    expect(document.activeElement!.getAttribute("data-date")).toBe("2026-10-28");
    press(document.activeElement!, "PageDown");
    expect(document.activeElement!.getAttribute("data-date")).toBe("2026-11-10");
    expect(next.disabled).toBe(true);
    press(document.activeElement!, "Enter");
    (document.activeElement as HTMLButtonElement).click();
    expect(input.value).toBe("2026-11-10");
  });

  it("follows a typed date, and clears", () => {
    const input = setup<HTMLInputElement>('<input type="date" value="2026-10-21">', "input");
    input.click();
    input.value = "2027-03-02";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(picker()!.querySelector('[aria-pressed="true"]')!.getAttribute("data-date")).toBe("2027-03-02");
    Array.from(picker()!.querySelectorAll<HTMLButtonElement>(".bb-picker-text")).find((button) => button.textContent === "Clear")!.click();
    expect(input.value).toBe("");
  });

  it("does not open for a disabled, read-only, or native field", () => {
    for (const markup of ['<input type="date" disabled>', '<input type="date" readonly>', '<input type="date" data-bb-pages-native>']) {
      setup<HTMLInputElement>(markup, "input").click();
      expect(picker()).toBeNull();
    }
  });
});

describe("time picker", () => {
  it("lists times at the step, inside min and max, and picks one", () => {
    const input = setup<HTMLInputElement>('<input type="time" value="09:30" min="09:00" max="11:00" step="1800">', "input");
    const change = vi.fn();
    input.addEventListener("change", change);
    input.click();
    const list = picker()!;
    const options = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'));
    expect(options).toHaveLength(5);
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    options[4].click();
    expect(input.value).toBe("11:00");
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("uses 15 minutes when the step is short, and a range across midnight", () => {
    const input = setup<HTMLInputElement>('<input type="time" min="22:00" max="01:00" step="60">', "input");
    input.click();
    expect(picker()!.querySelectorAll('[role="option"]')).toHaveLength(13);
  });
});

describe("number steppers", () => {
  it("wraps a number field with - and + buttons that step it and fire input and change", async () => {
    const input = setup<HTMLInputElement>('<form><input type="number" name="n" value="2" min="1" max="3"></form>', "input");
    await tick();
    const wrap = input.parentElement!;
    expect(wrap.classList.contains("bb-number")).toBe(true);
    const [minus, plus] = Array.from(wrap.querySelectorAll<HTMLButtonElement>(".bb-number-step"));
    expect(minus.type).toBe("button");
    expect(minus.tabIndex).toBe(-1);
    const change = vi.fn();
    input.addEventListener("change", change);
    plus.click();
    expect(input.value).toBe("3");
    plus.click();
    expect(input.value).toBe("3");
    expect(change).toHaveBeenCalledTimes(1);
    minus.click();
    minus.click();
    expect(input.value).toBe("1");
    input.disabled = true;
    plus.click();
    expect(input.value).toBe("1");
  });

  it("leaves native number fields alone", async () => {
    const input = setup<HTMLInputElement>('<input type="number" data-bb-pages-native>', "input");
    await tick();
    expect(input.parentElement!.classList.contains("bb-number")).toBe(false);
  });
});
