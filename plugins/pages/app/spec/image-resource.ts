import { useEffect, useState } from "react";
import { useHost } from "./host.js";

interface ImageResource { source: string; image?: HTMLImageElement; error?: string }

/** Uses the host's file scope and baked assets. It never fetches an arbitrary path. */
export function useImageResource(source: string | undefined): ImageResource | null {
  const host = useHost();
  const [resource, setResource] = useState<ImageResource | null>(null);
  useEffect(() => {
    if (!source) return;
    let active = true;
    void (async () => {
      try {
        const result = await host.loadImage(source);
        if (!result.ok) throw new Error(result.error);
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.referrerPolicy = "no-referrer";
        image.src = result.url;
        await image.decode();
        if (active) setResource({ source, image });
      } catch (error) {
        if (active) setResource({ source, error: error instanceof Error ? error.message : "Could not decode this image." });
      }
    })();
    return () => { active = false; };
  }, [source, host.loadImage]);
  return source ? resource?.source === source ? resource : { source } : null;
}
