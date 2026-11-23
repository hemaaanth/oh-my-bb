// @vitest-environment jsdom
// Viewer navigation and dismissal, plus unresolved map locations. No network.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Renderer } from "@openuidev/react-lang";
import { specLibrary } from "../catalog.js";
import { fallbackHost, HostContext, type Host } from "../host.js";

afterEach(cleanup);

// jsdom does not implement the browser's modal or resize primitives.
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterAll(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  vi.unstubAllGlobals();
});

const pixel = "data:image/png;base64,iVBORw0KGgo=";
const show = (code: string, host: Host = fallbackHost) => render(<HostContext.Provider value={host}><Renderer response={`root = ${code}`} library={specLibrary} isStreaming={false} /></HostContext.Provider>);
const dialog = () => screen.getByRole("dialog") as HTMLDialogElement;

describe("lightbox", () => {
  it("opens a Gallery photo, steps with buttons and arrows, and closes back to the tile", () => {
    show(`Gallery([Photo("${pixel}", "First"), Photo("${pixel}#2", "Second"), "${pixel}#3"])`);
    const tile = screen.getByRole("button", { name: "First. Open full-size image" });
    tile.focus();
    fireEvent.click(tile);
    expect(dialog().hasAttribute("open")).toBe(true);
    expect(dialog().querySelector("img")?.getAttribute("src")).toBe(pixel);
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    expect(dialog().querySelector("img")?.getAttribute("src")).toBe(`${pixel}#2`);
    fireEvent.keyDown(dialog(), { key: "ArrowLeft" });
    fireEvent.keyDown(dialog(), { key: "ArrowLeft" });
    expect(dialog().querySelector("img")?.getAttribute("src")).toBe(`${pixel}#3`);
    fireEvent.click(screen.getByRole("button", { name: "Close image preview" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(tile);
  });

  it("dismisses an image on backdrop click or native cancel", () => {
    show(`Image("${pixel}", "A red dot", "Tiny")`);
    fireEvent.click(screen.getByRole("button", { name: "A red dot. Open full-size image" }));
    expect(dialog().hasAttribute("open")).toBe(true);
    fireEvent.click(dialog());
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Open full-size image/ }));
    fireEvent(dialog(), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the selected BeforeAfter side and returns focus to that side", () => {
    show(`BeforeAfter([{"label": "Before", "src": "${pixel}", "alt": "Old form"}, {"label": "After", "src": "${pixel}#b", "alt": "New form"}])`);
    const tile = screen.getByRole("button", { name: "New form. Open full-size image" });
    tile.focus();
    fireEvent.click(tile);
    expect(dialog().querySelector("img")?.getAttribute("src")).toBe(`${pixel}#b`);
    fireEvent.click(screen.getByRole("button", { name: "Close image preview" }));
    expect(document.activeElement).toBe(tile);
  });

  it("loads local BeforeAfter images through host.loadImage", async () => {
    const host: Host = {
      ...fallbackHost,
      loadImage: vi.fn(async (src: string) => ({ ok: true as const, url: `${pixel}#${src}` })),
    };
    const { container } = show(`BeforeAfter([{"label": "Before", "src": "proof/before.png", "alt": "Before state"}, {"label": "After", "src": "proof/after.png", "alt": "After state"}])`, host);
    await vi.waitFor(() => {
      const imgs = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
      expect(imgs).toEqual([`${pixel}#proof/before.png`, `${pixel}#proof/after.png`]);
    });
    expect(host.loadImage).toHaveBeenCalledWith("proof/before.png");
    expect(host.loadImage).toHaveBeenCalledWith("proof/after.png");
  });
});

describe("Map", () => {
  it("draws places and the key, with no credit, when lookups are off", async () => {
    show(`Map([Marker("Here", [38.7, -9.1], "stay", "A note."), Marker("Somewhere", "Nowhere Town")])`);
    expect(screen.getByRole("region", { name: /Map of 1 place/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /OpenStreetMap|Mapbox/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "1. Here" }));
    expect(screen.getByRole("dialog", { name: "Here" }).textContent).toContain("A note.");
  });

});

describe("Video", () => {
  const mp4 = "data:video/mp4;base64,AAAA";

  it("renders a data: video with controls and caption", () => {
    const { container } = show(`Video("${mp4}", "After fix")`);
    const video = container.querySelector("video");
    expect(video?.getAttribute("src")).toBe(mp4);
    expect(video?.hasAttribute("controls")).toBe(true);
    expect(screen.getByText("After fix")).toBeTruthy();
  });

  it("loads a local video file through host.loadAsset", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:proof-clip");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const host: Host = {
      ...fallbackHost,
      loadAsset: vi.fn(async () => ({ ok: true as const, type: "video/mp4", bytes: new Uint8Array([0, 0, 0, 1]).buffer })),
    };
    const { container, unmount } = show(`Video("out/demo.mp4", "Demo clip")`, host);
    await vi.waitFor(() => {
      expect(container.querySelector("video")?.getAttribute("src")).toBe("blob:proof-clip");
    });
    expect(host.loadAsset).toHaveBeenCalledWith("out/demo.mp4");
    unmount();
    expect(revokeUrl).toHaveBeenCalledWith("blob:proof-clip");
    createUrl.mockRestore();
    revokeUrl.mockRestore();
  });

  it("blocks remote video URLs in chat but allows them on published pages", () => {
    const { container: chat } = show(`Video("https://example.test/demo.mp4")`, { ...fallbackHost, kind: "chat" });
    expect(chat.querySelector("video")).toBeNull();
    expect(chat.textContent).toContain("Remote video URLs are not loaded in chat");
    cleanup();
    const { container: page } = show(`Video("https://example.test/demo.mp4")`, { ...fallbackHost, kind: "page" });
    expect(page.querySelector("video")?.getAttribute("src")).toBe("https://example.test/demo.mp4");
  });
});
