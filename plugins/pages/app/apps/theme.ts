// Ported from ComicBit/bb-plugin-genui (Apache-2.0). See THIRD_PARTY.md.
import { useCallback, useEffect, useRef, type RefObject } from "react";
import { resolveTheme, themeCss, type AppTheme } from "./appDocument.js";

export function readHostTheme(anchor: Element | null = null): AppTheme {
  const style = getComputedStyle(anchor ?? document.documentElement);
  return resolveTheme((property) => style.getPropertyValue(property));
}

/**
 * Keeps a frame's theme and motion in step with BB's: a theme switch or the
 * Animations setting reaches the running app without reloading it. The
 * returned `sync` re-sends both once the frame's document has loaded, for a
 * change made while it was loading.
 */
export function useHostSync(iframe: RefObject<HTMLIFrameElement | null>, motionOff: boolean): () => void {
  const sentCss = useRef("");
  const motion = useRef(motionOff);
  motion.current = motionOff;

  // Stable: reads only refs, so the observers below subscribe once.
  const postTheme = useCallback(
    (force: boolean) => {
      const css = themeCss(readHostTheme(iframe.current));
      if (!force && css === sentCss.current) return;
      sentCss.current = css;
      iframe.current?.contentWindow?.postMessage({ source: "genui-host", type: "theme", css }, "*");
    },
    [iframe],
  );

  useEffect(() => {
    const onThemeChange = () => postTheme(false);
    const observer = new MutationObserver((records) => {
      const themeAttribute = records.some(
        ({ attributeName }) =>
          attributeName === "class" || attributeName === "style" || attributeName?.startsWith("data-"),
      );
      if (themeAttribute) onThemeChange();
    });
    observer.observe(document.documentElement, { attributes: true });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", onThemeChange);
    return () => {
      observer.disconnect();
      scheme.removeEventListener("change", onThemeChange);
    };
  }, [postTheme]);

  useEffect(() => {
    iframe.current?.contentWindow?.postMessage({ source: "genui-host", type: "motion", off: motionOff }, "*");
  }, [iframe, motionOff]);

  return useCallback(() => {
    postTheme(true);
    iframe.current?.contentWindow?.postMessage({ source: "genui-host", type: "motion", off: motion.current }, "*");
  }, [iframe, postTheme]);
}
