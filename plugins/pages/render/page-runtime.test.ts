// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LINK_BRIDGE, PAGE_RUNTIME, needsPageRuntime } from "./page-runtime.js";

function runRuntime(html: string): void {
  document.documentElement.removeAttribute("data-bb-frame");
  document.body.innerHTML = html;
  Function(PAGE_RUNTIME)();
}

describe("page runtime image zoom", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) { this.setAttribute("open", ""); },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement) { this.removeAttribute("open"); },
    });
  });

  it("detects compare blocks and explicit zoom images", () => {
    expect(needsPageRuntime('<div class="compare"><img src="a.png"></div>')).toBe(true);
    expect(needsPageRuntime('<img data-zoom src="a.png">')).toBe(true);
    expect(needsPageRuntime('<img src="small-icon.png">')).toBe(false);
  });

  it("opens an explicitly zoomable image with its caption", () => {
    runRuntime('<figure><img data-zoom src="detail.png" alt="Settings detail"><figcaption>Before settings</figcaption></figure>');
    const image = document.querySelector<HTMLImageElement>("img[data-zoom]")!;
    expect(image.getAttribute("role")).toBe("button");
    expect(image.tabIndex).toBe(0);
    image.click();
    expect(document.querySelector("dialog")?.hasAttribute("open")).toBe(true);
    expect(document.querySelector(".image-lightbox-caption")?.textContent).toBe("Before settings");
    document.querySelector<HTMLButtonElement>(".image-lightbox-close")!.click();
    expect(document.querySelector("dialog")?.hasAttribute("open")).toBe(false);
  });

  it("enables only materially downscaled compare images", () => {
    document.body.innerHTML = '<div class="compare"><div><p class="compare-label">Before</p><img src="before.png" alt="Before"></div><div><img src="after.png" alt="After"></div></div>';
    const [before, after] = Array.from(document.images);
    for (const [image, naturalWidth, clientWidth] of [[before, 1200, 600], [after, 600, 600]] as const) {
      Object.defineProperty(image, "complete", { configurable: true, value: true });
      Object.defineProperty(image, "naturalWidth", { configurable: true, value: naturalWidth });
      Object.defineProperty(image, "naturalHeight", { configurable: true, value: 600 });
      Object.defineProperty(image, "clientWidth", { configurable: true, value: clientWidth });
      Object.defineProperty(image, "clientHeight", { configurable: true, value: 600 });
    }
    Function(PAGE_RUNTIME)();
    expect(before.hasAttribute("data-pages-zoom-ready")).toBe(true);
    expect(after.hasAttribute("data-pages-zoom-ready")).toBe(false);
  });
});

describe("link bridge", () => {
  // One bridge per document: its listeners stay on the shared jsdom document, so every case is one run.
  it("posts outside links, loads our own v and a routes in the frame, and leaves the rest alone", () => {
    const parent = { postMessage: vi.fn() };
    Object.defineProperty(window, "parent", { configurable: true, value: parent });
    window.history.replaceState(null, "", "/api/v1/plugins/pages/http/v?id=v1");
    document.body.innerHTML = [
      '<a id="out" href="https://example.com/x"><span>out</span></a><a id="mail" href="mailto:a@b.co">mail</a><a id="frag" href="#top">top</a><a id="rel" href="other.html">rel</a><a id="stopped" href="https://example.com/y">y</a>',
      '<a id="page" href="./a?id=v1&amp;path=docs%2Fother.html#s">p</a><a id="home" href="./v?id=v1">h</a><a id="file" href="./file?x=1">f</a><a id="up" href="../other/v?id=v1">u</a><a id="root" href="/a?id=v1">r</a><a id="middle" href="./a?id=v1">m</a>',
    ].join("");
    document.getElementById("stopped")!.addEventListener("click", (event) => event.preventDefault());
    Function(LINK_BRIDGE)();
    const click = (id: string, init: MouseEventInit = {}, type = "click") => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
      (id === "out" ? document.querySelector("#out span")! : document.getElementById(id)!).dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(click("out")).toBe(true);
    expect(click("out", { button: 1 }, "auxclick")).toBe(true);
    expect(click("mail")).toBe(true);
    expect(click("frag")).toBe(false);
    // Same-origin links never navigate the frame itself; only our routes next to this page are passed up.
    for (const id of ["rel", "page", "home", "file", "up", "root"]) expect(click(id)).toBe(true);
    click("middle", { button: 1 }, "auxclick");
    click("stopped");
    const origin = window.location.origin;
    expect(parent.postMessage.mock.calls.map(([data]) => [data.type, data.url])).toEqual([
      ["open-link", "https://example.com/x"],
      ["open-link", "https://example.com/x"],
      ["open-link", "mailto:a@b.co"],
      ["open-page", `${origin}/api/v1/plugins/pages/http/a?id=v1&path=docs%2Fother.html#s`],
      ["open-page", `${origin}/api/v1/plugins/pages/http/v?id=v1`],
    ]);
    expect(parent.postMessage.mock.calls[0]).toEqual([{ source: "bb-pages", type: "open-link", url: "https://example.com/x" }, "*"]);
    Object.defineProperty(window, "parent", { configurable: true, value: window });
  });
});
