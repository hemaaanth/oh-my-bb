import { useEffect, useState, type RefObject } from "react";
/** Redraw token colours when the originating pane or its document changes theme. */
export function useThemeRevision(ref: RefObject<HTMLElement | null>): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setRevision((value) => value + 1));
    let node: Element | null = ref.current;
    while (node) {
      observer.observe(node, { attributes: true, attributeFilter: ["class", "style", "data-bb-theme", "data-theme"] });
      const parent = node.parentElement;
      const root = node.getRootNode();
      node = parent ?? (root instanceof ShadowRoot ? root.host : null);
    }
    return () => observer.disconnect();
  }, [ref]);
  return revision;
}
