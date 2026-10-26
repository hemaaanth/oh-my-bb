/** Binary assets stay in memory. Shared-page CSP need not permit data: fetches. */
export const SPEC_ASSET_MAX_BYTES = 10 * 1024 * 1024;
export type AssetBytes = { readonly ok: true; readonly bytes: ArrayBuffer; readonly type: string } | { readonly ok: false; readonly error: string };
export type ImageResult = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly error: string };
export function decodeAsset(dataUrl: string): AssetBytes {
  try {
    if (dataUrl.length > SPEC_ASSET_MAX_BYTES * 1.5) throw new Error("Assets must be 10 MB or smaller.");
    const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/u.exec(dataUrl);
    if (!match) throw new Error("The asset is not an embedded data URL.");
    const bytes = match[2] ? Uint8Array.from(atob(match[3]), (char) => char.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(match[3]));
    if (bytes.byteLength > SPEC_ASSET_MAX_BYTES) throw new Error("Assets must be 10 MB or smaller.");
    return { ok: true, bytes: bytes.buffer, type: match[1] };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The asset could not be decoded." };
  }
}
export function assetUrl(value: unknown): string {
  if (typeof value !== "object" || value === null || !("dataUrl" in value) || typeof value.dataUrl !== "string") throw new Error("The asset response has no data URL.");
  return value.dataUrl;
}
