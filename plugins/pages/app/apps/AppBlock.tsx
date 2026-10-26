// App documents/streaming preview are ported from ComicBit/bb-plugin-genui (Apache-2.0).
// The host shell keeps the iframe mounted across fullscreen, theme and answer changes.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Ellipsis, X } from "../spec/icons.generated.js";
import { focusRing, menuContent, menuItem, PORTAL_SCOPE } from "../ui.js";
import { useHost } from "../spec/host.js";
import { useAnimationsOff } from "../spec/motion.js";
import { usePaneBounds } from "../spec/paneBounds.js";
import { rememberHeight, storedHeight } from "../spec/reservedHeight.js";
import { blockedNote, parseAppMessage, readAppStorage, saveAppStorage, type AppMessage, type AppStorageItems } from "./appBridge.js";
import { APP_SANDBOX, PREVIEW_SANDBOX, appFileName, buildPreviewSrcdoc, buildSrcdoc } from "./appDocument.js";
import { processPartialHtml } from "./partialHtml.js";
import { readHostTheme, useHostSync } from "./theme.js";

const CARD = "rounded-md border border-border bg-surface-recessed p-3";
const MIN_HEIGHT = 80, MAX_HEIGHT = 1400, PREVIEW_POST_MS = 300;
const clampHeight = (height: number) => Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(height)));
const cn = (...values: (string | boolean | undefined)[]) => values.filter(Boolean).join(" ");

export interface AppBlockProps {
  html: string;
  ready: boolean;
  stateKey: string;
  persist?: boolean;
  onAnswer?: (text: string | null) => void | Promise<void>;
  feedback?: ReactNode;
  onDownload?: (fileName: string, blob: Blob) => Promise<void>;
}

