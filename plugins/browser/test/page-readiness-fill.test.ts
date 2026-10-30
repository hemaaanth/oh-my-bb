// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Extension runtime is plain JavaScript.
import { fillPage, guardPage, pageOperation, settlePage } from "../browser-extension/page-operations.js";

beforeEach(() => {
  document.body.innerHTML = "";
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 10, y: 10, width: 100, height: 30 } as DOMRect);
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => document.body.firstElementChild });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("relay form filling", () => {
  it("uses the native setter and emits input/change for controlled inputs, including clearing", () => {
    document.body.innerHTML = '<input value="old">';
    const node = document.querySelector("input")!;
    let tracked = "old";
    Object.defineProperty(node, "value", { configurable: true, get: () => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.get!.call(node), set: value => { tracked = value; } });
    const events: string[] = [];
    node.addEventListener("input", () => events.push("input:" + node.value));
    node.addEventListener("change", () => events.push("change:" + node.value));
    fillPage("input", "new");
    fillPage("input", "");
    expect(events).toEqual(["input:new", "change:new", "input:", "change:"]);
    expect(tracked).toBe("old");
  });

  it.each(['<textarea>old</textarea>', '<div contenteditable="true">old</div>', '<input type="date" value="2026-01-01">'])("replaces the value of %s", html => {
    document.body.innerHTML = html;
    const node = document.body.firstElementChild!;
    if (node.tagName === "DIV") Object.defineProperty(node, "isContentEditable", { value: true });
    fillPage(node.tagName.toLowerCase(), node.tagName === "INPUT" ? "2026-10-30" : "new");
    expect(node.tagName === "DIV" ? node.textContent : (node as HTMLInputElement).value).toBe(node.tagName === "INPUT" ? "2026-10-30" : "new");
  });

  it.each(['<input readonly value="keep">', '<input disabled value="keep">', '<input type="checkbox">', '<input type="file">', '<select><option>keep</option></select>', '<input aria-disabled="true" value="keep">'])("rejects unsupported controls before input: %s", html => {
    document.body.innerHTML = html;
    const input = vi.fn(); document.body.addEventListener("input", input, { once: true });
    expect(() => fillPage(document.body.firstElementChild!.tagName.toLowerCase(), "new")).toThrow();
    expect(input).not.toHaveBeenCalled();
  });

  it.each(['<input readonly>', '<input type="file">'])("guarded fill rejects %s before consuming the observation", html => {
    document.body.innerHTML = html;
    const observation = {
      revision: "fixture", document, consumed: false,
      nodes: [document.body.firstElementChild], visible: () => true,
      describe: () => ({}), readContext: () => "", rows: [{ id: "e0" }],
      semantic: JSON.stringify({ url: location.href, context: "", rows: [{ id: "e0" }] }),
    };
    // @ts-expect-error Runtime observation is owned by the extension's page script.
    globalThis.__bbObservation = observation;
    try {
      expect(() => guardPage({ revision: "fixture", target: "e0", operation: "fill", value: "new" })).toThrow("cannot be filled");
      expect(observation.consumed).toBe(false);
    } finally {
      // @ts-expect-error Remove the page-script observation fixture.
      delete globalThis.__bbObservation;
    }
  });

  it("rejects invalid dates before clearing the existing value", () => {
    document.body.innerHTML = '<input type="date" value="2026-01-01">';
    expect(() => fillPage("input", "bad date")).toThrow("rejected");
    expect(document.querySelector("input")!.value).toBe("2026-01-01");
  });
});

describe("bounded page settling", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(document, "readyState", "get").mockReturnValue("complete"); });
  it("waits for a full quiet window and resets it after DOM changes", async () => {
    const result = settlePage(1000);
    await vi.advanceTimersByTimeAsync(150);
    document.body.textContent = "loaded";
    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toMatchObject({ ready: true, readyState: "complete", ms: 350 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("returns a timeout result for an unfinished document and disconnects its observer", async () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const result = settlePage(125);
    await vi.advanceTimersByTimeAsync(125);
    await expect(result).resolves.toMatchObject({ ready: false, readyState: "loading", ms: 125 });
    expect(disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("validates deadlines before evaluating page code", async () => {
    const call = vi.fn(async () => ({}));
    for (const args of [["-1"], ["10001"], ["oops"], ["1", "2"]]) {
      await expect(pageOperation(call, ["settle", ...args], { owned: false })).rejects.toThrow("between 0 and 10000");
    }
    expect(call).not.toHaveBeenCalled();
  });
});
