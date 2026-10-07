// The host side of the frame bridge. Protocol: FRAME_MESSAGE in contract.ts. Page side: render/frame-bridge.ts.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { FRAME_MESSAGE } from "../contract.js";
import { themedUrl, usePreviewTheme } from "./ui.js";

/** Far taller than any page a chat frame shows. A larger report is noise. */
const MAX_REPORTED_HEIGHT = 100_000;
const MAX_URL_LENGTH = 8_192;

export type FrameMessage = { type: "open"; url: string } | { type: "height"; height: number };

/** A page's message, checked. Anything else, including a link that is not http(s), is null. */
export function readFrameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const { type, url, height } = data as Record<string, unknown>;
  if (type === FRAME_MESSAGE.open) {
    if (typeof url !== "string" || url.length > MAX_URL_LENGTH) return null;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? { type: "open", url: parsed.href } : null;
    } catch {
      return null;
    }
  }
  if (type === FRAME_MESSAGE.height) {
    return typeof height === "number" && Number.isFinite(height) && height > 0 && height <= MAX_REPORTED_HEIGHT ? { type: "height", height: Math.ceil(height) } : null;
  }
  return null;
}

export const themeMessage = (theme: "light" | "dark") => ({ type: FRAME_MESSAGE.theme, theme });

/**
 * One preview iframe's side of the bridge. The first theme rides in the URL, so the page paints themed.
 * Later theme changes are posted, so the src stays the same and the page does not reload.
 * Only messages from this iframe's own window count. The frame stays sandboxed without allow-same-origin.
 */
export function useFrameBridge(previewUrl: string, frame?: "card" | "inline", onHeight?: (height: number) => void) {
  const navigate = useBbNavigate();
  const theme = usePreviewTheme();
  const ref = useRef<HTMLIFrameElement>(null);
  // A new page or version loads with the theme of that moment.
  const [loaded, setLoaded] = useState({ previewUrl, theme });
  if (loaded.previewUrl !== previewUrl) setLoaded({ previewUrl, theme });
  const postTheme = useCallback(() => { ref.current?.contentWindow?.postMessage(themeMessage(theme), "*"); }, [theme]);
  useEffect(postTheme, [postTheme]);
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      const own = ref.current?.contentWindow;
      if (!own || event.source !== own) return;
      const message = readFrameMessage(event.data);
      if (message?.type === "open") {
        if (!navigate.openUrl(message.url)) window.open(message.url, "_blank", "noopener,noreferrer");
      } else if (message?.type === "height") {
        onHeight?.(message.height);
      }
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [navigate, onHeight]);
  // The frame's colour scheme matches the app's. A mismatch makes the browser paint an opaque backdrop behind the page.
  const style: CSSProperties = { colorScheme: theme };
  return { ref, src: themedUrl(loaded.previewUrl, loaded.theme, frame), onLoad: postTheme, style };
}
