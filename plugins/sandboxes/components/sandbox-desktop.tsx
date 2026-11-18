import { useCallback, useEffect, useState } from "react";
import { experimental_Icon as Icon, useRealtime, useRpc, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import type { sandboxDesktopRpcContract, SandboxDesktopView } from "../src/desktop-contract.js";

function browserUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.href : null;
  } catch {
    return null;
  }
}

export function SandboxDesktopDirective({ message }: PluginMessageDirectiveProps) {
  const threadId = message.threadId;
  const rpc = useRpc<typeof sandboxDesktopRpcContract>();
  const [view, setView] = useState<SandboxDesktopView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void rpc.call("getSandboxDesktop", { threadId }).then(setView).catch(() => setView({ kind: "closed" }));
  }, [rpc, threadId]);
  useEffect(refresh, [refresh]);
  useRealtime("sandbox-desktop:" + threadId, refresh);

  const open = view?.kind === "open" && view.expires > Date.now() ? view : null;
  const url = open ? browserUrl(open.url) : null;

  const change = async (viewOnly?: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (viewOnly === undefined) {
        await rpc.call("closeSandboxDesktop", { threadId });
        setView({ kind: "closed" });
      } else {
        setView(await rpc.call("openSandboxDesktop", { threadId, viewOnly }));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t update the desktop.");
    } finally {
      setBusy(false);
    }
  };

  const status = view === null ? "Loading…" : !open ? "Closed" : open.viewOnly ? "View only" : "Interactive";
  const button = "rounded-md px-2 py-1 text-xs font-medium hover:bg-state-hover disabled:opacity-50";

  return (
    <section aria-label="Sandbox desktop" className="my-2 rounded-lg border border-border bg-background px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Icon name="ComputerCloud" aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">Sandbox desktop</span>
        <span className="text-xs text-muted-foreground">
          {status}{open && ` · until ${new Date(open.expires).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
        </span>
      </div>
      {open && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {url && !busy && (
            <a href={url} target="_blank" rel="noopener noreferrer"
              className={`${button} bg-foreground text-background hover:opacity-90`}
              onClick={(event) => {
                if (open.expires <= Date.now()) {
                  event.preventDefault();
                  setView({ kind: "closed" });
                }
              }}>
              Open desktop in browser
            </a>
          )}
          <button type="button" disabled={busy} className={button} onClick={() => void change(!open.viewOnly)}>
            {open.viewOnly ? "Enable control" : "Switch to view only"}
          </button>
          <button type="button" disabled={busy} className={button} onClick={() => void change()}>
            Close desktop
          </button>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  );
}
