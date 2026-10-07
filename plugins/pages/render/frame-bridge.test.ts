// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FRAME_BRIDGE } from "./frame-bridge.js";

// The bridge runs as if inside a BB preview frame. Its parent is a second jsdom window, so posts and sources are real windows.
const host = document.createElement("iframe");
document.body.append(host);
const parent = host.contentWindow!;
const posted = vi.fn();
let resize: () => void = () => undefined;
// What the bridge decided. Listeners after it then cancel every click, since jsdom cannot navigate.
let handled = false;

beforeAll(() => {
  Object.defineProperty(window, "parent", { configurable: true, get: () => parent });
  parent.postMessage = posted as never;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) { resize = callback; }
    observe() { /* the test calls resize itself */ }
    unobserve() { /* unused */ }
    disconnect() { /* unused */ }
  } as never;
  document.documentElement.setAttribute("data-bb-frame", "inline");
  Function(FRAME_BRIDGE)();
  window.addEventListener("click", (event) => { handled = event.defaultPrevented; event.preventDefault(); });
});

beforeEach(() => { posted.mockClear(); document.body.innerHTML = ""; });

/** Clicks the element and returns whether the bridge took the click. */
function click(html: string, selector = "a"): boolean {
  document.body.innerHTML = html;
  document.querySelector(selector)!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  return handled;
}

describe("frame bridge links", () => {
  it("hands http(s) links to the host instead of navigating the sandbox", () => {
    expect(click('<a href="https://example.com/docs?q=1">docs</a>')).toBe(true);
    expect(posted).toHaveBeenCalledWith({ type: "bb-pages:open", url: "https://example.com/docs?q=1" }, "*");
  });

  it("routes data-table pill links (target=_blank), even from a nested node", () => {
    expect(click('<div class="data-table-row"><a class="data-table-pill good" href="https://example.com/pr/1" target="_blank" rel="noopener noreferrer"><b>Merged</b></a></div>', "b")).toBe(true);
    expect(posted).toHaveBeenCalledWith({ type: "bb-pages:open", url: "https://example.com/pr/1" }, "*");
  });

  it("keeps in-page, non-web, and author-handled links in the page", () => {
    for (const html of ['<a href="#results">results</a>', '<a href="mailto:a@example.com">mail</a>', '<a href="javascript:void 0">x</a>', "<a>no href</a>"]) {
      expect(click(html)).toBe(false);
    }
    document.body.innerHTML = '<a href="https://example.com/">x</a>';
    const link = document.querySelector("a")!;
    link.addEventListener("click", (event) => event.preventDefault());
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    document.body.innerHTML = '<a href="https://example.com/">x</a>';
    document.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 1 }));
    expect(posted).not.toHaveBeenCalled();
  });
});

describe("frame bridge theme", () => {
  it("takes the app theme from its parent only", () => {
    const root = document.documentElement;
    root.setAttribute("data-bb-theme", "light");
    window.dispatchEvent(new MessageEvent("message", { data: { type: "bb-pages:theme", theme: "dark" }, source: window }));
    expect(root.getAttribute("data-bb-theme")).toBe("light");
    window.dispatchEvent(new MessageEvent("message", { data: { type: "bb-pages:theme", theme: "sepia" }, source: parent }));
    expect(root.getAttribute("data-bb-theme")).toBe("light");
    window.dispatchEvent(new MessageEvent("message", { data: { type: "bb-pages:theme", theme: "dark" }, source: parent }));
    expect(root.getAttribute("data-bb-theme")).toBe("dark");
  });
});

describe("frame bridge height", () => {
  it("reports the content height when it changes, and only then", () => {
    const root = document.documentElement;
    let height = 312.3;
    vi.spyOn(root, "getBoundingClientRect").mockImplementation(() => ({ height }) as DOMRect);
    resize();
    expect(posted).toHaveBeenLastCalledWith({ type: "bb-pages:height", height: 313 }, "*");
    resize();
    expect(posted).toHaveBeenCalledTimes(1);
    height = 500;
    resize();
    expect(posted).toHaveBeenLastCalledWith({ type: "bb-pages:height", height: 500 }, "*");
  });
});
