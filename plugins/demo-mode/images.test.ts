// @vitest-environment jsdom
import { act } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, test, vi } from "vitest";
import { createImageMask, imageOptions, pixelatedImage } from "./images";

function image() {
  const img = document.createElement("img");
  img.src = "private.png";
  Object.defineProperties(img, { complete: { value: true, configurable: true }, naturalWidth: { value: 1000 }, naturalHeight: { value: 500 } });
  img.getBoundingClientRect = () => ({ width: 240, height: 120 } as DOMRect);
  return img;
}
function canvas() {
  const sample = { drawImage: vi.fn(), imageSmoothingEnabled: false, imageSmoothingQuality: "" };
  const output = { drawImage: vi.fn(), imageSmoothingEnabled: true };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValueOnce(sample as never).mockReturnValue(output as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,cGl4ZWxz");
  return { sample, output };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; document.body.removeAttribute("data-bb-demo-mode"); });

test("solid cover remains default and configured screen-pixel size is bounded", () => {
  expect(imageOptions()).toEqual({ style: "cover", pixelSize: 24 });
  expect(imageOptions({ imageMask: "pixelate", imagePixelSize: "48" })).toEqual({ style: "pixelate", pixelSize: 48 });
  expect(imageOptions({ imagePixelSize: "invalid" }).pixelSize).toBe(24);
  expect(imageOptions({ imagePixelSize: "1" }).pixelSize).toBe(8);
  expect(imageOptions({ imagePixelSize: "1000" }).pixelSize).toBe(64);
});
test("samples the loaded colours at screen size and enlarges without smoothing", () => {
  const { sample, output } = canvas();
  const img = image();
  expect(pixelatedImage(img, 24)).toBe("data:image/png;base64,cGl4ZWxz");
  expect(sample.drawImage).toHaveBeenCalledWith(img, 0, 0, 10, 5);
  expect(output.drawImage.mock.calls[0]![0]).toMatchObject({ width: 10, height: 5 });
  expect(output.drawImage.mock.calls[0]!.slice(1)).toEqual([0, 0, 240, 120]);
  expect(output.imageSmoothingEnabled).toBe(false);
});
test("unloaded and tainted images fall back to the solid cover", () => {
  canvas();
  vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockImplementation(() => { throw new DOMException("Tainted", "SecurityError"); });
  const img = image();
  expect(pixelatedImage(img, 24)).toBeNull();
  Object.defineProperty(img, "complete", { value: false });
  expect(pixelatedImage(img, 24)).toBeNull();
});
test("source changes clear old pixels while loading and disposal restores inline styles", async () => {
  canvas();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const img = image(); img.setAttribute("data-bb-demo-sensitive", "");
  img.style.borderRadius = "8px"; document.body.append(img);
  document.body.setAttribute("data-bb-demo-mode", "");
  const dispose = createImageMask({ style: "pixelate", pixelSize: 24 });
  expect(img.style.getPropertyValue("--bb-demo-pixel-image")).toContain("data:image/png");
  Object.defineProperty(img, "complete", { value: false, configurable: true });
  img.src = "another-private.png";
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(img.style.getPropertyValue("--bb-demo-pixel-image")).toBe("");
  Object.defineProperty(img, "complete", { value: true });
  img.dispatchEvent(new Event("load"));
  expect(img.style.getPropertyValue("--bb-demo-pixel-image")).toContain("data:image/png");
  document.body.removeAttribute("data-bb-demo-mode");
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(img.style.getPropertyValue("--bb-demo-pixel-image")).toBe("");
  dispose();
  expect(img.src).toContain("another-private.png");
  expect(img.style.borderRadius).toBe("8px");
});

test("the app overlay reads native settings without adding visible UI", async () => {
  canvas();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const img = image(); img.setAttribute("data-bb-demo-sensitive", ""); document.body.append(img);
  document.body.setAttribute("data-bb-demo-mode", "");
  const app = await loadPluginApp(() => import("./app"));
  const overlay = app.appOverlays.find(({ id }) => id === "image-mask")!;
  const rendered = renderSlot(overlay, {}, { settings: { imageMask: "pixelate", imagePixelSize: "48" } });
  expect(img.style.getPropertyValue("--bb-demo-pixel-image")).toContain("data:image/png");
  await act(async () => { rendered.lifecycle.unmount(); });
  expect(img.style.getPropertyValue("--bb-demo-pixel-image")).toBe("");
});
