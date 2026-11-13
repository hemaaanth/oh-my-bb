// Mermaid diagrams drawn by Pele (pele.run): its own layout, SVG out, colors from CSS variables.
// Pele escapes diagram text and filters links and styles, so its SVG is safe to insert as markup.
import { PeleError, render, type RenderResult } from "pele";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ZoomDiagram } from "./viewer.js";

/** Pele's colors follow the page theme; `tone-*` classes outline flowchart nodes. Set on the SVG's own wrapper, because the lightbox draws a second copy in a portal. */
const THEME = [
  "[--pele-bg:var(--background)] [--pele-fg:var(--foreground)] [--pele-muted:var(--muted-foreground)]",
  "[--pele-line:var(--muted-foreground)] [--pele-surface:var(--muted)] [--pele-surface-alt:var(--background)]",
  "[--pele-border:var(--border)] [--pele-accent:var(--primary)] [--pele-critical:var(--destructive)] [--pele-radius:6px]",
  "[&_.pele-node[class*=tone-]>:not(text)]:[stroke-width:1.5]",
  "[&_.tone-info>:not(text)]:stroke-primary [&_.tone-success>:not(text)]:stroke-success",
  "[&_.tone-warning>:not(text)]:stroke-warning [&_.tone-danger>:not(text)]:stroke-destructive",
].join(" ");

/** Renders Mermaid text. Wide diagrams switch to a vertical layout on narrow screens. Errors show as text. */
export function PeleDiagram({ source, label }: { source: string; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const idPrefix = `pele${useId().replace(/[^\w-]/g, "")}`;
  const [view, setView] = useState<{ font: string; width: number } | null>(null);
  const [fonts, setFonts] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    // Measure in the page font, and lay out for the space there is (in 40px steps, so a resize does not redraw every frame).
    const read = () => setView((last) => {
      const font = getComputedStyle(el).fontFamily, width = Math.max(240, Math.round(el.clientWidth / 40) * 40);
      return last?.font === font && last.width === width ? last : { font, width };
    });
    read();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(read) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);
  // A web font that finishes loading changes label widths: measure again.
  useEffect(() => { let live = true; document.fonts?.ready.then(() => { if (live) setFonts((n) => n + 1); }); return () => { live = false; }; }, []);
  const result = useMemo((): RenderResult | PeleError | null => {
    if (!view) return null;
    try {
      return render(source, { idPrefix, fontFamily: view.font, fontSize: 14, maxWidth: view.width, images: false });
    } catch (error) {
      if (error instanceof PeleError) return error;
      throw error;
    }
  }, [source, idPrefix, view, fonts]);
  return <div ref={box} className="min-w-0">
    {result instanceof PeleError
      ? <pre role="alert" className="m-0 overflow-x-auto rounded-md border border-border p-3 text-xs whitespace-pre-wrap text-muted-foreground">{result.message}</pre>
      : result
        ? <ZoomDiagram width={result.width} height={result.height} label={label}><div className={`contents ${THEME}`} style={{ ["--pele-font" as string]: view!.font }} dangerouslySetInnerHTML={{ __html: result.svg }} /></ZoomDiagram>
        : null}
  </div>;
}
