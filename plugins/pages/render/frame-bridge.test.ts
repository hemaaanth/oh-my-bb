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
  window.history.replaceState(null, "", "/api/v1/plugins/pages/http/v?id=v1");
  Function(FRAME_BRIDGE)();
  window.addEventListener("click", (event) => { handled = event.defaultPrevented; event.preventDefault(); });
  window.addEventListener("submit", (event) => { handled = event.defaultPrevented; event.preventDefault(); });
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

  it("hands links to other pages of a folder (the sibling v and a routes) to the host as page links", () => {
    const origin = window.location.origin;
    expect(click('<a href="./a?id=v1&amp;path=docs%2Fother.html#s">p</a>')).toBe(true);
    expect(posted).toHaveBeenLastCalledWith({ type: "bb-pages:page", url: `${origin}/api/v1/plugins/pages/http/a?id=v1&path=docs%2Fother.html#s` }, "*");
    expect(click('<a href="./v?id=v2">v2</a>')).toBe(true);
    expect(posted).toHaveBeenLastCalledWith({ type: "bb-pages:page", url: `${origin}/api/v1/plugins/pages/http/v?id=v2` }, "*");
    // Other routes, even on the same origin, are ordinary links.
    for (const href of ["./file?x=1", "../other/v?id=v1", "/a?id=v1"]) {
      expect(click(`<a href="${href}">x</a>`)).toBe(true);
      expect(posted).toHaveBeenLastCalledWith({ type: "bb-pages:open", url: new URL(href, window.location.href).href }, "*");
    }
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

/** Submits the form with the button (if any) as the submitter, and returns the last post. */
function submit(html: string, submitter?: string) {
  document.body.innerHTML = html;
  const form = document.querySelector("form")!;
  form.requestSubmit(submitter ? document.querySelector<HTMLButtonElement>(submitter) : undefined);
  return { form, post: posted.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined };
}

/** The host's answer for a submission, from the parent window. */
function answer(data: Record<string, unknown>, source: Window = parent) {
  window.dispatchEvent(new MessageEvent("message", { data: { type: "bb-pages:submitted", ...data }, source }));
}

describe("frame bridge forms", () => {
  it("sends every named field under the label the reader saw", () => {
    const { post } = submit(`<form>
      <h2>Launch review</h2>
      <label>Your name <input name="who" value="Ada"></label>
      <input name="team" aria-label="Team" value="Core">
      <input name="email" placeholder="Email address">
      <textarea name="notes" data-label="Notes for the agent">Ship it</textarea>
      <fieldset><legend>Risk</legend>
        <label><input type="radio" name="risk" value="low">Low</label>
        <label><input type="radio" name="risk" checked>High risk</label>
      </fieldset>
      <fieldset><legend>Areas</legend>
        <label><input type="checkbox" name="area" value="api" checked>API</label>
        <label><input type="checkbox" name="area" value="ui">UI</label>
        <label><input type="checkbox" name="area" value="docs" checked>Docs</label>
      </fieldset>
      <label><input type="checkbox" name="urgent" checked> Urgent</label>
      <label>Regions <select name="regions" multiple><option value="us" selected>US</option><option value="eu" selected>EU</option><option>Asia</option></select></label>
      <input name="off" value="x" disabled><input type="file" name="upload"><input type="hidden" name="token" value="t1"><input value="no name">
      <button>Send</button>
    </form>`);
    expect(post).toMatchObject({ type: "bb-pages:submit", formTitle: "Launch review", action: null });
    expect(post!.submissionId).toMatch(/^[A-Za-z0-9_-]{8,64}$/u);
    expect(post!.answers).toEqual([
      { name: "who", label: "Your name", value: "Ada" },
      { name: "team", label: "Team", value: "Core" },
      { name: "email", label: "Email address", value: "" },
      { name: "notes", label: "Notes for the agent", value: "Ship it" },
      { name: "risk", label: "Risk", value: "High risk" },
      { name: "area", label: "Areas", value: ["api", "docs"] },
      { name: "urgent", label: "Urgent", value: true },
      { name: "regions", label: "Regions", value: ["us", "eu"] },
      { name: "token", label: "token", value: "t1" },
    ]);
  });

  it("names the action only when the clicked button names one", () => {
    expect(submit('<form data-title="Plan"><button name="choice" value="approve">Looks good</button></form>', "button").post).toMatchObject({ formTitle: "Plan", action: "approve" });
    expect(submit('<form><button>Approve</button><button>Reject</button></form>', "button:last-child").post).toMatchObject({ formTitle: null, action: "Reject" });
    expect(submit('<form aria-label="Single"><button>Send</button></form>', "button").post).toMatchObject({ formTitle: "Single", action: null });
  });

  it("locks the form while it sends, and keeps it locked and marked sent after", () => {
    const { form, post } = submit('<form id="review"><input name="a" value="1"><button>Send</button></form>');
    const status = () => form.querySelector("[data-bb-pages-status]")!;
    expect(post).toMatchObject({ formKey: "review" });
    expect(form.getAttribute("aria-busy")).toBe("true");
    expect(form.getAttribute("data-bb-pages-state")).toBe("sending");
    expect(form.querySelector("input")!.disabled).toBe(true);
    expect(status().textContent).toBe("Sending…");
    expect(status().getAttribute("role")).toBe("status");
    // A second submit while busy is held; an answer from another window is ignored.
    form.requestSubmit();
    expect(posted).toHaveBeenCalledTimes(1);
    answer({ submissionId: post!.submissionId, ok: true }, window);
    expect(form.getAttribute("aria-busy")).toBe("true");
    answer({ submissionId: post!.submissionId, ok: true });
    expect(form.hasAttribute("aria-busy")).toBe(false);
    expect(form.getAttribute("data-bb-pages-state")).toBe("sent");
    expect(form.querySelector("input")!.disabled).toBe(true);
    expect(form.querySelector("button")!.hasAttribute("data-bb-pages-chosen")).toBe(true);
    expect(status().textContent).toBe("Sent to the thread. Edit answers");
    // Edit answers unlocks the form, so it can be sent again.
    status().querySelector<HTMLButtonElement>("[data-bb-pages-edit]")!.click();
    expect(form.hasAttribute("data-bb-pages-state")).toBe(false);
    expect(form.querySelector("input")!.disabled).toBe(false);
    expect(status().textContent).toBe("Change your answers, then send again.");
    form.requestSubmit();
    expect(posted).toHaveBeenCalledTimes(2);
  });

  it("names a form by its id, its name, or its place on the page", () => {
    document.body.innerHTML = '<form name="first"><button>Go</button></form><form><button>Go</button></form>';
    document.forms[1]!.requestSubmit();
    expect(posted.mock.calls.at(-1)?.[0]).toMatchObject({ formKey: "form-1" });
    document.forms[0]!.requestSubmit();
    expect(posted.mock.calls.at(-1)?.[0]).toMatchObject({ formKey: "first" });
  });

  it("shows a form sent before as sent, with its answers and button", () => {
    document.body.innerHTML = `<form id="plan"><input name="who"><textarea name="notes"></textarea>
      <label><input type="radio" name="risk" value="low">Low</label><label><input type="radio" name="risk" value="high">High</label>
      <label><input type="checkbox" name="area" value="api">API</label><label><input type="checkbox" name="area" value="ui">UI</label>
      <label><input type="checkbox" name="urgent"> Urgent</label>
      <select name="regions" multiple><option value="us">US</option><option value="eu">EU</option></select>
      <button>Approve</button><button>Reject</button></form><form id="other"><input name="x"></form>`;
    const form = document.forms[0]!;
    const restore = (forms: unknown[], source: Window = parent) => window.dispatchEvent(new MessageEvent("message", { data: { type: "bb-pages:restore", forms }, source }));
    const sent = { formKey: "plan", action: "Reject", sentAt: "2026-10-14T09:30:00.000Z", answers: [
      { name: "who", label: "who", value: "Ada" }, { name: "notes", label: "notes", value: "Later" },
      { name: "risk", label: "Risk", value: "high" }, { name: "area", label: "Areas", value: ["ui"] },
      { name: "urgent", label: "Urgent", value: true }, { name: "regions", label: "Regions", value: ["eu"] },
      { name: "gone", label: "Gone", value: "x" },
    ] };
    restore([sent], window);
    expect(form.hasAttribute("data-bb-pages-state")).toBe(false);
    restore([sent, { formKey: "missing", action: null, answers: [], sentAt: "" }]);
    expect(form.getAttribute("data-bb-pages-state")).toBe("sent");
    expect(document.forms[1]!.hasAttribute("data-bb-pages-state")).toBe(false);
    expect(form.querySelector<HTMLInputElement>("[name=who]")!.value).toBe("Ada");
    expect(form.querySelector("textarea")!.value).toBe("Later");
    expect(Array.from(form.querySelectorAll<HTMLInputElement>("[type=radio]"), (item) => item.checked)).toEqual([false, true]);
    expect(Array.from(form.querySelectorAll<HTMLInputElement>("[type=checkbox]"), (item) => item.checked)).toEqual([false, true, true]);
    expect(Array.from(form.querySelector("select")!.selectedOptions, (option) => option.value)).toEqual(["eu"]);
    expect(Array.from(form.querySelectorAll("button:not([data-bb-pages-edit])"), (button) => button.hasAttribute("data-bb-pages-chosen"))).toEqual([false, true]);
    expect(form.querySelector<HTMLInputElement>("[name=who]")!.disabled).toBe(true);
    expect(form.querySelector("[data-bb-pages-status]")!.textContent).toMatch(/^Sent to the thread .+2026.+\. Edit answers$/u);
    // A second restore, as on every load, changes nothing.
    restore([{ ...sent, answers: [{ name: "who", label: "who", value: "Bob" }] }]);
    expect(form.querySelector<HTMLInputElement>("[name=who]")!.value).toBe("Ada");
  });

  it("shows why a form was not sent, in the page's own status line", () => {
    const { form, post } = submit('<form><input name="a"><p data-bb-pages-status class="mine"></p><button>Send</button></form>');
    answer({ submissionId: post!.submissionId, ok: false, message: "Too many forms sent to this thread." });
    expect(form.querySelectorAll("[data-bb-pages-status]")).toHaveLength(1);
    expect(form.querySelector(".mine")!.textContent).toBe("Too many forms sent to this thread.");
  });

  it("gives up after 20 seconds without an answer", () => {
    vi.useFakeTimers();
    try {
      const { form } = submit('<form><input name="a"><button>Send</button></form>');
      vi.advanceTimersByTime(20_000);
      expect(form.hasAttribute("aria-busy")).toBe(false);
      expect(form.getAttribute("data-bb-pages-state")).toBe("error");
      expect(form.querySelector("input")!.disabled).toBe(false);
      expect(form.querySelector("[data-bb-pages-status]")!.textContent).toBe("BB did not answer. Send again.");
    } finally { vi.useRealTimers(); }
  });

  it("leaves manual, cancelled, and dialog forms to the page", () => {
    submit('<form data-bb-pages-manual><input name="a"></form>');
    expect(handled).toBe(false);
    submit('<form method="dialog"><button>Close</button></form>');
    expect(handled).toBe(false);
    document.body.innerHTML = '<form><input name="a"></form>';
    const form = document.querySelector("form")!;
    form.addEventListener("submit", (event) => event.preventDefault());
    form.requestSubmit();
    expect(form.hasAttribute("aria-busy")).toBe(false);
    expect(posted).not.toHaveBeenCalled();
  });
});
