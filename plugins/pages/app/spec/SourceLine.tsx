import { createContext, useContext, useState } from "react";
import { useHost } from "./host.js";
import { focusRing } from "./kit.js";
import { sameCaption, sourceCaption, sourceFileLabel, type SourceCaption } from "./source.js";

export const SourceContext = createContext<SourceCaption | null>(null);
const link = `cursor-pointer rounded-sm underline-offset-2 hover:text-foreground hover:underline ${focusRing}`;

export function SourceLine({ props }: { props: object }) {
  const caption = sourceCaption(props as Record<string, unknown>);
  const grouped = useContext(SourceContext);
  const host = useHost();
  const [error, setError] = useState<string | null>(null);
  if (!caption || sameCaption(caption, grouped)) return null;
  const openFile = async (path: string) => {
    setError(null);
    try {
      if (!await host.openFile?.(path)) setError(`Could not open ${sourceFileLabel(path)}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : `Could not open ${sourceFileLabel(path)}.`); }
  };
  return <div className="min-w-0 text-[11px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">
    <p className="m-0">Source: {caption.kind === "text" ? caption.text : caption.kind === "url" ? <a href={caption.url.href} title={caption.url.href} className={link} onClick={(event) => { event.preventDefault(); host.openUrl(caption.url.href); }}>{caption.label}</a> : caption.paths.map((path, index) => <span key={path}>{index ? ", " : null}{host.openFile ? <button type="button" className={`${link} font-mono`} title={`Open ${path}`} onClick={() => void openFile(path)}>{sourceFileLabel(path)}</button> : <span title={path}>{sourceFileLabel(path)}</span>}</span>)}</p>
    {error ? <p role="alert" className="m-0 text-destructive">{error}</p> : null}
  </div>;
}
