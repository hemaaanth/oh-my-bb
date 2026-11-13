// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeFrame } from "./host.js";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("CodeFrame copy", () => {
  it("keeps every label in one cell, so the width never changes", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CodeFrame label="a.ts" text="x">body</CodeFrame>);
    const button = screen.getByRole("button", { name: "Copy a.ts" });
    expect(button.textContent).toBe("CopyCopiedCopy failed");
    await act(async () => { fireEvent.click(button); });
    expect(writeText).toHaveBeenCalledWith("x");
    expect(button.textContent).toBe("CopyCopiedCopy failedCopied");
    expect(screen.getByText("Copy").className).toContain("invisible");
    expect(screen.getAllByText("Copied").some((label) => !label.className.includes("invisible"))).toBe(true);
  });
});
