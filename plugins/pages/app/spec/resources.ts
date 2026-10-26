import { assetUrl, decodeAsset, SPEC_ASSET_MAX_BYTES, type AssetBytes, type ImageResult } from "./assets.js";
import type { Host } from "./host.js";

/** A block keeps successful resources across hide/show without sending file paths to the browser network. */
export function hostResources(readFile: (src: string) => Promise<unknown>, readImage: (src: string) => Promise<unknown>): Pick<Host, "loadAsset" | "loadImage"> {
  const cache = new Map<string, { promise: Promise<string>; size: number }>();
  let bytes = 0;
  const resource = (src: string): Promise<string> => {
    const saved = cache.get(src);
    if (saved) { cache.delete(src); cache.set(src, saved); return saved.promise; }
    let entry: { promise: Promise<string>; size: number };
    const promise = Promise.resolve().then(async () => {
      const url = src.startsWith("data:") ? src : assetUrl(await (/^https?:\/\//iu.test(src) ? readImage(src) : readFile(src)));
      if (url.length > SPEC_ASSET_MAX_BYTES * 1.5) throw new Error("Assets must be 10 MB or smaller.");
      if (cache.get(src) !== entry) return url;
      entry.size = url.length * 2;
      bytes += entry.size;
      while (bytes > 32 * 1024 * 1024 || cache.size > 32) {
        const key = cache.keys().next().value as string | undefined;
        if (key === undefined) break;
        const evicted = cache.get(key)!;
        cache.delete(key);
        bytes -= evicted.size;
      }
      return url;
    }).catch((error: unknown) => {
      if (cache.get(src) === entry) cache.delete(src);
      throw error;
    });
    entry = { promise, size: 0 };
    cache.set(src, entry);
    return entry.promise;
  };
  const loadAsset = async (src: string): Promise<AssetBytes> => {
    try { return decodeAsset(await resource(src)); }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : "The asset could not be read." }; }
  };
  const loadImage = async (src: string): Promise<ImageResult> => {
    try {
      const url = await resource(src);
      return url.startsWith("data:image/") ? { ok: true, url } : { ok: false, error: "The asset is not an image." };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "The image could not be read." }; }
  };
  return { loadAsset, loadImage };
}
