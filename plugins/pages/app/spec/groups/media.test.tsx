// @vitest-environment jsdom
// The shared lightbox through Gallery, BeforeAfter, and Image, and the Map with lookups on and off. No network: web is a stub.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Renderer } from "@openuidev/react-lang";
import { specLibrary } from "../catalog.js";
import { fallbackHost, HostContext, type Host } from "../host.js";

afterEach(cleanup);

const pixel = "data:image/png;base64,iVBORw0KGgo=";
const show = (code: string, host: Host = fallbackHost) => render(<HostContext.Provider value={host}><Renderer response={`root = ${code}`} library={specLibrary} isStreaming={false} /></HostContext.Provider>);
const dialog = (container: HTMLElement) => container.querySelector("dialog") as HTMLDialogElement;

describe("lightbox", () => {
  it("opens a Gallery photo, steps with buttons and arrows, and closes back to the tile", () => {
    const { container } = show(`Gallery([Photo("${pixel}", "First"), Photo("${pixel}#2", "Second"), "${pixel}#3"])`);
    const tile = screen.getByRole("button", { name: "First. Open full-size image" });
    tile.focus();
    fireEvent.click(tile);
    expect(dialog(container).hasAttribute("open")).toBe(true);
    expect(dialog(container).textContent).toContain("1 / 3 · First");
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    expect(dialog(container).textContent).toContain("2 / 3 · Second");
    fireEvent.keyDown(dialog(container), { key: "ArrowLeft" });
    fireEvent.keyDown(dialog(container), { key: "ArrowLeft" });
    expect(dialog(container).textContent).toContain("3 / 3");
    fireEvent.click(screen.getByRole("button", { name: "Close image preview" }));
    expect(dialog(container).hasAttribute("open")).toBe(false);
    expect(document.activeElement).toBe(tile);
  });

  it("opens Content's Image and closes on a backdrop click or the dialog's close event (Escape)", () => {
    const { container } = show(`Image("${pixel}", "A red dot", "Tiny")`);
    fireEvent.click(screen.getByRole("button", { name: "A red dot. Open full-size image" }));
    expect(dialog(container).hasAttribute("open")).toBe(true);
    expect(dialog(container).getAttribute("aria-label")).toBe("A red dot");
    fireEvent.click(dialog(container));
    expect(dialog(container).hasAttribute("open")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Open full-size image/ }));
    fireEvent(dialog(container), new Event("close"));
    expect(dialog(container).hasAttribute("open")).toBe(false);
  });

  it("shows BeforeAfter labels with tone dots and opens each side with its label in the caption", () => {
    const { container } = show(`BeforeAfter([{"label": "Before", "src": "${pixel}", "alt": "Old form", "tone": "negative"}, {"label": "After", "src": "${pixel}#b", "alt": "New form", "tone": "positive", "caption": "Two fields."}])`);
    expect(container.querySelectorAll(".bg-destructive, .bg-success")).toHaveLength(2);
    expect(screen.getByText("Two fields.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New form. Open full-size image" }));
    expect(dialog(container).textContent).toContain("2 / 2 · After — Two fields.");
  });
});

describe("Map", () => {
  it("draws places and the key, with no credit, when lookups are off", async () => {
    show(`Map([Marker("Here", [38.7, -9.1], "stay", "A note."), Marker("Somewhere", "Nowhere Town")])`);
    expect(screen.getByRole("region", { name: /Map of 1 place/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /OpenStreetMap|Mapbox/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "1. Here" }));
    expect(screen.getByRole("dialog", { name: "Here" }).textContent).toContain("A note.");
    expect((await screen.findByRole("status")).textContent).toBe("Web lookups are not available here.");
  });

  it("asks for place names and tiles through the host, and opens links with openUrl", async () => {
    const openUrl = vi.fn();
    const web = vi.fn(async (method: string, _input: Record<string, unknown>) => method === "geocode" ? { lat: 51.5, lng: -0.12 } : method === "tile" ? { dataUrl: pixel } : {});
    const { container } = show(`Map([Marker("London", "London, UK", "general", null, null, "https://example.com/london")])`, { ...fallbackHost, kind: "chat", web, openUrl } as Host);
    fireEvent.click(await screen.findByRole("button", { name: "1. London" }));
    expect(web).toHaveBeenCalledWith("geocode", { name: "London, UK" });
    await act(async () => {});
    expect(web.mock.calls.some(([method, input]) => method === "tile" && input.theme === "light")).toBe(true);
    expect(container.querySelector(`img[src="${pixel}"]`)).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "London" }));
    expect(openUrl).toHaveBeenCalledWith("https://example.com/london");
  });
});
