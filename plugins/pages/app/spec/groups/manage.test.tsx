// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Renderer, type ActionEvent } from "@openuidev/react-lang";
import { specLibrary } from "../catalog.js";
import { fallbackHost, HostContext } from "../host.js";
import { SentContext } from "../kit.js";
// A host that can send to the thread, like chat. The default host is a page, where sending is read-only.
const chat = { ...fallbackHost, kind: "chat" as const, replies: true };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// jsdom has no PointerEvent; a MouseEvent with the pointer fields is enough for the Board's drag.
window.PointerEvent ??= class extends MouseEvent {
  pointerId: number; pointerType: string; isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? "mouse"; this.isPrimary = init.isPrimary ?? true; }
} as typeof PointerEvent;

function Fence({ code, streaming = false, log }: { code: string; streaming?: boolean; log: ActionEvent[] }) {
  const [sent, setSent] = useState<Record<string, string>>({});
  const onAction = (event: ActionEvent) => { log.push(event); setSent((now) => ({ ...now, [event.formName ?? ""]: event.humanFriendlyMessage })); };
  const unlock = (form: string) => setSent(({ [form]: _, ...rest }) => rest);
  return <HostContext.Provider value={chat}><SentContext.Provider value={{ sent, unlock }}><Renderer response={code} library={specLibrary} isStreaming={streaming} onAction={onAction} /></SentContext.Provider></HostContext.Provider>;
}

describe("Decision", () => {
  const code = `root = Decision("Launch date?", [{name: "Nov 4"}, {name: "Nov 18"}], "Nov 18", "launch")`;

  it("sends the pick under its name, then locks until changed", async () => {
    const log: ActionEvent[] = [];
    render(<Fence code={code} log={log} />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose Nov 4" }));
    expect(log.map((event) => [event.humanFriendlyMessage, event.formName])).toEqual([["Launch date?: Nov 4", "launch"]]);
    expect(screen.getByRole("button", { name: "Chosen" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Choose Nov 18" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByRole("button", { name: "Choose Nov 4" })).toHaveProperty("disabled", false);
  });

  it("is read-only without a name and locked while streaming", async () => {
    render(<Fence code={`root = Decision("Q?", [{name: "A"}])`} log={[]} />);
    expect(await screen.findByText("A")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    render(<Fence code={code} streaming log={[]} />);
    expect((await screen.findByRole("button", { name: "Choose Nov 4" })).hasAttribute("disabled")).toBe(true);
  });
});

describe("Board", () => {
  const code = `root = Board([{title: "A", status: "todo"}, {title: "B", status: "todo"}, {title: "C", status: "done"}], null, "triage")`;
  const column = (label: string) => screen.getByRole("region", { name: label });
  const titles = (label: string) => within(column(label)).queryAllByRole("article").map((card) => card.getAttribute("aria-label"));
  // Columns sit side by side, 224px wide with a 16px gap. jsdom lays nothing out, so every card's middle is at 0.
  const layout = () => vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const at = ["Todo", "Done"].indexOf(this.getAttribute("aria-label") ?? "");
    return at < 0 ? new DOMRect(0, 0, 0, 0) : new DOMRect(at * 240, 0, 224, 400);
  });
  const drag = (title: string, to: { x: number; y: number }) => {
    fireEvent.pointerDown(screen.getByRole("article", { name: title }), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: to.x, clientY: to.y });
    fireEvent.pointerUp(window, { clientX: to.x, clientY: to.y });
  };
  // The Move menu lists only the other columns, then moves the card to the one picked.
  const move = async (title: string, to: string) => {
    fireEvent.keyDown(await screen.findByRole("button", { name: `Move ${title}` }), { key: "Enter" });
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual([to]);
    fireEvent.click(screen.getByRole("menuitem", { name: to }));
  };

  it("moves a card by pointer drag and by its Move menu, then sends the moves under its name", async () => {
    const log: ActionEvent[] = [];
    render(<Fence code={code} log={log} />);
    layout();
    const send = await screen.findByRole("button", { name: "Send moves" });
    expect(send).toHaveProperty("disabled", true);
    fireEvent.pointerDown(screen.getByRole("article", { name: "A" }), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 50 });
    expect(titles("Todo")).toEqual(["B"]);
    // The slot follows the pointer on the next frame.
    await waitFor(() => expect(column("Done").querySelector('[data-flip="slot"]')).toBeTruthy());
    expect(column("Todo").querySelector('[data-flip="slot"]')).toBeNull();
    expect(document.body.querySelector('[data-bb-plugin="pages"][aria-hidden="true"]')).toBeTruthy();
    fireEvent.pointerUp(window, { clientX: 300, clientY: 50 });
    expect(titles("Done")).toEqual(["C", "A"]);
    // The click that ends a drag is swallowed; a later one goes through.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('[data-flip="slot"]')).toBeNull();
    await move("C", "Todo");
    expect(titles("Todo")).toEqual(["B", "C"]);
    fireEvent.click(screen.getByRole("button", { name: "Send moves (2)" }));
    expect(log.map((event) => [event.humanFriendlyMessage, event.formName])).toEqual([["Moves on the board:\n- A: Todo → Done\n- C: Done → Todo", "triage"]]);
  });

  it("puts a card back on Escape or off the board, and a short press is no drag", async () => {
    render(<Fence code={code} log={[]} />);
    layout();
    await screen.findByRole("button", { name: "Send moves" });
    fireEvent.pointerDown(screen.getByRole("article", { name: "A" }), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 50 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(titles("Todo")).toEqual(["A", "B"]);
    drag("A", { x: 900, y: 50 });
    drag("B", { x: 12, y: 12 });
    expect(titles("Todo")).toEqual(["A", "B"]);
    expect(screen.getByRole("button", { name: "Send moves" })).toHaveProperty("disabled", true);
  });

  it("locks once sent, unlocks with Change, and a move back undoes a move", async () => {
    render(<Fence code={code} log={[]} />);
    layout();
    await move("B", "Done");
    fireEvent.click(screen.getByRole("button", { name: "Send moves (1)" }));
    expect(screen.getByRole("button", { name: "Send moves (1)" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Move B" })).toBeNull();
    drag("A", { x: 300, y: 50 });
    expect(titles("Todo")).toEqual(["A"]);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    await move("B", "Todo");
    expect(screen.getByRole("button", { name: "Send moves" })).toHaveProperty("disabled", true);
  });

  it("is read-only without a name, selects no text, and is locked while streaming", async () => {
    render(<Fence code={`root = Board([{title: "A", status: "todo"}, {title: "C", status: "done"}])`} log={[]} />);
    layout();
    const card = await screen.findByRole("article", { name: "A" });
    expect(card.closest(".select-none")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    drag("A", { x: 300, y: 50 });
    expect(titles("Todo")).toEqual(["A"]);
    cleanup();
    render(<Fence code={code} streaming log={[]} />);
    await screen.findByRole("button", { name: "Send moves" });
    expect(screen.queryByRole("button", { name: "Move A" })).toBeNull();
  });
});

describe("partial props", () => {
  it("renders half-written programs without crashing", async () => {
    for (const code of [`root = Board([{title: "A", status: "todo"}, {status: "do`, `root = Roadmap([{title: "A", start: "2026-10-01", end: "2026-10-09"}, {title: "B", start: "2026-1`, `root = Estimate([{task: "A", low: 1`, `root = Plan([{step: "A"}, {ste`, `root = Status("at-risk", "Sl`]) {
      const view = render(<Fence code={code} streaming log={[]} />);
      await waitFor(() => expect(view.container.textContent).toMatch(/A/));
      cleanup();
    }
  });
});
