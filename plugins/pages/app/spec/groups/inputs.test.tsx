// @vitest-environment jsdom
// Field rules, ported from GenUI ui/components/fieldLogic.test.ts and choose-logic.test.ts (Apache-2.0), and what a Form sends.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Renderer, type ActionEvent } from "@openuidev/react-lang";
import { specLibrary } from "../catalog.js";
import { fallbackHost, HostContext } from "../host.js";
import { blankRow, decimals, followUpPrompts, isoDate, itemProblem, optionsOf, parseNumberInput, ratingMax, replaceItem, stepBy, stepRange, stepperValue, swatchColors, tableColumns } from "./inputs.js";

// A host that can send to the thread, like chat. The default host is a page, where sending is read-only.
const chat = { ...fallbackHost, kind: "chat" as const, replies: true };

afterEach(cleanup);

describe("Stepper rules", () => {
  it("counts written decimal places", () => {
    expect([decimals(3), decimals(0.25), decimals(1e-7), decimals(1.5e-7), decimals(1e21)]).toEqual([0, 2, 7, 8, 0]);
  });

  it("defaults the step to 1 and never lets max sit below min", () => {
    expect(stepRange(undefined, undefined, undefined)).toEqual({ min: null, max: null, step: 1 });
    expect(stepRange(0, 10, -2).step).toBe(1);
    expect(stepRange(5, 2, 1)).toEqual({ min: 5, max: 5, step: 1 });
  });

  it("steps without float drift, clamps, and jumps to bounds", () => {
    const range = stepRange(0, 1, 0.1);
    expect(stepBy(stepBy(0.1, 1, range), 1, range)).toBe(0.3);
    expect(stepBy(1.15, 1, stepRange(null, null, 0.05))).toBe(1.2);
    expect(stepBy(1.25, 1, stepRange(null, null, 1))).toBe(2.25);
    expect(stepBy(0.9, 1, range)).toBe(1);
    expect(stepBy(4, Infinity, stepRange(0, 9, 1))).toBe(9);
    expect(stepBy(4, Infinity, stepRange(0, null, 1))).toBe(4);
  });

  it("starts from min, else 0, and clamps a preset", () => {
    expect(stepperValue(undefined, stepRange(2, 8, 1))).toBe(2);
    expect(stepperValue(undefined, stepRange(null, null, 1))).toBe(0);
    expect(stepperValue(12, stepRange(0, 10, 1))).toBe(10);
    expect(stepperValue("7", stepRange(1, 10, 1))).toBe(1);
  });
});

describe("field values", () => {
  it("reads options as strings or objects and skips half-written ones", () => {
    expect(optionsOf(["a", { label: "B", value: "b", detail: "Second" }, { value: "c" }, { detail: "x" }, "a", null])).toEqual([
      { value: "a", label: "a", detail: undefined, icon: undefined },
      { value: "b", label: "B", detail: "Second", icon: undefined },
      { value: "c", label: "c", detail: undefined, icon: undefined },
    ]);
    expect(optionsOf("a")).toEqual([]);
  });

  it("accepts real yyyy-mm-dd dates only", () => {
    expect(isoDate("2024-02-29")).toBe("2024-02-29");
    expect(isoDate("2026-02-29")).toBeNull();
    expect(isoDate("2026-2-1")).toBeNull();
  });

  it("keeps the star count from 1 to 10", () => {
    expect([ratingMax(undefined), ratingMax(0), ratingMax(7.4), ratingMax(40)]).toEqual([5, 1, 7, 10]);
  });

  it("refuses empty and repeated list items", () => {
    expect(itemProblem(["a"], "   ")).toBe("empty");
    expect(itemProblem(["a"], " a ")).toBe("duplicate");
    expect(replaceItem(["a", "b"], 0, " c ")).toEqual(["c", "b"]);
    expect(replaceItem(["a", "b"], 0, "b")).toBeNull();
    expect(replaceItem(["a", "b"], 0, " a ")).toBeNull();
    expect(replaceItem(["a", "b"], 5, "c")).toBeNull();
  });

  it("splits colours it can read from ones it cannot", () => {
    expect(swatchColors(["#fff", { value: "red", name: "Red" }, "not a colour!", "#FFF", { name: "half" }])).toEqual({ colors: [{ value: "#fff", name: undefined }, { value: "red", name: "Red" }], invalid: ["not a colour!"] });
  });

  it("types table columns from their first filled cell", () => {
    const columns = tableColumns(["item", { key: "qty", label: "Qty" }, { key: "gift", type: "boolean" }, "item", { label: "no key" }], [{ item: "", qty: 2 }]);
    expect(columns).toEqual([{ key: "item", label: "Item", type: "text" }, { key: "qty", label: "Qty", type: "number" }, { key: "gift", label: "Gift", type: "boolean" }]);
    expect(blankRow(columns)).toEqual({ item: "", qty: null, gift: false });
  });

  it("reads plain, grouped, and decimal-comma numbers", () => {
    expect(["12", "-3.5", "1,234.5", "1,234", "3,5", "0,250", " 1 000 ", ".5"].map(parseNumberInput)).toEqual([12, -3.5, 1234.5, 1234, 3.5, 0.25, 1000, 0.5]);
    expect(parseNumberInput("  ")).toBeNull();
    expect(["-", "1.", "12abc", "1e400"].map(parseNumberInput)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("keeps follow-up prompts once each", () => {
    expect(followUpPrompts([" Why? ", "", { text: "x" }, 3, "Why?"])).toEqual(["Why?", "3"]);
  });
});

describe("Form", () => {
  it("sends preset, shown, and bound values, not only edited ones", async () => {
    const events: ActionEvent[] = [];
    const code = [
      `$note = "ship it"`,
      `root = Form("f", [Input("note", "Note", null, $note), Stepper("seats", "Seats", 2, 9), Checklist("steps", ["Plan", "Build"], "Steps", ["Plan"]), Toggle("notify", "Notify"), EditableTable("rows", ["item"], "Rows", [{item: "Tea"}])], [Button("Go")])`,
    ].join("\n");
    render(<HostContext.Provider value={chat}><Renderer response={code} library={specLibrary} isStreaming={false} onAction={(event) => events.push(event)} /></HostContext.Provider>);
    fireEvent.click(await screen.findByRole("button", { name: "Increase" }));
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(events).toHaveLength(1));
    const values = Object.fromEntries(Object.entries(events[0]!.formState?.f as Record<string, { value: unknown }>).map(([name, entry]) => [name, entry.value]));
    expect(values).toEqual({ note: "ship it", seats: 3, steps: ["Plan"], rows: '[{"item":"Tea"}]' });
  });

  it("sends a follow-up prompt alone", async () => {
    const events: ActionEvent[] = [];
    render(<HostContext.Provider value={chat}><Renderer response={`root = FollowUps(["Why?", "How?"])`} library={specLibrary} isStreaming={false} onAction={(event) => events.push(event)} /></HostContext.Provider>);
    fireEvent.click(await screen.findByRole("button", { name: "How?" }));
    await waitFor(() => expect(events.map((event) => [event.humanFriendlyMessage, event.formName])).toEqual([["How?", undefined]]));
  });
});
