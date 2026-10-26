import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Renderer, useRendererQuery, type ParseResult } from "@openuidev/react-lang";
import { HostContext, useHost } from "./host.js";
import { focusRing, type Tools } from "./kit.js";
import { bakedKey } from "../../render/spec-baked.js";
import { snapshotMarkdown } from "./markdown.js";

type Reader = () => Promise<string>;
const GroupContext = createContext<Map<object, Reader> | null>(null);

export function MarkdownGroup({ children }: { children: ReactNode }) {
  const [readers] = useState(() => new Map<object, Reader>());
  return <GroupContext.Provider value={readers}>{children}</GroupContext.Provider>;
}

export function CopyMarkdown({ read }: { read?: Reader }) {
  const group = useContext(GroupContext);
  const [status, setStatus] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const copy = async () => {
    setWorking(true);
    setStatus(null);
    try {
      const content = read ? await read() : (await Promise.all([...(group?.values() ?? [])].map(reader => reader()))).join("\n\n---\n\n");
      if (!content.trim()) throw new Error("No component content is ready to copy.");
      await navigator.clipboard.writeText(content);
      setStatus("Copied");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not copy Markdown."); }
    finally { setWorking(false); }
  };
  return <span className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-subtle-foreground">
    <button type="button" disabled={working} onClick={() => void copy()} className={`w-fit shrink-0 cursor-pointer rounded-sm hover:text-foreground disabled:opacity-50 ${focusRing}`}>{working ? "Copying…" : "Copy as Markdown"}</button>
    {status ? <span role="status" className="min-w-0 break-words">{status}</span> : null}
  </span>;
}

function ExportAction({ read }: { read: Reader }) {
  const { isLoading, errors } = useRendererQuery();
  if (isLoading || errors.some(error => error.severity !== "warning")) return null;
  return <div className="mt-2"><CopyMarkdown read={read} /></div>;
}

type Props = Omit<ComponentProps<typeof Renderer>, "toolProvider" | "children"> & { toolProvider?: Tools; exportable?: boolean };

/** Observes resolved data and native form state; copying never starts a lookup or executes an action. */
export function SpecRenderer({ exportable = true, ...props }: Props) {
  const host = useHost();
  const group = useContext(GroupContext);
  const token = useRef<object>({});
  const parsed = useRef<ParseResult | null>(null);
  const state = useRef<Record<string, unknown>>(props.initialState ?? {});
  const cache = useMemo(() => ({ queries: new Map<string, unknown>(), files: new Map<string, string>(), searches: new Map<string, unknown>() }), [props.toolProvider]);
  const remember = <T,>(map: Map<string, T>, key: string, value: T) => {
    map.delete(key);
    map.set(key, value);
    if (map.size > 64) map.delete(map.keys().next().value!);
    return value;
  };
  const tools = useMemo<Tools>(() => Object.fromEntries(Object.entries(props.toolProvider ?? {}).map(([name, run]) => [name, async (args: Record<string, unknown>) => remember(cache.queries, bakedKey("tool", name, args), await run(args))])), [props.toolProvider, cache]);
  const observedHost = useMemo(() => ({ ...host,
    loadText: async (path: string) => remember(cache.files, path, await host.loadText(path)),
    web: async (...args: Parameters<typeof host.web>) => {
      const value = await host.web(...args);
      if (args[0] === "search") remember(cache.searches, String(args[1].query ?? args[1].q ?? ""), value);
      return value;
    },
  }), [host, cache]);
  const latest = useRef({ cache, streaming: props.isStreaming });
  latest.current = { cache, streaming: props.isStreaming };
  const read = useCallback<Reader>(async () => {
    if (!parsed.current || latest.current.streaming) throw new Error("Wait for this component to finish before copying.");
    const { cache: current } = latest.current;
    return snapshotMarkdown(parsed.current, {
      state: state.current, textFiles: current.files, searches: current.searches,
      resolveQuery: (tool, args) => {
        const key = bakedKey("tool", tool, args);
        if (!current.queries.has(key)) throw new Error("Some component data is still loading. Try copying again.");
        return current.queries.get(key);
      },
    });
  }, []);
  useLayoutEffect(() => {
    if (!group) return;
    const id = token.current;
    group.set(id, read);
    return () => { group.delete(id); };
  }, [group, read]);
  return <HostContext.Provider value={observedHost}><Renderer {...props} toolProvider={tools}
    onParseResult={(result) => { parsed.current = result; props.onParseResult?.(result); }}
    onStateUpdate={(value) => { state.current = value; props.onStateUpdate?.(value); }}>
    <Renderer.Content />
    <Renderer.QueryLoading />
    <Renderer.QueryError><Renderer.Retry /></Renderer.QueryError>
    {exportable && !props.isStreaming ? <ExportAction read={read} /> : null}
  </Renderer></HostContext.Provider>;
}
