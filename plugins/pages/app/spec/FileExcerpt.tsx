import { useEffect, useMemo, useState } from "react";
import { useCopy, useHost } from "./host.js";
import { focusRing } from "./kit.js";
import { snippetLines, snippetRangeError } from "./file-lines.js";
import { sourceFileLabel } from "./source.js";

export function FileExcerpt({ file, from, to }: { file: string; from?: number; to?: number }) {
  const host = useHost();
  const [read, setRead] = useState<{ path: string; text?: string; error?: string } | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const invalid = snippetRangeError(from ?? null, to ?? null);
  useEffect(() => {
    if (invalid) return;
    let live = true;
    setOpenError(null);
    host.loadText(file).then((text) => { if (live) setRead({ path: file, text }); }, (cause: unknown) => {
      if (live) setRead({ path: file, error: cause instanceof Error ? cause.message : "Could not read this file." });
    });
    return () => { live = false; };
  }, [file, host.loadText, invalid]);
  const current = read?.path === file ? read : null;
  const excerpt = useMemo(() => current?.text !== undefined ? snippetLines(current.text, from ?? null, to ?? null) : null, [current?.text, from, to]);
  const code = excerpt?.code ?? "";
  const [copied, copy] = useCopy(code);
  const start = from ?? 1;
  const lines = useMemo(() => code.split("\n"), [code]);
  const end = start + lines.length - 1;
  const error = invalid ?? current?.error ?? excerpt?.error;
  const open = async () => {
    setOpenError(null);
    try { if (!await host.openFile?.(file, start, end)) setOpenError("Could not open this file in BB."); }
    catch (cause) { setOpenError(cause instanceof Error ? cause.message : "Could not open this file in BB."); }
  };
  return <figure className="m-0 min-w-0 overflow-hidden rounded-md border border-border bg-background">
    <figcaption className="flex h-9 items-center justify-between gap-3 border-b border-border bg-muted/30 px-3 text-xs text-muted-foreground">
      <span className="min-w-0 truncate font-mono" title={file}>{sourceFileLabel(file)}{excerpt?.code !== null && excerpt ? ` L${start}${end === start ? "" : `-${end}`}` : ""}</span>
      <span className="flex shrink-0 items-center gap-3">
        {host.openFile ? <button type="button" onClick={() => void open()} className={`rounded-sm hover:text-foreground ${focusRing}`}>Open file</button> : null}
        <button type="button" disabled={!code} onClick={copy} className={`rounded-sm hover:text-foreground disabled:opacity-50 ${focusRing}`}><span aria-live="polite">{copied ?? "Copy"}</span></button>
      </span>
    </figcaption>
    {error ?? openError ? <p role="alert" className="m-0 p-3 text-xs text-destructive">{error ?? openError}</p> : null}
    {!error && (!excerpt ? <div role="status" className="flex h-28 items-center px-3 text-xs text-muted-foreground">Reading source…</div> : <pre className="m-0 overflow-x-auto py-2 font-mono text-xs leading-5"><code>{lines.map((line, index) => <span key={index} className="flex min-w-max"><span aria-hidden className="w-12 shrink-0 select-none pr-3 text-right tabular-nums text-muted-foreground">{start + index}</span><span className="pr-3">{line || " "}</span>{"\n"}</span>)}</code></pre>)}
  </figure>;
}
