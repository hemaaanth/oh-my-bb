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