export function AppBlock(props: AppBlockProps) {
  const { html, ready, stateKey } = props;
  const [previewed, setPreviewed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const onPreviewContent = useCallback(() => setPreviewed(true), []);
  const onAppLoaded = useCallback(() => setLoaded(true), []);
  const previewing = !ready || (previewed && !loaded);
  return <div className="relative min-w-0">
    {ready ? <AppFrame key={html} {...props} covered={previewing} onLoaded={onAppLoaded} /> : null}
    {previewing ? <PreviewFrame html={html} stateKey={stateKey} cover={ready} onContent={onPreviewContent} /> : null}
  </div>;
}

function AppFrame({ html, stateKey, persist = true, onAnswer, feedback, onDownload, covered, onLoaded }: AppBlockProps & { covered: boolean; onLoaded: () => void }) {
  const host = useHost();
  const iframe = useRef<HTMLIFrameElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const menu = useRef<HTMLButtonElement>(null);
  const sourceSummary = useRef<HTMLElement>(null);
  const motionOff = useAnimationsOff();
  const sync = useHostSync(iframe, motionOff);
  const [restored] = useState<AppStorageItems>(() => persist ? readAppStorage(stateKey) : {});
  const storage = useRef(restored);
  const [srcdoc] = useState(() => buildSrcdoc(html, { theme: readHostTheme(), motionOff, storage: restored, canAnswer: !!onAnswer }));
  const [height, setHeight] = useState(() => clampHeight(storedHeight(stateKey) ?? MIN_HEIGHT));
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const message = error ?? note;
  const [full, setFull] = useState(false);
  const fullRef = useRef(full);
  fullRef.current = full;
  const modal = useRef(false);
  const bounds = usePaneBounds(dialog, full);
  const [source, setSource] = useState(false);
  const [limits, setLimits] = useState(false);
  const [portal, setPortal] = useState<Element | ShadowRoot | undefined>();
  const pending = useRef<"full" | "download" | "source" | "limits" | null>(null);
  const title = appFileName(html).replace(/\.html$/iu, "");

  useLayoutEffect(() => {
    const width = iframe.current?.getBoundingClientRect().width ?? 0;
    const remembered = storedHeight(stateKey, width);
    if (remembered !== null) setHeight(clampHeight(remembered));
  }, [stateKey]);

  // A native dialog enters the top layer without moving/reloading its iframe.
  // Inline it is an open, non-modal region; full screen is modal and pane-bounded.
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (full && !modal.current) {
      if (element.open) element.close();
      element.showModal();
      modal.current = true;
    } else if (!full && modal.current) {
      if (element.open) element.close();
      element.open = true;
      modal.current = false;
      menu.current?.focus();
    }
  }, [full]);

  useLayoutEffect(() => { if (source) sourceSummary.current?.focus(); }, [source]);
  const receive = useRef<(message: AppMessage, frame: HTMLIFrameElement) => void>(() => undefined);
  receive.current = (incoming, frame) => {
    switch (incoming.type) {
      case "height": {
        if (fullRef.current) return;
        const next = clampHeight(incoming.height);
        setHeight(next);
        rememberHeight(stateKey, frame.getBoundingClientRect().width, next);
        return;
      }
      case "error": setError(incoming.message); return;
      case "blocked": setNote(blockedNote(incoming.call)); return;
      case "storage":
        storage.current = incoming.items;
        if (persist) saveAppStorage(stateKey, incoming.items);
        return;
      case "answer":
        if (navigator.userActivation && !navigator.userActivation.isActive) { setNote("Choose an answer from a click or key press in the app."); return; }
        if (!onAnswer) { setNote("App answers need a BB thread."); return; }
        setNote(null);
        void Promise.resolve().then(() => onAnswer(incoming.text)).catch((error: unknown) => setError(error instanceof Error ? error.message : "Could not stage the app answer."));
        return;
      case "openLink":
        if (navigator.userActivation && !navigator.userActivation.isActive) { setNote("Open links from a click or key press in the app."); return; }
        setNote(null);
        host.openUrl(incoming.url);
        return;
      case "escape": setFull(false); return;
    }
  };
  useLayoutEffect(() => {
    const listen = (event: MessageEvent) => {
      const frame = iframe.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const incoming = parseAppMessage(event.data);
      if (incoming) receive.current(incoming, frame);
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, []);

  const download = async () => {
    const document = buildSrcdoc(html, { theme: readHostTheme(iframe.current), motionOff: false, storage: storage.current, standalone: true });
    const blob = new Blob([document], { type: "text/html" });
    if (onDownload) { await onDownload(appFileName(html), blob); return; }
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url; link.download = appFileName(html); link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return <>
    <dialog ref={dialog} open role={full ? "dialog" : "region"} aria-label={title === "app" ? "App" : title} aria-modal={full || undefined}
      onCancel={(event) => { event.preventDefault(); setFull(false); }}
      onClose={(event) => { if (!event.currentTarget.open) setFull(false); }}
      onPointerDown={(event) => {
        if (!full || event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) setFull(false);
      }}
      className={`group/app m-0 w-full max-h-none max-w-none text-foreground ${full ? "fixed inset-0 flex h-full flex-col gap-3 rounded-none border-0 bg-background p-3 backdrop:bg-black/40" : `relative block ${CARD}`}`}
      style={full && bounds ? { ...bounds, right: "auto", bottom: "auto" } : undefined}>
      <div className="flex h-9 shrink-0 items-center border-b border-border pr-20"><h2 className="m-0 truncate text-sm font-medium">{title === "app" ? "App" : title}</h2></div>
      <iframe ref={iframe} title={title === "app" ? "App" : title} sandbox={APP_SANDBOX} referrerPolicy="no-referrer" srcDoc={srcdoc}
        onLoad={() => { sync(); onLoaded(); }}
        className={`block w-full border-0 ${full ? "min-h-0 flex-1" : ""} ${covered ? "invisible" : ""}`} style={full ? undefined : { height }} />
      {message ? <p role={error ? "alert" : "status"} className={`my-2 text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}>{message}</p> : feedback}
      {limits ? <p className="my-2 text-xs text-muted-foreground">Isolated from BB. Remote resources and fetches are blocked. The app can still navigate its own frame and make a network request. Storage is limited to 256 KB per app and 1 MB total.</p> : null}
      <div className="absolute right-3 top-[18px] flex items-center gap-1">
        <DropdownMenu.Root modal={false} onOpenChange={(open) => {
          if (!open) return;
          const root = menu.current?.getRootNode();
          setPortal(full ? dialog.current ?? undefined : root instanceof ShadowRoot ? root : undefined);
        }}>
          <DropdownMenu.Trigger asChild><button ref={menu} type="button" aria-label="App actions" title="App actions" className={`inline-flex size-6 items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:bg-state-hover hover:text-foreground ${focusRing}`}><Ellipsis aria-hidden className="size-3.5" /></button></DropdownMenu.Trigger>
          <DropdownMenu.Portal container={portal}><DropdownMenu.Content {...PORTAL_SCOPE} align="end" sideOffset={4} className={`${menuContent} z-50 min-w-40 text-sm`}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
              // Radix's document.activeElement misses focus inside a page's ShadowRoot.
              const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]:not([data-disabled])"));
              if (!items.length) return;
              event.preventDefault();
              event.stopPropagation();
              const root = event.currentTarget.getRootNode();
              const active = root instanceof ShadowRoot ? root.activeElement : document.activeElement;
              const index = items.indexOf(active as HTMLElement);
              const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (index + 1) % items.length : (index <= 0 ? items.length : index) - 1;
              items[next]?.focus();
            }}
            onCloseAutoFocus={(event) => {
              const action = pending.current;
              pending.current = null;
              if (action === "full") { event.preventDefault(); setFull((value) => !value); }
              else if (action === "source") { event.preventDefault(); setFull(false); setSource(true); }
              else if (action === "limits") setLimits((value) => !value);
              else if (action === "download") void download().catch((error: unknown) => setError(error instanceof Error ? error.message : "Could not download the app."));
            }}>
            <DropdownMenu.Item className={menuItem} onSelect={() => { pending.current = "full"; }}>{full ? "Exit full screen" : "Full screen"}</DropdownMenu.Item>
            <DropdownMenu.Item className={menuItem} onSelect={() => { pending.current = "download"; }}>Download HTML</DropdownMenu.Item>
            <DropdownMenu.Item className={menuItem} onSelect={() => { pending.current = "source"; }}>View source</DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <DropdownMenu.Item className={menuItem} onSelect={() => { pending.current = "limits"; }}>Sandbox limits</DropdownMenu.Item>
          </DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>
        {full ? <button autoFocus type="button" aria-label="Close full screen" title="Close full screen" onClick={() => setFull(false)} className={`inline-flex size-6 items-center justify-center rounded-md hover:bg-state-hover ${focusRing}`}><X aria-hidden className="size-3.5" /></button> : null}
      </div>
    </dialog>
    {source ? <details open onToggle={(event) => { if (!event.currentTarget.open) { setSource(false); menu.current?.focus(); } }} className="mt-2 min-w-0" onKeyDown={(event) => {
      if (event.key === "Escape" && source) { event.preventDefault(); setSource(false); menu.current?.focus(); }
    }}>
      <summary ref={sourceSummary} className={`w-fit cursor-pointer text-xs text-muted-foreground ${focusRing}`}>Source</summary>
      {source ? <div className="mt-2"><host.SourceCode content={html} path="app.html" /></div> : null}
    </details> : null}
  </>;
}

function PreviewFrame({
  html,
  stateKey,
  cover,
  onContent,
}: {
  html: string;
  stateKey: string;
  /** The app is ready and loading under the preview. */
  cover: boolean;
  onContent: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const motionOff = useAnimationsOff();
  const [srcdoc] = useState(() => buildPreviewSrcdoc({ theme: readHostTheme(), motionOff }));
  const sync = useHostSync(iframeRef, motionOff);
  const [height, setHeight] = useState(0);
  const latest = useRef({ html, cover });
  latest.current = { html, cover };
  const posting = useRef<{ loaded: boolean; postedAt: number; timer: number | undefined; sent: string }>({
    loaded: false,
    postedAt: 0,
    timer: undefined,
    sent: "",
  });

  // Processing happens here, at most once per PREVIEW_POST_MS, not on every streamed token.
  const post = useCallback(() => {
    const state = posting.current;
    clearTimeout(state.timer);
    state.timer = undefined;
    state.postedAt = performance.now();
    const { css, body } = processPartialHtml(latest.current.html);
    const sent = `${css}\u0000${body}`;
    if (sent === state.sent) return;
    state.sent = sent;
    iframeRef.current?.contentWindow?.postMessage({ source: "genui-host", type: "preview", css, body }, "*");
  }, []);

  useEffect(() => {
    const state = posting.current;
    if (!state.loaded) return;
    // Covering the app: draw the whole document now, so the hand-over matches.
    if (cover) {
      post();
      return;
    }
    if (state.timer !== undefined) return;
    const wait = state.postedAt + PREVIEW_POST_MS - performance.now();
    if (wait <= 0) post();
    else state.timer = window.setTimeout(post, wait);
  }, [html, cover, post]);
  useEffect(() => () => clearTimeout(posting.current.timer), []);

  useLayoutEffect(() => {
    function onMessage(event: MessageEvent) {
      const frame = iframeRef.current;
      if (frame === null || event.source !== frame.contentWindow) return;
      const message = parseAppMessage(event.data);
      if (message?.type !== "height") return;
      const next = Math.min(MAX_HEIGHT, Math.ceil(message.height));
      setHeight(next);
      if (next === 0) return;
      onContent();
      // Once the app runs under it, the app's own height is the one to keep.
      if (!latest.current.cover) rememberHeight(stateKey, frame.getBoundingClientRect().width, clampHeight(next));
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [stateKey, onContent]);

  return (
    <div aria-hidden={cover || undefined} className={cn(CARD, cover && "pointer-events-none absolute inset-0 z-10 overflow-hidden")}>
      <iframe
        ref={iframeRef}
        title="App preview"
        sandbox={PREVIEW_SANDBOX}
        referrerPolicy="no-referrer"
        srcDoc={srcdoc}
        tabIndex={-1}
        aria-hidden
        onLoad={() => {
          posting.current.loaded = true;
          sync();
          post();
        }}
        className="pointer-events-none block w-full border-0"
        style={{ height }}
      />
      {cover ? null : height > 0 ? (
        <span role="status" className="sr-only">
          Building app…
        </span>
      ) : (
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className={cn("size-2 rounded-full bg-primary", !motionOff && "animate-pulse")} />
          Building app…
        </div>
      )}
    </div>
  );
}
