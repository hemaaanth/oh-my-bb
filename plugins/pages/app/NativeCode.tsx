import { useLayoutEffect, useRef, useState } from "react";
import { experimental_SourceCode as SourceCode } from "@get-bb/plugin-sdk/app";
import { CodeFrame, codeLanguage } from "./spec/host.js";

// BB's scrollbar rule must not reserve space inside the code viewer's shadow DOM.
const noIdleScrollbar = "[--diffs-overflow-override:auto] [--diffs-scrollbar-gutter-override:0px] [&_*]:[scrollbar-color:auto]";

/** A viewer initialized under a closed disclosure has no layout. Recreate it when width becomes real. */
export function NativeCode({ content, path }: { content: string; path: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [generation, setGeneration] = useState(0);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    let hadWidth = element.clientWidth > 0;
    const observer = new ResizeObserver(([entry]) => {
      const hasWidth = entry.contentRect.width > 0;
      if (hasWidth && !hadWidth) setGeneration((value) => value + 1);
      hadWidth = hasWidth;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <CodeFrame label={codeLanguage(path)} text={content}>
    <div ref={container} className="min-w-0"><SourceCode key={generation} content={content} path={path} overflow="wrap" className={noIdleScrollbar} /></div>
  </CodeFrame>;
}
