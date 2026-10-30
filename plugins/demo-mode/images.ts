export const IMAGE_REGIONS = "[data-message-column] img, [data-timeline-row-id] img, [data-promptbox] img, [role=dialog] img, [data-bb-demo-sensitive] img, img[data-bb-demo-sensitive]";
export type ImageMaskOptions = { style: "cover" | "pixelate"; pixelSize: number };
export function imageOptions(values?: Record<string, string | number | boolean>): ImageMaskOptions {
  const size = Number(values?.imagePixelSize ?? 24);
  return { style: values?.imageMask === "pixelate" ? "pixelate" : "cover", pixelSize: Number.isFinite(size) ? Math.min(64, Math.max(8, size)) : 24 };
}

/** Paint only from an already-loaded image; unreadable cross-origin images keep the solid cover. */
export function pixelatedImage(img: HTMLImageElement, pixelSize: number): string | null {
  const { width, height } = img.getBoundingClientRect();
  if (!img.complete || !img.naturalWidth || !img.naturalHeight || width < 1 || height < 1) return null;
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.floor(width / pixelSize));
  small.height = Math.max(1, Math.floor(height / pixelSize));
  const output = document.createElement("canvas");
  output.width = Math.round(width); output.height = Math.round(height);
  try {
    const sample = small.getContext("2d");
    const paint = output.getContext("2d");
    if (!sample || !paint) return null;
    const fit = getComputedStyle(img).objectFit;
    const scale = fit === "cover" ? Math.max(width / img.naturalWidth, height / img.naturalHeight)
      : fit === "contain" || fit === "scale-down" ? Math.min(width / img.naturalWidth, height / img.naturalHeight, fit === "scale-down" ? 1 : Infinity) : null;
    // Retain the image's broad colour and crop. No text or fine details are drawn at full resolution.
    const w = scale === null ? small.width : img.naturalWidth * scale * small.width / width;
    const h = scale === null ? small.height : img.naturalHeight * scale * small.height / height;
    sample.imageSmoothingEnabled = true;
    sample.imageSmoothingQuality = "high";
    sample.drawImage(img, (small.width - w) / 2, (small.height - h) / 2, w, h);
    paint.imageSmoothingEnabled = false;
    paint.drawImage(small, 0, 0, output.width, output.height);
    return output.toDataURL("image/png");
  } catch {
    return null;
  }
}

export function createImageMask(options: ImageMaskOptions) {
  const images = new Map<HTMLImageElement, { key: string; load: () => void }>();
  const clear = (img: HTMLImageElement) => img.style.removeProperty("--bb-demo-pixel-image");
  const draw = (img: HTMLImageElement) => {
    const entry = images.get(img);
    if (!entry) return;
    const { width, height } = img.getBoundingClientRect();
    const key = `${img.currentSrc}|${img.src}|${img.complete}|${width}|${height}`;
    if (entry.key === key) return;
    entry.key = key;
    clear(img);
    const value = pixelatedImage(img, options.pixelSize);
    if (value) img.style.setProperty("--bb-demo-pixel-image", `url("${value}")`);
  };
  const resize = new ResizeObserver((entries) => entries.forEach(({ target }) => draw(target as HTMLImageElement)));
  const remove = (img: HTMLImageElement) => {
    img.removeEventListener("load", images.get(img)!.load);
    img.removeEventListener("error", images.get(img)!.load);
    resize.unobserve(img); clear(img); images.delete(img);
  };
  const refresh = () => {
    const active = options.style === "pixelate" && document.body.hasAttribute("data-bb-demo-mode");
    for (const img of images.keys()) if (!active || !img.isConnected || !img.matches(IMAGE_REGIONS)) remove(img);
    if (!active) return;
    document.querySelectorAll<HTMLImageElement>(IMAGE_REGIONS).forEach((img) => {
      if (!images.has(img)) {
        const load = () => { const entry = images.get(img); if (entry) entry.key = ""; draw(img); };
        images.set(img, { key: "", load });
        img.addEventListener("load", load); img.addEventListener("error", load); resize.observe(img);
      }
      draw(img);
    });
  };
  const observer = new MutationObserver((changes) => {
    for (const change of changes) {
      // Invalidate immediately when React reuses a thumbnail for another attachment.
      if (change.type === "attributes" && change.target instanceof HTMLImageElement && images.has(change.target)) {
        images.get(change.target)!.key = "";
        clear(change.target);
      }
    }
    refresh();
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-bb-demo-mode", "data-bb-demo-sensitive", "src", "srcset", "sizes"] });
  refresh();
  return () => { observer.disconnect(); resize.disconnect(); for (const img of images.keys()) remove(img); };
}
