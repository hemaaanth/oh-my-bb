import { useId, useMemo } from "react";
import { useHost, type AssetBytes, type ImageResult } from "../host.js";
export type { AssetBytes } from "../host.js";
export interface UiRuntime {
  loadAsset: (src: string) => Promise<AssetBytes>;
  loadImage: (src: string) => Promise<ImageResult>;
  blockKey: string;
}
export function useUiRuntime(): UiRuntime {
  const host = useHost();
  const blockKey = useId();
  return useMemo(() => ({ loadAsset: host.loadAsset, loadImage: host.loadImage, blockKey }), [host.loadAsset, host.loadImage, blockKey]);
}
