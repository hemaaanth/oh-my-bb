// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { PAGE_RUNTIME, needsPageRuntime } from "./page-runtime.js";

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
